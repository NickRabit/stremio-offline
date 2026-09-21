import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
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
    assert.deepEqual(readdirSync(root).sort(), ["source", "target"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a copy leaves a partial download of the same name alone", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-transfer-"));
  try {
    const source = path.join(root, "source.mkv");
    const target = path.join(root, "target.mkv");
    await writeFile(source, "video");
    // The download queue writes exactly this path while a fetch is running.
    await writeFile(`${target}.part`, "half a download");
    await transferLibraryPath(source, target, false);
    assert.equal(await readFile(target, "utf8"), "video");
    assert.equal(await readFile(`${target}.part`, "utf8"), "half a download");
    assert.deepEqual(readdirSync(root).sort(), ["source.mkv", "target.mkv", "target.mkv.part"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a copy leaves a partial download directory of the same name alone", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-transfer-"));
  try {
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    const partial = `${target}.part`;
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "01.mkv"), "video");
    await mkdir(path.join(partial, "nested"), { recursive: true });
    await writeFile(path.join(partial, "nested", "segment"), "half a download");
    await transferLibraryPath(source, target, false);
    assert.equal(await readFile(path.join(target, "01.mkv"), "utf8"), "video");
    assert.equal(await readFile(path.join(partial, "nested", "segment"), "utf8"), "half a download");
    assert.deepEqual(readdirSync(root).sort(), ["source", "target", "target.part"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("two concurrent copies of different files into one name publish one and refuse the other", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-transfer-"));
  try {
    const target = path.join(root, "target.mkv");
    const sources = [path.join(root, "first.mkv"), path.join(root, "second.mkv")];
    const contents = [Buffer.alloc(2 * 1024 * 1024, 7), Buffer.alloc(2 * 1024 * 1024, 9)];
    await Promise.all(sources.map((source, index) => writeFile(source, contents[index])));
    const staged = new Set<string>();
    // What the folder holds mid-copy is the only place the staging names are visible.
    const watch = () => { for (const name of readdirSync(root)) if (name.endsWith(".part")) staged.add(name); };
    const settled = await Promise.allSettled(sources.map((source) => transferLibraryPath(source, target, false, watch)));
    const winner = settled.findIndex((entry) => entry.status === "fulfilled");
    const refused = settled.filter((entry) => entry.status === "rejected") as PromiseRejectedResult[];
    assert.ok(winner >= 0, "one of the two copies lands");
    assert.equal(refused.length, 1, "the other is refused instead of replacing what landed");
    assert.equal(refused[0].reason.messageKey, "err.nameTaken");
    assert.equal(refused[0].reason.message, "A file with that name already exists.");
    assert.equal(staged.size, 2, `two calls staged under ${[...staged].join(", ")}`);
    assert.ok((await readFile(target)).equals(contents[winner]), "the destination holds the winner's bytes whole");
    // The refused call cleared its own staging path and left no placeholder behind.
    assert.deepEqual(readdirSync(root).sort(), ["first.mkv", "second.mkv", "target.mkv"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("two concurrent folder copies into one name publish one and refuse the other", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-transfer-"));
  try {
    const target = path.join(root, "target");
    const sources = [path.join(root, "first"), path.join(root, "second")];
    const contents = ["first", "second!"];
    await Promise.all(sources.map(async (source, index) => {
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "01.mkv"), contents[index]);
    }));
    const settled = await Promise.allSettled(sources.map((source) => transferLibraryPath(source, target, false)));
    const winner = settled.findIndex((entry) => entry.status === "fulfilled");
    const refused = settled.filter((entry) => entry.status === "rejected") as PromiseRejectedResult[];
    assert.ok(winner >= 0, "one of the two folder copies lands");
    assert.equal(refused.length, 1, "the other is refused instead of replacing what landed");
    assert.equal(refused[0].reason.messageKey, "err.nameTaken");
    assert.equal(await readFile(path.join(target, "01.mkv"), "utf8"), contents[winner]);
    assert.deepEqual(readdirSync(root).sort(), ["first", "second", "target"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("two concurrent moves of different files into one name publish one and refuse the other", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-transfer-"));
  try {
    const target = path.join(root, "target.mkv");
    const sources = [path.join(root, "first.mkv"), path.join(root, "second.mkv")];
    const contents = [Buffer.alloc(64 * 1024, 7), Buffer.alloc(64 * 1024, 9)];
    await Promise.all(sources.map((source, index) => writeFile(source, contents[index])));
    const settled = await Promise.allSettled(sources.map((source) => transferLibraryPath(source, target, true)));
    const winner = settled.findIndex((entry) => entry.status === "fulfilled");
    const refused = settled.filter((entry) => entry.status === "rejected") as PromiseRejectedResult[];
    assert.ok(winner >= 0, "one of the two moves lands");
    assert.equal(refused.length, 1, "the other is refused instead of overwriting what landed");
    assert.equal(refused[0].reason.messageKey, "err.nameTaken");
    assert.ok((await readFile(target)).equals(contents[winner]), "the destination holds the winner's bytes whole");
    // The refused move never renamed, so the item it could not place is still its only copy.
    const loser = 1 - winner;
    assert.ok((await readFile(sources[loser])).equals(contents[loser]), "the loser's source is still on disk");
    assert.deepEqual(readdirSync(root).sort(), [path.basename(sources[loser]), "target.mkv"].sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a move of a folder into a name that is already taken is refused", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-transfer-"));
  try {
    const source = path.join(root, "Season 1");
    const target = path.join(root, "taken");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "01.mkv"), "video");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "kept.mkv"), "kept");
    await assert.rejects(transferLibraryPath(source, target, true), { messageKey: "err.nameTaken" });
    assert.equal(await readFile(path.join(source, "01.mkv"), "utf8"), "video");
    assert.deepEqual(readdirSync(target), ["kept.mkv"]);
    assert.deepEqual(readdirSync(root).sort(), ["Season 1", "taken"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a folder copy is refused at a name that is already taken", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-transfer-"));
  try {
    const source = path.join(root, "Season 1");
    const target = path.join(root, "taken");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "01.mkv"), "video");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "kept.mkv"), "kept");
    await assert.rejects(transferLibraryPath(source, target, false), { messageKey: "err.nameTaken" });
    assert.equal(await readFile(path.join(source, "01.mkv"), "utf8"), "video");
    assert.deepEqual(readdirSync(target), ["kept.mkv"]);
    assert.deepEqual(readdirSync(root).sort(), ["Season 1", "taken"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a copy that fails after staging clears its own staging path and nothing else", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-transfer-"));
  try {
    const source = path.join(root, "source.mkv");
    const target = path.join(root, "target.mkv");
    await writeFile(source, Buffer.alloc(256 * 1024, 5));
    // The copy stages in full, and then finds the name held by a folder it must not replace.
    await mkdir(target);
    await writeFile(path.join(target, "occupied"), "kept");
    await writeFile(`${target}.part`, "half a download");
    const staged = new Set<string>();
    await assert.rejects(transferLibraryPath(source, target, false, () => {
      for (const name of readdirSync(root)) if (name.endsWith(".part")) staged.add(name);
    }), { messageKey: "err.nameTaken" });
    assert.equal([...staged].filter((name) => name !== "target.mkv.part").length, 1, "the copy staged under a name of its own");
    assert.deepEqual(readdirSync(root).sort(), ["source.mkv", "target.mkv", "target.mkv.part"]);
    assert.deepEqual(readdirSync(target), ["occupied"]);
    assert.equal(await readFile(`${target}.part`, "utf8"), "half a download");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a copy that fails part way leaves the destination absent and the source alone", {
  skip: process.getuid?.() === 0 ? "needs a user that write permission applies to" : false,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-transfer-"));
  try {
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "01.mkv"), Buffer.alloc(256 * 1024, 5));
    // The pre-flight walk only stats the tree, so the unreadable file is met mid-copy, after
    // the bytes before it are already staged.
    await writeFile(path.join(source, "02.mkv"), "unreadable");
    await chmod(path.join(source, "02.mkv"), 0o000);
    await assert.rejects(transferLibraryPath(source, target, false), { code: "EACCES" });
    await assert.rejects(stat(target));
    assert.equal((await readFile(path.join(source, "01.mkv"))).length, 256 * 1024);
    assert.deepEqual(readdirSync(root), ["source"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a move of a folder holding a relative symlink lands instead of failing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-transfer-"));
  try {
    const source = path.join(root, "Season 1");
    const target = path.join(root, "moved");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "01.mkv"), "video");
    await symlink("01.mkv", path.join(source, "newest.mkv"));
    const before = await stat(source);
    const progress: Array<[number, number]> = [];
    const result = await transferLibraryPath(source, target, true, (done, total) => progress.push([done, total]));
    assert.equal(await readlink(path.join(target, "newest.mkv")), "01.mkv");
    assert.equal(await readFile(path.join(target, "01.mkv"), "utf8"), "video");
    await assert.rejects(stat(source));
    // The walk over the moved tree refuses the link, so the count falls back to the source.
    assert.deepEqual(result, { bytes: before.size, total: before.size });
    assert.deepEqual(progress, [[before.size, before.size]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a copy of a folder holding a symlink is still refused before anything is staged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-transfer-"));
  try {
    const source = path.join(root, "Season 1");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "01.mkv"), "video");
    await symlink("01.mkv", path.join(source, "newest.mkv"));
    await assert.rejects(transferLibraryPath(source, path.join(root, "copy"), false), /Symbolic links cannot be copied\./);
    assert.deepEqual(readdirSync(root).sort(), ["Season 1"]);
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

test("a move that fails after it took the name leaves the source and no placeholder", {
  skip: process.getuid?.() === 0 ? "needs a user that write permission applies to" : false,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-transfer-"));
  const held = path.join(root, "held");
  try {
    const source = path.join(held, "film.mkv");
    const target = path.join(root, "target.mkv");
    await mkdir(held, { recursive: true });
    await writeFile(source, "video");
    // The rename needs write permission in the folder the source is leaving, so it fails
    // after the destination has already been reserved.
    await chmod(held, 0o555);
    await assert.rejects(renameAcross(source, target), { code: "EACCES" });
    assert.equal(await readFile(source, "utf8"), "video");
    await assert.rejects(stat(target), "the placeholder went with the failed rename");
    assert.deepEqual(readdirSync(root), ["held"]);
  } finally {
    await chmod(held, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
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
