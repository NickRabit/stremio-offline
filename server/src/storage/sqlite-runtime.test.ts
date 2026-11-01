import assert from "node:assert/strict";
import test from "node:test";
import { parseSqliteVersion, walSafe } from "./sqlite-runtime.js";

test("SQLite versions are parsed from strict semantic text", () => {
  assert.deepEqual(parseSqliteVersion("3.53.4"), [3, 53, 4]);
  assert.deepEqual(parseSqliteVersion("3.51.3"), [3, 51, 3]);
  assert.deepEqual(parseSqliteVersion("3.50.7"), [3, 50, 7]);
  assert.deepEqual(parseSqliteVersion("3.44.6"), [3, 44, 6]);
  assert.equal(parseSqliteVersion("garbage"), undefined);
});

test("WAL is enabled only on fixed SQLite releases", () => {
  assert.equal(walSafe([3, 51, 2]), false);
  assert.equal(walSafe([3, 51, 3]), true);
  assert.equal(walSafe([3, 50, 7]), true);
  assert.equal(walSafe([3, 50, 6]), false);
  assert.equal(walSafe([3, 44, 6]), true);
  assert.equal(walSafe([3, 45, 0]), false);
  assert.equal(walSafe([3, 53, 4]), true);
});
