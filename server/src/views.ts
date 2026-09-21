import { AppError } from "./errors.js";
import { LIBRARY_ID } from "./libraries.js";

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

/** A type alias rather than an interface: `UserData.views` is an opaque map, and only an
 *  object type carries the implicit index signature that makes the two assignable. */
export type UserViews = {
  libraries: Record<string, LibraryViewPrefs>;
  extras: Partial<Record<ExtraView, LibraryViewPrefs>>;
  downloads: DownloadsViewPrefs;
};

export const defaultLibraryView = (): LibraryViewPrefs =>
  ({ sort: "name", order: "asc", favoritesOnly: false, view: "grid" });
export const defaultResumeView = (): LibraryViewPrefs =>
  ({ sort: "added", order: "desc", favoritesOnly: false, view: "grid" });
export const defaultDownloadsView = (): DownloadsViewPrefs =>
  ({ sort: "order", direction: "asc", status: "", dateField: "createdAt", pageSize: 20 });

export const emptyViews = (): UserViews =>
  ({ libraries: {}, extras: {}, downloads: defaultDownloadsView() });

const LIBRARY_SORTS: readonly LibrarySort[] = ["name", "added", "size", "random"];
const ORDERS: readonly LibraryOrder[] = ["asc", "desc"];
const LAYOUTS: readonly LibraryLayout[] = ["grid", "list"];
const DOWNLOAD_SORTS: readonly DownloadSort[] = ["order", "titleSort", "createdAt", "startedAt", "completedAt", "duration"];
const DOWNLOAD_STATUSES: readonly DownloadStatusFilter[] = ["", "queued", "waiting", "checking", "downloading", "paused", "completed", "failed"];
const DATE_FIELDS: readonly DownloadDateField[] = ["createdAt", "startedAt", "completedAt"];
const PAGE_SIZES: readonly DownloadPageSize[] = [20, 50, 100];

const EXTRA_VIEWS: readonly ExtraView[] = [":favorites", ":resume"];

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
    if (!LIBRARY_ID.test(id)) continue;
    views.libraries[id] = parseLibraryView(value, defaultLibraryView());
  }
  const extras = asRecord(source.extras);
  for (const id of EXTRA_VIEWS) {
    if (extras[id] === undefined) continue;
    views.extras[id] = parseLibraryView(extras[id], defaultForExtra(id));
  }
  views.downloads = parseDownloadsView(source.downloads);
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
  };
  for (const [id, value] of Object.entries(asRecord(source.libraries))) {
    if (!LIBRARY_ID.test(id)) continue;
    next.libraries[id] = patchLibraryView(value, defaultLibraryView());
  }
  const extras = asRecord(source.extras);
  for (const id of EXTRA_VIEWS) {
    if (extras[id] === undefined) continue;
    next.extras[id] = patchLibraryView(extras[id], defaultForExtra(id));
  }
  if (source.downloads !== undefined) next.downloads = patchDownloadsView(source.downloads);
  return next;
}
