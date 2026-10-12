import { randomBytes } from "node:crypto";
import type { ProviderItem } from "./media-server-provider.js";
import { MediaServerError, type MediaServerErrorCode } from "./media-server-types.js";

/** The identity a snapshot was taken under. A scan is only still valid while all of these
 *  match what the caller captured before it started. */
export interface MediaServerSnapshotKey {
  libraryId: string;
  connectionId: string;
  remoteId: string;
  generation: number;
  identityKey: string;
}

/** A completed scan. `items` is deep-frozen: the cache is shared, so a caller that mutates
 *  what it is handed would change what the next reader sees. */
export interface MediaServerSnapshot {
  id: string;
  key: Readonly<MediaServerSnapshotKey>;
  asOf: string;
  items: readonly ProviderItem[];
  bytes: number;
}

export interface SnapshotScan {
  items: ProviderItem[];
  asOf: string;
}

export interface MediaServerIndexOptions {
  clock?: () => number;
  maxSnapshots?: number;
  maxItemsPerLibrary?: number;
  maxBytesPerLibrary?: number;
  maxBytesTotal?: number;
  maxConcurrentScans?: number;
  ttlMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  rateLimitMaxMs?: number;
  maxFailures?: number;
}

const DEFAULTS = Object.freeze({
  maxSnapshots: 20,
  maxItemsPerLibrary: 10_000,
  maxBytesPerLibrary: 5 * 1024 * 1024,
  maxBytesTotal: 32 * 1024 * 1024,
  maxConcurrentScans: 2,
  ttlMs: 60_000,
  retryBaseMs: 5_000,
  retryMaxMs: 60_000,
  rateLimitMaxMs: 300_000,
  maxFailures: 1024,
});

interface Entry {
  snapshot: MediaServerSnapshot;
  takenAt: number;
}

interface Failure {
  key: MediaServerSnapshotKey;
  code: MediaServerErrorCode;
  retryAt: number;
  count: number;
}

interface Staged {
  controller: AbortController;
  key: MediaServerSnapshotKey;
}

const busy = (message: string): MediaServerError => new MediaServerError("busy", message);
const stale = (): MediaServerError => new MediaServerError("stale-generation", "The media-server library snapshot changed; start the listing again.");
const closed = (): MediaServerError => new MediaServerError("closed", "The media-server index is closed.");
const tooLarge = (message: string): MediaServerError => new MediaServerError("response-too-large", message);

const deepFreeze = (items: ProviderItem[]): readonly ProviderItem[] => {
  for (const item of items) {
    if (item.providerIds) Object.freeze(item.providerIds);
    Object.freeze(item);
  }
  return Object.freeze(items);
};

const sameKey = (left: MediaServerSnapshotKey, right: MediaServerSnapshotKey): boolean =>
  left.libraryId === right.libraryId && left.connectionId === right.connectionId && left.remoteId === right.remoteId
  && left.generation === right.generation && left.identityKey === right.identityKey;

/** Bounded, in-memory-only snapshots of one connection's libraries. One snapshot per
 *  library, replaced whole. A failed refresh never serves the previous snapshot: the data
 *  stays cached internally for recovery and for a cursor that names it exactly, but the
 *  request that could not confirm itself fails closed. */
export class MediaServerIndex {
  private readonly limits: Required<Omit<MediaServerIndexOptions, "clock">>;
  private readonly clock: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly failures = new Map<string, Failure>();
  private readonly scanning = new Map<string, Staged>();
  private totalBytes = 0;
  private activeScans = 0;
  private closed = false;

  constructor(options: MediaServerIndexOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.limits = {
      maxSnapshots: options.maxSnapshots ?? DEFAULTS.maxSnapshots,
      maxItemsPerLibrary: options.maxItemsPerLibrary ?? DEFAULTS.maxItemsPerLibrary,
      maxBytesPerLibrary: options.maxBytesPerLibrary ?? DEFAULTS.maxBytesPerLibrary,
      maxBytesTotal: options.maxBytesTotal ?? DEFAULTS.maxBytesTotal,
      maxConcurrentScans: options.maxConcurrentScans ?? DEFAULTS.maxConcurrentScans,
      ttlMs: options.ttlMs ?? DEFAULTS.ttlMs,
      retryBaseMs: options.retryBaseMs ?? DEFAULTS.retryBaseMs,
      retryMaxMs: options.retryMaxMs ?? DEFAULTS.retryMaxMs,
      rateLimitMaxMs: options.rateLimitMaxMs ?? DEFAULTS.rateLimitMaxMs,
      maxFailures: options.maxFailures ?? DEFAULTS.maxFailures,
    };
  }

  /** A snapshot for one library. A cursor names an exact snapshot and never triggers a scan;
   *  an un-cursored request inside a backoff window is refused with the failure that opened
   *  it, so remote denial is never papered over with older data. */
  async resolve(
    key: MediaServerSnapshotKey,
    options: { cursorSnapshotId?: string; scan: (signal: AbortSignal) => Promise<SnapshotScan> },
  ): Promise<MediaServerSnapshot> {
    if (this.closed) throw closed();
    const now = this.clock();
    const entry = this.current(key);
    if (options.cursorSnapshotId !== undefined) {
      if (!entry || entry.snapshot.id !== options.cursorSnapshotId) throw stale();
      this.touch(key.libraryId, entry);
      return entry.snapshot;
    }
    const failure = this.matchingFailure(key);
    if (failure && now < failure.retryAt) {
      throw new MediaServerError(failure.code, "The media-server library is backing off after a failure.", undefined, failure.retryAt - now);
    }
    if (entry && now - entry.takenAt < this.limits.ttlMs) {
      this.touch(key.libraryId, entry);
      return entry.snapshot;
    }
    return this.scan(key, options.scan);
  }

  /** Drops every snapshot, failure and staged scan belonging to one connection. A failure
   *  recorded under an old generation or identity goes with it, so a repaired connection is
   *  not held back by history it no longer describes. */
  invalidateConnection(connectionId: string): void {
    for (const [libraryId, entry] of [...this.entries]) {
      if (entry.snapshot.key.connectionId === connectionId) this.drop(libraryId);
    }
    for (const [libraryId, failure] of [...this.failures]) {
      if (failure.key.connectionId === connectionId) this.failures.delete(libraryId);
    }
    this.abortStaged((staged) => staged.key.connectionId === connectionId);
  }

  invalidateLibrary(libraryId: string): void {
    this.drop(libraryId);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abortStaged(() => true);
    this.entries.clear();
    this.failures.clear();
    this.totalBytes = 0;
  }

  private async scan(key: MediaServerSnapshotKey, work: (signal: AbortSignal) => Promise<SnapshotScan>): Promise<MediaServerSnapshot> {
    if (this.activeScans >= this.limits.maxConcurrentScans) throw busy("Too many media-server library scans are running.");
    if (this.scanning.has(key.libraryId)) throw busy("That media-server library is already being scanned.");
    const controller = new AbortController();
    const staged: Staged = { controller, key: { ...key } };
    this.scanning.set(key.libraryId, staged);
    this.activeScans += 1;
    let released = false;
    const finish = (): void => {
      if (released) return;
      released = true;
      this.activeScans -= 1;
      // Only the scan that still owns the slot may remove the record: a newer staged scan
      // for the same library must not be forgotten by the one it replaced.
      if (this.scanning.get(key.libraryId) === staged) this.scanning.delete(key.libraryId);
    };
    try {
      const result = await work(controller.signal);
      finish();
      if (this.closed) throw closed();
      // An invalidation aborts the staged scan; a provider that ignores the signal still
      // must not publish after its library, connection or generation was dropped.
      if (controller.signal.aborted) throw stale();
      const snapshot = this.publish(key, result);
      this.failures.delete(key.libraryId);
      return snapshot;
    } catch (error) {
      finish();
      const failure = error instanceof MediaServerError ? error : undefined;
      if (this.closed && failure?.code !== "stale-generation") throw closed();
      // A local refusal (a route or authority error) is not a provider failure: it earns no
      // backoff and it is handed back for the route to preserve.
      if (!failure) throw error;
      const discard = failure.code === "stale-generation" || failure.code === "identity-changed"
        || failure.code === "cancelled" || failure.code === "closed" || failure.code === "unsupported-policy";
      if (!discard) this.noteFailure(key, failure);
      throw error;
    }
  }

  private publish(key: MediaServerSnapshotKey, result: SnapshotScan): MediaServerSnapshot {
    if (result.items.length > this.limits.maxItemsPerLibrary) throw tooLarge("The media-server library has too many items.");
    const bytes = Buffer.byteLength(JSON.stringify(result.items), "utf8");
    if (bytes > this.limits.maxBytesPerLibrary) throw tooLarge("The media-server library snapshot is too large.");
    // Refused even when a single library's budget exceeds the whole cache: the aggregate cap
    // must hold, not be evaded by evicting everything else.
    if (bytes > this.limits.maxBytesTotal) throw tooLarge("The media-server library snapshot is too large for the cache.");
    const snapshot: MediaServerSnapshot = {
      id: randomBytes(16).toString("hex"),
      key: Object.freeze({ ...key }),
      asOf: result.asOf,
      items: deepFreeze(result.items.slice()),
      bytes,
    };
    this.drop(key.libraryId);
    this.entries.set(key.libraryId, { snapshot, takenAt: this.clock() });
    this.totalBytes += bytes;
    this.evict();
    return snapshot;
  }

  private evict(): void {
    while (this.entries.size > this.limits.maxSnapshots) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
    while (this.totalBytes > this.limits.maxBytesTotal && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
  }

  private drop(libraryId: string): void {
    const entry = this.entries.get(libraryId);
    if (entry) {
      this.totalBytes -= entry.snapshot.bytes;
      this.entries.delete(libraryId);
    }
    this.failures.delete(libraryId);
    const staged = this.scanning.get(libraryId);
    if (staged) staged.controller.abort();
  }

  private abortStaged(match: (staged: Staged) => boolean): void {
    for (const staged of this.scanning.values()) {
      if (match(staged)) staged.controller.abort();
    }
  }

  /** A read hit updates recency, so a frequently read snapshot is not evicted before an
   *  idle one that was written more recently. */
  private touch(libraryId: string, entry: Entry): void {
    this.entries.delete(libraryId);
    this.entries.set(libraryId, entry);
  }

  private current(key: MediaServerSnapshotKey): Entry | undefined {
    const entry = this.entries.get(key.libraryId);
    if (!entry) return undefined;
    if (!sameKey(entry.snapshot.key, key)) {
      this.drop(key.libraryId);
      return undefined;
    }
    return entry;
  }

  private matchingFailure(key: MediaServerSnapshotKey): Failure | undefined {
    const failure = this.failures.get(key.libraryId);
    if (!failure) return undefined;
    if (!sameKey(failure.key, key)) {
      this.failures.delete(key.libraryId);
      return undefined;
    }
    return failure;
  }

  private noteFailure(key: MediaServerSnapshotKey, error: MediaServerError): void {
    const previous = this.failures.get(key.libraryId);
    const count = (previous && sameKey(previous.key, key) ? previous.count : 0) + 1;
    const backoff = Math.min(this.limits.retryBaseMs * 2 ** (count - 1), this.limits.retryMaxMs);
    const rateLimited = error.code === "rate-limited" ? Math.min(Math.max(error.retryAfterMs ?? 0, 0), this.limits.rateLimitMaxMs) : 0;
    this.failures.delete(key.libraryId);
    this.failures.set(key.libraryId, { key: { ...key }, code: error.code, count, retryAt: this.clock() + Math.max(backoff, rateLimited) });
    while (this.failures.size > this.limits.maxFailures) {
      const oldest = this.failures.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
  }
}
