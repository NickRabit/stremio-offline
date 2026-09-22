import assert from "node:assert/strict";
import test from "node:test";
import { layout } from "./layout.js";

test("the connection mode gives the whole content box to the local page", () => {
  assert.deepEqual(layout({ width: 1100, height: 720 }, "connect"), { chrome: { x: 0, y: 0, width: 1100, height: 720 }, remote: { x: 0, y: 0, width: 0, height: 0 } });
});

test("the remote mode keeps a bar above the server page", () => {
  assert.deepEqual(layout({ width: 1100, height: 720 }, "remote"), { chrome: { x: 0, y: 0, width: 1100, height: 48 }, remote: { x: 0, y: 48, width: 1100, height: 672 } });
});

test("the fullscreen mode gives the whole content box to the server page", () => {
  assert.deepEqual(layout({ width: 1100, height: 720 }, "fullscreen"), { chrome: { x: 0, y: 0, width: 0, height: 0 }, remote: { x: 0, y: 0, width: 1100, height: 720 } });
});

test("a content box shorter than the bar leaves no space for the server page", () => {
  assert.deepEqual(layout({ width: 1100, height: 20 }, "remote"), { chrome: { x: 0, y: 0, width: 1100, height: 20 }, remote: { x: 0, y: 20, width: 1100, height: 0 } });
});

test("a negative content box is clamped to zero", () => {
  assert.deepEqual(layout({ width: -10, height: -10 }, "remote"), { chrome: { x: 0, y: 0, width: 0, height: 0 }, remote: { x: 0, y: 0, width: 0, height: 0 } });
});
