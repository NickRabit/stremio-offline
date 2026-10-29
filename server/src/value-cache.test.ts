import assert from "node:assert/strict";
import { test } from "node:test";
import { FreshValueCache } from "./value-cache.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

test("a value is reused until its bounded freshness expires", async () => {
  let now = 1000;
  let loads = 0;
  const cache = new FreshValueCache<string | undefined>(30_000, { now: () => now });
  const load = async () => {
    loads += 1;
    return loads === 1 ? "artwork.jpg" : undefined;
  };

  assert.equal(await cache.get("target", load), "artwork.jpg");
  now += 29_999;
  assert.equal(await cache.get("target", load), "artwork.jpg");
  assert.equal(loads, 1);
  now += 1;
  assert.equal(await cache.get("target", load), undefined);
  assert.equal(loads, 2, "a stale value is discovered again");
});

test("concurrent misses share their lookup, including one that finds nothing", async () => {
  const gate = deferred<string | undefined>();
  let loads = 0;
  const cache = new FreshValueCache<string | undefined>(30_000);
  const load = () => {
    loads += 1;
    return gate.promise;
  };

  const first = cache.get("missing", load);
  const second = cache.get("missing", load);
  assert.equal(first, second);
  gate.resolve(undefined);
  assert.equal(await first, undefined);
  assert.equal(await cache.get("missing", load), undefined);
  assert.equal(loads, 1, "the negative result is held as well");
});

test("clearing the cache prevents a lookup in flight from being kept", async () => {
  const firstLoad = deferred<string>();
  let loads = 0;
  const cache = new FreshValueCache<string>(60_000);
  const first = cache.get("target", () => {
    loads += 1;
    return firstLoad.promise;
  });
  cache.clear();
  const second = cache.get("target", async () => {
    loads += 1;
    return "new";
  });
  assert.equal(await second, "new");
  firstLoad.resolve("old");
  assert.equal(await first, "old");
  assert.equal(await cache.get("target", async () => "later"), "new");
  assert.equal(loads, 2);
});

test("the cache has a bound when many distinct targets are polled", async () => {
  const cache = new FreshValueCache<string>(60_000, { maxEntries: 2 });
  await cache.get("one", async () => "1");
  await cache.get("two", async () => "2");
  await cache.get("three", async () => "3");
  let loads = 0;
  await cache.get("one", async () => { loads += 1; return "again"; });
  assert.equal(loads, 1, "the oldest settled entry is dropped");
});

test("a lookup that stops responding is released after a bounded wait", async () => {
  let loads = 0;
  const result = deferred<string | undefined>();
  const cache = new FreshValueCache<string | undefined>(60_000, {
    lookupTimeoutMs: 5,
    timeoutResult: () => undefined,
    now: () => 0,
  });
  const load = () => {
    loads += 1;
    return result.promise;
  };
  const started = Date.now();
  assert.equal(await cache.get("dead-mount", load), undefined);
  assert.ok(Date.now() - started >= 4, "the request is not held indefinitely");
  assert.equal(await cache.get("dead-mount", load), undefined, "later polls reuse the timed-out result");
  assert.equal(loads, 1, "a dead mount does not start one lookup per poll");
  result.resolve("recovered");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await cache.get("dead-mount", load), "recovered", "a late answer replaces the fallback");
  assert.equal(loads, 1);
});
