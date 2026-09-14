import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { transferLibraryPath } from "./library-transfer.js";

test("copy stages a tree and reports byte progress", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-transfer-"));
  try {
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    await mkdir(path.join(source, "nested"), { recursive: true });
    await writeFile(path.join(source, "one.mkv"), "one");
    await writeFile(path.join(source, "nested", "two.srt"), "two-two");
    const progress: Array<[number, number]> = [];
    const result = await transferLibraryPath(source, target, false, (done, total) => progress.push([done, total]));
    assert.equal(await readFile(path.join(target, "nested", "two.srt"), "utf8"), "two-two");
    assert.equal(await readFile(path.join(source, "one.mkv"), "utf8"), "one");
    assert.deepEqual(result, { bytes: 10, total: 10 });
    assert.deepEqual(progress.at(-1), [10, 10]);
    await assert.rejects(stat(`${target}.part`));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a same-volume move renames the source", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-transfer-"));
  try {
    const source = path.join(root, "source.mkv");
    const target = path.join(root, "target.mkv");
    await writeFile(source, "video");
    const progress: Array<[number, number]> = [];
    await transferLibraryPath(source, target, true, (done, total) => progress.push([done, total]));
    assert.equal(await readFile(target, "utf8"), "video");
    await assert.rejects(stat(source));
    assert.deepEqual(progress, [[5, 5]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
