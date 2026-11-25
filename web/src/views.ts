import type {
  CatalogRef, CatalogViewPrefs, DownloadsViewPrefs, ExtraView, LibraryViewPrefs, RecentCatalogCount, UserViews,
} from "./types";

/** One stored bucket a browse path can name, or nothing to store under. */
export type ViewScope =
  | { kind: "library"; id: string }
  | { kind: "extra"; id: ExtraView }
  | { kind: "none" };

/** Matches `LIBRARY_ID` in `server/src/libraries.ts`; the client cannot import from there. */
const LIBRARY_ID = /^lib_[0-9a-f]{8}$/;

export const defaultLibraryView = (): LibraryViewPrefs =>
  ({ sort: "name", order: "asc", favoritesOnly: false, view: "grid" });
export const defaultDownloadsView = (): DownloadsViewPrefs =>
  ({ sort: "order", direction: "asc", status: "", dateField: "createdAt", pageSize: 20 });
export const defaultCatalogView = (): CatalogViewPrefs =>
  ({ recentCount: 3, recent: [], hiddenAddons: [], last: null });

export const emptyViews = (): UserViews =>
  ({ libraries: {}, extras: {}, downloads: defaultDownloadsView(), catalog: defaultCatalogView() });

export const sameCatalogRef = (a: CatalogRef, b: CatalogRef): boolean =>
  a.addonKey === b.addonKey && a.type === b.type && a.id === b.id;

export function pushRecentCatalog(recent: CatalogRef[], ref: CatalogRef, count: RecentCatalogCount): CatalogRef[] {
  if (count === 0) return [];
  return [ref, ...recent.filter((item) => !sameCatalogRef(item, ref))].slice(0, count);
}

const cutRecent = (refs: CatalogRef[], count: RecentCatalogCount): CatalogRef[] => {
  if (count === 0) return [];
  const out: CatalogRef[] = [];
  for (const item of refs) {
    if (out.some((other) => sameCatalogRef(item, other))) continue;
    out.push(item);
    if (out.length >= count) break;
  }
  return out;
};

export const withCatalog = (views: UserViews, patch: Partial<CatalogViewPrefs>): UserViews => {
  const recentCount = patch.recentCount ?? views.catalog.recentCount;
  const last = patch.last !== undefined ? patch.last : views.catalog.last;
  const hiddenAddons: string[] = [];
  for (const item of patch.hiddenAddons ?? views.catalog.hiddenAddons) {
    if (hiddenAddons.includes(item)) continue;
    hiddenAddons.push(item);
  }
  return {
    ...views,
    catalog: {
      recentCount,
      recent: cutRecent(patch.recent ?? views.catalog.recent, recentCount),
      hiddenAddons,
      last: last === null ? null : { ...last },
    },
  };
};

/** A library list is not a bucket. A single-library install speaks relative
 *  paths (`Films`, not `lib_xxxxxxxx/Films`); those still belong to that library. */
export function scopeOf(path: string, libraryIds: string[]): ViewScope {
  if (path === ":favorites") return { kind: "extra", id: path };
  if (!path) return libraryIds.length === 1 ? { kind: "library", id: libraryIds[0]! } : { kind: "none" };
  const id = path.split("/")[0]!;
  if (LIBRARY_ID.test(id)) return { kind: "library", id };
  return libraryIds.length === 1 ? { kind: "library", id: libraryIds[0]! } : { kind: "none" };
}

export function prefsFor(views: UserViews, scope: ViewScope): LibraryViewPrefs {
  if (scope.kind === "none") return defaultLibraryView();
  if (scope.kind === "library") return views.libraries[scope.id] ?? defaultLibraryView();
  return views.extras[scope.id] ?? defaultLibraryView();
}

export const withLibrary = (views: UserViews, id: string, prefs: LibraryViewPrefs): UserViews =>
  ({ ...views, libraries: { ...views.libraries, [id]: { ...prefs } } });

export const withExtra = (views: UserViews, id: ExtraView, prefs: LibraryViewPrefs): UserViews =>
  ({ ...views, extras: { ...views.extras, [id]: { ...prefs } } });

export const withDownloads = (views: UserViews, prefs: DownloadsViewPrefs): UserViews =>
  ({ ...views, downloads: { ...prefs } });
