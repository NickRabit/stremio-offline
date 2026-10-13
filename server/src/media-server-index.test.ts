import assert from "node:assert/strict";
import { test } from "node:test";
import { MediaServerIndex, type MediaServerSnapshotKey, type SnapshotScan } from "./media-server-index.js";
import type { ProviderItem } from "./media-server-provider.js";
import { MediaServerError } from "./media-server-types.js";

const item = (id: string, over: Partial<ProviderItem> = {}): ProviderItem => ({ id, name: `Item ${id}`, type: "movie", providerIds: {}, ...over });

const key = (over: Partial<MediaServerSnapshotKey> = {}): MediaServerSnapshotKey => ({
  libraryId: "rlib_00000000000000000000000000000001",
  connectionId: "mconn_00000000000000000000000000000001",
  remoteId: "lib-1",
  generation: 0,
  identityKey: "jellyfin|server-1|user-1",
  ...over,
});

const ok = (items: ProviderItem[]): SnapshotScan => ({ items, asOf: "2026-01-01T00:00:00.000Z" });

interface Deferred { promise: Promise<SnapshotScan>; resolve(value: SnapshotScan): void; reject(error: unknown): void }
const deferred = (): Deferred => {
  let resolve!: (value: SnapshotScan) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<SnapshotScan>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const clock = () => {
  let now = 1_000;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
};

test("a fresh snapshot is served without rescanning and is replaced after the TTL", async () => {
  const time = clock();
  const index = new MediaServerIndex({ clock: time.now, ttlMs: 1_000 });
  let scans = 0;
  const scan = () => { scans += 1; return Promise.resolve(ok([item("1"), item("2")])); };

  const first = await index.resolve(key(), { scan });
  assert.equal(first.items.length, 2);
  assert.equal(scans, 1);
  const second = await index.resolve(key(), { scan });
  assert.equal(second.id, first.id, "within the TTL the same snapshot answers");
  assert.equal(scans, 1);

  time.advance(1_001);
  const third = await index.resolve(key(), { scan });
  assert.equal(scans, 2, "past the TTL the library is scanned again");
  assert.notEqual(third.id, first.id);
  assert.deepEqual(third.items.map((entry) => entry.id), ["1", "2"]);
});

test("returned items and the snapshot key are frozen so a caller cannot corrupt the cache", async () => {
  const index = new MediaServerIndex();
  const snapshot = await index.resolve(key(), { scan: () => Promise.resolve(ok([item("1")])) });
  assert.ok(Object.isFrozen(snapshot.items));
  assert.ok(Object.isFrozen(snapshot.items[0]));
  assert.ok(Object.isFrozen(snapshot.key));
  const again = await index.resolve(key(), { scan: () => Promise.resolve(ok([])) });
  assert.equal(again.items[0]?.name, "Item 1");
});

test("a failed refresh fails closed, keeps the previous snapshot for its exact cursor and backs off", async () => {
  const time = clock();
  const index = new MediaServerIndex({ clock: time.now, ttlMs: 1_000, retryBaseMs: 5_000 });
  let fail = false;
  let scans = 0;
  const scan = () => {
    scans += 1;
    return fail ? Promise.reject(new MediaServerError("unavailable", "down")) : Promise.resolve(ok([item("1")]));
  };
  const first = await index.resolve(key(), { scan });
  assert.equal(scans, 1);

  time.advance(1_001);
  fail = true;
  await assert.rejects(index.resolve(key(), { scan }), { code: "unavailable" }, "a failed refresh serves nothing");
  assert.ok(Object.isFrozen(first.items));

  // Inside the backoff the next un-cursored request is refused without touching the provider.
  const attempts = scans;
  await assert.rejects(index.resolve(key(), { scan }), { code: "unavailable" });
  assert.equal(scans, attempts, "the backoff window is not rescanned");

  // The retained snapshot still answers a cursor that names it exactly.
  const paged = await index.resolve(key(), { cursorSnapshotId: first.id, scan: () => Promise.reject(new Error("must not scan")) });
  assert.equal(paged.id, first.id);

  fail = false;
  time.advance(10_000);
  const refreshed = await index.resolve(key(), { scan });
  assert.notEqual(refreshed.id, first.id, "once the backoff expires a full success replaces the snapshot");
});

test("a library with no snapshot and a backing-off failure refuses with the wait it implies", async () => {
  const index = new MediaServerIndex({ retryBaseMs: 5_000 });
  const scan = () => Promise.reject(new MediaServerError("rate-limited", "slow down", 429, 120_000));
  await assert.rejects(index.resolve(key(), { scan }), { code: "rate-limited" });
  await assert.rejects(index.resolve(key(), { scan }), (error: MediaServerError) => {
    assert.equal(error.code, "rate-limited");
    assert.ok((error.retryAfterMs ?? 0) > 0, "the refusal carries a bounded wait");
    return true;
  });
});

test("a local refusal is never recorded as a provider failure", async () => {
  const index = new MediaServerIndex();
  class LocalError extends Error {}
  await assert.rejects(index.resolve(key(), { scan: () => Promise.reject(new LocalError("denied")) }), LocalError);
  // The next request scans again rather than inheriting a backoff it did not cause.
  let scans = 0;
  const page = await index.resolve(key(), { scan: () => { scans += 1; return Promise.resolve(ok([item("1")])); } });
  assert.equal(scans, 1);
  assert.equal(page.items.length, 1);
  await assert.rejects(index.resolve(key(), { cursorSnapshotId: "nope", scan: () => Promise.reject(new Error("unused")) }), { code: "stale-generation" });
});

test("a cursor names an exact snapshot and a replaced one is refused as stale", async () => {
  const time = clock();
  const index = new MediaServerIndex({ clock: time.now, ttlMs: 1 });
  const first = await index.resolve(key(), { scan: () => Promise.resolve(ok([item("1"), item("2")])) });
  const paged = await index.resolve(key(), { cursorSnapshotId: first.id, scan: () => Promise.reject(new Error("must not scan")) });
  assert.equal(paged.id, first.id);
  time.advance(10);
  const second = await index.resolve(key(), { scan: () => Promise.resolve(ok([item("3")])) });
  assert.notEqual(second.id, first.id);
  await assert.rejects(index.resolve(key(), { cursorSnapshotId: first.id, scan: () => Promise.reject(new Error("must not scan")) }), { code: "stale-generation" });
});

test("an invalidation discards the snapshot and a staged scan, even one the provider keeps running", async () => {
  const index = new MediaServerIndex();
  const staged = deferred();
  const running = index.resolve(key(), { scan: () => staged.promise });
  index.invalidateConnection("mconn_00000000000000000000000000000001");
  staged.resolve(ok([item("1")]));
  await assert.rejects(running, { code: "stale-generation" }, "a provider that ignores the abort still publishes nothing");

  const after = await index.resolve(key(), { scan: () => Promise.resolve(ok([item("2")])) });
  assert.deepEqual(after.items.map((entry) => entry.id), ["2"], "the slot was released for a fresh scan");
});

test("invalidating one library aborts only its staged scan", async () => {
  const index = new MediaServerIndex();
  const other = deferred();
  const held = deferred();
  const second = index.resolve(key({ libraryId: "rlib_00000000000000000000000000000002" }), { scan: () => other.promise });
  const first = index.resolve(key(), { scan: () => held.promise });
  index.invalidateLibrary("rlib_00000000000000000000000000000001");
  held.resolve(ok([item("ignored")]));
  await assert.rejects(first, { code: "stale-generation" });
  other.resolve(ok([item("2")]));
  assert.deepEqual((await second).items.map((entry) => entry.id), ["2"]);
});

test("concurrent scans are bounded and the same library never scans twice", async () => {
  const index = new MediaServerIndex({ maxConcurrentScans: 2 });
  const a = deferred();
  const b = deferred();
  const first = index.resolve(key(), { scan: () => a.promise });
  const second = index.resolve(key({ libraryId: "rlib_00000000000000000000000000000002" }), { scan: () => b.promise });
  await assert.rejects(index.resolve(key({ libraryId: "rlib_00000000000000000000000000000003" }), { scan: () => Promise.resolve(ok([])) }), { code: "busy" });
  await assert.rejects(index.resolve(key(), { scan: () => Promise.resolve(ok([])) }), { code: "busy" }, "the same library is already scanning");
  a.resolve(ok([item("1")]));
  b.resolve(ok([item("2")]));
  await first;
  await second;
});

test("an over-cap snapshot is refused whole and the previous one is reachable only by its cursor", async () => {
  const time = clock();
  const index = new MediaServerIndex({ clock: time.now, ttlMs: 1, maxItemsPerLibrary: 2, retryBaseMs: 5_000 });
  const first = await index.resolve(key(), { scan: () => Promise.resolve(ok([item("1")])) });
  time.advance(10);
  await assert.rejects(index.resolve(key(), { scan: () => Promise.resolve(ok([item("1"), item("2"), item("3")])) }), { code: "response-too-large" });
  await assert.rejects(index.resolve(key(), { scan: () => Promise.resolve(ok([item("1")])) }), { code: "response-too-large" }, "the failure backs off");
  const retained = await index.resolve(key(), { cursorSnapshotId: first.id, scan: () => Promise.reject(new Error("unused")) });
  assert.equal(retained.id, first.id);
});

test("the aggregate byte cap refuses one snapshot that alone exceeds it", async () => {
  const index = new MediaServerIndex({ maxBytesTotal: 200, maxBytesPerLibrary: 1024 });
  await assert.rejects(index.resolve(key(), { scan: () => Promise.resolve(ok([item("1", { name: "x".repeat(500) })])) }), { code: "response-too-large" });
});

test("never-published failures are dropped with their connection and do not block a repaired one", async () => {
  const index = new MediaServerIndex({ retryBaseMs: 60_000 });
  await assert.rejects(index.resolve(key(), { scan: () => Promise.reject(new MediaServerError("unavailable", "down")) }), { code: "unavailable" });
  // Still inside the backoff for the same key.
  await assert.rejects(index.resolve(key(), { scan: () => Promise.reject(new MediaServerError("unavailable", "down")) }), { code: "unavailable" });
  index.invalidateConnection("mconn_00000000000000000000000000000001");
  const repaired = await index.resolve(key({ generation: 1 }), { scan: () => Promise.resolve(ok([item("1")])) });
  assert.deepEqual(repaired.items.map((entry) => entry.id), ["1"]);
});

test("failure records stay bounded so an old one cannot hold back a repair", async () => {
  const index = new MediaServerIndex({ retryBaseMs: 60_000, maxFailures: 2 });
  const library = (n: number) => `rlib_0000000000000000000000000000000${n}`;
  for (const n of [1, 2, 3]) {
    await assert.rejects(index.resolve(key({ libraryId: library(n) }), { scan: () => Promise.reject(new MediaServerError("unavailable", "down")) }), { code: "unavailable" });
  }
  let scans = 0;
  const page = await index.resolve(key({ libraryId: library(1) }), { scan: () => { scans += 1; return Promise.resolve(ok([item("1")])); } });
  assert.equal(scans, 1, "the oldest failure record was evicted and the library scans again");
  assert.equal(page.items.length, 1);
});

test("the snapshot count is bounded and a read hit refreshes recency", async () => {
  const index = new MediaServerIndex({ maxSnapshots: 2 });
  const scanFor = (id: string) => () => Promise.resolve(ok([item(id)]));
  const library = (n: number) => `rlib_0000000000000000000000000000000${n}`;
  const one = await index.resolve(key({ libraryId: library(1) }), { scan: scanFor("1") });
  await index.resolve(key({ libraryId: library(2) }), { scan: scanFor("2") });
  // Reading the oldest moves it to the front, so writing a third evicts the second instead.
  await index.resolve(key({ libraryId: library(1) }), { scan: scanFor("ignored") });
  await index.resolve(key({ libraryId: library(3) }), { scan: scanFor("3") });
  const retained = await index.resolve(key({ libraryId: library(1) }), { cursorSnapshotId: one.id, scan: () => Promise.reject(new Error("unused")) });
  assert.equal(retained.id, one.id);
  await assert.rejects(index.resolve(key({ libraryId: library(2) }), { cursorSnapshotId: "anything", scan: () => Promise.reject(new Error("unused")) }), { code: "stale-generation" }, "the least recently read snapshot was evicted");
});

test("close aborts a staged scan and refuses further work", async () => {
  const index = new MediaServerIndex();
  const staged = deferred();
  const running = index.resolve(key(), { scan: () => staged.promise });
  await index.close();
  staged.reject(new MediaServerError("cancelled", "stopped"));
  await assert.rejects(running, { code: "closed" }, "a scan cancelled by the shutdown reports the shutdown");
  await assert.rejects(index.resolve(key(), { scan: () => Promise.resolve(ok([])) }), { code: "closed" });
});
