import { AppError } from "./errors.js";

export type SearchOrder = "source" | "titleMatch";
export type SearchEntry = { query: string; usedAt: string };
export type SearchState = {
  saveHistory: boolean;
  liveSearch: boolean;
  defaultOrder: SearchOrder;
  recent: SearchEntry[];
};
export type SearchPreferences = Pick<SearchState, "saveHistory" | "liveSearch" | "defaultOrder">;

export const SEARCH_HISTORY_LIMIT = 20;
export const SEARCH_HISTORY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const SEARCH_QUERY_MAX_LENGTH = 200;

export const defaultSearchState = (): SearchState =>
  ({ saveHistory: true, liveSearch: true, defaultOrder: "source", recent: [] });

/** Duplicate detection only: NFC, trim, collapse whitespace runs to one space,
 *  toLowerCase(). Diacritics are KEPT ("Pes" and "Peš" differ). */
export function historyKey(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

const refused = () => new AppError("The request was not understood.", "err.invalidRequest");

/** Anything but a plain object is read as nothing stored. */
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const ORDERS: readonly SearchOrder[] = ["source", "titleMatch"];

const pickOrder = (value: unknown): SearchOrder | undefined =>
  typeof value === "string" && (ORDERS as readonly string[]).includes(value) ? value as SearchOrder : undefined;

const has = (source: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(source, key);

const codePoints = (text: string) => [...text].length;

const parseEntry = (value: unknown, now: number): SearchEntry | undefined => {
  const source = asRecord(value);
  if (typeof source.query !== "string" || typeof source.usedAt !== "string") return undefined;
  const query = source.query.trim();
  if (!query || codePoints(query) > SEARCH_QUERY_MAX_LENGTH) return undefined;
  const usedAt = Date.parse(source.usedAt);
  if (!Number.isFinite(usedAt) || now - usedAt > SEARCH_HISTORY_MAX_AGE_MS) return undefined;
  return { query, usedAt: source.usedAt };
};

/** Tolerant read of whatever is stored (undefined, garbage, old shapes):
 *  wrong-typed preference -> its default; recent keeps only entries with a
 *  non-empty string query (<= max length) and a parseable usedAt not older than
 *  max age relative to `now`; dedupe by historyKey keeping the first (newest);
 *  sort newest first by usedAt; cap at the limit. Never throws. */
export function parseSearchState(raw: unknown, now: number = Date.now()): SearchState {
  const source = asRecord(raw);
  const defaults = defaultSearchState();
  const state: SearchState = {
    saveHistory: typeof source.saveHistory === "boolean" ? source.saveHistory : defaults.saveHistory,
    liveSearch: typeof source.liveSearch === "boolean" ? source.liveSearch : defaults.liveSearch,
    defaultOrder: pickOrder(source.defaultOrder) ?? defaults.defaultOrder,
    recent: [],
  };
  const entries = Array.isArray(source.recent) ? source.recent : [];
  const valid = entries
    .map((entry) => parseEntry(entry, now))
    .filter((entry): entry is SearchEntry => entry !== undefined)
    .sort((a, b) => Date.parse(b.usedAt) - Date.parse(a.usedAt));
  const seen = new Set<string>();
  for (const entry of valid) {
    const key = historyKey(entry.query);
    if (seen.has(key)) continue;
    seen.add(key);
    state.recent.push(entry);
  }
  state.recent = state.recent.slice(0, SEARCH_HISTORY_LIMIT);
  return state;
}

/** Strict: body must be a plain object; only the three preference keys allowed;
 *  saveHistory/liveSearch must be boolean, defaultOrder one of the two values.
 *  Any unknown key or wrong type -> throw refused(). Empty object is allowed. */
export function parseSearchPreferencesPatch(body: unknown): Partial<SearchPreferences> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw refused();
  const source = body as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (key !== "saveHistory" && key !== "liveSearch" && key !== "defaultOrder") throw refused();
  }
  const patch: Partial<SearchPreferences> = {};
  if (has(source, "saveHistory")) {
    if (typeof source.saveHistory !== "boolean") throw refused();
    patch.saveHistory = source.saveHistory;
  }
  if (has(source, "liveSearch")) {
    if (typeof source.liveSearch !== "boolean") throw refused();
    patch.liveSearch = source.liveSearch;
  }
  if (has(source, "defaultOrder")) {
    const order = pickOrder(source.defaultOrder);
    if (order === undefined) throw refused();
    patch.defaultOrder = order;
  }
  return patch;
}

/** Strict: body must be a plain object with `query` a string; trimmed result
 *  must be non-empty and <= SEARCH_QUERY_MAX_LENGTH code points; any other key
 *  -> refused(). Returns the trimmed query (original spelling kept). */
export function parseRecordBody(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw refused();
  const source = body as Record<string, unknown>;
  for (const key of Object.keys(source)) if (key !== "query") throw refused();
  if (typeof source.query !== "string") throw refused();
  const query = source.query.trim();
  if (!query || codePoints(query) > SEARCH_QUERY_MAX_LENGTH) throw refused();
  return query;
}

/** Pure: puts {query, usedAt: new Date(now).toISOString()} first, removes any
 *  older entry with the same historyKey, prunes expired, caps at the limit. */
export function withRecorded(state: SearchState, query: string, now: number): SearchState {
  const entry: SearchEntry = { query, usedAt: new Date(now).toISOString() };
  const key = historyKey(query);
  const recent = [entry, ...state.recent.filter((item) => historyKey(item.query) !== key)]
    .filter((item) => now - Date.parse(item.usedAt) <= SEARCH_HISTORY_MAX_AGE_MS)
    .slice(0, SEARCH_HISTORY_LIMIT);
  return { ...state, recent };
}

/** Pure: drops every entry whose historyKey equals historyKey(query); the rest
 *  keep their order. Preferences are untouched. */
export function withoutQuery(state: SearchState, query: string): SearchState {
  const key = historyKey(query);
  const recent = state.recent.filter((item) => historyKey(item.query) !== key);
  return { ...state, recent };
}

/** What the API returns: recent is [] when saveHistory is false. */
export function publicSearchState(state: SearchState): SearchState {
  return { ...state, recent: state.saveHistory ? state.recent : [] };
}
