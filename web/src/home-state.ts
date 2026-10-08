import type { HomeCard, HomeResponse, HomeRowId } from "../../server/src/home";

/** The three server rows below the Downloads row, in the order Home draws them. */
export const HOME_ROWS: readonly HomeRowId[] = ["resume", "completed", "favorites"];

export type HomeRowStatus = "idle" | "loading" | "ok" | "error";

export interface HomeRowState {
  status: HomeRowStatus;
  items: HomeCard[];
  hasMore: boolean;
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
    next[row] = { status: "ok", items: answered.items, hasMore: answered.hasMore, partial: answered.partial === true, request: current.request };
  }
  return next;
}

/** The page-wide empty state only: every server row answered and every one is empty. A row
 *  that is still loading or has failed is not an empty account. */
export function homeAllRowsEmpty(rows: HomeRows): boolean {
  return HOME_ROWS.every((row) => rows[row]?.status === "ok" && rows[row]!.items.length === 0);
}
