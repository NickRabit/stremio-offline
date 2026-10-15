import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { log } from "./logger.js";
import { ffmpegPath } from "./media-tools.js";

/**
 * The fan a tile draws when it stands for several films: one picture, composed here, so the
 * browser downloads a single JPEG per tile instead of two to four posters and assembling them
 * itself. The tile keeps the same address until one of the pictures behind it changes, because
 * the fan is cached under a stamp drawn from their own versions.
 */

const run = promisify(execFile);

/** The extension a source really is: the bytes come from a provider or from a thumbnail and may
 *  be any of the four formats the image cache stores. */
const imageExtension = (bytes: Buffer): string => {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes.toString("latin1", 1, 4) === "PNG") return "png";
  if (bytes.length > 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (bytes.length > 6 && bytes.toString("latin1", 0, 4) === "GIF8") return "gif";
  return "jpg";
};

/** The size a tile actually draws, per shape. */
export const MOSAIC_SIZES = { poster: { width: 480, height: 720 }, wide: { width: 960, height: 540 } } as const;
export type MosaicShape = keyof typeof MOSAIC_SIZES;

export const mosaicShape = (value: unknown): MosaicShape => (value === "wide" ? "wide" : "poster");

/** The space between two cells, in the tiles' own background colour, so a fan blends into a tile. */
const GAP = 4;
const BACKGROUND = "0x0d1117";
const MAX_CELLS = 4;
const COMPOSE_TIMEOUT_MS = 20_000;

export interface MosaicCell { x: number; y: number; width: number; height: number }

/** Rounded down to an even number: a JPEG is cropped and scaled at whole chroma samples, so an
 *  odd cell would shift its own colour by half a pixel. Everything below stays even, and the
 *  background shows through whatever pixel or two the frame has left over. */
const even = (value: number) => Math.max(2, value - (value % 2));

/** Where each picture sits. Two share the frame, three give the first one the left two thirds,
 *  four or more fill a grid; one covers the frame, which a tile only asks for with no fan. */
export function mosaicCells(count: number, shape: MosaicShape): MosaicCell[] {
  const { width, height } = MOSAIC_SIZES[shape];
  if (count <= 1) return [{ x: 0, y: 0, width: even(width), height: even(height) }];
  // A wide frame is a row of pictures: stacked cells there would be letterbox slivers, while a
  // column keeps each one close to its own portrait shape.
  if (shape === "wide") {
    const column = even(Math.floor((width - GAP * (count - 1)) / count));
    return Array.from({ length: count }, (_unused, index) => ({
      x: index * (column + GAP), y: 0, width: column, height: even(height),
    }));
  }
  const columns = () => {
    const left = even(Math.floor((width - GAP) / 2));
    return { left, right: even(width - GAP - left) };
  };
  const rows = () => {
    const top = even(Math.floor((height - GAP) / 2));
    return { top, bottom: even(height - GAP - top) };
  };
  if (count === 2) {
    const { left, right } = columns();
    return [
      { x: 0, y: 0, width: left, height: even(height) },
      { x: left + GAP, y: 0, width: right, height: even(height) },
    ];
  }
  if (count === 3) {
    const hero = even(Math.round(width * 0.6125));
    const side = even(width - GAP - hero);
    const { top, bottom } = rows();
    return [
      { x: 0, y: 0, width: hero, height: even(height) },
      { x: hero + GAP, y: 0, width: side, height: top },
      { x: hero + GAP, y: top + GAP, width: side, height: bottom },
    ];
  }
  const { left, right } = columns();
  const { top, bottom } = rows();
  return [
    { x: 0, y: 0, width: left, height: top },
    { x: left + GAP, y: 0, width: right, height: top },
    { x: 0, y: top + GAP, width: left, height: bottom },
    { x: left + GAP, y: top + GAP, width: right, height: bottom },
  ];
}

/** The filter graph: every picture is cropped to its cell the way `object-fit: cover` would, and
 *  the cells are laid over one background in order. */
export function mosaicFilter(cells: readonly MosaicCell[], shape: MosaicShape): string {
  const { width, height } = MOSAIC_SIZES[shape];
  const parts = cells.map((cell, index) =>
    `[${index}]scale=${cell.width}:${cell.height}:force_original_aspect_ratio=increase,crop=${cell.width}:${cell.height}[c${index}]`);
  let graph = `${parts.join(";")};color=c=${BACKGROUND}:s=${width}x${height}[bg]`;
  let previous = "bg";
  cells.forEach((cell, index) => {
    graph += `;[${previous}][c${index}]overlay=${cell.x}:${cell.y}[o${index}]`;
    previous = `o${index}`;
  });
  return graph;
}

/** The bytes of one fan. At most four pictures are used; the rest are dropped rather than
 *  squeezed in. */
export async function composeMosaic(sources: readonly Buffer[], shape: MosaicShape, signal?: AbortSignal): Promise<Buffer> {
  const cells = mosaicCells(Math.min(sources.length, MAX_CELLS), shape);
  const images = sources.slice(0, cells.length);
  if (!images.length) throw new Error("A mosaic needs at least one picture.");
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-mosaic-"));
  try {
    const inputs: string[] = [];
    for (const [index, bytes] of images.entries()) {
      const file = path.join(dir, `${index}.${imageExtension(bytes)}`);
      await writeFile(file, bytes);
      inputs.push(file);
    }
    const target = path.join(dir, "mosaic.jpg");
    await run(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error",
      ...inputs.flatMap((file) => ["-i", file]),
      "-filter_complex", mosaicFilter(cells, shape),
      "-map", `[o${cells.length - 1}]`, "-frames:v", "1", "-q:v", "4", "-y", target,
    ], { signal, timeout: COMPOSE_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    return await readFile(target);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const megabytes = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return (Number.isFinite(parsed) && parsed > 0 ? parsed : fallback) * 1024 * 1024;
};

/** Composed fans on disk and in memory, under a byte cap. The key is the library, the folder,
 *  the shape and the stamp of the pictures behind it, so one composition is exactly one address:
 *  a picture that changes makes a new key, and the old file is what eviction takes first. */
export class MosaicCache {
  private entries = new Map<string, Buffer>();
  private bytes = 0;
  private maintenance?: Promise<void>;
  private readonly composing = new Map<string, Promise<Buffer>>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly dir = path.join(process.env.DATA_DIR ?? "/data", "mosaics"),
    private readonly cap = megabytes(process.env.MOSAIC_CACHE_MB, 128),
    private readonly memoryCap = megabytes(process.env.MOSAIC_MEMORY_MB, 32),
  ) {}

  file(key: string): string {
    return path.join(this.dir, `${createHash("sha1").update(key).digest("hex")}.jpg`);
  }

  /** The composed fan, or nothing. A hit moves to the end of the memory order. */
  async read(key: string): Promise<Buffer | undefined> {
    const known = this.entries.get(key);
    if (known) {
      this.entries.delete(key);
      this.entries.set(key, known);
      return known;
    }
    const file = this.file(key);
    const bytes = await readFile(file).catch(() => undefined);
    if (!bytes?.length) return undefined;
    // A fan somebody draws is a fan somebody wants: its place in the eviction order is now.
    await utimes(file, new Date(), new Date()).catch(() => undefined);
    this.remember(key, bytes);
    return bytes;
  }

  /** The composed fan for a key, composing it once: two requests for the same fan wait on one
   *  composition, and at most two composes run at once no matter how many tiles ask. */
  async compose(key: string, work: () => Promise<Buffer>): Promise<Buffer> {
    const known = await this.read(key);
    if (known) return known;
    const running = this.composing.get(key);
    if (running) return running;
    const pass = (async () => {
      await this.acquire(slot => this.waiting.push(slot));
      try {
        const bytes = await work();
        await this.write(key, bytes);
        return bytes;
      } finally {
        const next = this.waiting.shift();
        if (next) next(); else this.active -= 1;
      }
    })().finally(() => { this.composing.delete(key); });
    this.composing.set(key, pass);
    return pass;
  }

  private async acquire(queue: (slot: () => void) => void): Promise<void> {
    if (this.active < 2) { this.active += 1; return; }
    await new Promise<void>((resolve) => queue(resolve));
  }

  async write(key: string, bytes: Buffer): Promise<void> {
    this.remember(key, bytes);
    const file = this.file(key);
    try {
      await mkdir(this.dir, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, bytes);
      await rename(temp, file);
    } catch (error) {
      log("WARN", "A composed mosaic could not be stored", { reason: String(error).slice(0, 120) });
      return;
    }
    await this.trim().catch(() => undefined);
  }

  private remember(key: string, bytes: Buffer): void {
    if (this.memoryCap <= 0 || bytes.length > this.memoryCap) return;
    const known = this.entries.get(key);
    if (known) { this.entries.delete(key); this.bytes -= known.length; }
    while (this.bytes + bytes.length > this.memoryCap) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const dropped = this.entries.get(oldest)!;
      this.entries.delete(oldest);
      this.bytes -= dropped.length;
    }
    this.entries.set(key, bytes);
    this.bytes += bytes.length;
  }

  /** One pass over the directory at a time: the oldest files go until the cap holds again. */
  private trim(): Promise<void> {
    if (this.maintenance) return this.maintenance;
    const pass = (async () => {
      const names = (await readdir(this.dir).catch(() => [] as string[])).filter((name) => name.endsWith(".jpg"));
      const files = await Promise.all(names.map(async (name) => {
        const file = path.join(this.dir, name);
        const info = await stat(file).catch(() => undefined);
        return info ? { file, size: info.size, at: info.mtimeMs } : undefined;
      }));
      const kept = files.filter((entry): entry is { file: string; size: number; at: number } => entry !== undefined);
      let total = kept.reduce((sum, entry) => sum + entry.size, 0);
      if (total <= this.cap) return;
      for (const entry of kept.sort((left, right) => left.at - right.at)) {
        if (total <= this.cap) break;
        total -= entry.size;
        await rm(entry.file, { force: true }).catch(() => undefined);
      }
    })().finally(() => { this.maintenance = undefined; });
    this.maintenance = pass;
    return pass;
  }

  /** The stamp a composed fan is cached under: the version of every picture that went into it,
   *  in order, so a new poster, a removed film or a changed picture is a new fan. */
  static stamp(versions: readonly string[]): string {
    return createHash("sha1").update(versions.join("\u0000")).digest("base64url").slice(0, 16);
  }
}
