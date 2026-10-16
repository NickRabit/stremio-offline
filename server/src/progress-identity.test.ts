import assert from "node:assert/strict";
import { test } from "node:test";
import type { LibraryMetaRecord, TitleUnit } from "./library-match.js";
import { fileProgressKeys, newestProgress, titleProgressKey } from "./progress-identity.js";

const FILM_FILE = "lib_00000001/Films/Heat/Heat.mkv";
const FILM_UNIT: TitleUnit = { key: "lib_00000001/Films/Heat", kind: "movie", relative: "Films/Heat", sampleFiles: [FILM_FILE] };
const EPISODE_FILE = "lib_00000001/Shows/Dark/S01/Dark.S01E02.mkv";
const SHOW_UNIT: TitleUnit = { key: "lib_00000001/Shows/Dark", kind: "series", relative: "Shows/Dark", sampleFiles: [EPISODE_FILE] };

const records = (entries: Array<[string, Partial<LibraryMetaRecord>]>): Record<string, LibraryMetaRecord> =>
  Object.fromEntries(entries.map(([key, record]) => [key, { type: "movie", id: "tt0", ...record } as LibraryMetaRecord]));

test("a film's file stands for its folder's binding", () => {
  const bound = records([["lib_00000001/Films/Heat", { type: "movie", id: "tt1", name: "Heat" }]]);
  assert.deepEqual(titleProgressKey(FILM_FILE, bound, [FILM_UNIT]), { key: "movie:tt1", type: "movie", id: "tt1", name: "Heat" });
});

test("an episode's file stands for its show's binding and its listing numbers", () => {
  const bound = records([["lib_00000001/Shows/Dark", { type: "series", id: "tt5", name: "Dark" }]]);
  assert.deepEqual(
    titleProgressKey(EPISODE_FILE, bound, [SHOW_UNIT], { season: 1, episode: 2 }),
    { key: "series:tt5:1:2", type: "series", id: "tt5", name: "Dark", season: 1, episode: 2 },
  );
});

test("the listing's numbering beats the one the file name states", () => {
  const bound = records([["lib_00000001/Shows/Dark", { type: "series", id: "tt5", name: "Dark" }]]);
  assert.equal(titleProgressKey(EPISODE_FILE, bound, [SHOW_UNIT], { season: 3, episode: 7 })?.key, "series:tt5:3:7");
});

test("a series file no source numbers answers with nothing", () => {
  const bound = records([["lib_00000001/Shows/Dark", { type: "series", id: "tt5", name: "Dark" }]]);
  const unit: TitleUnit = { ...SHOW_UNIT, sampleFiles: ["lib_00000001/Shows/Dark/Feature.mkv"] };
  assert.equal(titleProgressKey("lib_00000001/Shows/Dark/Feature.mkv", bound, [unit]), undefined);
});

test("an unbound file and a non-video path answer with nothing", () => {
  assert.equal(titleProgressKey(FILM_FILE, {}, [FILM_UNIT]), undefined);
  assert.equal(titleProgressKey("lib_00000001/Films/Heat/poster.jpg", records([["lib_00000001/Films/Heat", {}]]), [FILM_UNIT]), undefined);
});

test("newestProgress picks the newest row and gives a tie to the title's own", () => {
  const old = { updatedAt: "2024-01-01T00:00:00.000Z" };
  const recent = { updatedAt: "2024-01-02T00:00:00.000Z" };
  assert.deepEqual(newestProgress([["file:lib_00000001/Films/Heat/Heat.mkv", recent], ["movie:tt1", old]], "movie:tt1"), ["file:lib_00000001/Films/Heat/Heat.mkv", recent]);
  assert.deepEqual(newestProgress([["file:lib_00000001/Films/Heat/Heat.mkv", old], ["movie:tt1", recent]], "movie:tt1"), ["movie:tt1", recent]);
  assert.deepEqual(newestProgress([["file:lib_00000001/Films/Heat/Heat.mkv", recent], ["movie:tt1", { ...recent }]], "movie:tt1"), ["movie:tt1", { ...recent }]);
  assert.equal(newestProgress([], "movie:tt1"), undefined);
});

test("fileProgressKeys names the file's own key and every row that carries its path", () => {
  const all = {
    [`file:${FILM_FILE}`]: { path: FILM_FILE },
    "movie:tt1": { path: FILM_FILE },
    "movie:tt2": { path: "lib_00000001/Films/Other.mkv" },
  } as Record<string, { path?: string }>;

  assert.deepEqual(fileProgressKeys(all, FILM_FILE).sort(), ["file:lib_00000001/Films/Heat/Heat.mkv", "movie:tt1"]);
  assert.deepEqual(fileProgressKeys({}, "lib_00000001/Films/Nothing.mkv"), ["file:lib_00000001/Films/Nothing.mkv"]);
});
