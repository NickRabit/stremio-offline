import type { BrowseItem } from "./types";

/** How many posters one idle pass may warm, and how many of them load at once. */
export const PRELOAD_POSTER_LIMIT = 20;
export const PRELOAD_CONCURRENCY = 4;

/** The distinct picture addresses on a page of browse rows, in listing order and capped.
 *  A mosaic contributes its own posters first: those are the tiles the row actually draws.
 *  Duplicates and rows with no picture are ignored, so the same poster is fetched once. */
export function posterUrls(items: BrowseItem[], limit = PRELOAD_POSTER_LIMIT): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const add = (url: string | undefined) => {
    if (!url || seen.has(url) || urls.length >= limit) return;
    seen.add(url);
    urls.push(url);
  };
  for (const item of items) {
    if (item.kind !== "file") for (const poster of item.posters ?? []) add(poster);
    add(item.poster);
  }
  return urls;
}

export interface PreloadOptions {
  signal?: AbortSignal;
  /** Injected so a test can count loads and hold them open. Defaults to an `Image` probe. */
  load?: (url: string) => Promise<void>;
  limit?: number;
  concurrency?: number;
}

/** Fetches one picture through an `Image`, which fills the browser's cache for when the tile
 *  renders. A failure (a broken picture, a refused request) is not an error here. */
const loadPoster = (url: string, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    const image = new Image();
    const settle = () => {
      signal?.removeEventListener("abort", abort);
      image.onload = null;
      image.onerror = null;
      resolve();
    };
    const abort = () => { image.src = ""; settle(); };
    image.onload = settle;
    image.onerror = settle;
    if (signal?.aborted) { settle(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    image.src = url;
  });

/** Warms the pictures the library is about to draw, at most `limit` of them and never more
 *  than `concurrency` at once. Only the request in flight when `signal` aborts is left to
 *  finish; nothing else is started. Never throws. */
export async function preloadLibraryPosters(items: BrowseItem[], options: PreloadOptions = {}): Promise<void> {
  const { signal, load, limit = PRELOAD_POSTER_LIMIT, concurrency = PRELOAD_CONCURRENCY } = options;
  const urls = posterUrls(items, limit);
  if (!urls.length) return;
  const fetchOne = load ?? ((url: string) => loadPoster(url, signal));
  let next = 0;
  const worker = async () => {
    while (!signal?.aborted) {
      const url = urls[next++];
      if (!url) return;
      await fetchOne(url).catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
}

/** Runs `task` once the browser is idle, or after `timeoutMs` at the latest. Returns a
 *  canceller. Browsers without `requestIdleCallback` fall back to the timeout. */
export function scheduleIdle(task: () => void, timeoutMs = 2000): () => void {
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(() => task(), { timeout: timeoutMs });
    return () => window.cancelIdleCallback(handle);
  }
  const timer = setTimeout(task, timeoutMs);
  return () => clearTimeout(timer);
}
