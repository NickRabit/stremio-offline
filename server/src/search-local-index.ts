import { setImmediate as nextImmediate } from "node:timers";
import { normalizeTitle } from "./library-match.js";
import type { LibraryEntry } from "./library.js";
import { parseLibraryPath, posixBase } from "./libraries.js";
import { SEARCH_LIMITS, type SearchKindFilter } from "./search-contracts.js";
import { SourceFailure } from "./search-session.js";

interface TimerApi {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface LocalSearchIndexDeps {
  entries(): Promise<LibraryEntry[]>;
  now?: () => number;
  timers?: TimerApi;
  debounceMs?: number;
}

export interface LocalSearchIndexState {
  generation: number;
  ready: boolean;
  stale: boolean;
  building: boolean;
  failed: boolean;
}

interface IndexedEntry {
  entry: LibraryEntry;
  libraryId: string;
  titles: string[];
  name: string;
}

const CHUNK_SIZE = 5_000;

export class LocalSearchIndex {
  private readonly deps: LocalSearchIndexDeps;
  private readonly timers: TimerApi;
  private readonly debounceMs: number;
  private readonly listeners = new Set<() => void>();
  private indexed: IndexedEntry[] = [];
  private generation = 0;
  private ready = false;
  private stale = false;
  private building = false;
  private failed = false;
  private closed = false;
  private invalidations = 0;
  private rerun = false;
  private debounceTimer: unknown;

  constructor(deps: LocalSearchIndexDeps) {
    this.deps = deps;
    this.debounceMs = deps.debounceMs ?? 2_000;
    this.timers = deps.timers ?? {
      setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
    };
  }

  start(): void {
    if (this.closed) return;
    if (this.debounceTimer !== undefined) {
      this.timers.clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    void this.build();
  }

  markDirty(): void {
    if (this.closed) return;
    this.invalidations += 1;
    this.stale = true;
    if (this.debounceTimer !== undefined) this.timers.clearTimeout(this.debounceTimer);
    this.debounceTimer = this.timers.setTimeout(() => {
      this.debounceTimer = undefined;
      void this.build();
    }, this.debounceMs);
    const timer = this.debounceTimer as { unref?: () => void } | undefined;
    timer?.unref?.();
  }

  state(): LocalSearchIndexState {
    return {
      generation: this.generation,
      ready: this.ready,
      stale: this.stale,
      building: this.building,
      failed: this.failed,
    };
  }

  async search(
    libraryId: string,
    query: string,
    kind: SearchKindFilter,
    signal?: AbortSignal,
  ): Promise<{ generation: number; entries: LibraryEntry[] }> {
    if (signal?.aborted) throw new SourceFailure("cancelled");
    const normalizedQuery = normalizeTitle(query);
    const indexed = this.indexed;
    const generation = this.generation;
    if (normalizedQuery === "") return { generation, entries: [] };

    const matches: Array<{ entry: LibraryEntry; score: number }> = [];
    for (let start = 0; start < indexed.length; start += CHUNK_SIZE) {
      if (signal?.aborted) throw new SourceFailure("cancelled");
      const end = Math.min(indexed.length, start + CHUNK_SIZE);
      for (let index = start; index < end; index += 1) {
        const item = indexed[index]!;
        if (item.libraryId !== libraryId) continue;
        const type = item.entry.meta?.type;
        if (kind !== "all" && (type === "movie" || type === "series") && type !== kind) continue;
        const score = this.score(item, normalizedQuery);
        if (score !== undefined) matches.push({ entry: item.entry, score });
      }
      if (end < indexed.length) {
        await new Promise<void>((resolve) => nextImmediate(resolve));
      }
    }
    if (signal?.aborted) throw new SourceFailure("cancelled");
    matches.sort((left, right) =>
      left.score - right.score || (left.entry.key < right.entry.key ? -1 : left.entry.key > right.entry.key ? 1 : 0),
    );
    return {
      generation,
      entries: matches.slice(0, SEARCH_LIMITS.recordsPerSession).map((match) => match.entry),
    };
  }

  onReady(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.debounceTimer !== undefined) {
      this.timers.clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.listeners.clear();
  }

  private score(entry: IndexedEntry, query: string): number | undefined {
    let best: number | undefined;
    for (const title of entry.titles) {
      if (title === query) return 0;
      if (title.startsWith(query)) best = best === undefined ? 1 : Math.min(best, 1);
      else if (title.includes(query)) best = best === undefined ? 2 : Math.min(best, 2);
    }
    if (best !== undefined) return best;
    return entry.name.includes(query) ? 3 : undefined;
  }

  private async build(): Promise<void> {
    if (this.closed) return;
    if (this.building) {
      this.rerun = true;
      return;
    }
    this.building = true;
    this.rerun = false;
    const invalidations = this.invalidations;
    let published = false;
    try {
      const entries = await this.deps.entries();
      if (this.closed) return;
      if (invalidations === this.invalidations) {
        this.indexed = this.prepare(entries);
        this.generation += 1;
        this.ready = true;
        this.stale = false;
        this.failed = false;
        published = true;
      }
    } catch {
      if (!this.closed) this.failed = true;
    } finally {
      this.building = false;
    }
    if (published) {
      for (const listener of [...this.listeners]) {
        try { listener(); } catch { /* a subscriber cannot stop a publish */ }
      }
    }
    if (this.rerun && !this.closed) {
      this.rerun = false;
      void this.build();
    }
  }

  private prepare(entries: LibraryEntry[]): IndexedEntry[] {
    const prepared: IndexedEntry[] = [];
    for (const entry of entries) {
      const parsed = parseLibraryPath(entry.key);
      if (!parsed) continue;
      const titles = [normalizeTitle(entry.meta?.name), normalizeTitle(entry.title)]
        .filter((title) => title !== "");
      prepared.push({
        entry,
        libraryId: parsed.libraryId,
        titles,
        name: normalizeTitle(posixBase(entry.key)),
      });
    }
    return prepared;
  }
}
