import type { FetchLike } from "./debrid.js";
import { OutboundError } from "./outbound.js";
import { keyFingerprint } from "./title-extras.js";
import {
  tmdbImage,
  tmdbPerson,
  type TmdbConfig,
  type TmdbPersonCredit,
  type TmdbPersonResponse,
} from "./tmdb.js";

export type PersonSectionKey = "acting" | "crew";

export interface PersonCreditTitle {
  type: "movie" | "series";
  tmdbId: number;
  name: string;
  year?: string;
  date?: string;
  posterPath?: string;
  role?: string;
  popularity: number;
}

export interface PersonCredits {
  id: number;
  name: string;
  profilePath?: string;
  knownFor: PersonSectionKey;
  acting: PersonCreditTitle[];
  crew: PersonCreditTitle[];
}

export interface PersonTitle {
  type: "movie" | "series";
  tmdbId: number;
  id: string;
  name: string;
  year?: string;
  poster?: string;
  role?: string;
  inLibrary?: true;
}

export interface PersonFilmography {
  id: number;
  name: string;
  photo?: string;
  sections: Array<{ key: PersonSectionKey; titles: PersonTitle[] }>;
}

export type PersonLookup =
  | { status: "found"; credits: PersonCredits }
  | { status: "missing" }
  | { status: "failed" };

const KEPT_JOBS = new Set(["Director", "Writer", "Screenplay", "Story", "Teleplay", "Novel", "Creator"]);
const TALK_OR_NEWS = new Set([10767, 10763]);
const SUCCESS_TTL_MS = 24 * 60 * 60_000;
const FAILURE_TTL_MS = 10 * 60_000;
const CACHE_LIMIT = 200;
const SECTION_LIMIT = 200;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/** `Self`, `Himself - Host`, `Herself (voice)`, `Themselves`; not `Selfridge`. */
const SELF = /^(?:self|himself|herself|themselves)(?:$|[\s(-])/;

const selfAppearance = (character: string): boolean => {
  const lower = character.toLowerCase();
  return SELF.test(lower)
    || lower.includes("archive footage")
    || lower.includes("uncredited");
};

interface MergedCredit {
  type: PersonCreditTitle["type"];
  tmdbId: number;
  name: string;
  date?: string;
  posterPath?: string;
  popularity?: number;
  jobs: string[];
  characters: string[];
}

const addUnique = (values: string[], value: string | undefined) => {
  if (value && !values.includes(value)) values.push(value);
};

export function normalizePerson(raw: TmdbPersonResponse, tmdbId: number): PersonCredits | null {
  if (!raw || typeof raw !== "object") return null;
  const name = text(raw.name);
  if (!name) return null;
  const merged = new Map<string, MergedCredit>();

  const take = (row: TmdbPersonCredit, cast: boolean) => {
    const media = row.media_type;
    if (media !== "movie" && media !== "tv") return;
    if (!positiveInteger(row.id) || row.adult === true) return;
    const title = text(media === "movie" ? row.title : row.name);
    if (!title) return;
    if (media === "tv" && row.genre_ids?.some((genre) => TALK_OR_NEWS.has(genre))) return;
    const character = text(row.character);
    if (cast && character && selfAppearance(character)) return;
    const job = text(row.job);
    if (!cast && (!job || !KEPT_JOBS.has(job))) return;

    const type = media === "movie" ? "movie" : "series";
    const key = `${type}:${row.id}`;
    let item = merged.get(key);
    if (!item) {
      item = {
        type,
        tmdbId: row.id,
        name: title,
        jobs: [],
        characters: [],
      };
      merged.set(key, item);
    }
    const date = text(media === "movie" ? row.release_date : row.first_air_date);
    item.date ??= date;
    item.posterPath ??= text(row.poster_path);
    if (typeof row.popularity === "number" && Number.isFinite(row.popularity)) {
      item.popularity = item.popularity == null ? row.popularity : Math.max(item.popularity, row.popularity);
    }
    addUnique(item.characters, character);
    if (!cast) addUnique(item.jobs, job);
  };

  const credits = raw.combined_credits;
  if (Array.isArray(credits?.cast)) for (const row of credits.cast) take(row, true);
  if (Array.isArray(credits?.crew)) for (const row of credits.crew) take(row, false);

  const acting: PersonCreditTitle[] = [];
  const crew: PersonCreditTitle[] = [];
  for (const item of merged.values()) {
    const roles = item.jobs.length ? [...item.jobs, ...item.characters] : item.characters;
    const title: PersonCreditTitle = {
      type: item.type,
      tmdbId: item.tmdbId,
      name: item.name,
      ...(item.date ? { date: item.date, year: item.date.slice(0, 4) } : {}),
      ...(item.posterPath ? { posterPath: item.posterPath } : {}),
      ...(roles.length ? { role: roles.join(", ") } : {}),
      popularity: item.popularity ?? 0,
    };
    if (item.jobs.length) crew.push(title);
    else acting.push(title);
  }

  return {
    id: tmdbId,
    name,
    ...(text(raw.profile_path) ? { profilePath: text(raw.profile_path) } : {}),
    knownFor: raw.known_for_department === "Acting" ? "acting" : "crew",
    acting,
    crew,
  };
}

function compareTitles(
  left: PersonCreditTitle & { inLibrary?: true },
  right: PersonCreditTitle & { inLibrary?: true },
): number {
  const owned = Number(Boolean(right.inLibrary)) - Number(Boolean(left.inLibrary));
  if (owned) return owned;
  const popularity = right.popularity - left.popularity;
  if (popularity) return popularity;
  if (left.date && right.date) {
    const date = right.date.localeCompare(left.date);
    if (date) return date;
  } else if (left.date !== right.date) {
    return left.date ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

export function composePerson(credits: PersonCredits, opts: {
  owned: ReadonlySet<string>;
  imdbOf: (type: "movie" | "series", tmdbId: number) => string | null | undefined;
}): PersonFilmography {
  const titles = (items: PersonCreditTitle[]): PersonTitle[] => items
    .map((item) => {
      const imdb = opts.imdbOf(item.type, item.tmdbId);
      const owned = opts.owned.has(`${item.type}:${item.tmdbId}`);
      return {
        type: item.type,
        tmdbId: item.tmdbId,
        id: typeof imdb === "string" ? imdb : `tmdb:${item.tmdbId}`,
        name: item.name,
        ...(item.year ? { year: item.year } : {}),
        ...(tmdbImage(item.posterPath, "w342") ? { poster: tmdbImage(item.posterPath, "w342") } : {}),
        ...(item.role ? { role: item.role } : {}),
        ...(owned ? { inLibrary: true as const } : {}),
        date: item.date,
        popularity: item.popularity,
      };
    })
    .sort(compareTitles)
    .slice(0, SECTION_LIMIT)
    .map(({ date: _date, popularity: _popularity, ...title }) => title);

  const acting = titles(credits.acting);
  const crew = titles(credits.crew);
  const sections: PersonFilmography["sections"] = [];
  const known = credits.knownFor === "acting" ? acting : crew;
  const other = credits.knownFor === "acting" ? crew : acting;
  if (known.length) sections.push({ key: credits.knownFor, titles: known });
  if (other.length) sections.push({ key: credits.knownFor === "acting" ? "crew" : "acting", titles: other });
  return {
    id: credits.id,
    name: credits.name,
    ...(tmdbImage(credits.profilePath, "w185") ? { photo: tmdbImage(credits.profilePath, "w185") } : {}),
    sections,
  };
}

export function ownedTitleKeys(
  records: Iterable<{ type: string; id?: string }>,
  tmdbOf: (type: "movie" | "series", imdb: string) => number | null | undefined,
): Set<string> {
  const owned = new Set<string>();
  for (const record of records) {
    if (record.type !== "movie" && record.type !== "series") continue;
    const id = record.id;
    if (!id) continue;
    const direct = /^tmdb:([1-9]\d*)$/.exec(id);
    if (direct) {
      owned.add(`${record.type}:${Number(direct[1])}`);
      continue;
    }
    if (!/^tt\d+$/.test(id)) continue;
    const tmdbId = tmdbOf(record.type, id);
    if (typeof tmdbId === "number") owned.add(`${record.type}:${tmdbId}`);
  }
  return owned;
}

interface PersonCacheEntry {
  at: number;
  ttl: number;
  value: PersonLookup;
}

interface PersonInFlight {
  controller: AbortController;
  waiting: number;
  promise: Promise<PersonLookup>;
}

const cache = new Map<string, PersonCacheEntry>();
const inFlight = new Map<string, PersonInFlight>();

export function clearPersonCache(): void {
  cache.clear();
  for (const entry of inFlight.values()) entry.controller.abort();
  inFlight.clear();
}

const remember = (key: string, entry: PersonCacheEntry) => {
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size <= CACHE_LIMIT) return;
  const oldest = cache.keys().next().value;
  if (oldest !== undefined) cache.delete(oldest);
};

const cached = (key: string, now: number): PersonCacheEntry | undefined => {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (now - entry.at < entry.ttl) {
    remember(key, entry);
    return entry;
  }
  cache.delete(key);
  return undefined;
};

const throwIfCancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new OutboundError("cancelled");
};

async function buildPerson(
  tmdbId: number,
  deps: { tmdb: TmdbConfig; fetchImpl?: FetchLike },
  key: string,
  now: number,
  signal: AbortSignal,
): Promise<PersonLookup> {
  const result = await tmdbPerson(tmdbId, deps.tmdb, deps.fetchImpl, signal);
  throwIfCancelled(signal);
  const value: PersonLookup = result.status === "found"
    ? (() => {
      const credits = normalizePerson(result.person, tmdbId);
      return credits ? { status: "found", credits } : { status: "missing" };
    })()
    : result;
  remember(key, {
    at: now,
    ttl: value.status === "failed" ? FAILURE_TTL_MS : SUCCESS_TTL_MS,
    value,
  });
  return value;
}

function joinInFlight(entry: PersonInFlight, signal?: AbortSignal): Promise<PersonLookup> {
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
    if (signal?.aborted) {
      leave();
      return;
    }
    signal?.addEventListener("abort", leave, { once: true });
    entry.promise.then(
      (value) => { if (finish()) resolve(value); },
      (error: unknown) => { if (finish()) reject(error); },
    );
  });
}

export function personCredits(tmdbId: number, language: string, deps: {
  tmdb: TmdbConfig;
  fetchImpl?: FetchLike;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<PersonLookup> {
  const now = deps.now?.() ?? Date.now();
  const key = `person:v1:${tmdbId}:${language}:${keyFingerprint(deps.tmdb.apiKey)}`;
  const hit = cached(key, now);
  if (hit) return Promise.resolve(hit.value);
  let entry = inFlight.get(key);
  // The last waiter left and aborted it; the entry is only waiting for its own cleanup.
  if (!entry || entry.controller.signal.aborted) {
    const controller = new AbortController();
    const promise = buildPerson(tmdbId, deps, key, now, controller.signal);
    const started: PersonInFlight = {
      controller,
      waiting: 0,
      promise: promise.finally(() => {
        if (inFlight.get(key) === started) inFlight.delete(key);
      }),
    };
    started.promise.catch(() => undefined);
    inFlight.set(key, started);
    entry = started;
  }
  return joinInFlight(entry, deps.signal);
}
