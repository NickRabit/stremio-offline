import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FetchLike } from "./debrid.js";

process.env.WIKIDATA_GUARD = "0";
const { ExternalIdStore, siteLinks } = await import("./external-ids.js");
type ExternalIds = import("./external-ids.js").ExternalIds;

const bindings = (rows: Array<Record<string, { value: string }>>) =>
  new Response(JSON.stringify({ results: { bindings: rows } }), { status: 200, headers: { "content-type": "application/sparql-results+json" } });

const chunkedBody = (chunkBytes: number, plannedChunks: number) => {
  let pulled = 0;
  let cancelled = false;
  const chunk = new Uint8Array(chunkBytes);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= plannedChunks) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, pulled: () => pulled, cancelled: () => cancelled };
};

const tempDir = () => mkdtemp(path.join(os.tmpdir(), "external-ids-"));

const cacheFile = (dir: string) => path.join(dir, "external-ids.json");

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 250;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return condition();
};

const heldBody = () => {
  const reading = deferred();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() {
      reading.resolve();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, reading: reading.promise, cancelled: () => cancelled };
};

test("the query carries the format, the escaped SPARQL with the id and a descriptive agent", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return bindings([{ csfd: { value: "6672" }, tmdbMovie: { value: "31410" } }]);
  };
  const store = new ExternalIdStore(dir, fetchImpl);
  await store.load();

  await store.ids("tt0090257");

  assert.equal(calls.length, 1);
  const called = calls[0]!;
  const url = new URL(called.url);
  assert.equal(url.origin + url.pathname, "https://query.wikidata.org/sparql");
  assert.equal(url.searchParams.get("format"), "json");
  const query = url.searchParams.get("query") ?? "";
  assert.match(query, /wdt:P345 "tt0090257"/);
  assert.match(query, /wdt:P2529 \?csfd/);
  assert.match(query, /wdt:P4947 \?tmdbMovie/);
  assert.match(query, /wdt:P4983 \?tmdbTv/);
  assert.match(query, /LIMIT 1/);
  // The id reaches the query escaped, so nothing else can slip into the SPARQL string.
  assert.match(called.url, /%22tt0090257%22/);
  const headers = called.init?.headers as Record<string, string>;
  assert.equal(headers["user-agent"], "StremioOffline (+https://github.com/NickRabit/stremio-offline)");
  assert.equal(headers.accept, "application/sparql-results+json");
});

test("a movie answer maps to the film ids and a series answer to the TV id", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fetchImpl: FetchLike = async () => bindings([{ csfd: { value: "6672" }, tmdbMovie: { value: "31410" } }]);
  const store = new ExternalIdStore(dir, fetchImpl);
  await store.load();

  assert.deepEqual(await store.ids("tt0090257"), { csfd: "6672", tmdbMovie: "31410" });

  const seriesDir = await tempDir();
  t.after(() => rm(seriesDir, { recursive: true, force: true }));
  const seriesStore = new ExternalIdStore(seriesDir, async () => bindings([{ tmdbTv: { value: "1396" } }]));
  await seriesStore.load();

  assert.deepEqual(await seriesStore.ids("tt0903747"), { tmdbTv: "1396" });
});

test("a second lookup of the same id asks Wikidata nothing", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const store = new ExternalIdStore(dir, async () => { calls += 1; return bindings([{ tmdbMovie: { value: "31410" } }]); });
  await store.load();

  await store.ids("tt0090257");
  await store.ids("tt0090257");

  assert.equal(calls, 1);
});

test("two concurrent lookups of one id share a single query", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const store = new ExternalIdStore(dir, async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return bindings([{ tmdbMovie: { value: "31410" } }]);
  });
  await store.load();

  const [first, second] = await Promise.all([store.ids("tt0090257"), store.ids("tt0090257")]);

  assert.equal(calls, 1);
  assert.deepEqual(first, { tmdbMovie: "31410" });
  assert.deepEqual(second, first);
  // One query means one save: the write sits inside the promise both callers await.
  const written = JSON.parse(await readFile(cacheFile(dir), "utf8")) as { entries: Record<string, unknown> };
  assert.deepEqual(Object.keys(written.entries), ["tt0090257"]);
});

test("one caller leaving keeps the shared query and its remaining caller alive", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entered = deferred();
  const answer = deferred<Response>();
  let calls = 0;
  let transport: AbortSignal | undefined;
  const store = new ExternalIdStore(dir, async (_url, init) => {
    calls += 1;
    transport = init?.signal ?? undefined;
    entered.resolve();
    return answer.promise;
  });
  await store.load();
  const leaving = new AbortController();

  const first = store.ids("tt0090257", leaving.signal);
  const second = store.ids("tt0090257");
  await entered.promise;
  leaving.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(transport?.aborted, false, "the remaining caller keeps the transport alive");

  answer.resolve(bindings([{ tmdbMovie: { value: "31410" } }]));
  assert.deepEqual(await second, { tmdbMovie: "31410" });
  assert.equal(calls, 1);
  assert.equal(store.cachedIds("tt0090257")?.tmdbMovie, "31410");
});

test("the last caller leaving cancels the body, writes nothing, and a retry asks again", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = heldBody();
  let calls = 0;
  let transport: AbortSignal | undefined;
  const store = new ExternalIdStore(dir, async (_url, init) => {
    calls += 1;
    transport = init?.signal ?? undefined;
    return calls === 1 ? new Response(source.body) : bindings([]);
  });
  await store.load();
  const first = new AbortController();
  const second = new AbortController();

  const abandoned = store.ids("tt0090257", first.signal);
  const alsoAbandoned = store.ids("tt0090257", second.signal);
  await source.reading;
  assert.equal(await until(() => source.body.locked), true);
  first.abort();
  second.abort();
  await assert.rejects(abandoned, { name: "AbortError" });
  await assert.rejects(alsoAbandoned, { name: "AbortError" });

  assert.equal(transport?.aborted, true);
  assert.equal(store.cachedIds("tt0090257"), undefined);
  await assert.rejects(readFile(cacheFile(dir), "utf8"));

  const retry = store.ids("tt0090257");
  assert.equal(calls, 2, "the retry starts a new query instead of joining the abandoned one");
  assert.deepEqual(await retry, {});
  assert.equal(await until(source.cancelled), true);
  const written = JSON.parse(await readFile(cacheFile(dir), "utf8")) as { entries: Record<string, unknown> };
  assert.deepEqual(Object.keys(written.entries), ["tt0090257"]);
});

test("a caller without a signal keeps a shared lookup alive after the first caller leaves", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entered = deferred();
  const answer = deferred<Response>();
  let cancelling: AbortSignal | undefined;
  const store = new ExternalIdStore(dir, async (_url, init) => {
    cancelling = init?.signal ?? undefined;
    entered.resolve();
    return answer.promise;
  });
  await store.load();
  const leaving = new AbortController();

  const first = store.ids("tt0090257", leaving.signal);
  const background = store.ids("tt0090257");
  await entered.promise;
  leaving.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(cancelling?.aborted, false);

  answer.resolve(bindings([]));
  assert.deepEqual(await background, {});
  assert.deepEqual(await store.ids("tt0090257"), {});
  assert.equal(cancelling?.aborted, false);
});

test("a lookup that throws answers null and writes no cache file", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExternalIdStore(dir, async () => { throw new Error("The operation was aborted due to timeout"); });
  await store.load();

  assert.equal(await store.ids("tt0090257"), null);
  await assert.rejects(readFile(cacheFile(dir), "utf8"));
});

test("a malformed answer returns null and writes no cache file", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExternalIdStore(dir, async () =>
    new Response("<html>", { headers: { "content-type": "application/sparql-results+json" } }));
  await store.load();

  assert.equal(await store.ids("tt0090257"), null);
  await assert.rejects(readFile(cacheFile(dir), "utf8"));
});

test("an oversized chunked answer is cancelled before the whole body is read", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = chunkedBody(256 * 1024, 64);
  const store = new ExternalIdStore(dir, async () => new Response(source.body));
  await store.load();

  assert.equal(await store.ids("tt0090257"), null);
  assert.equal(source.cancelled(), true);
  assert.ok(source.pulled() < 20, `the response stopped after ${source.pulled()} chunks`);
  await assert.rejects(readFile(cacheFile(dir), "utf8"));
});

test("a throttled lookup answers null, caches nothing and is tried again", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const store = new ExternalIdStore(dir, async () => {
    calls += 1;
    return calls === 1
      ? new Response("too many requests", { status: 429, headers: { "retry-after": "120" } })
      : bindings([]);
  });
  await store.load();

  assert.equal(await store.ids("tt0090257"), null);
  await assert.rejects(readFile(cacheFile(dir), "utf8"));

  assert.deepEqual(await store.ids("tt0090257"), {});
  assert.equal(calls, 2);
});

test("the answer is written to disk and a fresh store reads it back without a call", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const fetchImpl: FetchLike = async () => { calls += 1; return bindings([{ csfd: { value: "6672" }, tmdbMovie: { value: "31410" } }]); };
  const store = new ExternalIdStore(dir, fetchImpl);
  await store.load();
  await store.ids("tt0090257");

  const written = JSON.parse(await readFile(cacheFile(dir), "utf8")) as { version: number; entries: Record<string, ExternalIds & { at: string }> };
  assert.equal(written.version, 1);
  assert.equal(written.entries.tt0090257?.csfd, "6672");
  assert.equal(written.entries.tt0090257?.tmdbMovie, "31410");
  assert.ok(Date.parse(written.entries.tt0090257!.at) > 0, "the entry carries the time it was answered");

  const fresh = new ExternalIdStore(dir, async () => { calls += 1; return bindings([]); });
  await fresh.load();
  assert.deepEqual(await fresh.ids("tt0090257"), { csfd: "6672", tmdbMovie: "31410" });
  assert.equal(calls, 1);
});

test("an answer with no ids is kept for 30 days and asked again after that", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const store = new ExternalIdStore(dir, async () => { calls += 1; return bindings([]); });
  await store.load();

  assert.deepEqual(await store.ids("tt0090257"), {});
  assert.deepEqual(await store.ids("tt0090257"), {});
  assert.equal(calls, 1);

  const stale = JSON.parse(await readFile(cacheFile(dir), "utf8")) as { entries: Record<string, ExternalIds & { at: string }> };
  stale.entries.tt0090257!.at = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  await writeFile(cacheFile(dir), JSON.stringify(stale));

  const fresh = new ExternalIdStore(dir, async () => { calls += 1; return bindings([]); });
  await fresh.load();
  assert.deepEqual(await fresh.ids("tt0090257"), {});
  assert.equal(calls, 2);
});

test("a refused lookup answers null, caches nothing and is tried again", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const store = new ExternalIdStore(dir, async () => {
    calls += 1;
    return calls === 1 ? new Response("forbidden", { status: 403 }) : bindings([{ tmdbMovie: { value: "31410" } }]);
  });
  await store.load();

  assert.equal(await store.ids("tt0090257"), null);
  await assert.rejects(readFile(cacheFile(dir), "utf8"));

  assert.deepEqual(await store.ids("tt0090257"), { tmdbMovie: "31410" });
  assert.equal(calls, 2);
});

test("an id that is not an IMDb id answers null without a call", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const store = new ExternalIdStore(dir, async () => { calls += 1; return bindings([]); });
  await store.load();

  assert.equal(await store.ids("tmdb:157336"), null);
  assert.equal(await store.ids("tt0090257' } UNION { ?item wdt:P345 ?x } #"), null);
  assert.equal(calls, 0);
});

test("siteLinks builds the row the language and the kind call for", () => {
  const ids: ExternalIds = { csfd: "6672", tmdbMovie: "31410" };
  assert.deepEqual(siteLinks("movie", "tt0090257", ids, "cs"), [
    { site: "csfd", url: "https://www.csfd.cz/film/6672/" },
    { site: "tmdb", url: "https://www.themoviedb.org/movie/31410?language=cs-CZ" },
    { site: "imdb", url: "https://www.imdb.com/title/tt0090257/" },
  ]);
  assert.deepEqual(siteLinks("movie", "tt0090257", ids, "en"), [
    { site: "imdb", url: "https://www.imdb.com/title/tt0090257/" },
    { site: "tmdb", url: "https://www.themoviedb.org/movie/31410" },
  ]);
  assert.deepEqual(siteLinks("series", "tt0903747", { tmdbTv: "1396" }, "en"), [
    { site: "imdb", url: "https://www.imdb.com/title/tt0903747/" },
    { site: "tmdb", url: "https://www.themoviedb.org/tv/1396" },
  ]);
  // A catalog id that already is a TMDB id needs nothing from Wikidata.
  assert.deepEqual(siteLinks("movie", "tmdb:157336", {}, "en"), [
    { site: "tmdb", url: "https://www.themoviedb.org/movie/157336" },
  ]);
  // The path follows the property that supplied the id, not the kind the catalogue believes.
  assert.deepEqual(siteLinks("series", "tt0108906", { csfd: "71924", tmdbMovie: "22137" }, "cs"), [
    { site: "csfd", url: "https://www.csfd.cz/film/71924/" },
    { site: "tmdb", url: "https://www.themoviedb.org/movie/22137?language=cs-CZ" },
    { site: "imdb", url: "https://www.imdb.com/title/tt0108906/" },
  ]);
  // A prefixed catalogue id carries the IMDb id in its last segment, and all three links
  // are built from it.
  assert.deepEqual(siteLinks("movie", "mpa:webshare-index:tt2709692", ids, "cs"), [
    { site: "csfd", url: "https://www.csfd.cz/film/6672/" },
    { site: "tmdb", url: "https://www.themoviedb.org/movie/31410?language=cs-CZ" },
    { site: "imdb", url: "https://www.imdb.com/title/tt2709692/" },
  ]);
  // An id with no IMDb segment in it links to nothing at all.
  assert.deepEqual(siteLinks("movie", "mpa:webshare-index:title:movie:grinch-2018", ids, "cs"), [
    { site: "csfd", url: "https://www.csfd.cz/film/6672/" },
    { site: "tmdb", url: "https://www.themoviedb.org/movie/31410?language=cs-CZ" },
  ]);
});
