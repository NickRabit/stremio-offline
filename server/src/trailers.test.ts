import assert from "node:assert/strict";
import test from "node:test";
import { clearTrailerCache, cinemetaTrailer, trailerFor } from "./trailers.js";
import { defaultDownloadSettings } from "./naming.js";
import type { AddonRecord } from "./types.js";

const cinemeta = (): AddonRecord => ({
  key: "cinemeta", manifestUrl: "https://cinemeta.example/manifest.json", role: "catalog", enabled: true, globalSearch: true,
  addedAt: "2026-01-01T00:00:00.000Z", downloadSettings: defaultDownloadSettings(),
  manifest: { id: "com.linvo.cinemeta", name: "Cinemeta", version: "1", resources: ["meta"] },
});

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

async function withFetch(handler: (url: string) => Response, run: () => Promise<void>) {
  const original = globalThis.fetch;
  const allow = process.env.ALLOW_PRIVATE_ADDONS;
  process.env.ALLOW_PRIVATE_ADDONS = "1";
  globalThis.fetch = (async (url: string | URL | Request) => handler(String(url))) as typeof fetch;
  try { await run(); }
  finally {
    globalThis.fetch = original;
    if (allow === undefined) delete process.env.ALLOW_PRIVATE_ADDONS;
    else process.env.ALLOW_PRIVATE_ADDONS = allow;
  }
}

test("Cinemeta trailer wins over TMDB", async () => {
  clearTrailerCache();
  await withFetch((url) => {
    if (url.includes("cinemeta.example")) return json({ meta: { trailers: [{ source: "aaaaaaaaaaa", type: "Trailer" }] } });
    throw new Error(`unexpected ${url}`);
  }, async () => {
    assert.deepEqual(await trailerFor([cinemeta()], "movie", "tt0090257", "cs", { apiKey: "key", language: "cs" }), {
      youtubeId: "aaaaaaaaaaa", provider: "cinemeta",
    });
  });
});

test("Cinemeta trailerStreams are accepted and malformed ids fall through to TMDB", async () => {
  assert.deepEqual(cinemetaTrailer({ id: "tt1", type: "movie", name: "One", trailerStreams: [{ ytId: "bbbbbbbbbbb", title: "Trailer" }] }), { youtubeId: "bbbbbbbbbbb", title: "Trailer" });
  clearTrailerCache();
  await withFetch((url) => {
    if (url.includes("cinemeta.example")) return json({ meta: { trailers: [{ source: "bad", type: "Trailer" }] } });
    if (url.includes("/find/")) return json({ movie_results: [{ id: 12 }], tv_results: [] });
    return json({ results: [{ key: "ccccccccccc", site: "YouTube", type: "Trailer" }] });
  }, async () => {
    assert.deepEqual(await trailerFor([cinemeta()], "movie", "tt1", "en", { apiKey: "key", language: "en" }), {
      youtubeId: "ccccccccccc", provider: "tmdb",
    });
  });
});

test("trailer cache remembers an empty answer", async () => {
  clearTrailerCache();
  let calls = 0;
  await withFetch(() => { calls += 1; return json({ meta: {} }); }, async () => {
    assert.equal(await trailerFor([cinemeta()], "movie", "tt1", "en"), null);
    assert.equal(await trailerFor([cinemeta()], "movie", "tt1", "en"), null);
  });
  assert.equal(calls, 1);
});

test("only a Trailer counts, whatever else Cinemeta sends", () => {
  assert.equal(cinemetaTrailer({ id: "tt1", type: "movie", name: "One", trailers: [{ source: "aaaaaaaaaaa", type: "Clip" }] }), null, "a clip is not a trailer");
  assert.equal(cinemetaTrailer({ id: "tt1", type: "movie", name: "One", trailers: ["aaaaaaaaaaa"] }), null, "an entry that is not an object is skipped");
  assert.equal(cinemetaTrailer({ id: "tt1", type: "movie", name: "One", trailers: [{ source: "short", type: "Trailer" }], trailerStreams: [{ ytId: "not an id" }] }), null);
  assert.deepEqual(
    cinemetaTrailer({ id: "tt1", type: "movie", name: "One", trailers: [{ source: "aaaaaaaaaaa", type: "Clip" }], trailerStreams: [{ ytId: "bbbbbbbbbbb", title: "Trailer" }] }),
    { youtubeId: "bbbbbbbbbbb", title: "Trailer" }, "a clip still leaves the trailer stream usable");
});

test("a title or an addon Cinemeta cannot answer for asks nobody", async () => {
  clearTrailerCache();
  let calls = 0;
  await withFetch(() => { calls += 1; return json({ meta: {} }); }, async () => {
    assert.equal(await trailerFor([cinemeta()], "person", "tt1", "en", { apiKey: "key", language: "en" }), null, "only films and series have trailers");
    assert.equal(await trailerFor([{ ...cinemeta(), enabled: false }], "movie", "tt1", "en"), null, "a switched-off Cinemeta is left alone");
    assert.equal(await trailerFor([{ ...cinemeta(), manifest: { ...cinemeta().manifest, idPrefixes: ["tt99"] } }], "movie", "tt1", "en"), null, "an id outside its prefixes is not its business");
    assert.equal(await trailerFor([], "movie", "tt1", "en"), null, "no Cinemeta at all");
  });
  assert.equal(calls, 0);
});

test("TMDB is asked only when a key is configured", async () => {
  clearTrailerCache();
  const calls: string[] = [];
  await withFetch((url) => { calls.push(url); return json({ meta: {} }); }, async () => {
    assert.equal(await trailerFor([cinemeta()], "movie", "tt1", "en"), null, "no key, no fallback");
  });
  assert.equal(calls.length, 1);
  assert.ok(calls.every((url) => url.includes("cinemeta.example")), `TMDB was never asked: ${calls.join(", ")}`);
});

test("an unreachable Cinemeta falls through to TMDB rather than throwing", async () => {
  clearTrailerCache();
  await withFetch((url) => {
    if (url.includes("cinemeta.example")) throw new Error("cinemeta is down");
    if (url.includes("/find/")) return json({ movie_results: [{ id: 12 }], tv_results: [] });
    return json({ results: [{ key: "ccccccccccc", site: "YouTube", type: "Trailer" }] });
  }, async () => {
    assert.deepEqual(await trailerFor([cinemeta()], "movie", "tt1", "en", { apiKey: "key", language: "en" }), {
      youtubeId: "ccccccccccc", provider: "tmdb",
    });
  });
});

test("a cached trailer is answered without asking again, and clearing starts over", async () => {
  clearTrailerCache();
  let calls = 0;
  await withFetch(() => { calls += 1; return json({ meta: { trailers: [{ source: "aaaaaaaaaaa", type: "Trailer" }] } }); }, async () => {
    const first = await trailerFor([cinemeta()], "movie", "tt1", "en");
    assert.deepEqual(await trailerFor([cinemeta()], "movie", "tt1", "en"), first);
    assert.equal(calls, 1, "the second lookup never left the process");
    clearTrailerCache();
    assert.deepEqual(await trailerFor([cinemeta()], "movie", "tt1", "en"), first);
    assert.equal(calls, 2, "a cleared cache asks again, which is what a new key or language needs");
  });
});
