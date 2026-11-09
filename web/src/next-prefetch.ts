/**
 * The server keeps a listed source for 30 minutes. An episode runs about that long, so a list read
 * when it started is often dead by the time the next one should play. A prefetch is renewed and
 * trusted only well inside that window.
 */
export const NEXT_PREFETCH_FRESH_MS = 20 * 60_000;

export const freshPrefetch = <T extends { at: number }>(entry: T | null | undefined, now = Date.now()): T | null =>
  entry && now - entry.at < NEXT_PREFETCH_FRESH_MS ? entry : null;
