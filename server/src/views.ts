import { AppError } from "./errors.js";
import { LIBRARY_ID } from "./libraries.js";
import { REMOTE_LIBRARY_ID } from "./media-server-types.js";

export type LibrarySort = "name" | "added" | "size" | "random";
export type LibraryOrder = "asc" | "desc";
export type LibraryLayout = "grid" | "list";
export type ExtraView = ":favorites" | ":resume";
export type DownloadSort = "order" | "titleSort" | "createdAt" | "startedAt" | "completedAt" | "duration";
export type DownloadStatusFilter = "" | "queued" | "waiting" | "checking" | "downloading" | "paused" | "completed" | "failed";
export type DownloadDateField = "createdAt" | "startedAt" | "completedAt";
export type DownloadPageSize = 20 | 50 | 100;

export interface LibraryViewPrefs {
  sort: LibrarySort;
  order: LibraryOrder;
  favoritesOnly: boolean;
  view: LibraryLayout;
}

export interface DownloadsViewPrefs {
  sort: DownloadSort;
  direction: LibraryOrder;
  status: DownloadStatusFilter;
  dateField: DownloadDateField;
  pageSize: DownloadPageSize;
}

export interface CatalogRef { addonKey: string; type: string; id: string }
export type RecentCatalogCount = 0 | 3 | 5 | 8;
export interface CatalogViewPrefs {
  recentCount: RecentCatalogCount;
  recent: CatalogRef[];
  hiddenAddons: string[];
  last: (CatalogRef & { genre: string }) | null;
}

/** A type alias rather than an interface: `UserData.views` is an opaque map, and only an
 *  object type carries the implicit index signature that makes the two assignable. */
export type UserViews = {
  libraries: Record<string, LibraryViewPrefs>;
  extras: Partial<Record<ExtraView, LibraryViewPrefs>>;
  downloads: DownloadsViewPrefs;
  catalog: CatalogViewPrefs;
};

export const defaultLibraryView = (): LibraryViewPrefs =>
  ({ sort: "name", order: "asc", favoritesOnly: false, view: "grid" });
export const defaultResumeView = (): LibraryViewPrefs =>
  ({ sort: "added", order: "desc", favoritesOnly: false, view: "grid" });
export const defaultDownloadsView = (): DownloadsViewPrefs =>
  ({ sort: "order", direction: "asc", status: "", dateField: "createdAt", pageSize: 20 });
export const defaultCatalogView = (): CatalogViewPrefs =>
  ({ recentCount: 3, recent: [], hiddenAddons: [], last: null });

export const emptyViews = (): UserViews =>
  ({ libraries: {}, extras: {}, downloads: defaultDownloadsView(), catalog: defaultCatalogView() });

const LIBRARY_SORTS: readonly LibrarySort[] = ["name", "added", "size", "random"];
const ORDERS: readonly LibraryOrder[] = ["asc", "desc"];
const LAYOUTS: readonly LibraryLayout[] = ["grid", "list"];
const DOWNLOAD_SORTS: readonly DownloadSort[] = ["order", "titleSort", "createdAt", "startedAt", "completedAt", "duration"];
const DOWNLOAD_STATUSES: readonly DownloadStatusFilter[] = ["", "queued", "waiting", "checking", "downloading", "paused", "completed", "failed"];
const DATE_FIELDS: readonly DownloadDateField[] = ["createdAt", "startedAt", "completedAt"];
const PAGE_SIZES: readonly DownloadPageSize[] = [20, 50, 100];
const RECENT_COUNTS: readonly RecentCatalogCount[] = [0, 3, 5, 8];
const CATALOG_FIELD_MAX = 200;
const RECENT_BODY_MAX = 8;
const HIDDEN_ADDONS_MAX = 200;

const EXTRA_VIEWS: readonly ExtraView[] = [":favorites", ":resume"];

/** A per-library view scope: a filesystem library or a granted remote library. Remote prefs
 *  live under the same map, keyed by the `rlib_` handle -- purely a preference scope, which
 *  broadens no filesystem route. */
const isLibraryScope = (id: string): boolean => LIBRARY_ID.test(id) || REMOTE_LIBRARY_ID.test(id);

const refused = () => new AppError("The request was not understood.", "err.invalidRequest");

/** What a stored value contributes. Anything but an object is read as nothing stored. */
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const pick = <T extends string>(allowed: readonly T[], value: unknown): T | undefined =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : undefined;

const defaultForExtra = (id: ExtraView): LibraryViewPrefs =>
  id === ":resume" ? defaultResumeView() : defaultLibraryView();

const parseLibraryView = (value: unknown, fallback: LibraryViewPrefs): LibraryViewPrefs => {
  const source = asRecord(value);
  return {
    sort: pick(LIBRARY_SORTS, source.sort) ?? fallback.sort,
    order: pick(ORDERS, source.order) ?? fallback.order,
    favoritesOnly: typeof source.favoritesOnly === "boolean" ? source.favoritesOnly : fallback.favoritesOnly,
    view: pick(LAYOUTS, source.view) ?? fallback.view,
  };
};

const parseDownloadsView = (value: unknown): DownloadsViewPrefs => {
  const source = asRecord(value);
  const fallback = defaultDownloadsView();
  return {
    sort: pick(DOWNLOAD_SORTS, source.sort) ?? fallback.sort,
    direction: pick(ORDERS, source.direction) ?? fallback.direction,
    status: pick(DOWNLOAD_STATUSES, source.status) ?? fallback.status,
    dateField: pick(DATE_FIELDS, source.dateField) ?? fallback.dateField,
    pageSize: typeof source.pageSize === "number" && PAGE_SIZES.includes(source.pageSize as DownloadPageSize)
      ? source.pageSize as DownloadPageSize
      : fallback.pageSize,
  };
};

const requiredEnum = <T extends string>(allowed: readonly T[], value: unknown, fallback: T): T => {
  if (value === undefined) return fallback;
  const picked = pick(allowed, value);
  if (picked === undefined) throw refused();
  return picked;
};

const requiredBoolean = (value: unknown, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw refused();
  return value;
};

const requiredPageSize = (value: unknown): DownloadPageSize => {
  if (value === undefined) return defaultDownloadsView().pageSize;
  if (typeof value !== "number" || !PAGE_SIZES.includes(value as DownloadPageSize)) throw refused();
  return value as DownloadPageSize;
};

const isCatalogField = (value: unknown, emptyOk = false): value is string =>
  typeof value === "string" && value.length <= CATALOG_FIELD_MAX && (emptyOk || value.length > 0);

const catalogRefKey = (ref: CatalogRef): string => `${ref.addonKey}\0${ref.type}\0${ref.id}`;

const parseCatalogRef = (value: unknown): CatalogRef | undefined => {
  const source = asRecord(value);
  if (!isCatalogField(source.addonKey) || !isCatalogField(source.type) || !isCatalogField(source.id)) return undefined;
  return { addonKey: source.addonKey, type: source.type, id: source.id };
};

const parseCatalogLast = (value: unknown): CatalogViewPrefs["last"] => {
  if (value == null) return null;
  const ref = parseCatalogRef(value);
  if (!ref) return null;
  const genre = asRecord(value).genre;
  if (!isCatalogField(genre, true)) return null;
  return { ...ref, genre };
};

const dedupeCatalogRefs = (refs: CatalogRef[]): CatalogRef[] => {
  const seen = new Set<string>();
  const out: CatalogRef[] = [];
  for (const ref of refs) {
    const key = catalogRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
};

const uniqueStrings = (values: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
};

const parseHiddenAddons = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isCatalogField(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= HIDDEN_ADDONS_MAX) break;
  }
  return out;
};

const parseRecentCount = (value: unknown): RecentCatalogCount =>
  typeof value === "number" && (RECENT_COUNTS as readonly number[]).includes(value)
    ? value as RecentCatalogCount
    : 3;

const parseRecentCatalogs = (value: unknown, count: RecentCatalogCount): CatalogRef[] => {
  if (count === 0 || !Array.isArray(value)) return [];
  const refs: CatalogRef[] = [];
  for (const item of value) {
    const ref = parseCatalogRef(item);
    if (ref) refs.push(ref);
  }
  return dedupeCatalogRefs(refs).slice(0, count);
};

const parseCatalogView = (value: unknown): CatalogViewPrefs => {
  const source = asRecord(value);
  const recentCount = parseRecentCount(source.recentCount);
  return {
    recentCount,
    recent: parseRecentCatalogs(source.recent, recentCount),
    hiddenAddons: parseHiddenAddons(source.hiddenAddons),
    last: parseCatalogLast(source.last),
  };
};

const requiredRecentCount = (value: unknown): RecentCatalogCount => {
  if (typeof value !== "number" || !(RECENT_COUNTS as readonly number[]).includes(value)) throw refused();
  return value as RecentCatalogCount;
};

const requiredCatalogRef = (value: unknown): CatalogRef => {
  const ref = parseCatalogRef(value);
  if (!ref) throw refused();
  return ref;
};

const requiredRecent = (value: unknown): CatalogRef[] => {
  if (!Array.isArray(value) || value.length > RECENT_BODY_MAX) throw refused();
  return value.map(requiredCatalogRef);
};

const requiredHiddenAddons = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > HIDDEN_ADDONS_MAX) throw refused();
  return value.map((item) => {
    if (!isCatalogField(item)) throw refused();
    return item;
  });
};

const requiredCatalogLast = (value: unknown): CatalogViewPrefs["last"] => {
  if (value === null) return null;
  const ref = parseCatalogRef(value);
  if (!ref) throw refused();
  const genre = asRecord(value).genre;
  if (!isCatalogField(genre, true)) throw refused();
  return { ...ref, genre };
};

const patchCatalogView = (value: unknown, fallback: CatalogViewPrefs): CatalogViewPrefs => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw refused();
  const source = value as Record<string, unknown>;
  const recentCount = source.recentCount !== undefined ? requiredRecentCount(source.recentCount) : fallback.recentCount;
  let recent = source.recent !== undefined ? requiredRecent(source.recent) : [...fallback.recent];
  const hiddenAddons = source.hiddenAddons !== undefined ? requiredHiddenAddons(source.hiddenAddons) : [...fallback.hiddenAddons];
  const last = source.last !== undefined
    ? requiredCatalogLast(source.last)
    : fallback.last === null ? null : { ...fallback.last };
  if (recentCount === 0) recent = [];
  else recent = dedupeCatalogRefs(recent).slice(0, recentCount);
  return { recentCount, recent, hiddenAddons: uniqueStrings(hiddenAddons), last };
};

const patchLibraryView = (value: unknown, fallback: LibraryViewPrefs): LibraryViewPrefs => {
  const source = asRecord(value);
  return {
    sort: requiredEnum(LIBRARY_SORTS, source.sort, fallback.sort),
    order: requiredEnum(ORDERS, source.order, fallback.order),
    favoritesOnly: requiredBoolean(source.favoritesOnly, fallback.favoritesOnly),
    view: requiredEnum(LAYOUTS, source.view, fallback.view),
  };
};

const patchDownloadsView = (value: unknown): DownloadsViewPrefs => {
  const source = asRecord(value);
  const fallback = defaultDownloadsView();
  return {
    sort: requiredEnum(DOWNLOAD_SORTS, source.sort, fallback.sort),
    direction: requiredEnum(ORDERS, source.direction, fallback.direction),
    status: requiredEnum(DOWNLOAD_STATUSES, source.status, fallback.status),
    dateField: requiredEnum(DATE_FIELDS, source.dateField, fallback.dateField),
    pageSize: requiredPageSize(source.pageSize),
  };
};

/** Never throws. Junk keys and unknown enums are dropped; missing halves are defaults. */
export function parseViews(raw: unknown): UserViews {
  const source = asRecord(raw);
  const views = emptyViews();
  for (const [id, value] of Object.entries(asRecord(source.libraries))) {
    if (!isLibraryScope(id)) continue;
    views.libraries[id] = parseLibraryView(value, defaultLibraryView());
  }
  const extras = asRecord(source.extras);
  for (const id of EXTRA_VIEWS) {
    if (extras[id] === undefined) continue;
    views.extras[id] = parseLibraryView(extras[id], defaultForExtra(id));
  }
  views.downloads = parseDownloadsView(source.downloads);
  views.catalog = parseCatalogView(source.catalog);
  return views;
}

/** Merge a PATCH body onto the current views. */
export function applyPatch(current: UserViews, body: unknown): UserViews {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw refused();
  const source = body as Record<string, unknown>;
  const next: UserViews = {
    libraries: { ...current.libraries },
    extras: { ...current.extras },
    downloads: current.downloads,
    catalog: current.catalog,
  };
  for (const [id, value] of Object.entries(asRecord(source.libraries))) {
    if (!isLibraryScope(id)) continue;
    next.libraries[id] = patchLibraryView(value, defaultLibraryView());
  }
  const extras = asRecord(source.extras);
  for (const id of EXTRA_VIEWS) {
    if (extras[id] === undefined) continue;
    next.extras[id] = patchLibraryView(extras[id], defaultForExtra(id));
  }
  if (source.downloads !== undefined) next.downloads = patchDownloadsView(source.downloads);
  if (source.catalog !== undefined) next.catalog = patchCatalogView(source.catalog, current.catalog);
  return next;
}
