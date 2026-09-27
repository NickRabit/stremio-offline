import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nextVideoFile } from "./next-file.js";

test("next video follows natural episode order and ignores folders, sidecars and symlinks", {
  skip: process.platform === "win32" ? "symlinks need developer mode or admin on Windows" : false,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "next-video-"));
  try {
    for (const name of ["Episode 10.mp4", "Episode 2.mkv", "Episode 1.mp4", "Episode 3.srt", ".hidden.mp4"]) await writeFile(path.join(root, name), "");
    await mkdir(path.join(root, "Episode 3.mp4"));
    await symlink(path.join(root, "Episode 10.mp4"), path.join(root, "Episode 4.mp4"));
    assert.equal(await nextVideoFile(path.join(root, "Episode 1.mp4")), "Episode 2.mkv");
    assert.equal(await nextVideoFile(path.join(root, "Episode 2.mkv")), "Episode 10.mp4");
    assert.equal(await nextVideoFile(path.join(root, "Episode 10.mp4")), undefined);
    assert.equal(await nextVideoFile(path.join(root, "missing.mp4")), undefined);
    assert.equal(await nextVideoFile(path.join(root, "Episode 1.mp4"), -1), undefined);
    assert.equal(await nextVideoFile(path.join(root, "Episode 2.mkv"), -1), "Episode 1.mp4");
    assert.equal(await nextVideoFile(path.join(root, "Episode 10.mp4"), -1), "Episode 2.mkv");
    assert.equal(await nextVideoFile(path.join(root, "missing.mp4"), -1), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
