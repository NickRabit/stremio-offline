import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DownloadSelection } from "./downloads.js";
import { AppError } from "./errors.js";
import { renameWithRetry } from "./fs-retry.js";
import type { Viewer } from "./libraries.js";
import { log } from "./logger.js";
import type { MediaInfo } from "./naming.js";
import type { MetaItem } from "./types.js";

export interface FollowEpisode {
  key: string;
  videoId: string;
  season: number;
  episode: number;
  title?: string;
  released?: string;
  firstSeenAt: string;
  ambiguous?: boolean;
  download?: EpisodeDownload;
}

export interface FollowAutoDownload {
  /** Set when automatic downloads were switched on, kept when the rule is edited. */
  enabledAt: string;
  startMode: "new" | "from";
  startSeason?: number;
  startEpisode?: number;
  selection: DownloadSelection;
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
export function downloadEligibility(follow: Follow, episode: FollowEpisode, now: number): DownloadEligibility {
  const auto = follow.autoDownload;
  if (!auto) return "outside";
  if (auto.startMode === "from") {
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
  if (!episode.released) return "attention-no-date";
  if (Date.parse(episode.released) > now) return "upcoming";
  return "eligible";
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
        // A key already seen keeps the moment it was first seen; everything else the
        // provider now says about it wins, so a title or a date can be corrected.
        follow.episodes[episode.key] = existing
          ? { ...existing, ...episode, ambiguous: episode.ambiguous, firstSeenAt: existing.firstSeenAt }
          : episode;
        if (!follow.episodes[episode.key].ambiguous) delete follow.episodes[episode.key].ambiguous;
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
  followJobs(): FollowJob[];
  get(id: string): { id: string; status: string; errorKey?: string } | undefined;
  retry(id: string): Promise<unknown>;
  remove(id: string): Promise<void>;
}

export interface FollowDeps {
  store: FollowStore;
  now: () => number;
  /** The owner as they are now; undefined when deleted. */
  owner: (userId: string) => { id: string; role: "admin" | "user"; disabled?: boolean } | undefined;
  /** Metadata as the owner may see it, in the owner's language, bypassing the cache. */
  meta: (owner: Viewer, type: string, metaId: string) => Promise<MetaItem | null>;
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
    return `${follow.name} · S${pad2(episode.season)}E${pad2(episode.episode)}`;
  }

  private episodeMedia(follow: Follow, episode: FollowEpisode): MediaInfo {
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
      const verdict = downloadEligibility(follow, current, this.deps.now());
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
      { type: follow.type, videoId: episode.videoId, selection: follow.autoDownload!.selection },
      this.episodeMedia(follow, episode),
      follow.ownerUserId,
      { followId, episodeKey, intent },
    );
    follow = this.admittable(followId, revision);
    if (!follow) return;
    const linked = job ?? this.deps.queue.findActiveEpisode(follow.ownerUserId, follow.type, episode.videoId);
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
      await this.setDownload(followId, episodeKey, { ...download, state: "completed", jobId: job.id, reasonKey: undefined, nextAttemptAt: undefined, updatedAt: "" });
    } else if (job.status === "failed") {
      await this.setWaiting(followId, episodeKey, { ...download, jobId: job.id }, job, now);
    } else {
      await this.setDownload(followId, episodeKey, { ...download, state: "queued", jobId: job.id, reasonKey: undefined, nextAttemptAt: undefined, updatedAt: "" });
    }
  }

  private async setWaiting(followId: string, episodeKey: string, download: EpisodeDownload, job: FollowJob, now: number): Promise<void> {
    const attempts = download.attempts + 1;
    await this.setDownload(followId, episodeKey, {
      ...download, state: "waiting", attempts,
      reasonKey: job.errorKey ?? "err.followDownloadFailed",
      nextAttemptAt: new Date(now + downloadLadderMs(attempts)).toISOString(),
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
          else if (job.status === "completed") await this.setDownload(follow.id, episodeKey, { ...download, state: "completed", reasonKey: undefined, nextAttemptAt: undefined, updatedAt: "" });
          else if (job.status === "failed") await this.setWaiting(follow.id, episodeKey, download, job, now);
          continue;
        }
        if (download.state !== "waiting") continue;
        if (!download.nextAttemptAt || Date.parse(download.nextAttemptAt) > now) continue;
        if (!follow.enabled || !this.mayQueue(follow)) continue;
        const job = jobs.get(download.intent);
        if (job && job.status === "failed") {
          await this.deps.queue.retry(job.id);
          if (!this.fresh(follow.id, revision)) return;
          await this.setDownload(follow.id, episodeKey, { ...download, state: "queued", jobId: job.id, reasonKey: undefined, nextAttemptAt: undefined, updatedAt: "" });
        } else if (job && job.status === "completed") {
          await this.setDownload(follow.id, episodeKey, { ...download, state: "completed", reasonKey: undefined, nextAttemptAt: undefined, updatedAt: "" });
        } else {
          await this.setDownload(follow.id, episodeKey, { ...download, state: "attention", jobId: undefined, reasonKey: "err.followJobMissing", nextAttemptAt: undefined, updatedAt: "" });
        }
      }
    }
  }

  /** The episodes a proposed rule would queue right now, for the setup dialog's count. */
  preview(follow: Follow, start: { startMode: "new" | "from"; startSeason?: number; startEpisode?: number }): FollowEpisode[] {
    const now = this.deps.now();
    const proposed: Follow = {
      ...follow,
      autoDownload: {
        enabledAt: follow.autoDownload?.enabledAt ?? new Date(now).toISOString(),
        startMode: start.startMode,
        ...(start.startSeason != null ? { startSeason: start.startSeason } : {}),
        ...(start.startEpisode != null ? { startEpisode: start.startEpisode } : {}),
        // `downloadEligibility` reads the start rule only, never the selection.
        selection: follow.autoDownload?.selection ?? ({} as DownloadSelection),
      },
    };
    return Object.values(follow.episodes)
      .filter((episode) => downloadEligibility(proposed, episode, now) === "eligible")
      .sort((a, b) => a.season - b.season || a.episode - b.episode);
  }

  private async maintain(): Promise<void> {
    try {
      await this.locked(async () => {
        await this.syncLocked();
        for (const follow of this.deps.store.all()) {
          if (follow.autoDownload && follow.enabled) await this.admitLocked(follow.id);
        }
      });
    } catch (error) {
      log("WARN", "The automatic downloads could not be reconciled", { error: error instanceof Error ? error.message : String(error) });
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
            selection: value.selection,
          };
        }
        current.revision += 1;
      });
      if (value !== null) await this.admitLocked(followId);
    });
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
        await this.deps.queue.retry(job.id);
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
      await this.setDownload(ref.followId, ref.episodeKey, { ...download, state: "completed", reasonKey: undefined, nextAttemptAt: undefined, updatedAt: "" });
    });
  }

  jobRemoving(job: Readonly<FollowJob>, reason: "user" | "account"): Promise<void> {
    return this.locked(async () => {
      const ref = job.follow;
      if (reason !== "user" || !ref) return;
      const download = this.deps.store.get(ref.followId)?.episodes[ref.episodeKey]?.download;
      if (!download || download.intent !== ref.intent) return;
      if (job.status === "completed") {
        if (download.state === "completed") return;
        await this.setDownload(ref.followId, ref.episodeKey, { ...download, state: "completed", reasonKey: undefined, nextAttemptAt: undefined, updatedAt: "" });
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
        await this.setDownload(ref.followId, ref.episodeKey, { ...download, state: "completed", reasonKey: undefined, nextAttemptAt: undefined, updatedAt: "" });
      }
    });
  }

  private async runCheck(followId: string, reason: "schedule" | "manual"): Promise<void> {
    const follow = this.deps.store.get(followId);
    if (!follow) return;
    const owner = this.deps.owner(follow.ownerUserId);
    if (!owner || owner.disabled) return;
    const revision = follow.revision;
    let result: { episodes: FollowEpisode[]; now: number } | { errorKey: string; now: number };
    try {
      const meta = await this.deps.meta({ id: owner.id, role: owner.role }, follow.type, follow.metaId);
      if (!meta) throw new Error("no metadata");
      const at = new Date(this.deps.now()).toISOString();
      const episodes: FollowEpisode[] = normalizeFollowEpisodes(meta).map((episode) => ({ ...episode, firstSeenAt: at }));
      result = { episodes, now: this.deps.now() };
    } catch {
      result = { errorKey: "err.followMetaUnavailable", now: this.deps.now() };
      log("WARN", "A followed series could not be checked", { follow: followId, reason });
    }
    // A removal or an edit while the addons answered must not be overwritten by this
    // run's older picture.
    const current = this.deps.store.get(followId);
    if (!current || current.revision !== revision) return;
    await this.deps.store.recordCheck(followId, result);
    if ("episodes" in result) {
      try { await this.admit(followId); }
      catch (error) { log("WARN", "A followed series could not queue its new episodes", { follow: followId, error: error instanceof Error ? error.message : String(error) }); }
    }
  }
}
