import { streamCandidates, streamListings, type StreamCandidate, type StreamListing } from "./addons.js";
import { addonIdentity } from "./addon-identity.js";
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

interface InFlightEntry {
  type: string;
  videoId: string;
  epoch: number;
  promise: Promise<StreamListing>;
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
  private readonly inFlight = new Map<string, InFlightEntry>();
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
    const candidates = await streamCandidates(addons, type, id);
    const hits = new Map<string, StreamItem[]>();
    const misses: StreamCandidate[] = [];

    for (const candidate of candidates) {
      const key = this.key(type, candidate.id, candidate.addon);
      const entry = this.entries.get(key);
      if (entry && this.now() - entry.at < this.ttlMs) {
        this.entries.delete(key);
        this.entries.set(key, entry);
        hits.set(candidate.addon.key, entry.items);
      } else {
        if (entry) this.entries.delete(key);
        misses.push(candidate);
      }
    }

    const results = await Promise.allSettled(misses.map((candidate) => this.fetchOnce(candidate, type, id)));
    results.forEach((result, index) => {
      const candidate = misses[index]!;
      if (result.status !== "fulfilled" || result.value.status !== "success" || result.value.addonKey !== candidate.addon.key) return;
      hits.set(candidate.addon.key, result.value.items);
    });

    return candidates.flatMap((candidate) => hits.get(candidate.addon.key) ?? []);
  }

  invalidate(type: string, id: string): void {
    this.epoch += 1;
    for (const [key, entry] of this.entries) {
      if (entry.type === type && entry.videoId === id) this.entries.delete(key);
    }
    for (const [key, entry] of this.inFlight) {
      if (entry.type === type && entry.videoId === id) this.inFlight.delete(key);
    }
  }

  clear(): void {
    this.epoch += 1;
    this.entries.clear();
    this.inFlight.clear();
  }

  private key(type: string, id: string, addon: AddonRecord): string {
    return JSON.stringify([type, id, addon.key, addonIdentity(addon)]);
  }

  private fetchOnce(candidate: StreamCandidate, type: string, videoId: string): Promise<StreamListing> {
    const key = this.key(type, candidate.id, candidate.addon);
    const addonKey = candidate.addon.key;
    const requested = { ...candidate.addon, manifest: structuredClone(candidate.addon.manifest) };
    const existing = this.inFlight.get(key);
    if (existing) return existing.promise;

    const promise = Promise.resolve()
      .then(() => this.fetch(requested, type, candidate.id))
      .catch((): StreamListing => ({ addonKey, status: "failure" }));
    const entry: InFlightEntry = { type, videoId, epoch: this.epoch, promise };
    this.inFlight.set(key, entry);
    void promise.then((listing) => {
      try {
        if (entry.epoch === this.epoch && listing.status === "success" && listing.addonKey === addonKey) {
          this.remember(key, type, videoId, listing.items);
        }
      } finally {
        if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
      }
    }).catch(() => undefined);
    return promise;
  }

  private remember(key: string, type: string, id: string, items: StreamItem[]): void {
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
