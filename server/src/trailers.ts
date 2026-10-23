import { addonMetadata } from "./addons.js";
import { OutboundError } from "./outbound.js";
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

const throwIfCancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new OutboundError("cancelled");
};

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

async function fromCinemeta(
  addons: AddonRecord[],
  type: string,
  id: string,
  signal?: AbortSignal,
): Promise<Pick<Trailer, "youtubeId" | "title"> | null> {
  const addon = addons.find((item) => item.manifest.id === "com.linvo.cinemeta");
  if (!addon) return null;
  try {
    const meta = await addonMetadata(addon, type, id, false, signal);
    throwIfCancelled(signal);
    return meta ? cinemetaTrailer(meta) : null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

export async function trailerFor(
  addons: AddonRecord[],
  type: string,
  id: string,
  language: string,
  tmdb?: TmdbConfig,
  signal?: AbortSignal,
): Promise<Trailer | null> {
  if (type !== "movie" && type !== "series") return null;
  throwIfCancelled(signal);
  // A trailer can come from Cinemeta, so the cache cannot be shared between callers whose
  // allowance differs: the addons the caller may use are part of the key.
  const key = `${type}:${id}:${language}:${addons.map((addon) => addon.key).join(",")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const cinemeta = await fromCinemeta(addons, type, id, signal);
  throwIfCancelled(signal);
  const tmdbResult = cinemeta ? null : tmdb ? await tmdbTrailer(type, id, tmdb, undefined, signal) : null;
  throwIfCancelled(signal);
  const value = cinemeta
    ? { youtubeId: cinemeta.youtubeId, ...(cinemeta.title ? { title: cinemeta.title } : {}), provider: "cinemeta" as const }
    : tmdbResult ? { ...tmdbResult, provider: "tmdb" as const } : null;
  if (cache.size >= LIMIT) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}
