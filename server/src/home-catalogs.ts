import { catalogWithExtras } from "./addons.js";
import { homeCatalogSelectionKey } from "./home.js";
import { log } from "./logger.js";
import type { AddonRecord, CatalogDefinition, MetaItem } from "./types.js";

export type HomeCatalogFetch = (addon: AddonRecord, type: string, catalogId: string, extras: Record<string, string | number>) => Promise<MetaItem[]>;

/** One Home shelf an addon feeds: the addon and the catalogue it reads. */
export interface HomeCatalogTarget { addon: AddonRecord; definition: CatalogDefinition }

/** Every catalogue an addon puts on Home, before any account's grants are applied. */
export function homeCatalogTargets(addons: AddonRecord[]): HomeCatalogTarget[] {
  const targets: HomeCatalogTarget[] = [];
  for (const addon of addons) {
    if (!addon.enabled || addon.role === "source" || addon.showOnHome === false) continue;
    for (const definition of addon.manifest.catalogs ?? []) {
      if (addon.homeCatalogs !== undefined && !addon.homeCatalogs.includes(homeCatalogSelectionKey(definition.type, definition.id))) continue;
      targets.push({ addon, definition });
    }
  }
  return targets;
}

/** The extras a catalogue refuses to answer without: `skip` starts at zero, anything else
 *  takes its first declared option. */
export function homeCatalogExtras(definition: CatalogDefinition): Record<string, string | number> {
  const rawRequired = definition.extraRequired as unknown;
  const requiredNames = Array.isArray(rawRequired)
    ? rawRequired.filter((name): name is string => typeof name === "string")
    : typeof rawRequired === "string" ? [rawRequired] : [];
  // A remote manifest is not validated: anything but a list of extras declares none.
  const declared = Array.isArray(definition.extra) ? definition.extra.filter((extra) => extra && typeof extra === "object") : [];
  const required = new Set([...requiredNames, ...declared.filter((extra) => extra.isRequired).map((extra) => extra.name)]);
  const extras: Record<string, string | number> = {};
  for (const extra of required) {
    if (extra === "skip") extras.skip = 0;
    else {
      const options = declared.find((candidate) => candidate.name === extra)?.options;
      const option = Array.isArray(options) ? options[0] : undefined;
      if (option) extras[extra] = option;
    }
  }
  return extras;
}

interface Entry { items: MetaItem[]; at: number }

export interface HomeCatalogCacheOptions {
  /** An answer younger than this is served without asking the addon again. */
  freshMs?: number;
  /** An older one is still served at once while a refresh runs behind it, up to this age. */
  keepMs?: number;
  maxEntries?: number;
  /** Requests one addon answers at a time; Home with every Cinemeta feed is a dozen at once. */
  perAddon?: number;
  now?: () => number;
}

/** Home's addon shelves, remembered between visits. A catalogue changes over hours, so the
 *  page draws what was fetched last and refreshes it behind the answer; a lookup that outlives
 *  the page's deadline keeps running and lands here for the next request instead of being lost.
 *  Shared by every account: grants decide which shelves an account is shown, never their
 *  content. */
export class HomeCatalogCache {
  private entries = new Map<string, Entry>();
  private inFlight = new Map<string, Promise<MetaItem[]>>();
  private active = new Map<string, number>();
  private waiting = new Map<string, Array<() => void>>();
  private readonly freshMs: number;
  private readonly keepMs: number;
  private readonly maxEntries: number;
  private readonly perAddon: number;
  private readonly now: () => number;
  private visitedAt: number;

  constructor(private readonly fetch: HomeCatalogFetch = (addon, type, id, extras) => catalogWithExtras(addon, type, id, extras), options: HomeCatalogCacheOptions = {}) {
    this.freshMs = options.freshMs ?? 20 * 60_000;
    this.keepMs = options.keepMs ?? 12 * 60 * 60_000;
    this.maxEntries = options.maxEntries ?? 400;
    this.perAddon = options.perAddon ?? 6;
    this.now = options.now ?? Date.now;
    this.visitedAt = this.now();
  }

  /** The manifest URL carries an addon's configuration, so it names the content; the key alone
   *  would keep serving a reinstalled addon's old answers. */
  private key({ addon, definition }: HomeCatalogTarget) {
    return JSON.stringify([addon.manifestUrl, definition.type, definition.id, homeCatalogExtras(definition)]);
  }

  /** What is remembered for this shelf, fresh or not, without asking the addon. */
  peek(target: HomeCatalogTarget): { items: MetaItem[]; fresh: boolean } | undefined {
    const key = this.key(target);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const age = this.now() - entry.at;
    if (age > this.keepMs) { this.entries.delete(key); return undefined; }
    return { items: entry.items, fresh: age <= this.freshMs };
  }

  /** Asks the addon, once per shelf however many requests want it at the same moment. */
  load(target: HomeCatalogTarget): Promise<MetaItem[]> {
    const key = this.key(target);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const slot = target.addon.key;
    const started = (async () => {
      await this.acquire(slot);
      try {
        const items = await this.fetch(target.addon, target.definition.type, target.definition.id, homeCatalogExtras(target.definition));
        this.store(key, items);
        return items;
      } finally {
        this.release(slot);
      }
    })().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, started);
    return started;
  }

  /** A refresh nobody waits for: a failure keeps the older answer and costs a log line. */
  refresh(target: HomeCatalogTarget): void {
    this.load(target).catch((error: unknown) => log("DEBUG", "A Home catalogue refresh failed", {
      addon: target.addon.manifest.name, catalog: `${target.definition.type}/${target.definition.id}`,
      reason: error instanceof Error ? error.message : String(error),
    }));
  }

  /** Fills every shelf that is missing or stale, so the first visit after a start or after a
   *  quiet hour draws from memory. */
  warm(targets: HomeCatalogTarget[]): void {
    for (const target of targets) if (!this.peek(target)?.fresh) this.refresh(target);
  }

  /** Home was opened: the shelves below the fold are fetched before anybody scrolls to them. */
  visited(targets: HomeCatalogTarget[]): void {
    this.visitedAt = this.now();
    this.warm(targets);
  }

  /** The periodic warm-up keeps going only while somebody uses Home; an instance nobody opens
   *  does not ask its addons every few minutes. A fresh start counts as recent. */
  get idle(): boolean {
    return this.now() - this.visitedAt > this.keepMs;
  }

  /** How often a warm-up is worth running: every shelf has just gone stale by then. */
  get interval(): number { return this.freshMs; }

  private store(key: string, items: MetaItem[]) {
    this.entries.delete(key);
    this.entries.set(key, { items, at: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  private async acquire(slot: string) {
    if ((this.active.get(slot) ?? 0) < this.perAddon) {
      this.active.set(slot, (this.active.get(slot) ?? 0) + 1);
      return;
    }
    // The releasing request hands its place over directly, so nobody slips in between.
    await new Promise<void>((resolve) => {
      const queue = this.waiting.get(slot) ?? [];
      queue.push(resolve);
      this.waiting.set(slot, queue);
    });
  }

  private release(slot: string) {
    const queue = this.waiting.get(slot);
    const next = queue?.shift();
    if (queue && !queue.length) this.waiting.delete(slot);
    if (next) { next(); return; }
    const left = (this.active.get(slot) ?? 1) - 1;
    if (left > 0) this.active.set(slot, left);
    else this.active.delete(slot);
  }
}
