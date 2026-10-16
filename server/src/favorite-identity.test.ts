import assert from "node:assert/strict";
import { test } from "node:test";
import { favoriteIdentity, starredPath, titleOfPath } from "./favorite-identity.js";
import type { LibraryMetaRecord, TitleUnit } from "./library-match.js";

const FILM_FILE = "lib_00000001/Films/Heat/Heat.mkv";
const FILM_UNIT: TitleUnit = { key: "lib_00000001/Films/Heat", kind: "movie", relative: "Films/Heat", sampleFiles: [FILM_FILE] };
const EPISODE_FILE = "lib_00000001/Shows/Dark/S01/Dark.S01E02.mkv";
const SHOW_UNIT: TitleUnit = { key: "lib_00000001/Shows/Dark", kind: "series", relative: "Shows/Dark", sampleFiles: [EPISODE_FILE] };

const records = (entries: Array<[string, Partial<LibraryMetaRecord>]>): Record<string, LibraryMetaRecord> =>
  Object.fromEntries(entries.map(([key, record]) => [key, { type: "movie", id: "tt0", ...record } as LibraryMetaRecord]));

test("a film's file or folder stands for the title of its binding", () => {
  const bound = records([["lib_00000001/Films/Heat", { type: "movie", id: "tt1", name: "Heat" }]]);
  assert.deepEqual(titleOfPath(FILM_FILE, bound, [FILM_UNIT]), { type: "movie", id: "tt1", name: "Heat" });
  assert.deepEqual(titleOfPath("lib_00000001/Films/Heat", bound, [FILM_UNIT]), { type: "movie", id: "tt1", name: "Heat" });
});

test("a starred episode stands for its show, the way the Favourites fold reads it", () => {
  const bound = records([["lib_00000001/Shows/Dark", { type: "series", id: "tt5", name: "Dark" }]]);
  assert.deepEqual(titleOfPath(EPISODE_FILE, bound, [SHOW_UNIT]), { type: "series", id: "tt5", name: "Dark" });
  assert.equal(favoriteIdentity(EPISODE_FILE, bound, [SHOW_UNIT])?.key, "lib_00000001/Shows/Dark");
});

test("an unbound path and a record that is no title answer with nothing", () => {
  assert.equal(titleOfPath(FILM_FILE, {}, [FILM_UNIT]), undefined);
  const other = records([["lib_00000001/Films/Heat", { type: "channel", id: "c1" }]]);
  assert.equal(titleOfPath(FILM_FILE, other, [FILM_UNIT]), undefined);
});

test("a path is starred by its own star or by the title's", () => {
  const bound = records([["lib_00000001/Films/Heat", { type: "movie", id: "tt1", name: "Heat" }]]);
  const own = new Set([FILM_FILE]);
  const titleStar = { "movie:tt1": { type: "movie", id: "tt1", name: "Heat", addedAt: "" } };

  assert.equal(starredPath(FILM_FILE, own, {}, bound, [FILM_UNIT]), true, "the path's own star");
  assert.equal(starredPath(FILM_FILE, new Set(), titleStar, bound, [FILM_UNIT]), true, "the title's star");
  assert.equal(starredPath(FILM_FILE, new Set(["lib_00000001/Films/Other.mkv"]), {}, bound, [FILM_UNIT]), false);
  assert.equal(starredPath("lib_00000001/Films/Loose.mkv", new Set(), titleStar, bound, [FILM_UNIT]), false, "an unbound copy is nobody's");
});
