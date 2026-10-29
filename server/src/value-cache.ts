interface Held<T> {
  expiresAt: number;
  value: T;
}

interface Pending<T> {
  promise: Promise<T>;
}

interface CacheOptions<T> {
  now?: () => number;
  maxEntries?: number;
  lookupTimeoutMs?: number;
  timeoutResult?: () => T;
}

/** A bounded freshness cache for a value that is cheap to reuse and potentially expensive to
 *  discover. Concurrent misses share one lookup, and a missing value is cached too: a completed
 *  download without artwork must not make every queue poll search the filesystem again. */
export class FreshValueCache<T> {
  private entries = new Map<string, Held<T> | Pending<T>>();
  private now: () => number;
  private maxEntries: number;
  private lookupTimeoutMs: number;
  private timeoutResult: () => T;

  constructor(private readonly ttlMs: number, options: CacheOptions<T> = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? 2048;
    this.lookupTimeoutMs = options.lookupTimeoutMs ?? ttlMs;
    this.timeoutResult = options.timeoutResult ?? (() => undefined as T);
  }

  get(key: string, load: () => Promise<T>): Promise<T> {
    this.prune();
    const held = this.entries.get(key);
    if (held) {
      if ("promise" in held) return held.promise;
      return Promise.resolve(held.value);
    }

    const loaded = Promise.resolve().then(load);
    let resolveResult!: (value: T) => void;
    let rejectResult!: (error: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const pending = { promise };
    this.entries.set(key, pending);
    const timer = setTimeout(() => {
      try { resolveResult(this.timeoutResult()); }
      catch { resolveResult(undefined as T); }
    }, this.lookupTimeoutMs);
    loaded.then(
      (value) => {
        clearTimeout(timer);
        if (this.entries.get(key) === pending) {
          this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
          this.trim();
        }
        resolveResult(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        if (this.entries.get(key) === pending) this.entries.delete(key);
        rejectResult(error);
      },
    );
    return promise;
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(): void {
    const now = this.now();
    for (const [key, held] of this.entries) {
      if (!("promise" in held) && held.expiresAt <= now) this.entries.delete(key);
    }
  }

  private trim(): void {
    if (this.entries.size <= this.maxEntries) return;
    for (const [key, held] of this.entries) {
      if ("promise" in held) continue;
      this.entries.delete(key);
      if (this.entries.size <= this.maxEntries) return;
    }
  }
}
