import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { asLibraryType, checkLibraryRemoval, checkLibraryRoot, checkRerootItems, checkRerootPaths, libraryFlag } from "./library-admin.js";
import { carveOuts, type LibraryRecord, type RootGrant } from "./libraries.js";
import { flushLog } from "./logger.js";

const grant = (p: string): RootGrant => ({ path: p, source: "env", grantedAt: "2026-01-01T00:00:00.000Z" });
const library = (over: Partial<LibraryRecord> & { root: string }): LibraryRecord => ({
  id: "lib_ab12cd34", name: "Library", type: "mixed", enabled: true, order: 0,
  addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: true, ...over,
});

test("a root outside every grant is refused before anything touches the disk", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "admin-"));
  const outside = path.join(dataDir, "outside");
  try {
    const result = await checkLibraryRoot({ grants: [grant(path.join(dataDir, "granted"))], libraries: [], root: path.join(outside, "new"), create: true });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.messageKey, "err.libraryRootNotGranted");
    assert.equal(result.ok === false && result.status, 403);
    await assert.rejects(stat(outside), "a refused root is never created");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a relative path, a file and a missing folder are each named", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "admin-"));
  const granted = path.join(dataDir, "granted");
  await mkdir(granted, { recursive: true });
  const file = path.join(granted, "Film.mkv");
  await writeFile(file, "x");
  const grants = [grant(granted)];
  try {
    const relative = await checkLibraryRoot({ grants, libraries: [], root: "movies" });
    assert.equal(relative.ok === false && relative.messageKey, "err.libraryRootAbsolute");
    const notFolder = await checkLibraryRoot({ grants, libraries: [], root: file });
    assert.equal(notFolder.ok === false && notFolder.messageKey, "err.libraryRootNotFolder");
    const missing = await checkLibraryRoot({ grants, libraries: [], root: path.join(granted, "Films") });
    assert.equal(missing.ok === false && missing.messageKey, "err.pathMissing");
    const created = await checkLibraryRoot({ grants, libraries: [], root: path.join(granted, "Films"), create: true });
    assert.equal(created.ok, true);
    assert.equal((await stat(path.join(granted, "Films"))).isDirectory(), true);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("two libraries cannot share a root, not even through a symlink", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "admin-"));
  const granted = path.join(dataDir, "granted");
  await mkdir(granted, { recursive: true });
  const link = path.join(dataDir, "link");
  await symlink(granted, link);
  const grants = [grant(dataDir)];
  const taken = library({ root: granted });
  try {
    const same = await checkLibraryRoot({ grants, libraries: [taken], root: granted });
    assert.equal(same.ok === false && same.messageKey, "err.libraryRootTaken");
    const linked = await checkLibraryRoot({ grants, libraries: [taken], root: link });
    assert.equal(linked.ok === false && linked.messageKey, "err.libraryRootTaken", "the same folder under another name");
    const kept = await checkLibraryRoot({ grants, libraries: [taken], root: granted, exceptId: taken.id });
    assert.equal(kept.ok, true, "re-rooting a library onto its own root changes nothing");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a root inside another library's root is legal, and reads as a carve-out", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "admin-"));
  const granted = path.join(dataDir, "granted");
  const child = path.join(granted, "Archive");
  await mkdir(child, { recursive: true });
  const parent = library({ root: granted });
  try {
    const result = await checkLibraryRoot({ grants: [grant(granted)], libraries: [parent], root: child });
    assert.equal(result.ok, true);
    assert.deepEqual(libraryFlag([parent], child), { libraryId: parent.id, libraryRoot: false });
    assert.deepEqual(libraryFlag([parent], granted), { libraryId: parent.id, libraryRoot: true });
    assert.deepEqual(libraryFlag([parent], path.join(dataDir, "elsewhere")), {});
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a child reached through a symlink is a carve-out of the tree it points into", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "admin-"));
  const granted = path.join(dataDir, "granted");
  const child = path.join(granted, "Archive", "Serialy");
  const alias = path.join(dataDir, "alias");
  await mkdir(child, { recursive: true });
  await symlink(path.join(granted, "Archive"), alias);
  const parent = library({ id: "lib_aaaaaaaa", root: granted });
  const nested = library({ id: "lib_bbbbbbbb", root: path.join(alias, "Serialy") });
  try {
    const accepted = await checkLibraryRoot({ grants: [grant(granted)], libraries: [parent], root: nested.root });
    assert.equal(accepted.ok, true, "the folder is another one than the parent's, whoever reaches it");
    // Roots as the disk has them, which is what the guard compares: the alias resolves into the
    // parent's tree, and the configured spelling alone would miss it.
    const resolved = await Promise.all([parent, nested].map(async (entry) => ({ id: entry.id, root: await realpath(entry.root) })));
    assert.deepEqual(carveOuts(resolved, resolved[0]!), ["Archive/Serialy"]);
    assert.deepEqual(carveOuts([parent, nested], parent), [], "the spellings as they were configured share no tree");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("only the three library types are accepted", () => {
  assert.equal(asLibraryType("movie"), "movie");
  assert.equal(asLibraryType("series"), "series");
  assert.equal(asLibraryType("mixed"), "mixed");
  assert.equal(asLibraryType("Movie"), undefined);
  assert.equal(asLibraryType(undefined), undefined);
});

test("the only library is refused, because an empty set breaks every unqualified path", () => {
  const only = library({ root: "/media/Films" });
  const result = checkLibraryRemoval([only], only.id);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.messageKey, "err.libraryLast");
  assert.equal(result.ok === false && result.status, 409);
  assert.equal(result.ok === false && result.message, "This is the only library. Point it at another folder instead of removing it.");
});

test("an unknown id is refused as not found, even when it is the only library configured", () => {
  const only = library({ root: "/media/Films" });
  const result = checkLibraryRemoval([only], "lib_00000000");
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.messageKey, "err.libraryNotFound");
  assert.equal(result.ok === false && result.status, 404);
});

test("any of several libraries is removable, and a disabled or unreachable one still counts", () => {
  const first = library({ root: "/media/Films", order: 0 });
  const second = library({ id: "lib_ef56ab78", root: "/media/Series", order: 1, enabled: false, unreachable: true });
  const removedFirst = checkLibraryRemoval([first, second], first.id);
  assert.equal(removedFirst.ok, true);
  assert.equal(removedFirst.ok === true && removedFirst.library, first);
  const removedSecond = checkLibraryRemoval([first, second], second.id);
  assert.equal(removedSecond.ok, true);
  assert.equal(removedSecond.ok === true && removedSecond.library, second);
});

test("a removable library is answered with the record that matched, not another of the same", () => {
  const first = library({ root: "/media/Films", name: "Films", order: 0 });
  const second = library({ id: "lib_ef56ab78", root: "/media/Series", name: "Series", order: 1 });
  const result = checkLibraryRemoval([first, second], second.id);
  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.library.name, "Series");
  assert.equal(result.ok === true && result.library.root, "/media/Series");
});

test("a carve-out refuses the move before the destination is even looked at", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "admin-"));
  const from = path.join(dataDir, "from");
  const to = path.join(dataDir, "to");
  await mkdir(from, { recursive: true });
  await mkdir(to, { recursive: true });
  await writeFile(path.join(from, "Movies"), "x");
  // The destination would collide as well; the carve-out is what the person has to fix.
  await writeFile(path.join(to, "Movies"), "x");
  try {
    const result = await checkRerootPaths({ from, to, carveOuts: ["Archive"] });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.messageKey, "err.libraryRerootCarveOut");
    assert.equal(result.ok === false && result.status, 409);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a root inside the other one is refused in both directions", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "admin-"));
  const from = path.join(dataDir, "from");
  const nested = path.join(from, "Nested");
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(from, "Movies"), "x");
  try {
    const within = await checkRerootPaths({ from, to: nested, carveOuts: [] });
    assert.equal(within.ok === false && within.messageKey, "err.libraryRerootNested");
    assert.equal(within.ok === false && within.status, 409);
    const around = await checkRerootPaths({ from: nested, to: from, carveOuts: [] });
    assert.equal(around.ok === false && around.messageKey, "err.libraryRerootNested");
    const same = await checkRerootPaths({ from, to: from, carveOuts: [] });
    assert.equal(same.ok === false && same.messageKey, "err.libraryRerootNested");
    // A destination that does not exist yet is still read as the folder it would become.
    const missing = await checkRerootPaths({ from, to: path.join(from, "Unmade"), carveOuts: [] });
    assert.equal(missing.ok === false && missing.messageKey, "err.libraryRerootNested");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a nested destination is refused before create can make the folder", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "admin-"));
  const from = path.join(dataDir, "from");
  const to = path.join(from, "Sub");
  await mkdir(path.join(from, "Show"), { recursive: true });
  try {
    // The route's order: the path-only refusals run against the input as given, and `create`
    // never runs once one of them fires, so a refused request writes nothing.
    const paths = await checkRerootPaths({ from, to, carveOuts: [] });
    if (paths.ok) await checkLibraryRoot({ grants: [grant(dataDir)], libraries: [], root: to, create: true });
    assert.equal(paths.ok === false && paths.messageKey, "err.libraryRerootNested");
    assert.equal(await stat(to).then(() => true, () => false), false);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("an empty source is refused, because there is nothing to carry over", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "admin-"));
  const from = path.join(dataDir, "from");
  const to = path.join(dataDir, "to");
  await mkdir(from, { recursive: true });
  await mkdir(to, { recursive: true });
  try {
    const result = await checkRerootItems({ from, to });
    assert.equal(result.ok === false && result.messageKey, "err.libraryRerootEmpty");
    assert.equal(result.ok === false && result.status, 409);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a name the destination already holds is refused by name", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "admin-"));
  const from = path.join(dataDir, "from");
  const to = path.join(dataDir, "to");
  await mkdir(from, { recursive: true });
  await mkdir(to, { recursive: true });
  await writeFile(path.join(from, "Movies"), "x");
  await writeFile(path.join(from, "Show"), "x");
  await writeFile(path.join(to, "Show"), "x");
  try {
    const result = await checkRerootItems({ from, to });
    assert.equal(result.ok === false && result.messageKey, "err.libraryRerootCollision");
    assert.equal(result.ok === false && result.status, 409);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a clear move hands back every top-level entry and touches nothing", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "admin-"));
  const from = path.join(dataDir, "from");
  const to = path.join(dataDir, "to");
  await mkdir(from, { recursive: true });
  await mkdir(path.join(from, "Show"), { recursive: true });
  await mkdir(to, { recursive: true });
  await writeFile(path.join(from, "Movies"), "x");
  await writeFile(path.join(from, ".hidden"), "x");
  try {
    const result = await checkRerootItems({ from, to });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok === true && [...result.items].sort(), [".hidden", "Movies", "Show"]);
    // The check reads both folders and writes neither: the move is the queue's job.
    assert.deepEqual((await readdir(from)).sort(), [".hidden", "Movies", "Show"]);
    assert.deepEqual(await readdir(to), []);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a root that cannot be created records the errno the interface hides", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "stremio-admin-"));
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  try {
    // A file where the new folder would go: mkdir refuses with EEXIST/ENOTDIR.
    await writeFile(path.join(directory, "blocked"), "");
    const target = path.join(directory, "blocked", "library");
    process.stdout.write = ((chunk: unknown) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
    const result = await checkLibraryRoot({ root: target, grants: [grant(directory)], libraries: [], create: true });
    process.stdout.write = original;
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.messageKey, "err.libraryRootCreate");

    const line = written.find((entry) => entry.includes("A library root could not be created"));
    assert.ok(line, "the refusal is logged");
    assert.match(line!, /"code":"(ENOTDIR|EEXIST|EACCES)"/);
  } finally {
    process.stdout.write = original;
    await flushLog();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a new folder beside the old root is a valid re-root destination", async () => {
  // The destination does not exist yet, so it resolves through its nearest existing
  // ancestor -- which also holds the old root. Comparing the source against that ancestor
  // refused every ordinary "make a folder next to this one and move the content into it".
  const dataDir = await mkdtemp(path.join(tmpdir(), "reroot-"));
  const from = path.join(dataDir, "Old");
  await mkdir(from, { recursive: true });
  try {
    const beside = await checkRerootPaths({ from, to: path.join(dataDir, "New"), carveOuts: [] });
    assert.equal(beside.ok, true, "a sibling that does not exist yet is allowed");

    const inside = await checkRerootPaths({ from, to: path.join(from, "New"), carveOuts: [] });
    assert.equal(inside.ok, false, "a folder inside the old root is still refused");
    if (!inside.ok) assert.equal(inside.messageKey, "err.libraryRerootNested");

    const parent = await checkRerootPaths({ from, to: dataDir, carveOuts: [] });
    assert.equal(parent.ok, false, "the source's own parent is still refused");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
