import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "./fs-retry.js";
import { log } from "./logger.js";
import type { AppDatabase } from "./storage/app-database.js";
import { HourlyCounts, moveToMigrationBackup, type HourlyRow } from "./storage/hourly-counts.js";
import { TrackedMap } from "./storage/tracked-map.js";

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
const SAVE_MS = 45_000;
const DOMAIN = "imageStats";

export interface StatsSaveTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const emptyCounts = (): ImageCounts => ({ memory: 0, disk: 0, upstream: 0 });
const emptySummary = (): ImageLayerSummary => ({
  catalog: emptyCounts(), library: emptyCounts(), remote: emptyCounts(), home: emptyCounts(),
});

interface Bucket extends ImageLayerSummary { at: string }

const isLayer = (value: string): value is ImageLayer => (LAYERS as readonly string[]).includes(value);
const isFrom = (value: string): value is ImageFrom => (FROMS as readonly string[]).includes(value);

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
  log("DEBUG", "Poster served", {
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
  private timer: unknown;
  private dirty = false;
  private chain: Promise<void> = Promise.resolve();
  private hourly?: HourlyCounts;
  private pending = new TrackedMap<string, HourlyRow>();
  private loaded = false;

  constructor(
    private readonly file: string,
    private readonly now = () => Date.now(),
    private readonly timers: StatsSaveTimers = {
      set: (run, ms) => setTimeout(run, ms).unref(),
      clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
  ) {}

  attachDatabase(database: AppDatabase): void {
    if (this.loaded) throw new Error("The image statistics database must be attached before load.");
    this.hourly = new HourlyCounts(database, DOMAIN);
  }

  async load(): Promise<void> {
    this.loaded = true;
    if (this.hourly) {
      await this.loadDatabase(this.hourly);
      return;
    }
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
    if (this.hourly) {
      const key = `${layer}.${from}`;
      this.pending.set(pairKey(at, key), { hour: at, key, count: bucket[layer][from] });
    }
    this.markDirty();
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

  /** A write nobody waits for: the next one carries the same counts, so a failure is only said. */
  private flushQuietly() {
    this.flush().catch((error: unknown) => log("WARN", "The image counts could not be saved", { file: path.basename(this.file), reason: String(error).slice(0, 200) }));
  }

  flush(): Promise<void> {
    if (this.timer) {
      this.timers.clear(this.timer);
      this.timer = undefined;
    }
    // Nothing new: wait for the write already under way, and make it again if that one failed --
    // shutdown is the last chance to save what it carried.
    if (!this.dirty) return this.chain.then(() => this.dirty ? this.flush() : undefined);
    this.dirty = false;
    const cutoff = this.now() - KEEP_MS;
    this.buckets = this.buckets.filter((bucket) => Date.parse(bucket.at) >= cutoff);
    const snapshot = this.pending.snapshot();
    const payload = this.hourly ? undefined : JSON.stringify(this.buckets);
    const write = this.chain.then(async () => {
      if (this.hourly) {
        const rows: HourlyRow[] = [];
        for (const key of snapshot.keys()) {
          const row = this.pending.get(key);
          if (row) rows.push(row);
        }
        await this.hourly.write(rows, new Date(cutoff).toISOString());
        this.pending.forget(snapshot);
        return;
      }
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      await writeFile(temp, payload!, { mode: 0o600 });
      await renameWithRetry(temp, this.file);
    }).catch((error: unknown) => {
      this.dirty = true;
      this.schedule();
      throw error;
    });
    // Chaining onto the rejection itself would skip every later write until a restart.
    this.chain = write.catch(() => undefined);
    return write;
  }

  private async loadDatabase(hourly: HourlyCounts): Promise<void> {
    if (await hourly.marker()) {
      this.buckets = this.bucketsFromRows(await hourly.load());
      await moveToMigrationBackup(this.file, path.dirname(this.file), `${this.backupStem()}-${this.now()}.json`);
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.file, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await hourly.writeMarker({ importedAt: this.now(), source: path.basename(this.file), count: 0 });
        return;
      }
      await this.markUnreadable(hourly, error);
      return;
    }
    if (!Array.isArray(raw)) {
      await this.markUnreadable(hourly, new Error("The image statistics are not an array."));
      return;
    }

    this.buckets = raw.flatMap((item) => this.readBucket(item));
    const rows = this.rowsFromBuckets();
    const importedAt = this.now();
    await hourly.import(rows, { importedAt, source: path.basename(this.file), count: rows.length });
    this.buckets = this.bucketsFromRows(rows);
    await moveToMigrationBackup(this.file, path.dirname(this.file), `${this.backupStem()}-${importedAt}.json`);
  }

  private async markUnreadable(hourly: HourlyCounts, error: unknown): Promise<void> {
    const importedAt = this.now();
    log("ERROR", "The image statistics could not be imported", { reason: String(error).slice(0, 200) });
    await moveToMigrationBackup(
      this.file,
      path.dirname(this.file),
      `${this.backupStem()}-unreadable-${importedAt}.json`,
    );
    await hourly.writeMarker({ importedAt, source: "unreadable", count: 0 });
    this.buckets = [];
  }

  private backupStem(): string {
    const name = path.basename(this.file);
    return name.endsWith(".json") ? name.slice(0, -5) : name;
  }

  private rowsFromBuckets(): HourlyRow[] {
    const rows = new Map<string, HourlyRow>();
    for (const bucket of this.buckets) {
      for (const layer of LAYERS) {
        for (const from of FROMS) {
          const count = bucket[layer][from];
          if (!(count > 0)) continue;
          const key = `${layer}.${from}`;
          const id = pairKey(bucket.at, key);
          const existing = rows.get(id);
          if (existing) existing.count += count;
          else rows.set(id, { hour: bucket.at, key, count });
        }
      }
    }
    return [...rows.values()];
  }

  private bucketsFromRows(rows: HourlyRow[]): Bucket[] {
    const byHour = new Map<string, Bucket>();
    for (const row of rows) {
      if (!(row.count > 0)) continue;
      const separator = row.key.indexOf(".");
      if (separator < 1 || separator !== row.key.lastIndexOf(".")) continue;
      const layer = row.key.slice(0, separator);
      const from = row.key.slice(separator + 1);
      if (!isLayer(layer) || !isFrom(from)) continue;
      let bucket = byHour.get(row.hour);
      if (!bucket) {
        bucket = { at: row.hour, ...emptySummary() };
        byHour.set(row.hour, bucket);
      }
      bucket[layer][from] += row.count;
    }
    return [...byHour.values()].sort((left, right) => left.at.localeCompare(right.at));
  }

  private markDirty() {
    this.dirty = true;
    this.schedule();
  }

  private schedule() {
    if (this.timer) return;
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      this.flushQuietly();
    }, SAVE_MS);
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

const pairKey = (hour: string, key: string) => `${hour}\u0000${key}`;

let active: ImageStats | undefined;

/** The process-wide counter. Tests leave it unset, so a picture request records nothing. */
export function useImageStats(stats: ImageStats | undefined): void {
  active = stats;
}

export function noteImage(layer: ImageLayer, from: ImageFrom): void {
  active?.record(layer, from);
}
