import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "./fs-retry.js";
import { log } from "./logger.js";
import { preserveDamaged, readStateFile } from "./state-file.js";

/** One library file the app has seen, stamped the first time a complete walk met it. `baseline`
 *  marks a file that predates the index: the app cannot say when it was added, so it never
 *  reaches the row. */
export interface SeenFile {
  at: string;
  baseline?: true;
  size: number;
  mtimeMs: number;
}

export interface SeenLibrary {
  /** The moment of the first complete walk: the whole library is at least this old. */
  baselineAt: string;
  /** Keyed by the path inside the library. */
  files: Record<string, SeenFile>;
}

/** Keyed by library id. */
export interface SeenState {
  version: 1;
  libraries: Record<string, SeenLibrary>;
}

/** One file of a complete walk, as `FoundFile` hands it over. */
export interface SeenWalkFile {
  relative: string;
  size: number;
  modified: string | number;
}

export interface RecentSeen {
  libraryId: string;
  relative: string;
  at: string;
}

/** A burst of walks shares one write; long enough to coalesce the sweep and a completion,
 *  short enough that Home is truthful after a drop-in. */
const SAVE_DEBOUNCE_MS = 300;

const emptyState = (): SeenState => ({ version: 1, libraries: {} });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const parseFile = (value: unknown): SeenFile | undefined => {
  if (!isRecord(value)) return undefined;
  const { at, baseline, size, mtimeMs } = value;
  if (typeof at !== "string" || typeof size !== "number" || typeof mtimeMs !== "number") return undefined;
  return { at, ...(baseline === true ? { baseline: true as const } : {}), size, mtimeMs };
};

/** A file of any other version, or a shape the model does not recognise, is not read: the
 *  caller copies it aside and starts empty rather than failing the boot. */
const parseState = (raw: unknown): SeenState => {
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.libraries)) throw new Error("not a version 1 seen file");
  const libraries: Record<string, SeenLibrary> = {};
  for (const [libraryId, value] of Object.entries(raw.libraries)) {
    if (!isRecord(value) || typeof value.baselineAt !== "string" || !isRecord(value.files)) throw new Error("a seen library is malformed");
    const files: Record<string, SeenFile> = {};
    for (const [relative, entry] of Object.entries(value.files)) {
      const parsed = parseFile(entry);
      if (!parsed) throw new Error("a seen file entry is malformed");
      files[relative] = parsed;
    }
    libraries[libraryId] = { baselineAt: value.baselineAt, files };
  }
  return { version: 1, libraries };
};

/** `FoundFile.modified` is an ISO string, a download's `stats.mtimeMs` is a number; both end up
 *  as epoch milliseconds so a move can be recognised by the same fingerprint. */
const mtimeOf = (modified: string | number): number => {
  const value = typeof modified === "number" ? modified : Date.parse(modified);
  return Number.isFinite(value) ? value : 0;
};

const fingerprint = (size: number, mtimeMs: number) => `${size}:${mtimeMs}`;

/**
 * The first time the app saw each library file. A file's own modification time is a claim about
 * the bytes, not about when the app met them: a re-copy, a re-encode or a fresh install would
 * all read as news. Only a complete walk may speak for the tree it did not cover.
 */
export class LibrarySeenStore {
  private state: SeenState = emptyState();
  private readonly file: string;
  private timer?: NodeJS.Timeout;
  private dirty = false;
  private chain: Promise<void> = Promise.resolve();
  /** Kept when a file could not be read or copied aside: a later write must not cover bytes the
   *  owner may still be able to recover. */
  private protected = false;

  constructor(dataDir = process.env.DATA_DIR ?? "/data") {
    this.file = path.join(dataDir, "library-seen.json");
  }

  async load(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const read = await readStateFile(this.file);
    if (read.kind === "absent") {
      this.state = emptyState();
      return;
    }
    if (read.kind === "unreadable") {
      this.protected = true;
      this.state = emptyState();
      log("WARN", "The first-seen index could not be read, it starts empty", { file: this.file, reason: read.error instanceof Error ? read.error.message : String(read.error) });
      return;
    }
    try {
      this.state = parseState(JSON.parse(read.raw));
    } catch (error) {
      this.state = emptyState();
      try {
        const preserved = await preserveDamaged(this.file, read.raw);
        log("WARN", "The first-seen index was damaged, it was copied aside and starts empty", { file: path.basename(preserved), reason: String(error).slice(0, 120) });
      } catch (preserveError) {
        this.protected = true;
        log("WARN", "The first-seen index was damaged and could not be copied aside, it starts empty", { file: this.file, reason: String(preserveError).slice(0, 120) });
      }
    }
  }

  /** One complete walk of one library. The first stamps everything as the baseline; a later
   *  walk stamps what is new, carries a fingerprint across a move, and drops what is gone. */
  observe(libraryId: string, files: SeenWalkFile[], now: Date): void {
    if (!libraryId) return;
    const at = now.toISOString();
    const existing = this.state.libraries[libraryId];
    if (!existing) {
      const map: Record<string, SeenFile> = {};
      for (const file of files) map[file.relative] = { at, baseline: true, size: file.size, mtimeMs: mtimeOf(file.modified) };
      this.state.libraries[libraryId] = { baselineAt: at, files: map };
      this.markDirty();
      return;
    }
    const present = new Set(files.map((file) => file.relative));
    // The vanished entries are the move candidates, grouped by the fingerprint a new path has
    // to match. Several candidates for one fingerprint make the match ambiguous, so it is new.
    const vanished = new Map<string, string[]>();
    for (const [relative, file] of Object.entries(existing.files)) {
      if (present.has(relative)) continue;
      const key = fingerprint(file.size, file.mtimeMs);
      const bucket = vanished.get(key);
      if (bucket) bucket.push(relative); else vanished.set(key, [relative]);
    }
    const claimed = new Set<string>();
    const next: Record<string, SeenFile> = {};
    for (const file of files) {
      const mtimeMs = mtimeOf(file.modified);
      const known = existing.files[file.relative];
      if (known) {
        next[file.relative] = { ...known, size: file.size, mtimeMs };
        continue;
      }
      const candidates = (vanished.get(fingerprint(file.size, mtimeMs)) ?? []).filter((path) => !claimed.has(path));
      if (candidates.length === 1) {
        const source = candidates[0]!;
        claimed.add(source);
        next[file.relative] = existing.files[source]!;
        continue;
      }
      next[file.relative] = { at, size: file.size, mtimeMs };
    }
    this.state.libraries[libraryId] = { baselineAt: existing.baselineAt, files: next };
    this.markDirty();
  }

  /** Stamps one file the moment it lands, for a download that completed between two walks. A
   *  no-op before the library has a baseline or when the path is already known. */
  add(libraryId: string, relative: string, size: number, mtimeMs: number, now: Date): void {
    if (!libraryId || !relative) return;
    const library = this.state.libraries[libraryId];
    if (!library || library.files[relative]) return;
    library.files[relative] = { at: now.toISOString(), size, mtimeMs };
    this.markDirty();
  }

  /** The non-baseline entries of the named libraries, newest first, then by path. */
  recent(libraryIds: string[], limit: number): RecentSeen[] {
    const wanted = new Set(libraryIds);
    const entries: RecentSeen[] = [];
    for (const [libraryId, library] of Object.entries(this.state.libraries)) {
      if (!wanted.has(libraryId)) continue;
      for (const [relative, file] of Object.entries(library.files)) {
        if (file.baseline) continue;
        entries.push({ libraryId, relative, at: file.at });
      }
    }
    entries.sort((left, right) =>
      right.at.localeCompare(left.at) || left.relative.localeCompare(right.relative) || left.libraryId.localeCompare(right.libraryId));
    return entries.slice(0, Math.max(0, limit));
  }

  /** Only an explicit forget reaches here. Removing without forgetting keeps the data, the way
   *  it keeps a library's artwork and match history. */
  async forget(libraryId: string): Promise<void> {
    if (!this.state.libraries[libraryId]) return;
    delete this.state.libraries[libraryId];
    this.markDirty();
    await this.flush();
  }

  /** Called on shutdown and before a forget, so nothing is lost to the debounce. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const next = this.chain.then(() => this.write());
    this.chain = next.catch(() => undefined);
    await next;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer) return;
    const timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, SAVE_DEBOUNCE_MS);
    timer.unref?.();
    this.timer = timer;
  }

  private async write(): Promise<void> {
    if (!this.dirty) return;
    if (this.protected) {
      this.dirty = false;
      log("WARN", "The first-seen index was not saved over a file that could not be read or copied aside", { file: this.file });
      return;
    }
    this.dirty = false;
    try {
      const temp = `${this.file}.tmp`;
      await writeFile(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      await renameWithRetry(temp, this.file);
    } catch (error) {
      log("WARN", "The first-seen index could not be saved", { file: this.file, reason: String(error).slice(0, 200) });
    }
  }
}
