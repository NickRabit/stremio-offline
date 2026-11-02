import { log } from "./logger.js";
import { guardedJson, OutboundError } from "./outbound.js";

export interface SegmentRange { start: number; end: number }
export interface IntroSegments { intro?: SegmentRange; recap?: SegmentRange; outro?: SegmentRange }
export interface IntroQuery { imdbId: string; season?: number; episode?: number }

export type IntroFetcher = (query: IntroQuery, signal?: AbortSignal) => Promise<IntroSegments | "absent">;

const FOUND_TTL_MS = 24 * 60 * 60_000;
const ABSENT_TTL_MS = 6 * 60 * 60_000;
const FAILURE_TTL_MS = 10 * 60_000;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const range = (value: unknown): SegmentRange | undefined => {
  if (!record(value)) return undefined;
  const start = value.start_sec;
  const end = value.end_sec;
  if (typeof start !== "number" || typeof end !== "number"
    || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= end) return undefined;
  return { start, end };
};

export function segmentsFromIntroDb(body: unknown): IntroSegments {
  if (!record(body)) return {};
  const intro = range(body.intro);
  const recap = range(body.recap);
  const outro = range(body.outro);
  return {
    ...(intro ? { intro } : {}),
    ...(recap ? { recap } : {}),
    ...(outro ? { outro } : {}),
  };
}

const urlFor = (query: IntroQuery) => {
  const params = new URLSearchParams({ imdb_id: query.imdbId });
  if (query.season !== undefined && query.episode !== undefined) {
    params.set("season", String(query.season));
    params.set("episode", String(query.episode));
  } else {
    params.set("is_movie", "true");
  }
  return `https://api.introdb.app/segments?${params}`;
};

export async function fetchIntroSegments(query: IntroQuery, signal?: AbortSignal): Promise<IntroSegments | "absent"> {
  try {
    const body = await guardedJson<unknown>(urlFor(query), {
      headers: { accept: "application/json" },
    }, {
      signal,
      deadlineMs: 5000,
      maxBytes: 64 * 1024,
      interactive: true,
    });
    return segmentsFromIntroDb(body);
  } catch (error) {
    if (error instanceof OutboundError && error.code === "http-404") return "absent";
    throw error;
  }
}

interface CachedSegments {
  value: IntroSegments;
  expiresAt: number;
}

interface PendingSegments {
  controller: AbortController;
  promise: Promise<IntroSegments>;
  waiters: number;
  settled: boolean;
}

const keyOf = (query: IntroQuery) =>
  query.season === undefined || query.episode === undefined
    ? query.imdbId
    : `${query.imdbId}:${query.season}:${query.episode}`;

const hasSegments = (segments: IntroSegments) =>
  segments.intro !== undefined || segments.recap !== undefined || segments.outro !== undefined;

const reasonOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export class IntroSegmentsCache {
  private readonly entries = new Map<string, CachedSegments>();
  private readonly pending = new Map<string, PendingSegments>();
  private readonly fetcher: IntroFetcher;
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(options: {
    fetcher?: IntroFetcher;
    now?: () => number;
    maxEntries?: number;
  } = {}) {
    this.fetcher = options.fetcher ?? fetchIntroSegments;
    this.now = options.now ?? Date.now;
    this.maxEntries = Math.max(0, Math.floor(options.maxEntries ?? 2000));
  }

  get(query: IntroQuery, signal?: AbortSignal): Promise<IntroSegments> {
    if (signal?.aborted) return Promise.resolve({});
    const key = keyOf(query);
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.now()) return Promise.resolve(cached.value);

    let pending = this.pending.get(key);
    if (!pending) {
      const controller = new AbortController();
      pending = {
        controller,
        waiters: 0,
        settled: false,
        promise: Promise.resolve({}),
      };
      this.pending.set(key, pending);
      pending.promise = this.fetch(key, query, pending);
    }
    return this.wait(pending, signal);
  }

  private async fetch(key: string, query: IntroQuery, pending: PendingSegments): Promise<IntroSegments> {
    try {
      const result = await this.fetcher(query, pending.controller.signal);
      if (result === "absent" || !hasSegments(result)) {
        this.remember(key, {}, ABSENT_TTL_MS);
        return {};
      }
      this.remember(key, result, FOUND_TTL_MS);
      return result;
    } catch (error) {
      if (!pending.controller.signal.aborted) {
        log("DEBUG", "IntroDB segments could not be read", { imdbId: query.imdbId, reason: reasonOf(error) });
        this.remember(key, {}, FAILURE_TTL_MS);
      }
      return {};
    } finally {
      pending.settled = true;
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }
  }

  private wait(pending: PendingSegments, signal?: AbortSignal): Promise<IntroSegments> {
    pending.waiters += 1;
    return new Promise((resolve) => {
      let done = false;
      let abort = () => {};
      const finish = (value: IntroSegments) => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", abort);
        pending.waiters -= 1;
        if (pending.waiters === 0 && !pending.settled) pending.controller.abort();
        resolve(value);
      };
      abort = () => finish({});
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      void pending.promise.then(finish);
    });
  }

  private remember(key: string, value: IntroSegments, ttl: number) {
    if (this.maxEntries === 0) return;
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttl });
  }
}
