import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { activeDeparted, carveOuts, defaultLibrary, DEPARTED_MAX, departedIdFor, libraryFor, libraryPath, parseLibraryPath, relativeWithin, resolveLibraryPath, sameFile, showsInContinueWatching, toFs, toPosix, type DepartedLibrary, type LibraryRecord, queuedArtworkKey } from "./libraries.js";

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

test("a library is in Continue watching unless it was turned off", () => {
  const off = library({ showInContinueWatching: false });
  assert.equal(showsInContinueWatching("lib_ab12cd34/Show/01.mkv", [library()]), true, "a record without the field predates the switch and stays on");
  assert.equal(showsInContinueWatching("lib_ab12cd34/Show/01.mkv", [off]), false);
  assert.equal(showsInContinueWatching("lib_ab12cd34/Show/01.mkv", [library({ showInContinueWatching: true })]), true, "turning it back on brings the stored rows with it");
  assert.equal(showsInContinueWatching("Show/01.mkv", [off]), true, "a path no library claims belongs to no switch");
  assert.equal(showsInContinueWatching("lib_11111111/Show/01.mkv", [off]), true, "a library that is gone hides nothing");
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

test("a folder added again takes back the id it had before", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "departed-"));
  const root = path.join(base, "Films");
  const elsewhere = path.join(base, "Elsewhere");
  await mkdir(root, { recursive: true });
  await mkdir(elsewhere, { recursive: true });
  const link = path.join(base, "link");
  await symlink(root, link);
  const now = Date.parse("2026-09-14T12:00:00.000Z");
  // A departed entry holds the realpath, the way the route records it: on macOS the temporary
  // directory is reached through a symlink, and two names for one folder must still match.
  const [realRoot, realElsewhere] = await Promise.all([realpath(root), realpath(elsewhere)]);
  const departed: DepartedLibrary[] = [
    { id: "lib_11111111", root: realElsewhere, removedAt: "2026-09-14T11:00:00.000Z" },
    { id: "lib_22222222", root: realRoot, removedAt: "2026-09-14T11:30:00.000Z" },
  ];

  try {
    assert.equal(await departedIdFor(departed, root, now), "lib_22222222", "the same folder takes its id back");
    assert.equal(await departedIdFor(departed, link, now), "lib_22222222", "and so does the same folder under another name");
    assert.equal(await departedIdFor(departed, path.join(base, "Other"), now), undefined);
    assert.equal(await departedIdFor(departed, elsewhere, now), "lib_11111111");

    // Nothing is kept for ever: an old entry stops matching, and the list has a ceiling.
    const stale = [{ id: "lib_33333333", root: realRoot, removedAt: "2026-07-01T00:00:00.000Z" }];
    assert.equal(await departedIdFor(stale, root, now), undefined, "an expired entry is gone");
    // The list is kept oldest first, the way the route appends to it.
    const total = DEPARTED_MAX + 5;
    const many = Array.from({ length: total }, (_, index) => ({
      id: `lib_${String(index).padStart(8, "0")}`, root: path.resolve(base, `root-${index}`), removedAt: new Date(now - (total - index) * 1000).toISOString(),
    }));
    assert.equal(activeDeparted(many, now).length, DEPARTED_MAX, "the newest are kept");
    assert.equal(await departedIdFor(many, path.resolve(base, "root-0"), now), undefined, "the oldest fell off the end");
    assert.equal(await departedIdFor(many, path.resolve(base, `root-${total - 1}`), now), `lib_${String(total - 1).padStart(8, "0")}`, "the newest is still there");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("two paths as the filesystem under this build sees them", () => {
  // The rename guard's rule, in one place: changing only the case of a name is a rename where
  // case is folded, and a clash where it is not. Linux CI runs the second half of each pair.
  assert.equal(sameFile("/mnt/Films", "/mnt/Films", true), true);
  assert.equal(sameFile("/mnt/Films", "/mnt/films", false), false, "Linux keeps them apart");
  assert.equal(sameFile("/mnt/Films", "/mnt/films", true), true, "macOS and Windows do not");
  assert.equal(sameFile("/mnt/Films", "/mnt/Series", true), false);
  // On this runner the default follows the platform, whichever it is.
  const folded = process.platform === "win32" || process.platform === "darwin";
  assert.equal(sameFile("/mnt/Films", "/mnt/films"), folded);
});

test("the wire is POSIX and the syscall is not", () => {
  // The interface sends "/" whatever the host uses, and `toFs` is the one place that turns it
  // back into the separator this build's filesystem expects.
  assert.equal(toPosix("Show/01 serie/01.mkv"), "Show/01 serie/01.mkv");
  assert.equal(toFs("Show/01 serie/01.mkv"), path.join("Show", "01 serie", "01.mkv"));
  assert.equal(toPosix(toFs("Show/01 serie/01.mkv")), "Show/01 serie/01.mkv");
  // A qualified key parses on the wire, and a Windows-shaped one is not a key: the client never
  // sends that, and reading it as one would name a library that does not exist.
  assert.deepEqual(parseLibraryPath("lib_ab12cd34/Show/01.mkv"), { libraryId: "lib_ab12cd34", relative: "Show/01.mkv" });
  assert.equal(parseLibraryPath("lib_ab12cd34\\Show\\01.mkv"), undefined);
});

// The sweep crashed a two-library install with "An unqualified path needs exactly one
// library, 2 are configured": it qualified every queued target blindly, and a job left over
// from before libraries carries a bare path that nothing can attribute.
test("a queued download's artwork key is only guessed when the job knows its library", () => {
  assert.equal(queuedArtworkKey({ target: "lib_ab12cd34/Film/Film.mkv" }), "lib_ab12cd34/Film/Film.mkv",
    "a qualified target is already an answer");
  assert.equal(queuedArtworkKey({ target: "Film/Film.mkv", libraryId: "lib_ab12cd34" }), "lib_ab12cd34/Film/Film.mkv",
    "a bare target is qualified from the job's own library");
  assert.equal(queuedArtworkKey({ target: "Film/Film.mkv" }), undefined,
    "a legacy bare target belongs to nobody, and the sweep must not ask which library it is");
  assert.equal(queuedArtworkKey({ target: "" }), undefined);
});

// A bare path is the single-library wire format. Once a second library exists the client
// sends qualified paths, so a bare one now means something stale -- a bookmark, a remembered
// browse path -- and it has to read as an invalid path rather than as a sentence about the
// server's internals.
test("an unqualified path is refused, not resolved, once a second library exists", async () => {
  const two: LibraryRecord[] = [
    { id: "lib_ab12cd34", name: "One", type: "mixed", root: "/one", enabled: true, order: 0, addedAt: "", writeArtwork: false },
    { id: "lib_ef56ab78", name: "Two", type: "mixed", root: "/two", enabled: true, order: 1, addedAt: "", writeArtwork: false },
  ];
  assert.equal(await resolveLibraryPath(two, "Film/Film.mkv"), undefined, "nothing can say which library it meant");
  assert.equal(await resolveLibraryPath([two[0]!], "Film/Film.mkv") === undefined, false, "one library is still the pass-through");
});
