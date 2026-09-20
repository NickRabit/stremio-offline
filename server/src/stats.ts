import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

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
  points: Array<{ at: string; bytes: number; count: number }>;
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

/** The second-level labels a country registry sells under, rather than a list of whole
 *  suffixes. A list of suffixes was tried and got the failure direction backwards: an
 *  unlisted one such as `com.tr` fell through to the last two labels, so `film.com.tr` and
 *  `dizi.com.tr` became one row called `com.tr` -- every site in a country summed into a
 *  stranger. Reading the shape instead covers every ccTLD at once, listed or not. */
const REGISTRY_LABELS = new Set(["com", "co", "net", "org", "edu", "gov", "ac", "mil", "or", "ne", "gob", "nom"]);

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
  // `x.co.uk` and `x.com.tr` are three labels deep because the registry sells under the
  // second one; `x.strem.fun` and `x.real-debrid.com` are two, because `fun` and `com` are
  // not country codes. A two-letter last label is the ccTLD test.
  const [second, last] = [labels.at(-2)!, labels.at(-1)!];
  const underRegistry = labels.length > 2 && last.length === 2 && REGISTRY_LABELS.has(second);
  return labels.slice(underRegistry ? -3 : -2).join(".");
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

  const points = edges.map((at) => ({ at: new Date(at).toISOString(), bytes: 0, count: 0 }));
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
    step: stepFor(span),
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
  const merged = new Map<string, TrafficEvent>();
  const recent: TrafficEvent[] = [];
  for (const event of events) {
    const at = Date.parse(event.at);
    if (Number.isNaN(at) || at >= before) { recent.push(event); continue; }
    const hour = Math.floor(at / HOUR) * HOUR;
    const key = `${hour}|${event.source}|${event.provider}|${event.addonKey ?? ""}|${event.title}|${event.kind}`;
    const bucket = merged.get(key);
    if (bucket) { bucket.bytes += event.bytes; bucket.items += event.items; }
    else merged.set(key, { ...event, at: new Date(hour).toISOString() });
  }
  if (!merged.size) return events;
  return [...merged.values(), ...recent].sort((a, b) => a.at.localeCompare(b.at));
}

/** The oldest entries are dropped so the file does not grow without bound. */
const LIMIT = 20_000;
/** How often the collected increments are saved. The finest chart step is five minutes,
 * so a minute is fine enough while the file is not written constantly. */
const FLUSH_MS = 60_000;

export class StatsLog {
  private events: TrafficEvent[] = [];
  /** Increments in progress that have no entry of their own yet. */
  private pending = new Map<string, { meta: TrafficMeta; bytes: number; items: number }>();
  private file: string;
  private chain: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private compactedAt = 0;

  constructor(dataDir = process.env.DATA_DIR ?? "/data") { this.file = path.join(dataDir, "stats.json"); }

  async load() {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const stored: Array<Partial<TrafficEvent>> = JSON.parse(await readFile(this.file, "utf8"));
      // An older file knows only finished downloads and has neither the source nor the items field.
      this.events = stored.map((event) => ({ ...event, source: event.source ?? "download", items: event.items ?? 1 } as TrafficEvent));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // The timer holds pending increments for at most a minute; unref so it does not keep
    // the server alive when it wants to exit.
    if (!this.timer) { this.timer = setInterval(() => void this.flush(), FLUSH_MS); this.timer.unref(); }
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

  /** Pending increments are turned into entries stamped with the time the traffic actually flowed. */
  flush() {
    if (!this.pending.size) return this.chain;
    const at = new Date().toISOString();
    for (const { meta, bytes, items } of this.pending.values()) {
      if (bytes || items) this.events.push({ ...meta, at, bytes, items });
    }
    this.pending.clear();
    return this.save();
  }

  summary(hours: number) { this.flush(); return summarize(this.events, hours); }

  private save() {
    const now = Date.now();
    if (now - this.compactedAt > HOUR) { this.events = compact(this.events, now - DAY); this.compactedAt = now; }
    if (this.events.length > LIMIT) this.events = this.events.slice(-LIMIT);
    this.chain = this.chain.then(async () => {
      const temp = `${this.file}.tmp`;
      await writeFile(temp, JSON.stringify(this.events), { mode: 0o600 });
      await rename(temp, this.file);
    });
    return this.chain;
  }
}
