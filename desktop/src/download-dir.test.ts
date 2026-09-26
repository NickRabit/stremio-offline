import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { prepareDownloadDir, type DownloadDirFs } from "./download-dir.js";

const tempDir = async (t: TestContext) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-download-dir-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test("a missing folder is created and left empty", async (t) => {
  const dir = await tempDir(t);
  const target = path.join(dir, "Movies", "Stremio Offline");
  assert.deepEqual(await prepareDownloadDir(target), { ok: true, dir: target });
  assert.deepEqual(await readdir(target), [], "the probe file is removed again");
});

test("an existing folder is accepted and the path is resolved", async (t) => {
  const dir = await tempDir(t);
  assert.deepEqual(await prepareDownloadDir(dir), { ok: true, dir });
  assert.deepEqual(await prepareDownloadDir(path.join(dir, "..", path.basename(dir))), { ok: true, dir });
});

test("anything that is not an absolute path is refused", async () => {
  for (const input of ["relative/folder", "../folder", "", 7, null, undefined, true, {}, ["/tmp"]]) {
    assert.deepEqual(await prepareDownloadDir(input), { ok: false, reason: "not-absolute" }, JSON.stringify(input));
  }
  assert.deepEqual(await prepareDownloadDir(`/${"a".repeat(1024)}`), { ok: false, reason: "not-absolute" });
  assert.deepEqual(await prepareDownloadDir("/tmp/a\0b"), { ok: false, reason: "not-absolute" });
});

test("a file where the folder should be is refused", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "not-a-folder");
  await writeFile(file, "x", "utf8");
  assert.deepEqual(await prepareDownloadDir(file), { ok: false, reason: "not-folder" });
});

test("a folder that cannot be created is refused", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "file");
  await writeFile(file, "x", "utf8");
  assert.deepEqual(await prepareDownloadDir(path.join(file, "downloads")), { ok: false, reason: "not-writable" });
});

test("a folder the probe file cannot be written to is refused", async (t) => {
  const dir = await tempDir(t);
  const fsImpl: DownloadDirFs = {
    stat: async () => ({ isDirectory: () => true }),
    mkdir: async () => undefined,
    writeFile: async () => { throw new Error("EACCES"); },
    rm: async () => undefined,
  };
  assert.deepEqual(await prepareDownloadDir(dir, fsImpl), { ok: false, reason: "not-writable" });
});
