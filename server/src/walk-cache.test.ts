import assert from "node:assert/strict";
import { test } from "node:test";
import { WalkCache } from "./walk-cache.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

test("callers asking at the same moment share one walk", async () => {
  let walks = 0;
  const cache = new WalkCache(async () => { walks += 1; return walks; }, 30_000);
  const answers = await Promise.all([cache.get(), cache.get(), cache.get({ stale: true })]);
  assert.deepEqual(answers, [1, 1, 1]);
  assert.equal(walks, 1);
});

test("a fresh value is served without walking again", async () => {
  let clock = 0;
  let walks = 0;
  const cache = new WalkCache(async () => ++walks, 30_000, () => clock);
  await cache.get();
  clock = 29_999;
  assert.equal(await cache.get(), 1);
  assert.equal(walks, 1);
});

test("an expired value is served to a view while the next walk runs behind it", async () => {
  let clock = 0;
  let walks = 0;
  const next = deferred<number>();
  const cache = new WalkCache(() => (++walks === 1 ? Promise.resolve(1) : next.promise), 30_000, () => clock);
  await cache.get();
  clock = 31_000;
  assert.equal(await cache.get({ stale: true }), 1);
  assert.equal(walks, 2);
  // A caller that acts on the answer waits for the walk already running rather than starting another.
  const current = cache.get();
  next.resolve(2);
  assert.equal(await current, 2);
  assert.equal(walks, 2);
  assert.equal(await cache.get({ stale: true }), 2);
});

test("an expired value is not handed to a caller that needs a current one", async () => {
  let clock = 0;
  let walks = 0;
  const cache = new WalkCache(async () => ++walks, 30_000, () => clock);
  await cache.get();
  clock = 31_000;
  assert.equal(await cache.get(), 2);
});

test("an invalidated value is never served, not even to a view", async () => {
  let walks = 0;
  const cache = new WalkCache(async () => ++walks, 30_000);
  await cache.get();
  cache.invalidate();
  assert.equal(await cache.get({ stale: true }), 2);
});

test("a walk that was running when the value was invalidated is not kept", async () => {
  let walks = 0;
  const first = deferred<string>();
  const cache = new WalkCache(() => (++walks === 1 ? first.promise : Promise.resolve("after")), 30_000);
  const early = cache.get();
  cache.invalidate();
  const late = cache.get();
  first.resolve("before");
  assert.equal(await early, "before");
  assert.equal(await late, "after");
  assert.equal(await cache.get(), "after");
  assert.equal(walks, 2);
});

test("a failed walk is not cached and the next caller tries again", async () => {
  let walks = 0;
  const cache = new WalkCache(async () => { walks += 1; if (walks === 1) throw new Error("mount away"); return walks; }, 30_000);
  await assert.rejects(cache.get(), /mount away/);
  assert.equal(await cache.get(), 2);
});
