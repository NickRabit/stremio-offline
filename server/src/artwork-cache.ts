import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameWithRetry, syncDirectory } from "./fs-retry.js";
import { parseLibraryPath } from "./libraries.js";
import { log } from "./logger.js";
import { mapBounded } from "./map-bounded.js";
import type { AppDatabase, Statement } from "./storage/app-database.js";
import { moveToMigrationBackup } from "./storage/hourly-counts.js";
import { TrackedMap } from "./storage/tracked-map.js";

/**
 * The thumbnails this server generates itself -- a frame out of the video, or the
 * poster of the bound title -- live under `data/artwork/<libraryId>/`. A picture that
 * sits next to the media is the user's own: it never gets here, is never counted
 * against the ceiling and is never evicted.
 */

interface Entry {
  bytes: number;
  /** Written or last served; the oldest go first when the directory is over its cap. */
  at: number;
}

/** What happened to a picture asked to follow its key. `absent` is the ordinary case -- most
 *  items have no picture of their own -- and `failed` is the one worth saying out loud. */
export type ArtworkCarry = { carried: true } | { carried: false; reason: "absent" | "conflict" | "failed"; detail?: string };

const hash = (key: string) => createHash("sha1").update(key).digest("hex");
const STRUCTURAL_SAVE_MS = 2000;
const RETRY_SAVE_MS = 60_000;
const DOMAIN = "artwork";
const UPSERT = "INSERT INTO artwork_entries (key, bytes, at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET bytes = excluded.bytes, at = excluded.at";
const DELETE = "DELETE FROM artwork_entries WHERE key = ?";

export interface ArtworkSaveTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface ArtworkCacheOptions {
  saveTimers?: ArtworkSaveTimers;
  lstat?: typeof lstat;
}

const megabytes = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return (Number.isFinite(parsed) && parsed > 0 ? parsed : fallback) * 1024 * 1024;
};

/** How far below the cap a pass drops: the smaller of 8 MiB and 2% of the cap, at least one
 *  byte. A cache that stays above its cap evicts on every pass; the cap is the lever. */
function evictionFloor(cap: number): number {
  const margin = Math.min(8 * 1024 * 1024, Math.max(1, Math.floor(cap * 0.02)));
  return cap - margin;
}

export class ArtworkCache {
  private entries = new TrackedMap<string, Entry>();
  private storedBytes = 0;
  private database?: AppDatabase;
  private loaded = false;
  private timer?: unknown;
  private saveDue = 0;
  private dirty = false;
  private maintenance?: Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();
  private indexWrites: Promise<void> = Promise.resolve();
  private databaseWriteQueued = false;
  private indexText?: string;
  private recencyDirty = false;
  private recencyRevision = 0;
  private readonly saveTimers: ArtworkSaveTimers;
  private readonly lstatFile: typeof lstat;

  constructor(
    private dir = path.join(process.env.DATA_DIR ?? "/data", "artwork"),
    private cap = megabytes(process.env.ARTWORK_CACHE_MB, 256),
    options: ArtworkCacheOptions = {},
  ) {
    this.saveTimers = options.saveTimers ?? {
      set: (run, ms) => setTimeout(run, ms).unref(),
      clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
    };
    this.lstatFile = options.lstat ?? lstat;
  }

  private get indexFile() { return path.join(this.dir, "index.json"); }

  private setEntry(name: string, entry: Entry): void {
    const previous = this.entries.get(name);
    this.entries.set(name, entry);
    this.storedBytes += entry.bytes - (previous?.bytes ?? 0);
  }

  private deleteEntry(name: string): boolean {
    const previous = this.entries.get(name);
    if (!this.entries.delete(name)) return false;
    this.storedBytes -= previous?.bytes ?? 0;
    return true;
  }

  /** test seam */
  recountStoredBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.bytes;
    this.storedBytes = total;
    return total;
  }

  attachDatabase(database: AppDatabase): void {
    if (this.loaded) throw new Error("The artwork database must be attached before load.");
    this.database = database;
  }

  /** Where the thumbnail of a qualified key goes: the library is the directory, the rest
   *  is the hash of the library-relative key, `dir:` marking a folder so a file and a
   *  folder of the same name keep their own pictures. */
  file(key: string) {
    const folder = key.startsWith("dir:");
    const parsed = parseLibraryPath(folder ? key.slice(4) : key);
    if (!parsed) throw new Error(`An artwork key without a library: ${key}`);
    return path.join(this.dir, parsed.libraryId, `${hash(folder ? `dir:${parsed.relative}` : parsed.relative)}.jpg`);
  }

  /** The directory one library's generated thumbnails live in. */
  dirOf(libraryId: string) { return path.join(this.dir, libraryId); }

  /** Path as the index stores it, or undefined for a picture that is not ours. */
  private storedName(file: string) {
    const relative = path.relative(this.dir, file);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : undefined;
  }

  /** Last-use alone waits much longer than a structural change. A due structural write is only
   *  brought forward, never postponed by a later serve. */
  private save(delayMs = STRUCTURAL_SAVE_MS) {
    this.dirty = true;
    const due = Date.now() + delayMs;
    if (this.timer && this.saveDue <= due) return;
    if (this.timer) this.saveTimers.clear(this.timer);
    this.saveDue = due;
    this.timer = this.saveTimers.set(() => {
      this.timer = undefined;
      if (!this.dirty) return;
      this.dirty = false;
      void this.writeIndex();
    }, delayMs);
  }

  /** One write at a time: two would share the temporary file, and a rename could move the
   *  other's half-written bytes into place. A failed write is owed again. */
  private writeIndex() {
    if (this.database) return this.writeDatabaseIndex(this.database);
    const snapshot = this.entries.snapshot();
    const data = JSON.stringify(Object.fromEntries(this.entries));
    if (data === this.indexText) {
      this.entries.forget(snapshot);
      this.recencyDirty = false;
      return Promise.resolve();
    }
    const recencyRevision = this.recencyRevision;
    const run = this.indexWrites.then(async () => {
      const temp = `${this.indexFile}.tmp`;
      try {
        await writeFile(temp, data, { mode: 0o600 });
        await renameWithRetry(temp, this.indexFile);
        this.indexText = data;
        this.entries.forget(snapshot);
        if (this.recencyRevision === recencyRevision) this.recencyDirty = false;
      } catch (error) {
        this.dirty = true;
        this.save(RETRY_SAVE_MS);
        log("WARN", "The artwork cache index could not be saved", { reason: String(error).slice(0, 120) });
      }
    });
    this.indexWrites = run;
    return run;
  }

  private writeDatabaseIndex(database: AppDatabase): Promise<void> {
    if (this.databaseWriteQueued) return this.indexWrites;
    this.databaseWriteQueued = true;
    const run = this.indexWrites.catch(() => undefined).then(async () => {
      this.databaseWriteQueued = false;
      const snapshot = this.entries.snapshot();
      const statements: Statement[] = [];
      for (const key of snapshot.keys()) {
        const entry = this.entries.get(key);
        statements.push(entry
          ? { sql: UPSERT, params: [key, entry.bytes, entry.at] }
          : { sql: DELETE, params: [key] });
      }
      if (!statements.length) return;
      try {
        await database.batch(statements);
        this.entries.forget(snapshot);
        if (!this.entries.hasDirty()) this.recencyDirty = false;
      } catch (error) {
        this.dirty = true;
        this.save(RETRY_SAVE_MS);
        log("WARN", "The artwork cache index could not be saved", { reason: String(error).slice(0, 120) });
      }
    });
    this.indexWrites = run;
    return run;
  }

  async load() {
    await mkdir(this.dir, { recursive: true });
    this.loaded = true;
    if (this.database) {
      await this.loadDatabase(this.database);
      return;
    }
    let stored: Record<string, { at?: unknown }> = {};
    let raw: string | undefined;
    try {
      raw = await readFile(this.indexFile, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed as Record<string, { at?: unknown }>;
    } catch { stored = {}; }
    this.indexText = raw;
    // The index is rebuilt from what is actually on disk: a stored size is not trusted,
    // and anything the sweep took, or that was never recorded, is measured afresh.
    for (const name of [...this.entries.keys()]) this.deleteEntry(name);
    for (const library of await readdir(this.dir, { withFileTypes: true }).catch(() => [])) {
      if (!library.isDirectory()) continue;
      const candidates = (await readdir(path.join(this.dir, library.name), { withFileTypes: true }).catch(() => []))
        .filter((file) => file.isFile() && /^[0-9a-f]{40}\.jpg$/.test(file.name));
      const inspected = await mapBounded(candidates, 8, async (file) => ({
        file,
        info: await this.lstatFile(path.join(this.dir, library.name, file.name)).catch(() => undefined),
      }));
      for (const { file, info } of inspected) {
        const name = path.join(library.name, file.name);
        if (!info?.isFile()) continue;
        const prior = stored[name]?.at;
        const at = typeof prior === "number" && Number.isFinite(prior) && prior > 0 ? prior : info.mtimeMs;
        this.setEntry(name, { bytes: info.size, at });
      }
    }
    this.entries.forget(this.entries.snapshot());
    await this.writeIndex();
    await this.evict();
    this.recountStoredBytes();
  }

  async flush() {
    if (this.timer) { this.saveTimers.clear(this.timer); this.timer = undefined; }
    if (this.dirty || this.recencyDirty || this.entries.hasDirty()) { this.dirty = false; await this.writeIndex(); }
    await this.indexWrites;
    if (this.dirty || this.recencyDirty || this.entries.hasDirty()) { this.dirty = false; await this.writeIndex(); }
  }

  /** The thumbnails on disk, and which library folders were read completely. A folder whose
   *  listing or a file's lstat failed for any reason other than the file being gone is not
   *  complete: its rows are kept as they are, because a failed read says nothing about which
   *  thumbnails are really missing. */
  private async scanFiles(): Promise<{ files: Map<string, { size: number; mtimeMs: number }>; complete: Set<string> | undefined }> {
    const files = new Map<string, { size: number; mtimeMs: number }>();
    let libraries;
    try {
      libraries = await readdir(this.dir, { withFileTypes: true });
    } catch {
      return { files, complete: undefined };
    }
    const complete = new Set<string>();
    for (const library of libraries) {
      if (!library.isDirectory()) continue;
      let entries;
      try {
        entries = await readdir(path.join(this.dir, library.name), { withFileTypes: true });
      } catch {
        continue;
      }
      let whole = true;
      const candidates = entries.filter((file) => file.isFile() && /^[0-9a-f]{40}\.jpg$/.test(file.name));
      const inspected = await mapBounded(candidates, 8, async (file) => {
        const name = path.join(library.name, file.name);
        try {
          return { name, info: await this.lstatFile(path.join(this.dir, name)) };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") whole = false;
          return { name, info: undefined };
        }
      });
      for (const { name, info } of inspected) {
        if (info?.isFile()) files.set(name, { size: info.size, mtimeMs: info.mtimeMs });
      }
      if (whole) complete.add(library.name);
    }
    return { files, complete };
  }

  /** Whether a stored key may be dropped for not being on disk: only inside a folder that was
   *  read completely, or a library folder that no longer exists in a root that was listed. */
  private static settled(key: string, complete: Set<string> | undefined, listed: Set<string>): boolean {
    if (!complete) return false;
    const library = key.split(/[\\/]/)[0] ?? "";
    return complete.has(library) || !listed.has(library);
  }

  private async loadDatabase(database: AppDatabase): Promise<void> {
    const marker = await database.get("SELECT value FROM meta WHERE key = ?", [`domain.${DOMAIN}`]);
    const { files, complete } = await this.scanFiles();
    const listed = new Set(complete ? (await readdir(this.dir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name) : []);
    const importedAt = Date.now();
    const statements: Statement[] = [];

    if (marker) {
      const rows = await database.all<{ key: string; bytes: number; at: number }>(
        "SELECT key, bytes, at FROM artwork_entries",
      );
      const stored = new Map(rows.map((row) => [row.key, row]));
      // The one scan above is the only look at the disk: a thumbnail removed after it is simply
      // missing later, never a second lstat that could reject and abort the start.
      for (const [name, { size: bytes, mtimeMs }] of files) {
        const row = stored.get(name);
        const validAt = row && Number.isFinite(row.at) && row.at > 0;
        this.setEntry(name, { bytes, at: validAt ? row.at : mtimeMs });
        if (!validAt || row.bytes !== bytes) {
          statements.push({ sql: UPSERT, params: [name, bytes, validAt ? row.at : mtimeMs] });
        }
      }
      for (const [key, row] of stored) {
        if (files.has(key)) continue;
        if (ArtworkCache.settled(key, complete, listed)) {
          statements.push({ sql: DELETE, params: [key] });
        } else if (Number.isFinite(row.at) && row.at > 0) {
          // Not read this time: keep what the row knows rather than forget its recency.
          this.setEntry(key, { bytes: row.bytes, at: row.at });
        }
      }
    } else {
      if (!complete) {
        // The thumbnail folder could not be listed at all: importing now would record no
        // thumbnails and move the index (and its recency) aside. The import waits for a start
        // that can read the folder.
        log("WARN", "The artwork folder could not be read, the index import waits for the next start", { dir: this.dir });
        this.recountStoredBytes();
        return;
      }
      let stored: Record<string, { at?: unknown }> = {};
      try {
        const parsed: unknown = JSON.parse(await readFile(this.indexFile, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          stored = parsed as Record<string, { at?: unknown }>;
        }
      } catch {
        stored = {};
      }
      for (const [name, { size: bytes, mtimeMs }] of files) {
        const prior = stored[name]?.at;
        const at = typeof prior === "number" && Number.isFinite(prior) && prior > 0
          ? prior
          : mtimeMs;
        this.setEntry(name, { bytes, at });
        statements.push({ sql: UPSERT, params: [name, bytes, at] });
      }
      statements.push({
        sql: "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params: [`domain.${DOMAIN}`, JSON.stringify({
          importedAt,
          source: path.basename(this.indexFile),
          count: files.size,
        })],
      });
    }

    const snapshot = this.entries.snapshot();
    if (statements.length) await database.batch(statements);
    this.entries.forget(snapshot);
    await moveToMigrationBackup(
      this.indexFile,
      path.dirname(database.info.file),
      `artwork-index-${importedAt}.json`,
    );
    await this.evict();
    this.recountStoredBytes();
  }

  /** Removals run one at a time: each candidate is a snapshot, and two passes must never
   *  interleave the read of an entry with its removal. */
  private exclusively<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** One explicit pass over the ceiling; never throws, and concurrent calls share the run. */
  maintain(): Promise<void> {
    if (!this.maintenance) {
      this.maintenance = this.evict().then(
        () => undefined,
        (error) => { log("WARN", "Artwork cache maintenance failed", { reason: String(error).slice(0, 120) }); },
      ).finally(() => { this.maintenance = undefined; });
    }
    return this.maintenance;
  }

  /** A thumbnail just landed in the cache. */
  async written(file: string) {
    const name = this.storedName(file);
    if (!name) return;
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) return;
    this.setEntry(name, { bytes: info.size, at: Date.now() });
    this.save();
    await this.evict();
  }

  /** A thumbnail whose key changed is the same picture in a new place: the index entry has
   *  to follow, or the ceiling counts bytes that are no longer there and the sweep deletes
   *  the wrong file. */
  async moved(from: string, to: string) {
    const name = this.storedName(from);
    if (name) { this.deleteEntry(name); this.save(); }
    await this.written(to);
  }

  moveKey(from: string, to: string): Promise<ArtworkCarry> {
    return this.carryKey(from, to, true);
  }

  copyKey(from: string, to: string): Promise<ArtworkCarry> {
    return this.carryKey(from, to, false);
  }

  private async carryKey(from: string, to: string, move: boolean): Promise<ArtworkCarry> {
    const source = this.file(from), target = this.file(to);
    if (source === target) return { carried: true };
    const conflict = { carried: false, reason: "conflict" } as const;
    try {
      const original = await this.lstatFile(source, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!original) return { carried: false, reason: "absent" };
      if (!original.isFile()) return conflict;
      const data = await readFile(source);
      const dir = path.dirname(target);
      if (await mkdir(dir, { recursive: true })) await syncDirectory(path.dirname(dir));
      await copyFile(source, target, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const published = await this.lstatFile(target, { bigint: true });
      if (!published.isFile()) return conflict;
      const handle = await open(target, process.platform === "win32" ? "r+" : "r");
      try {
        if (!(await handle.readFile()).equals(data)) return conflict;
        await handle.sync();
      } finally { await handle.close(); }
      await syncDirectory(dir);
      const unchanged = (a: typeof original, b: typeof original) =>
        a.dev === b.dev && a.ino === b.ino && a.ctimeNs === b.ctimeNs && a.size === b.size;
      if (!unchanged(published, await this.lstatFile(target, { bigint: true })) ||
          !unchanged(original, await this.lstatFile(source, { bigint: true }))) return conflict;
      if (move) {
        await rm(source);
        await this.moved(source, target);
      } else await this.written(target);
      return { carried: true };
    } catch (error) {
      return { carried: false, reason: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /** A thumbnail the server deleted. Without this the entry's bytes keep counting against the
   *  ceiling, and the next eviction drops a live picture to make room for nothing. */
  async removed(file: string) {
    const name = this.storedName(file);
    if (!name || !this.deleteEntry(name)) return;
    this.save();
  }

  /** Every entry under a directory the server removed with its library. */
  async removedTree(directory: string) {
    const prefix = this.storedName(directory);
    if (prefix === undefined) return;
    let dropped = 0;
    for (const name of [...this.entries.keys()]) {
      if (name !== prefix && !name.startsWith(`${prefix}${path.sep}`)) continue;
      this.deleteEntry(name);
      dropped += 1;
    }
    if (!dropped) return;
    log("DEBUG", "Artwork cache entries dropped with their directory", { directory, dropped });
    this.save();
  }

  /** Serving refreshes an entry in memory, so a picture somebody keeps looking at is not the
   *  first one dropped. The next structural write or shutdown records the new order. */
  async served(file: string) {
    const name = this.storedName(file);
    if (!name) return;
    const known = this.entries.get(name);
    const info = known ? undefined : await stat(file).catch(() => undefined);
    if (known) this.setEntry(name, { bytes: known.bytes, at: Date.now() });
    else if (info?.isFile()) this.setEntry(name, { bytes: info.size, at: Date.now() });
    else return;
    this.recencyDirty = true;
    this.recencyRevision += 1;
  }

  /** A thumbnail served from the memory in front of this cache: the index entry is refreshed
   *  the same way a serve does, without the debounced write. A picture that is not indexed --
   *  one sitting next to its media -- is not this cache's business. */
  touch(file: string): void {
    const name = this.storedName(file);
    if (!name) return;
    const known = this.entries.get(name);
    if (!known) return;
    this.setEntry(name, { bytes: known.bytes, at: Date.now() });
    this.recencyDirty = true;
    this.recencyRevision += 1;
  }

  /** Every indexed file as an absolute path, newest `at` first. Bodies are not read here. */
  hotFiles(): Array<{ file: string; at: number }> {
    return [...this.entries.entries()]
      .map(([name, entry]) => ({ file: path.join(this.dir, name), at: entry.at }))
      .sort((left, right) => right.at - left.at);
  }

  private evictionGuard?: (file: string) => boolean;
  protectFromEviction(guard: (file: string) => boolean): void {
    this.evictionGuard = guard;
  }

  private evict(): Promise<void> { return this.exclusively(() => this.evictOnce()); }

  /** Oldest first, down to `evictionFloor(cap)` so this does not run on every write. */
  private async evictOnce() {
    let total = this.storedBytes;
    if (total <= this.cap) return;
    const stored = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at);
    const target = evictionFloor(this.cap);
    let removed = 0;
    for (const [name, snapshot] of stored) {
      if (total <= target) break;
      const current = this.entries.get(name);
      // Served or rewritten between the snapshot and now: leave it for the next pass.
      if (!current || current.at !== snapshot.at || current.bytes !== snapshot.bytes) continue;
      const file = path.join(this.dir, name);
      try {
        await stat(file);
      } catch (error) {
        // The file is already gone, so the entry only has to stop counting.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.deleteEntry(name); total -= current.bytes; removed += 1; }
        continue;
      }
      if (this.evictionGuard?.(file)) continue;
      try {
        await rm(file, { force: true });
      } catch (error) {
        log("WARN", "A cached thumbnail could not be removed", { reason: String(error).slice(0, 120) });
        continue;
      }
      this.deleteEntry(name);
      total -= current.bytes;
      removed += 1;
    }
    if (removed) {
      log("INFO", "Cached thumbnails dropped to stay under the limit", { removed });
    }
    if (removed || !this.database) this.save();
  }

  get size() { return this.entries.size; }
}

export const artworks = new ArtworkCache();
