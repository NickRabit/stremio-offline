export interface MetaCacheOptions {
  /** Fresh time of an answer. Today 6 h. */
  ttlMs: number;
  /** Fresh time of a remembered failure. */
  failureTtlMs: number;
  /** Most entries held; the least recently used goes first. */
  limit: number;
  now?: () => number;
}

export interface MetaCache<V> {
  /** `{ hit: true, value }` for a fresh answer or a fresh remembered failure (value null),
   *  `{ hit: false }` otherwise. A read marks the entry as recently used. */
  get(key: string): { hit: true; value: V | null } | { hit: false };
  set(key: string, value: V): void;
  /** Remember that this key has no answer, for `failureTtlMs`. */
  fail(key: string): void;
  /** One lookup per key at a time: a caller asking while the key is already being looked up
   *  shares that lookup instead of starting another. */
  join(key: string, lookup: () => Promise<V | null>): Promise<V | null>;
  clear(): void;
  readonly size: number;
}

interface Entry<V> {
  value: V | null;
  at: number;
  failure: boolean;
}

/** Successful metadata lives for six hours, while a miss is held briefly so repeated Home
 *  requests do not ask the same dead title again; stale entries make room in least-used order. */
export function createMetaCache<V>(options: MetaCacheOptions): MetaCache<V> {
  const entries = new Map<string, Entry<V>>();
  const pending = new Map<string, Promise<V | null>>();
  const now = options.now ?? Date.now;

  const remember = (key: string, entry: Entry<V>): void => {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > options.limit) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return { hit: false };
      const ttl = entry.failure ? options.failureTtlMs : options.ttlMs;
      if (now() - entry.at >= ttl) {
        entries.delete(key);
        return { hit: false };
      }
      remember(key, entry);
      return { hit: true, value: entry.value };
    },
    set(key, value) {
      remember(key, { value, at: now(), failure: false });
    },
    fail(key) {
      remember(key, { value: null, at: now(), failure: true });
    },
    join(key, lookup) {
      const running = pending.get(key);
      if (running) return running;
      const work = lookup().finally(() => { pending.delete(key); });
      pending.set(key, work);
      return work;
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}
