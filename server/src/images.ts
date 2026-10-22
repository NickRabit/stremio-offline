import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { renameWithRetry } from "./fs-retry.js";
import { log } from "./logger.js";
import { ffmpegPath } from "./media-tools.js";
import { guardedFetch } from "./outbound.js";
import { secureMode } from "./secure.js";
import type { MetaItem } from "./types.js";

/**
 * Artwork from addons -- posters, backdrops, logos, episode stills -- used to be
 * loaded by the browser straight from the provider's CDN. That hands every guest's
 * address, and the title they are looking at, to a third party, and on a managed
 * machine the request shows up in somebody's proxy log. Here the server fetches the
 * image once, caches it on disk and hands the page an opaque id, so the original
 * address never leaves this process: not in the payload, not in the image link.
 */

const PREFIX = "/api/image/";
const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const TILE_WIDTH = 640;
const DETAIL_WIDTH = 1920;
const FFMPEG_TIMEOUT_MS = 15_000;

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp",
  "image/gif": "gif", "image/avif": "avif", "image/bmp": "bmp", "image/svg+xml": "svg",
};
const TYPES: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml" };

/** Only the host goes into the log; the address itself is what this module hides. */
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return "?"; } };

const METAHUB_HOST = "images.metahub.space";
const WIDE_SIZES = new Set(["medium", "large"]);

/**
 * Metahub serves the same picture under several widths, and /medium/ is megabytes
 * where the grid wants a tile. Only a background is narrowed: the detail page shows
 * that field behind a gradient, while a poster has to stay readable.
 */
export function narrowArtwork(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return url; }
  if (parsed.host !== METAHUB_HOST) return url;
  const segments = parsed.pathname.split("/");
  for (let index = 1; index < segments.length - 1; index += 1) {
    if (segments[index] !== "background" || !WIDE_SIZES.has(segments[index + 1]!)) continue;
    segments[index + 1] = "small";
    parsed.pathname = segments.join("/");
    return parsed.toString();
  }
  return url;
}

export const imageId = (url: string) => createHash("sha256").update(url).digest("base64url").slice(0, 32);
export const isProxiedImage = (value: string) => value.startsWith(PREFIX);

/** Two widths exist: the listing tile and the wider detail backdrop. Anything else is the
 *  listing width, so a stored id can never name a size this cache does not serve. */
const artworkWidth = (width: number) => (width === DETAIL_WIDTH ? DETAIL_WIDTH : TILE_WIDTH);

/** The listing id stays the plain hash of the address; a wider variant mixes the width in, so
 *  the two never share a cache entry and a cached tile is never handed back as a backdrop. */
const idFor = (url: string, width: number) => (width === TILE_WIDTH ? imageId(url) : imageId(`${width}\n${url}`));

const jpegWidth = (data: Buffer) => {
  let offset = 2;
  while (offset + 9 <= data.length) {
    if (data[offset] !== 0xff) { offset += 1; continue; }
    const marker = data[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = data.readUInt16BE(offset + 2);
    if (length < 2) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return data.readUInt16BE(offset + 7);
    offset += 2 + length;
  }
  return undefined;
};

/** Pixel width out of the file header, or undefined for a format this does not read. */
function imageWidth(data: Buffer): number | undefined {
  if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47 && data.toString("latin1", 12, 16) === "IHDR") return data.readUInt32BE(16);
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) return jpegWidth(data);
  if (data.length >= 30 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") {
    const chunk = data.toString("latin1", 12, 16);
    if (chunk === "VP8X") return data.readUIntLE(24, 3) + 1;
    if (chunk === "VP8 ") return data.readUInt16LE(26) & 0x3fff;
    if (chunk === "VP8L") return (data.readUInt16LE(21) & 0x3fff) + 1;
    return undefined;
  }
  if (data.length >= 26 && data[0] === 0x42 && data[1] === 0x4d) return Math.abs(data.readInt32LE(18));
  return undefined;
}

interface Entry {
  url: string;
  /** Set once the bytes are on disk; the file is `<id>.<ext>`. */
  ext?: string;
  bytes?: number;
  /** The wider detail backdrop; absent means the listing tile. */
  width?: number;
  at: number;
}

export interface CachedImage { file: string; type: string; etag: string }

const megabytes = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return (Number.isFinite(parsed) && parsed > 0 ? parsed : fallback) * 1024 * 1024;
};

/** Unlike `megabytes`, an explicit `0` is honoured: it turns the memory layer off. */
const memoryMegabytes = (value: string | undefined, fallback: number) => {
  const text = value?.trim();
  const parsed = Number(text);
  return (!text || !Number.isFinite(parsed) || parsed < 0 ? fallback : parsed) * 1024 * 1024;
};

/** How far below the cap a pass drops: the smaller of 8 MiB and 2% of the cap, at least one
 *  byte. A cache that stays above its cap evicts on every pass; the cap is the lever. */
function evictionFloor(cap: number): number {
  const margin = Math.min(8 * 1024 * 1024, Math.max(1, Math.floor(cap * 0.02)));
  return cap - margin;
}

/** `0`, the default, keeps the cache on its cap alone. */
const days = (value: string | undefined) => {
  const parsed = Number(value);
  return (Number.isFinite(parsed) && parsed > 0 ? parsed : 0) * 24 * 60 * 60 * 1000;
};

/**
 * How long an unused link is kept before it is forgotten. Unlike `days()` an
 * unset or empty value is 90 days rather than "off"; `0` is the only way to keep links forever.
 */
const indexDays = (value: string | undefined) => {
  const parsed = Number(value);
  return (!value?.trim() || !Number.isFinite(parsed) || parsed < 0 ? 90 : parsed) * 24 * 60 * 60 * 1000;
};

export class ImageProxy {
  private index = new Map<string, Entry>();
  private inflight = new Map<string, Promise<Entry | undefined>>();
  private memory = new Map<string, Buffer>();
  private memoryBytes = 0;
  /** Ids whose bytes were downloaded by the fetch that is about to serve them. */
  private justFetched = new Set<string>();
  private saveTimer?: NodeJS.Timeout;
  private dirty = false;
  private maintenance?: Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();
  private indexWrites: Promise<void> = Promise.resolve();

  constructor(
    private dir = path.join(process.env.DATA_DIR ?? "/data", "images"),
    private cap = megabytes(process.env.IMAGE_CACHE_MB, 512),
    private ttlMs = days(process.env.IMAGE_CACHE_TTL_DAYS),
    private fetcher: (url: string, init: RequestInit) => Promise<Response> = guardedFetch,
    private indexTtlMs = indexDays(process.env.IMAGE_CACHE_INDEX_TTL_DAYS),
    private now: () => number = Date.now,
    private memoryCap = memoryMegabytes(process.env.IMAGE_MEMORY_MB, 32),
  ) {}

  private get indexFile() { return path.join(this.dir, "index.json"); }

  /**
   * The map has to survive a restart: a poster the client already holds is an id,
   * and without the address behind it the picture would be gone until the catalogue
   * is fetched again -- and a queued download would lose its poster for good.
   */
  async load() {
    await mkdir(this.dir, { recursive: true });
    let stored: Record<string, Entry> = {};
    try { stored = JSON.parse(await readFile(this.indexFile, "utf8")) as Record<string, Entry>; }
    catch { stored = {}; }
    const files = new Set((await readdir(this.dir).catch(() => [])).filter((name) => name !== "index.json"));
    for (const [id, entry] of Object.entries(stored)) {
      if (!entry?.url) continue;
      const at = Number.isFinite(entry.at) && entry.at > 0 ? entry.at : this.now();
      // The width has to survive a restart even before the bytes exist: the id the page holds
      // already names the size, and serving it smaller would hand back a different picture.
      const width = entry.width === DETAIL_WIDTH ? DETAIL_WIDTH : undefined;
      const sized = width ? { width } : {};
      const onDisk = entry.ext && files.has(`${id}.${entry.ext}`);
      this.index.set(id, onDisk ? { url: entry.url, ext: entry.ext, bytes: entry.bytes, at, ...sized } : { url: entry.url, at, ...sized });
      if (onDisk) files.delete(`${id}.${entry.ext}`);
    }
    // Anything the index does not know about cannot be served, so it is only waste.
    for (const orphan of files) await rm(path.join(this.dir, orphan), { force: true });
    // A lowered cap, or an index nobody has touched for a long time, is dealt with here
    // as well, so the first paint after a restart already sees the enforcement.
    if (await this.enforce()) await this.writeIndex();
  }

  /** Removals run one at a time: each candidate is a snapshot, and two passes must never
   *  interleave the read of an entry with its removal. */
  private exclusively<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async enforce(): Promise<boolean> {
    const evicted = await this.evict();
    // Retirement always runs, whatever the byte pass decided.
    return this.retireMappings() > 0 || evicted;
  }

  /** An explicit pass: bytes past their age or over the cap go, then links nobody used. */
  maintain(): Promise<void> {
    if (!this.maintenance) {
      this.maintenance = this.enforce().then(
        () => undefined,
        (error) => { log("WARN", "Image cache maintenance failed", { reason: String(error).slice(0, 120) }); },
      ).finally(() => { this.maintenance = undefined; });
    }
    return this.maintenance;
  }

  /** A link nobody used for `indexTtlMs` and with no bytes behind it is forgotten. Entries
   *  with bytes are left alone: byte expiry turns them into links first, and they retire later. */
  private retireMappings(): number {
    if (!(this.indexTtlMs > 0)) return 0;
    let removed = 0;
    for (const [id, entry] of [...this.index.entries()]) {
      if (entry.ext || this.inflight.has(id)) continue;
      if (this.now() - entry.at <= this.indexTtlMs) continue;
      this.index.delete(id);
      removed += 1;
    }
    if (removed) { log("INFO", "Unused image links dropped", { removed }); this.save(); }
    return removed;
  }

  private save() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      if (!this.dirty) return;
      this.dirty = false;
      void this.writeIndex();
    }, 2000);
    this.saveTimer.unref?.();
  }

  /** One write at a time: two would share the temporary file, and a rename could move the
   *  other's half-written bytes into place. An index that lags the files costs them all at the
   *  next load, which deletes what it does not list, so a failed write is owed again. */
  private writeIndex() {
    const run = this.indexWrites.then(async () => {
      const temp = `${this.indexFile}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(Object.fromEntries(this.index)), { mode: 0o600 });
        await renameWithRetry(temp, this.indexFile);
      } catch (error) {
        this.dirty = true;
        log("WARN", "The image cache index could not be saved", { reason: String(error).slice(0, 120) });
      }
    });
    this.indexWrites = run;
    return run;
  }

  async flush() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    if (this.dirty) { this.dirty = false; await this.writeIndex(); }
    await this.indexWrites;
    if (this.dirty) { this.dirty = false; await this.writeIndex(); }
  }

  /** Remote address in, opaque link out. Anything already local is left alone. A width other
   *  than the listing tile registers a separate entry, so a wider picture is its own file. */
  proxied(value?: string, width: number = TILE_WIDTH): string | undefined {
    if (!value) return value ?? undefined;
    if (!secureMode() || !/^https?:\/\//i.test(value)) return value;
    const target = artworkWidth(width);
    const id = idFor(value, target);
    const known = this.index.get(id);
    if (known) known.at = this.now();
    else this.index.set(id, { url: value, at: this.now(), ...(target === DETAIL_WIDTH ? { width: target } : {}) });
    this.save();
    return `${PREFIX}${id}`;
  }

  /** The other direction, for the poster the client hands back to us. */
  original(value?: string): string | undefined {
    if (!value || !isProxiedImage(value)) return value ?? undefined;
    return this.index.get(value.slice(PREFIX.length))?.url;
  }

  source(id: string): string | undefined { return this.index.get(id)?.url; }

  /** Whatever the interface may put in an `<img>`: the named fields, episode stills and
   *  the loose gallery arrays addons attach. */
  private rewriteGallery(value: unknown, width: number = TILE_WIDTH): unknown {
    if (!Array.isArray(value)) return value;
    return value.map((entry) => {
      if (typeof entry === "string") return this.proxied(entry, width);
      if (!entry || typeof entry !== "object") return entry;
      const item = entry as Record<string, unknown>;
      const next = { ...item };
      const target = item.kind === "poster" || item.shape === "poster" ? TILE_WIDTH : width;
      for (const key of ["url", "src"]) if (typeof item[key] === "string") next[key] = this.proxied(item[key] as string, target);
      return next;
    });
  }

  rewriteMeta<T extends MetaItem>(item: T, detail = false): T {
    const width = detail ? DETAIL_WIDTH : TILE_WIDTH;
    // The listing narrows a Metahub backdrop to a tile; the detail page draws it full width.
    const background = typeof item.background === "string" ? (detail ? item.background : narrowArtwork(item.background)) : item.background;
    // An addon that names its own poster as the backdrop leaves every wide surface with a
    // portrait picture to draw. That is not a backdrop, so it is dropped here and the page falls
    // back to the gallery's own picture, the video frame, or its gradient.
    const duplicated = typeof item.background === "string" && item.background === item.poster;
    // Secure mode off still narrows a background: the page then loads it from the CDN itself.
    if (!secureMode()) return background === item.background && !duplicated ? item : { ...item, background: duplicated ? undefined : background };
    const videos = item.videos?.map((video) => {
      const thumbnail = typeof video.thumbnail === "string" ? this.proxied(video.thumbnail) : video.thumbnail;
      return thumbnail === video.thumbnail ? video : { ...video, thumbnail };
    });
    const galleries: Record<string, unknown> = {};
    for (const key of ["images", "screenshots"]) if (key in item) galleries[key] = this.rewriteGallery(item[key], width);
    return {
      ...item,
      ...galleries,
      poster: this.proxied(item.poster),
      background: duplicated ? undefined : this.proxied(background, width),
      logo: typeof item.logo === "string" ? this.proxied(item.logo) : item.logo,
      ...(videos ? { videos } : {}),
    };
  }

  private path(id: string, ext: string) { return path.join(this.dir, `${id}.${ext}`); }

  /** Fewer bytes on disk: the fetched picture is re-encoded once, or comes back as it was.
   *  A picture already at or under the target width is never scaled up. */
  private async downscale(data: Buffer, ext: string, width: number = TILE_WIDTH): Promise<Buffer> {
    if (ext === "svg" || ext === "gif") return data;
    const target = artworkWidth(width);
    const current = imageWidth(data);
    if (current !== undefined && current <= target) return data;
    const temp = path.join(this.dir, `.resize-${randomUUID()}`);
    try {
      await writeFile(temp, data, { mode: 0o600 });
      const { stdout } = await promisify(execFile)(ffmpegPath(), [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-i", temp,
        "-vf", `scale='min(${target},iw)':-2`, "-q:v", "5", "-c:v", "mjpeg", "-f", "image2pipe", "pipe:1",
      ], { encoding: "buffer", timeout: FFMPEG_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: MAX_BYTES * 2 });
      return stdout.length && stdout.length < data.length ? stdout : data;
    } catch (error) {
      log("DEBUG", "The image stays at the size it was fetched", { reason: String(error).slice(0, 120) });
      return data;
    } finally {
      await rm(temp, { force: true });
    }
  }

  /** Cached bytes, or one fetch shared by everyone who asked at the same time. */
  async fetch(id: string): Promise<CachedImage | undefined> {
    const entry = this.index.get(id);
    if (!entry) { log("DEBUG", "An unknown image id was requested", { id }); return undefined; }
    if (entry.ext) {
      entry.at = this.now();
      return { file: this.path(id, entry.ext), type: TYPES[entry.ext]!, etag: `"${id}-${entry.bytes ?? 0}"` };
    }
    let pending = this.inflight.get(id);
    if (!pending) {
      pending = this.download(id, entry).finally(() => this.inflight.delete(id));
      this.inflight.set(id, pending);
    }
    const done = await pending;
    if (!done?.ext) return undefined;
    this.justFetched.add(id);
    return { file: this.path(id, done.ext), type: TYPES[done.ext]!, etag: `"${id}-${done.bytes ?? 0}"` };
  }

  /** True when this id's bytes are already in memory, before the route reads them. */
  inMemory(id: string): boolean {
    return this.memory.has(id);
  }

  /** The fetch that just stored this id. The next read of it is not a disk hit. */
  takeFetched(id: string): boolean {
    return this.justFetched.delete(id);
  }

  private putMemory(id: string, data: Buffer) {
    if (this.memoryCap <= 0 || data.length > this.memoryCap) return;
    const known = this.memory.get(id);
    if (known) { this.memory.delete(id); this.memoryBytes -= known.length; }
    while (this.memoryBytes + data.length > this.memoryCap) {
      const oldest = this.memory.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const dropped = this.memory.get(oldest)!;
      this.memory.delete(oldest);
      this.memoryBytes -= dropped.length;
    }
    this.memory.set(id, data);
    this.memoryBytes += data.length;
  }

  /** The bytes behind an id the page holds: from memory when they are there, otherwise read
   *  once from disk and remembered. An id whose bytes were evicted holds nothing. */
  async readCached(id: string): Promise<Buffer | undefined> {
    const entry = this.index.get(id);
    if (!entry?.ext) return undefined;
    const remembered = this.memory.get(id);
    if (remembered) {
      this.memory.delete(id);
      this.memory.set(id, remembered);
      return remembered;
    }
    const data = await readFile(this.path(id, entry.ext)).catch(() => undefined);
    if (!data) return undefined;
    this.putMemory(id, data);
    return data;
  }

  /** The hottest files, newest `at` first, read into memory once at start. It never changes an
   *  entry's `at`: preheat is a copy, not a use. */
  async preheat(): Promise<void> {
    if (this.memoryCap <= 0) return;
    const ordered = [...this.index.entries()]
      .filter(([, entry]) => entry.ext !== undefined)
      .sort((left, right) => right[1].at - left[1].at);
    const warmed: string[] = [];
    let files = 0;
    let bytes = 0;
    for (const [id, entry] of ordered) {
      if (this.memory.has(id)) continue;
      const info = await stat(this.path(id, entry.ext!)).catch(() => undefined);
      if (!info?.isFile()) continue;
      if (info.size > this.memoryCap) continue;
      if (info.size > this.memoryCap - this.memoryBytes) break;
      const data = await readFile(this.path(id, entry.ext!)).catch(() => undefined);
      if (!data) continue;
      this.putMemory(id, data);
      warmed.push(id);
      files += 1;
      bytes += data.length;
    }
    // Newest was inserted first, so it would be evicted first. Replay oldest-first.
    for (const id of warmed.reverse()) {
      const data = this.memory.get(id);
      if (!data) continue;
      this.memory.delete(id);
      this.memory.set(id, data);
    }
    log("INFO", "Image cache preheat finished", { files, bytes });
  }

  private async download(id: string, entry: Entry): Promise<Entry | undefined> {
    const rejected = (reason: string) => {
      log("DEBUG", "The image was not cached", { host: hostOf(entry.url), reason });
      return undefined;
    };
    try {
      const response = await this.fetcher(entry.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) { await response.body?.cancel(); return rejected(`HTTP ${response.status}`); }
      const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const ext = EXTENSIONS[type];
      if (!ext) { await response.body?.cancel(); return rejected(`content-type ${type || "missing"}`); }
      const fetched = Buffer.from(await response.arrayBuffer());
      if (!fetched.length || fetched.length > MAX_BYTES) return rejected(`${fetched.length} bytes`);
      await mkdir(this.dir, { recursive: true });
      const data = await this.downscale(fetched, ext, entry.width ?? TILE_WIDTH);
      // The same buffer back means nothing was re-encoded; mjpeg output is a jpeg.
      const storedExt = data === fetched ? ext : "jpg";
      const target = this.path(id, storedExt);
      const temp = `${target}.tmp`;
      await writeFile(temp, data, { mode: 0o600 });
      await renameWithRetry(temp, target);
      entry.ext = storedExt;
      entry.bytes = data.length;
      entry.at = this.now();
      this.save();
      await this.evict();
      // Eviction may have taken this very picture; never hand out a path it just deleted.
      return entry.ext ? entry : undefined;
    } catch (error) {
      return rejected(String(error).slice(0, 120));
    }
  }

  private evict(): Promise<boolean> { return this.exclusively(() => this.evictOnce()); }

  /** Oldest first, down to `evictionFloor(cap)` so this does not run on every write.
   *  `IMAGE_CACHE_TTL_DAYS` also drops the bytes of anything not served for that long,
   *  while the cache still sits under its cap. */
  private async evictOnce(): Promise<boolean> {
    let total = 0;
    for (const entry of this.index.values()) total += entry.bytes ?? 0;
    let changed = false;
    const aged = this.ttlMs
      ? [...this.index.entries()].filter(([id, entry]) => entry.ext && !this.inflight.has(id) && this.now() - entry.at > this.ttlMs)
      : [];
    let agedRemoved = 0;
    for (const [id, snapshot] of aged) {
      const bytes = await this.dropBytes(id, snapshot);
      if (bytes === undefined) continue;
      total -= bytes;
      agedRemoved += 1;
      changed = true;
    }
    if (agedRemoved) log("INFO", "Cached images dropped past their age", { removed: agedRemoved });

    const stored = [...this.index.entries()]
      .filter(([id, entry]) => entry.ext && !this.inflight.has(id))
      .sort((a, b) => a[1].at - b[1].at);
    const target = evictionFloor(this.cap);
    let removed = 0;
    for (const [id, snapshot] of total > this.cap ? stored : []) {
      if (total <= target) break;
      const bytes = await this.dropBytes(id, snapshot);
      if (bytes === undefined) continue;
      total -= bytes;
      removed += 1;
      changed = true;
    }
    if (removed) log("INFO", "Cached images dropped to stay under the limit", { removed });
    if (changed) this.save();
    return changed;
  }

  /** Removes one snapshot's bytes, unless the entry was served or replaced meanwhile. The
   *  address stays; only the bytes go, so the id the client holds keeps working. */
  private async dropBytes(id: string, snapshot: Entry): Promise<number | undefined> {
    const current = this.index.get(id);
    if (!current?.ext || current.ext !== snapshot.ext || current.at !== snapshot.at) return undefined;
    try {
      await rm(this.path(id, current.ext), { force: true });
    } catch (error) {
      log("WARN", "A cached image could not be removed", { reason: String(error).slice(0, 120) });
      return undefined;
    }
    const bytes = current.bytes ?? 0;
    current.ext = undefined;
    current.bytes = undefined;
    const remembered = this.memory.get(id);
    if (remembered) { this.memory.delete(id); this.memoryBytes -= remembered.length; }
    return bytes;
  }

  get size() { return this.index.size; }
}

export const images = new ImageProxy();
