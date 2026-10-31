import { createHash } from "node:crypto";
import type { FetchLike } from "./debrid.js";
import type { MetaItem } from "./types.js";
import { OutboundError } from "./outbound.js";
import { normalizeLanguage } from "./language.js";
import {
  tmdbExternalId,
  tmdbIdOf,
  tmdbImage,
  tmdbTitleExtras,
  type TmdbConfig,
  type TmdbTitleExtras,
} from "./tmdb.js";

export interface TitlePerson {
  name: string;
  role: "cast" | "director" | "creator" | "writer" | "novel";
  /** The character for cast; absent for crew. */
  character?: string;
  photo?: string;
}

export interface RelatedTitle {
  type: "movie" | "series";
  id: string;
  name: string;
  year?: string;
  poster?: string;
  inLibrary?: boolean;
}

export interface TitleRatings {
  imdb?: string;
  tmdb?: number;
  tmdbVotes?: number;
}

export interface TitleVideo {
  key: string;
  name: string;
  kind: "trailer" | "teaser" | "clip" | "featurette" | "behindTheScenes";
  thumbnail: string;
  language?: string;
}

export interface TitleExtras {
  people: TitlePerson[];
  related: RelatedTitle[];
  ratings: TitleRatings;
  videos: TitleVideo[];
  ageRating?: string;
  ageRatingRegion?: string;
  originalTitle?: string;
  originalLanguage?: string;
  nextEpisode?: { season: number; episode: number; name?: string; released: string };
  source: "tmdb" | "addon";
}

export interface TitleExtrasDeps {
  /** undefined when the instance has no TMDB key. */
  tmdb?: TmdbConfig;
  fetchImpl?: FetchLike;
  meta: () => Promise<MetaItem | null>;
  copies: (type: string, id: string) => Promise<unknown[]>;
  now?: () => number;
  signal?: AbortSignal;
}

interface CachedTmdbExtras {
  people: TitlePerson[];
  related: RelatedTitle[];
  tmdb?: number;
  tmdbVotes?: number;
  videos: TitleVideo[];
  ageRating?: string;
  ageRatingRegion?: string;
  originalTitle?: string;
  originalLanguage?: string;
}

interface CacheEntry {
  at: number;
  value: CachedTmdbExtras | null;
}

const SUCCESS_TTL_MS = 24 * 60 * 60_000;
const FAILURE_TTL_MS = 10 * 60_000;
const CACHE_LIMIT = 500;
const REGION: Record<string, string> = {
  en: "US",
  cs: "CZ",
  sk: "SK",
  de: "DE",
  es: "ES",
  fr: "FR",
  it: "IT",
  pl: "PL",
  pt: "BR",
  ru: "RU",
};
const CREW_ROLE: Record<string, TitlePerson["role"]> = {
  Director: "director",
  Screenplay: "writer",
  Writer: "writer",
  Teleplay: "writer",
  Novel: "novel",
};
const VIDEO_KIND: Record<string, TitleVideo["kind"]> = {
  Trailer: "trailer",
  Teaser: "teaser",
  Clip: "clip",
  Featurette: "featurette",
  "Behind the Scenes": "behindTheScenes",
};
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const TMDB_RATING_MIN_VOTES = 20;
const VIDEO_LIMIT = 8;

const extrasCache = new Map<string, CacheEntry>();
const extrasInFlight = new Map<string, Promise<CachedTmdbExtras | null>>();

export function clearTitleExtrasCache(): void {
  extrasCache.clear();
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const numberOf = (value: unknown): number | undefined => {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

const throwIfCancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new OutboundError("cancelled");
};

const keyFingerprint = (apiKey: string) => createHash("sha256").update(apiKey).digest("hex").slice(0, 12);

function tmdbPeople(data: TmdbTitleExtras, type: "movie" | "series"): TitlePerson[] {
  const cast = [...data.cast]
    .sort((left, right) => left.order - right.order)
    .slice(0, 20)
    .map((person) => {
      const photo = tmdbImage(person.profilePath, "w185");
      return {
        name: person.name,
        role: "cast" as const,
        ...(person.character ? { character: person.character } : {}),
        ...(photo ? { photo } : {}),
      };
    });
  const crew: TitlePerson[] = [];
  const seen = new Set<string>();
  const addCrew = (person: TitlePerson) => {
    const identity = `${person.name}\0${person.role}`;
    if (crew.length >= 8 || seen.has(identity)) return;
    seen.add(identity);
    crew.push(person);
  };
  for (const person of data.createdBy) {
    const photo = tmdbImage(person.profilePath, "w185");
    addCrew({ name: person.name, role: "creator", ...(photo ? { photo } : {}) });
  }
  for (const person of data.crew) {
    const role = CREW_ROLE[person.job];
    if (!role) continue;
    // A series' directors and writers are those of single episodes; its creators stand for it.
    if (type === "series" && role !== "novel") continue;
    const photo = tmdbImage(person.profilePath, "w185");
    addCrew({ name: person.name, role, ...(photo ? { photo } : {}) });
  }
  return [
    ...crew.filter((person) => person.role === "creator"),
    ...cast,
    ...crew.filter((person) => person.role !== "creator"),
  ];
}

function tmdbVideos(data: TmdbTitleExtras, language: string): TitleVideo[] {
  const preferred = normalizeLanguage(language);
  const candidates = data.videos.flatMap((video, index) => {
    const kind = VIDEO_KIND[video.type];
    if (video.site !== "YouTube" || !YOUTUBE_ID.test(video.key) || !kind) return [];
    return [{ video, kind, index }];
  }).sort((left, right) => {
    const languageRank = (video: (typeof candidates)[number]["video"]) => {
      const code = normalizeLanguage(video.language);
      return code === preferred ? 0 : code === "en" ? 1 : 2;
    };
    return languageRank(left.video) - languageRank(right.video)
      || Number(left.kind !== "trailer") - Number(right.kind !== "trailer")
      || Number(!left.video.official) - Number(!right.video.official)
      || left.index - right.index;
  });
  const seen = new Set<string>();
  const videos: TitleVideo[] = [];
  for (const { video, kind } of candidates) {
    if (seen.has(video.key)) continue;
    seen.add(video.key);
    videos.push({
      key: video.key,
      name: video.name,
      kind,
      thumbnail: `https://i.ytimg.com/vi/${video.key}/hqdefault.jpg`,
      ...(video.language ? { language: video.language } : {}),
    });
    if (videos.length === VIDEO_LIMIT) break;
  }
  return videos;
}

function imdbRating(value: unknown): string | undefined {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value.trim())
      : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 10 ? parsed.toFixed(1) : undefined;
}

async function tmdbRelated(
  type: "movie" | "series",
  data: TmdbTitleExtras,
  config: TmdbConfig,
  fetchImpl?: FetchLike,
  signal?: AbortSignal,
): Promise<RelatedTitle[]> {
  const candidates = data.recommendations.slice(0, 16);
  const related: Array<RelatedTitle | undefined> = new Array(candidates.length);
  let next = 0;
  let resolved = 0;
  const worker = async () => {
    while (resolved < 12) {
      const index = next;
      next += 1;
      if (index >= candidates.length) return;
      const item = candidates[index]!;
      throwIfCancelled(signal);
      const id = await tmdbExternalId(type, item.tmdbId, config, fetchImpl);
      throwIfCancelled(signal);
      if (!id || resolved >= 12) continue;
      const poster = tmdbImage(item.posterPath, "w342");
      related[index] = {
        type,
        id,
        name: item.name,
        ...(item.date && /^\d{4}/.test(item.date) ? { year: item.date.slice(0, 4) } : {}),
        ...(poster ? { poster } : {}),
      };
      resolved += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, worker));
  return related.filter((item): item is RelatedTitle => item !== undefined);
}

async function buildTmdbPart(
  type: "movie" | "series",
  id: string,
  language: string,
  deps: TitleExtrasDeps & { tmdb: TmdbConfig },
  key: string,
  now: number,
): Promise<CachedTmdbExtras | null> {
  const fail = () => {
    if (extrasCache.size > CACHE_LIMIT) extrasCache.clear();
    extrasCache.set(key, { at: now, value: null });
    return null;
  };
  const tmdbId = await tmdbIdOf(type, id, deps.tmdb, deps.fetchImpl, deps.signal);
  if (tmdbId == null) return fail();
  throwIfCancelled(deps.signal);
  const data = await tmdbTitleExtras(type, tmdbId, deps.tmdb, deps.fetchImpl, deps.signal);
  if (!data) return fail();
  throwIfCancelled(deps.signal);
  const related = await tmdbRelated(type, data, deps.tmdb, deps.fetchImpl, deps.signal);
  const preferredRegion = REGION[language] ?? "US";
  const ageRatingRegion = data.certifications[preferredRegion] != null
    ? preferredRegion
    : data.certifications.US != null ? "US" : undefined;
  const ageRating = ageRatingRegion ? data.certifications[ageRatingRegion] : undefined;
  const value: CachedTmdbExtras = {
    people: tmdbPeople(data, type),
    related,
    ...(data.voteAverage != null && data.voteCount != null && data.voteCount >= TMDB_RATING_MIN_VOTES ? {
      tmdb: Math.round(data.voteAverage * 10) / 10,
      tmdbVotes: data.voteCount,
    } : {}),
    videos: tmdbVideos(data, language),
    ...(ageRating ? { ageRating } : {}),
    ...(ageRatingRegion ? { ageRatingRegion } : {}),
    ...(data.originalTitle ? { originalTitle: data.originalTitle } : {}),
    ...(data.originalLanguage ? { originalLanguage: data.originalLanguage } : {}),
  };
  if (extrasCache.size > CACHE_LIMIT) extrasCache.clear();
  extrasCache.set(key, { at: now, value });
  return value;
}

async function cachedTmdbPart(
  type: "movie" | "series",
  id: string,
  language: string,
  deps: TitleExtrasDeps & { tmdb: TmdbConfig },
  now: number,
): Promise<CachedTmdbExtras | null> {
  const key = `${type}:${id}:${language}:${keyFingerprint(deps.tmdb.apiKey)}`;
  const cached = extrasCache.get(key);
  if (cached) {
    const ttl = cached.value ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
    if (now - cached.at < ttl) return cached.value;
  }
  const pending = extrasInFlight.get(key);
  if (pending) return pending;
  const building = buildTmdbPart(type, id, language, deps, key, now).finally(() => {
    if (extrasInFlight.get(key) === building) extrasInFlight.delete(key);
  });
  extrasInFlight.set(key, building);
  return building;
}

function addonNames(value: unknown): string[] {
  if (typeof value === "string") {
    const name = text(value);
    return name ? [name] : [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      const name = text(entry);
      return name ? [name] : [];
    }
    if (!entry || typeof entry !== "object") return [];
    const name = text((entry as Record<string, unknown>).name);
    return name ? [name] : [];
  });
}

function addonPeople(meta: MetaItem | null): TitlePerson[] {
  if (!meta) return [];
  const cast = addonNames(meta.cast).slice(0, 20).map((name) => ({ name, role: "cast" as const }));
  const crew: TitlePerson[] = [];
  for (const [field, role] of [["director", "director"], ["writer", "writer"]] as const) {
    for (const name of addonNames(meta[field])) {
      if (crew.length >= 8) break;
      crew.push({ name, role });
    }
  }
  return [...cast, ...crew];
}

function futureEpisode(meta: MetaItem | null, now: number): TitleExtras["nextEpisode"] {
  let earliest: { at: number; episode: NonNullable<TitleExtras["nextEpisode"]> } | undefined;
  for (const video of meta?.videos ?? []) {
    const season = numberOf(video.season);
    const episode = numberOf(video.episode ?? video.number);
    const released = text(video.released);
    if (season == null || season <= 0 || episode == null || !released) continue;
    const at = Date.parse(released);
    if (!Number.isFinite(at) || at <= now || (earliest && at >= earliest.at)) continue;
    const name = text(video.name) ?? text(video.title);
    earliest = {
      at,
      episode: { season, episode, ...(name ? { name } : {}), released },
    };
  }
  return earliest?.episode;
}

function imdbIdOfMeta(meta: MetaItem | null): string | undefined {
  for (const value of [meta?.imdb_id, meta?.imdbId, meta?.imdb]) {
    if (typeof value === "string" && /^tt\d{5,}$/.test(value.trim())) return value.trim();
  }
  return undefined;
}

export async function titleExtras(
  type: string,
  id: string,
  language: string,
  deps: TitleExtrasDeps,
): Promise<TitleExtras> {
  if (type !== "movie" && type !== "series") {
    return { people: [], related: [], ratings: {}, videos: [], source: "addon" };
  }
  const meta = await deps.meta();
  throwIfCancelled(deps.signal);
  const now = deps.now?.() ?? Date.now();
  // An addon that names titles its own way (`mpa:sosac:…`) still carries the IMDb id in the meta;
  // without it the title would have no TMDB answer at all.
  const lookupId = /(?:^|:)tt\d+$/.test(id) || /^tmdb:\d+$/.test(id) ? id : imdbIdOfMeta(meta) ?? id;
  const part = deps.tmdb
    ? await cachedTmdbPart(type, lookupId, language, { ...deps, tmdb: deps.tmdb }, now)
    : null;
  const people = part?.people.length ? part.people : addonPeople(meta);
  const related = await Promise.all((part?.related ?? []).map(async (item) => {
    const copies = await deps.copies(type, item.id);
    return { ...item, ...(copies.length ? { inLibrary: true } : {}) };
  }));
  throwIfCancelled(deps.signal);
  const nextEpisode = futureEpisode(meta, now);
  const imdb = imdbRating(meta?.imdbRating);
  return {
    people,
    related,
    ratings: {
      ...(imdb ? { imdb } : {}),
      ...(part?.tmdb != null ? { tmdb: part.tmdb } : {}),
      ...(part?.tmdbVotes != null ? { tmdbVotes: part.tmdbVotes } : {}),
    },
    videos: part?.videos ?? [],
    ...(part?.ageRating ? { ageRating: part.ageRating } : {}),
    ...(part?.ageRatingRegion ? { ageRatingRegion: part.ageRatingRegion } : {}),
    ...(part?.originalTitle ? { originalTitle: part.originalTitle } : {}),
    ...(part?.originalLanguage ? { originalLanguage: part.originalLanguage } : {}),
    ...(nextEpisode ? { nextEpisode } : {}),
    source: part ? "tmdb" : "addon",
  };
}
