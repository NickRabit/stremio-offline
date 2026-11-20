import assert from "node:assert/strict";
import { test } from "node:test";
import type { LibraryMetaRecord, TitleUnit } from "./library-match.js";
import { libraryPath, type LibraryRecord } from "./libraries.js";
import { buildSplitPlan, type SplitPlanInput } from "./library-split.js";

const parent: LibraryRecord = {
  id: "lib_aaaaaaaa",
  name: "Media",
  type: "mixed",
  root: "/media/library",
  enabled: true,
  order: 0,
  addedAt: "2024-01-01T00:00:00.000Z",
  writeArtwork: false,
};

const unit = (id: string, relative: string, kind: TitleUnit["kind"] = "movie"): TitleUnit =>
  ({ key: libraryPath(id, relative), relative, kind, sampleFiles: [libraryPath(id, relative)] });

const input = (overrides: Partial<SplitPlanInput> = {}): SplitPlanInput => ({
  library: parent,
  libraries: [parent],
  healthOf: () => ({}),
  units: [],
  records: {},
  downloadTargets: [],
  operationBusy: new Set(),
  ...overrides,
});

test("a mixed library identifies bound titles and guesses only series-shaped units", () => {
  const film = "Films/Arrival";
  const show = "Shows/Dark";
  const guessedShow = "Shows/Guess";
  const loose = "Loose.mkv";
  const records: Record<string, LibraryMetaRecord> = {
    [libraryPath(parent.id, film)]: { type: "movie", id: "tt-film", name: "Arrival", year: "2016" },
    [libraryPath(parent.id, show)]: { type: "series", id: "tt-show", name: "Dark" },
  };
  const plan = buildSplitPlan(input({
    records,
    units: [
      unit(parent.id, film),
      unit(parent.id, show, "series"),
      unit(parent.id, guessedShow, "series"),
      unit(parent.id, loose),
    ],
  }));

  assert.deepEqual(plan.items.map(({ relative, label, kind, basis }) => ({ relative, label, kind, basis })), [
    { relative: film, label: "Arrival (2016)", kind: "movie", basis: "identified" },
    { relative: show, label: "Dark", kind: "series", basis: "identified" },
    { relative: guessedShow, label: "Guess", kind: "series", basis: "guessed" },
    { relative: loose, label: "Loose.mkv", kind: "unknown", basis: "none" },
  ]);
  assert.ok(plan.items.every((item) => item.key.startsWith(`${parent.id}/`)));
  assert.deepEqual(plan.counts, { movies: 1, series: 2, unknown: 1 });
  assert.equal(plan.counts.movies + plan.counts.series + plan.counts.unknown, plan.items.length);
});

test("unmatched and id-less records are not identified", () => {
  const unmatched = "Unmatched.mkv";
  const idless = "No id.mkv";
  const plan = buildSplitPlan(input({
    records: {
      [libraryPath(parent.id, unmatched)]: { type: "movie", id: "", unmatched: true },
      [libraryPath(parent.id, idless)]: { type: "movie", id: "" },
    },
    units: [unit(parent.id, unmatched), unit(parent.id, idless)],
  }));

  assert.deepEqual(plan.items.map(({ kind, basis }) => ({ kind, basis })), [
    { kind: "unknown", basis: "none" },
    { kind: "unknown", basis: "none" },
  ]);
});

test("a typed library guesses its own kind for unidentified units", () => {
  const movieLibrary = { ...parent, type: "movie" as const };
  const plan = buildSplitPlan(input({
    library: movieLibrary,
    libraries: [movieLibrary],
    units: [unit(movieLibrary.id, "Loose.mkv")],
  }));

  assert.deepEqual(plan.items.map(({ kind, basis }) => ({ kind, basis })), [{ kind: "movie", basis: "guessed" }]);
});

test("only units keyed to the parent library are listed", () => {
  const child = { ...parent, id: "lib_bbbbbbbb", name: "Child", root: "/media/library/child" };
  const outside = { ...parent, id: "lib_cccccccc", name: "Outside", root: "/media/outside" };
  const plan = buildSplitPlan(input({
    libraries: [parent, child, outside],
    units: [
      unit(parent.id, "Owned.mkv"),
      unit(child.id, "Nested.mkv"),
      unit(outside.id, "Elsewhere.mkv"),
    ],
  }));

  assert.deepEqual(plan.items.map((item) => item.relative), ["Owned.mkv"]);
});

test("children inside the parent root use posix relatives and fall back to stored health", () => {
  const first = { ...parent, id: "lib_bbbbbbbb", name: "First", root: "/media/library/z/child", enabled: false, unreachable: true, readOnly: true };
  const second = { ...parent, id: "lib_cccccccc", name: "Second", root: "/media/library/a", unreachable: true, readOnly: true };
  const outside = { ...parent, id: "lib_dddddddd", name: "Outside", root: "/media/outside" };
  const plan = buildSplitPlan(input({
    libraries: [parent, first, outside, second],
    healthOf: (library) => library.id === second.id ? { unreachable: false, readOnly: true } : {},
  }));

  assert.deepEqual(plan.children, [
    { id: second.id, name: "Second", type: "mixed", relative: "a", enabled: true, unreachable: false, readOnly: true },
    { id: first.id, name: "First", type: "mixed", relative: "z/child", enabled: false, unreachable: true, readOnly: true },
  ]);
});

test("folders count deeper units, omit title folders, and respect child roots", () => {
  const child = { ...parent, id: "lib_bbbbbbbb", name: "Kids", root: "/media/library/Kids/Shows" };
  const plan = buildSplitPlan(input({
    libraries: [parent, child],
    records: {
      [libraryPath(parent.id, "Filmy/One")]: { type: "movie", id: "tt-one", name: "One" },
      [libraryPath(parent.id, "Filmy/Two")]: { type: "movie", id: "tt-two", name: "Two" },
    },
    units: [
      unit(parent.id, "Filmy/One"),
      unit(parent.id, "Filmy/Two"),
      unit(parent.id, "Avatar (2009)"),
      unit(parent.id, "Kids/Show", "series"),
    ],
  }));

  assert.deepEqual(plan.folders, [{ name: "Filmy", movies: 2, series: 0, unknown: 0 }]);
});

test("download busy wins over operation busy, and containment is per unit", () => {
  const downloading = unit(parent.id, "Shows/Downloading", "series");
  const operating = unit(parent.id, "Films/Operating");
  const unrelated = unit(parent.id, "Films/Free");
  const plan = buildSplitPlan(input({
    units: [downloading, operating, unrelated],
    downloadTargets: [libraryPath(parent.id, "Shows/Downloading/S01E01.part")],
    operationBusy: new Set([downloading.key, operating.key]),
  }));

  assert.deepEqual(plan.items.map(({ relative, busy }) => ({ relative, busy })), [
    { relative: "Shows/Downloading", busy: "download" },
    { relative: "Films/Free", busy: undefined },
    { relative: "Films/Operating", busy: "operation" },
  ]);
  assert.deepEqual(plan.counts, { movies: 0, series: 1, unknown: 2 });
});
