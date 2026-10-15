import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { dolbyVisionProfile, hasDolbyVisionEnhancementLayer, looksUnreachable, pickVariant, playlistArgsFrom, probe } from "./probe.js";

test("the picky segment options are passed only to a build that has them", () => {
  assert.deepEqual(
    playlistArgsFrom("  -allowed_segment_extensions <string>\n  -extension_picky   <boolean>  reject unknown extensions"),
    ["-allowed_extensions", "ALL", "-allowed_segment_extensions", "ALL", "-extension_picky", "0"],
  );
  // An older FFmpeg dies on an option it does not know, so it must be left out entirely.
  assert.deepEqual(playlistArgsFrom("  -allowed_extensions <string>"), ["-allowed_extensions", "ALL"]);
  assert.deepEqual(playlistArgsFrom(""), ["-allowed_extensions", "ALL"]);
});

test("a dead connection or a server error is recognised as unreachable", () => {
  assert.equal(looksUnreachable("tcp://host:443: Connection refused"), true);
  assert.equal(looksUnreachable("Server returned 404 Not Found"), true);
  assert.equal(looksUnreachable("Server returned 500 Internal Server Error"), true);
  assert.equal(looksUnreachable("Failed to resolve hostname host: Name or service not known"), true);
  assert.equal(looksUnreachable("Connection timed out"), true);
});

test("a stream the source just failed to decode is not treated as unreachable", () => {
  assert.equal(looksUnreachable("Invalid data found when processing input"), false);
  assert.equal(looksUnreachable(""), false);
});

test("Dolby Vision enhancement layer is recognised from ffprobe side data", () => {
  assert.equal(hasDolbyVisionEnhancementLayer({
    side_data_list: [{ side_data_type: "DOVI configuration record", el_present_flag: 1 }],
  }), true);
  assert.equal(hasDolbyVisionEnhancementLayer({
    side_data_list: [{ name: "Dolby Vision enhancement-layer HEVC configuration" }],
  }), true);
  assert.equal(hasDolbyVisionEnhancementLayer({
    tags: { title: "Dolby Vision enhancement-layer HEVC configuration" },
  }), true);
  assert.equal(hasDolbyVisionEnhancementLayer({
    side_data_list: [{ side_data_type: "DOVI configuration record", el_present_flag: 0 }],
  }), false);
  assert.equal(hasDolbyVisionEnhancementLayer({ side_data_list: [] }), false);
});

test("an HLS master is read as one rendition: the tallest, with its own audio", () => {
  const rendition = (index: number, height: number, bitrate: number) => [
    { index, codec_type: "video", codec_name: "h264", height, tags: { variant_bitrate: String(bitrate) } },
    { index: index + 1, codec_type: "audio", codec_name: "aac", tags: { variant_bitrate: String(bitrate) } },
    { index: index + 2, codec_type: "data", tags: { variant_bitrate: String(bitrate) } },
  ];
  const ladder = [...rendition(0, 144, 105384), ...rendition(3, 720, 819686), ...rendition(6, 1080, 2151645), ...rendition(9, 2160, 11504545)];
  const picked = pickVariant(ladder);
  assert.equal(picked?.video.index, 9, "the 4K, not the 144p FFmpeg lists first");
  assert.equal(picked?.audio?.index, 10, "the audio of that same rendition");
  assert.equal(pickVariant(rendition(0, 720, 1)), undefined, "a single rendition needs no choosing");
  assert.equal(pickVariant([{ index: 0, codec_type: "video", height: 1080 }, { index: 1, codec_type: "video", height: 720 }]), undefined, "a file, not a playlist");
});

test("the Dolby Vision profile is read from the configuration record for the log", () => {
  assert.equal(dolbyVisionProfile({ side_data_list: [{ side_data_type: "DOVI configuration record", dv_profile: 7, el_present_flag: 1 }] }), 7);
  assert.equal(dolbyVisionProfile({ side_data_list: [{ side_data_type: "DOVI configuration record", dv_profile: 8 }] }), 8);
  assert.equal(dolbyVisionProfile({ side_data_list: [{ side_data_type: "Mastering display metadata" }] }), undefined);
  assert.equal(dolbyVisionProfile({}), undefined);
});

// A real process stands in for ffprobe here: the point of these tests is that an aborted probe
// kills the running child and never reaches the deep round, which a stubbed runner could not show.
const FAKE_FFPROBE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("-h")) process.exit(0);
const deep = args.includes("60M");
const write = (line) => fs.appendFileSync(process.env.FAKE_LOG, line + "\n");
write(deep ? "deep" : "fast");
setTimeout(() => {
  write(deep ? "deep-done" : "fast-done");
  process.stdout.write(JSON.stringify(deep
    ? { format: { format_name: "matroska", duration: "120" }, streams: [
        { index: 0, codec_type: "video", codec_name: "h264" },
        { index: 1, codec_type: "audio", codec_name: "aac" }] }
    : { format: { format_name: "matroska" }, streams: [{ index: 0, codec_type: "video", codec_name: "h264" }] }));
  process.exit(0);
}, Number(deep ? process.env.FAKE_DEEP_MS : process.env.FAKE_FAST_MS) || 0);
`;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fakeFfprobe = async (t: { after(fn: () => unknown): void }, delays: { fastMs?: number; deepMs?: number } = {}) => {
  const dir = await mkdtemp(path.join(tmpdir(), "fake-ffprobe-"));
  const binary = path.join(dir, "ffprobe");
  const logFile = path.join(dir, "calls.log");
  await writeFile(binary, FAKE_FFPROBE);
  await chmod(binary, 0o755);
  const previous = {
    binary: process.env.FFPROBE_PATH, log: process.env.FAKE_LOG,
    fast: process.env.FAKE_FAST_MS, deep: process.env.FAKE_DEEP_MS,
  };
  process.env.FFPROBE_PATH = binary;
  process.env.FAKE_LOG = logFile;
  process.env.FAKE_FAST_MS = String(delays.fastMs ?? 0);
  process.env.FAKE_DEEP_MS = String(delays.deepMs ?? 0);
  t.after(() => {
    for (const [name, value] of [["FFPROBE_PATH", previous.binary], ["FAKE_LOG", previous.log], ["FAKE_FAST_MS", previous.fast], ["FAKE_DEEP_MS", previous.deep]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    return rm(dir, { recursive: true, force: true });
  });
  const calls = () => { try { return readFileSync(logFile, "utf8").split("\n").filter(Boolean); } catch { return []; } };
  const waitForCall = async (line: string) => {
    for (let attempt = 0; attempt < 400 && !calls().includes(line); attempt += 1) await pause(5);
    assert.ok(calls().includes(line), `the fake ffprobe never reported "${line}"`);
  };
  return { calls, waitForCall };
};

const abortError = (error: Error) => error.name === "AbortError";

test("a probe whose caller already aborted never starts ffprobe", async (t) => {
  const { calls } = await fakeFfprobe(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(probe("https://cdn.example/movie.mkv", controller.signal), abortError);
  assert.deepEqual(calls(), [], "no ffprobe process was spawned at all");
});

test("an abort during the fast probe stops it and never reaches the deep probe", async (t) => {
  const { calls, waitForCall } = await fakeFfprobe(t, { fastMs: 5_000 });
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = probe("https://cdn.example/movie.mkv", controller.signal);
  await waitForCall("fast");
  controller.abort();
  await assert.rejects(pending, abortError);
  assert.ok(Date.now() - startedAt < 3_000, "the probe returned on the abort, not on its own delay");
  await pause(100);
  assert.deepEqual(calls(), ["fast"], "the killed ffprobe never finished and the deep probe never started");
});

test("an abort during the deep probe stops the deep round", async (t) => {
  const { calls, waitForCall } = await fakeFfprobe(t, { deepMs: 5_000 });
  const controller = new AbortController();
  const pending = probe("https://cdn.example/movie.mkv", controller.signal);
  await waitForCall("deep");
  controller.abort();
  await assert.rejects(pending, abortError);
  await pause(100);
  assert.deepEqual(calls(), ["fast", "fast-done", "deep"], "the deep probe was started and then cancelled");
});
