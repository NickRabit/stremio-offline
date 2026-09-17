import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { removeMovedSource, renameAcross, transferLibraryPath } from "./library-transfer.js";

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

test("a rename that the filesystem refuses hands the move over to the copy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-transfer-"));
  try {
    const source = path.join(root, "source.mkv");
    const target = path.join(root, "target.mkv");
    await writeFile(source, "video");
    assert.equal(await renameAcross(source, target), true);
    // Only EXDEV means "copy instead". Anything else is a real failure and has to be seen:
    // swallowing it would report a move that never happened.
    await assert.rejects(renameAcross(path.join(root, "gone.mkv"), target), { code: "ENOENT" });
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

test("a same-volume folder move reports the size it moved", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-transfer-"));
  try {
    const source = path.join(root, "Season 1");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "01.mkv"), "first");
    await writeFile(path.join(source, "02.mkv"), "second");
    const progress: Array<[number, number]> = [];
    const result = await transferLibraryPath(source, path.join(root, "moved"), true, (done, total) => progress.push([done, total]));
    // The rename copies nothing, but the item still weighs what it weighs.
    assert.deepEqual(result, { bytes: 11, total: 11 });
    assert.deepEqual(progress, [[11, 11]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Reachable only across volumes inside `transferLibraryPath`, so the step is tested where
// it lives. Root may unlink inside a directory it cannot write, hence the guard.
test("the source of a finished move is reported, not thrown, when it will not go", {
  skip: process.getuid?.() === 0 ? "needs a user that write permission applies to" : false,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-transfer-"));
  const held = path.join(root, "held");
  try {
    const source = path.join(held, "film.mkv");
    await mkdir(held, { recursive: true });
    await writeFile(source, "video");
    await chmod(held, 0o555);

    const reason = await removeMovedSource(source);
    assert.ok(reason, "a refusal comes back as a message");
    assert.equal(await readFile(source, "utf8"), "video");
  } finally {
    await chmod(held, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a source that goes reports nothing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-transfer-"));
  try {
    const source = path.join(root, "film.mkv");
    await writeFile(source, "video");
    assert.equal(await removeMovedSource(source), undefined);
    await assert.rejects(stat(source));
  } finally { await rm(root, { recursive: true, force: true }); }
});
