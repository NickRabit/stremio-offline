import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "./fs-retry.js";
import { log } from "./logger.js";

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

const emptySummary = (): ProviderCallSummary =>
  Object.fromEntries(PROVIDER_CALL_KINDS.map((kind) => [kind, 0])) as ProviderCallSummary;

interface Bucket extends ProviderCallSummary { at: string }

const isKind = (value: string): value is ProviderCallKind => (PROVIDER_CALL_KINDS as readonly string[]).includes(value);

/** Hourly counts of the calls this process put on the wire towards a media server. Written like
 *  the picture counts: one bucket per hour, kept for the statistics window and rewritten at most
 *  once a second while calls keep arriving. */
export class ProviderStats {
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

  record(kind: ProviderCallKind): void {
    const at = new Date(Math.floor(this.now() / HOUR) * HOUR).toISOString();
    let bucket = this.buckets.find((item) => item.at === at);
    if (!bucket) {
      bucket = { at, ...emptySummary() };
      this.buckets.push(bucket);
    }
    bucket[kind] += 1;
    this.dirty = true;
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; this.flushQuietly(); }, 1000);
      this.timer.unref?.();
    }
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
    if (!this.dirty) return this.chain;
    this.dirty = false;
    const cutoff = this.now() - KEEP_MS;
    this.buckets = this.buckets.filter((bucket) => Date.parse(bucket.at) >= cutoff);
    const payload = JSON.stringify(this.buckets);
    const write = this.chain.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      await writeFile(temp, payload, { mode: 0o600 });
      await renameWithRetry(temp, this.file);
    }).catch((error: unknown) => { this.dirty = true; throw error; });
    // Chaining onto the rejection itself would skip every later write until a restart.
    this.chain = write.catch(() => undefined);
    return write;
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

let active: ProviderStats | undefined;

/** The process-wide counter. Tests leave it unset, so a provider call records nothing. */
export function useProviderStats(stats: ProviderStats | undefined): void {
  active = stats;
}

export function noteProviderCall(kind: ProviderCallKind): void {
  active?.record(kind);
}
