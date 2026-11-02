import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "./fs-retry.js";
import { log } from "./logger.js";
import type { StatsSaveTimers } from "./image-stats.js";
import type { AppDatabase } from "./storage/app-database.js";
import { HourlyCounts, moveToMigrationBackup, type HourlyRow } from "./storage/hourly-counts.js";
import { TrackedMap } from "./storage/tracked-map.js";

/** One request the app put on the wire towards an Emby or Jellyfin server. The transport names
 *  the operation, so a count is a call that left this process: what it answered from its own
 *  cache, or refused before the request was built, is not counted. `detail`/`ancestors`/`versions`
 *  are the reads behind an opened title, `playbackInfo` is one stream-admission question,
 *  `directory` and `items` are listings, `artwork` is one picture, and `playback` is one
 *  playback-session report. */
export type ProviderCallKind =
  | "info" | "login" | "user" | "views" | "items" | "directory" | "match"
  | "detail" | "ancestors" | "versions" | "playbackInfo"
  | "artwork" | "subtitle" | "original" | "playback" | "logout";

export const PROVIDER_CALL_KINDS: readonly ProviderCallKind[] = [
  "info", "login", "user", "views", "items", "directory", "match",
  "detail", "ancestors", "versions", "playbackInfo",
  "artwork", "subtitle", "original", "playback", "logout",
];

export type ProviderCallSummary = Record<ProviderCallKind, number>;

const HOUR = 60 * 60 * 1000;
const KEEP_MS = 400 * 24 * HOUR;
const SAVE_MS = 45_000;
const DOMAIN = "providerStats";

const emptySummary = (): ProviderCallSummary =>
  Object.fromEntries(PROVIDER_CALL_KINDS.map((kind) => [kind, 0])) as ProviderCallSummary;

interface Bucket extends ProviderCallSummary { at: string }

const isKind = (value: string): value is ProviderCallKind => (PROVIDER_CALL_KINDS as readonly string[]).includes(value);

/** Hourly counts of the calls this process put on the wire towards a media server. Written like
 *  the picture counts: one bucket per hour, kept for the statistics window and rewritten at most
 *  once a second while calls keep arriving. */
export class ProviderStats {
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
    if (this.loaded) throw new Error("The provider statistics database must be attached before load.");
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

  record(kind: ProviderCallKind): void {
    const at = new Date(Math.floor(this.now() / HOUR) * HOUR).toISOString();
    let bucket = this.buckets.find((item) => item.at === at);
    if (!bucket) {
      bucket = { at, ...emptySummary() };
      this.buckets.push(bucket);
    }
    bucket[kind] += 1;
    if (this.hourly) this.pending.set(pairKey(at, kind), { hour: at, key: kind, count: bucket[kind] });
    this.markDirty();
  }

  /** Counts whose hour starts inside the window, the same window the activity summary uses. */
  summary(hours: number, now = this.now()): ProviderCallSummary {
    const from = now - Math.max(0, hours) * HOUR;
    const out = emptySummary();
    for (const bucket of this.buckets) {
      const at = Date.parse(bucket.at);
      if (!Number.isFinite(at) || at < from) continue;
      for (const kind of PROVIDER_CALL_KINDS) out[kind] += bucket[kind];
    }
    return out;
  }

  /** A write nobody waits for: the next one carries the same counts, so a failure is only said. */
  private flushQuietly() {
    this.flush().catch((error: unknown) => log("WARN", "The provider call counts could not be saved", { file: path.basename(this.file), reason: String(error).slice(0, 200) }));
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
      await this.markUnreadable(hourly, new Error("The provider statistics are not an array."));
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
    log("ERROR", "The provider statistics could not be imported", { reason: String(error).slice(0, 200) });
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
      for (const kind of PROVIDER_CALL_KINDS) {
        const count = bucket[kind];
        if (!(count > 0)) continue;
        const id = pairKey(bucket.at, kind);
        const existing = rows.get(id);
        if (existing) existing.count += count;
        else rows.set(id, { hour: bucket.at, key: kind, count });
      }
    }
    return [...rows.values()];
  }

  private bucketsFromRows(rows: HourlyRow[]): Bucket[] {
    const byHour = new Map<string, Bucket>();
    for (const row of rows) {
      if (!(row.count > 0) || !isKind(row.key)) continue;
      let bucket = byHour.get(row.hour);
      if (!bucket) {
        bucket = { at: row.hour, ...emptySummary() };
        byHour.set(row.hour, bucket);
      }
      bucket[row.key] += row.count;
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
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      if (isKind(key) && typeof value === "number" && Number.isFinite(value) && value > 0) counts[key] = value;
    }
    return [{ at, ...counts }];
  }
}

const pairKey = (hour: string, key: string) => `${hour}\u0000${key}`;

let active: ProviderStats | undefined;

/** The process-wide counter. Tests leave it unset, so a provider call records nothing. */
export function useProviderStats(stats: ProviderStats | undefined): void {
  active = stats;
}

export function noteProviderCall(kind: ProviderCallKind): void {
  active?.record(kind);
}
