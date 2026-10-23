import assert from "node:assert/strict";
import test from "node:test";
import { clearTrailerCache, cinemetaTrailer, trailerFor } from "./trailers.js";
import { defaultDownloadSettings } from "./naming.js";
import { outbound, OutboundError } from "./outbound.js";
import { setFetchTransport } from "./security.js";
import type { AddonRecord } from "./types.js";

const cinemeta = (): AddonRecord => ({
  key: "cinemeta", manifestUrl: "https://cinemeta.example/manifest.json", role: "catalog", enabled: true, globalSearch: true,
  addedAt: "2026-01-01T00:00:00.000Z", downloadSettings: defaultDownloadSettings(),
  manifest: { id: "com.linvo.cinemeta", name: "Cinemeta", version: "1", resources: ["meta"] },
});

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

async function withFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>, run: () => Promise<void>) {
  const allow = process.env.ALLOW_PRIVATE_ADDONS;
  process.env.ALLOW_PRIVATE_ADDONS = "1";
  setFetchTransport(async (url, init) => handler(String(url), init));
  try { await run(); }
  finally {
    setFetchTransport();
    if (allow === undefined) delete process.env.ALLOW_PRIVATE_ADDONS;
    else process.env.ALLOW_PRIVATE_ADDONS = allow;
  }
}

const prompt = async <T>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not happen promptly`)), 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const heldBody = () => {
  let activate!: () => void;
  let started!: () => void;
  let cancelled!: () => void;
  const activated = new Promise<void>((resolve) => { activate = resolve; });
  const readStarted = new Promise<void>((resolve) => { started = resolve; });
  const bodyCancelled = new Promise<void>((resolve) => { cancelled = resolve; });
  const response = new Response(new ReadableStream<Uint8Array>({
    async pull() {
      await activated;
      started();
      return new Promise<void>(() => undefined);
    },
    cancel() {
      cancelled();
    },
  }), { headers: { "content-type": "application/json" } });
  return { response, readStarted, bodyCancelled, activate };
};

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
  const signal = new AbortController().signal;
  await withFetch((url) => {
    if (url.includes("cinemeta.example")) throw new Error("cinemeta is down");
    if (url.includes("/find/")) return json({ movie_results: [{ id: 12 }], tv_results: [] });
    return json({ results: [{ key: "ccccccccccc", site: "YouTube", type: "Trailer" }] });
  }, async () => {
    assert.deepEqual(await trailerFor([cinemeta()], "movie", "tt1", "en", { apiKey: "key", language: "en" }, signal), {
      youtubeId: "ccccccccccc", provider: "tmdb",
    });
  });
});

test("cancelling Cinemeta does not try TMDB or cache either answer", async () => {
  clearTrailerCache();
  const held = heldBody();
  const controller = new AbortController();
  let cinemetaCalls = 0;
  let tmdbCalls = 0;
  let transportSignal: AbortSignal | undefined;
  let requestStarted!: () => void;
  const requestStartedSignal = new Promise<void>((resolve) => { requestStarted = resolve; });

  await withFetch((url, init) => {
    const host = new URL(url).hostname;
    if (host === "cinemeta.example") {
      cinemetaCalls += 1;
      if (cinemetaCalls === 1) {
        transportSignal = init.signal as AbortSignal;
        requestStarted();
        return held.response;
      }
      return json({ meta: { trailers: [{ source: "ddddddddddd", type: "Trailer" }] } });
    }
    tmdbCalls += 1;
    return json({ movie_results: [{ id: 12 }], tv_results: [], results: [{ key: "eeeeeeeeeee", site: "YouTube", type: "Trailer" }] });
  }, async () => {
    const cancelled = trailerFor([cinemeta()], "movie", "tt1", "en", { apiKey: "key", language: "en" }, controller.signal);
    await prompt(requestStartedSignal, "the Cinemeta request");
    held.activate();
    await prompt(held.readStarted, "the Cinemeta body read");
    controller.abort();

    await assert.rejects(cancelled, (error: unknown) => error instanceof OutboundError && error.code === "cancelled");
    await prompt(new Promise<void>((resolve) => {
      if (transportSignal?.aborted) resolve();
      else transportSignal?.addEventListener("abort", () => resolve(), { once: true });
    }), "the Cinemeta signal abort");
    await prompt(held.bodyCancelled, "the Cinemeta body cancel");
    assert.equal(tmdbCalls, 0, "a cancelled Cinemeta lookup does not fall through");

    assert.deepEqual(await trailerFor([cinemeta()], "movie", "tt1", "en", { apiKey: "key", language: "en" }), {
      youtubeId: "ddddddddddd", provider: "cinemeta",
    });
    assert.equal(cinemetaCalls, 2, "the cancelled answer was not cached");
    assert.deepEqual(await trailerFor([cinemeta()], "movie", "tt1", "en", { apiKey: "key", language: "en" }), {
      youtubeId: "ddddddddddd", provider: "cinemeta",
    });
    assert.equal(cinemetaCalls, 2, "the successful retry is cached");
    assert.equal(tmdbCalls, 0);
  });

  assert.equal(outbound.diagnostics().find((entry) => entry.host === "cinemeta.example")?.failures ?? 0, 0);
});

test("a cancelled trailer lookup cannot overwrite a concurrent successful answer", async () => {
  clearTrailerCache();
  const held = heldBody();
  const controller = new AbortController();
  let calls = 0;

  await withFetch(() => {
    calls += 1;
    return calls === 1
      ? held.response
      : json({ meta: { trailers: [{ source: "fffffffffff", type: "Trailer" }] } });
  }, async () => {
    const cancelled = trailerFor([cinemeta()], "movie", "tt1", "en", undefined, controller.signal);
    const successful = await trailerFor([cinemeta()], "movie", "tt1", "en");
    assert.deepEqual(successful, { youtubeId: "fffffffffff", provider: "cinemeta" });

    controller.abort();
    await assert.rejects(cancelled, (error: unknown) => error instanceof OutboundError && error.code === "cancelled");
    await prompt(held.bodyCancelled, "the cancelled concurrent body");

    assert.deepEqual(await trailerFor([cinemeta()], "movie", "tt1", "en"), successful);
    assert.equal(calls, 2, "the successful answer remains cached");
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
