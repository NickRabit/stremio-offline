import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "./fs-retry.js";
import { log } from "./logger.js";

/** Where the picture was shown. Home is separate because its cards reuse the other three stores. */
export type ImageLayer = "catalog" | "library" | "remote" | "home";
/** Memory did not read the file. Disk did not ask the addon or the remote library again. */
export type ImageFrom = "memory" | "disk" | "upstream";

export interface ImageCounts { memory: number; disk: number; upstream: number }
export interface ImageLayerSummary {
  catalog: ImageCounts;
  library: ImageCounts;
  remote: ImageCounts;
  home: ImageCounts;
}

const LAYERS = ["catalog", "library", "remote", "home"] as const;
const FROMS = ["memory", "disk", "upstream"] as const;
const HOUR = 60 * 60 * 1000;
const KEEP_MS = 400 * 24 * HOUR;

const emptyCounts = (): ImageCounts => ({ memory: 0, disk: 0, upstream: 0 });
const emptySummary = (): ImageLayerSummary => ({
  catalog: emptyCounts(), library: emptyCounts(), remote: emptyCounts(), home: emptyCounts(),
});

interface Bucket extends ImageLayerSummary { at: string }

const isLayer = (value: string): value is ImageLayer => (LAYERS as readonly string[]).includes(value);

/** A request may name the screen that showed the picture. Anything else keeps the store's own layer. */
export function imageSurface(value: unknown, fallback: ImageLayer): ImageLayer {
  return typeof value === "string" && isLayer(value) ? value : fallback;
}

/** The surface the client actually named, for the log. A missing or unknown value stays a label,
 *  never the raw query, so a poster line cannot grow without a bound. */
export function askedSurface(value: unknown): string {
  if (typeof value !== "string" || value === "") return "unset";
  return isLayer(value) ? value : "other";
}

/** Hop between the image cache and the HTTP route. The route reads it for the log and does not
 *  forward it: the browser must not see which copy the bytes came from. */
export const IMAGE_FROM_HEADER = "x-image-from";

/** One line per poster the browser was sent or revalidated. A picture the browser already holds
 *  never arrives here. `asked` is the query; `surface` is the statistics column that moved. */
export function logPoster(detail: {
  kind: "remote" | "catalog" | "library";
  surface: ImageLayer;
  asked: string;
  from?: ImageFrom;
  status: number;
  bytes: number;
  cache?: string | null;
}): void {
  log("INFO", "Poster served", {
    kind: detail.kind,
    surface: detail.surface,
    asked: detail.asked,
    ...(detail.from ? { from: detail.from } : {}),
    status: detail.status,
    bytes: detail.bytes,
    ...(detail.cache ? { cache: detail.cache } : {}),
  });
}

/** Hourly picture counts. One request is exactly one of memory, disk or upstream. */
export class ImageStats {
  private buckets: Bucket[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string, private readonly now = () => Date.now()) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as unknown;
      if (!Array.isArray(raw)) return;
      this.buckets = raw.flatMap((item) => this.readBucket(item));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  record(layer: ImageLayer, from: ImageFrom): void {
    const at = new Date(Math.floor(this.now() / HOUR) * HOUR).toISOString();
    let bucket = this.buckets.find((item) => item.at === at);
    if (!bucket) {
      bucket = { at, ...emptySummary() };
      this.buckets.push(bucket);
    }
    bucket[layer][from] += 1;
    this.dirty = true;
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 1000);
      this.timer.unref?.();
    }
  }

  /** Counts whose hour starts inside the window. The selected statistics period uses the same hours. */
  summary(hours: number, now = this.now()): ImageLayerSummary {
    const from = now - Math.max(0, hours) * HOUR;
    const out = emptySummary();
    for (const bucket of this.buckets) {
      const at = Date.parse(bucket.at);
      if (!Number.isFinite(at) || at < from) continue;
      for (const layer of LAYERS) for (const key of FROMS) out[layer][key] += bucket[layer][key];
    }
    return out;
  }

  flush(): Promise<void> {
    if (!this.dirty) return this.chain;
    this.dirty = false;
    const cutoff = this.now() - KEEP_MS;
    this.buckets = this.buckets.filter((bucket) => Date.parse(bucket.at) >= cutoff);
    const payload = JSON.stringify(this.buckets);
    this.chain = this.chain.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      await writeFile(temp, payload, { mode: 0o600 });
      await renameWithRetry(temp, this.file);
    });
    return this.chain;
  }

  private readBucket(item: unknown): Bucket[] {
    if (!item || typeof item !== "object") return [];
    const at = (item as { at?: unknown }).at;
    if (typeof at !== "string") return [];
    const counts = emptySummary();
    for (const layer of LAYERS) {
      const row = (item as Record<string, unknown>)[layer];
      if (!row || typeof row !== "object") continue;
      for (const key of FROMS) {
        const value = (row as Record<string, unknown>)[key];
        if (typeof value === "number" && Number.isFinite(value) && value > 0) counts[layer][key] = value;
      }
    }
    return [{ at, ...counts }];
  }
}

let active: ImageStats | undefined;

/** The process-wide counter. Tests leave it unset, so a picture request records nothing. */
export function useImageStats(stats: ImageStats | undefined): void {
  active = stats;
}

export function noteImage(layer: ImageLayer, from: ImageFrom): void {
  active?.record(layer, from);
}
