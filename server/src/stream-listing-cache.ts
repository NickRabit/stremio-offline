import { streamCandidates, streamListings, type StreamListing } from "./addons.js";
import type { AddonRecord, StreamItem } from "./types.js";

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 100;

type StreamListingFetcher = (addon: AddonRecord, type: string, id: string) => Promise<StreamListing>;

interface CacheEntry {
  type: string;
  videoId: string;
  at: number;
  items: StreamItem[];
}

interface Options {
  fetch?: StreamListingFetcher;
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
}

const fetchStreamListing: StreamListingFetcher = async (addon, type, id) =>
  (await streamListings([addon], type, id))[0] ?? { addonKey: addon.key, status: "failure" };

export class StreamListingCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly fetch: StreamListingFetcher;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private epoch = 0;

  constructor(options: Options = {}) {
    this.fetch = options.fetch ?? fetchStreamListing;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async list(addons: AddonRecord[], type: string, id: string): Promise<StreamItem[]> {
    const candidates = streamCandidates(addons, type, id);
    const hits = new Map<string, StreamItem[]>();
    const misses: AddonRecord[] = [];

    for (const addon of candidates) {
      const key = this.key(type, id, addon);
      const entry = this.entries.get(key);
      if (entry && this.now() - entry.at < this.ttlMs) {
        this.entries.delete(key);
        this.entries.set(key, entry);
        hits.set(addon.key, entry.items);
      } else {
        if (entry) this.entries.delete(key);
        misses.push(addon);
      }
    }

    const epoch = this.epoch;
    const results = await Promise.allSettled(misses.map((addon) => this.fetch(addon, type, id)));
    results.forEach((result, index) => {
      if (result.status !== "fulfilled" || result.value.status !== "success" || result.value.addonKey !== misses[index].key) return;
      hits.set(misses[index].key, result.value.items);
      if (epoch === this.epoch) this.remember(type, id, misses[index], result.value.items);
    });

    return candidates.flatMap((addon) => hits.get(addon.key) ?? []);
  }

  invalidate(type: string, id: string): void {
    this.epoch += 1;
    for (const [key, entry] of this.entries) {
      if (entry.type === type && entry.videoId === id) this.entries.delete(key);
    }
  }

  clear(): void {
    this.epoch += 1;
    this.entries.clear();
  }

  private key(type: string, id: string, addon: AddonRecord): string {
    return JSON.stringify([type, id, addon.key, addon.manifestUrl, addon.manifest.version]);
  }

  private remember(type: string, id: string, addon: AddonRecord, items: StreamItem[]): void {
    const key = this.key(type, id, addon);
    this.entries.set(key, {
      type,
      videoId: id,
      at: this.now(),
      items,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
