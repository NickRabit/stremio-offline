import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ActivityLog, markerStatement, readMarker, writeMarker } from "./activity.js";
import { renameWithRetry } from "./fs-retry.js";
import { log } from "./logger.js";
import type { AppDatabase, Statement } from "./storage/app-database.js";
import { moveToMigrationBackup } from "./storage/hourly-counts.js";

/** Where the traffic flows from. The library reads a file from disk and so costs the line
 * nothing -- it is kept apart and not mixed into the external traffic figures. */
export type TrafficSource = "download" | "catalog" | "library";

export const SOURCE_LABEL: Record<TrafficSource, string> = {
  download: "Downloads",
  catalog: "Catalogue playback",
  library: "Library playback",
};

export const isExternal = (event: TrafficEvent) => event.source !== "library";

/** The description of one transfer. The bytes themselves arrive in pieces; this is what
 * gives them a name -- and the key the increments add up under. */
export interface TrafficMeta {
  source: TrafficSource;
  provider: string;
  addonKey?: string;
  addonName?: string;
  title: string;
  kind: "movie" | "episode" | "other";
}

export interface TrafficEvent extends TrafficMeta {
  at: string;
  bytes: number;
  /** How many finished items the entry stands for. Running increments carry zero, or one
   * film would be counted once per write made during it. */
  items: number;
}

/** One host a grouped row stands for. `items` rather than `count`: it is the number of
 *  finished transfers recorded on that host, not a bucket count. */
export interface BucketHost { key: string; label: string; bytes: number; items: number }
export interface Bucket {
  key: string; label: string; bytes: number; count: number;
  /** The concrete hosts this row groups, largest first. Absent when the row is
   *  not a provider row, or when it groups exactly one host. */
  hosts?: BucketHost[];
}
export interface Series { key: string; label: string; points: number[] }
export interface Window { bytes: number; count: number }
export type Step = "minute" | "hour" | "day";

export interface Summary {
  hour: Window; day: Window; week: Window; month: Window; total: Window;
  step: Step;
  /** `day`, on a day bar only: the calendar date the bar counts, in the server's own zone. The
   *  instant in `at` is that day's local midnight, which a viewer in another zone would read
   *  as the day before or after. */
  points: Array<{ at: string; day?: string; bytes: number; count: number }>;
  providers: Bucket[];
  addons: Bucket[];
  sources: Bucket[];
  byProvider: Series[];
  byAddon: Series[];
  bySource: Series[];
  since?: string;
}

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

/** The chart step follows the period: an hour in five-minute bars, a day in hours, longer in days. */
const stepFor = (hours: number): Step => hours <= 1 ? "minute" : hours <= 24 ? "hour" : "day";

/** Bar boundaries. Days advance through setDate rather than by adding 24 hours --
 * otherwise the series would slip by an hour across a daylight-saving change. */
function boundaries(hours: number, now: Date) {
  const step = stepFor(hours);
  if (step === "day") {
    const days = Math.max(1, Math.round(hours / 24));
    const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (days - 1));
    return Array.from({ length: days }, (_, index) => { const at = new Date(start); at.setDate(at.getDate() + index); return at.getTime(); });
  }
  const size = step === "minute" ? 5 * MINUTE : HOUR;
  const count = Math.max(1, Math.ceil((hours * HOUR) / size));
  const end = Math.floor(now.getTime() / size) * size;
  return Array.from({ length: count }, (_, index) => end - (count - 1 - index) * size);
}

/** The last boundary that is not yet past the time of the event. */
const slot = (edges: number[], at: number) => {
  if (at < edges[0]) return -1;
  let low = 0, high = edges.length - 1;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (edges[middle] <= at) low = middle; else high = middle - 1; }
  return low;
};

const window = (events: TrafficEvent[], from: number): Window => {
  let bytes = 0; let count = 0;
  for (const event of events) if (Date.parse(event.at) >= from) { bytes += event.bytes; count += event.items; }
  return { bytes, count };
};

/** Under a country code this function does not guess. Two attempts were made and both
 *  merged unrelated operators into one row: a list of whole suffixes missed `com.tr`, and a
 *  list of the labels a registry sells under missed `id.au`. Neither list can be completed
 *  without the Public Suffix List, and a row that sums two strangers under a name neither
 *  of them owns is worse than a row per host -- the count and the trend both become
 *  fiction. So a two-letter last label means the host is kept whole; the shortening the
 *  page needed comes from the eight-row cap, not from guessing.
 *
 *  What is left is a private suffix under a generic top level -- `a.blogspot.com` and
 *  `b.blogspot.com` still share a row. That needs the Public Suffix List to fix, which is a
 *  dependency this has not taken. */
const COUNTRY_CODE = /^[a-z]{2}$/i;

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** The name the outside world knows a host by: its last two labels, or three under a
 *  multi-part suffix. Anything that is not a name -- a bare machine, an address
 *  literal, an empty string -- comes back unchanged, as does a host with a single
 *  label such as the `knihovna` used for playback from the library. */
export function registrableDomain(host: string): string {
  const name = host.replace(/\.+$/, "");
  if (!name || name.includes(":") || IPV4.test(name)) return host;
  const labels = name.split(".");
  if (labels.length < 2) return host;
  // A country code is where the guessing goes wrong, so it is where the guessing stops.
  if (COUNTRY_CODE.test(labels.at(-1)!)) return name;
  return labels.slice(-2).join(".");
}

const identify = {
  provider: (event: TrafficEvent) => {
    const domain = registrableDomain(event.provider);
    return { key: domain, label: domain };
  },
  addon: (event: TrafficEvent) => ({ key: event.addonKey ?? event.provider, label: event.addonName ?? event.provider }),
  source: (event: TrafficEvent) => ({ key: event.source, label: SOURCE_LABEL[event.source] }),
};

/** The summary for the chosen number of hours. The windows (hour, day, week, month) are
 * computed independently of it, so the cards show the same thing whatever period is picked.
 *
 * The cards, the bar chart and the breakdowns by source and addon speak only of external
 * traffic; library playback shows up solely in the breakdown by traffic kind, from where it
 * can be added to the chart as a line of its own. */
export function summarize(events: TrafficEvent[], hours = 720, now = new Date()): Summary {
  const span = Math.max(1, Math.min(24 * 365, hours));
  const edges = boundaries(span, now);

  const step = stepFor(span);
  const localDay = (at: Date) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  const points = edges.map((at) => ({ at: new Date(at).toISOString(), ...(step === "day" ? { day: localDay(new Date(at)) } : {}), bytes: 0, count: 0 }));
  const totals = { provider: new Map<string, Bucket>(), addon: new Map<string, Bucket>(), source: new Map<string, Bucket>() };
  const lines = { provider: new Map<string, Series>(), addon: new Map<string, Series>(), source: new Map<string, Series>() };
  /** The hosts behind each provider row, kept so the interface can open the row. */
  const providerHosts = new Map<string, Map<string, BucketHost>>();

  for (const event of events) {
    const at = Date.parse(event.at);
    if (Number.isNaN(at)) continue;
    const index = slot(edges, at);
    if (index < 0) continue;

    const external = isExternal(event);
    if (external) { points[index].bytes += event.bytes; points[index].count += event.items; }

    for (const kind of (external ? ["provider", "addon", "source"] : ["source"]) as Array<keyof typeof totals>) {
      const { key, label } = identify[kind](event);
      const bucket = totals[kind].get(key) ?? { key, label, bytes: 0, count: 0 };
      bucket.bytes += event.bytes; bucket.count += event.items;
      totals[kind].set(key, bucket);

      const line = lines[kind].get(key) ?? { key, label, points: new Array(edges.length).fill(0) };
      line.points[index] += event.bytes;
      lines[kind].set(key, line);

      if (kind === "provider") {
        const hosts = providerHosts.get(key) ?? new Map();
        const host = hosts.get(event.provider) ?? { key: event.provider, label: event.provider, bytes: 0, items: 0 };
        host.bytes += event.bytes; host.items += event.items;
        hosts.set(event.provider, host);
        providerHosts.set(key, hosts);
      }
    }
  }

  const ranked = (map: Map<string, Bucket>) => [...map.values()].sort((a, b) => b.bytes - a.bytes);
  const ordered = (map: Map<string, Series>, order: Bucket[]) => order.map((bucket) => map.get(bucket.key)!).filter(Boolean);
  const providers = ranked(totals.provider);
  const addons = ranked(totals.addon);
  const sources = ranked(totals.source);
  const external = events.filter(isExternal);
  for (const provider of providers) {
    const hosts = providerHosts.get(provider.key);
    if (hosts && hosts.size > 1) provider.hosts = [...hosts.values()].sort((a, b) => b.bytes - a.bytes);
  }

  return {
    hour: window(external, now.getTime() - HOUR),
    day: window(external, now.getTime() - DAY),
    week: window(external, now.getTime() - 7 * DAY),
    month: window(external, now.getTime() - 30 * DAY),
    total: window(external, 0),
    step,
    points,
    providers,
    addons,
    sources,
    byProvider: ordered(lines.provider, providers),
    byAddon: ordered(lines.addon, addons),
    bySource: ordered(lines.source, sources),
    since: events.reduce<string | undefined>((oldest, event) => (!oldest || event.at < oldest ? event.at : oldest), undefined),
  };
}

/** Older entries are merged by the hour. The chart shows a finer step than an hour only for
 * the last 24 hours, so the merge loses nothing and the file stops growing with the length
 * of the transfers. */
export function compact(events: TrafficEvent[], before: number): TrafficEvent[] {
  return compactWithChange(events, before).events;
}

interface Compaction {
  events: TrafficEvent[];
  changed: boolean;
  origins: Map<TrafficEvent, TrafficEvent>;
  covered: Set<TrafficEvent>;
}

function compactWithChange(events: TrafficEvent[], before: number): Compaction {
  const merged = new Map<string, { event: TrafficEvent; origin: TrafficEvent; count: number }>();
  const recent: Array<{ event: TrafficEvent; origin: TrafficEvent }> = [];
  const covered = new Set<TrafficEvent>();
  for (const event of events) {
    const at = Date.parse(event.at);
    if (Number.isNaN(at) || at >= before) { recent.push({ event, origin: event }); continue; }
    covered.add(event);
    const hour = Math.floor(at / HOUR) * HOUR;
    const key = `${hour}|${event.source}|${event.provider}|${event.addonKey ?? ""}|${event.title}|${event.kind}`;
    const bucket = merged.get(key);
    if (bucket) {
      bucket.event.bytes += event.bytes;
      bucket.event.items += event.items;
      bucket.count += 1;
    } else {
      merged.set(key, {
        event: { ...event, at: new Date(hour).toISOString() },
        origin: event,
        count: 1,
      });
    }
  }

  const changed = [...merged.values()].some((bucket) =>
    bucket.count > 1 || bucket.event.at !== bucket.origin.at);
  if (!changed) return { events, changed: false, origins: new Map(), covered: new Set() };

  const origins = new Map<TrafficEvent, TrafficEvent>();
  const compacted = [...merged.values()].map((bucket) => {
    origins.set(bucket.event, bucket.origin);
    return bucket.event;
  });
  const kept = recent.map((item) => {
    origins.set(item.event, item.origin);
    return item.event;
  });
  return {
    events: [...compacted, ...kept].sort((a, b) => a.at.localeCompare(b.at)),
    changed: true,
    origins,
    covered,
  };
}

/** The oldest entries are dropped so the file does not grow without bound. */
const LIMIT = 20_000;
/** How often the collected increments are saved. The finest chart step is five minutes,
 * so a minute is fine enough while the file is not written constantly. */
const FLUSH_MS = 60_000;

export interface StatsLogOptions {
  limit?: number;
}

interface TrafficRow {
  seq: number;
  at: string;
  source: TrafficSource;
  provider: string;
  addon_key: string | null;
  addon_name: string | null;
  title: string;
  kind: TrafficEvent["kind"];
  bytes: number;
  items: number;
}

const DOMAIN = "traffic";
const INSERT = "INSERT INTO traffic_events (seq, at, source, provider, addon_key, addon_name, title, kind, bytes, items) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (seq) DO NOTHING";

export class StatsLog {
  private events: TrafficEvent[] = [];
  private seqs = new WeakMap<TrafficEvent, number>();
  private attemptedSeqs = new WeakMap<TrafficEvent, number>();
  private unsavedEvents = new Set<TrafficEvent>();
  private nextSeq = 1;
  private generation = 0;
  /** Increments in progress that have no entry of their own yet. */
  private pending = new Map<string, { meta: TrafficMeta; bytes: number; items: number }>();
  private file: string;
  private chain: Promise<void> = Promise.resolve();
  private unsaved = false;
  private timer?: NodeJS.Timeout;
  private compactedAt = 0;
  private loaded = false;
  private database?: AppDatabase;
  private readonly limit: number;

  readonly activity: ActivityLog;

  constructor(dataDir = process.env.DATA_DIR ?? "/data", options: StatsLogOptions = {}) {
    this.file = path.join(dataDir, "stats.json");
    this.activity = new ActivityLog(dataDir);
    this.limit = options.limit ?? LIMIT;
  }

  attachDatabase(database: AppDatabase): void {
    if (this.loaded) throw new Error("The traffic database must be attached before load.");
    this.database = database;
    this.activity.attachDatabase(database);
  }

  async load() {
    this.loaded = true;
    await this.activity.load();
    if (this.database) {
      await this.loadDatabase(this.database);
      this.startTimer();
      return this.events.length;
    }
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const stored: Array<Partial<TrafficEvent>> = JSON.parse(await readFile(this.file, "utf8"));
      // An older file knows only finished downloads and has neither the source nor the items field.
      this.events = stored.map((event) => ({ ...event, source: event.source ?? "download", items: event.items ?? 1 } as TrafficEvent));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // The timer holds pending increments for at most a minute; unref so it does not keep
    // the server alive when it wants to exit.
    this.startTimer();
    return this.events.length;
  }

  /** Fills in history from the queue only where our own record does not reach. From the moment
   * stats.json came into being it is complete, so only older jobs can be missing -- and only
   * those are added, so nothing already written is duplicated. */
  async seed(events: TrafficEvent[]) {
    const oldest = this.events.reduce<string | undefined>((found, event) => (!found || event.at < found ? event.at : found), undefined);
    const missing = events.filter((event) => !oldest || event.at < oldest);
    if (!missing.length) return 0;
    this.events = [...this.events, ...missing].sort((a, b) => a.at.localeCompare(b.at));
    this.markUnsaved(missing);
    await this.save();
    return missing.length;
  }

  /** Adds transferred bytes to a transfer in progress; they are written at the next save. */
  add(meta: TrafficMeta, bytes: number) {
    if (bytes <= 0) return;
    this.bucket(meta).bytes += bytes;
  }

  /** A finished item. Saved at once, so a completed download shows in the statistics right away. */
  complete(meta: TrafficMeta, bytes = 0) {
    const bucket = this.bucket(meta);
    bucket.bytes += Math.max(0, bytes);
    bucket.items += 1;
    return this.flush();
  }

  private bucket(meta: TrafficMeta) {
    const key = `${meta.source}|${meta.provider}|${meta.addonKey ?? ""}|${meta.title}|${meta.kind}`;
    const found = this.pending.get(key);
    if (found) return found;
    const fresh = { meta, bytes: 0, items: 0 };
    this.pending.set(key, fresh);
    return fresh;
  }

  /** A write nobody waits for: the next one carries the same entries, so a failure is only said. */
  private flushQuietly() {
    this.flush().catch((error: unknown) => log("WARN", "The traffic statistics could not be saved", { file: path.basename(this.file), reason: String(error).slice(0, 200) }));
  }

  /** Pending increments are turned into entries stamped with the time the traffic actually flowed. */
  flush() {
    if (!this.pending.size) return this.chain.then(() => this.unsaved ? this.save() : undefined);
    const at = new Date().toISOString();
    const appended: TrafficEvent[] = [];
    for (const { meta, bytes, items } of this.pending.values()) {
      if (bytes || items) {
        const event = { ...meta, at, bytes, items };
        this.events.push(event);
        appended.push(event);
      }
    }
    this.pending.clear();
    this.markUnsaved(appended);
    return this.save();
  }

  summary(hours: number) { this.flushQuietly(); return summarize(this.events, hours); }

  private save() {
    const now = Date.now();
    const write = this.chain.then(async () => {
      if (this.database) return await this.writeDatabase(this.database, now);
      if (now - this.compactedAt > HOUR) { this.events = compact(this.events, now - DAY); this.compactedAt = now; }
      if (this.events.length > this.limit) this.events = this.events.slice(-this.limit);
      const temp = `${this.file}.tmp`;
      await writeFile(temp, JSON.stringify(this.events), { mode: 0o600 });
      await renameWithRetry(temp, this.file);
      this.unsaved = false;
    }).catch((error: unknown) => { this.unsaved = true; throw error; });
    // Chaining onto the rejection itself would skip every later write until a restart.
    this.chain = write.catch(() => undefined);
    return write;
  }

  private async writeDatabase(database: AppDatabase, now: number): Promise<void> {
    if (!this.unsaved) return;
    const base = this.events.slice();
    const baseGeneration = this.generation;
    const before = now - DAY;
    const compaction = now - this.compactedAt > HOUR
      ? compactWithChange(base, before)
      : { events: base, changed: false, origins: new Map<TrafficEvent, TrafficEvent>(), covered: new Set<TrafficEvent>() };
    const next = compaction.events.length > this.limit
      ? compaction.events.slice(-this.limit)
      : compaction.events;
    const trim = Math.max(0, compaction.events.length - this.limit);
    const statements: Statement[] = [];
    const written = new Map<TrafficEvent, number>();
    const replacements = new Map<TrafficEvent, number>();
    const compactionWrites = new Set<TrafficEvent>();

    if (compaction.changed) {
      statements.push({
        sql: "DELETE FROM traffic_events WHERE at < ?",
        params: [new Date(before).toISOString()],
      });
      for (const event of compaction.events) {
        const at = Date.parse(event.at);
        if (Number.isNaN(at) || at >= before) continue;
        const origin = compaction.origins.get(event) ?? event;
        const seq = this.unsavedEvents.has(origin) ? this.assignSeq(origin) : this.seqs.get(origin);
        if (seq === undefined) continue;
        replacements.set(event, seq);
        compactionWrites.add(origin);
        written.set(origin, seq);
        statements.push({ sql: INSERT, params: trafficParams(seq, event) });
      }
    }

    const unsaved = [...this.unsavedEvents];
    for (const event of unsaved) {
      if (compactionWrites.has(event)) continue;
      const at = Date.parse(event.at);
      if (compaction.changed && !Number.isNaN(at) && at < before) continue;
      const seq = this.assignSeq(event);
      written.set(event, seq);
      statements.push({ sql: INSERT, params: trafficParams(seq, event) });
    }

    if (trim > 0) {
      statements.push({
        sql: "DELETE FROM traffic_events WHERE seq IN (SELECT seq FROM traffic_events ORDER BY seq LIMIT ?)",
        params: [trim],
      });
    }

    if (statements.length) await database.batch(statements);
    this.events = [...next, ...this.events.slice(base.length)];
    for (const [event, seq] of written) {
      this.seqs.set(event, seq);
      this.attemptedSeqs.delete(event);
      this.unsavedEvents.delete(event);
    }
    for (const [event, seq] of replacements) this.seqs.set(event, seq);
    for (const event of compaction.covered) {
      this.unsavedEvents.delete(event);
      this.attemptedSeqs.delete(event);
    }
    if (now - this.compactedAt > HOUR) this.compactedAt = now;
    this.unsaved = this.generation !== baseGeneration || this.unsavedEvents.size > 0;
  }

  private markUnsaved(events: TrafficEvent[]): void {
    if (this.database) for (const event of events) this.unsavedEvents.add(event);
    this.generation += 1;
    this.unsaved = true;
  }

  private assignSeq(event: TrafficEvent): number {
    const assigned = this.attemptedSeqs.get(event);
    if (assigned !== undefined) return assigned;
    const seq = this.nextSeq++;
    this.attemptedSeqs.set(event, seq);
    return seq;
  }

  private async loadDatabase(database: AppDatabase): Promise<void> {
    const marker = await readMarker(database, DOMAIN);
    if (marker) {
      await this.loadRows(database);
      await moveToMigrationBackup(this.file, path.dirname(this.file), `${this.backupStem()}-${Date.now()}.json`);
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.file, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await writeMarker(database, DOMAIN, { importedAt: Date.now(), source: path.basename(this.file), count: 0 });
        return;
      }
      await this.markUnreadable(database, error);
      return;
    }
    if (!Array.isArray(raw)) {
      await this.markUnreadable(database, new Error("The traffic statistics are not an array."));
      return;
    }

    const rows = (raw as Array<Partial<TrafficEvent>>).map((event) => ({
      ...event,
      source: event.source ?? "download",
      items: event.items ?? 1,
    } as TrafficEvent));
    const importedAt = Date.now();
    const statements: Statement[] = rows.map((event, index) => ({
      sql: INSERT,
      params: trafficParams(index + 1, event),
    }));
    statements.push(markerStatement(DOMAIN, { importedAt, source: path.basename(this.file), count: rows.length }));
    await database.batch(statements);
    await this.loadRows(database);
    await moveToMigrationBackup(this.file, path.dirname(this.file), `${this.backupStem()}-${importedAt}.json`);
  }

  private async markUnreadable(database: AppDatabase, error: unknown): Promise<void> {
    const importedAt = Date.now();
    log("ERROR", "The traffic statistics could not be imported", { reason: String(error).slice(0, 200) });
    await moveToMigrationBackup(
      this.file,
      path.dirname(this.file),
      `${this.backupStem()}-unreadable-${importedAt}.json`,
    );
    await writeMarker(database, DOMAIN, { importedAt, source: "unreadable", count: 0 });
    this.events = [];
  }

  private async loadRows(database: AppDatabase): Promise<void> {
    const rows = await database.all<TrafficRow>(
      "SELECT seq, at, source, provider, addon_key, addon_name, title, kind, bytes, items FROM traffic_events ORDER BY seq",
    );
    this.events = rows.map((row) => {
      const event: TrafficEvent = {
        at: row.at,
        source: row.source,
        provider: row.provider,
        ...(row.addon_key === null ? {} : { addonKey: row.addon_key }),
        ...(row.addon_name === null ? {} : { addonName: row.addon_name }),
        title: row.title,
        kind: row.kind,
        bytes: row.bytes,
        items: row.items,
      };
      this.seqs.set(event, row.seq);
      return event;
    });
    this.nextSeq = rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1;
  }

  private backupStem(): string {
    const name = path.basename(this.file);
    return name.endsWith(".json") ? name.slice(0, -5) : name;
  }

  private startTimer(): void {
    if (!this.timer) { this.timer = setInterval(() => this.flushQuietly(), FLUSH_MS); this.timer.unref(); }
  }
}

function trafficParams(seq: number, event: TrafficEvent) {
  return [
    seq,
    event.at,
    event.source,
    event.provider,
    event.addonKey ?? null,
    event.addonName ?? null,
    event.title,
    event.kind,
    event.bytes,
    event.items,
  ];
}
