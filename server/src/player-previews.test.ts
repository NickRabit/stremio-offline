import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { grabFrame, PlayerPreviews } from "./player-previews.js";
import { PlaybackManager } from "./playback.js";

test("a cancelled preview takes its process down, even one that ignores SIGTERM", async () => {
  // FFmpeg waiting on a silent source does not act on SIGTERM; this stands in for it.
  const pidFile = path.join(os.tmpdir(), `preview-pid-${process.pid}`);
  const stubborn = ["-e", `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`];
  const controller = new AbortController();
  const grabbing = grabFrame(stubborn, controller.signal, process.execPath);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  controller.abort();
  const error = await grabbing.then(() => undefined, (value: unknown) => value as { signal?: string });
  assert.equal(error?.signal, "SIGKILL");
  const pid = Number(await readFile(pidFile, "utf8"));
  await rm(pidFile, { force: true });
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), "the process is gone by the time the grab settles");
});

test("one preview at a time per film", async () => {
  let release!: () => void;
  const previews = new PlayerPreviews(() => new Promise<Buffer>((resolve) => { release = () => resolve(Buffer.from("jpg")); }));
  const first = previews.frame("s", "source", 100, new AbortController().signal);
  assert.equal(await previews.frame("s", "source", 200, new AbortController().signal), undefined);
  release();
  assert.ok(await first);
});

test("previews are not made from a remote source", async () => {
  const manager = new PlaybackManager("/tmp/test-preview-remote") as any;
  let grabbed = 0;
  manager.previews = { frame: async () => { grabbed += 1; return Buffer.from("x"); }, stop: () => {} };
  manager.sessions.set("remote", { id: "remote", stream: { url: "https://cdn.example/film.mkv" }, info: { duration: 3600 }, stopped: false });
  manager.sessions.set("local", { id: "local", stream: { url: "file://lib/film.mkv" }, info: { duration: 3600 }, stopped: false });
  assert.equal(await manager.preview("remote", 100, new AbortController().signal), undefined);
  assert.equal(grabbed, 0);
  assert.ok(await manager.preview("local", 100, new AbortController().signal));
  assert.equal(grabbed, 1);
});

test("shutdown reaches a preview that is still running", {
  skip: process.platform === "win32" ? "a kill is not a signal there" : false,
}, async () => {
  const { killRunningMedia } = await import("./media-tools.js");
  const directory = await mkdtemp(path.join(os.tmpdir(), "preview-shutdown-"));
  const script = path.join(directory, "ffmpeg");
  const marker = path.join(directory, "pid");
  await writeFile(script, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
  await chmod(script, 0o755);
  try {
    const grabbing = grabFrame([], new AbortController().signal, script);
    let pid = 0;
    while (!pid) { pid = Number(await readFile(marker, "utf8").catch(() => "0")); await new Promise((resolve) => setTimeout(resolve, 20)); }
    assert.ok(killRunningMedia() >= 1, "the preview is registered with the shutdown");
    await grabbing.catch(() => undefined);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the preview is gone");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
