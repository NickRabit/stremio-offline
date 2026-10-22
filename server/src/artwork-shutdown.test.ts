import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { saveFrame } from "./artwork.js";
import { killRunningMedia } from "./media-tools.js";

/** Its own file: `killRunningMedia` puts the whole process into its shutdown state. */
test("the shutdown takes down a thumbnail ffmpeg rather than leaving it to write into the data folder", {
  skip: process.platform === "win32" ? "a shell script stands in for ffmpeg" : false,
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "artwork-shutdown-"));
  const previous = process.env.FFMPEG_PATH;
  try {
    // An ffmpeg that would still be running long after the server has gone.
    const fake = path.join(dir, "ffmpeg");
    await writeFile(fake, "#!/bin/sh\nexec sleep 30\n");
    await chmod(fake, 0o755);
    process.env.FFMPEG_PATH = fake;
    const started = Date.now();
    const saving = saveFrame(path.join(dir, "film.mkv"), path.join(dir, "thumb.jpg"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(killRunningMedia(), 1, "the thumbnail ffmpeg is one the shutdown knows about");
    assert.equal(await saving, false);
    assert.ok(Date.now() - started < 10_000, "it ends with the shutdown, not at its own timeout");
  } finally {
    if (previous === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
