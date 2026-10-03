import assert from "node:assert/strict";
import { test } from "node:test";
import { messageKeyOf } from "./errors.js";
import {
  SEARCH_HISTORY_LIMIT, SEARCH_HISTORY_MAX_AGE_MS, SEARCH_QUERY_MAX_LENGTH,
  defaultSearchState, historyKey, parseRecordBody, parseSearchPreferencesPatch, parseSearchState,
  publicSearchState, withRecorded, type SearchEntry, type SearchState,
} from "./search-state.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const at = (age: number) => new Date(NOW - age).toISOString();

const refusal = (run: () => unknown) => {
  try { run(); } catch (error) { return messageKeyOf(error); }
  return undefined;
};

test("historyKey folds case and whitespace but keeps diacritics", () => {
  assert.equal(historyKey("  Hello   World  "), "hello world");
  assert.equal(historyKey("HELLO\tWORLD"), "hello world");
  assert.equal(historyKey("Pes"), "pes");
  assert.notEqual(historyKey("Pes"), historyKey("Peš"), "an accent is a different query");
});

test("parseSearchState reads nothing or junk as the defaults", () => {
  for (const raw of [undefined, null, "garbage", 42, [], {}, { recent: "no" }, { saveHistory: "yes" }]) {
    assert.deepEqual(parseSearchState(raw, NOW), defaultSearchState(), JSON.stringify(raw));
  }
});

test("parseSearchState falls back field by field on wrong types", () => {
  const state = parseSearchState({ saveHistory: false, liveSearch: 1, defaultOrder: "nope", recent: {} }, NOW);
  assert.deepEqual(state, { ...defaultSearchState(), saveHistory: false });
  assert.equal(parseSearchState({ defaultOrder: "titleMatch" }, NOW).defaultOrder, "titleMatch");
});

test("parseSearchState drops blank, over-long, unparseable and expired entries", () => {
  const state = parseSearchState({
    recent: [
      { query: "   ", usedAt: at(0) },
      { query: "😀".repeat(SEARCH_QUERY_MAX_LENGTH + 1), usedAt: at(0) },
      { query: "ok", usedAt: at(0) },
      { query: "old", usedAt: at(SEARCH_HISTORY_MAX_AGE_MS + 1) },
      { query: "edge", usedAt: at(SEARCH_HISTORY_MAX_AGE_MS) },
      { query: "no-time" },
      { query: 7, usedAt: at(0) },
      { query: "bad-time", usedAt: "not a date" },
    ],
  }, NOW);
  assert.deepEqual(state.recent.map((entry) => entry.query), ["ok", "edge"]);
});

test("parseSearchState dedupes by historyKey keeping the newest spelling", () => {
  const state = parseSearchState({
    recent: [
      { query: "Heat", usedAt: at(3 * DAY) },
      { query: "  heat ", usedAt: at(DAY) },
    ],
  }, NOW);
  assert.deepEqual(state.recent, [{ query: "heat", usedAt: at(DAY) }]);
});

test("parseSearchState sorts newest first and caps at the limit", () => {
  const recent = Array.from({ length: 25 }, (_, index) => ({ query: `q${index}`, usedAt: at(index * DAY) })).reverse();
  const state = parseSearchState({ recent }, NOW);
  assert.equal(state.recent.length, SEARCH_HISTORY_LIMIT);
  assert.deepEqual(state.recent.map((entry) => entry.query),
    Array.from({ length: SEARCH_HISTORY_LIMIT }, (_, index) => `q${index}`));
});

test("parseSearchPreferencesPatch accepts an empty object and the known keys", () => {
  assert.deepEqual(parseSearchPreferencesPatch({}), {});
  assert.deepEqual(parseSearchPreferencesPatch({ saveHistory: false }), { saveHistory: false });
  assert.deepEqual(parseSearchPreferencesPatch({ liveSearch: false, defaultOrder: "titleMatch" }),
    { liveSearch: false, defaultOrder: "titleMatch" });
});

test("parseSearchPreferencesPatch refuses unknown keys, wrong types and non-objects", () => {
  for (const body of [null, "x", 7, [], { unknown: true }, { saveHistory: "yes" }, { liveSearch: 1 }, { defaultOrder: "newest" }]) {
    assert.equal(refusal(() => parseSearchPreferencesPatch(body)), "err.invalidRequest", JSON.stringify(body));
  }
});

test("parseRecordBody trims, checks code points and refuses extra keys", () => {
  assert.equal(parseRecordBody({ query: "  Heat  " }), "Heat");
  assert.equal(parseRecordBody({ query: "😀".repeat(SEARCH_QUERY_MAX_LENGTH) }), "😀".repeat(SEARCH_QUERY_MAX_LENGTH));
  for (const body of [null, "x", 7, [], {}, { query: "" }, { query: "   " },
    { query: "😀".repeat(SEARCH_QUERY_MAX_LENGTH + 1) }, { query: "Heat", extra: 1 }, { query: 7 }]) {
    assert.equal(refusal(() => parseRecordBody(body)), "err.invalidRequest", JSON.stringify(body));
  }
});

test("withRecorded moves a duplicate to the top with the newest spelling", () => {
  const before: SearchState = { ...defaultSearchState(), recent: [
    { query: "heat", usedAt: at(DAY) },
    { query: "Ronin", usedAt: at(2 * DAY) },
  ] };
  const next = withRecorded(before, "HEAT", NOW);
  assert.deepEqual(next.recent.map((entry) => entry.query), ["HEAT", "Ronin"]);
  assert.equal(next.recent[0]!.usedAt, new Date(NOW).toISOString());
  assert.equal(next.saveHistory, before.saveHistory, "the preferences are carried over");
});

test("withRecorded prunes expired entries and caps the list", () => {
  const stale: SearchEntry = { query: "stale", usedAt: at(SEARCH_HISTORY_MAX_AGE_MS + 1) };
  const fresh: SearchEntry = { query: "fresh", usedAt: at(DAY) };
  const pruned = withRecorded({ ...defaultSearchState(), recent: [stale, fresh] }, "new", NOW);
  assert.deepEqual(pruned.recent.map((entry) => entry.query), ["new", "fresh"]);

  const full: SearchEntry[] = Array.from({ length: SEARCH_HISTORY_LIMIT },
    (_, index) => ({ query: `q${index}`, usedAt: at((index + 1) * DAY) }));
  const capped = withRecorded({ ...defaultSearchState(), recent: full }, "new", NOW);
  assert.equal(capped.recent.length, SEARCH_HISTORY_LIMIT);
  assert.equal(capped.recent[0]!.query, "new");
  assert.equal(capped.recent.at(-1)!.query, `q${SEARCH_HISTORY_LIMIT - 2}`);
});

test("publicSearchState hides recent while saving is off", () => {
  const off: SearchState = { ...defaultSearchState(), saveHistory: false, recent: [{ query: "Heat", usedAt: at(DAY) }] };
  assert.deepEqual(publicSearchState(off), { ...off, recent: [] });
  const on: SearchState = { ...off, saveHistory: true };
  assert.deepEqual(publicSearchState(on).recent, off.recent);
});
