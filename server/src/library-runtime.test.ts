import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmedByRuntime, runtimeFits, runtimeMinutes } from "./library-runtime.js";

test("a runtime is read from every shape a provider writes it in", () => {
  assert.equal(runtimeMinutes({ runtime: 85 }), 85);
  assert.equal(runtimeMinutes({ runtime: "85 min" }), 85);
  assert.equal(runtimeMinutes({ runtime: "85min" }), 85);
  assert.equal(runtimeMinutes({ runtime: "1h 25min" }), 85);
  assert.equal(runtimeMinutes({ runtime: "1 h 25 min" }), 85);
  assert.equal(runtimeMinutes({ runtime: "PT85M" }), 85);
  assert.equal(runtimeMinutes({ runtime: "PT1H25M" }), 85);
  assert.equal(runtimeMinutes({ runtime: "2h" }), 120);
});

test("a runtime that says nothing, or nothing useful, is unknown", () => {
  for (const runtime of [undefined, null, "", "   ", "soon", "1h soon", "85", 0, -5, NaN, Infinity, {}, []]) {
    assert.equal(runtimeMinutes({ runtime }), undefined, `${String(runtime)} is not a runtime`);
  }
  assert.equal(runtimeMinutes(undefined), undefined);
  assert.equal(runtimeMinutes(null), undefined);
  assert.equal(runtimeMinutes({}), undefined);
});

test("a file fits a runtime within its tolerance, PAL speed-up included", () => {
  // A PAL copy of an 85-minute film runs about four percent short.
  assert.equal(runtimeFits(85 * 60, 85), true);
  assert.equal(runtimeFits(81.6 * 60, 85), true);
  assert.equal(runtimeFits(78 * 60, 85), false, "seven minutes short of an 85-minute film is another film");
  assert.equal(runtimeFits(108 * 60, 85), false);
  assert.equal(runtimeFits(0, 85), false);
  assert.equal(runtimeFits(Number.NaN, 85), false);
});

test("the one candidate whose runtime fits is the film", () => {
  // Lilo & Stitch: the file runs 85 minutes, the remake is 108.
  assert.equal(confirmedByRuntime(5100, [108, 85], [4000, 9000]), 1);
  assert.equal(confirmedByRuntime(5100, [85, 108], [9000, 4000]), 0);
});

test("two candidates that fit, or none, confirm nothing", () => {
  assert.equal(confirmedByRuntime(5100, [85, 84], []), undefined);
  assert.equal(confirmedByRuntime(5100, [100, 120], []), undefined);
  assert.equal(confirmedByRuntime(5100, [undefined, undefined], []), undefined);
});

test("a candidate with no runtime blocks the confirmation unless nobody knows it", () => {
  assert.equal(confirmedByRuntime(5100, [85, undefined], [9000, 4000]), undefined, "a rival of equal standing could be the one");
  assert.equal(confirmedByRuntime(5100, [85, undefined], [9000, 400]), 0, "a rival nobody watched does not stand in the way");
  assert.equal(confirmedByRuntime(5100, [85, undefined, undefined], [9000, 0, 0]), undefined, "two unknowns always block");
});
