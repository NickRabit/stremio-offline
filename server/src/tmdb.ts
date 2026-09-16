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
const ID_CACHE_LIMIT = 500;

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

const reasonOf = (error: unknown) => error instanceof Error ? error.message : String(error);

const tmdbUrl = (path: string, params: Record<string, string>) => {
  const url = new URL(`${TMDB_API}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
};

const request = (path: string, params: Record<string, string>, fetchImpl: FetchLike) =>
  fetchImpl(tmdbUrl(path, params), { signal: AbortSignal.timeout(TIMEOUT_MS) });

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
    log("WARN", "TMDB id lookup failed", { operation: "find", type, id, reason: reasonOf(error) });
    return null;
  }
  if (!response.ok) {
    log("WARN", "TMDB id lookup failed", { operation: "find", type, id, status: response.status });
    return null;
  }

  let body: TmdbFind;
  try { body = await response.json() as TmdbFind; }
  catch (error) {
    log("WARN", "TMDB answered with malformed JSON", { operation: "find", type, id, reason: reasonOf(error) });
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
    log("WARN", "TMDB trailer lookup failed", { operation: "videos", type, id, reason: reasonOf(error) });
    return null;
  }
  if (!response.ok) {
    log("WARN", "TMDB trailer lookup failed", { operation: "videos", type, id, status: response.status });
    return null;
  }
  let body: TmdbVideos;
  try { body = await response.json() as TmdbVideos; }
  catch (error) {
    log("WARN", "TMDB answered with malformed JSON", { operation: "videos", type, id, reason: reasonOf(error) });
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
    log("WARN", "TMDB request failed", { operation: "meta", type, id, reason: reasonOf(error) });
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
    log("WARN", "TMDB answered with malformed JSON", { operation: "meta", type, id, reason: reasonOf(error) });
    return null;
  }
}
