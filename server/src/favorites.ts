/** The one Favourites list. A library star and a catalogue star are stored in two
 *  different maps and merged here, once, so the web, Home and the TV all read the same
 *  list in the same order. Nothing here touches a request or a store. */

export type FavoriteFilter = "all" | "library" | "catalog";

export const FAVORITE_FILTERS: readonly FavoriteFilter[] = ["all", "library", "catalog"];

export const parseFavoriteFilter = (value: unknown): FavoriteFilter =>
  value === "library" || value === "catalog" ? value : "all";

/** One catalogue star that survived the fold, or the identity of a library star. */
export interface FavoriteEntryLibrary { kind: "library"; key: string; catalogId?: string }
export interface FavoriteEntryCatalog {
  kind: "catalog";
  type: string;
  id: string;
  name: string;
  poster?: string;
  year?: string;
  addonKey?: string;
}
export type FavoriteEntry = FavoriteEntryLibrary | FavoriteEntryCatalog;

export interface FavoriteProgress { position: number; duration: number }

/** What `GET /api/favorites` hands the interface for a library star. */
export interface FavoriteLibraryItem {
  kind: "library";
  /** Qualified wire path, the form the library's own listings use. */
  path: string;
  label: string;
  poster?: string;
  wide?: string;
  year?: string;
  itemKind: "file" | "folder";
  progress?: FavoriteProgress;
  /** The IMDb id of the catalogue star this library item stands for. */
  catalogId?: string;
}

/** One catalogue star with no library copy behind it. */
export interface FavoriteCatalogItem {
  kind: "catalog";
  type: string;
  id: string;
  name: string;
  poster?: string;
  year?: string;
  addonKey?: string;
}

export type FavoriteItem = FavoriteLibraryItem | FavoriteCatalogItem;

/** The merged order: library stars first, newest first, then the catalogue stars that
 *  no library copy answers, newest first. Library stars carry no timestamp of their own,
 *  so their stored order decides within the group; a catalogue star keeps its `addedAt`
 *  order. Paging a single ordered list stays stable either way. */
export function mergeFavorites(library: FavoriteEntryLibrary[], catalog: FavoriteEntryCatalog[]): FavoriteEntry[] {
  return [...library, ...catalog];
}

/** How many entries a filter keeps. */
export function filterFavorites(entries: FavoriteEntry[], filter: FavoriteFilter): FavoriteEntry[] {
  if (filter === "all") return entries;
  return entries.filter((entry) => entry.kind === filter);
}
