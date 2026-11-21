import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ImageProxy } from "./images.js";
import { killRunningMedia } from "./media-tools.js";

// Its own file: the shutdown switch it throws stays on for the rest of the process.
test("a re-encode killed by the shutdown stores nothing rather than the full-size original", {
  skip: process.platform === "win32" ? "the test uses a POSIX script for FFmpeg" : false,
}, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-images-shutdown-"));
  const wide = Buffer.alloc(24);
  wide.writeUInt32BE(0x89504e47, 0);
  wide.write("IHDR", 12, "latin1");
  wide.writeUInt32BE(1_000, 16);
  const proxy = new ImageProxy(dir, 1024 * 1024, 0, async () => new Response(wide, { headers: { "content-type": "image/png" } }), undefined, Date.now, 0);
  await proxy.load();
  const marker = path.join(dir, "ffmpeg-started");
  const fake = path.join(dir, "ffmpeg");
  await writeFile(fake, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "");\nsetInterval(() => {}, 1000);\n`);
  await chmod(fake, 0o755);
  const previous = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = fake;
  try {
    const id = proxy.proxied("https://cdn.example/wide.png")!.split("/").pop()!;
    const fetching = proxy.fetch(id);
    for (let attempt = 0; !(await stat(marker).then(() => true, () => false)); attempt += 1) {
      if (attempt >= 300) throw new Error("FFmpeg never started");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    killRunningMedia();
    assert.equal(await fetching, undefined);
    assert.equal(await proxy.readCached(id), undefined);
    assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith(`${id}.`)), []);
  } finally {
    if (previous === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = previous;
  }
});
