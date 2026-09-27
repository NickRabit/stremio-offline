import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { mayTrashDownloadDir, prepareDownloadDir, protectedDownloadDir, readOwnership, reservedDownloadDir, suggestedDownloadDir, writeOwnership, type DownloadDirFs, type Places } from "./download-dir.js";

const tempDir = async (t: TestContext) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-download-dir-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

/** Home and app data far from the temp folders the tests write to. */
const PLACES: Places = { home: "/Users/someone", userData: "/Users/someone/Library/Application Support/Stremio Offline", platform: "darwin" };

/** Windows paths cannot be written to the host's file system, so a fake stands in for it. */
const WINDOWS_PLACES: Places = {
  home: "C:\\Users\\me",
  userData: "C:\\Users\\me\\AppData\\Roaming\\Stremio Offline",
  platform: "win32",
};

const fakeFs = (over: Partial<DownloadDirFs> = {}): DownloadDirFs => ({
  stat: async () => ({ isDirectory: () => true }),
  readdir: async () => [],
  mkdir: async () => undefined,
  writeFile: async () => undefined,
  rm: async () => undefined,
  realpath: async (entry) => entry,
  ...over,
});

/** The real file system answers with the host's rules, so a test that writes to a real temp folder
 *  measures that folder against places beside it, on the host's platform. */
const hostPlaces = (root: string): Places =>
  ({ home: `${root}-home`, userData: `${root}-data`, platform: process.platform });

test("a missing folder is created, left empty and owned by the app", async (t) => {
  const dir = await tempDir(t);
  const target = path.join(dir, "Movies", "Stremio Offline");
  assert.deepEqual(await prepareDownloadDir(target, hostPlaces(dir)), { ok: true, dir: target, owned: true });
  assert.deepEqual(await readdir(target), [], "the probe file is removed again");
});

test("an empty folder is owned; one that already holds the user's files is not", async (t) => {
  const dir = await tempDir(t);
  const places = hostPlaces(dir);
  await writeFile(path.join(dir, ".DS_Store"), "", "utf8");
  assert.deepEqual(await prepareDownloadDir(dir, places), { ok: true, dir, owned: true }, "Finder's own file does not count");
  await writeFile(path.join(dir, "mine.txt"), "x", "utf8");
  assert.deepEqual(await prepareDownloadDir(dir, places), { ok: true, dir, owned: false });
  assert.deepEqual(await prepareDownloadDir(path.join(dir, "..", path.basename(dir)), places), { ok: true, dir, owned: false }, "the path is resolved");
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

test("macOS home folders and volume roots are usable but never the app's to throw away", async () => {
  for (const dir of ["/Users/someone/Movies", "/Users/someone/Downloads", "/Users/someone/Desktop", "/Volumes/Films"]) {
    assert.equal(protectedDownloadDir(dir, PLACES), true, dir);
  }
  for (const dir of ["/Users/someone/Movies/Stremio Offline", "/Volumes/Films/Stremio"]) {
    assert.equal(protectedDownloadDir(dir, PLACES), false, dir);
  }
  // A known folder the system moved out of the home folder is protected with the folders above it.
  const moved: Places = { ...PLACES, knownFolders: ["/Users/someone/OneDrive/Videos"] };
  for (const dir of ["/Users/someone/OneDrive/Videos", "/Users/someone/OneDrive"]) {
    assert.equal(protectedDownloadDir(dir, moved), true, dir);
  }
  // An empty, freshly made folder under a protected name still is not owned.
  assert.deepEqual(await prepareDownloadDir("/Users/someone/Movies", PLACES, fakeFs()),
    { ok: true, dir: "/Users/someone/Movies", owned: false });
});

test("anything that is not an absolute path is refused", async () => {
  for (const input of ["relative/folder", "../folder", "", 7, null, undefined, true, {}, ["/tmp"]]) {
    assert.deepEqual(await prepareDownloadDir(input, PLACES), { ok: false, reason: "not-absolute" }, JSON.stringify(input));
  }
  assert.deepEqual(await prepareDownloadDir(`/${"a".repeat(1024)}`, PLACES), { ok: false, reason: "not-absolute" });
  assert.deepEqual(await prepareDownloadDir("/tmp/a\0b", PLACES), { ok: false, reason: "not-absolute" });
});

test("the suggested download folder steps out of OneDrive on Windows", () => {
  const home = "C:\\Users\\me";
  assert.equal(suggestedDownloadDir(home, "C:\\Users\\me\\Videos", "win32"), "C:\\Users\\me\\Videos\\Stremio Offline");
  assert.equal(suggestedDownloadDir(home, "C:\\Users\\me\\OneDrive\\Videos", "win32"), "C:\\Users\\me\\Stremio Offline");
  assert.equal(suggestedDownloadDir(home, "C:\\Users\\me\\OneDrive - Firma\\Videa", "win32"), "C:\\Users\\me\\Stremio Offline");
  assert.equal(suggestedDownloadDir(home, "D:\\OneDrive Videa", "win32"), "D:\\OneDrive Videa\\Stremio Offline",
    "a folder that merely starts with OneDrive is no OneDrive");
  assert.equal(suggestedDownloadDir("/Users/me", "/Users/me/Movies", "darwin"), "/Users/me/Movies/Stremio Offline");
});

test("a file where the folder should be is refused", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "not-a-folder");
  await writeFile(file, "x", "utf8");
  assert.deepEqual(await prepareDownloadDir(file, hostPlaces(dir)), { ok: false, reason: "not-folder" });
});

test("a folder that cannot be written to is refused", async () => {
  const fsImpl = fakeFs({ writeFile: async () => { throw new Error("EACCES"); } });
  assert.deepEqual(await prepareDownloadDir("/Volumes/ReadOnly/Films", PLACES, fsImpl), { ok: false, reason: "not-writable" });
});

test("a folder that cannot be created is refused", async () => {
  const fsImpl = fakeFs({
    stat: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    mkdir: async () => { throw new Error("EACCES"); },
  });
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

test("a folder whose contents cannot be listed is used but never owned",
  { skip: process.platform === "win32" ? "file modes do not hide a folder's contents on NTFS" : false }, async (t) => {
  // Write and search, but no read: the user's own film stays invisible to readdir.
  const dir = path.join(await tempDir(t), "Films");
  await mkdir(dir);
  await writeFile(path.join(dir, "my-own-film.mkv"), "x", "utf8");
  await chmod(dir, 0o300);
  try {
    assert.deepEqual(await prepareDownloadDir(dir, PLACES), { ok: true, dir, owned: false });
  } finally {
    await chmod(dir, 0o700);
  }
});

test("a folder that cannot even be looked at is refused, not created", async () => {
  let made = false;
  const fsImpl = fakeFs({
    stat: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
    mkdir: async () => { made = true; return undefined; },
  });
  assert.deepEqual(await prepareDownloadDir("/Users/someone/Films", PLACES, fsImpl), { ok: false, reason: "not-writable" });
  assert.equal(made, false);
});

test("a Windows drive root, a share root, the profile and the app's own data are refused", () => {
  for (const dir of ["C:\\", "D:\\", "\\\\nas\\share", "C:\\Users\\me", "C:\\Users", WINDOWS_PLACES.userData, "C:\\Users\\me\\AppData\\Roaming\\Stremio Offline\\instance"]) {
    assert.equal(reservedDownloadDir(dir, WINDOWS_PLACES), true, dir);
  }
  for (const dir of ["C:\\Movies", "C:\\Users\\me\\AppData\\Roaming\\Stremio Offline\\downloads", "C:\\Users\\me\\Videos\\Stremio Offline", "\\\\nas\\share\\films"]) {
    assert.equal(reservedDownloadDir(dir, WINDOWS_PLACES), false, dir);
  }
});

test("the folders a Windows profile is given are protected, with a work OneDrive beside them", () => {
  const names = ["Desktop", "Documents", "Downloads", "Music", "Pictures", "Videos", "AppData", "Saved Games",
    "Contacts", "Favorites", "Links", "Searches", "3D Objects", "OneDrive", "OneDrive - Firma"];
  for (const name of names) {
    assert.equal(protectedDownloadDir(`C:\\Users\\me\\${name}`, WINDOWS_PLACES), true, name);
    assert.equal(protectedDownloadDir(`C:\\Users\\me\\${name}\\Stremio Offline`, WINDOWS_PLACES), false, `${name} child`);
  }
  assert.equal(protectedDownloadDir("C:\\Users\\me\\OneDrive - Firma", { ...WINDOWS_PLACES, home: "c:\\USERS\\me" }), true,
    "the profile folder is compared without case");
});

test("a known folder and every folder above it are protected, wherever OneDrive or a drive moved it", () => {
  const places: Places = { ...WINDOWS_PLACES, knownFolders: ["D:\\Videos", "C:\\Users\\me\\OneDrive\\Videos"] };
  for (const dir of ["D:\\Videos", "C:\\Users\\me\\OneDrive\\Videos", "C:\\Users\\me\\OneDrive", "c:\\users\\ME\\videos", "D:\\VIDEOS"]) {
    assert.equal(protectedDownloadDir(dir, places), true, dir);
  }
  for (const dir of ["D:\\Videos\\Stremio Offline", "C:\\Users\\me\\Videos\\Stremio Offline", "D:\\"]) {
    assert.equal(protectedDownloadDir(dir, places), false, dir);
  }
});

test("a Windows folder the user keeps is used but never the app's, and one below it is the app's", async () => {
  const own = "C:\\Users\\me\\Videos\\Stremio Offline";
  assert.deepEqual(await prepareDownloadDir(own, WINDOWS_PLACES, fakeFs()), { ok: true, dir: own, owned: true });
  const places: Places = { ...WINDOWS_PLACES, knownFolders: ["D:\\Videos"] };
  for (const dir of ["C:\\Users\\me\\Videos", "C:\\Users\\me\\OneDrive", "D:\\Videos"]) {
    assert.deepEqual(await prepareDownloadDir(dir, places, fakeFs()), { ok: true, dir, owned: false }, dir);
  }
  assert.deepEqual(await prepareDownloadDir("C:\\Users\\me", WINDOWS_PLACES, fakeFs()), { ok: false, reason: "reserved" });
});

test("an 8.3 name or a junction of a folder is still that folder", async () => {
  const short = "C:\\Users\\me\\VIDEOS~1";
  const shortFs = fakeFs({ realpath: async (entry) => entry === short ? "C:\\Users\\me\\Videos" : entry });
  assert.deepEqual(await prepareDownloadDir(short, WINDOWS_PLACES, shortFs), { ok: true, dir: short, owned: false });

  const junction = "C:\\films";
  const junctionFs = fakeFs({ realpath: async (entry) => entry === junction ? WINDOWS_PLACES.userData : entry });
  assert.deepEqual(await prepareDownloadDir(junction, WINDOWS_PLACES, junctionFs), { ok: false, reason: "reserved" });
});

test("Explorer's own files do not make a Windows folder the user's", async () => {
  const dir = "C:\\Users\\me\\Videos\\Stremio Offline";
  assert.deepEqual(await prepareDownloadDir(dir, WINDOWS_PLACES, fakeFs({ readdir: async () => ["desktop.ini", "Thumbs.db"] })),
    { ok: true, dir, owned: true });
  assert.deepEqual(await prepareDownloadDir(dir, WINDOWS_PLACES, fakeFs({ readdir: async () => ["desktop.ini", "film.mkv"] })),
    { ok: true, dir, owned: false });
});

test("a Windows path needs a drive letter or a share to be somewhere", async () => {
  for (const input of ["\\films", "films", "C:films", "\\\\nas"]) {
    assert.deepEqual(await prepareDownloadDir(input, WINDOWS_PLACES, fakeFs()), { ok: false, reason: "not-absolute" }, input);
  }
  assert.deepEqual(await prepareDownloadDir("\\\\nas\\films\\Stremio Offline", WINDOWS_PLACES, fakeFs()),
    { ok: true, dir: "\\\\nas\\films\\Stremio Offline", owned: true });
});

test("mixed-case spellings still name one Windows folder", () => {
  const dir = "C:\\Users\\me\\Movies\\Stremio Offline";
  const stored = "c:\\users\\ME\\movies\\stremio offline";
  assert.equal(mayTrashDownloadDir(dir, stored, { dir: stored, owned: true }, WINDOWS_PLACES), true);
  assert.equal(mayTrashDownloadDir(dir, "C:\\Users\\me\\Videos", { dir, owned: true }, WINDOWS_PLACES), false, "not the stored folder any more");
  assert.equal(mayTrashDownloadDir("C:\\Users\\ME\\VIDEOS", "C:\\Users\\ME\\VIDEOS", { dir: "C:\\Users\\ME\\VIDEOS", owned: true }, WINDOWS_PLACES),
    false, "a folder the user keeps never goes");
  assert.equal(mayTrashDownloadDir("c:\\users\\me\\appdata\\roaming\\STREMIO OFFLINE\\Downloads", null, null, WINDOWS_PLACES),
    true, "the app's own default, whatever the case");
  assert.equal(mayTrashDownloadDir("C:\\Users\\me\\Movies\\Stremio Offline", "C:\\Users\\me\\Movies\\Stremio Offline",
    { dir: "C:\\Users\\me\\Movies\\Stremio Offline", owned: false }, WINDOWS_PLACES), false, "it held the user's files");
});
