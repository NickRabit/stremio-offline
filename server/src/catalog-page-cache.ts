import type { AddonRecord, MetaItem } from "./types.js";

/** How long a catalogue page answers from memory. Paging back and forth through a listing asks
 *  the same pages again within seconds; an addon's catalogue changes over hours. */
export const CATALOG_PAGE_TTL_MS = 5 * 60_000;
const CATALOG_PAGE_MAX = 200;

export interface CatalogPageRequest {
  type: string;
  id: string;
  skip: number;
  genre?: string;
}

/** Catalogue pages that already came back, shared by everyone who may use the addon: the page
 *  depends only on the addon's address and the request. Only answers are kept, never failures,
 *  and a search is never kept. Access is checked by the route on every request, cached or not. */
export class CatalogPageCache {
  private entries = new Map<string, { expiresAt: number; items: MetaItem[] }>();

  constructor(
    private readonly ttlMs = CATALOG_PAGE_TTL_MS,
    private readonly maxEntries = CATALOG_PAGE_MAX,
    private readonly now: () => number = Date.now,
  ) {}

  /** The address and the manifest version are part of the key: a reinstalled or reconfigured
   *  addon, or a new version of it, never answers with the old pages. */
  key(addon: Pick<AddonRecord, "key" | "manifestUrl" | "manifest">, request: CatalogPageRequest): string {
    return JSON.stringify([addon.key, addon.manifestUrl, addon.manifest.version ?? "", request.type, request.id, request.skip, request.genre ?? ""]);
  }

  get(key: string): MetaItem[] | undefined {
    const held = this.entries.get(key);
    if (!held) return undefined;
    if (held.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Most recently used last, so the oldest page is the one dropped at the limit.
    this.entries.delete(key);
    this.entries.set(key, held);
    return held.items;
  }

  set(key: string, items: MetaItem[]): void {
    this.entries.delete(key);
    this.entries.set(key, { expiresAt: this.now() + this.ttlMs, items });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
