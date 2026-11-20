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

/** Shaped like the server's unit cache: `titleUnits` runs over library-qualified files, so the
 *  unit's `relative` is the qualified key too, not the path below the root. */
const unit = (id: string, relative: string, kind: TitleUnit["kind"] = "movie"): TitleUnit =>
  ({ key: libraryPath(id, relative), relative: libraryPath(id, relative), kind, sampleFiles: [libraryPath(id, relative)] });

const input = (overrides: Partial<SplitPlanInput> = {}): SplitPlanInput => ({
  library: parent,
  libraries: [parent],
  healthOf: () => ({}),
  units: [],
  records: {},
  downloadTargets: [],
  operationBusy: new Set(),
  topNames: [],
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

test("a loose film in a collection folder does not take the folder's binding", () => {
  const records: Record<string, LibraryMetaRecord> = {
    [libraryPath(parent.id, "Whisper Man")]: { type: "movie", id: "tt-whisper", name: "The Whisper Man", year: "2025" },
  };
  const plan = buildSplitPlan(input({
    records,
    units: [unit(parent.id, "Whisper Man/Harry Potter.mp4"), unit(parent.id, "Whisper Man/The Whisper Man (2025).mkv")],
  }));
  const byLabel = Object.fromEntries(plan.items.map((item) => [item.relative, { kind: item.kind, basis: item.basis, label: item.label }]));
  assert.deepEqual(byLabel["Whisper Man/Harry Potter.mp4"], { kind: "unknown", basis: "none", label: "Harry Potter.mp4" });
  assert.deepEqual(byLabel["Whisper Man/The Whisper Man (2025).mkv"], { kind: "movie", basis: "identified", label: "The Whisper Man (2025)" });
});

test("taken lists every name under the root once, folders without videos included", () => {
  const plan = buildSplitPlan(input({ topNames: ["notes.txt", "Empty", "Films", "Empty"] }));
  assert.deepEqual(plan.taken, ["Empty", "Films", "notes.txt"]);
});

test("a title keyed by its first file carries its other versions and is busy through them", () => {
  const first = libraryPath(parent.id, "Films/Heat (1995).mkv");
  const second = libraryPath(parent.id, "Films/Heat (1995) 1080p.mkv");
  const heat: TitleUnit = { key: first, relative: first, kind: "movie", sampleFiles: [first, second] };
  const folder: TitleUnit = {
    key: libraryPath(parent.id, "Arrival"), relative: libraryPath(parent.id, "Arrival"), kind: "movie",
    sampleFiles: [libraryPath(parent.id, "Arrival/a.mkv"), libraryPath(parent.id, "Arrival/b.mkv")],
  };
  const free = buildSplitPlan(input({ units: [heat, folder] }));
  const byKey = Object.fromEntries(free.items.map((item) => [item.key, item]));
  assert.deepEqual(byKey[first]?.files, [second]);
  assert.equal(byKey[libraryPath(parent.id, "Arrival")]?.files, undefined, "files inside a folder title move with the folder");

  const busy = buildSplitPlan(input({ units: [heat], operationBusy: new Set([second]) }));
  assert.equal(busy.items[0]?.busy, "operation");
  const downloading = buildSplitPlan(input({ units: [heat], downloadTargets: [second] }));
  assert.equal(downloading.items[0]?.busy, "download");
});
