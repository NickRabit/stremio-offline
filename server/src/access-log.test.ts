import assert from "node:assert/strict";
import test from "node:test";
import { RepeatFilter } from "./access-log.js";

test("a key reports once per window and the next line carries what it stood for", () => {
  let now = 0;
  const filter = new RepeatFilter(() => now, 1000);

  assert.deepEqual(filter.record("a"), { suppressed: 0 });
  for (let i = 0; i < 5; i += 1) assert.equal(filter.record("a"), undefined);

  now += 1000;
  assert.deepEqual(filter.record("a"), { suppressed: 5 });
  assert.equal(filter.record("a"), undefined);

  now += 1000;
  assert.deepEqual(filter.record("a"), { suppressed: 1 });
});

test("keys are counted apart", () => {
  let now = 0;
  const filter = new RepeatFilter(() => now, 1000);
  assert.deepEqual(filter.record("a"), { suppressed: 0 });
  assert.deepEqual(filter.record("b"), { suppressed: 0 });
  assert.equal(filter.record("a"), undefined);
  now += 1000;
  assert.deepEqual(filter.record("a"), { suppressed: 1 });
  assert.deepEqual(filter.record("b"), { suppressed: 0 });
});

test("the map does not grow without bound", () => {
  let now = 0;
  const filter = new RepeatFilter(() => now, 60_000, 10);
  for (let i = 0; i < 100; i += 1) filter.record(`key-${i}`);
  assert.ok(filter.record("key-99") === undefined, "the newest key is still remembered");
});

test("an overflow drops an idle key, not the busiest one", () => {
  let now = 0;
  const filter = new RepeatFilter(() => now, 60_000, 10);
  assert.deepEqual(filter.record("busy"), { suppressed: 0 });
  // The loud key keeps knocking while twenty quiet ones arrive behind it.
  for (let i = 0; i < 20; i += 1) { assert.equal(filter.record("busy"), undefined); filter.record(`key-${i}`); }
  now += 60_000;
  assert.deepEqual(filter.record("busy"), { suppressed: 20 }, "the count it stood for has to survive the overflow");
});
