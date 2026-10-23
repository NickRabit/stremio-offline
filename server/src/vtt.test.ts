import assert from "node:assert/strict";
import test from "node:test";
import { completeVttBlocks, shiftVtt, vttCoverage } from "./vtt.js";

const cues = "WEBVTT\n\n00:10:00.000 --> 00:10:02.000\nfirst\n\n01:00:00.000 --> 01:00:04.500\nsecond\n";

test("cues move to the generation the player is actually playing", () => {
  const shifted = shiftVtt(cues, 3000);
  assert.match(shifted, /00:10:00\.000 --> 00:10:04\.500\nsecond/);
  assert.doesNotMatch(shifted, /first/);
});

test("a cue still on screen at the seek point survives with a clamped start", () => {
  assert.match(shiftVtt("WEBVTT\n\n00:49:58.000 --> 00:50:05.000\nspoken\n", 3000), /00:00:00\.000 --> 00:00:05\.000/);
});

test("the minute:second form FFmpeg writes is read as well as the hour form", () => {
  assert.equal(vttCoverage("WEBVTT\n\n44:50.418 --> 44:52.418\nline\n"), 2692.418);
  assert.equal(vttCoverage("WEBVTT\n\n01:00:00.000 --> 01:00:04.500\nline\n"), 3604.5);
  assert.equal(vttCoverage("WEBVTT\n\nno cues here\n"), -Infinity);
});

test("a half-written cue is not handed out while FFmpeg is still writing", () => {
  const growing = "WEBVTT\n\n00:10:00.000 --> 00:10:02.000\nwritten\n\n00:11:00.000 --> ";
  assert.equal(completeVttBlocks(growing), "WEBVTT\n\n00:10:00.000 --> 00:10:02.000\nwritten");
  assert.equal(completeVttBlocks("WEBVTT\n\n00:10:00.000 --> 00:10:02.000\nwritten\n\n"), "WEBVTT\n\n00:10:00.000 --> 00:10:02.000\nwritten\n\n");
});

test("a file saved with Windows line endings is shifted cue by cue", () => {
  const shifted = shiftVtt("WEBVTT\r\n\r\n00:10:05.000 --> 00:10:07.000\r\nfirst\r\n\r\n00:10:20.000 --> 00:10:22.000\r\nsecond\r\n", 600);
  assert.match(shifted, /00:00:05\.000 --> 00:00:07\.000\nfirst/);
  assert.match(shifted, /00:00:20\.000 --> 00:00:22\.000\nsecond/);
});
