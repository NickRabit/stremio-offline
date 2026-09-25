import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
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
  at: number;
}

export interface CachedImage { file: string; type: string; etag: string }

const megabytes = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return (Number.isFinite(parsed) && parsed > 0 ? parsed : fallback) * 1024 * 1024;
};

/** `0`, the default, keeps the cache on its cap alone. */
const days = (value: string | undefined) => {
  const parsed = Number(value);
  return (Number.isFinite(parsed) && parsed > 0 ? parsed : 0) * 24 * 60 * 60 * 1000;
};

export class ImageProxy {
  private index = new Map<string, Entry>();
  private inflight = new Map<string, Promise<Entry | undefined>>();
  private saveTimer?: NodeJS.Timeout;
  private dirty = false;

  constructor(
    private dir = path.join(process.env.DATA_DIR ?? "/data", "images"),
    private cap = megabytes(process.env.IMAGE_CACHE_MB, 512),
    private ttlMs = days(process.env.IMAGE_CACHE_TTL_DAYS),
    private fetcher: (url: string, init: RequestInit) => Promise<Response> = guardedFetch,
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
      const onDisk = entry.ext && files.has(`${id}.${entry.ext}`);
      this.index.set(id, onDisk ? entry : { url: entry.url, at: entry.at || Date.now() });
      if (onDisk) files.delete(`${id}.${entry.ext}`);
    }
    // Anything the index does not know about cannot be served, so it is only waste.
    for (const orphan of files) await rm(path.join(this.dir, orphan), { force: true });
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

  private async writeIndex() {
    const data = JSON.stringify(Object.fromEntries(this.index));
    const temp = `${this.indexFile}.tmp`;
    try {
      await writeFile(temp, data, { mode: 0o600 });
      await rename(temp, this.indexFile);
    } catch (error) {
      log("WARN", "The image cache index could not be saved", { reason: String(error).slice(0, 120) });
    }
  }

  async flush() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    if (this.dirty) { this.dirty = false; await this.writeIndex(); }
  }

  /** Remote address in, opaque link out. Anything already local is left alone. */
  proxied(value?: string): string | undefined {
    if (!value) return value ?? undefined;
    if (!secureMode() || !/^https?:\/\//i.test(value)) return value;
    const id = imageId(value);
    const known = this.index.get(id);
    if (known) known.at = Date.now();
    else this.index.set(id, { url: value, at: Date.now() });
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
  private rewriteGallery(value: unknown): unknown {
    if (!Array.isArray(value)) return value;
    return value.map((entry) => {
      if (typeof entry === "string") return this.proxied(entry);
      if (!entry || typeof entry !== "object") return entry;
      const item = entry as Record<string, unknown>;
      const next = { ...item };
      for (const key of ["url", "src"]) if (typeof item[key] === "string") next[key] = this.proxied(item[key] as string);
      return next;
    });
  }

  rewriteMeta<T extends MetaItem>(item: T): T {
    const background = typeof item.background === "string" ? narrowArtwork(item.background) : item.background;
    // Secure mode off still narrows a background: the page then loads it from the CDN itself.
    if (!secureMode()) return background === item.background ? item : { ...item, background };
    const videos = item.videos?.map((video) => {
      const thumbnail = typeof video.thumbnail === "string" ? this.proxied(video.thumbnail) : video.thumbnail;
      return thumbnail === video.thumbnail ? video : { ...video, thumbnail };
    });
    const galleries: Record<string, unknown> = {};
    for (const key of ["images", "screenshots"]) if (key in item) galleries[key] = this.rewriteGallery(item[key]);
    return {
      ...item,
      ...galleries,
      poster: this.proxied(item.poster),
      background: this.proxied(background),
      logo: typeof item.logo === "string" ? this.proxied(item.logo) : item.logo,
      ...(videos ? { videos } : {}),
    };
  }

  private path(id: string, ext: string) { return path.join(this.dir, `${id}.${ext}`); }

  /** Fewer bytes on disk: the fetched picture is re-encoded once, or comes back as it was. */
  private async downscale(data: Buffer, ext: string): Promise<Buffer> {
    if (ext === "svg" || ext === "gif") return data;
    const width = imageWidth(data);
    if (width !== undefined && width <= TILE_WIDTH) return data;
    const temp = path.join(this.dir, `.resize-${randomUUID()}`);
    try {
      await writeFile(temp, data, { mode: 0o600 });
      const { stdout } = await promisify(execFile)(ffmpegPath(), [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-i", temp,
        "-vf", "scale='min(640,iw)':-2", "-q:v", "5", "-c:v", "mjpeg", "-f", "image2pipe", "pipe:1",
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
      entry.at = Date.now();
      this.save();
      return { file: this.path(id, entry.ext), type: TYPES[entry.ext]!, etag: `"${id}-${entry.bytes ?? 0}"` };
    }
    let pending = this.inflight.get(id);
    if (!pending) {
      pending = this.download(id, entry).finally(() => this.inflight.delete(id));
      this.inflight.set(id, pending);
    }
    const done = await pending;
    if (!done?.ext) return undefined;
    return { file: this.path(id, done.ext), type: TYPES[done.ext]!, etag: `"${id}-${done.bytes ?? 0}"` };
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
      const data = await this.downscale(fetched, ext);
      // The same buffer back means nothing was re-encoded; mjpeg output is a jpeg.
      const storedExt = data === fetched ? ext : "jpg";
      const target = this.path(id, storedExt);
      const temp = `${target}.tmp`;
      await writeFile(temp, data, { mode: 0o600 });
      await rename(temp, target);
      entry.ext = storedExt;
      entry.bytes = data.length;
      entry.at = Date.now();
      this.save();
      await this.evict();
      return entry;
    } catch (error) {
      return rejected(String(error).slice(0, 120));
    }
  }

  /** Oldest first, down to four fifths of the cap so this does not run on every write.
   *  `IMAGE_CACHE_TTL_DAYS` also drops the bytes of anything not served for that long,
   *  while the cache still sits under its cap. */
  private async evict() {
    let total = 0;
    for (const entry of this.index.values()) total += entry.bytes ?? 0;
    // The address stays, only the bytes go: the id the client holds keeps working.
    const drop = async ([id, entry]: [string, Entry]) => {
      await rm(this.path(id, entry.ext!), { force: true });
      total -= entry.bytes ?? 0;
      entry.ext = undefined;
      entry.bytes = undefined;
    };
    const aged = this.ttlMs
      ? [...this.index.entries()].filter(([, entry]) => entry.ext && Date.now() - entry.at > this.ttlMs)
      : [];
    for (const entry of aged) await drop(entry);
    if (aged.length) log("INFO", "Cached images dropped past their age", { removed: aged.length });

    const stored = [...this.index.entries()].filter(([, entry]) => entry.ext).sort((a, b) => a[1].at - b[1].at);
    const target = this.cap * 0.8;
    let removed = 0;
    for (const entry of total > this.cap ? stored : []) {
      if (total <= target) break;
      await drop(entry);
      removed += 1;
    }
    if (removed) log("INFO", "Cached images dropped to stay under the limit", { removed });
    if (removed || aged.length) this.save();
  }

  get size() { return this.index.size; }
}

export const images = new ImageProxy();
