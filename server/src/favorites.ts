/** The one Favourites list. A library star and a catalogue star are stored in two
 *  different maps and merged here, once, so the web, Home and the TV all read the same
 *  list in the same order. Nothing here touches a request or a store. */

export type FavoriteFilter = "all" | "library" | "catalog";

export const parseFavoriteFilter = (value: unknown): FavoriteFilter =>
  value === "library" || value === "catalog" ? value : "all";

/** One library star, either its own or folded with the catalogue star it answers. */
export interface FavoriteEntryLibrary { kind: "library"; key: string; catalogId?: string }
export interface FavoriteEntryCatalog {
  kind: "catalog";
  type: string;
  id: string;
  name: string;
  poster?: string;
  year?: string;
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
  /** The IMDb id of the catalogue star this card folds in, and only then: the card answers
   *  the catalogue's own filter and tells the interface which star chose the local copy. */
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
}

export type FavoriteItem = FavoriteLibraryItem | FavoriteCatalogItem;

/** The merged order: library stars first, newest first, then the catalogue stars that
 *  no library copy answers, newest first. Library stars carry no timestamp of their own,
 *  so their stored order decides within the group; a catalogue star keeps its `addedAt`
 *  order. Storage stays as it is, so this order is the contract. Paging a single ordered
 *  list stays stable either way. */
export function mergeFavorites(library: FavoriteEntryLibrary[], catalog: FavoriteEntryCatalog[]): FavoriteEntry[] {
  return [...library, ...catalog];
}

/** How many entries a filter keeps. A library card that folded a catalogue star answers
 *  both filters: it is a library star and it is that catalogue star. */
export function filterFavorites(entries: FavoriteEntry[], filter: FavoriteFilter): FavoriteEntry[] {
  if (filter === "all") return entries;
  return entries.filter((entry) => entry.kind === filter
    || (filter === "catalog" && entry.kind === "library" && entry.catalogId !== undefined));
}
