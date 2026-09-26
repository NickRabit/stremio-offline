import assert from "node:assert/strict";
import test from "node:test";
import { TOAST, layout } from "./layout.js";

const nothing = { x: 0, y: 0, width: 0, height: 0 };
const full = { x: 0, y: 0, width: 1100, height: 720 };
const toastAt = { x: 1100 - TOAST.inset - TOAST.width, y: TOAST.inset, width: TOAST.width, height: TOAST.height };

test("the shell mode gives the whole window to the shell page", () => {
  assert.deepEqual(layout({ width: 1100, height: 720 }, "shell", false), { shell: full, remote: nothing, toast: nothing });
});

test("the remote mode gives the whole window to the server page", () => {
  assert.deepEqual(layout({ width: 1100, height: 720 }, "remote", false), { shell: nothing, remote: full, toast: nothing });
});

test("the fullscreen mode leaves no shell page and no toast", () => {
  assert.deepEqual(layout({ width: 1100, height: 720 }, "fullscreen", true), { shell: nothing, remote: full, toast: nothing });
});

test("a toast sits top-right in the shell and remote modes", () => {
  assert.deepEqual(layout({ width: 1100, height: 720 }, "shell", true), { shell: full, remote: nothing, toast: toastAt });
  assert.deepEqual(layout({ width: 1100, height: 720 }, "remote", true), { shell: nothing, remote: full, toast: toastAt });
});

test("a narrow window clamps the toast so it keeps its inset on both sides", () => {
  const narrow = 300;
  const width = narrow - 2 * TOAST.inset;
  assert.deepEqual(layout({ width: narrow, height: 720 }, "remote", true).toast, { x: TOAST.inset, y: TOAST.inset, width, height: TOAST.height });
});

test("a window narrower than the toast insets leaves a zero-width toast at the left edge", () => {
  assert.deepEqual(layout({ width: 10, height: 720 }, "remote", true).toast, { x: 0, y: TOAST.inset, width: 0, height: TOAST.height });
});

test("a negative content box is clamped to zero", () => {
  assert.deepEqual(layout({ width: -10, height: -10 }, "remote", true), { shell: nothing, remote: nothing, toast: { x: 0, y: TOAST.inset, width: 0, height: TOAST.height } });
});
