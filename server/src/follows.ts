import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DownloadSelection } from "./downloads.js";
import { AppError } from "./errors.js";
import { renameWithRetry } from "./fs-retry.js";
import { parseLibraryPath, type Viewer } from "./libraries.js";
import { log } from "./logger.js";
import type { MediaInfo } from "./naming.js";
import type { MetaItem } from "./types.js";
import type { FollowDefaults } from "./users.js";

export interface FollowEpisode {
  key: string;
  videoId: string;
  season: number;
  episode: number;
  title?: string;
  released?: string;
  /** Where the released instant came from, when a TMDB check decided it. */
  releasedSource?: "addon" | "tmdb";
  /** The date is not trustworthy: a placeholder, or a season-wide shared date with no TMDB answer. */
  dateUncertain?: boolean;
  /** A film's single record: which kind of release `released` is, and the cinema date shown
   *  while the digital one is not announced. */
  releaseKind?: "digital" | "physical" | "theatrical" | "catalog";
  theatricalAt?: string;
  firstSeenAt: string;
  ambiguous?: boolean;
  download?: EpisodeDownload;
}

export interface FollowAutoDownload {
  /** Set when automatic downloads were switched on, kept when the rule is edited. */
  enabledAt: string;
  startMode: "new" | "from" | "ahead";
  startSeason?: number;
  startEpisode?: number;
  /** With `ahead`: how many regular episodes after the watched marker stay ready, 1..10. */
  aheadCount?: number;
  selection: DownloadSelection;
  /** Days after release during which only the preferred audio is admitted, 0..30. */
  graceDays?: number;
  /** Delete downloaded episodes this long after the owner watched past them; absent keeps them. */
  retention?: { afterWatchedDays: 1 | 7 | 30 };
  /** The catalogue key of the reason nothing is admitted, while the owner may not download. */
  blockedKey?: string;
}

export type EpisodeDownloadState = "reserved" | "queued" | "waiting" | "completed" | "skipped" | "attention";

export interface EpisodeDownload {
  state: EpisodeDownloadState;
  /** `${followId}:${episodeKey}:${generation}`, matched against the queue across restarts. */
  intent: string;
  /** Starts at 1, bumped on every explicit retry of a finished state. */
  generation: number;
  jobId?: string;
  attempts: number;
  /** ISO UTC, only meaningful in `waiting`. */
  nextAttemptAt?: string;
  /** ISO UTC, the moment the preferred-audio window closes; only meaningful in `waiting`. */
  graceUntil?: string;
  /** The library key the completed download wrote, remembered when the job finished. */
  target?: string;
  /** ISO UTC, set when the file was deleted by retention; the state stays `completed`. */
  removedAt?: string;
  removedReason?: "retention";
  reasonKey?: string;
  updatedAt: string;
}

export interface Follow {
  id: string;
  ownerUserId: string;
  type: string;
  metaId: string;
  name: string;
  poster?: string;
  createdAt: string;
  updatedAt: string;
  enabled: boolean;
  revision: number;
  lastCheckedAt?: string;
  lastSuccessfulCheckAt?: string;
  nextCheckAt: string;
  failures: number;
  lastErrorKey?: string;
  autoDownload?: FollowAutoDownload;
  episodes: Record<string, FollowEpisode>;
}

export interface FollowFile { version: 1; follows: Follow[] }

/** An episode as the metadata read hands it over, before the store stamps `firstSeenAt`. */
export type NormalizedFollowEpisode = Omit<FollowEpisode, "firstSeenAt">;

export interface NewEpisode {
  followId: string;
  type: string;
  metaId: string;
  name: string;
  poster?: string;
  videoId: string;
  season: number;
  episode: number;
  title?: string;
  released: string;
}

const EPISODE_LIMIT = 5000;
const DAY_MS = 24 * 60 * 60_000;
const STAGGER_MS = 6 * 60 * 60_000;
const FIRST_FAILURE_MS = 15 * 60_000;
const SECOND_FAILURE_MS = 60 * 60_000;
const LATER_FAILURE_MS = 6 * 60 * 60_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** A season is worth verifying against TMDB while it has an undated episode or one that airs
 *  soon; older seasons are settled. */
const RECONCILE_HORIZON_MS = 60 * DAY_MS;
/** How many of the newest such seasons one check reads, so a long-running series stays cheap. */
const RECONCILE_SEASON_LIMIT = 3;
/** Without TMDB, a shared date counts as a placeholder only while it is still ahead. */
const PLACEHOLDER_WINDOW_MS = 14 * DAY_MS;

const number = (value: unknown): number | undefined => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
const integer = (value: unknown): number | undefined => {
  const parsed = number(value);
  return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined;
};
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** A date with no time names the end of that UTC day: a provider that says only
 *  `2024-03-01` must not read as released before the episode actually aired. */
const releasedAt = (value: unknown): string | undefined => {
  const raw = text(value);
  if (!raw) return undefined;
  const parsed = DATE_ONLY.test(raw) ? Date.parse(`${raw}T23:59:59.999Z`) : Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
};

/** The episodes a series meta carries, read with the aliases `episodesFromMeta` uses.
 *  Specials and rows without whole numbers are dropped; episodes the store has never
 *  seen arrive without `firstSeenAt`, which is the store's to add. */
export function normalizeFollowEpisodes(meta: MetaItem | null | undefined): NormalizedFollowEpisode[] {
  const videos = Array.isArray(meta?.videos) ? meta.videos : [];
  if (videos.length > EPISODE_LIMIT) log("WARN", "A series answered with more episodes than the follow store expects", { id: meta?.id, videos: videos.length });
  const out: NormalizedFollowEpisode[] = [];
  const index = new Map<string, number>();
  for (const video of videos) {
    const season = integer(video.season);
    const episode = integer(video.episode ?? video.number);
    const videoId = text(video.id);
    if (season == null || season < 1 || episode == null || episode < 1 || !videoId) continue;
    const key = `${season}:${episode}`;
    const at = index.get(key);
    if (at !== undefined) {
      // Two providers claiming one slot: the first answer stands, but the row is marked
      // so a caller that shows it can say so rather than pick a side.
      if (out[at].videoId !== videoId) out[at].ambiguous = true;
      continue;
    }
    index.set(key, out.length);
    const title = text(video.name ?? video.title);
    const released = releasedAt(video.released ?? video.firstAired);
    out.push({
      key, videoId, season, episode,
      ...(title ? { title } : {}),
      ...(released ? { released } : {}),
    });
  }
  return out;
}

/** The UTC calendar day a value names, when the first ten characters are a real day. */
const utcDay = (value: string | undefined): string | undefined => {
  const raw = value?.slice(0, 10);
  return raw && DATE_ONLY.test(raw) ? raw : undefined;
};

/** The releases a season repeats across two or more episodes: the placeholder a catalogue
 *  uses when it does not know the real weekly dates and stamps the premiere on each. */
const sharedReleases = (episodes: ReadonlyArray<FollowEpisode>): Map<number, Set<string>> => {
  const counts = new Map<number, Map<string, number>>();
  for (const episode of episodes) {
    if (!episode.released) continue;
    const bySeason = counts.get(episode.season) ?? new Map<string, number>();
    bySeason.set(episode.released, (bySeason.get(episode.released) ?? 0) + 1);
    counts.set(episode.season, bySeason);
  }
  const shared = new Map<number, Set<string>>();
  for (const [season, byReleased] of counts) {
    const repeated = new Set<string>();
    for (const [released, count] of byReleased) if (count >= 2) repeated.add(released);
    if (repeated.size) shared.set(season, repeated);
  }
  return shared;
};

/** The release dates one check trusts. TMDB wins where it names a day of its own; where it is
 *  silent, a date several episodes of a season share is the placeholder and is dropped rather
 *  than kept as an invented premiere. Without TMDB the shared date stays, but every episode
 *  after the first in the season is marked uncertain. Pure, so a test can drive it directly. */
export function reconcileReleaseDates(episodes: FollowEpisode[], tmdb: Map<string, string | null> | undefined, now: number): FollowEpisode[] {
  const out = episodes.map((episode) => ({ ...episode }));
  if (tmdb) {
    const repeated = sharedReleases(out);
    // TMDB was only asked about a few recent seasons; the others keep what the addon said.
    const asked = new Set([...tmdb.keys()].map((key) => Number(key.split(":")[0])));
    for (const episode of out) {
      if (!asked.has(episode.season)) continue;
      const tmdbDay = utcDay(tmdb.get(`${episode.season}:${episode.episode}`) ?? undefined);
      if (tmdbDay) {
        if (utcDay(episode.released) !== tmdbDay) {
          episode.released = new Date(Date.parse(`${tmdbDay}T23:59:59.999Z`)).toISOString();
          episode.releasedSource = "tmdb";
        } else {
          episode.releasedSource = "addon";
        }
        delete episode.dateUncertain;
        continue;
      }
      if (episode.released && repeated.get(episode.season)?.has(episode.released)) {
        delete episode.released;
        delete episode.releasedSource;
        episode.dateUncertain = true;
      } else {
        delete episode.releasedSource;
        delete episode.dateUncertain;
      }
    }
    return out;
  }
  const clusters = new Map<number, Map<string, FollowEpisode[]>>();
  for (const episode of out) {
    if (!episode.released || !(Date.parse(episode.released) > now - PLACEHOLDER_WINDOW_MS)) continue;
    const byReleased = clusters.get(episode.season) ?? new Map<string, FollowEpisode[]>();
    const list = byReleased.get(episode.released) ?? [];
    list.push(episode);
    byReleased.set(episode.released, list);
    clusters.set(episode.season, byReleased);
  }
  for (const byReleased of clusters.values()) {
    for (const list of byReleased.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.season - b.season || a.episode - b.episode);
      for (const episode of list.slice(1)) episode.dateUncertain = true;
    }
  }
  return out;
}

/** The seasons whose dates one check verifies against TMDB: any with an undated episode or one
 *  that airs within the horizon, plus the season of an episode the download service is waiting
 *  on. Only the newest few, so a long-running series never fans out into every season. */
export function seasonsForReconcile(
  episodes: ReadonlyArray<{ season: number; released?: string }>,
  stored: Record<string, FollowEpisode> | undefined,
  now: number,
): number[] {
  const floor = now - RECONCILE_HORIZON_MS;
  const seasons = new Set<number>();
  for (const episode of episodes) {
    if (episode.season < 1) continue;
    if (!episode.released || Date.parse(episode.released) > floor) seasons.add(episode.season);
  }
  for (const episode of Object.values(stored ?? {})) {
    const state = episode.download?.state;
    if (state === "waiting" || state === "attention") seasons.add(episode.season);
  }
  return [...seasons].sort((a, b) => b - a).slice(0, RECONCILE_SEASON_LIMIT);
}

/** 0..6 h from the id, so follows created together do not all check at the same minute. */
export function followStaggerMs(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % STAGGER_MS;
}

const failureBackoffMs = (failures: number): number =>
  failures <= 1 ? FIRST_FAILURE_MS : failures === 2 ? SECOND_FAILURE_MS : LATER_FAILURE_MS;

export type DownloadEligibility = "eligible" | "upcoming" | "outside" | "attention-no-date" | "attention-ambiguous";

/** Whether one episode of a followed series should be queued automatically, as the current
 *  clock and the follow's rule see it. Pure, so the setup dialog and the admission agree. */
export interface MovieReleases { theatrical?: string; digital?: string; physical?: string }

const MOVIE_CATALOG_DOUBT_MS = 120 * DAY_MS;

/** A film as the one record the follow machinery tracks. Its date is when it can be
 *  downloaded -- the digital release, else the disc -- because a premiere says nothing about
 *  sources. A film only in cinemas waits undated; without TMDB the catalogue's date stands,
 *  doubted while it is recent, since for a new film it is usually the premiere. */
export function movieEpisode(meta: MetaItem, metaId: string, releases: MovieReleases | null, now: number): Omit<FollowEpisode, "firstSeenAt"> {
  const base = { key: "1:1", videoId: metaId, season: 1, episode: 1, ...(text(meta.name) ? { title: text(meta.name)! } : {}) };
  const digital = releasedAt(releases?.digital);
  if (digital) return { ...base, released: digital, releasedSource: "tmdb", releaseKind: "digital" };
  const physical = releasedAt(releases?.physical);
  if (physical) return { ...base, released: physical, releasedSource: "tmdb", releaseKind: "physical" };
  const theatrical = releasedAt(releases?.theatrical);
  if (theatrical) return { ...base, dateUncertain: true, releaseKind: "theatrical", theatricalAt: theatrical };
  const catalog = releasedAt((meta as { released?: unknown }).released);
  if (!catalog) return { ...base, dateUncertain: true };
  const doubtful = Date.parse(catalog) > now - MOVIE_CATALOG_DOUBT_MS;
  return { ...base, released: catalog, releasedSource: "addon", releaseKind: "catalog", ...(doubtful ? { dateUncertain: true } : {}) };
}

/** The episodes an "ahead" rule keeps ready: the next `aheadCount` regular episodes in
 *  season/episode order after the marker -- or from the first one when there is no marker.
 *  A slot is a slot, so an episode with no release date still spends one and the window never
 *  reaches past it. Pure, so the setup dialog and the admission agree. */
export function aheadWindow(follow: Follow, watched: { season: number; episode: number } | undefined): Set<string> {
  const count = follow.autoDownload?.aheadCount ?? 0;
  if (count <= 0) return new Set();
  const ordered = Object.values(follow.episodes)
    .filter((episode) => episode.season >= 1)
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  const after = watched
    ? ordered.filter((episode) => afterMarker(episode, watched))
    : ordered;
  return new Set(after.slice(0, count).map((episode) => episode.key));
}

export function downloadEligibility(follow: Follow, episode: FollowEpisode, now: number, watched?: { season: number; episode: number }): DownloadEligibility {
  const auto = follow.autoDownload;
  if (!auto) return "outside";
  // A film is one download whenever it comes out; the start rule is about a series' episodes.
  if (follow.type === "movie") {
    if (!episode.released) return episode.dateUncertain ? "upcoming" : "attention-no-date";
    return Date.parse(episode.released) > now ? "upcoming" : "eligible";
  }
  if (auto.startMode === "ahead") {
    if (!aheadWindow(follow, watched).has(episode.key)) return "outside";
  } else if (auto.startMode === "from") {
    const startSeason = auto.startSeason ?? 1;
    const startEpisode = auto.startEpisode ?? 1;
    const atOrAfter = episode.season > startSeason || (episode.season === startSeason && episode.episode >= startEpisode);
    if (!atOrAfter) return "outside";
  } else {
    const enabledAt = Date.parse(auto.enabledAt);
    const released = episode.released ? Date.parse(episode.released) : undefined;
    const seen = released ?? Date.parse(episode.firstSeenAt);
    if (!(seen > enabledAt)) return "outside";
  }
  if (episode.ambiguous) return "attention-ambiguous";
  // An unknown date is not proof the episode exists, so it is neither upcoming nor eligible.
  // A date we know is only the season's placeholder is different: the next check usually
  // brings the real one, so the episode waits rather than asking to be resolved.
  if (!episode.released) return episode.dateUncertain ? "upcoming" : "attention-no-date";
  if (Date.parse(episode.released) > now) return "upcoming";
  return "eligible";
}

/** The instant a follow's preferred-audio window closes, or nothing when it never waits. The
 *  clock runs from the episode's release, so a date the provider has not given leaves no window. */
export function graceUntil(auto: FollowAutoDownload, episode: FollowEpisode): number | undefined {
  const days = auto.graceDays;
  if (!days || days <= 0 || !episode.released) return undefined;
  const released = Date.parse(episode.released);
  return Number.isFinite(released) ? released + days * DAY_MS : undefined;
}

/** The selection a follow hands to the queue right now: inside the window the fallback audio is
 *  dropped and a preferred mode softens to listed, so only the preferred language is accepted.
 *  A strict mode stays strict, and the window's end restores the saved rules unchanged. */
export function effectiveSelection(auto: FollowAutoDownload, episode: FollowEpisode, now: number): DownloadSelection {
  const until = graceUntil(auto, episode);
  if (until === undefined || now >= until) return auto.selection;
  const stripped: DownloadSelection = { ...auto.selection };
  delete stripped.fallbackAudioLanguage;
  if (stripped.audioMode === "preferred") stripped.audioMode = "listed";
  return stripped;
}

const FOLLOW_ADDON_LIMIT = 50;
/** How far a calendar window may reach: a page reads two months, not a library dump. */
export const CALENDAR_MAX_SPAN_MS = 62 * DAY_MS;
const CALENDAR_LIMIT = 500;

const invalidFollowDefaults = (): AppError =>
  new AppError("The follow defaults are not valid.", "err.followInvalid");

const asDefaultsRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const enumValue = <T extends string>(allowed: readonly T[], value: unknown): T | undefined =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : undefined;

const parseFollowDefaultsSelection = (value: unknown): NonNullable<FollowDefaults["selection"]> => {
  const source = asDefaultsRecord(value);
  if (!source) throw invalidFollowDefaults();
  if (!Array.isArray(source.addonKeys)) throw invalidFollowDefaults();
  const addonKeys = [...new Set(source.addonKeys
    .filter((key): key is string => typeof key === "string")
    .map((key) => key.trim())
    .filter(Boolean))];
  if (addonKeys.length > FOLLOW_ADDON_LIMIT) throw invalidFollowDefaults();
  const sourceStrategy = enumValue(["largest", "priority"] as const, source.sourceStrategy);
  const audioLanguage = text(source.audioLanguage);
  const audioMode = enumValue(["listed", "preferred", "strict"] as const, source.audioMode);
  const subtitleMode = enumValue(["off", "optional", "required"] as const, source.subtitleMode);
  if (!sourceStrategy || !audioLanguage || !audioMode || !subtitleMode) throw invalidFollowDefaults();
  const fallbackAudioLanguage = text(source.fallbackAudioLanguage);
  // A subtitle language is only meaningful while subtitles are wanted at all.
  const subtitleLanguage = subtitleMode === "off" ? undefined : text(source.subtitleLanguage);
  const fallbackSubtitleLanguage = subtitleMode === "off" ? undefined : text(source.fallbackSubtitleLanguage);
  return {
    addonKeys, sourceStrategy, audioLanguage,
    ...(fallbackAudioLanguage ? { fallbackAudioLanguage } : {}),
    audioMode, subtitleMode,
    ...(subtitleLanguage ? { subtitleLanguage } : {}),
    ...(fallbackSubtitleLanguage ? { fallbackSubtitleLanguage } : {}),
  };
};

const parseFollowDefaultsTarget = (value: unknown): NonNullable<FollowDefaults["target"]> => {
  const source = asDefaultsRecord(value);
  if (!source) throw invalidFollowDefaults();
  const libraryId = text(source.libraryId);
  if (!libraryId) throw invalidFollowDefaults();
  const subfolder = text(source.subfolder);
  const layout = source.layout === undefined || source.layout === null
    ? undefined : enumValue(["structured", "flat"] as const, source.layout);
  if (source.layout !== undefined && source.layout !== null && !layout) throw invalidFollowDefaults();
  return {
    libraryId,
    ...(subfolder ? { subfolder } : {}),
    ...(layout ? { layout } : {}),
  };
};

/** Reads a follow-wizard body into the shape `UserData.followDefaults` stores. Unknown keys
 *  are dropped and strings trimmed; a missing or wrong-typed field is a validation failure,
 *  which the caller answers as `err.followInvalid`. */
export function parseFollowDefaults(value: unknown): FollowDefaults | undefined {
  const source = asDefaultsRecord(value);
  if (!source) return undefined;
  const mode = enumValue(["notify", "download"] as const, source.mode);
  if (!mode) throw invalidFollowDefaults();
  const startMode = source.startMode === undefined || source.startMode === null
    ? undefined : enumValue(["new", "from", "ahead"] as const, source.startMode);
  if (source.startMode !== undefined && source.startMode !== null && !startMode) throw invalidFollowDefaults();
  const aheadCount = source.aheadCount === undefined || source.aheadCount === null ? undefined : integer(source.aheadCount);
  if (startMode === "ahead" && (aheadCount === undefined || aheadCount < 1 || aheadCount > 10)) throw invalidFollowDefaults();
  const graceDays = source.graceDays === undefined || source.graceDays === null ? undefined : integer(source.graceDays);
  if (source.graceDays !== undefined && source.graceDays !== null && (graceDays === undefined || graceDays < 0 || graceDays > 30)) throw invalidFollowDefaults();
  const selection = source.selection === undefined || source.selection === null
    ? undefined : parseFollowDefaultsSelection(source.selection);
  const target = source.target === undefined || source.target === null
    ? undefined : parseFollowDefaultsTarget(source.target);
  return {
    mode,
    ...(startMode ? { startMode } : {}),
    ...(startMode === "ahead" && aheadCount ? { aheadCount } : {}),
    ...(graceDays ? { graceDays } : {}),
    ...(selection ? { selection } : {}),
    ...(target ? { target } : {}),
  };
}

export type CalendarEpisodeState = "upcoming" | "released" | EpisodeDownloadState;

export interface CalendarItem {
  followId: string;
  type: string;
  metaId: string;
  name: string;
  poster?: string;
  videoId: string;
  season: number;
  episode: number;
  title?: string;
  released: string;
  state: CalendarEpisodeState;
  reasonKey?: string;
  nextAttemptAt?: string;
  ambiguous?: boolean;
  dateUncertain?: boolean;
  releasedSource?: "addon" | "tmdb";
}

/** A calendar item that carries no date: the shape of a `CalendarItem` without `released`. */
export type CalendarUndatedItem = Omit<CalendarItem, "released">;

/** The episodes of the caller's follows that fall in `[from, to)`, ordered by when they air.
 *  An episode the service has touched carries its download state; the rest are simply past
 *  or still to come. */
export function calendarItems(follows: Follow[], from: number, to: number, now: number): CalendarItem[] {
  const items: CalendarItem[] = [];
  for (const follow of follows) {
    for (const episode of Object.values(follow.episodes)) {
      if (!episode.released) continue;
      const released = Date.parse(episode.released);
      if (!(released >= from && released < to)) continue;
      const download = episode.download;
      items.push({
        followId: follow.id, type: follow.type, metaId: follow.metaId, name: follow.name,
        ...(follow.poster ? { poster: follow.poster } : {}),
        videoId: episode.videoId, season: episode.season, episode: episode.episode,
        ...(episode.title ? { title: episode.title } : {}),
        released: episode.released,
        state: download ? download.state : released > now ? "upcoming" : "released",
        ...(download?.reasonKey ? { reasonKey: download.reasonKey } : {}),
        ...(download?.nextAttemptAt ? { nextAttemptAt: download.nextAttemptAt } : {}),
        ...(episode.ambiguous ? { ambiguous: true } : {}),
        ...(episode.dateUncertain ? { dateUncertain: true } : {}),
        ...(episode.releasedSource ? { releasedSource: episode.releasedSource } : {}),
      });
    }
  }
  items.sort((a, b) => a.released.localeCompare(b.released)
    || a.name.localeCompare(b.name)
    || a.season - b.season
    || a.episode - b.episode);
  return items.slice(0, CALENDAR_LIMIT);
}

/** The uncertain episodes of the caller's follows that carry no date: there is no day to place
 *  them on, but the calendar still lists them once under its grid. */
export function undatedCalendarItems(follows: Follow[], limit: number): CalendarUndatedItem[] {
  const items: CalendarUndatedItem[] = [];
  for (const follow of follows) {
    for (const episode of Object.values(follow.episodes)) {
      if (episode.released || !episode.dateUncertain) continue;
      const download = episode.download;
      items.push({
        followId: follow.id, type: follow.type, metaId: follow.metaId, name: follow.name,
        ...(follow.poster ? { poster: follow.poster } : {}),
        videoId: episode.videoId, season: episode.season, episode: episode.episode,
        ...(episode.title ? { title: episode.title } : {}),
        state: download ? download.state : "upcoming",
        ...(download?.reasonKey ? { reasonKey: download.reasonKey } : {}),
        ...(download?.nextAttemptAt ? { nextAttemptAt: download.nextAttemptAt } : {}),
        ...(episode.ambiguous ? { ambiguous: true } : {}),
        dateUncertain: true,
      });
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name)
    || a.season - b.season
    || a.episode - b.episode);
  return items.slice(0, Math.max(0, limit));
}

/** The window a feed carries: everything released in the last month, and the next half year. */
const FEED_PAST_MS = 30 * DAY_MS;
const FEED_FUTURE_MS = 180 * DAY_MS;
/** RFC 5545 wants no logical line longer than 75 octets, the fold space included. */
const ICS_LINE_OCTETS = 75;

/** Escapes a text value the way RFC 5545 wants it: the backslash first, then the two
 *  separators and any newline, since escaping the backslash first would double its escapes. */
const icsText = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");

/** Folds one logical line to the 75-octet budget, a continuation line spending one on its
 *  leading space. Iterating by character never splits a multi-byte one. */
const foldIcsLine = (line: string): string => {
  const folded: string[] = [];
  let current = "";
  let octets = 0;
  for (const character of line) {
    const size = Buffer.byteLength(character, "utf8");
    if (octets + size > (folded.length ? ICS_LINE_OCTETS - 1 : ICS_LINE_OCTETS)) {
      folded.push(current);
      current = "";
      octets = 0;
    }
    current += character;
    octets += size;
  }
  folded.push(current);
  return folded.join("\r\n ");
};

/** The UTC calendar day a release names, as `YYYYMMDD`. */
const icsDay = (iso: string): string => iso.slice(0, 10).replace(/-/g, "");
/** The UTC day after the one a `YYYYMMDD` string names. */
const icsNextDay = (day: string): string =>
  icsDay(new Date(Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00Z`) + DAY_MS).toISOString());
/** An instant as `YYYYMMDDTHHMMSSZ`, the form DTSTAMP wants. */
const icsStamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** Every state a feed can carry, in the English words its DESCRIPTION uses. */
const FEED_STATE: Record<CalendarEpisodeState, string> = {
  upcoming: "upcoming", released: "released", reserved: "queued", queued: "queued",
  waiting: "waiting for a source", completed: "downloaded", attention: "needs attention", skipped: "skipped",
};

/** One episode's summary: a film is its title, a series episode its code and title, and an
 *  uncertain date is marked so the reader knows the day may still move. */
const feedSummary = (item: CalendarItem): string => {
  const code = `S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}`;
  const body = item.type === "movie" ? item.name : `${item.name} ${code}${item.title ? ` · ${item.title}` : ""}`;
  return `${item.dateUncertain ? "≈ " : ""}${body}`;
};

/** The private calendar an account subscribes to, as one RFC 5545 document. Pure: the route
 *  decides who may read it, and `now` fixes both DTSTAMP and the window that is written. */
export function calendarFeed(follows: Follow[], now: number, options: { name: string; language: string }): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Stremio Offline//Following//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${icsText(options.name)}`,
  ];
  for (const item of calendarItems(follows, now - FEED_PAST_MS, now + FEED_FUTURE_MS, now)) {
    const start = icsDay(item.released);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${item.followId}-${item.season}-${item.episode}@stremio-offline`,
      `DTSTAMP:${icsStamp(now)}`,
      `DTSTART;VALUE=DATE:${start}`,
      `DTEND;VALUE=DATE:${icsNextDay(start)}`,
      `SUMMARY:${icsText(feedSummary(item))}`,
      `DESCRIPTION:${icsText(FEED_STATE[item.state])}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

export interface ActivityItem {
  followId: string;
  type: string;
  metaId: string;
  name: string;
  poster?: string;
  season: number;
  episode: number;
  title?: string;
  state: EpisodeDownloadState;
  reasonKey?: string;
  nextAttemptAt?: string;
  jobId?: string;
  updatedAt: string;
}

/** Every episode of the caller's follows that the download service has touched, the most
 *  recently changed first. */
export function activityItems(follows: Follow[], limit: number): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const follow of follows) {
    for (const episode of Object.values(follow.episodes)) {
      const download = episode.download;
      if (!download) continue;
      items.push({
        followId: follow.id, type: follow.type, metaId: follow.metaId, name: follow.name,
        ...(follow.poster ? { poster: follow.poster } : {}),
        season: episode.season, episode: episode.episode,
        ...(episode.title ? { title: episode.title } : {}),
        state: download.state,
        ...(download.reasonKey ? { reasonKey: download.reasonKey } : {}),
        ...(download.nextAttemptAt ? { nextAttemptAt: download.nextAttemptAt } : {}),
        ...(download.jobId ? { jobId: download.jobId } : {}),
        updatedAt: download.updatedAt,
      });
    }
  }
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return items.slice(0, Math.max(0, limit));
}

/** The followed series, on disk in `<dataDir>/follows.json`. A file that cannot be read
 *  is left where it is: writing over it would throw away series nobody can follow again. */
export class FollowStore {
  private follows: Follow[] = [];
  private unreadable = false;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly file: string;

  constructor(dataDir: string) { this.file = path.join(dataDir, "follows.json"); }

  get unavailable(): boolean { return this.unreadable; }

  async load(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.follows = [];
        this.unreadable = false;
        return;
      }
      this.follows = [];
      this.unreadable = true;
      log("ERROR", "The followed series file could not be read, it is left as it is", { file: this.file, error: String(error) });
      return;
    }
    try {
      const parsed = JSON.parse(raw) as FollowFile;
      if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || !Array.isArray(parsed.follows)) throw new Error("not a version 1 follow file");
      this.follows = parsed.follows;
      this.unreadable = false;
    } catch (error) {
      this.follows = [];
      this.unreadable = true;
      log("ERROR", "The followed series file could not be read, it is left as it is", { file: this.file, error: String(error) });
    }
  }

  listForOwner(ownerUserId: string): Follow[] {
    return this.unreadable ? [] : this.follows.filter((follow) => follow.ownerUserId === ownerUserId);
  }

  /** Every follow, for the reconciliation that counts outstanding episodes across owners. */
  all(): Follow[] {
    return this.unreadable ? [] : this.follows.slice();
  }

  get(id: string): Follow | undefined {
    return this.unreadable ? undefined : this.follows.find((follow) => follow.id === id);
  }

  findByMeta(ownerUserId: string, type: string, metaId: string): Follow | undefined {
    return this.unreadable ? undefined : this.follows.find((follow) =>
      follow.ownerUserId === ownerUserId && follow.type === type && follow.metaId === metaId);
  }

  /** The enabled follows whose check is due, soonest first. */
  due(now: number): Follow[] {
    if (this.unreadable) return [];
    const at = new Date(now).toISOString();
    return this.follows
      .filter((follow) => follow.enabled && follow.nextCheckAt <= at)
      .sort((a, b) => a.nextCheckAt.localeCompare(b.nextCheckAt));
  }

  async create(input: { ownerUserId: string; type: string; metaId: string; name: string; poster?: string }, now: number): Promise<Follow> {
    this.assertWritable();
    const existing = this.findByMeta(input.ownerUserId, input.type, input.metaId);
    if (existing) return existing;
    const at = new Date(now).toISOString();
    const follow: Follow = {
      id: randomUUID(),
      ownerUserId: input.ownerUserId,
      type: input.type,
      metaId: input.metaId,
      name: input.name,
      ...(input.poster ? { poster: input.poster } : {}),
      createdAt: at,
      updatedAt: at,
      enabled: true,
      revision: 1,
      nextCheckAt: at,
      failures: 0,
      episodes: {},
    };
    this.follows.push(follow);
    await this.persist();
    return follow;
  }

  async update(id: string, mutate: (follow: Follow) => void): Promise<Follow> {
    this.assertWritable();
    const follow = this.get(id);
    if (!follow) throw new AppError("The item was not found.", "err.itemNotFound", 404);
    mutate(follow);
    follow.updatedAt = new Date().toISOString();
    await this.persist();
    return follow;
  }

  async remove(id: string): Promise<void> {
    this.assertWritable();
    const index = this.follows.findIndex((follow) => follow.id === id);
    if (index < 0) return;
    this.follows.splice(index, 1);
    await this.persist();
  }

  async removeOwner(ownerUserId: string): Promise<number> {
    this.assertWritable();
    const before = this.follows.length;
    this.follows = this.follows.filter((follow) => follow.ownerUserId !== ownerUserId);
    const removed = before - this.follows.length;
    if (removed) await this.persist();
    return removed;
  }

  async recordCheck(id: string, result: { episodes: FollowEpisode[]; now: number } | { errorKey: string; now: number }): Promise<void> {
    this.assertWritable();
    const follow = this.get(id);
    if (!follow) return;
    const at = new Date(result.now).toISOString();
    if ("episodes" in result) {
      for (const episode of result.episodes) {
        const existing = follow.episodes[episode.key];
        if (!existing) {
          follow.episodes[episode.key] = episode;
          continue;
        }
        // A key already seen keeps the moment it was first seen and the download it carries;
        // everything else the provider now says about it wins. A field the new check leaves out
        // is cleared rather than inherited, so a corrected date or a dropped flag does not linger.
        const merged: FollowEpisode = { ...existing, ...episode, firstSeenAt: existing.firstSeenAt };
        if (episode.released === undefined) delete merged.released;
        if (episode.releasedSource === undefined) delete merged.releasedSource;
        if (episode.dateUncertain === undefined) delete merged.dateUncertain;
        if (episode.releaseKind === undefined) delete merged.releaseKind;
        if (episode.theatricalAt === undefined) delete merged.theatricalAt;
        if (!episode.ambiguous) delete merged.ambiguous;
        follow.episodes[episode.key] = merged;
      }
      follow.lastCheckedAt = at;
      follow.lastSuccessfulCheckAt = at;
      follow.failures = 0;
      delete follow.lastErrorKey;
      follow.nextCheckAt = new Date(result.now + DAY_MS + followStaggerMs(follow.id)).toISOString();
    } else {
      follow.lastCheckedAt = at;
      follow.failures += 1;
      follow.lastErrorKey = result.errorKey;
      follow.nextCheckAt = new Date(result.now + failureBackoffMs(follow.failures)).toISOString();
    }
    await this.persist();
  }

  private assertWritable(): void {
    if (this.unreadable) throw new AppError("The followed series could not be read.", "err.followsUnreadable");
  }

  /** One chain, so writes land in the order they were asked for, and the caller waits for
   *  its own write rather than for the previous one to settle. */
  private persist(): Promise<void> {
    const next = this.chain.then(async () => {
      await writeFile(`${this.file}.tmp`, JSON.stringify({ version: 1, follows: this.follows }), { mode: 0o600 });
      await renameWithRetry(`${this.file}.tmp`, this.file);
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

/** One job of the queue as the follow service reads it: enough to reconcile an episode
 *  with what became of its download. */
export interface FollowJob {
  id: string;
  status: string;
  errorKey?: string;
  /** The library key the job wrote, once it has one. */
  target?: string;
  follow?: { followId: string; episodeKey: string; intent: string };
}

/** The slice of the download queue the follow service drives. */
export interface FollowQueue {
  addPending(
    title: string,
    source: { type: string; videoId: string; selection?: DownloadSelection },
    media: MediaInfo | undefined,
    ownerUserId: string,
    follow: { followId: string; episodeKey: string; intent: string },
  ): Promise<{ id: string } | undefined>;
  findActiveEpisode(ownerUserId: string, type: string, videoId: string): { id: string } | undefined;
  adopt(id: string, follow: { followId: string; episodeKey: string; intent: string }): Promise<void>;
  followJobs(): FollowJob[];
  get(id: string): { id: string; status: string; errorKey?: string } | undefined;
  retry(id: string, selection?: DownloadSelection): Promise<unknown>;
  remove(id: string): Promise<void>;
}

export interface FollowDeps {
  store: FollowStore;
  now: () => number;
  /** The owner as they are now; undefined when deleted. */
  owner: (userId: string) => { id: string; role: "admin" | "user"; disabled?: boolean } | undefined;
  /** Metadata as the owner may see it, in the owner's language, bypassing the cache. */
  meta: (owner: Viewer, type: string, metaId: string) => Promise<MetaItem | null>;
  /** Per-episode TMDB air dates for the seasons worth checking, keyed `${season}:${episode}`.
   *  Undefined when TMDB is not configured or does not know the series. */
  airDates?: (type: string, metaId: string, seasons: number[], owner: Viewer) => Promise<Map<string, string | null> | undefined>;
  /** A film's release dates by kind, from TMDB; undefined when no key is set. */
  movieReleases?: (metaId: string, owner: Viewer) => Promise<MovieReleases | null>;
  /** The owner's watched marker for a series, keyed by the meta id; the last episode they
   *  finished, or nothing when they never did. Drives the "ahead" window; `updatedAt` closes
   *  the retention delay. */
  watched?: (ownerUserId: string, metaId: string) => { season: number; episode: number; updatedAt?: string } | undefined;
  /** Delete one file by its library key. Answers whether the deletion was queued; a key that
   *  is not a library file is refused without touching anything. */
  removeFile?: (target: string) => Promise<boolean>;
  /** The download queue the followed series queue into. */
  queue: FollowQueue;
  /** The owner may queue into this selection's library right now. */
  mayDownload: (ownerUserId: string, selection: DownloadSelection) => boolean;
  tickMs?: number;
  concurrency?: number;
}

const DEFAULT_TICK_MS = 5 * 60_000;
const FIRST_TICK_MS = 30_000;
const COOLDOWN_MS = 60_000;
const NEW_EPISODE_WINDOW_MS = 30 * 24 * 60 * 60_000;
const MAX_NEW_EPISODES = 50;
const HOUR_MS = 60 * 60_000;
/** How many episodes one call admits for a single follow, and how many may be outstanding
 *  across every follow: a long season is picked up over several passes, not in one burst. */
const ADMIT_PER_CALL = 20;
const OUTSTANDING_LIMIT = 20;
/** How many files one retention pass may delete, so a bulk cleanup never storms the queue. */
const RETENTION_PER_PASS = 10;

/** When a failed download is tried again: an hour, six hours, then a day, then a week. */
const downloadLadderMs = (attempts: number): number =>
  attempts <= 1 ? HOUR_MS : attempts === 2 ? 6 * HOUR_MS : attempts <= 32 ? DAY_MS : 7 * DAY_MS;

const pad2 = (value: number): string => String(Math.max(0, Math.trunc(value))).padStart(2, "0");

const afterMarker = (episode: { season: number; episode: number }, marker: { season: number; episode: number }): boolean =>
  episode.season > marker.season || (episode.season === marker.season && episode.episode > marker.episode);

/** The daily metadata check behind the followed series, and the "new episodes" it feeds. */
export class FollowService {
  private readonly tickMs: number;
  private readonly concurrency: number;
  private timer?: ReturnType<typeof setInterval>;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private readonly running = new Map<string, Promise<void>>();
  private readonly lastStarted = new Map<string, number>();
  /** One chain for every download mutation, so admission, sync, skip, retry and the queue
   *  hooks never interleave across an await. Reentrant, because a skip calls the queue whose
   *  guard calls back into the service. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: FollowDeps) {
    this.tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
    this.concurrency = Math.max(1, deps.concurrency ?? 2);
  }

  start(): void {
    if (this.timer) return;
    // Nobody is waiting for the first check, so it waits out the boot instead of
    // competing with the library scan for the same sleeping addons.
    this.startupTimer = setTimeout(() => { void this.tick(); }, FIRST_TICK_MS);
    this.startupTimer.unref?.();
    this.timer = setInterval(() => { void this.tick(); }, this.tickMs);
    this.timer.unref?.();
    log("INFO", "Followed series checks armed", { tickMs: this.tickMs });
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.timer) clearInterval(this.timer);
    this.startupTimer = undefined;
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    const due = this.deps.store.due(this.deps.now());
    let next = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, due.length) }, async () => {
      while (next < due.length) {
        const follow = due[next++];
        try {
          await this.check(follow.id, "schedule");
        } catch (error) {
          log("WARN", "A followed series check failed", { follow: follow.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
    });
    await Promise.all(workers);
    await this.maintain();
  }

  /** Runs `fn` under the one download mutex. Nothing inside it may wait for a queue call
   *  that comes back through a guard, or it would wait on itself: a skip therefore removes
   *  the job after leaving the mutex, and the removal guard takes it on its own. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** A second call for the same follow while one is in flight joins it rather than
   *  asking the addons twice. */
  check(followId: string, reason: "schedule" | "manual"): Promise<void> {
    const existing = this.running.get(followId);
    if (existing) return existing;
    const run = this.runCheck(followId, reason).finally(() => { this.running.delete(followId); });
    this.running.set(followId, run);
    return run;
  }

  /** A check the caller is waiting for, held off for a moment after any other check
   *  so a button pressed twice does not hammer the metadata providers. */
  async checkNow(followId: string, ownerUserId: string): Promise<Follow | undefined> {
    const follow = this.deps.store.get(followId);
    if (!follow || follow.ownerUserId !== ownerUserId) throw new AppError("The item was not found.", "err.itemNotFound", 404);
    const started = this.lastStarted.get(followId);
    if (started !== undefined && this.deps.now() - started < COOLDOWN_MS) {
      throw new AppError("Checked a moment ago, try again shortly.", "err.followCooldown", 429);
    }
    this.lastStarted.set(followId, this.deps.now());
    await this.check(followId, "manual");
    return this.deps.store.get(followId);
  }

  /** Episodes of the owner's followed series released since the follow was created,
   *  inside the last thirty days and not yet watched past. */
  newEpisodes(ownerUserId: string, watched: (metaId: string) => { season: number; episode: number } | undefined): NewEpisode[] {
    const now = this.deps.now();
    const floor = now - NEW_EPISODE_WINDOW_MS;
    const items: NewEpisode[] = [];
    for (const follow of this.deps.store.listForOwner(ownerUserId)) {
      const createdAt = Date.parse(follow.createdAt);
      const marker = watched(follow.metaId);
      for (const episode of Object.values(follow.episodes)) {
        if (episode.ambiguous || !episode.released) continue;
        const released = Date.parse(episode.released);
        if (!(released > createdAt) || released > now || released < floor) continue;
        if (marker && !afterMarker(episode, marker)) continue;
        items.push({
          followId: follow.id, type: follow.type, metaId: follow.metaId, name: follow.name,
          ...(follow.poster ? { poster: follow.poster } : {}),
          videoId: episode.videoId, season: episode.season, episode: episode.episode,
          ...(episode.title ? { title: episode.title } : {}),
          released: episode.released,
        });
      }
    }
    items.sort((a, b) => b.released.localeCompare(a.released));
    return items.slice(0, MAX_NEW_EPISODES);
  }

  /** The follow as it must still stand after an await: present, switched on, still automatic
   *  and on the revision this run started from. */
  private admittable(followId: string, revision: number): Follow | undefined {
    const follow = this.deps.store.get(followId);
    if (!follow || !follow.enabled || !follow.autoDownload || follow.revision !== revision) return undefined;
    return follow;
  }

  /** Like `admittable`, but a paused follow still reconciles: existing jobs are recorded,
   *  only new admissions and the retry ladder wait for it to be switched on. */
  private fresh(followId: string, revision: number): Follow | undefined {
    const follow = this.deps.store.get(followId);
    if (!follow || !follow.autoDownload || follow.revision !== revision) return undefined;
    return follow;
  }

  private mayQueue(follow: Follow): boolean {
    const owner = this.deps.owner(follow.ownerUserId);
    if (!owner || owner.disabled || !follow.autoDownload) return false;
    return this.deps.mayDownload(follow.ownerUserId, follow.autoDownload.selection);
  }

  /** Where the owner is watching one series, as the "ahead" window reads it. */
  private watchedFor(follow: Follow): { season: number; episode: number } | undefined {
    return this.deps.watched?.(follow.ownerUserId, follow.metaId);
  }

  private requireOwn(followId: string, ownerUserId: string): Follow {
    const follow = this.deps.store.get(followId);
    if (!follow || follow.ownerUserId !== ownerUserId) throw new AppError("The item was not found.", "err.itemNotFound", 404);
    return follow;
  }

  private intentOf(followId: string, episodeKey: string, generation: number): string {
    return `${followId}:${episodeKey}:${generation}`;
  }

  private async setDownload(followId: string, episodeKey: string, download: EpisodeDownload): Promise<void> {
    await this.deps.store.update(followId, (current) => {
      const episode = current.episodes[episodeKey];
      if (!episode) return;
      episode.download = { ...download, updatedAt: new Date(this.deps.now()).toISOString() };
    });
  }

  private jobTitle(follow: Follow, episode: FollowEpisode): string {
    if (follow.type === "movie") return follow.name;
    return `${follow.name} · S${pad2(episode.season)}E${pad2(episode.episode)}`;
  }

  private episodeMedia(follow: Follow, episode: FollowEpisode): MediaInfo {
    if (follow.type === "movie") {
      return { kind: "movie", title: follow.name, id: follow.metaId, metaType: "movie", ...(follow.poster ? { poster: follow.poster } : {}) };
    }
    return {
      kind: "episode", title: follow.name, season: episode.season, episode: episode.episode,
      ...(episode.title ? { episodeTitle: episode.title } : {}),
      id: follow.metaId, metaType: follow.type,
      ...(follow.poster ? { poster: follow.poster } : {}),
    };
  }

  /** How many episodes are spoken for across every follow, so a new burst never runs past
   *  the queue's patience. */
  private outstanding(): number {
    let count = 0;
    for (const follow of this.deps.store.all()) {
      // A follow that was paused or switched off no longer admits anything, so what it left
      // behind must not hold the shared budget away from every other follow.
      if (!follow.enabled || !follow.autoDownload) continue;
      for (const episode of Object.values(follow.episodes)) {
        const state = episode.download?.state;
        if (state === "reserved" || state === "queued" || state === "waiting") count += 1;
      }
    }
    return count;
  }

  /** Every eligible, unspoken-for episode of one follow, in order, capped per call and by the
   *  outstanding budget. A follow switch that is missing a date or disagreeing goes to
   *  attention instead of being guessed at. */
  private async admitLocked(followId: string): Promise<void> {
    const start = this.deps.store.get(followId);
    if (!start) return;
    const revision = start.revision;
    let follow = this.admittable(followId, revision);
    if (!follow) return;
    if (!this.mayQueue(follow)) {
      if (follow.autoDownload!.blockedKey !== "err.downloadLibraryNotAllowed") {
        await this.deps.store.update(followId, (current) => { if (current.autoDownload) current.autoDownload.blockedKey = "err.downloadLibraryNotAllowed"; });
      }
      return;
    }
    if (follow.autoDownload!.blockedKey) {
      await this.deps.store.update(followId, (current) => { if (current.autoDownload) delete current.autoDownload.blockedKey; });
      follow = this.admittable(followId, revision);
      if (!follow) return;
    }
    const jobs = new Set(this.deps.queue.followJobs().flatMap((job) => job.follow ? [job.follow.intent] : []));
    const ordered = Object.values(follow.episodes).sort((a, b) => a.season - b.season || a.episode - b.episode);
    let admitted = 0;
    for (const episode of ordered) {
      follow = this.admittable(followId, revision);
      if (!follow) return;
      const current = follow.episodes[episode.key];
      if (!current) continue;
      const verdict = downloadEligibility(follow, current, this.deps.now(), this.watchedFor(follow));
      if (verdict === "attention-ambiguous" || verdict === "attention-no-date") {
        if (!current.download) {
          const reasonKey = verdict === "attention-ambiguous" ? "err.followEpisodeAmbiguous" : "err.followNoReleaseDate";
          await this.setDownload(followId, episode.key, { state: "attention", intent: this.intentOf(followId, episode.key, 1), generation: 1, attempts: 0, reasonKey, updatedAt: "" });
        }
        continue;
      }
      if (verdict !== "eligible") continue;
      const download = current.download;
      // A reserved episode whose job is already there is left for sync to link; only one
      // whose job never landed is admitted again.
      if (download && (download.state !== "reserved" || jobs.has(download.intent))) continue;
      if (admitted >= ADMIT_PER_CALL) return;
      if (this.outstanding() >= OUTSTANDING_LIMIT) return;
      await this.enqueueLocked(followId, revision, episode.key, download?.generation ?? 1);
      admitted += 1;
    }
  }

  /** The admission of one episode: reserve, queue the lazy job, then link or fall to attention. */
  private async enqueueLocked(followId: string, revision: number, episodeKey: string, generation: number): Promise<void> {
    const before = this.admittable(followId, revision);
    const episode = before?.episodes[episodeKey];
    if (!before || !episode) return;
    const intent = this.intentOf(followId, episodeKey, generation);
    await this.setDownload(followId, episodeKey, { state: "reserved", intent, generation, attempts: 0, updatedAt: "" });
    let follow = this.admittable(followId, revision);
    if (!follow) return;
    const job = await this.deps.queue.addPending(
      this.jobTitle(follow, episode),
      { type: follow.type, videoId: episode.videoId, selection: effectiveSelection(follow.autoDownload!, episode, this.deps.now()) },
      this.episodeMedia(follow, episode),
      follow.ownerUserId,
      { followId, episodeKey, intent },
    );
    follow = this.admittable(followId, revision);
    if (!follow) return;
    const existing = job ? undefined : this.deps.queue.findActiveEpisode(follow.ownerUserId, follow.type, episode.videoId);
    // The owner had already queued this episode by hand: the job takes this intent, so the
    // reconciliation, its completion and its removal all find it like one the follow queued.
    if (existing) await this.deps.queue.adopt(existing.id, { followId, episodeKey, intent });
    const linked = job ?? existing;
    await this.setDownload(followId, episodeKey, linked
      ? { state: "queued", intent, generation, jobId: linked.id, attempts: 0, updatedAt: "" }
      : { state: "attention", intent, generation, attempts: 0, reasonKey: "err.followJobMissing", updatedAt: "" });
  }

  /** Records a job's own verdict on the episode it was queued for. */
  private async linkLocked(followId: string, revision: number, episodeKey: string, job: FollowJob, now: number): Promise<void> {
    const follow = this.fresh(followId, revision);
    const download = follow?.episodes[episodeKey]?.download;
    if (!follow || !download) return;
    if (job.status === "completed") {
      await this.setDownload(followId, episodeKey, { ...download, ...(job.target ? { target: job.target } : {}), state: "completed", jobId: job.id, reasonKey: undefined, nextAttemptAt: undefined, updatedAt: "" });
    } else if (job.status === "failed") {
      await this.setWaiting(followId, episodeKey, { ...download, jobId: job.id }, job, now);
    } else {
      await this.setDownload(followId, episodeKey, { ...download, state: "queued", jobId: job.id, reasonKey: undefined, nextAttemptAt: undefined, updatedAt: "" });
    }
  }

  private async setWaiting(followId: string, episodeKey: string, download: EpisodeDownload, job: FollowJob, now: number): Promise<void> {
    const attempts = download.attempts + 1;
    const follow = this.deps.store.get(followId);
    const episode = follow?.episodes[episodeKey];
    const window = follow?.autoDownload && episode ? graceUntil(follow.autoDownload, episode) : undefined;
    const grace = window !== undefined && window > now ? window : undefined;
    const ladder = now + downloadLadderMs(attempts);
    await this.setDownload(followId, episodeKey, {
      ...download, state: "waiting", attempts,
      reasonKey: job.errorKey ?? "err.followDownloadFailed",
      nextAttemptAt: new Date(grace !== undefined ? Math.min(ladder, grace) : ladder).toISOString(),
      graceUntil: grace !== undefined ? new Date(grace).toISOString() : undefined,
      updatedAt: "",
    });
  }

  /** Reconciles every episode that has a download with what the queue now says about it. */
  private async syncLocked(): Promise<void> {
    const now = this.deps.now();
    const jobs = new Map<string, FollowJob>();
    for (const job of this.deps.queue.followJobs()) if (job.follow) jobs.set(job.follow.intent, job);
    for (const snapshot of this.deps.store.all()) {
      const revision = snapshot.revision;
      for (const episodeKey of Object.keys(snapshot.episodes)) {
        const follow = this.fresh(snapshot.id, revision);
        if (!follow) break;
        const download = follow.episodes[episodeKey]?.download;
        if (!download) continue;
        if (download.state === "reserved") {
          const job = jobs.get(download.intent);
          if (job) await this.linkLocked(follow.id, revision, episodeKey, job, now);
          continue;
        }
        if (download.state === "queued") {
          const job = jobs.get(download.intent);
          if (!job) await this.setDownload(follow.id, episodeKey, { ...download, state: "attention", jobId: undefined, reasonKey: "err.followJobMissing", nextAttemptAt: undefined, updatedAt: "" });
          else if (job.status === "completed") await this.setDownload(follow.id, episodeKey, { ...download, ...(job.target ? { target: job.target } : {}), state: "completed", reasonKey: undefined, nextAttemptAt: undefined, updatedAt: "" });
          else if (job.status === "failed") await this.setWaiting(follow.id, episodeKey, download, job, now);
          continue;
        }
        if (download.state !== "waiting") continue;
        if (!download.nextAttemptAt || Date.parse(download.nextAttemptAt) > now) continue;
        // An episode whose date moved into the future (a corrected placeholder) is not looked
        // for again before it airs.
        const airs = follow.episodes[episodeKey]?.released;
        if (airs && Date.parse(airs) > now) continue;
        if (!follow.enabled || !this.mayQueue(follow)) continue;
        const job = jobs.get(download.intent);
        if (job && job.status === "failed") {
          await this.deps.queue.retry(job.id, effectiveSelection(follow.autoDownload!, follow.episodes[episodeKey], now));
          if (!this.fresh(follow.id, revision)) return;
          await this.setDownload(follow.id, episodeKey, { ...download, state: "queued", jobId: job.id, reasonKey: undefined, nextAttemptAt: undefined, updatedAt: "" });
        } else if (job && job.status === "completed") {
          await this.setDownload(follow.id, episodeKey, { ...download, ...(job.target ? { target: job.target } : {}), state: "completed", reasonKey: undefined, nextAttemptAt: undefined, updatedAt: "" });
        } else if (!job && !download.jobId) {
          // The failed job was cleared from the queue on purpose; the episode is still wanted.
          await this.enqueueLocked(follow.id, revision, episodeKey, download.generation + 1);
        } else {
          await this.setDownload(follow.id, episodeKey, { ...download, state: "attention", jobId: undefined, reasonKey: "err.followJobMissing", nextAttemptAt: undefined, updatedAt: "" });
        }
      }
    }
  }

  /** The episodes a proposed rule would queue right now, for the setup dialog's count. */
  preview(follow: Follow, start: { startMode: "new" | "from" | "ahead"; startSeason?: number; startEpisode?: number; aheadCount?: number }): FollowEpisode[] {
    const now = this.deps.now();
    const proposed: Follow = {
      ...follow,
      autoDownload: {
        enabledAt: follow.autoDownload?.enabledAt ?? new Date(now).toISOString(),
        startMode: start.startMode,
        ...(start.startSeason != null ? { startSeason: start.startSeason } : {}),
        ...(start.startEpisode != null ? { startEpisode: start.startEpisode } : {}),
        ...(start.startMode === "ahead" && start.aheadCount != null ? { aheadCount: start.aheadCount } : {}),
        // `downloadEligibility` reads the start rule only, never the selection.
        selection: follow.autoDownload?.selection ?? ({} as DownloadSelection),
      },
    };
    const watched = this.watchedFor(follow);
    return Object.values(follow.episodes)
      .filter((episode) => downloadEligibility(proposed, episode, now, watched) === "eligible")
      .sort((a, b) => a.season - b.season || a.episode - b.episode);
  }

  private async maintain(): Promise<void> {
    try {
      await this.locked(async () => {
        await this.syncLocked();
        for (const follow of this.deps.store.all()) {
          if (follow.autoDownload && follow.enabled) await this.admitLocked(follow.id);
        }
        await this.applyRetention();
      });
    } catch (error) {
      log("WARN", "The automatic downloads could not be reconciled", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Deletes the files of watched episodes once their follow's delay has passed. Only an
   *  administrator's follow may hold a delay, and only an episode whose target the follow
   *  itself recorded is ever touched; the state stays `completed`, so it is not queued again. */
  private async applyRetention(): Promise<void> {
    const removeFile = this.deps.removeFile;
    if (!removeFile) return;
    const now = this.deps.now();
    let removed = 0;
    for (const follow of this.deps.store.all()) {
      const retention = follow.autoDownload?.retention;
      if (!retention || !follow.enabled) continue;
      const owner = this.deps.owner(follow.ownerUserId);
      if (!owner || owner.disabled || owner.role !== "admin") continue;
      const marker = this.deps.watched?.(follow.ownerUserId, follow.metaId);
      if (!marker?.updatedAt) continue;
      const dueAt = Date.parse(marker.updatedAt) + retention.afterWatchedDays * DAY_MS;
      if (!(now >= dueAt)) continue;
      const episodes = Object.values(follow.episodes).sort((a, b) => a.season - b.season || a.episode - b.episode);
      for (const episode of episodes) {
        if (removed >= RETENTION_PER_PASS) return;
        const download = episode.download;
        if (!download || download.state !== "completed" || !download.target || download.removedAt) continue;
        const covered = marker.season > episode.season || (marker.season === episode.season && marker.episode >= episode.episode);
        if (!covered) continue;
        const accepted = await removeFile(download.target);
        if (!accepted) continue;
        log("INFO", "Deleting a watched episode", { follow: follow.id, episode: episode.key, library: parseLibraryPath(download.target)?.libraryId });
        await this.setDownload(follow.id, episode.key, { ...download, removedAt: new Date(now).toISOString(), removedReason: "retention" });
        removed += 1;
      }
    }
  }

  admit(followId: string): Promise<void> { return this.locked(() => this.admitLocked(followId)); }
  sync(): Promise<void> { return this.locked(() => this.syncLocked()); }
  reconcile(): Promise<void> { return this.sync(); }

  setAutoDownload(followId: string, ownerUserId: string, value: Omit<FollowAutoDownload, "enabledAt" | "blockedKey"> | null): Promise<void> {
    return this.locked(async () => {
      this.requireOwn(followId, ownerUserId);
      const at = new Date(this.deps.now()).toISOString();
      await this.deps.store.update(followId, (current) => {
        if (value === null) {
          delete current.autoDownload;
        } else {
          const previous = current.autoDownload;
          current.autoDownload = {
            enabledAt: previous ? previous.enabledAt : at,
            startMode: value.startMode,
            ...(value.startSeason != null ? { startSeason: value.startSeason } : {}),
            ...(value.startEpisode != null ? { startEpisode: value.startEpisode } : {}),
            ...(value.aheadCount ? { aheadCount: value.aheadCount } : {}),
            ...(value.graceDays ? { graceDays: value.graceDays } : {}),
            ...(value.retention ? { retention: value.retention } : previous?.retention ? { retention: previous.retention } : {}),
            selection: value.selection,
          };
        }
        current.revision += 1;
      });
      if (value !== null) {
        await this.retryUnderNewRules(followId);
        await this.admitLocked(followId);
      }
    });
  }

  /** New rules are the user's answer to an episode that found nothing: everything still
   *  waiting for a source, or lost from the queue, is tried again now with them. */
  private async retryUnderNewRules(followId: string): Promise<void> {
    const follow = this.admittable(followId, this.deps.store.get(followId)?.revision ?? -1);
    if (!follow || !this.mayQueue(follow)) return;
    const revision = follow.revision;
    for (const episode of Object.values(follow.episodes)) {
      const download = episode.download;
      if (!download) continue;
      const lost = download.state === "attention" && download.reasonKey === "err.followJobMissing";
      if (download.state !== "waiting" && !lost) continue;
      const job = download.jobId ? this.deps.queue.get(download.jobId) : undefined;
      if (job && job.status === "failed") {
        await this.deps.queue.retry(job.id, effectiveSelection(follow.autoDownload!, episode, this.deps.now()));
        if (!this.admittable(followId, revision)) return;
        await this.setDownload(followId, episode.key, { ...download, state: "queued", attempts: 0, reasonKey: undefined, nextAttemptAt: undefined, updatedAt: "" });
      } else if (!job) {
        await this.enqueueLocked(followId, revision, episode.key, download.generation + 1);
      }
    }
  }

  async skipEpisode(followId: string, ownerUserId: string, episodeKey: string): Promise<void> {
    const running = await this.locked(async () => {
      const follow = this.requireOwn(followId, ownerUserId);
      const download = follow.episodes[episodeKey]?.download;
      if (!download) return undefined;
      const job = download.jobId ? this.deps.queue.get(download.jobId) : undefined;
      if (job && job.status !== "completed" && job.status !== "failed") return job.id;
      await this.setDownload(followId, episodeKey, { ...download, state: "skipped", reasonKey: "err.followSkipped", nextAttemptAt: undefined, updatedAt: "" });
      return undefined;
    });
    // Outside the mutex: the removal guard records the skip under it before the row goes.
    if (running) await this.deps.queue.remove(running);
  }

  retryEpisode(followId: string, ownerUserId: string, episodeKey: string): Promise<void> {
    return this.locked(async () => {
      const follow = this.requireOwn(followId, ownerUserId);
      const revision = follow.revision;
      const download = follow.episodes[episodeKey]?.download;
      if (!download) return;
      if (!["waiting", "attention", "skipped"].includes(download.state)) return;
      const job = download.jobId ? this.deps.queue.get(download.jobId) : undefined;
      if (job && job.status === "failed") {
        await this.deps.queue.retry(job.id, follow.autoDownload ? effectiveSelection(follow.autoDownload, follow.episodes[episodeKey], this.deps.now()) : undefined);
        if (!this.fresh(followId, revision)) return;
        await this.setDownload(followId, episodeKey, { ...download, state: "queued", reasonKey: undefined, nextAttemptAt: undefined, updatedAt: "" });
        return;
      }
      if (!follow.autoDownload) return;
      if (!this.mayQueue(follow)) {
        await this.deps.store.update(followId, (current) => { if (current.autoDownload) current.autoDownload.blockedKey = "err.downloadLibraryNotAllowed"; });
        return;
      }
      // An explicit retry does not re-apply the start rule: the episode was asked for.
      await this.enqueueLocked(followId, revision, episodeKey, download.generation + 1);
    });
  }

  jobCompleted(job: Readonly<FollowJob>): Promise<void> {
    return this.locked(async () => {
      const ref = job.follow;
      const download = ref ? this.deps.store.get(ref.followId)?.episodes[ref.episodeKey]?.download : undefined;
      if (!ref || !download || download.intent !== ref.intent || download.state === "completed") return;
      await this.setDownload(ref.followId, ref.episodeKey, { ...download, ...(job.target ? { target: job.target } : {}), state: "completed", reasonKey: undefined, nextAttemptAt: undefined, updatedAt: "" });
    });
  }

  jobRemoving(job: Readonly<FollowJob>, reason: "user" | "account"): Promise<void> {
    return this.locked(async () => {
      const ref = job.follow;
      if (reason !== "user" || !ref) return;
      const download = this.deps.store.get(ref.followId)?.episodes[ref.episodeKey]?.download;
      if (!download || download.intent !== ref.intent) return;
      // A skip the person already chose stands; removing the job afterwards only tidies the queue.
      if (download.state === "skipped") return;
      if (job.status === "completed") {
        if (download.state === "completed") return;
        await this.setDownload(ref.followId, ref.episodeKey, { ...download, ...(job.target ? { target: job.target } : {}), state: "completed", reasonKey: undefined, nextAttemptAt: undefined, updatedAt: "" });
        return;
      }
      if (job.status === "failed") {
        // Clearing a failure tidies the queue; it does not say the episode is unwanted, so it
        // keeps waiting and a fresh job is queued at its next attempt.
        const attempts = Math.max(1, download.attempts);
        await this.setDownload(ref.followId, ref.episodeKey, {
          ...download, state: "waiting", jobId: undefined, attempts,
          reasonKey: job.errorKey ?? download.reasonKey ?? "err.followDownloadFailed",
          nextAttemptAt: new Date(this.deps.now() + downloadLadderMs(attempts)).toISOString(), updatedAt: "",
        });
        return;
      }
      await this.setDownload(ref.followId, ref.episodeKey, { ...download, state: "skipped", reasonKey: "err.followSkipped", nextAttemptAt: undefined, updatedAt: "" });
    });
  }

  jobsClearing(jobs: ReadonlyArray<Readonly<FollowJob>>): Promise<void> {
    return this.locked(async () => {
      for (const job of jobs) {
        const ref = job.follow;
        if (!ref || job.status !== "completed") continue;
        const download = this.deps.store.get(ref.followId)?.episodes[ref.episodeKey]?.download;
        if (!download || download.intent !== ref.intent || download.state === "completed") continue;
        await this.setDownload(ref.followId, ref.episodeKey, { ...download, ...(job.target ? { target: job.target } : {}), state: "completed", reasonKey: undefined, nextAttemptAt: undefined, updatedAt: "" });
      }
    });
  }

  private async runCheck(followId: string, reason: "schedule" | "manual"): Promise<void> {
    const follow = this.deps.store.get(followId);
    if (!follow) return;
    const owner = this.deps.owner(follow.ownerUserId);
    if (!owner || owner.disabled) return;
    let result: { episodes: FollowEpisode[]; now: number } | { errorKey: string; now: number };
    try {
      const meta = await this.deps.meta({ id: owner.id, role: owner.role }, follow.type, follow.metaId);
      if (!meta) throw new Error("no metadata");
      const now = this.deps.now();
      const at = new Date(now).toISOString();
      if (follow.type === "movie") {
        let releases: MovieReleases | null = null;
        if (this.deps.movieReleases) {
          try { releases = await this.deps.movieReleases(follow.metaId, { id: owner.id, role: owner.role }); }
          catch (error) { log("WARN", "TMDB release dates could not be read", { follow: followId, error: error instanceof Error ? error.message : String(error) }); }
        }
        result = { episodes: [{ ...movieEpisode(meta, follow.metaId, releases, now), firstSeenAt: at }], now };
      } else {
        const episodes: FollowEpisode[] = normalizeFollowEpisodes(meta).map((episode) => ({ ...episode, firstSeenAt: at }));
        let tmdb: Map<string, string | null> | undefined;
        if (this.deps.airDates) {
          const seasons = seasonsForReconcile(episodes, this.deps.store.get(followId)?.episodes, now);
          if (seasons.length) {
            try { tmdb = await this.deps.airDates(follow.type, follow.metaId, seasons, { id: owner.id, role: owner.role }); }
            catch (error) { log("WARN", "TMDB air dates could not be read", { follow: followId, error: error instanceof Error ? error.message : String(error) }); }
          }
        }
        result = { episodes: reconcileReleaseDates(episodes, tmdb, now), now };
      }
    } catch {
      result = { errorKey: "err.followMetaUnavailable", now: this.deps.now() };
      log("WARN", "A followed series could not be checked", { follow: followId, reason });
    }
    // The episodes are the provider's facts, not the person's choices: an edit while the
    // addons answered (switching downloads on right after following) keeps them. Only a
    // follow that was removed meanwhile drops the result.
    const current = this.deps.store.get(followId);
    if (!current) return;
    await this.deps.store.recordCheck(followId, result);
    if ("episodes" in result) {
      try { await this.admit(followId); }
      catch (error) { log("WARN", "A followed series could not queue its new episodes", { follow: followId, error: error instanceof Error ? error.message : String(error) }); }
    }
  }
}
