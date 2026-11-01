import assert from "node:assert/strict";
import test from "node:test";
import { IntroSegmentsCache, segmentsFromIntroDb, type IntroQuery } from "./intro-segments.js";

const FILM: IntroQuery = { imdbId: "tt0903747" };

test("IntroDB segments are read from seconds and malformed fields are ignored", () => {
  assert.deepEqual(segmentsFromIntroDb({
    intro: { start_sec: 2.5, end_sec: 58, confidence: 0.9 },
    recap: null,
    outro: { start_sec: 3_000, end_sec: 3_090 },
    post_credits: { start_sec: 10, end_sec: 5 },
    no_intro: true,
  }), {
    intro: { start: 2.5, end: 58 },
    outro: { start: 3_000, end: 3_090 },
  });
});

test("concurrent reads for one title share a single IntroDB fetch", async () => {
  let calls = 0;
  let release!: (value: { intro: { start: number; end: number } }) => void;
  const fetcher = () => {
    calls += 1;
    return new Promise<{ intro: { start: number; end: number } }>((resolve) => { release = resolve; });
  };
  const cache = new IntroSegmentsCache({ fetcher });

  const first = cache.get(FILM);
  const second = cache.get(FILM);
  release({ intro: { start: 10, end: 40 } });

  assert.deepEqual(await Promise.all([first, second]), [
    { intro: { start: 10, end: 40 } },
    { intro: { start: 10, end: 40 } },
  ]);
  assert.equal(calls, 1);
});

test("found segments stay cached for 24 hours and then refresh", async () => {
  let now = 0;
  let calls = 0;
  const cache = new IntroSegmentsCache({
    now: () => now,
    fetcher: async () => ({ intro: { start: ++calls, end: calls + 10 } }),
  });

  assert.deepEqual(await cache.get(FILM), { intro: { start: 1, end: 11 } });
  now = 24 * 60 * 60_000 - 1;
  assert.deepEqual(await cache.get(FILM), { intro: { start: 1, end: 11 } });
  now += 1;
  assert.deepEqual(await cache.get(FILM), { intro: { start: 2, end: 12 } });
  assert.equal(calls, 2);
});

test("an absent title answers an empty result and is cached", async () => {
  let calls = 0;
  const cache = new IntroSegmentsCache({ fetcher: async () => { calls += 1; return "absent"; } });

  assert.deepEqual(await cache.get(FILM), {});
  assert.deepEqual(await cache.get(FILM), {});
  assert.equal(calls, 1);
});

test("a failed lookup answers empty and retries only after ten minutes", async () => {
  let now = 0;
  let calls = 0;
  const cache = new IntroSegmentsCache({
    now: () => now,
    fetcher: async () => { calls += 1; throw new Error("IntroDB is down"); },
  });

  assert.deepEqual(await cache.get(FILM), {});
  now = 10 * 60_000 - 1;
  assert.deepEqual(await cache.get(FILM), {});
  assert.equal(calls, 1);
  now += 1;
  assert.deepEqual(await cache.get(FILM), {});
  assert.equal(calls, 2);
});

test("the cache evicts the entry inserted first when it is full", async () => {
  const calls = new Map<string, number>();
  const cache = new IntroSegmentsCache({
    maxEntries: 2,
    fetcher: async (query) => {
      const count = (calls.get(query.imdbId) ?? 0) + 1;
      calls.set(query.imdbId, count);
      return { intro: { start: count, end: count + 10 } };
    },
  });
  const first = { imdbId: "tt00001" };
  const second = { imdbId: "tt00002" };
  const third = { imdbId: "tt00003" };

  await cache.get(first);
  await cache.get(second);
  await cache.get(third);
  await cache.get(first);

  assert.equal(calls.get(first.imdbId), 2);
  assert.equal(calls.get(second.imdbId), 1);
  assert.equal(calls.get(third.imdbId), 1);
});
