import assert from "node:assert/strict";
import type { Dirent, Stats } from "node:fs";
import test from "node:test";
import { existingFolder, folderEntries, statUnlessMissing } from "./folder-access.js";
import { messageKeyOf } from "./errors.js";

const failing = (code: string) => async () => { throw Object.assign(new Error(code), { code }); };
const folder = { isDirectory: () => true } as Stats;
const file = { isDirectory: () => false } as Stats;

test("a refused folder is a permission error, not a missing folder", async () => {
  for (const code of ["EACCES", "EPERM"]) {
    await assert.rejects(statUnlessMissing("/media", failing(code)), (error) => messageKeyOf(error) === "err.folderNoAccess", code);
    await assert.rejects(existingFolder("/media", failing(code)), (error) => messageKeyOf(error) === "err.folderNoAccess", code);
    await assert.rejects(folderEntries("/media", failing(code)), (error) => messageKeyOf(error) === "err.folderNoAccess", code);
  }
});

test("a folder that is not there is still missing", async () => {
  for (const code of ["ENOENT", "ENOTDIR"]) {
    assert.equal(await statUnlessMissing("/media", failing(code)), undefined, code);
    await assert.rejects(existingFolder("/media", failing(code)), (error) => messageKeyOf(error) === "err.pathMissing", code);
    assert.deepEqual(await folderEntries("/media", failing(code)), [], code);
  }
  await assert.rejects(existingFolder("/media/film.mkv", async () => file), (error) => messageKeyOf(error) === "err.pathMissing");
});

test("any other failure is thrown as it came", async () => {
  await assert.rejects(statUnlessMissing("/media", failing("EIO")), /EIO/);
  await assert.rejects(folderEntries("/media", failing("EIO")), /EIO/);
});

test("a readable folder answers as before", async () => {
  assert.equal(await existingFolder("/media", async () => folder), folder);
  const entries = [{ name: "Films" }] as Dirent[];
  assert.equal(await folderEntries("/media", async () => entries), entries);
});
