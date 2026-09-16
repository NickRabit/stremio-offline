import { AppError } from "./errors.js";
import { guardedFetch } from "./outbound.js";
import { log } from "./logger.js";
import { normalizeLanguage } from "./language.js";
import type { FetchLike } from "./debrid.js";
import type { MetaItem } from "./types.js";

export interface TmdbConfig { apiKey: string; language: string }

const TMDB_API = "https://api.themoviedb.org/3";
const TIMEOUT_MS = 12_000;
const ID_CACHE_LIMIT = 500;

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
  release_date?: string; first_air_date?: string;
  genres?: Array<{ name?: string }>;
}

interface TmdbFind {
  movie_results?: Array<{ id?: number }>;
  tv_results?: Array<{ id?: number }>;
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

const toMetaItem = (type: string, id: string, detail: TmdbDetail, language: string): MetaItem => {
  const name = (type === "movie" ? detail.title || detail.original_title : detail.name || detail.original_name) ?? "";
  const date = (type === "movie" ? detail.release_date : detail.first_air_date) ?? "";
  const year = date.slice(0, 4);
  const genres = (detail.genres ?? []).map((genre) => genre.name).filter((value): value is string => Boolean(value));
  const poster = detail.poster_path ? `https://image.tmdb.org/t/p/w500${detail.poster_path}` : undefined;
  const background = detail.backdrop_path ? `https://image.tmdb.org/t/p/original${detail.backdrop_path}` : undefined;
  const nameLanguage = normalizeLanguage(language);
  return {
    id, type, name,
    ...(detail.overview ? { description: detail.overview } : {}),
    ...(poster ? { poster } : {}),
    ...(background ? { background } : {}),
    ...(year ? { year, releaseInfo: year } : {}),
    ...(genres.length ? { genres } : {}),
    ...(nameLanguage ? { nameLanguage } : {}),
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

  try { return toMetaItem(type, id, await response.json() as TmdbDetail, config.language); }
  catch (error) {
    log("WARN", "TMDB answered with malformed JSON", { operation: "meta", type, id, reason: reasonOf(error) });
    return null;
  }
}
