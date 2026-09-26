import assert from "node:assert/strict";
import test from "node:test";
import { downloadFraction, nextToastId, safeFileName } from "./shell-text.js";

test("a plain file name is kept as it is", () => {
  assert.equal(safeFileName("Film.2021.mkv"), "Film.2021.mkv");
  assert.equal(safeFileName("  spaced name.mp4  "), "spaced name.mp4");
});

test("only the base name survives a path", () => {
  assert.equal(safeFileName("/tmp/downloads/Film.mkv"), "Film.mkv");
  assert.equal(safeFileName("C:\\Users\\me\\Film.mkv"), "Film.mkv");
  assert.equal(safeFileName("../../etc/passwd"), "passwd");
});

test("control characters are dropped and an empty name falls back to video", () => {
  assert.equal(safeFileName("a\u0000b\u001fc.mkv"), "abc.mkv");
  assert.equal(safeFileName("\u0000\u0001"), "video");
  assert.equal(safeFileName("   "), "video");
  assert.equal(safeFileName(""), "video");
  assert.equal(safeFileName("/tmp/"), "video");
});

test("a long name is shortened in the middle to eighty characters", () => {
  const long = "a".repeat(120) + ".mkv";
  const shortened = safeFileName(long);
  assert.equal(shortened.length, 80);
  assert.equal(shortened.includes("\u2026"), true);
  assert.equal(shortened.startsWith("a".repeat(40)), true);
  assert.equal(shortened.endsWith(".mkv"), true);
  assert.equal(safeFileName("a".repeat(80)).length, 80);
  assert.equal(safeFileName("a".repeat(80)).includes("\u2026"), false);
});

test("a known total gives a fraction between zero and one", () => {
  assert.equal(downloadFraction(0, 100), 0);
  assert.equal(downloadFraction(50, 100), 0.5);
  assert.equal(downloadFraction(100, 100), 1);
  assert.equal(downloadFraction(150, 100), 1);
  assert.equal(downloadFraction(-10, 100), 0);
});

test("an unknown total gives Electron's indeterminate value", () => {
  assert.equal(downloadFraction(10, 0), 2);
  assert.equal(downloadFraction(10, -1), 2);
  assert.equal(downloadFraction(10, Number.NaN), 2);
  assert.equal(downloadFraction(Number.NaN, 100), 2);
  assert.equal(downloadFraction(10, Number.POSITIVE_INFINITY), 2);
});

test("toast ids only grow", () => {
  const first = nextToastId();
  const second = nextToastId();
  assert.ok(second > first);
  assert.equal(Number.isInteger(first), true);
});
