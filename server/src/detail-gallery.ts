import type { TmdbConfig, TmdbGalleryPicture } from "./tmdb.js";

type GalleryType = "movie" | "series";
type GalleryLoader = (type: GalleryType, id: string, config: TmdbConfig, signal: AbortSignal) => Promise<TmdbGalleryPicture[]>;

interface GalleryEntry {
  at: number;
  pictures: TmdbGalleryPicture[];
}

interface FlightWaiter {
  onAbort(): void;
}

interface GalleryFlight {
  controller: AbortController;
  waiters: Set<FlightWaiter>;
  done: Promise<TmdbGalleryPicture[]>;
  settled: boolean;
  abandoned: boolean;
}

const GALLERY_TTL_MS = 30 * 60_000;
const GALLERY_CACHE_LIMIT = 128;
const GALLERY_ID = /^(tt[0-9]+|tmdb:[0-9]+)$/;

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? Object.assign(new Error("The gallery lookup was cancelled."), { name: "AbortError" });

export class DetailGalleryCache {
  private entries = new Map<string, GalleryEntry>();
  private flights = new Map<string, GalleryFlight>();

  constructor(
    private readonly load: GalleryLoader,
    private readonly options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
  ) {}

  async get(type: string, id: string, language: string, apiKey: string, signal?: AbortSignal): Promise<TmdbGalleryPicture[]> {
    if (!apiKey || (type !== "movie" && type !== "series") || !GALLERY_ID.test(id)) return [];
    if (signal?.aborted) throw abortReason(signal);

    const key = `${type}:${id}:${language}:${apiKey}`;
    const now = this.now();
    const cached = this.entries.get(key);
    if (cached && now - cached.at < this.ttlMs) return cached.pictures;
    if (cached) this.entries.delete(key);

    const flight = this.flights.get(key) ?? this.start(type, id, language, apiKey, key);
    return this.attach(key, flight, signal);
  }

  private get ttlMs() {
    return this.options.ttlMs ?? GALLERY_TTL_MS;
  }

  private get maxEntries() {
    return this.options.maxEntries ?? GALLERY_CACHE_LIMIT;
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  private start(type: GalleryType, id: string, language: string, apiKey: string, key: string): GalleryFlight {
    const flight: GalleryFlight = {
      controller: new AbortController(),
      waiters: new Set<FlightWaiter>(),
      done: Promise.resolve([]),
      settled: false,
      abandoned: false,
    };
    this.flights.set(key, flight);
    flight.done = (async () => {
      let pictures: TmdbGalleryPicture[];
      try {
        pictures = await this.load(type, id, { apiKey, language }, flight.controller.signal);
      } catch {
        if (flight.controller.signal.aborted) return [];
        pictures = [];
      }
      if (flight.abandoned || flight.controller.signal.aborted) return [];
      this.remember(key, pictures);
      return pictures;
    })().finally(() => {
      flight.settled = true;
      if (this.flights.get(key) === flight) this.flights.delete(key);
    });
    return flight;
  }

  private attach(key: string, flight: GalleryFlight, signal?: AbortSignal): Promise<TmdbGalleryPicture[]> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal?.removeEventListener("abort", waiter.onAbort);
      const waiter: FlightWaiter = {
        onAbort: () => {
          if (settled) return;
          settled = true;
          cleanup();
          flight.waiters.delete(waiter);
          reject(abortReason(signal!));
          this.abandon(key, flight);
        },
      };
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        flight.waiters.delete(waiter);
        settle();
      };
      flight.waiters.add(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      flight.done.then(
        (pictures) => finish(() => resolve(pictures)),
        (error) => finish(() => reject(error)),
      );
      if (signal?.aborted) waiter.onAbort();
    });
  }

  private abandon(key: string, flight: GalleryFlight): void {
    if (flight.waiters.size > 0 || flight.settled) return;
    flight.abandoned = true;
    if (this.flights.get(key) === flight) this.flights.delete(key);
    flight.controller.abort();
  }

  private remember(key: string, pictures: TmdbGalleryPicture[]): void {
    this.entries.set(key, { at: this.now(), pictures });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }
}
