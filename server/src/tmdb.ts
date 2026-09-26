import { AppError } from "./errors.js";
import { guardedFetch } from "./outbound.js";
import { log } from "./logger.js";
import { normalizeLanguage } from "./language.js";
import type { FetchLike } from "./debrid.js";
import type { MetaItem } from "./types.js";

export interface TmdbConfig {
  apiKey: string;
  language: string;
  /** Off by default: the catalogue owns the artwork, and swapping it for a second set of
   *  pictures of the same title is churn the reader sees. The landscape artwork work turns
   *  this on; nothing else should. */
  artwork?: boolean;
}

const TMDB_API = "https://api.themoviedb.org/3";
const TIMEOUT_MS = 12_000;
/** A title search sits between the user and the result list, so it gets a shorter deadline
 *  than a detail lookup whose answer nobody is waiting on. */
const SEARCH_TIMEOUT_MS = 5_000;
const ID_CACHE_LIMIT = 500;

/** How many pictures a stored gallery may hold. The artwork store owns the same cap. */
export const TMDB_GALLERY_LIMIT = 18;
/** Per kind, so one kind of picture cannot crowd the others out of the gallery. */
const GALLERY_PER_KIND = { poster: 8, background: 6, logo: 4 } as const;

const IMDB_ID = /^tt\d{5,}$/;

/** The sizes TMDB serves. `original` is the full file -- for a hero it is three to eight
 *  times the bytes of w1280 and buys nothing at the widths this interface renders. */
export type TmdbImageSize = "w300" | "w500" | "w780" | "w1280" | "original";

/** An absolute image URL, or undefined when TMDB has no file for that slot. */
export function tmdbImage(path: string | null | undefined, size: TmdbImageSize): string | undefined {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : undefined;
}

/** IMDb id against the TMDB id it resolves to, so a title is looked up through /find once. */
const idCache = new Map<string, number | null>();

/** Test seam only: forgets the imdb -> tmdb id map. */
export function clearTmdbCache(): void { idCache.clear(); }

/** A refused title search turns into a wait rather than a retry per title: the scan
 *  asks about hundreds of them, and a 429 answered hundreds of times is what got it
 *  rate-limited in the first place. */
const SEARCH_PAUSE_MAX_MS = 60_000;
let searchPausedUntil = 0;

/** Test seam only: forgets the Retry-After wait a 429 asked for. */
export function clearTmdbSearchPause(): void { searchPausedUntil = 0; }

const reasonOf = (error: unknown, secret?: string) => {
  const reason = error instanceof Error ? error.message : String(error);
  return secret ? reason.split(secret).join("[redacted]") : reason;
};

const tmdbUrl = (path: string, params: Record<string, string>) => {
  const url = new URL(`${TMDB_API}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
};

const request = (path: string, params: Record<string, string>, fetchImpl: FetchLike, timeoutMs = TIMEOUT_MS) =>
  fetchImpl(tmdbUrl(path, params), { signal: AbortSignal.timeout(timeoutMs) });

/** The seconds TMDB asks the caller to wait, when a refusal carries a `Retry-After`. */
export function tmdbRetryAfterMs(response: Response): number {
  const header = response.headers.get("retry-after");
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

interface TmdbSearchRow {
  id?: number;
  title?: string; name?: string;
  original_title?: string; original_name?: string;
  release_date?: string; first_air_date?: string;
  origin_country?: unknown;
  vote_count?: number;
  poster_path?: string | null; backdrop_path?: string | null;
}

interface TmdbSearchResponse { results?: TmdbSearchRow[] }

interface TmdbExternalIds { imdb_id?: string | null }

interface TmdbImageRow { file_path?: string | null; iso_639_1?: string | null; vote_average?: number }
interface TmdbImages { posters?: TmdbImageRow[]; backdrops?: TmdbImageRow[]; logos?: TmdbImageRow[] }

/** A picture of a chosen title, ready for the artwork store. */
export interface TmdbGalleryPicture { url: string; kind: "poster" | "background" | "logo" }

const mediaType = (type: "movie" | "series") => (type === "movie" ? "movie" : "tv");

const releaseYear = (value?: string): string | undefined => {
  const raw = String(value ?? "").slice(0, 4);
  return /^(19|20)\d{2}$/.test(raw) ? raw : undefined;
};

/** Title search against TMDB. A failed or refused request is an empty list, never a throw:
 *  the caller falls back to the next provider. A year the file states narrows the search. */
export async function tmdbSearch(
  type: "movie" | "series",
  query: string,
  config: TmdbConfig,
  fetchImpl: FetchLike = guardedFetch,
  options: { year?: number } = {},
): Promise<MetaItem[]> {
  const trimmed = query.trim();
  if (!trimmed || (type !== "movie" && type !== "series")) return [];
  if (Date.now() < searchPausedUntil) return [];
  const yearParam: Record<string, string> = options.year != null
    ? (mediaType(type) === "movie" ? { year: String(options.year) } : { first_air_date_year: String(options.year) })
    : {};
  let response: Response;
  try {
    response = await request(`/search/${mediaType(type)}`, {
      api_key: config.apiKey,
      language: config.language,
      query: trimmed,
      page: "1",
      include_adult: "false",
      ...yearParam,
    }, fetchImpl, SEARCH_TIMEOUT_MS);
  } catch (error) {
    log("WARN", "TMDB search failed", { operation: "search", type, reason: reasonOf(error, config.apiKey) });
    return [];
  }
  if (!response.ok) {
    if (response.status === 429 || response.status === 503) {
      const asked = tmdbRetryAfterMs(response);
      if (asked > 0) searchPausedUntil = Date.now() + Math.min(asked, SEARCH_PAUSE_MAX_MS);
    }
    log("WARN", "TMDB search failed", { operation: "search", type, status: response.status, retryAfterMs: tmdbRetryAfterMs(response) });
    return [];
  }
  let body: TmdbSearchResponse;
  try { body = await response.json() as TmdbSearchResponse; }
  catch (error) {
    log("WARN", "TMDB answered with malformed JSON", { operation: "search", type, reason: reasonOf(error, config.apiKey) });
    return [];
  }
  return (body.results ?? []).flatMap((row) => {
    const id = typeof row.id === "number" ? row.id : undefined;
    const name = mediaType(type) === "movie" ? row.title || row.original_title : row.name || row.original_name;
    if (id == null || !name) return [];
    const date = mediaType(type) === "movie" ? row.release_date : row.first_air_date;
    const year = releaseYear(date);
    const original = mediaType(type) === "movie" ? row.original_title : row.original_name;
    const originCountry = Array.isArray(row.origin_country)
      ? row.origin_country.filter((code): code is string => typeof code === "string" && Boolean(code))
      : [];
    return [{
      id: `tmdb:${id}`,
      type,
      name,
      ...(original && original !== name ? { originalTitle: original } : {}),
      ...(year ? { releaseInfo: year } : {}),
      ...(originCountry.length ? { originCountry } : {}),
      // How many people know this title, and the day it came out: the matcher tells two
      // namesakes apart by the first, and will not bind one that is not out yet.
      ...(typeof row.vote_count === "number" && Number.isFinite(row.vote_count) ? { voteCount: row.vote_count } : {}),
      ...(/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? "")) ? { released: String(date) } : {}),
      ...artworkOf({ poster_path: row.poster_path, backdrop_path: row.backdrop_path }),
    }];
  });
}

/** The IMDb id behind a TMDB id, when TMDB has one. A refusal, a timeout or an id that is
 *  not an IMDb id answers null rather than a guess. */
export async function tmdbExternalId(
  type: "movie" | "series",
  tmdbId: number,
  config: TmdbConfig,
  fetchImpl: FetchLike = guardedFetch,
): Promise<string | null> {
  if (type !== "movie" && type !== "series") return null;
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return null;
  let response: Response;
  try {
    response = await request(`/${mediaType(type)}/${tmdbId}/external_ids`, { api_key: config.apiKey, language: config.language }, fetchImpl);
  } catch (error) {
    log("WARN", "TMDB external id lookup failed", { operation: "external_ids", type, reason: reasonOf(error, config.apiKey) });
    return null;
  }
  if (!response.ok) {
    log("WARN", "TMDB external id lookup failed", { operation: "external_ids", type, status: response.status, retryAfterMs: tmdbRetryAfterMs(response) });
    return null;
  }
  let body: TmdbExternalIds;
  try { body = await response.json() as TmdbExternalIds; }
  catch (error) {
    log("WARN", "TMDB answered with malformed JSON", { operation: "external_ids", type, reason: reasonOf(error, config.apiKey) });
    return null;
  }
  return typeof body.imdb_id === "string" && IMDB_ID.test(body.imdb_id) ? body.imdb_id : null;
}

/** Alternate artwork of one chosen title, deduplicated and bounded. Only called once a
 *  binding has been picked: a per-candidate request would multiply the search cost. */
export async function tmdbGallery(
  type: "movie" | "series",
  id: string,
  config: TmdbConfig,
  fetchImpl: FetchLike = guardedFetch,
): Promise<TmdbGalleryPicture[]> {
  if (type !== "movie" && type !== "series") return [];
  const tmdbId = await resolveId(type, id, config, fetchImpl);
  if (tmdbId == null) return [];
  const language = normalizeLanguage(config.language);
  const include = [...new Set([...(language ? [language] : []), "en", "null"])].join(",");
  let response: Response;
  try {
    response = await request(`/${mediaType(type)}/${tmdbId}/images`, { api_key: config.apiKey, include_image_language: include }, fetchImpl);
  } catch (error) {
    log("WARN", "TMDB images lookup failed", { operation: "images", type, reason: reasonOf(error, config.apiKey) });
    return [];
  }
  if (!response.ok) {
    log("WARN", "TMDB images lookup failed", { operation: "images", type, status: response.status, retryAfterMs: tmdbRetryAfterMs(response) });
    return [];
  }
  let body: TmdbImages;
  try { body = await response.json() as TmdbImages; }
  catch (error) {
    log("WARN", "TMDB answered with malformed JSON", { operation: "images", type, reason: reasonOf(error, config.apiKey) });
    return [];
  }
  const rank = (row: TmdbImageRow) => {
    const iso = normalizeLanguage(row.iso_639_1 ?? undefined);
    const languageRank = iso === language ? 2 : iso === "en" ? 1 : 0;
    return languageRank * 1000 + (Number.isFinite(row.vote_average) ? Number(row.vote_average) : 0);
  };
  const seen = new Set<string>();
  const out: TmdbGalleryPicture[] = [];
  const take = (rows: TmdbImageRow[] | undefined, kind: TmdbGalleryPicture["kind"], size: TmdbImageSize) => {
    let taken = 0;
    for (const row of [...(rows ?? [])].sort((a, b) => rank(b) - rank(a))) {
      if (taken >= GALLERY_PER_KIND[kind] || out.length >= TMDB_GALLERY_LIMIT) return;
      const path = row.file_path;
      if (!path || seen.has(path)) continue;
      const url = tmdbImage(path, size);
      if (!url) continue;
      seen.add(path);
      out.push({ url, kind });
      taken += 1;
    }
  };
  take(body.posters, "poster", "w500");
  take(body.backdrops, "background", "w1280");
  take(body.logos, "logo", "w500");
  return out;
}

interface TmdbDetail {
  title?: string; original_title?: string;
  name?: string; original_name?: string;
  overview?: string;
  poster_path?: string | null; backdrop_path?: string | null;
}

interface TmdbFind {
  movie_results?: Array<{ id?: number }>;
  tv_results?: Array<{ id?: number }>;
}

interface TmdbVideos {
  results?: Array<{ key?: string; name?: string; site?: string; type?: string; official?: boolean; iso_639_1?: string | null }>;
}

/** Verifies the key. Throws AppError("…", "err.tmdbKeyRejected") when TMDB refuses it. */
export async function verifyTmdbKey(apiKey: string, fetchImpl: FetchLike = guardedFetch): Promise<void> {
  const response = await request("/configuration", { api_key: apiKey }, fetchImpl);
  if (!response.ok) throw new AppError("TMDB refused the API key.", "err.tmdbKeyRejected");
}

async function resolveId(type: string, id: string, config: TmdbConfig, fetchImpl: FetchLike): Promise<number | null> {
  const direct = /^tmdb:(\d+)$/.exec(id);
  if (direct) return Number(direct[1]);
  if (!id.startsWith("tt")) return null;

  const key = `${type}:${id}`;
  if (idCache.has(key)) return idCache.get(key) ?? null;

  let response: Response;
  try {
    response = await request(`/find/${encodeURIComponent(id)}`, { api_key: config.apiKey, language: config.language, external_source: "imdb_id" }, fetchImpl);
  } catch (error) {
    log("WARN", "TMDB id lookup failed", { operation: "find", type, id, reason: reasonOf(error, config.apiKey) });
    return null;
  }
  if (!response.ok) {
    log("WARN", "TMDB id lookup failed", { operation: "find", type, id, status: response.status });
    return null;
  }

  let body: TmdbFind;
  try { body = await response.json() as TmdbFind; }
  catch (error) {
    log("WARN", "TMDB answered with malformed JSON", { operation: "find", type, id, reason: reasonOf(error, config.apiKey) });
    return null;
  }

  const results = type === "movie" ? body.movie_results : body.tv_results;
  const found = results?.[0]?.id;
  const resolved = typeof found === "number" ? found : null;
  if (idCache.size > ID_CACHE_LIMIT) idCache.clear();
  idCache.set(key, resolved);
  return resolved;
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

export async function tmdbTrailer(type: "movie" | "series", id: string, config: TmdbConfig, fetchImpl: FetchLike = guardedFetch): Promise<{ youtubeId: string; title?: string } | null> {
  const tmdbId = await resolveId(type, id, config, fetchImpl);
  if (tmdbId == null) return null;
  let response: Response;
  try {
    response = await request(`/${type === "movie" ? "movie" : "tv"}/${tmdbId}/videos`, { api_key: config.apiKey, language: config.language }, fetchImpl);
  } catch (error) {
    log("WARN", "TMDB trailer lookup failed", { operation: "videos", type, id, reason: reasonOf(error, config.apiKey) });
    return null;
  }
  if (!response.ok) {
    log("WARN", "TMDB trailer lookup failed", { operation: "videos", type, id, status: response.status });
    return null;
  }
  let body: TmdbVideos;
  try { body = await response.json() as TmdbVideos; }
  catch (error) {
    log("WARN", "TMDB answered with malformed JSON", { operation: "videos", type, id, reason: reasonOf(error, config.apiKey) });
    return null;
  }
  const language = normalizeLanguage(config.language);
  const candidates = (body.results ?? []).filter((video) => video.site === "YouTube" && video.type === "Trailer" && YOUTUBE_ID.test(video.key ?? ""));
  if (!candidates.length) return null;
  const score = (video: typeof candidates[number]) =>
    (video.official ? 4 : 0) + (normalizeLanguage(video.iso_639_1 ?? undefined) === language ? 2 : 0) + (normalizeLanguage(video.iso_639_1 ?? undefined) === "en" ? 1 : 0);
  const selected = candidates.reduce((best, video) => score(video) > score(best) ? video : best);
  return { youtubeId: selected.key!, ...(selected.name ? { title: selected.name } : {}) };
}

const artworkOf = (detail: TmdbDetail): Pick<MetaItem, "poster" | "background"> => {
  const poster = tmdbImage(detail.poster_path, "w500");
  const background = tmdbImage(detail.backdrop_path, "w1280");
  return {
    ...(poster ? { poster } : {}),
    ...(background ? { background } : {}),
  };
};

const toMetaItem = (type: string, id: string, detail: TmdbDetail, config: TmdbConfig): MetaItem => {
  const name = (type === "movie" ? detail.title || detail.original_title : detail.name || detail.original_name) ?? "";
  const nameLanguage = normalizeLanguage(config.language);
  // The description is the only field the addon cannot give in the interface language: a
  // year reads the same everywhere, genres are three words nobody opened the panel for, and
  // the artwork is already painted. Replacing any of them late is movement without value.
  // fillMissingMeta takes all of it from the addon.
  return {
    id, type, name,
    ...(detail.overview ? { description: detail.overview } : {}),
    ...(nameLanguage ? { nameLanguage } : {}),
    ...(config.artwork ? artworkOf(detail) : {}),
  };
};

/** Metadata for one title, or null when TMDB does not know it. Never throws for a
 *  missing title; a transport failure is logged and answered with null. */
export async function tmdbMeta(type: string, id: string, config: TmdbConfig, fetchImpl: FetchLike = guardedFetch): Promise<MetaItem | null> {
  if (type !== "movie" && type !== "series") return null;
  const tmdbId = await resolveId(type, id, config, fetchImpl);
  if (tmdbId == null) return null;

  let response: Response;
  try {
    response = await request(`/${type === "movie" ? "movie" : "tv"}/${tmdbId}`, { api_key: config.apiKey, language: config.language }, fetchImpl);
  } catch (error) {
    log("WARN", "TMDB request failed", { operation: "meta", type, id, reason: reasonOf(error, config.apiKey) });
    return null;
  }
  if (response.status === 401) {
    log("WARN", "TMDB request failed", { operation: "meta", type, id, status: response.status });
    return null;
  }
  if (!response.ok) {
    log("WARN", "TMDB request failed", { operation: "meta", type, id, status: response.status });
    return null;
  }

  try { return toMetaItem(type, id, await response.json() as TmdbDetail, config); }
  catch (error) {
    log("WARN", "TMDB answered with malformed JSON", { operation: "meta", type, id, reason: reasonOf(error, config.apiKey) });
    return null;
  }
}
