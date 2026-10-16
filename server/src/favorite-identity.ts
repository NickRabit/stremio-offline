import { isVideo } from "./library.js";
import { knownEntryForUnit, unitFor, type LibraryMetaRecord, type TitleUnit } from "./library-match.js";
import { posixBase } from "./libraries.js";

/** The catalogue title a library path stands for: a film, a show, or nothing when the path is
 *  not bound to one. */
export interface FavoriteTitle { type: "movie" | "series"; id: string; name?: string }

/** The identified title a starred or listed library path belongs to, resolved the way the library
 *  listing resolves it: through the path's unit, so a starred episode answers with its show's folder
 *  and folds with the show's catalogue star. Falls back to the key itself when nothing groups it. */
export function favoriteIdentity(
  key: string,
  records: Record<string, LibraryMetaRecord>,
  units: TitleUnit[],
): { key: string; record: LibraryMetaRecord } | undefined {
  return knownEntryForUnit(unitFor(key, units) ?? key, records, isVideo(posixBase(key)) ? key : undefined);
}

/** The catalogue title a library path stands for, when the binding names a film or a show. */
export function titleOfPath(
  qualified: string,
  records: Record<string, LibraryMetaRecord>,
  units: TitleUnit[],
): FavoriteTitle | undefined {
  const record = favoriteIdentity(qualified, records, units)?.record;
  if (record?.type !== "movie" && record?.type !== "series") return undefined;
  if (!record.id) return undefined;
  return { type: record.type, id: record.id, ...(record.name ? { name: record.name } : {}) };
}

/** Whether one qualified library path wears the star: its own, or the title's, so a library copy
 *  and the catalogue star for the same title are one favourite. */
export function starredPath(
  key: string,
  favorites: ReadonlySet<string>,
  watchlist: Record<string, unknown>,
  records: Record<string, LibraryMetaRecord>,
  units: TitleUnit[],
): boolean {
  if (favorites.has(key)) return true;
  const title = titleOfPath(key, records, units);
  return Boolean(title && watchlist[`${title.type}:${title.id}`]);
}
