import type { HomeCard, HomeOrderEntry, HomeRowId } from "../../server/src/home";
import type { HomeRows } from "./home-state";

export interface CachedHome { order: HomeOrderEntry[]; rows: HomeRows }

export const HOME_CACHE_PREFIX = "home-cache:";
export const HOME_CACHE_MAX_BYTES = 600_000;
// Raise it by hand whenever the stored shape (the JSON written by `writeHomeCache` or the `HomeCard` fields the page reads) changes.
export const HOME_CACHE_FORMAT = 1;

const keyFor = (account: string) => `${HOME_CACHE_PREFIX}${account}`;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type FieldType = "str" | "num" | "arr" | "progress" | "candidate";
const CARD_FIELDS: Record<HomeCard["kind"], Record<string, FieldType>> = {
  remote: { key: "str", title: "str", provider: "str", libraryId: "str", libraryName: "str", itemId: "str", itemType: "str", updatedAt: "str" },
  "resume-file": { key: "str", title: "str", path: "str", updatedAt: "str", progress: "progress", forgetKeys: "arr" },
  "resume-catalogue": { key: "str", title: "str", type: "str", id: "str", name: "str", updatedAt: "str", forgetKeys: "arr" },
  completed: { key: "str", title: "str", path: "str", completedAt: "str" },
  favorite: { key: "str", path: "str", itemKind: "str", label: "str" },
  "favorite-catalogue": { key: "str", type: "str", id: "str", name: "str" },
  recent: { key: "str", path: "str", label: "str", addedAt: "str", libraryId: "str" },
  episode: { key: "str", followId: "str", type: "str", metaId: "str", name: "str", released: "str", season: "num", episode: "num" },
  discovery: { key: "str", type: "str", id: "str", name: "str", title: "str" },
  tonight: { key: "str", path: "str", itemKind: "str", label: "str", libraryId: "str" },
  confirm: { key: "str", libraryId: "str", library: "str", label: "str", path: "str", candidate: "candidate" },
};

const OPTIONAL_STRINGS = ["poster", "wide", "subtitle", "year", "seriesPath", "seriesName", "series", "episodeName", "addonKey", "mediaSourceId"];
const OPTIONAL_NUMBERS = ["season", "episode"];

const validProgress = (value: unknown): boolean =>
  isRecord(value) && typeof value.position === "number" && typeof value.duration === "number";

const validField = (type: FieldType, value: unknown): boolean => {
  if (type === "str") return typeof value === "string";
  if (type === "num") return typeof value === "number";
  if (type === "arr") return Array.isArray(value) && value.every((entry) => typeof entry === "string");
  if (type === "progress") return validProgress(value);
  return isRecord(value) && typeof value.name === "string";
};

function validCard(item: unknown): boolean {
  if (!isRecord(item) || typeof item.kind !== "string") return false;
  if (!Object.prototype.hasOwnProperty.call(CARD_FIELDS, item.kind)) return false;
  const fields = CARD_FIELDS[item.kind as HomeCard["kind"]];
  for (const [name, type] of Object.entries(fields)) {
    if (!validField(type, item[name])) return false;
  }
  if (item.progress !== undefined && !validProgress(item.progress)) return false;
  if (OPTIONAL_STRINGS.some((name) => item[name] !== undefined && typeof item[name] !== "string")) return false;
  return OPTIONAL_NUMBERS.every((name) => item[name] === undefined || typeof item[name] === "number");
}

/** The account's last Home, or null when there is none, it is from another format, or
 *  storage is unavailable or holds something unreadable. Every returned row is "ok", settled and
 *  request 0. */
export function readHomeCache(account: string): CachedHome | null {
  try {
    const stored = localStorage.getItem(keyFor(account));
    if (stored === null) return null;
    const value: unknown = JSON.parse(stored);
    if (!isRecord(value) || value.format !== HOME_CACHE_FORMAT) return null;
    if (!Array.isArray(value.order) || !value.order.every((entry) => isRecord(entry) && typeof entry.id === "string")) return null;
    if (!isRecord(value.rows)) return null;

    const order = value.order.map((entry) => ({
      id: (entry as Record<string, unknown>).id as HomeRowId,
      ...(typeof (entry as Record<string, unknown>).title === "string" ? { title: (entry as Record<string, string>).title } : {}),
    }));
    const rows: HomeRows = {};
    for (const [id, row] of Object.entries(value.rows)) {
      if (!isRecord(row) || !Array.isArray(row.items)) return null;
      if (!row.items.every(validCard)) return null;
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
    const json = JSON.stringify({ format: HOME_CACHE_FORMAT, order, rows: storedRows });
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
