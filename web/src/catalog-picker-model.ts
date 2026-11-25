import { catalogTypeTag } from "./catalog-labels";
import type { Catalog, SearchableCatalog } from "./types";

export interface CatalogRef { addonKey: string; type: string; id: string }
export type TypeBucket = "movie" | "series" | "other";
export const BUCKETS: readonly TypeBucket[] = ["movie", "series", "other"];

type PickerCatalog = Catalog & { extraRequired?: unknown };

export const typeBucket = (type: string): TypeBucket =>
  type === "movie" || type === "series" ? type : "other";

export const catalogRefKey = (ref: CatalogRef): string => `${ref.addonKey}:${ref.type}:${ref.id}`;
export const refOf = (catalog: Catalog): CatalogRef => ({
  addonKey: catalog.addonKey,
  type: catalog.type,
  id: catalog.id,
});
export const sameRef = (a: CatalogRef, b: CatalogRef): boolean =>
  a.addonKey === b.addonKey && a.type === b.type && a.id === b.id;

export function foldText(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function matchesQuery(text: string, query: string): boolean {
  const words = foldText(query).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const folded = foldText(text);
  return words.every((word) => folded.includes(word));
}

export function requiredExtras(catalog: Catalog): string[] {
  // A remote manifest is not validated: anything but a list of extras declares none.
  const extras = Array.isArray(catalog.extra) ? catalog.extra.filter((extra) => extra && typeof extra === "object") : [];
  const names = extras.filter((extra) => extra.isRequired && typeof extra.name === "string").map((extra) => extra.name);
  const extraRequired = (catalog as PickerCatalog).extraRequired;
  if (Array.isArray(extraRequired)) {
    names.push(...extraRequired.filter((name): name is string => typeof name === "string"));
  } else if (typeof extraRequired === "string") {
    names.push(extraRequired);
  }
  return [...new Set(names)];
}

export function genreOptions(catalog: Catalog): string[] {
  const options = Array.isArray(catalog.extra) ? catalog.extra.find((extra) => extra?.name === "genre")?.options : undefined;
  return Array.isArray(options) ? options.filter((option): option is string => typeof option === "string" && option.length > 0) : [];
}

export function genreRequired(catalog: Catalog): boolean {
  return requiredExtras(catalog).includes("genre");
}

export function needsSearch(catalog: Catalog): boolean {
  return requiredExtras(catalog).includes("search");
}

export function isBrowsable(catalog: Catalog): boolean {
  const required = requiredExtras(catalog);
  return required.every((name) => name === "search" || name === "skip" || name === "genre")
    && (!required.includes("genre") || genreOptions(catalog).length > 0);
}

export function effectiveGenre(catalog: Catalog, chosen: string): string {
  const options = genreOptions(catalog);
  if (options.includes(chosen)) return chosen;
  if (genreRequired(catalog)) return options[0] ?? "";
  return "";
}

export function genrePaused(catalog: Catalog, chosen: string): boolean {
  return Boolean(chosen) && !genreRequired(catalog) && !genreOptions(catalog).includes(chosen);
}

export interface CatalogRow { ref: CatalogRef; name: string; otherType: boolean; needsSearch: boolean }
export interface CatalogGroup { addonKey: string; addonName: string; hidden: boolean; rows: CatalogRow[]; notBrowsable: number; countInBucket: number }

export function catalogGroups(catalogs: Catalog[], options: {
  bucket: TypeBucket;
  query: string;
  hiddenAddons: readonly string[];
  includeHidden: boolean;
}): CatalogGroup[] {
  const hidden = new Set(options.hiddenAddons);
  const queryPresent = options.query.trim().length > 0;
  const grouped = new Map<string, Catalog[]>();
  for (const catalog of catalogs) {
    const group = grouped.get(catalog.addonKey);
    if (group) group.push(catalog);
    else grouped.set(catalog.addonKey, [catalog]);
  }

  const groups: CatalogGroup[] = [];
  for (const [addonKey, addonCatalogs] of grouped) {
    const addonHidden = hidden.has(addonKey);
    if (addonHidden && !options.includeHidden && !queryPresent) continue;
    const addonName = addonCatalogs[0]!.addonName;
    const variants = new Map<string, Catalog[]>();
    for (const catalog of addonCatalogs) {
      const groupKey = JSON.stringify([catalog.id, typeBucket(catalog.type) === "other" ? catalog.type : null]);
      const idGroup = variants.get(groupKey);
      if (idGroup) idGroup.push(catalog);
      else variants.set(groupKey, [catalog]);
    }

    const matching: CatalogRow[] = [];
    let notBrowsable = 0;
    let countInBucket = 0;
    for (const idCatalogs of variants.values()) {
      const browsable = idCatalogs.filter(isBrowsable);
      if (!browsable.length) {
        notBrowsable += 1;
        continue;
      }
      const candidates = browsable.filter((item) => matchesQuery(
        `${addonName} ${item.name ?? item.id} ${item.type} ${catalogTypeTag(item.type)}`, options.query));
      if (!candidates.length) continue;
      const inBucket = candidates.find((catalog) => typeBucket(catalog.type) === options.bucket);
      const catalog = inBucket ?? candidates[0]!;
      const row: CatalogRow = {
        ref: refOf(catalog),
        name: catalog.name ?? catalog.id,
        otherType: !inBucket,
        needsSearch: needsSearch(catalog),
      };
      if (!row.otherType) countInBucket += 1;
      matching.push(row);
    }
    const rows = [
      ...matching.filter((row) => !row.otherType),
      ...matching.filter((row) => row.otherType),
    ];
    if (!rows.length) continue;
    groups.push({ addonKey, addonName, hidden: addonHidden, rows, notBrowsable, countInBucket });
  }
  return groups;
}

export function bucketsPresent(catalogs: Catalog[]): TypeBucket[] {
  const present = new Set(catalogs.filter(isBrowsable).map((catalog) => typeBucket(catalog.type)));
  return BUCKETS.filter((bucket) => present.has(bucket));
}

export function fallbackForBucket(catalogs: Catalog[], current: CatalogRef, bucket: TypeBucket, hiddenAddons: readonly string[]): { ref: CatalogRef; sameId: boolean } | null {
  const sameId = catalogs.find((catalog) =>
    catalog.addonKey === current.addonKey && catalog.id === current.id
    && typeBucket(catalog.type) === bucket && isBrowsable(catalog));
  if (sameId) return { ref: refOf(sameId), sameId: true };

  const hidden = new Set(hiddenAddons);
  const ordered = [
    ...catalogs.filter((catalog) => catalog.addonKey === current.addonKey),
    ...catalogs.filter((catalog) => catalog.addonKey !== current.addonKey),
  ];
  const fallback = ordered.find((catalog) =>
    !hidden.has(catalog.addonKey) && typeBucket(catalog.type) === bucket
    && isBrowsable(catalog) && !needsSearch(catalog));
  return fallback ? { ref: refOf(fallback), sameId: false } : null;
}

export function recentCatalogs(catalogs: Catalog[], recent: readonly CatalogRef[], limit: number): Catalog[] {
  if (limit <= 0) return [];
  const found = recent.flatMap((ref) => {
    const catalog = catalogs.find((candidate) => sameRef(refOf(candidate), ref));
    return catalog && isBrowsable(catalog) ? [catalog] : [];
  });
  return found.slice(0, limit);
}

export interface ScopeRow { value: string; name: string; type: string }
export interface ScopeGroup { addonKey: string; addonName: string; globalSearch: boolean; addonValue: string; rows: ScopeRow[] }

export function scopeGroups(searchable: SearchableCatalog[], options: { query: string; type: "" | "movie" | "series" }): ScopeGroup[] {
  const grouped = new Map<string, SearchableCatalog[]>();
  for (const catalog of searchable) {
    const group = grouped.get(catalog.addonKey);
    if (group) group.push(catalog);
    else grouped.set(catalog.addonKey, [catalog]);
  }
  const groups: ScopeGroup[] = [];
  for (const [addonKey, addonCatalogs] of grouped) {
    const addonName = addonCatalogs[0]!.addonName;
    const rows = addonCatalogs
      .filter((catalog) => !options.type || catalog.type === options.type)
      .filter((catalog) => matchesQuery(`${addonName} ${catalog.name} ${catalog.type} ${catalogTypeTag(catalog.type)}`, options.query))
      .map((catalog) => ({
        value: scopeCatalogValue(catalog),
        name: catalog.name,
        type: catalog.type,
      }));
    if (!rows.length) continue;
    groups.push({
      addonKey,
      addonName,
      globalSearch: addonCatalogs[0]!.globalSearch,
      addonValue: scopeAddonValue(addonKey),
      rows,
    });
  }
  return groups;
}

export const scopeAddonValue = (addonKey: string) => `addon:${addonKey}`;
export const scopeCatalogValue = (ref: CatalogRef) => `catalog:${ref.addonKey}:${ref.type}:${ref.id}`;
