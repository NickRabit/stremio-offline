import { setImmediate as nextImmediate } from "node:timers";
import type { LibraryEntry } from "./library.js";
import { parseLibraryPath, posixBase } from "./libraries.js";
import { SEARCH_LIMITS, type SearchKindFilter, type StrongIds } from "./search-contracts.js";
import { enoughMatched, normalizeSearchText, prepareFields, prepareQuery, relevancePrepared, type PreparedFields } from "./search-relevance.js";

const emptyFields: PreparedFields = { tokens: [], bareTitles: [], titleWords: 0 };
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
  pathSegments: string[];
  /** The entry's text tokenised once at build, so a search only compares. */
  fields: PreparedFields;
  /** Set on a file listed inside a folder entry: the folder it belongs to. */
  parentKey?: string;
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
    const indexed = this.indexed;
    const generation = this.generation;
    if (normalizeSearchText(query) === "") return { generation, entries: [] };

    const prepared = prepareQuery(query);
    const matches: Array<{ entry: LibraryEntry; score: number; parentKey?: string }> = [];
    for (let start = 0; start < indexed.length; start += CHUNK_SIZE) {
      if (signal?.aborted) throw new SourceFailure("cancelled");
      const end = Math.min(indexed.length, start + CHUNK_SIZE);
      for (let index = start; index < end; index += 1) {
        const item = indexed[index]!;
        if (item.libraryId !== libraryId) continue;
        const type = item.entry.meta?.type;
        if (kind !== "all" && (type === "movie" || type === "series") && type !== kind) continue;
        const result = relevancePrepared(prepared, item.fields);
        const score = enoughMatched(result) ? result.score : undefined;
        if (score !== undefined) matches.push({ entry: item.entry, score, ...(item.parentKey === undefined ? {} : { parentKey: item.parentKey }) });
      }
      if (end < indexed.length) {
        await new Promise<void>((resolve) => nextImmediate(resolve));
      }
    }
    if (signal?.aborted) throw new SourceFailure("cancelled");
    // A file inside a folder is offered only when the folder itself did not answer: a show found
    // by its name is one card, not one more per episode file.
    const matchedFolders = new Set(matches.filter((match) => match.parentKey === undefined).map((match) => match.entry.key));
    const kept = matches.filter((match) => match.parentKey === undefined || !matchedFolders.has(match.parentKey));
    matches.length = 0;
    matches.push(...kept);
    matches.sort((left, right) =>
      right.score - left.score || (left.entry.key < right.entry.key ? -1 : left.entry.key > right.entry.key ? 1 : 0),
    );
    return {
      generation,
      entries: matches.slice(0, SEARCH_LIMITS.recordsPerSession).map((match) => match.entry),
    };
  }

  byIds(libraryId: string, ids: StrongIds, kind: "movie" | "series"): LibraryEntry[] {
    const targets = [
      ids.imdb === undefined ? undefined : ids.imdb.toLowerCase(),
      ids.tmdb === undefined ? undefined : `tmdb:${ids.tmdb}`,
      ids.tvdb === undefined ? undefined : `tvdb:${ids.tvdb}`,
    ].filter((value): value is string => value !== undefined);
    if (targets.length === 0) return [];
    const found: LibraryEntry[] = [];
    for (const item of this.indexed) {
      if (item.libraryId !== libraryId || item.entry.meta?.type !== kind) continue;
      const id = item.entry.meta.id.toLowerCase();
      if (!targets.includes(id)) continue;
      found.push(item.entry);
      if (found.length === 20) break;
    }
    return found;
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
      prepared.push({
        entry,
        libraryId: parsed.libraryId,
        titles: [...new Set([entry.meta?.name, entry.title].filter((title): title is string => title !== undefined && title.trim() !== ""))],
        pathSegments: parsed.relative
          .split("/")
          .map(normalizeSearchText)
          .filter((segment) => segment !== ""),
        fields: emptyFields,
      });
      const item = prepared[prepared.length - 1]!;
      const [title = "", originalTitle] = item.titles;
      item.fields = prepareFields({
        title,
        ...(originalTitle === undefined ? {} : { originalTitle }),
        path: item.pathSegments.join(" "),
      });
      // A folder of several files is one entry, so the names of the files inside it were never
      // searchable. Each file gets an item of its own, answering as a loose file of that library.
      if (entry.files.length > 1) {
        for (const file of entry.files) {
          const relative = file.path.startsWith(`${parsed.libraryId}/`) ? file.path.slice(parsed.libraryId.length + 1) : file.path;
          const key = `${parsed.libraryId}/${relative}`;
          const label = file.label.trim() !== "" ? file.label : posixBase(relative);
          const pathSegments = relative.split("/").map(normalizeSearchText).filter((segment) => segment !== "");
          prepared.push({
            entry: { key, kind: entry.kind, title: label, files: [file], size: file.size, modified: file.modified },
            libraryId: parsed.libraryId,
            titles: [label],
            pathSegments,
            fields: prepareFields({ title: label, path: pathSegments.join(" ") }),
            parentKey: entry.key,
          });
        }
      }
    }
    return prepared;
  }
}
