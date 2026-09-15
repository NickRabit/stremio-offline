import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { asLibraryType, checkLibraryRemoval, checkLibraryRoot, libraryFlag } from "./library-admin.js";
import type { LibraryRecord, RootGrant } from "./libraries.js";

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
