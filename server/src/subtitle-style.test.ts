import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SUBTITLE_STYLE, normalizeSubtitleStyle } from "./subtitle-style.js";

test("normalizeSubtitleStyle returns undefined for values that are not plain objects", () => {
  for (const value of [undefined, null, "box", 125, true, [], ["white"], new Date()]) {
    assert.equal(normalizeSubtitleStyle(value), undefined);
  }
});

test("normalizeSubtitleStyle keeps supported fields", () => {
  assert.deepEqual(normalizeSubtitleStyle({
    size: 200,
    color: "yellow",
    textOpacity: 75,
    background: "box",
    backgroundOpacity: 50,
    edge: "outline",
    position: 20,
  }), {
    size: 200,
    color: "yellow",
    textOpacity: 75,
    background: "box",
    backgroundOpacity: 50,
    edge: "outline",
    position: 20,
  });
});

test("normalizeSubtitleStyle falls back field by field", () => {
  assert.deepEqual(normalizeSubtitleStyle({
    size: 175,
    color: "blue",
    textOpacity: "50",
    background: "line",
    edge: "glow",
  }), {
    ...DEFAULT_SUBTITLE_STYLE,
    background: "line",
  });
});

test("normalizeSubtitleStyle ignores extra fields", () => {
  assert.deepEqual(normalizeSubtitleStyle({ ...DEFAULT_SUBTITLE_STYLE, ignored: "value" }), DEFAULT_SUBTITLE_STYLE);
});
