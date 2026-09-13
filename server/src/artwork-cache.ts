import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseLibraryPath } from "./libraries.js";
import { log } from "./logger.js";

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

const hash = (key: string) => createHash("sha1").update(key).digest("hex");

const megabytes = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return (Number.isFinite(parsed) && parsed > 0 ? parsed : fallback) * 1024 * 1024;
};

export class ArtworkCache {
  private entries = new Map<string, Entry>();
  private timer?: NodeJS.Timeout;
  private dirty = false;

  constructor(
    private dir = path.join(process.env.DATA_DIR ?? "/data", "artwork"),
    private cap = megabytes(process.env.ARTWORK_CACHE_MB, 256),
  ) {}

  private get indexFile() { return path.join(this.dir, "index.json"); }

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

  private save() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.dirty) return;
      this.dirty = false;
      void this.writeIndex();
    }, 2000);
    this.timer.unref?.();
  }

  private async writeIndex() {
    const temp = `${this.indexFile}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(Object.fromEntries(this.entries)), { mode: 0o600 });
      await rename(temp, this.indexFile);
    } catch (error) {
      log("WARN", "The artwork cache index could not be saved", { reason: String(error).slice(0, 120) });
    }
  }

  async load() {
    await mkdir(this.dir, { recursive: true });
    let stored: Record<string, Entry> = {};
    try { stored = JSON.parse(await readFile(this.indexFile, "utf8")) as Record<string, Entry>; }
    catch { stored = {}; }
    // A size is needed to enforce the ceiling, so an entry from before the index, or one
    // whose file the sweep took, is dropped rather than trusted.
    for (const [name, entry] of Object.entries(stored)) {
      const info = await stat(path.join(this.dir, name)).catch(() => undefined);
      if (info?.isFile()) this.entries.set(name, { bytes: entry?.bytes || info.size, at: entry?.at || Date.now() });
    }
  }

  async flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.dirty) { this.dirty = false; await this.writeIndex(); }
  }

  /** A thumbnail just landed in the cache. */
  async written(file: string) {
    const name = this.storedName(file);
    if (!name) return;
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) return;
    this.entries.set(name, { bytes: info.size, at: Date.now() });
    this.save();
    await this.evict();
  }

  /** A thumbnail whose key changed is the same picture in a new place: the index entry has
   *  to follow, or the ceiling counts bytes that are no longer there and the sweep deletes
   *  the wrong file. */
  async moved(from: string, to: string) {
    const name = this.storedName(from);
    if (name) { this.entries.delete(name); this.save(); }
    await this.written(to);
  }

  /** Serving refreshes an entry, so a picture somebody keeps looking at is not the first
   *  one dropped. The index write itself is debounced, like every other write here. */
  async served(file: string) {
    const name = this.storedName(file);
    if (!name) return;
    const known = this.entries.get(name);
    const info = known ? undefined : await stat(file).catch(() => undefined);
    if (known) this.entries.set(name, { bytes: known.bytes, at: Date.now() });
    else if (info?.isFile()) this.entries.set(name, { bytes: info.size, at: Date.now() });
    else return;
    this.save();
  }

  /** Oldest first, down to four fifths of the cap so this does not run on every write. */
  private async evict() {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.bytes;
    if (total <= this.cap) return;
    const stored = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at);
    const target = this.cap * 0.8;
    let removed = 0;
    for (const [name, entry] of stored) {
      if (total <= target) break;
      await rm(path.join(this.dir, name), { force: true });
      this.entries.delete(name);
      total -= entry.bytes;
      removed += 1;
    }
    if (removed) log("INFO", "Cached thumbnails dropped to stay under the limit", { removed });
    this.save();
  }

  get size() { return this.entries.size; }
}

export const artworks = new ArtworkCache();
