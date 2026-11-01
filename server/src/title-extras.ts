import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FetchLike } from "./debrid.js";
import type { MetaItem } from "./types.js";
import { OutboundError } from "./outbound.js";
import { normalizeLanguage } from "./language.js";
import { renameWithRetry } from "./fs-retry.js";
import { log } from "./logger.js";
import {
  tmdbExternalIdResult,
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
  /** TMDB's synopsis, for an addon whose own description is only a line of tags. */
  overview?: string;
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
  overview?: string;
}

interface CacheEntry {
  at: number;
  ttl: number;
  value: CachedTmdbExtras | null;
}

const SUCCESS_TTL_MS = 24 * 60 * 60_000;
const PARTIAL_TTL_MS = 30 * 60_000;
const FAILURE_TTL_MS = 10 * 60_000;
const DEFAULT_CACHE_LIMIT = 500;
const DISK_VERSION = 1;
const DISK_LIMIT = 2_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
let cacheLimit = DEFAULT_CACHE_LIMIT;
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
/** One TMDB build per title, shared by every request that asks while it runs. It has its own
 *  signal: one viewer leaving must not cancel the answer another one is still waiting for, so it is
 *  cancelled only once every request waiting on it has gone. */
interface InFlight { promise: Promise<CachedTmdbExtras | null>; controller: AbortController; waiting: number }
const extrasInFlight = new Map<string, InFlight>();
let extrasDir: string | undefined;
let lastPruneAt = 0;
const diskWrites = new Map<string, Promise<void>>();

interface DiskEntry {
  version: 1;
  key: string;
  at: number;
  value: CachedTmdbExtras;
}

export function clearTitleExtrasCache(): void {
  extrasCache.clear();
  for (const entry of extrasInFlight.values()) entry.controller.abort();
  extrasInFlight.clear();
}

/** Test seam: keeps the memory cache but stops reading and writing title extras on disk. */
export function detachTitleExtrasDisk(): void {
  extrasDir = undefined;
  lastPruneAt = 0;
}

/** Test seam: resolves once every disk write queued so far has finished. */
export async function flushTitleExtrasDisk(): Promise<void> {
  while (diskWrites.size > 0) await Promise.all(diskWrites.values());
}

export function setTitleExtrasCacheLimitForTests(limit: number): void {
  cacheLimit = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_CACHE_LIMIT;
}

/** Enables the title extras disk cache and removes stale files before the first request. */
export async function attachTitleExtrasDisk(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  extrasDir = dir;
  await pruneTitleExtras(dir);
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
const diskName = (key: string) => `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`;
const reasonOf = (error: unknown) => error instanceof Error ? error.message : String(error);

function rememberMemory(key: string, entry: CacheEntry): void {
  extrasCache.delete(key);
  extrasCache.set(key, entry);
  if (extrasCache.size <= cacheLimit) return;
  const oldest = extrasCache.keys().next().value;
  if (oldest !== undefined) extrasCache.delete(oldest);
}

function cachedMemory(key: string, now: number): CacheEntry | undefined {
  const cached = extrasCache.get(key);
  if (!cached) return undefined;
  if (now - cached.at < cached.ttl) {
    rememberMemory(key, cached);
    return cached;
  }
  extrasCache.delete(key);
  return undefined;
}

function isDiskEntry(value: unknown, key: string): value is DiskEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<DiskEntry>;
  return entry.version === DISK_VERSION
    && entry.key === key
    && typeof entry.at === "number"
    && Number.isFinite(entry.at)
    && Boolean(entry.value)
    && typeof entry.value === "object"
    && Array.isArray(entry.value.people)
    && entry.value.people.every((person) => isRecord(person) && typeof person.name === "string")
    && Array.isArray(entry.value.related)
    && entry.value.related.every((item) => isRecord(item) && typeof item.id === "string" && typeof item.name === "string")
    && Array.isArray(entry.value.videos)
    && entry.value.videos.every((video) => isRecord(video) && typeof video.key === "string");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

async function readDisk(key: string, now: number): Promise<CacheEntry | undefined> {
  const dir = extrasDir;
  if (!dir) return undefined;
  await diskWrites.get(key);
  if (extrasDir !== dir) return undefined;
  const file = path.join(dir, diskName(key));
  const raw = await readFile(file, "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await unlink(file).catch(() => undefined);
    return undefined;
  }
  if (!isDiskEntry(parsed, key) || now - parsed.at >= SUCCESS_TTL_MS) return undefined;
  return { at: parsed.at, ttl: SUCCESS_TTL_MS, value: parsed.value };
}

function writeDisk(key: string, at: number, value: CachedTmdbExtras): void {
  const dir = extrasDir;
  if (!dir) return;
  const file = path.join(dir, diskName(key));
  const previous = diskWrites.get(key) ?? Promise.resolve();
  const pending = previous.then(async () => {
    try {
      await mkdir(dir, { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify({
        version: DISK_VERSION,
        key,
        at,
        value,
      } satisfies DiskEntry), { mode: 0o600 });
      await renameWithRetry(temp, file);
      await pruneTitleExtrasIfDue(dir);
    } catch (error) {
      log("WARN", "Title extras could not be saved", { file: path.basename(file), reason: reasonOf(error) });
    }
  }).finally(() => {
    if (diskWrites.get(key) === pending) diskWrites.delete(key);
  });
  diskWrites.set(key, pending);
}

async function pruneTitleExtrasIfDue(dir: string): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  await pruneTitleExtras(dir);
}

async function pruneTitleExtras(dir: string): Promise<void> {
  lastPruneAt = Date.now();
  const names = await readdir(dir).catch(() => [] as string[]);
  const files = (await Promise.all(names.map(async (name) => {
    const file = path.join(dir, name);
    const info = await stat(file).catch(() => undefined);
    return info?.isFile() ? { file, mtimeMs: info.mtimeMs } : undefined;
  }))).filter((file): file is { file: string; mtimeMs: number } => file !== undefined);
  const cutoff = Date.now() - SUCCESS_TTL_MS;
  let kept = files.filter((file) => file.mtimeMs >= cutoff);
  const expired = files.filter((file) => file.mtimeMs < cutoff);
  await Promise.all(expired.map((file) => unlink(file.file).catch(() => undefined)));
  if (kept.length > DISK_LIMIT) {
    kept.sort((left, right) => left.mtimeMs - right.mtimeMs);
    const excess = kept.slice(0, kept.length - DISK_LIMIT);
    await Promise.all(excess.map((file) => unlink(file.file).catch(() => undefined)));
  }
}

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
): Promise<{ related: RelatedTitle[]; partial: boolean }> {
  const candidates = data.recommendations.slice(0, 16);
  const related: Array<RelatedTitle | undefined> = new Array(candidates.length);
  let next = 0;
  let resolved = 0;
  let failed = false;
  const worker = async () => {
    while (resolved < 12) {
      const index = next;
      next += 1;
      if (index >= candidates.length) return;
      const item = candidates[index]!;
      throwIfCancelled(signal);
      const result = await tmdbExternalIdResult(type, item.tmdbId, config, fetchImpl, signal);
      throwIfCancelled(signal);
      if (result.status === "failed") {
        failed = true;
        continue;
      }
      if (result.status === "none" || resolved >= 12) continue;
      const poster = tmdbImage(item.posterPath, "w342");
      related[index] = {
        type,
        id: result.imdb,
        name: item.name,
        ...(item.date && /^\d{4}/.test(item.date) ? { year: item.date.slice(0, 4) } : {}),
        ...(poster ? { poster } : {}),
      };
      resolved += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, worker));
  return {
    related: related.filter((item): item is RelatedTitle => item !== undefined),
    // A failed lookup matters only when the list came out short because of it.
    partial: failed && resolved < 12,
  };
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
    // A build everybody walked away from answers nothing, and that is no failure to remember.
    throwIfCancelled(deps.signal);
    rememberMemory(key, { at: now, ttl: FAILURE_TTL_MS, value: null });
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
    related: related.related,
    ...(data.voteAverage != null && data.voteCount != null && data.voteCount >= TMDB_RATING_MIN_VOTES ? {
      tmdb: Math.round(data.voteAverage * 10) / 10,
      tmdbVotes: data.voteCount,
    } : {}),
    videos: tmdbVideos(data, language),
    ...(ageRating ? { ageRating } : {}),
    ...(ageRatingRegion ? { ageRatingRegion } : {}),
    ...(data.originalTitle ? { originalTitle: data.originalTitle } : {}),
    ...(data.originalLanguage ? { originalLanguage: data.originalLanguage } : {}),
    ...(data.overview ? { overview: data.overview } : {}),
  };
  rememberMemory(key, { at: now, ttl: related.partial ? PARTIAL_TTL_MS : SUCCESS_TTL_MS, value });
  if (!related.partial) writeDisk(key, now, value);
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
  const cached = cachedMemory(key, now);
  if (cached) return cached.value;
  let entry = extrasInFlight.get(key);
  if (!entry) {
    const controller = new AbortController();
    const promise = (async () => {
      const disk = await readDisk(key, now);
      throwIfCancelled(controller.signal);
      if (disk) {
        rememberMemory(key, disk);
        return disk.value;
      }
      return buildTmdbPart(type, id, language, { ...deps, signal: controller.signal }, key, now);
    })();
    const started: InFlight = {
      controller,
      waiting: 0,
      promise: promise.finally(() => {
        if (extrasInFlight.get(key) === started) extrasInFlight.delete(key);
      }),
    };
    // A request that left before it joined would otherwise leave the rejection unobserved.
    started.promise.catch(() => undefined);
    extrasInFlight.set(key, started);
    entry = started;
  }
  return joinInFlight(entry, deps.signal);
}

/** Waits on a shared build for one request. That request leaving rejects only its own wait; the
 *  build is cancelled when the last request waiting on it has left. */
function joinInFlight(entry: InFlight, signal?: AbortSignal): Promise<CachedTmdbExtras | null> {
  entry.waiting += 1;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = () => {
      if (done) return false;
      done = true;
      signal?.removeEventListener("abort", leave);
      entry.waiting -= 1;
      return true;
    };
    function leave() {
      if (!finish()) return;
      if (entry.waiting === 0) entry.controller.abort();
      reject(new OutboundError("cancelled"));
    }
    if (signal?.aborted) { leave(); return; }
    signal?.addEventListener("abort", leave, { once: true });
    entry.promise.then(
      (value) => { if (finish()) resolve(value); },
      (error: unknown) => { if (finish()) reject(error); },
    );
  });
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
  const now = deps.now?.() ?? Date.now();
  const direct = /(?:^|:)tt\d+$/.test(id) || /^tmdb:\d+$/.test(id);
  let meta: MetaItem | null;
  let part: CachedTmdbExtras | null;
  if (direct) {
    const tmdb = deps.tmdb
      ? cachedTmdbPart(type, id, language, { ...deps, tmdb: deps.tmdb }, now)
      : Promise.resolve(null);
    [meta, part] = await Promise.all([deps.meta(), tmdb]);
  } else {
    meta = await deps.meta();
    throwIfCancelled(deps.signal);
    // An addon that names titles its own way (`mpa:sosac:…`) still carries the IMDb id in the meta;
    // without it the title would have no TMDB answer at all.
    const lookupId = imdbIdOfMeta(meta) ?? id;
    part = deps.tmdb
      ? await cachedTmdbPart(type, lookupId, language, { ...deps, tmdb: deps.tmdb }, now)
      : null;
  }
  throwIfCancelled(deps.signal);
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
    ...(part?.overview ? { overview: part.overview } : {}),
    ...(nextEpisode ? { nextEpisode } : {}),
    source: part ? "tmdb" : "addon",
  };
}
