import assert from "node:assert/strict";
import { test } from "node:test";
import { createMetaCache } from "./meta-cache.js";

test("an answer is fresh within ttlMs and gone after it", () => {
  let at = 100;
  const cache = createMetaCache<{ title: string }>({
    ttlMs: 1_000,
    failureTtlMs: 500,
    limit: 10,
    now: () => at,
  });

  cache.set("movie:tt1", { title: "One" });
  assert.deepEqual(cache.get("movie:tt1"), { hit: true, value: { title: "One" } });

  at += 999;
  assert.deepEqual(cache.get("movie:tt1"), { hit: true, value: { title: "One" } });

  at += 1;
  assert.deepEqual(cache.get("movie:tt1"), { hit: false });
  assert.equal(cache.size, 0);
});

test("a failure is remembered within failureTtlMs, gone after it, and a later answer wins", () => {
  let at = 100;
  const cache = createMetaCache<string>({
    ttlMs: 1_000,
    failureTtlMs: 500,
    limit: 10,
    now: () => at,
  });

  cache.fail("movie:missing");
  assert.deepEqual(cache.get("movie:missing"), { hit: true, value: null });

  at += 499;
  assert.deepEqual(cache.get("movie:missing"), { hit: true, value: null });

  at += 1;
  assert.deepEqual(cache.get("movie:missing"), { hit: false });

  cache.fail("movie:recovered");
  cache.set("movie:recovered", "answer");
  assert.deepEqual(cache.get("movie:recovered"), { hit: true, value: "answer" });
});

test("the least recently used entry is evicted when the cache exceeds its limit", () => {
  const cache = createMetaCache<string>({
    ttlMs: 1_000,
    failureTtlMs: 500,
    limit: 3,
    now: () => 100,
  });

  cache.set("oldest", "one");
  cache.set("second", "two");
  cache.set("third", "three");
  assert.deepEqual(cache.get("oldest"), { hit: true, value: "one" });

  cache.set("fourth", "four");
  assert.equal(cache.size, 3);
  assert.deepEqual(cache.get("second"), { hit: false });
  assert.deepEqual(cache.get("oldest"), { hit: true, value: "one" });
  assert.deepEqual(cache.get("third"), { hit: true, value: "three" });
  assert.deepEqual(cache.get("fourth"), { hit: true, value: "four" });
});

test("clear empties the cache", () => {
  const cache = createMetaCache<string>({
    ttlMs: 1_000,
    failureTtlMs: 500,
    limit: 10,
    now: () => 100,
  });

  cache.set("answer", "value");
  cache.fail("failure");
  cache.clear();

  assert.equal(cache.size, 0);
  assert.deepEqual(cache.get("answer"), { hit: false });
  assert.deepEqual(cache.get("failure"), { hit: false });
});

test("callers asking for one key while it is looked up share that lookup", async () => {
  const cache = createMetaCache<string>({ ttlMs: 1_000, failureTtlMs: 500, limit: 10 });
  let started = 0;
  let finish!: (value: string) => void;
  const lookup = () => { started += 1; return new Promise<string | null>((resolve) => { finish = resolve; }); };

  const first = cache.join("movie:tt1", lookup);
  const second = cache.join("movie:tt1", lookup);
  assert.equal(started, 1);
  finish("One");
  assert.deepEqual(await Promise.all([first, second]), ["One", "One"]);

  // Once settled, the next caller starts a lookup of its own.
  const third = cache.join("movie:tt1", lookup);
  assert.equal(started, 2);
  finish("Again");
  assert.equal(await third, "Again");
});

test("a failed shared lookup is not kept for the next caller", async () => {
  const cache = createMetaCache<string>({ ttlMs: 1_000, failureTtlMs: 500, limit: 10 });
  await assert.rejects(cache.join("movie:tt1", () => Promise.reject(new Error("down"))));
  assert.equal(await cache.join("movie:tt1", () => Promise.resolve("up")), "up");
});
