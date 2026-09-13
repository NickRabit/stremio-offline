import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { carveOuts, defaultLibrary, libraryFor, libraryPath, parseLibraryPath, relativeWithin, resolveLibraryPath, toFs, toPosix, type LibraryRecord } from "./libraries.js";

const library = (over: Partial<LibraryRecord> = {}): LibraryRecord => ({
  id: "lib_ab12cd34", name: "Filmy", type: "movie", root: "/media/filmy", enabled: true,
  order: 0, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: true, ...over,
});

test("a qualified path splits into the library id and the relative path", () => {
  assert.deepEqual(parseLibraryPath("lib_ab12cd34/Show/01 serie/01.mkv"), { libraryId: "lib_ab12cd34", relative: "Show/01 serie/01.mkv" });
  assert.deepEqual(parseLibraryPath("lib_ab12cd34"), { libraryId: "lib_ab12cd34", relative: "" });
  assert.deepEqual(parseLibraryPath("lib_ab12cd34/Show"), { libraryId: "lib_ab12cd34", relative: "Show" });
  assert.deepEqual(parseLibraryPath("/lib_ab12cd34/Show/"), { libraryId: "lib_ab12cd34", relative: "Show" });
});

test("an unqualified path is not a library path", () => {
  assert.equal(parseLibraryPath("Show/01.mkv"), undefined);
  assert.equal(parseLibraryPath(""), undefined);
  assert.equal(parseLibraryPath("lib_AB12CD34/Show"), undefined, "ids are lowercase hex");
  assert.equal(parseLibraryPath("lib_ab12cd345/Show"), undefined);
});

test("a qualified path is built back from its parts", () => {
  assert.equal(libraryPath("lib_ab12cd34", "Show/01.mkv"), "lib_ab12cd34/Show/01.mkv");
  assert.equal(libraryPath("lib_ab12cd34", ""), "lib_ab12cd34");
  assert.equal(libraryPath("lib_ab12cd34", "/Show/"), "lib_ab12cd34/Show");
  assert.equal(relativeWithin("lib_ab12cd34", "lib_ab12cd34/Show/01.mkv"), "Show/01.mkv");
  assert.equal(relativeWithin("lib_ab12cd34", "lib_ab12cd34"), "");
  assert.equal(relativeWithin("lib_ab12cd34", ":favorites"), ":favorites", "a virtual path is untouched");
});

test("the wire separator is POSIX and the filesystem one is native", () => {
  assert.equal(toPosix("Show/01.mkv"), "Show/01.mkv");
  assert.equal(toFs("Show/01.mkv"), ["Show", "01.mkv"].join(path.sep));
  assert.equal(toPosix(toFs("Show/01.mkv")), "Show/01.mkv");
});

test("the default library follows the stored id, the kind and the order", () => {
  const movie = library({ id: "lib_11111111", type: "movie", order: 1 });
  const series = library({ id: "lib_22222222", type: "series", order: 2 });
  const mixed = library({ id: "lib_33333333", type: "mixed", order: 3 });
  const all = [movie, series, mixed];
  assert.equal(defaultLibrary(all, { defaultMovieLibrary: "lib_33333333" }, "movie")?.id, "lib_33333333");
  assert.equal(defaultLibrary(all, {}, "movie")?.id, "lib_11111111");
  assert.equal(defaultLibrary(all, {}, "episode")?.id, "lib_22222222");
  assert.equal(defaultLibrary([series, mixed], {}, "movie")?.id, mixed.id, "a movie download falls back to mixed");
  assert.equal(defaultLibrary([movie, mixed], {}, "episode")?.id, mixed.id);
  assert.equal(defaultLibrary([movie], { defaultSeriesLibrary: "lib_11111111" }, "episode"), undefined, "a movie library cannot take an episode");
  assert.equal(defaultLibrary([series], { defaultSeriesLibrary: "lib_22222222" }, "episode")?.id, series.id);
  assert.equal(defaultLibrary([library({ id: "lib_44444444", enabled: false }), mixed], {}, "movie")?.id, mixed.id);
  assert.equal(defaultLibrary([library({ id: "lib_55555555", unreachable: true }), mixed], {}, "movie")?.id, mixed.id);
  assert.equal(defaultLibrary([library({ id: "lib_66666666", type: "movie" })], { defaultSeriesLibrary: "lib_66666666" }, "episode"), undefined);
  assert.equal(libraryFor(all, "lib_22222222"), series);
  assert.equal(libraryFor(all, "lib_99999999"), undefined);
});

test("a library nested in another is carved out of the parent", () => {
  const parent = library({ id: "lib_aaaaaaaa", root: "/downloads" });
  const child = library({ id: "lib_bbbbbbbb", root: "/downloads/Series" });
  const deeper = library({ id: "lib_cccccccc", root: "/downloads/Series/Anime" });
  const elsewhere = library({ id: "lib_dddddddd", root: "/media/filmy" });
  assert.deepEqual(carveOuts([parent, child, deeper, elsewhere], parent), ["Series", "Series/Anime"]);
  assert.deepEqual(carveOuts([parent, child, deeper, elsewhere], child), ["Anime"]);
  assert.deepEqual(carveOuts([parent, elsewhere], parent), []);
  assert.deepEqual(carveOuts([library({ id: "lib_eeeeeeee", root: "/downloads-other" })], parent), [], "a sibling with a shared prefix is not inside");
});

test("a single configured library keeps the unqualified wire format", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "libraries-"));
  await mkdir(path.join(root, "Show"));
  await writeFile(path.join(root, "Show", "01.mkv"), "x");
  const only = library({ root });
  try {
    const passed = await resolveLibraryPath([only], "Show/01.mkv");
    assert.equal(passed?.library.id, only.id);
    assert.equal(passed?.relative, "Show/01.mkv");
    assert.equal(passed?.key, `${only.id}/Show/01.mkv`);
    assert.equal(passed?.absolute, path.join(root, "Show", "01.mkv"));

    const qualified = await resolveLibraryPath([only], `${only.id}/Show`);
    assert.equal(qualified?.absolute, path.join(root, "Show"));
    const atRoot = await resolveLibraryPath([only], only.id);
    assert.equal(atRoot?.relative, "");
    assert.equal(atRoot?.absolute, path.resolve(root));

    const missing = await resolveLibraryPath([only], "Show/Not Yet");
    assert.equal(missing?.absolute, path.join(root, "Show", "Not Yet"), "a target that does not exist yet still resolves");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("resolution refuses what the guard exists for", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "libraries-"));
  const outside = await mkdtemp(path.join(tmpdir(), "outside-"));
  await mkdir(path.join(root, "Show"));
  await writeFile(path.join(outside, "secret.mkv"), "x");
  await symlink(path.join(outside, "secret.mkv"), path.join(root, "escaped.mkv"));
  const only = library({ root });
  const second = library({ id: "lib_ffffffff", root: outside });

  assert.equal(await resolveLibraryPath([only], "Show/../Show"), undefined, "a dot segment is refused, resolvable or not");
  assert.equal(await resolveLibraryPath([only], "Show/../.."), undefined);
  assert.equal(await resolveLibraryPath([only], "../etc/passwd"), undefined);
  assert.equal(await resolveLibraryPath([only], "escaped.mkv"), undefined, "a symlink out of the root is refused");
  assert.equal(await resolveLibraryPath([only], "lib_99999999/Show"), undefined, "an unknown library is refused");
  assert.equal(await resolveLibraryPath([library({ id: "lib_ab12cd34", root, enabled: false })], `${only.id}/Show`), undefined, "a disabled library is refused");
  assert.equal(await resolveLibraryPath([only, second], "Show"), undefined, "an unqualified path needs exactly one configured library");

  try { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); } catch { /* best effort */ }
});
