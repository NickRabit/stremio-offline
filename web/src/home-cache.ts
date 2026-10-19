import { version } from "../package.json";
import type { HomeCard, HomeOrderEntry, HomeRowId } from "../../server/src/home";
import type { HomeRows } from "./home-state";

export interface CachedHome { order: HomeOrderEntry[]; rows: HomeRows }

export const HOME_CACHE_PREFIX = "home-cache:";
export const HOME_CACHE_MAX_BYTES = 600_000;

const keyFor = (account: string) => `${HOME_CACHE_PREFIX}${account}`;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The account's last Home, or null when there is none, it is from another app version, or
 *  storage is unavailable or holds something unreadable. Every returned row is "ok", settled and
 *  request 0. */
export function readHomeCache(account: string): CachedHome | null {
  try {
    const stored = localStorage.getItem(keyFor(account));
    if (stored === null) return null;
    const value: unknown = JSON.parse(stored);
    if (!isRecord(value) || value.version !== version) return null;
    if (!Array.isArray(value.order) || !value.order.every((entry) => isRecord(entry) && typeof entry.id === "string")) return null;
    if (!isRecord(value.rows)) return null;

    const order = value.order.map((entry) => ({
      id: (entry as Record<string, unknown>).id as HomeRowId,
      ...(typeof (entry as Record<string, unknown>).title === "string" ? { title: (entry as Record<string, string>).title } : {}),
    }));
    const rows: HomeRows = {};
    for (const [id, row] of Object.entries(value.rows)) {
      if (!isRecord(row) || !Array.isArray(row.items)) return null;
      if (!row.items.every((item) => isRecord(item) && typeof item.key === "string" && typeof item.kind === "string")) return null;
      rows[id as HomeRowId] = {
        status: "ok",
        items: row.items as HomeCard[],
        hasMore: row.hasMore === true,
        ...(typeof row.total === "number" ? { total: row.total } : {}),
        partial: row.partial === true,
        request: 0,
        settled: true,
      };
    }
    return { order, rows };
  } catch { return null; }
}

/** Stores the order and every row that has cards or was answered. An answered empty row is
 *  kept so the next start knows not to draw a skeleton for it. Skips silently when the JSON is over HOME_CACHE_MAX_BYTES or
 *  storage throws. */
export function writeHomeCache(account: string, order: HomeOrderEntry[], rows: HomeRows): void {
  try {
    const storedRows = Object.fromEntries(Object.entries(rows).flatMap(([id, row]) =>
      row && (row.items.length > 0 || row.status === "ok")
        ? [[id, {
            items: row.items,
            hasMore: row.hasMore,
            ...(row.total !== undefined ? { total: row.total } : {}),
            partial: row.partial,
          }]]
        : []));
    const json = JSON.stringify({ version, order, rows: storedRows });
    if (new TextEncoder().encode(json).length > HOME_CACHE_MAX_BYTES) return;
    localStorage.setItem(keyFor(account), json);
  } catch { /* storage may be unavailable or full */ }
}

/** Removes every key that starts with HOME_CACHE_PREFIX. */
export function clearHomeCache(): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(HOME_CACHE_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch { /* storage may be unavailable */ }
}
