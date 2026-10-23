import assert from "node:assert/strict";
import test from "node:test";
import { DetailGalleryCache } from "./detail-gallery.js";
import type { TmdbGalleryPicture } from "./tmdb.js";

const picture = (name: string): TmdbGalleryPicture => ({
  url: `https://image.tmdb.org/t/p/w500/${name}.jpg`,
  kind: "poster",
});

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

test("gallery waiters share a flight, and one leaving does not abort the other", async () => {
  const entered = deferred();
  const answer = deferred<TmdbGalleryPicture[]>();
  const transport: AbortSignal[] = [];
  let calls = 0;
  const cache = new DetailGalleryCache(async (_type, _id, _config, signal) => {
    calls += 1;
    transport.push(signal);
    entered.resolve();
    return answer.promise;
  });
  const leaving = new AbortController();

  const first = cache.get("movie", "tt0090257", "cs", "key", leaving.signal);
  const second = cache.get("movie", "tt0090257", "cs", "key");
  await entered.promise;
  assert.notEqual(transport[0], leaving.signal, "the shared flight owns its upstream signal");
  leaving.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(transport[0]!.aborted, false);

  answer.resolve([picture("poster")]);
  assert.deepEqual(await second, [picture("poster")]);
  assert.deepEqual(await cache.get("movie", "tt0090257", "cs", "key"), [picture("poster")]);
  assert.equal(calls, 1);
});

test("the last gallery waiter aborts, caches nothing, and a retry starts a new flight", async () => {
  const started = deferred();
  const transport: AbortSignal[] = [];
  let calls = 0;
  const cache = new DetailGalleryCache(async (_type, _id, _config, signal) => {
    calls += 1;
    transport.push(signal);
    if (calls === 1) {
      started.resolve();
      return new Promise<TmdbGalleryPicture[]>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return [picture("retry")];
  });
  const firstController = new AbortController();
  const secondController = new AbortController();

  const first = cache.get("movie", "tt0090257", "cs", "key", firstController.signal);
  const second = cache.get("movie", "tt0090257", "cs", "key", secondController.signal);
  await started.promise;
  firstController.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(transport[0]!.aborted, false);

  secondController.abort();
  await assert.rejects(second, { name: "AbortError" });
  assert.equal(transport[0]!.aborted, true);

  assert.deepEqual(await cache.get("movie", "tt0090257", "cs", "key"), [picture("retry")]);
  assert.equal(calls, 2, "the retry does not join the abandoned flight");
});

test("a successful empty gallery is cached for thirty minutes", async () => {
  let now = 1_000;
  let calls = 0;
  const cache = new DetailGalleryCache(async () => {
    calls += 1;
    return [];
  }, { now: () => now });

  assert.deepEqual(await cache.get("movie", "tmdb:31410", "en", "key"), []);
  assert.deepEqual(await cache.get("movie", "tmdb:31410", "en", "key"), []);
  assert.equal(calls, 1);

  now += 30 * 60_000 - 1;
  assert.deepEqual(await cache.get("movie", "tmdb:31410", "en", "key"), []);
  assert.equal(calls, 1);

  now += 1;
  assert.deepEqual(await cache.get("movie", "tmdb:31410", "en", "key"), []);
  assert.equal(calls, 2);
});

test("gallery entries are isolated by type, id, language and API key", async () => {
  const calls: string[] = [];
  const cache = new DetailGalleryCache(async (type, id, config) => {
    calls.push(`${type}:${id}:${config.language}:${config.apiKey}`);
    return [];
  });

  await cache.get("movie", "tt0090257", "cs", "key-a");
  await cache.get("series", "tt0090257", "cs", "key-a");
  await cache.get("movie", "tt0090258", "cs", "key-a");
  await cache.get("movie", "tt0090257", "en", "key-a");
  await cache.get("movie", "tt0090257", "cs", "key-b");

  assert.deepEqual(calls, [
    "movie:tt0090257:cs:key-a",
    "series:tt0090257:cs:key-a",
    "movie:tt0090258:cs:key-a",
    "movie:tt0090257:en:key-a",
    "movie:tt0090257:cs:key-b",
  ]);
});

test("the gallery cache is bounded and evicts the oldest successful entry", async () => {
  let calls = 0;
  const cache = new DetailGalleryCache(async () => {
    calls += 1;
    return [];
  }, { maxEntries: 2 });

  await cache.get("movie", "tmdb:1", "en", "key");
  await cache.get("movie", "tmdb:2", "en", "key");
  await cache.get("movie", "tmdb:3", "en", "key");
  await cache.get("movie", "tmdb:1", "en", "key");
  await cache.get("movie", "tmdb:3", "en", "key");

  assert.equal(calls, 4);
});

test("no key or an unusable gallery target answers empty without loading", async () => {
  let calls = 0;
  const cache = new DetailGalleryCache(async () => {
    calls += 1;
    return [];
  });

  assert.deepEqual(await cache.get("movie", "tt0090257", "cs", ""), []);
  assert.deepEqual(await cache.get("episode", "tt0090257", "cs", "key"), []);
  assert.deepEqual(await cache.get("movie", "some-id", "cs", "key"), []);
  assert.equal(calls, 0);
});
