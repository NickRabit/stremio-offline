import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "./errors.js";
import { clearTmdbCache, tmdbMeta, verifyTmdbKey, type TmdbConfig } from "./tmdb.js";
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
  assert.equal(result.poster, "https://image.tmdb.org/t/p/w500/back.jpg");
  assert.equal(result.background, "https://image.tmdb.org/t/p/original/backdrop.jpg");
  assert.equal(result.year, "1985");
  assert.equal(result.releaseInfo, "1985");
  assert.deepEqual(result.genres, ["Dobrodružný", "Komedie"]);
  assert.equal(result.nameLanguage, "cs");
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
  assert.equal(result.year, "2008");
  assert.equal(result.releaseInfo, "2008");
  assert.equal("poster" in result, false);
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
