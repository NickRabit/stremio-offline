import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppError } from "./errors.js";
import { flushLog, initLogger } from "./logger.js";
import { clearTmdbCache, clearTmdbSearchPause, tmdbExternalId, tmdbGallery, tmdbImage, tmdbMeta, tmdbSearch, tmdbTrailer, verifyTmdbKey, type TmdbConfig } from "./tmdb.js";
import type { FetchLike } from "./debrid.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const config: TmdbConfig = { apiKey: "test-key", language: "cs" };

const findMovie = { movie_results: [{ id: 31410 }], tv_results: [] };
const movieDetail = {
  id: 31410,
  title: "Návrat do budoucnosti",
  original_title: "Back to the Future",
  overview: "Marty se vydává do minulosti.",
  poster_path: "/back.jpg",
  backdrop_path: "/backdrop.jpg",
  release_date: "1985-07-03",
  genres: [{ id: 12, name: "Dobrodružný" }, { id: 35, name: "Komedie" }],
};

test("a movie by IMDb id is resolved and mapped to Czech", async () => {
  clearTmdbCache();
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    return url.includes("/find/") ? json(findMovie) : json(movieDetail);
  };

  const result = await tmdbMeta("movie", "tt0090257", config, fetchImpl);

  assert.equal(calls.length, 2);
  assert.match(calls[0], /\/find\/tt0090257\?/);
  assert.match(calls[0], /external_source=imdb_id/);
  assert.match(calls[0], /api_key=test-key/);
  assert.match(calls[0], /language=cs/);
  assert.match(calls[1], /\/movie\/31410\?/);
  assert.match(calls[1], /api_key=test-key/);
  assert.match(calls[1], /language=cs/);
  if (!result) throw new Error("expected metadata");
  assert.equal(result.id, "tt0090257");
  assert.equal(result.type, "movie");
  assert.equal(result.name, "Návrat do budoucnosti");
  assert.equal(result.description, "Marty se vydává do minulosti.");
  assert.equal(result.nameLanguage, "cs");
  assert.equal("poster" in result, false);
  assert.equal("background" in result, false);
  assert.equal("year" in result, false);
  assert.equal("releaseInfo" in result, false);
  assert.equal("genres" in result, false);
});

test("artwork on maps the poster and backdrop and nothing else", async () => {
  clearTmdbCache();
  const fetchImpl: FetchLike = async (url) =>
    url.includes("/find/") ? json(findMovie) : json(movieDetail);

  const result = await tmdbMeta("movie", "tt0090257", { ...config, artwork: true }, fetchImpl);

  if (!result) throw new Error("expected metadata");
  assert.equal(result.poster, "https://image.tmdb.org/t/p/w500/back.jpg");
  assert.equal(result.background, "https://image.tmdb.org/t/p/w1280/backdrop.jpg");
  assert.equal("genres" in result, false);
  assert.equal("year" in result, false);
});

test("an empty overview leaves the description off", async () => {
  clearTmdbCache();
  const fetchImpl: FetchLike = async (url) =>
    url.includes("/find/") ? json(findMovie) : json({ ...movieDetail, overview: "" });

  const result = await tmdbMeta("movie", "tt0090257", config, fetchImpl);

  if (!result) throw new Error("expected metadata");
  assert.equal("description" in result, false);
});

test("a tmdb id skips the imdb lookup", async () => {
  clearTmdbCache();
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => { calls.push(url); return json(movieDetail); };

  const result = await tmdbMeta("movie", "tmdb:31410", config, fetchImpl);

  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/movie\/31410\?/);
  if (!result) throw new Error("expected metadata");
  assert.equal(result.id, "tmdb:31410");
});

test("TMDB trailers prefer official entries and ignore other video kinds", async () => {
  clearTmdbCache();
  const calls: string[] = [];
  const result = await tmdbTrailer("movie", "tmdb:31410", config, async (url) => {
    calls.push(url);
    return json({ results: [
      { key: "aaaaaaaaaaa", site: "YouTube", type: "Teaser", official: true },
      { key: "bbbbbbbbbbb", site: "Vimeo", type: "Trailer", official: true },
      { key: "ccccccccccc", site: "YouTube", type: "Trailer", iso_639_1: "cs" },
      { key: "ddddddddddd", site: "YouTube", type: "Trailer", official: true, iso_639_1: "en", name: "Official" },
    ] });
  });
  assert.match(calls[0]!, /\/movie\/31410\/videos\?/);
  assert.deepEqual(result, { youtubeId: "ddddddddddd", title: "Official" });
});

test("TMDB trailers resolve an IMDb series through the tv endpoint", async () => {
  clearTmdbCache();
  const calls: string[] = [];
  const result = await tmdbTrailer("series", "tt0903747", config, async (url) => {
    calls.push(url);
    return url.includes("/find/") ? json({ movie_results: [], tv_results: [{ id: 1396 }] })
      : json({ results: [{ key: "eeeeeeeeeee", site: "YouTube", type: "Trailer", iso_639_1: "en" }] });
  });
  assert.match(calls[1]!, /\/tv\/1396\/videos\?/);
  assert.deepEqual(result, { youtubeId: "eeeeeeeeeee" });
});

test("TMDB trailer selection falls back to the UI language, then English, then the first", async () => {
  clearTmdbCache();
  const byLanguage = async (language: string) => tmdbTrailer("movie", "tmdb:31410", { ...config, language }, async () => json({ results: [
    { key: "aaaaaaaaaaa", site: "YouTube", type: "Trailer", iso_639_1: "de" },
    { key: "bbbbbbbbbbb", site: "YouTube", type: "Trailer", iso_639_1: "en" },
    { key: "ccccccccccc", site: "YouTube", type: "Trailer", iso_639_1: "cs" },
  ] }));
  assert.deepEqual(await byLanguage("cs"), { youtubeId: "ccccccccccc" }, "the interface language wins");
  assert.deepEqual(await byLanguage("fr"), { youtubeId: "bbbbbbbbbbb" }, "English is the next best thing");
  clearTmdbCache();
  assert.deepEqual(await tmdbTrailer("movie", "tmdb:31410", config, async () => json({ results: [
    { key: "aaaaaaaaaaa", site: "YouTube", type: "Trailer" },
    { key: "bbbbbbbbbbb", site: "YouTube", type: "Trailer" },
  ] })), { youtubeId: "aaaaaaaaaaa" }, "with nothing to choose by, TMDB's order decides");
});

test("TMDB answers nothing for a video list it cannot use, a refusal, or malformed JSON", async () => {
  clearTmdbCache();
  const unusable = { results: [{ key: "aaaaaaaaaaa", site: "YouTube", type: "Clip" }, { key: "short", site: "YouTube", type: "Trailer" }] };
  assert.equal(await tmdbTrailer("movie", "tmdb:31410", config, async () => json(unusable)), null);
  assert.equal(await tmdbTrailer("movie", "tmdb:31411", config, async () => json({ error: "refused" }, 500)), null);
  assert.equal(await tmdbTrailer("movie", "tmdb:31412", config, async () => new Response("<html>", { headers: { "content-type": "application/json" } })), null);
});

test("a series is read from the tv endpoint", async () => {
  clearTmdbCache();
  const calls: string[] = [];
  const detail = {
    id: 1396, name: "Perníkový táta", original_name: "Breaking Bad", overview: "Učitel chemie.",
    first_air_date: "2008-01-20", poster_path: null, genres: [{ id: 18, name: "Drama" }],
  };
  const fetchImpl: FetchLike = async (url) => { calls.push(url); return json(detail); };

  const result = await tmdbMeta("series", "tmdb:1396", config, fetchImpl);

  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/tv\/1396\?/);
  if (!result) throw new Error("expected metadata");
  assert.equal(result.name, "Perníkový táta");
  assert.equal("year" in result, false);
  assert.equal("releaseInfo" in result, false);
  assert.equal("poster" in result, false);
});

test("tmdbImage composes a URL and answers undefined without a path", () => {
  assert.equal(tmdbImage("/back.jpg", "w500"), "https://image.tmdb.org/t/p/w500/back.jpg");
  assert.equal(tmdbImage(undefined, "w1280"), undefined);
  assert.equal(tmdbImage(null, "w1280"), undefined);
  assert.equal(tmdbImage("", "w1280"), undefined);
});

test("an imdb id TMDB does not know answers null", async () => {
  clearTmdbCache();
  const fetchImpl: FetchLike = async () => json({ movie_results: [], tv_results: [] });
  assert.equal(await tmdbMeta("movie", "tt0000000", config, fetchImpl), null);
});

test("a repeated imdb lookup makes no second find call", async () => {
  clearTmdbCache();
  let finds = 0;
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes("/find/")) { finds += 1; return json(findMovie); }
    return json(movieDetail);
  };

  await tmdbMeta("movie", "tt0090257", config, fetchImpl);
  await tmdbMeta("movie", "tt0090257", config, fetchImpl);

  assert.equal(finds, 1);
});

test("a revoked key answers null instead of throwing", async () => {
  clearTmdbCache();
  const fetchImpl: FetchLike = async (url) =>
    url.includes("/find/") ? json(findMovie) : json({ status_message: "Invalid API key" }, 401);

  assert.equal(await tmdbMeta("movie", "tt0090257", config, fetchImpl), null);
});

test("verifyTmdbKey accepts a good key and rejects a refused one", async () => {
  const calls: string[] = [];
  await verifyTmdbKey("good-key", async (url) => { calls.push(url); return json({ images: {} }); });
  assert.match(calls[0], /\/configuration\?/);
  assert.match(calls[0], /api_key=good-key/);

  await assert.rejects(
    verifyTmdbKey("bad-key", async () => json({ status_message: "Invalid API key" }, 401)),
    (error: unknown) => error instanceof AppError && error.messageKey === "err.tmdbKeyRejected",
  );
});

const searchRow = (over: Record<string, unknown> = {}) => ({
  id: 31410, title: "Návrat do budoucnosti", original_title: "Back to the Future",
  release_date: "1985-07-03", poster_path: "/back.jpg", backdrop_path: "/backdrop.jpg", ...over,
});

test("a title search maps a movie page and keeps the original name and year", async () => {
  clearTmdbCache();
  const calls: string[] = [];
  const result = await tmdbSearch("movie", "Navrat do budoucnosti", config, async (url) => {
    calls.push(url);
    return json({ results: [searchRow(), { id: 12, title: "" }, searchRow({ id: 99, title: "Bez roku", release_date: "" })] });
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /\/search\/movie\?/);
  assert.match(calls[0]!, /include_adult=false/);
  assert.match(calls[0]!, /page=1/);
  assert.match(calls[0]!, /language=cs/);
  assert.equal(result.length, 2, "a row without a name is dropped");
  assert.deepEqual(result[0], {
    id: "tmdb:31410", type: "movie", name: "Návrat do budoucnosti", originalTitle: "Back to the Future",
    releaseInfo: "1985", released: "1985-07-03", poster: "https://image.tmdb.org/t/p/w500/back.jpg",
    background: "https://image.tmdb.org/t/p/w1280/backdrop.jpg",
  });
  assert.equal("releaseInfo" in result[1]!, false, "a missing release date is not invented");
});

test("a title search reads the tv endpoint and the series name", async () => {
  clearTmdbCache();
  const calls: string[] = [];
  const result = await tmdbSearch("series", "Pernikovy tata", config, async (url) => {
    calls.push(url);
    return json({ results: [{ id: 1396, name: "Perníkový táta", original_name: "Breaking Bad", first_air_date: "2008-01-20" }] });
  });

  assert.match(calls[0]!, /\/search\/tv\?/);
  assert.deepEqual(result, [{
    id: "tmdb:1396", type: "series", name: "Perníkový táta", originalTitle: "Breaking Bad",
    releaseInfo: "2008", released: "2008-01-20",
  }]);
});

test("a search row carries the vote count and the release day the matcher needs", async () => {
  clearTmdbCache();
  const result = await tmdbSearch("movie", "Navrat do budoucnosti", config, async () => json({
    results: [
      searchRow({ vote_count: 33000 }),
      searchRow({ id: 99, vote_count: "many" }),
      searchRow({ id: 98, release_date: "30.7.1985" }),
    ],
  }));

  assert.equal(result[0]!.voteCount, 33000);
  assert.equal(result[0]!.released, "1985-07-03");
  assert.equal("voteCount" in result[1]!, false, "a vote count that is not a number is not invented");
  assert.equal("released" in result[2]!, false, "a date that is not a day of the month is not invented");
});

test("a known year narrows the search the way each medium spells it", async () => {
  clearTmdbCache();
  const movieCalls: string[] = [];
  await tmdbSearch("movie", "Jackass", config, async (url) => { movieCalls.push(url); return json({ results: [] }); }, { year: 2010 });
  assert.match(movieCalls[0]!, /\/search\/movie\?/);
  assert.match(movieCalls[0]!, /year=2010/);

  const seriesCalls: string[] = [];
  await tmdbSearch("series", "Peppa Pig", config, async (url) => { seriesCalls.push(url); return json({ results: [] }); }, { year: 2004 });
  assert.match(seriesCalls[0]!, /first_air_date_year=2004/);

  const plain: string[] = [];
  await tmdbSearch("movie", "Jackass", config, async (url) => { plain.push(url); return json({ results: [] }); });
  assert.equal(/year=/.test(plain[0]!), false, "a search without a year asks without one");
});

test("a search that times out, is refused or answers rubbish is an empty list", async () => {
  clearTmdbCache();
  clearTmdbSearchPause();
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  assert.deepEqual(await tmdbSearch("movie", "Anything", config, async () => { throw timeout; }), []);
  assert.deepEqual(await tmdbSearch("movie", "Anything", config, async () => json({ results: [] }, 401)), []);
  assert.deepEqual(await tmdbSearch("movie", "Anything", config, async () => new Response("<html>", { headers: { "content-type": "application/json" } })), []);
  assert.deepEqual(await tmdbSearch("movie", "   ", config, async () => json({ results: [searchRow()] })), []);
});

test("a 429 with Retry-After stops asking for the next title instead of retrying each one", async () => {
  clearTmdbCache();
  clearTmdbSearchPause();
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    return new Response(JSON.stringify({ status_message: "rate limited" }), {
      status: 429, headers: { "content-type": "application/json", "retry-after": "30" },
    });
  };
  assert.deepEqual(await tmdbSearch("movie", "First", config, fetchImpl), []);
  assert.deepEqual(await tmdbSearch("movie", "Second", config, fetchImpl), []);
  assert.deepEqual(await tmdbSearch("movie", "Third", config, fetchImpl), []);
  assert.equal(calls, 1, "the wait the provider asked for is honoured, not retried per title");
  clearTmdbSearchPause();
  assert.deepEqual(await tmdbSearch("movie", "Fourth", config, async () => json({ results: [searchRow()] })).then((rows) => rows.length), 1);
});

test("an external id lookup answers the IMDb id, or nothing when there is none", async () => {
  clearTmdbCache();
  const calls: string[] = [];
  const withId = await tmdbExternalId("movie", 31410, config, async (url) => {
    calls.push(url);
    return json({ id: 31410, imdb_id: "tt0090257" });
  });
  assert.match(calls[0]!, /\/movie\/31410\/external_ids\?/);
  assert.equal(withId, "tt0090257");

  assert.equal(await tmdbExternalId("series", 1396, config, async () => json({ id: 1396, imdb_id: null })), null);
  assert.equal(await tmdbExternalId("series", 1396, config, async () => json({ id: 1396, imdb_id: "nm0001" })), null, "a non-IMDb id is not used");
  assert.equal(await tmdbExternalId("movie", 0, config, async () => json({ imdb_id: "tt1" })), null);
  assert.equal(await tmdbExternalId("movie", 31410, config, async () => json({}, 500)), null);
});

test("a gallery request is bounded, deduplicated and prefers the interface language", async () => {
  clearTmdbCache();
  const posters = Array.from({ length: 12 }, (_, index) => ({ file_path: `/p${index}.jpg`, iso_639_1: index === 0 ? "cs" : "en", vote_average: 12 - index }));
  posters.push({ file_path: "/p0.jpg", iso_639_1: "en", vote_average: 1 });
  const backdrops = Array.from({ length: 9 }, (_, index) => ({ file_path: `/b${index}.jpg`, iso_639_1: "xx", vote_average: 9 - index }));
  const logos = Array.from({ length: 6 }, (_, index) => ({ file_path: `/l${index}.jpg`, iso_639_1: "en" }));
  const calls: string[] = [];
  const result = await tmdbGallery("movie", "tt0090257", config, async (url) => {
    calls.push(url);
    return url.includes("/find/") ? json(findMovie) : json({ posters, backdrops, logos });
  });

  assert.match(calls[1]!, /\/movie\/31410\/images\?/);
  assert.match(calls[1]!, /include_image_language=cs%2Cen%2Cnull|include_image_language=cs,en,null/);
  assert.ok(result.length <= 18, "the gallery is bounded");
  assert.equal(result[0]!.url, "https://image.tmdb.org/t/p/w500/p0.jpg", "the interface language is offered first");
  assert.equal(result.filter((picture) => picture.kind === "poster").length, 8);
  assert.equal(result.filter((picture) => picture.kind === "background").length, 6);
  assert.equal(result.filter((picture) => picture.kind === "logo").length, 4);
  assert.equal(new Set(result.map((picture) => picture.url)).size, result.length, "one picture appears once");
  assert.equal(result.some((picture) => picture.url.endsWith("/p0.jpg") && picture.kind === "poster"), true);
});

test("a gallery request that fails leaves the title without a gallery rather than without a match", async () => {
  clearTmdbCache();
  assert.deepEqual(await tmdbGallery("movie", "tmdb:31410", config, async () => json({}, 500)), []);
  assert.deepEqual(await tmdbGallery("series", "tmdb:1396", config, async () => { throw new Error("offline"); }), []);
});

test("neither the log nor the answered metadata carries the API key", async () => {
  clearTmdbCache();
  clearTmdbSearchPause();
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-tmdb-"));
  const previous = process.env.LOG_STDOUT;
  process.env.LOG_STDOUT = "0";
  try {
    await initLogger(directory);
    const refused: FetchLike = async (url) => { throw new Error(`Request failed: ${String(url)}`); };
    assert.deepEqual(await tmdbSearch("movie", "Anything", { apiKey: "secret-key-42", language: "cs" }, refused), []);
    assert.equal(await tmdbExternalId("movie", 1, { apiKey: "secret-key-42", language: "cs" }, refused), null);
    const meta = await tmdbMeta("movie", "tmdb:1", { apiKey: "secret-key-42", language: "cs" }, refused);
    assert.equal(meta, null);
    await flushLog();
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(path.join(directory, "app.log"), "utf8").catch(() => "");
    assert.equal(text.includes("secret-key-42"), false);
    assert.equal(JSON.stringify(meta).includes("secret-key-42"), false);
  } finally {
    if (previous === undefined) delete process.env.LOG_STDOUT; else process.env.LOG_STDOUT = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
