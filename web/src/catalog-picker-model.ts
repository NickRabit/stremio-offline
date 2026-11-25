import { catalogTypeTag } from "./catalog-labels";
import type { Catalog, CatalogRef, SearchableCatalog } from "./types";
export type { CatalogRef } from "./types";
export const browseMembers = Symbol("browseMembers");
export type BrowseCatalog = Catalog & { [browseMembers]?: Catalog[] };
export type TypeBucket = "all" | "movie" | "series" | "other";
export const BUCKETS: readonly TypeBucket[] = ["all", "movie", "series", "other"];

type PickerCatalog = Catalog & { extraRequired?: unknown };

export const typeBucket = (type: string): TypeBucket =>
  type === "movie" || type === "series" ? type : "other";

export const catalogRefKey = (ref: CatalogRef): string => JSON.stringify([ref.addonKey, ref.type, ref.id, Boolean(ref.combined)]);
export const refOf = (catalog: BrowseCatalog): CatalogRef => ({
  addonKey: catalog.addonKey,
  type: catalog.type,
  id: catalog.id,
  ...(catalog[browseMembers] ? { combined: true as const } : {}),
});
export const sameRef = (a: CatalogRef, b: CatalogRef): boolean =>
  a.addonKey === b.addonKey && a.type === b.type && a.id === b.id && a.combined === b.combined;

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

/** Keep manifest resources for individual types, and project their movie/series pairs into the All tab. */
export function browseCatalogs(raw: Catalog[]): BrowseCatalog[] {
  const eligible = raw.filter((c) => typeBucket(c.type) !== "other" && isBrowsable(c) && !needsSearch(c));
  if (!eligible.some((c) => c.type === "movie") || !eligible.some((c) => c.type === "series")) return raw;
  const groupsBy = (field: "name" | "id") => {
    const groups = new Map<string, Catalog[]>();
    for (const catalog of eligible) {
      const key = JSON.stringify([catalog.addonKey, catalog[field]]);
      const group = groups.get(key);
      if (group) group.push(catalog);
      else groups.set(key, [catalog]);
    }
    return groups;
  };
  const byId = groupsBy("id");
  const byName = groupsBy("name");
  const consumed = new Set<Catalog>();
  const combined: BrowseCatalog[] = [];
  for (const group of byId.values()) {
    const first = group[0]!;
    if (consumed.has(first)) continue;
    let members = group;
    if (group.length === 1 && first.name) {
      const named = byName.get(JSON.stringify([first.addonKey, first.name]))!;
      if (named.length === 2 && named[0]!.type !== named[1]!.type &&
        named.every((catalog) => byId.get(JSON.stringify([catalog.addonKey, catalog.id]))!.length === 1)) {
        members = named;
      }
    }
    members.forEach((catalog) => consumed.add(catalog));
    const primary = members.find((catalog) => catalog.type === "movie") ?? first;
    const options = [...new Set(members.flatMap(genreOptions))];
    combined.push({ ...primary, [browseMembers]: members, extraRequired: [], extra: [{ name: "genre", options }] });
  }
  return [...combined, ...raw];
}

export const browseBucket = (c: BrowseCatalog): TypeBucket => c[browseMembers] ? "all" : typeBucket(c.type);

/** One catalogue in another type: the same id of one addon, or a mixed entry and one of its types. */
export function samePair(a: BrowseCatalog, b: BrowseCatalog): boolean {
  if (a.addonKey !== b.addonKey) return false;
  const ids = (c: BrowseCatalog) => (c[browseMembers] ?? [c]).map((member) => member.id);
  return ids(a).some((id) => ids(b).includes(id));
}

/** The All tab also offers the search-only movie and series catalogues, which have no mixed form. */
const fitsBucket = (catalog: BrowseCatalog, bucket: TypeBucket): boolean =>
  browseBucket(catalog) === bucket
  || (bucket === "all" && !catalog[browseMembers] && typeBucket(catalog.type) !== "other" && needsSearch(catalog));

/** `onlyType` marks a row of the All tab that exists in one type only. */
export interface CatalogRow { ref: CatalogRef; name: string; otherType: boolean; needsSearch: boolean; onlyType?: string }
export interface CatalogGroup { addonKey: string; addonName: string; hidden: boolean; rows: CatalogRow[]; notBrowsable: number; countInBucket: number }

export function catalogGroups(catalogs: BrowseCatalog[], options: {
  bucket: TypeBucket;
  query: string;
  hiddenAddons: readonly string[];
  includeHidden: boolean;
}): CatalogGroup[] {
  const hidden = new Set(options.hiddenAddons);
  const queryPresent = options.query.trim().length > 0;
  const grouped = new Map<string, BrowseCatalog[]>();
  for (const catalog of catalogs) {
    const plainInAll = !catalog[browseMembers] && !(typeBucket(catalog.type) !== "other" && needsSearch(catalog))
      // A search from the All tab still reaches anime, TV and the other kinds All does not mix.
      && !(queryPresent && typeBucket(catalog.type) === "other");
    if (options.bucket === "all" ? plainInAll : catalog[browseMembers]) continue;
    const group = grouped.get(catalog.addonKey);
    if (group) group.push(catalog);
    else grouped.set(catalog.addonKey, [catalog]);
  }

  const groups: CatalogGroup[] = [];
  for (const [addonKey, addonCatalogs] of grouped) {
    const addonHidden = hidden.has(addonKey);
    if (addonHidden && !options.includeHidden && !queryPresent) continue;
    const addonName = addonCatalogs[0]!.addonName;
    const variants = new Map<string, BrowseCatalog[]>();
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
        `${addonName} ${item.name ?? item.id} ${(item[browseMembers] ?? [item]).map((v) => v.type + " " + catalogTypeTag(v.type)).join(" ")}`, options.query));
      if (!candidates.length) continue;
      const inBucket = candidates.find((catalog) => fitsBucket(catalog, options.bucket));
      if (inBucket) {
        let catalog = inBucket;
        if (catalog[browseMembers] && !matchesQuery(`${addonName} ${catalog.name ?? catalog.id}`, options.query)) {
          const matchingMembers = catalog[browseMembers].filter((member) => matchesQuery(
            `${addonName} ${member.name ?? member.id} ${member.type} ${catalogTypeTag(member.type)}`, options.query));
          if (matchingMembers.length === 1) catalog = matchingMembers[0]!;
        }
        const members = catalog[browseMembers];
        countInBucket += 1;
        matching.push({
          ref: refOf(catalog),
          name: catalog.name ?? catalog.id,
          otherType: false,
          needsSearch: needsSearch(catalog),
          ...(members?.length === 1 ? { onlyType: members[0]!.type } : {}),
        });
        continue;
      }
      // Another type only while searching: browsing a tab lists that tab, and a search finds
      // every type, each variant on its own row so none of them is left unreachable.
      if (!queryPresent) continue;
      for (const catalog of candidates) {
        if (catalog[browseMembers]) continue;
        matching.push({ ref: refOf(catalog), name: catalog.name ?? catalog.id, otherType: true, needsSearch: needsSearch(catalog) });
      }
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

export function bucketsPresent(catalogs: BrowseCatalog[]): TypeBucket[] {
  const present = new Set(catalogs.filter(isBrowsable).map(browseBucket));
  return BUCKETS.filter((bucket) => present.has(bucket));
}

export function fallbackForBucket(catalogs: BrowseCatalog[], current: CatalogRef, bucket: TypeBucket, hiddenAddons: readonly string[]): { ref: CatalogRef; sameId: boolean } | null {
  const combined = catalogs.find((c) => c[browseMembers]?.some((member) => member.addonKey === current.addonKey && member.type === current.type && member.id === current.id));
  if (bucket === "all" && combined) return { ref: refOf(combined), sameId: true };
  const member = current.combined && combined?.[browseMembers]?.find((c) => c.type === bucket);
  if (member) return { ref: refOf(member), sameId: true };
  const sameId = catalogs.find((catalog) =>
    catalog.addonKey === current.addonKey && catalog.id === current.id
    && browseBucket(catalog) === bucket && isBrowsable(catalog));
  if (sameId) return { ref: refOf(sameId), sameId: true };

  const hidden = new Set(hiddenAddons);
  const ordered = [
    ...catalogs.filter((catalog) => catalog.addonKey === current.addonKey),
    ...catalogs.filter((catalog) => catalog.addonKey !== current.addonKey),
  ];
  const fallback = ordered.find((catalog) =>
    !hidden.has(catalog.addonKey) && browseBucket(catalog) === bucket
    && isBrowsable(catalog) && !needsSearch(catalog));
  return fallback ? { ref: refOf(fallback), sameId: false } : null;
}

export function recentCatalogs(catalogs: BrowseCatalog[], recent: readonly CatalogRef[], limit: number): BrowseCatalog[] {
  if (limit <= 0) return [];
  const found = recent.flatMap((ref) => {
    const catalog = catalogs.find((candidate) => sameRef(refOf(candidate), ref));
    return catalog && isBrowsable(catalog) ? [catalog] : [];
  });
  // One list in several types is one chip, in the type used last.
  const unique = found.filter((catalog, index) => !found.slice(0, index).some((earlier) => samePair(earlier, catalog)));
  return unique.slice(0, limit);
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
