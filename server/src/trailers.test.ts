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
