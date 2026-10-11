import assert from "node:assert/strict";
import { test } from "node:test";
import type { FoundFile } from "./library.js";
import { parseLibraryPath, libraryPath, type LibraryRecord, type LibraryType } from "./libraries.js";
import { titleUnits, unmatchAt, withSkipFlag, type LibraryMetaRecord, type TitleUnit } from "./library-match.js";
import { LOCAL_COPY_LIMIT, localCopies, parseLocalRequest } from "./local-sources.js";

const library = (id: string, overrides: Partial<LibraryRecord> & { type?: LibraryType } = {}): LibraryRecord => ({
  id, name: `Library ${id}`, type: "movie", root: `/media/${id}`, enabled: true,
  order: 0, addedAt: "2024-01-01T00:00:00.000Z", writeArtwork: false, ...overrides,
});

const found = (id: string, relative: string, size = 1): FoundFile =>
  ({ relative: libraryPath(id, relative), size, modified: "2026-01-01T00:00:00.000Z" });

/** The units just the way `unitCache` in index.ts builds them: qualified files, one library at a time. */
const unitsOf = (files: FoundFile[], libraries: LibraryRecord[]): TitleUnit[] =>
  libraries.flatMap((entry) => titleUnits(files.filter((file) => parseLibraryPath(file.relative)?.libraryId === entry.id), entry.type));

const movie = (id: string): LibraryMetaRecord => ({ type: "movie", id, source: "user" });
const series = (id: string): LibraryMetaRecord => ({ type: "series", id, source: "user" });

test("parseLocalRequest reads a movie id as it is and an episode id from its last two parts", () => {
  assert.deepEqual(parseLocalRequest("movie", "tt2975148"), { type: "movie", titleId: "tt2975148" });
  assert.deepEqual(parseLocalRequest("series", "tt1:1:2"), { type: "series", titleId: "tt1", season: 1, episode: 2 });
  assert.deepEqual(parseLocalRequest("series", "kitsu:5:3"), { type: "series", titleId: "kitsu", season: 5, episode: 3 });
  assert.deepEqual(parseLocalRequest("series", "tmdb:123:4:5"), { type: "series", titleId: "tmdb:123", season: 4, episode: 5 });
  assert.equal(parseLocalRequest("series", "tt1"), undefined);
  assert.equal(parseLocalRequest("series", "tt1:1"), undefined);
  assert.equal(parseLocalRequest("series", "tt1:x:2"), undefined);
  assert.equal(parseLocalRequest("series", "tt1:1:-2"), undefined);
  assert.equal(parseLocalRequest("series", "tt1:1:2:3:x"), undefined);
  assert.equal(parseLocalRequest("channel", "anything"), undefined);
});

test("a movie bound on its folder answers one copy", () => {
  const lib = library("lib_00000001");
  const files = [found(lib.id, "Heat (1995)/Heat.1995.1080p.mkv", 900)];
  const copies = localCopies({
    type: "movie", id: "tt0113277", files, units: unitsOf(files, [lib]),
    records: { [libraryPath(lib.id, "Heat (1995)")]: movie("tt0113277") },
    libraries: [lib],
  });
  assert.deepEqual(copies, [{ key: libraryPath(lib.id, "Heat (1995)/Heat.1995.1080p.mkv"), libraryId: lib.id, size: 900 }]);
});

test("a shared folder with two encodes of one film offers both, and not the other film", () => {
  const lib = library("lib_00000001");
  const files = [
    found(lib.id, "Shelf/Heat.1995.1080p.mkv", 900),
    found(lib.id, "Shelf/Heat.1995.720p.mkv", 400),
    found(lib.id, "Shelf/Ronin.1998.mkv", 700),
  ];
  const units = unitsOf(files, [lib]);
  const representative = libraryPath(lib.id, "Shelf/Heat.1995.1080p.mkv");
  const second = libraryPath(lib.id, "Shelf/Heat.1995.720p.mkv");
  const ronin = libraryPath(lib.id, "Shelf/Ronin.1998.mkv");
  assert.equal(units.find((unit) => unit.key === representative)?.sampleFiles.length, 2, "the encodes share one file-keyed unit");

  const records: Record<string, LibraryMetaRecord> = { [representative]: movie("tt0113277") };
  const copies = localCopies({ type: "movie", id: "tt0113277", files, units, records, libraries: [lib] });
  assert.deepEqual(copies.map((copy) => copy.key), [representative, second], "both encodes, the larger first");
  assert.ok(!copies.some((copy) => copy.key === ronin));

  const rebound = { ...records, [second]: movie("tt0084597") };
  assert.deepEqual(localCopies({ type: "movie", id: "tt0113277", files, units, records: rebound, libraries: [lib] }).map((copy) => copy.key), [representative]);

  // The library keeps a path a person took out of matching as a flag; Unmatch then writes the
  // marker that drops the inherited binding, which is what this asserts stays honoured.
  const unmatched = unmatchAt(withSkipFlag(records, second, "skipLookup", true), second);
  assert.deepEqual(localCopies({ type: "movie", id: "tt0113277", files, units, records: unmatched, libraries: [lib] }).map((copy) => copy.key), [representative]);
});

test("a file unmatched inside a bound folder is left out", () => {
  const lib = library("lib_00000001");
  const files = [
    found(lib.id, "Heat (1995)/Heat.1995.1080p.mkv"),
    found(lib.id, "Heat (1995)/Heat.1995.720p.mkv"),
  ];
  const bound = libraryPath(lib.id, "Heat (1995)");
  const second = libraryPath(lib.id, "Heat (1995)/Heat.1995.720p.mkv");
  const records = unmatchAt({ [bound]: movie("tt0113277") }, second);
  assert.deepEqual(localCopies({
    type: "movie", id: "tt0113277", files, units: unitsOf(files, [lib]), records, libraries: [lib],
  }).map((copy) => copy.key), [libraryPath(lib.id, "Heat (1995)/Heat.1995.1080p.mkv")]);
});

test("a nearer folder that is a title of its own keeps its files off the folder above", () => {
  const lib = library("lib_00000001");
  const files = [
    found(lib.id, "Collection/Film A/Film A.mkv"),
    found(lib.id, "Collection/Film B/Film B.mkv"),
  ];
  const records: Record<string, LibraryMetaRecord> = {
    [libraryPath(lib.id, "Collection")]: movie("tt_coll"),
    [libraryPath(lib.id, "Collection/Film A")]: movie("tt_other"),
  };
  assert.deepEqual(localCopies({
    type: "movie", id: "tt_coll", files, units: unitsOf(files, [lib]), records, libraries: [lib],
  }).map((copy) => copy.key), [libraryPath(lib.id, "Collection/Film B/Film B.mkv")]);
});

test("a season folder inside a show is not a unit and keeps the show's binding", () => {
  const lib = library("lib_00000001", { type: "series" });
  const files = [
    found(lib.id, "Show/Season 1/Show S01E01.mkv"),
    found(lib.id, "Show/Season 1/Show S01E02.mkv"),
    found(lib.id, "Show/Season 2/Show S02E01.mkv"),
  ];
  const units = unitsOf(files, [lib]);
  assert.deepEqual(units.map((unit) => unit.key), [libraryPath(lib.id, "Show")]);
  const records = { [libraryPath(lib.id, "Show")]: series("tt1") };
  const copies = (id: string) => localCopies({ type: "series", id, files, units, records, libraries: [lib] }).map((copy) => copy.key);
  assert.deepEqual(copies("tt1:1:2"), [libraryPath(lib.id, "Show/Season 1/Show S01E02.mkv")]);
  assert.deepEqual(copies("tt1:1:3"), []);
  assert.deepEqual(copies("tt1"), []);
  assert.deepEqual(copies("kitsu:5:3"), []);
  assert.deepEqual(copies("tt1:1:x"), []);
});

test("a copy whose record is another type is not a movie copy", () => {
  const lib = library("lib_00000001", { type: "series" });
  const files = [found(lib.id, "Show/Season 1/Show S01E01.mkv")];
  assert.deepEqual(localCopies({
    type: "movie", id: "tt1", files, units: unitsOf(files, [lib]),
    records: { [libraryPath(lib.id, "Show")]: series("tt1") }, libraries: [lib],
  }), []);
});

test("a copy in a library the viewer may not see stays out, and the answer is empty", () => {
  const visible = library("lib_00000001");
  const hidden = library("lib_00000002", { order: 1 });
  const files = [
    found(visible.id, "Heat (1995)/Heat.1995.1080p.mkv"),
    found(hidden.id, "Heat (1995)/Heat.1995.1080p.mkv"),
  ];
  const records: Record<string, LibraryMetaRecord> = {
    [libraryPath(visible.id, "Heat (1995)")]: movie("tt0113277"),
    [libraryPath(hidden.id, "Heat (1995)")]: movie("tt0113277"),
  };
  const units = unitsOf(files, [visible, hidden]);
  assert.deepEqual(localCopies({ type: "movie", id: "tt0113277", files, units, records, libraries: [visible] }).map((copy) => copy.libraryId), [visible.id]);
  assert.deepEqual(localCopies({ type: "movie", id: "tt0113277", files, units, records, libraries: [] }), []);
});

test("the order follows the libraries' order, not the array they arrive in", () => {
  const second = library("lib_00000002", { order: 2 });
  const first = library("lib_00000001", { order: 1 });
  const files = [
    found(second.id, "Heat (1995)/Heat.1995.1080p.mkv", 900),
    found(first.id, "Heat (1995)/Heat.1995.720p.mkv", 100),
  ];
  const records: Record<string, LibraryMetaRecord> = {
    [libraryPath(second.id, "Heat (1995)")]: movie("tt0113277"),
    [libraryPath(first.id, "Heat (1995)")]: movie("tt0113277"),
  };
  assert.deepEqual(localCopies({
    type: "movie", id: "tt0113277", files, units: unitsOf(files, [second, first]), records, libraries: [second, first],
  }).map((copy) => copy.libraryId), [first.id, second.id]);
});

test("copies of one library are ordered by size, then by path", () => {
  const lib = library("lib_00000001");
  const files = [
    found(lib.id, "Heat (1995)/a/Heat.mkv", 100),
    found(lib.id, "Heat (1995)/b/Heat.mkv", 300),
    found(lib.id, "Heat (1995)/c/Heat.mkv", 300),
  ];
  assert.deepEqual(localCopies({
    type: "movie", id: "tt0113277", files, units: unitsOf(files, [lib]),
    records: { [libraryPath(lib.id, "Heat (1995)")]: movie("tt0113277") }, libraries: [lib],
  }).map((copy) => copy.key), [
    libraryPath(lib.id, "Heat (1995)/b/Heat.mkv"),
    libraryPath(lib.id, "Heat (1995)/c/Heat.mkv"),
    libraryPath(lib.id, "Heat (1995)/a/Heat.mkv"),
  ]);
});

test("the answer is capped at the local copy limit", () => {
  const lib = library("lib_00000001");
  const files = Array.from({ length: LOCAL_COPY_LIMIT + 5 }, (_, index) =>
    found(lib.id, `Heat (1995)/v${String(index).padStart(2, "0")}/Heat.mkv`, 1000 + index));
  const copies = localCopies({
    type: "movie", id: "tt0113277", files, units: unitsOf(files, [lib]),
    records: { [libraryPath(lib.id, "Heat (1995)")]: movie("tt0113277") }, libraries: [lib],
  });
  assert.equal(copies.length, LOCAL_COPY_LIMIT);
});

test("a file in a library with no matching record is not a copy", () => {
  const lib = library("lib_00000001");
  const files = [found(lib.id, "Heat (1995)/Heat.1995.1080p.mkv")];
  assert.deepEqual(localCopies({
    type: "movie", id: "tt0113277", files, units: unitsOf(files, [lib]),
    records: { [libraryPath(lib.id, "Heat (1995)")]: movie("tt9999999") }, libraries: [lib],
  }), []);
});
