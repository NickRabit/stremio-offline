import type { DownloadsViewPrefs, ExtraView, LibraryViewPrefs, UserViews } from "./types";

/** One stored bucket a browse path can name, or nothing to store under. */
export type ViewScope =
  | { kind: "library"; id: string }
  | { kind: "extra"; id: ExtraView }
  | { kind: "none" };

/** Matches `LIBRARY_ID` in `server/src/libraries.ts`; the client cannot import from there. */
const LIBRARY_ID = /^lib_[0-9a-f]{8}$/;

export const defaultLibraryView = (): LibraryViewPrefs =>
  ({ sort: "name", order: "asc", favoritesOnly: false, view: "grid" });
export const defaultResumeView = (): LibraryViewPrefs =>
  ({ sort: "added", order: "desc", favoritesOnly: false, view: "grid" });
export const defaultDownloadsView = (): DownloadsViewPrefs =>
  ({ sort: "order", direction: "asc", status: "", dateField: "createdAt", pageSize: 20 });

export const emptyViews = (): UserViews =>
  ({ libraries: {}, extras: {}, downloads: defaultDownloadsView() });

/** A library list is not a bucket. A single-library install speaks relative
 *  paths (`Films`, not `lib_xxxxxxxx/Films`); those still belong to that library. */
export function scopeOf(path: string, libraryIds: string[]): ViewScope {
  if (path === ":favorites" || path === ":resume") return { kind: "extra", id: path };
  if (!path) return libraryIds.length === 1 ? { kind: "library", id: libraryIds[0]! } : { kind: "none" };
  const id = path.split("/")[0]!;
  if (LIBRARY_ID.test(id)) return { kind: "library", id };
  return libraryIds.length === 1 ? { kind: "library", id: libraryIds[0]! } : { kind: "none" };
}

export function prefsFor(views: UserViews, scope: ViewScope): LibraryViewPrefs {
  if (scope.kind === "none") return defaultLibraryView();
  if (scope.kind === "library") return views.libraries[scope.id] ?? defaultLibraryView();
  return views.extras[scope.id] ?? (scope.id === ":resume" ? defaultResumeView() : defaultLibraryView());
}

export const withLibrary = (views: UserViews, id: string, prefs: LibraryViewPrefs): UserViews =>
  ({ ...views, libraries: { ...views.libraries, [id]: { ...prefs } } });

export const withExtra = (views: UserViews, id: ExtraView, prefs: LibraryViewPrefs): UserViews =>
  ({ ...views, extras: { ...views.extras, [id]: { ...prefs } } });

export const withDownloads = (views: UserViews, prefs: DownloadsViewPrefs): UserViews =>
  ({ ...views, downloads: { ...prefs } });
