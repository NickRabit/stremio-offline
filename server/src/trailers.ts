import { addonMetadata } from "./addons.js";
import { tmdbTrailer, type TmdbConfig } from "./tmdb.js";
import type { AddonRecord, MetaItem } from "./types.js";

export interface Trailer { youtubeId: string; title?: string; provider: "cinemeta" | "tmdb" }

const TTL_MS = 6 * 60 * 60_000;
const LIMIT = 300;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const cache = new Map<string, { at: number; value: Trailer | null }>();

export function clearTrailerCache() { cache.clear(); }

const youtubeId = (value: unknown): string | undefined =>
  typeof value === "string" && YOUTUBE_ID.test(value) ? value : undefined;

const titleOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export function cinemetaTrailer(meta: MetaItem): Pick<Trailer, "youtubeId" | "title"> | null {
  const legacy = Array.isArray(meta.trailers) ? meta.trailers : [];
  for (const value of legacy) {
    if (!value || typeof value !== "object") continue;
    const trailer = value as Record<string, unknown>;
    const id = trailer.type === "Trailer" ? youtubeId(trailer.source) : undefined;
    if (id) return { youtubeId: id, title: titleOf(trailer.title) };
  }
  const streams = Array.isArray(meta.trailerStreams) ? meta.trailerStreams : [];
  for (const value of streams) {
    if (!value || typeof value !== "object") continue;
    const trailer = value as Record<string, unknown>;
    const id = youtubeId(trailer.ytId);
    if (id) return { youtubeId: id, title: titleOf(trailer.title) };
  }
  return null;
}

async function fromCinemeta(addons: AddonRecord[], type: string, id: string): Promise<Pick<Trailer, "youtubeId" | "title"> | null> {
  const addon = addons.find((item) => item.manifest.id === "com.linvo.cinemeta");
  if (!addon) return null;
  try {
    const meta = await addonMetadata(addon, type, id);
    return meta ? cinemetaTrailer(meta) : null;
  } catch { return null; }
}

export async function trailerFor(addons: AddonRecord[], type: string, id: string, language: string, tmdb?: TmdbConfig): Promise<Trailer | null> {
  if (type !== "movie" && type !== "series") return null;
  const key = `${type}:${id}:${language}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const cinemeta = await fromCinemeta(addons, type, id);
  const tmdbResult = cinemeta ? null : tmdb ? await tmdbTrailer(type, id, tmdb) : null;
  const value = cinemeta
    ? { youtubeId: cinemeta.youtubeId, ...(cinemeta.title ? { title: cinemeta.title } : {}), provider: "cinemeta" as const }
    : tmdbResult ? { ...tmdbResult, provider: "tmdb" as const } : null;
  if (cache.size >= LIMIT) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}
