import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DebridReadyStore } from "./debrid-ready.js";

const HASH = "59e11cef8c2152ac73681092844ebd3db19025bc";
const DAY_MS = 24 * 60 * 60 * 1_000;

const tempDir = () => mkdtemp(path.join(os.tmpdir(), "debrid-ready-"));
const fileIn = (dir: string) => path.join(dir, "debrid-ready.json");

test("a remembered hash survives a store round trip in lower case", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = Date.parse("2026-10-28T10:00:00.000Z");
  const store = new DebridReadyStore(dir, () => now);
  await store.load();

  await store.remember(HASH.toUpperCase());

  const reopened = new DebridReadyStore(dir, () => now);
  await reopened.load();
  assert.equal(reopened.has(HASH), true);
  const stored = JSON.parse(await readFile(fileIn(dir), "utf8")) as { entries: Record<string, string> };
  assert.deepEqual(stored.entries, { [HASH]: "2026-10-28T10:00:00.000Z" });
});

test("the store keeps the five thousand newest hashes", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = Date.parse("2026-10-28T10:00:00.000Z");
  const entries = Object.fromEntries(Array.from({ length: 5_001 }, (_unused, index) => [
    index.toString(16).padStart(40, "0"),
    new Date(now - index * 1_000).toISOString(),
  ]));
  await writeFile(fileIn(dir), JSON.stringify({ version: 1, entries }));

  const store = new DebridReadyStore(dir, () => now);
  await store.load();
  await store.remember("f".repeat(40));

  const stored = JSON.parse(await readFile(fileIn(dir), "utf8")) as { entries: Record<string, string> };
  assert.equal(Object.keys(stored.entries).length, 5_000);
  assert.equal(store.has("0".repeat(40)), true);
  assert.equal(store.has((5_000).toString(16).padStart(40, "0")), false);
});

test("hashes older than sixty days are ignored and removed by the next save", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = Date.parse("2026-10-28T10:00:00.000Z");
  const oldHash = "a".repeat(40);
  const freshHash = "b".repeat(40);
  const replacement = "c".repeat(40);
  await writeFile(fileIn(dir), JSON.stringify({
    version: 1,
    entries: {
      [oldHash]: new Date(now - 61 * DAY_MS).toISOString(),
      [freshHash]: new Date(now - 59 * DAY_MS).toISOString(),
    },
  }));

  const store = new DebridReadyStore(dir, () => now);
  await store.load();
  assert.equal(store.has(oldHash), false);
  assert.equal(store.has(freshHash), true);

  await store.remember(replacement);
  const stored = JSON.parse(await readFile(fileIn(dir), "utf8")) as { entries: Record<string, string> };
  assert.equal(Object.hasOwn(stored.entries, oldHash), false);
  assert.equal(Object.hasOwn(stored.entries, freshHash), true);
});

test("a broken file starts empty and can be replaced", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(fileIn(dir), "{not json");
  const now = Date.parse("2026-10-28T10:00:00.000Z");
  const store = new DebridReadyStore(dir, () => now);

  await store.load();
  assert.equal(store.has(HASH), false);
  await store.remember(HASH);

  const reopened = new DebridReadyStore(dir, () => now);
  await reopened.load();
  assert.equal(reopened.has(HASH), true);
});
