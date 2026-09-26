import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { mayTrashDownloadDir, prepareDownloadDir, protectedDownloadDir, readOwnership, reservedDownloadDir, writeOwnership, type DownloadDirFs, type Places } from "./download-dir.js";

const tempDir = async (t: TestContext) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-download-dir-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

/** Home and app data far from the temp folders the tests write to. */
const PLACES: Places = { home: "/Users/someone", userData: "/Users/someone/Library/Application Support/Stremio Offline" };

test("a missing folder is created, left empty and owned by the app", async (t) => {
  const dir = await tempDir(t);
  const target = path.join(dir, "Movies", "Stremio Offline");
  assert.deepEqual(await prepareDownloadDir(target, PLACES), { ok: true, dir: target, owned: true });
  assert.deepEqual(await readdir(target), [], "the probe file is removed again");
});

test("an empty folder is owned; one that already holds the user's files is not", async (t) => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, ".DS_Store"), "", "utf8");
  assert.deepEqual(await prepareDownloadDir(dir, PLACES), { ok: true, dir, owned: true }, "Finder's own file does not count");
  await writeFile(path.join(dir, "mine.txt"), "x", "utf8");
  assert.deepEqual(await prepareDownloadDir(dir, PLACES), { ok: true, dir, owned: false });
  assert.deepEqual(await prepareDownloadDir(path.join(dir, "..", path.basename(dir)), PLACES), { ok: true, dir, owned: false }, "the path is resolved");
});

test("the disk root, the home folder and above it, and the app's own data are refused", () => {
  for (const dir of ["/", "/Users", "/Users/someone", "/Users/someone/", PLACES.userData, path.join(PLACES.userData, "instance"), "/Users/someone/Library/Application Support"]) {
    assert.equal(reservedDownloadDir(dir, PLACES), true, dir);
  }
  for (const dir of [path.join(PLACES.userData, "downloads"), "/Users/someone/Movies", "/Users/someone/Movies/Stremio Offline", "/Volumes/Films"]) {
    assert.equal(reservedDownloadDir(dir, PLACES), false, dir);
  }
});

test("a reserved folder is refused before anything is written", async () => {
  assert.deepEqual(await prepareDownloadDir("/Users/someone", PLACES), { ok: false, reason: "reserved" });
  assert.deepEqual(await prepareDownloadDir("/", PLACES), { ok: false, reason: "reserved" });
});

test("macOS home folders and volume roots are usable but never the app's to throw away", async (t) => {
  for (const dir of ["/Users/someone/Movies", "/Users/someone/Downloads", "/Users/someone/Desktop", "/Volumes/Films"]) {
    assert.equal(protectedDownloadDir(dir, PLACES), true, dir);
  }
  for (const dir of ["/Users/someone/Movies/Stremio Offline", "/Volumes/Films/Stremio"]) {
    assert.equal(protectedDownloadDir(dir, PLACES), false, dir);
  }
  // An empty, freshly made folder under a protected name still is not owned.
  const home = await tempDir(t);
  await mkdir(path.join(home, "Movies"));
  const result = await prepareDownloadDir(path.join(home, "Movies"), { home, userData: path.join(home, "Library", "App") });
  assert.deepEqual(result, { ok: true, dir: path.join(home, "Movies"), owned: false });
});

test("anything that is not an absolute path is refused", async () => {
  for (const input of ["relative/folder", "../folder", "", 7, null, undefined, true, {}, ["/tmp"]]) {
    assert.deepEqual(await prepareDownloadDir(input, PLACES), { ok: false, reason: "not-absolute" }, JSON.stringify(input));
  }
  assert.deepEqual(await prepareDownloadDir(`/${"a".repeat(1024)}`, PLACES), { ok: false, reason: "not-absolute" });
  assert.deepEqual(await prepareDownloadDir("/tmp/a\0b", PLACES), { ok: false, reason: "not-absolute" });
});

test("a file where the folder should be is refused", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "not-a-folder");
  await writeFile(file, "x", "utf8");
  assert.deepEqual(await prepareDownloadDir(file, PLACES), { ok: false, reason: "not-folder" });
});

test("a folder that cannot be written to is refused", async () => {
  const fsImpl: DownloadDirFs = {
    stat: async () => ({ isDirectory: () => true }),
    readdir: async () => [],
    mkdir: async () => undefined,
    writeFile: async () => { throw new Error("EACCES"); },
    rm: async () => undefined,
  };
  assert.deepEqual(await prepareDownloadDir("/Volumes/ReadOnly/Films", PLACES, fsImpl), { ok: false, reason: "not-writable" });
});

test("a folder that cannot be created is refused", async () => {
  const fsImpl: DownloadDirFs = {
    stat: async () => { throw new Error("ENOENT"); },
    readdir: async () => [],
    mkdir: async () => { throw new Error("EACCES"); },
    writeFile: async () => undefined,
    rm: async () => undefined,
  };
  assert.deepEqual(await prepareDownloadDir("/nowhere/Films", PLACES, fsImpl), { ok: false, reason: "not-writable" });
});

test("only an owned, still stored, unprotected folder may go to the Trash", () => {
  const films = "/Users/someone/Movies/Stremio Offline";
  assert.equal(mayTrashDownloadDir(films, films, { dir: films, owned: true }, PLACES), true);
  assert.equal(mayTrashDownloadDir(films, films, { dir: films, owned: false }, PLACES), false, "it held the user's files");
  assert.equal(mayTrashDownloadDir(films, films, null, PLACES), false, "no record, no trust");
  assert.equal(mayTrashDownloadDir(films, "/Volumes/X/Films", { dir: films, owned: true }, PLACES), false, "not the stored folder any more");
  assert.equal(mayTrashDownloadDir("/Users/someone/Movies", "/Users/someone/Movies", { dir: "/Users/someone/Movies", owned: true }, PLACES), false, "a home folder never goes");
  assert.equal(mayTrashDownloadDir(path.join(PLACES.userData, "downloads"), null, null, PLACES), true, "the app's own default");
});

test("ownership is written atomically and read back leniently", async (t) => {
  const dir = await tempDir(t);
  assert.equal(await readOwnership(dir), null);
  await writeOwnership(dir, { dir: "/x/Films", owned: true });
  assert.deepEqual(await readOwnership(dir), { dir: "/x/Films", owned: true });
  await writeFile(path.join(dir, "download-folder.json"), "{\"dir\":7}", "utf8");
  assert.equal(await readOwnership(dir), null);
});
