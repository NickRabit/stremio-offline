import assert from "node:assert/strict";
import test from "node:test";
import { TrackedMap } from "./tracked-map.js";

test("set, delete and clear record their keys", () => {
  const map = new TrackedMap<string, number>();
  map.set("first", 1);
  map.set("second", 2);
  assert.deepEqual([...map.snapshot().keys()].sort(), ["first", "second"]);

  map.delete("second");
  assert.ok(map.snapshot().has("second"));

  map.clear();
  assert.ok(map.snapshot().has("first"));
});

test("forget keeps keys changed after the snapshot", () => {
  const map = new TrackedMap<string, number>();
  map.set("unchanged", 1);
  map.set("changed", 1);
  const snapshot = map.snapshot();

  map.set("changed", 2);
  map.set("new", 1);
  map.forget(snapshot);

  assert.equal(map.hasDirty(), true);
  assert.deepEqual([...map.snapshot().keys()].sort(), ["changed", "new"]);

  map.forget(map.snapshot());
  assert.equal(map.hasDirty(), false);
});
