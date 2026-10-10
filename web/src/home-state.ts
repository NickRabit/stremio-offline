import type { HomeCard, HomeResponse, HomeRowId } from "../../server/src/home";
import { HOME_ROWS, homeCatalogRowId, homeCatalogSelectionKey, homeRowOrder } from "../../server/src/home";
import type { Addon } from "./types";

export { HOME_ROWS };

export const isHomeCatalogRow = (row: HomeRowId): boolean => row.startsWith("catalog:");

export interface HomeCatalogShelf { id: HomeRowId; title: string }

export function homeCatalogShelves(addons: Addon[]): HomeCatalogShelf[] {
  const seen = new Set<string>();
  return addons.flatMap((addon) => {
    if (!addon.enabled || addon.role === "source" || addon.showOnHome === false) return [];
    return (addon.manifest.catalogs ?? []).flatMap((catalog) => {
      const selection = homeCatalogSelectionKey(catalog.type, catalog.id);
      if (addon.homeCatalogs !== undefined && !addon.homeCatalogs.includes(selection)) return [];
      const id = homeCatalogRowId(addon.key, catalog.type, catalog.id);
      if (seen.has(id)) return [];
      seen.add(id);
      return [{
        id,
        title: `${addon.manifest.name} · ${catalog.name || catalog.id}`,
      }];
    });
  });
}

/** The rows one account loads. `confirm` is administrator-only, so an ordinary account's load
 *  omits it and its global empty state must not wait for a row that will never answer. */
export const homeRowsFor = (admin: boolean, addons: Addon[] = []): readonly HomeRowId[] =>
  homeRowOrder(admin, homeCatalogShelves(addons).map((shelf) => ({ id: shelf.id }))).map((entry) => entry.id);

export type HomeRowStatus = "idle" | "loading" | "ok" | "error";

export interface HomeRowState {
  status: HomeRowStatus;
  items: HomeCard[];
  hasMore: boolean;
  /** The row's exact count, present only where the server computed one (`confirm`). */
  total?: number;
  /** An addon lookup timed out, so a card may be missing but the row is usable. */
  partial: boolean;
  /** The request number this row reflects. A newer request supersedes an older one. */
  request: number;
}

export type HomeRows = Partial<Record<HomeRowId, HomeRowState>>;

export type HomeAction =
  | { type: "begin"; rows: readonly HomeRowId[]; request: number }
  | { type: "answer"; rows: readonly HomeRowId[]; request: number; response: HomeResponse }
  | { type: "fail"; rows: readonly HomeRowId[]; request: number }
  | { type: "reset" };

export const emptyHomeRows = (): HomeRows => ({});

/** Per-row state machine. A row keeps its cards while a refresh runs, an answer only lands on
 *  the request that is still current for that row, and one row failing leaves the others alone. */
export function homeReducer(state: HomeRows, action: HomeAction): HomeRows {
  if (action.type === "reset") return emptyHomeRows();
  if (action.type === "begin") {
    const next: HomeRows = { ...state };
    for (const row of action.rows) {
      const current = next[row];
      next[row] = {
        status: "loading",
        items: current?.items ?? [],
        hasMore: current?.hasMore ?? false,
        total: current?.total,
        partial: current?.partial ?? false,
        request: action.request,
      };
    }
    return next;
  }
  const next: HomeRows = { ...state };
  for (const row of action.rows) {
    const current = next[row];
    if (!current || current.request !== action.request) continue;
    if (action.type === "fail") {
      next[row] = { ...current, status: "error" };
      continue;
    }
    const answered = action.response.rows[row];
    if (!answered || answered.status === "error") {
      next[row] = { ...current, status: "error" };
      continue;
    }
    next[row] = { status: "ok", items: answered.items, hasMore: answered.hasMore, total: answered.total, partial: answered.partial === true, request: current.request };
  }
  return next;
}

/** The page-wide empty state only: every row the account asked for answered and every one is
 *  empty. A row that is still loading or has failed is not an empty account. */
export function homeAllRowsEmpty(rows: HomeRows, asked: readonly HomeRowId[] = HOME_ROWS): boolean {
  return asked.every((row) => rows[row]?.status === "ok" && rows[row]!.items.length === 0 && !rows[row]!.partial);
}
