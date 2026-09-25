import assert from "node:assert/strict";
import test from "node:test";
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
