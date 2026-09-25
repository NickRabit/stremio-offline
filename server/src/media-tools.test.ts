import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ffmpegPath, ffprobePath } from "./media-tools.js";

test("an unset variable keeps the bare name PATH resolves", () => {
  assert.equal(ffmpegPath({}), "ffmpeg");
  assert.equal(ffprobePath({}), "ffprobe");
});

test("a set variable names the executable, trimmed", () => {
  assert.equal(ffmpegPath({ FFMPEG_PATH: "/opt/homebrew/bin/ffmpeg" }), "/opt/homebrew/bin/ffmpeg");
  assert.equal(ffprobePath({ FFPROBE_PATH: "/usr/local/bin/ffprobe" }), "/usr/local/bin/ffprobe");
  assert.equal(ffmpegPath({ FFMPEG_PATH: " /opt/ffmpeg " }), "/opt/ffmpeg");
  assert.equal(ffprobePath({ FFPROBE_PATH: " /opt/ffprobe " }), "/opt/ffprobe");
});

test("an empty or whitespace-only variable counts as unset", () => {
  assert.equal(ffmpegPath({ FFMPEG_PATH: "" }), "ffmpeg");
  assert.equal(ffmpegPath({ FFMPEG_PATH: "   " }), "ffmpeg");
  assert.equal(ffprobePath({ FFPROBE_PATH: "" }), "ffprobe");
  assert.equal(ffprobePath({ FFPROBE_PATH: "\t\n" }), "ffprobe");
});

test("each variable is read when it is asked, not when the module is loaded", () => {
  const env: NodeJS.ProcessEnv = {};
  assert.equal(ffmpegPath(env), "ffmpeg");
  env.FFMPEG_PATH = "/opt/homebrew/bin/ffmpeg";
  assert.equal(ffmpegPath(env), "/opt/homebrew/bin/ffmpeg");
  env.FFPROBE_PATH = "/opt/homebrew/bin/ffprobe";
  assert.equal(ffprobePath(env), "/opt/homebrew/bin/ffprobe");
  delete env.FFMPEG_PATH;
  assert.equal(ffmpegPath(env), "ffmpeg");
});

test("the process environment is the default", (t) => {
  const original = process.env.FFMPEG_PATH;
  t.after(() => { if (original === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = original; });
  process.env.FFMPEG_PATH = "/tmp/ffmpeg";
  assert.equal(ffmpegPath(), "/tmp/ffmpeg");
  delete process.env.FFMPEG_PATH;
  assert.equal(ffmpegPath(), "ffmpeg");
});

test("no process in the server is started by a bare ffmpeg or ffprobe name", async () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const files = (await readdir(root, { recursive: true }))
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "media-tools.ts");
  assert.ok(files.length > 10, "the scan reads the TypeScript sources");
  const bare = /\b(?:(?:spawn|execFile|exec)(?:Sync)?\)?|run)\(\s*["'`]ff(?:mpeg|probe)(?:\.exe)?[\s"'`]/;
  const offenders = [];
  for (const file of files) if (bare.test(await readFile(path.join(root, file), "utf8"))) offenders.push(file);
  assert.deepEqual(offenders, [], "start them through ffmpegPath() or ffprobePath()");
});

test("a tracked FFmpeg is killed at shutdown, and one that already ended is forgotten", async () => {
  const { spawn } = await import("node:child_process");
  const { killRunningMedia, trackMedia } = await import("./media-tools.js");
  const done = trackMedia(spawn(process.execPath, ["-e", ""]));
  await new Promise((resolve) => done.once("exit", resolve));
  const running = trackMedia(spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]));
  const exited = new Promise((resolve) => running.once("exit", (_code, signal) => resolve(signal)));
  assert.equal(killRunningMedia(), 1);
  assert.equal(await exited, "SIGKILL");
  assert.equal(killRunningMedia(), 0);
});

test("once the shutdown killed the running ones, a new FFmpeg is killed as it starts", async () => {
  const { spawn } = await import("node:child_process");
  const { killRunningMedia, mediaStopping, trackMedia } = await import("./media-tools.js");
  killRunningMedia();
  assert.equal(mediaStopping(), true);
  const late = trackMedia(spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]));
  const signal = await new Promise((resolve) => late.once("exit", (_code, signal) => resolve(signal)));
  assert.equal(signal, "SIGKILL");
});
