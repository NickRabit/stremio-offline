import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "./debrid.js";
import {
  clearPersonCache,
  composePerson,
  normalizePeople,
  normalizePerson,
  ownedTitleKeys,
  personCredits,
  searchPeople,
  type PersonCreditTitle,
  type PersonCredits,
} from "./person-filmography.js";
import type { TmdbConfig, TmdbPersonHit, TmdbPersonResponse } from "./tmdb.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): TmdbPersonResponse =>
  JSON.parse(readFileSync(path.join(here, "..", "test-fixtures", "tmdb-person", name), "utf8")) as TmdbPersonResponse;

const config: TmdbConfig = { apiKey: "person-test-key", language: "en-US" };
const SUCCESS_TTL_MS = 24 * 60 * 60_000;
const FAILURE_TTL_MS = 10 * 60_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fresh = (t: TestContext) => {
  clearPersonCache();
  t.after(clearPersonCache);
};

const credit = (overrides: Partial<PersonCreditTitle> = {}): PersonCreditTitle => ({
  type: "movie",
  tmdbId: 1,
  name: "Film",
  popularity: 1,
  ...overrides,
});

test("Tarantino keeps his Pulp Fiction jobs and character in the crew section", () => {
  const credits = normalizePerson(fixture("quentin-tarantino-138.json"), 138);
  assert.ok(credits);
  const pulp = credits.crew.find((item) => item.tmdbId === 680);
  assert.ok(pulp);
  assert.deepEqual(pulp.jobs, ["director", "writer"]);
  assert.match(pulp.character ?? "", /Jimmie Dimmick/);
  assert.equal(credits.acting.some((item) => item.tmdbId === 680), false);
  assert.equal(credits.crew.some((item) => item.tmdbId === 507), false, "Producer-only Killing Zoe is absent");
  assert.equal(credits.crew.some((item) => item.tmdbId === 339403), false, "Thanks-only Baby Driver is absent");

  const filmography = composePerson(credits, { owned: new Set(), imdbOf: () => undefined });
  assert.equal(filmography.sections[0]?.key, "crew");
  assert.equal(filmography.knownFor, "crew");
  assert.equal(filmography.total, credits.acting.length + credits.crew.length);
  const tile = filmography.sections[0]!.titles.find((title) => title.tmdbId === 680);
  assert.match(tile?.poster ?? "", /^https:\/\/image\.tmdb\.org\/t\/p\/w342\//);
  assert.match(tile?.background ?? "", /^https:\/\/image\.tmdb\.org\/t\/p\/w780\//, "a wide tile has a backdrop to show");
});

test("Gilligan's creator credit for Breaking Bad is a series in crew", () => {
  const credits = normalizePerson(fixture("vince-gilligan-66633.json"), 66633);
  assert.ok(credits);
  const breakingBad = credits.crew.find((item) => item.tmdbId === 1396);
  assert.ok(breakingBad);
  assert.equal(breakingBad.type, "series");
  assert.ok(breakingBad.jobs?.includes("creator"));
});

test("Cranston merges characters and drops talk shows and self appearances", () => {
  const credits = normalizePerson(fixture("bryan-cranston-17419.json"), 17419);
  assert.ok(credits);
  const names = new Set([...credits.acting, ...credits.crew].map((item) => item.name));
  for (const dropped of ["Jimmy Kimmel Live!", "The View", "The Graham Norton Show", "MADtv", "The Oscars"]) {
    assert.equal(names.has(dropped), false, dropped);
  }
  const familyGuy = credits.acting.filter((item) => item.tmdbId === 1434);
  assert.equal(familyGuy.length, 1);
  assert.match(familyGuy[0]!.character ?? "", /Dr\. Jewish/);
  assert.match(familyGuy[0]!.character ?? "", /Bert \/ Judge/);
  const breakingBad = credits.crew.find((item) => item.tmdbId === 1396);
  assert.ok(breakingBad);
  assert.ok(breakingBad.jobs?.includes("director"));
  assert.match(breakingBad.character ?? "", /Walter White/);
});

test("normalisation drops adult, untitled, non-title and self-credit rows", () => {
  const raw = structuredClone(fixture("brad-pitt-287.json"));
  const cast = raw.combined_credits!.cast!;
  cast.push(
    { id: 9001, media_type: "movie", adult: true, title: "Adult synthetic", character: "Actor", popularity: 100 },
    { id: 9002, media_type: "movie", character: "Actor", popularity: 100 },
    { id: 9003, media_type: "person", name: "A person row", character: "Actor", popularity: 100 },
    { id: 9004, media_type: "movie", title: "Archive synthetic", character: "Himself (archive footage)", popularity: 100 },
    { id: 9005, media_type: "movie", title: "Uncredited synthetic", character: "Bartender (uncredited)", popularity: 100 },
    { id: 9006, media_type: "movie", title: "Negative synthetic", character: "Actor", popularity: -2 },
    { id: 9007, media_type: "tv", name: "Host synthetic", character: "Himself - Host", popularity: 100 },
    { id: 9008, media_type: "movie", title: "Voice synthetic", character: "Herself (voice)", popularity: 100 },
    { id: 9009, media_type: "tv", name: "Band synthetic", character: "Themselves - Guests", popularity: 100 },
    { id: 9010, media_type: "movie", title: "Selfish synthetic", character: "Selfridge", popularity: 100 },
  );
  const credits = normalizePerson(raw, 287);
  assert.ok(credits);
  const ids = new Set([...credits.acting, ...credits.crew].map((item) => item.tmdbId));
  for (const id of [9001, 9002, 9003, 9004, 9005, 9007, 9008, 9009]) assert.equal(ids.has(id), false, String(id));
  assert.equal(ids.has(9010), true);
  assert.equal(credits.acting.find((item) => item.tmdbId === 9006)?.popularity, -2);
});

test("composition sorts owned, popularity and dates, then cuts at 200", () => {
  const ordered: PersonCredits = {
    id: 1,
    name: "Person",
    knownFor: "acting",
    acting: [
      credit({ tmdbId: 1, name: "Old high", popularity: 50, date: "2000-01-01" }),
      credit({ tmdbId: 2, name: "Owned", popularity: 1, date: "1990-01-01" }),
      credit({ tmdbId: 3, name: "Popular", popularity: 99, date: "2020-01-01" }),
      credit({ tmdbId: 4, name: "New high", popularity: 50, date: "2024-01-01" }),
      credit({ tmdbId: 5, name: "No date", popularity: 50 }),
      credit({ tmdbId: 6, name: "A tie", popularity: 10, date: "2020-01-01" }),
      credit({ tmdbId: 7, name: "B tie", popularity: 10, date: "2020-01-01" }),
    ],
    crew: [],
  };
  const sorted = composePerson(ordered, { owned: new Set(["movie:2"]), imdbOf: () => undefined });
  assert.deepEqual(sorted.sections[0]?.titles.map((item) => item.name), [
    "Owned",
    "Popular",
    "New high",
    "Old high",
    "No date",
    "A tie",
    "B tie",
  ]);

  const extensive: PersonCredits = {
    id: 2,
    name: "Prolific",
    knownFor: "acting",
    acting: [
      ...Array.from({ length: 249 }, (_, index) => credit({
        tmdbId: 1000 + index,
        name: `Film ${index}`,
        popularity: 1000 - index,
      })),
      credit({ tmdbId: 999, name: "Owned low", popularity: 0 }),
    ],
    crew: [],
  };
  const cut = composePerson(extensive, { owned: new Set(["movie:999"]), imdbOf: () => undefined });
  assert.equal(cut.sections[0]?.titles.length, 200);
  assert.equal(cut.sections[0]?.titles[0]?.name, "Owned low");
});

test("composition uses a known IMDb id and marks ownership without changing the cache", () => {
  const credits: PersonCredits = {
    id: 138,
    name: "Quentin Tarantino",
    profilePath: "/quentin.jpg",
    knownFor: "crew",
    acting: [],
    crew: [credit({ tmdbId: 680, name: "Pulp Fiction", posterPath: "/pulp.jpg", jobs: ["director"] })],
  };
  const known = composePerson(credits, {
    owned: new Set(["movie:680"]),
    imdbOf: (type, id) => type === "movie" && id === 680 ? "tt0110912" : undefined,
  });
  assert.equal(known.sections[0]?.titles[0]?.id, "tt0110912");
  assert.equal(known.sections[0]?.titles[0]?.inLibrary, true);

  const unknown = composePerson(credits, { owned: new Set(), imdbOf: () => undefined });
  assert.equal(unknown.sections[0]?.titles[0]?.id, "tmdb:680");
  assert.equal("inLibrary" in unknown.sections[0]!.titles[0]!, false);
});

test("ownedTitleKeys accepts direct and learned ids and ownership stays per composition", () => {
  const owned = ownedTitleKeys([
    { type: "series", id: "tmdb:500" },
    { type: "movie", id: "tt0110912" },
    { type: "movie", id: "tt9999999" },
    { type: "channel", id: "tmdb:700" },
  ], (type, imdb) => type === "movie" && imdb === "tt0110912" ? 680 : undefined);
  assert.deepEqual([...owned].sort(), ["movie:680", "series:500"]);

  const credits: PersonCredits = {
    id: 1,
    name: "Person",
    knownFor: "acting",
    acting: [credit({ tmdbId: 1, name: "One" })],
    crew: [],
  };
  const alice = composePerson(credits, { owned: new Set(["movie:1"]), imdbOf: () => undefined });
  const bob = composePerson(credits, { owned: new Set(), imdbOf: () => undefined });
  assert.equal(alice.sections[0]?.titles[0]?.inLibrary, true);
  assert.equal("inLibrary" in bob.sections[0]!.titles[0]!, false);
});

test("concurrent person cache misses share one TMDB request", async (t) => {
  fresh(t);
  let requests = 0;
  let release!: () => void;
  let started!: () => void;
  const startedRequest = new Promise<void>((resolve) => { started = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (raw) => {
    requests += 1;
    calls.push(raw);
    started();
    await held;
    return json(fixture("quentin-tarantino-138.json"));
  };

  const first = personCredits(138, "en-US", { tmdb: config, fetchImpl });
  await startedRequest;
  const second = personCredits(138, "en-US", { tmdb: config, fetchImpl });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((result) => result.status), ["found", "found"]);
  assert.equal(requests, 1);
  const url = new URL(calls[0]!);
  assert.equal(url.pathname, "/3/person/138");
  assert.equal(url.searchParams.get("append_to_response"), "combined_credits");
  assert.equal(calls.some((call) => call.includes("/external_ids")), false);
});

test("a caller joining just after the last one left gets a fresh lookup, not its cancellation", async (t) => {
  fresh(t);
  let requests = 0;
  const fetchImpl: FetchLike = async (_raw, init) => {
    requests += 1;
    if (requests === 1) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    return json(fixture("quentin-tarantino-138.json"));
  };
  const leaving = new AbortController();
  const first = personCredits(138, "en-US", { tmdb: config, fetchImpl, signal: leaving.signal });
  first.catch(() => undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  leaving.abort();
  const second = await personCredits(138, "en-US", { tmdb: config, fetchImpl });
  assert.equal(second.status, "found");
  await assert.rejects(first);
});

test("failed person lookups are retried after ten minutes and found ones after a day", async (t) => {
  fresh(t);
  let now = 1_000;
  let failures = 0;
  const failing: FetchLike = async () => {
    failures += 1;
    return json({}, 500);
  };
  const failingDeps = { tmdb: config, fetchImpl: failing, now: () => now };
  assert.equal((await personCredits(1, "en-US", failingDeps)).status, "failed");
  now += FAILURE_TTL_MS - 1;
  assert.equal((await personCredits(1, "en-US", failingDeps)).status, "failed");
  assert.equal(failures, 1);
  now += 1;
  assert.equal((await personCredits(1, "en-US", failingDeps)).status, "failed");
  assert.equal(failures, 2);

  clearPersonCache();
  now = 10_000;
  let successes = 0;
  const found: FetchLike = async () => {
    successes += 1;
    return json({ id: 2, name: "Found" });
  };
  const foundDeps = { tmdb: config, fetchImpl: found, now: () => now };
  assert.equal((await personCredits(2, "en-US", foundDeps)).status, "found");
  now += SUCCESS_TTL_MS - 1;
  assert.equal((await personCredits(2, "en-US", foundDeps)).status, "found");
  assert.equal(successes, 1);
  now += 1;
  await personCredits(2, "en-US", foundDeps);
  assert.equal(successes, 2);
});

test("person cache distinguishes a TMDB 404 from a failure", async (t) => {
  fresh(t);
  const missing = await personCredits(3, "en-US", {
    tmdb: config,
    fetchImpl: async () => json({}, 404),
    now: () => 1_000,
  });
  const failed = await personCredits(4, "en-US", {
    tmdb: config,
    fetchImpl: async () => json({}, 500),
    now: () => 1_000,
  });
  assert.equal(missing.status, "missing");
  assert.equal(failed.status, "failed");
});

test("the person cache evicts the least recently used of 201 people", async (t) => {
  fresh(t);
  let requests = 0;
  const fetchImpl: FetchLike = async (raw) => {
    requests += 1;
    const id = Number(new URL(raw).pathname.split("/").at(-1));
    return json({ id, name: `Person ${id}` });
  };
  for (let id = 1; id <= 201; id += 1) {
    await personCredits(id, "en-US", { tmdb: config, fetchImpl, now: () => 1_000 });
  }
  assert.equal(requests, 201);
  await personCredits(1, "en-US", { tmdb: config, fetchImpl, now: () => 1_000 });
  assert.equal(requests, 202, "the oldest person was evicted");
});

const hits = (name: string): TmdbPersonHit[] =>
  (JSON.parse(readFileSync(path.join(here, "..", "test-fixtures", "tmdb-person", name), "utf8")) as { results: TmdbPersonHit[] }).results;

test("a people search keeps those TMDB knows a title for, at most eight, in TMDB's order", () => {
  const brad = normalizePeople(hits("search-brad-pitt.json"));
  assert.equal(brad[0]?.name, "Brad Pitt");
  assert.equal(brad[0]?.id, 287);
  assert.equal(brad[0]?.knownFor, "acting");
  assert.ok(brad[0]!.knownTitles.length > 0 && brad[0]!.knownTitles.length <= 3);
  assert.match(brad[0]?.photo ?? "", /^https:\/\/image\.tmdb\.org\/t\/p\/w185\//);

  const raw = hits("search-tarantino.json");
  const tarantino = normalizePeople(raw);
  assert.ok(raw.length > 10, "the fixture is full of namesakes");
  assert.deepEqual(tarantino.map((person) => person.name), ["Quentin Tarantino"], "namesakes a tenth as known are dropped");
  assert.equal(tarantino[0]?.knownFor, "crew");

  const row = (over: Partial<TmdbPersonHit>): TmdbPersonHit => ({ name: "Someone", known_for_department: "Acting", popularity: 1, known_for: [{ title: "X" }], ...over });
  assert.deepEqual(normalizePeople([
    row({ id: 1, adult: true }),
    row({ id: 2, name: "" }),
    row({ id: 3 }),
    row({ id: 3 }),
    row({ id: 4, known_for_department: "Camera" }),
    row({ id: 5, known_for: [] }),
    row({ id: 6, known_for_department: "Writing", popularity: 0.2 }),
    row({ id: 7, popularity: 0.05 }),
  ]).map((person) => person.id), [3, 6], "adult, nameless, repeated, camera, title-less and obscure rows are dropped");
  assert.equal(normalizePeople(Array.from({ length: 12 }, (_, index) => row({ id: index + 1 }))).length, 8);
});

test("a people search is asked once per query and remembers a failure briefly", async (t) => {
  fresh(t);
  const calls: string[] = [];
  let fail = false;
  const fetchImpl: FetchLike = async (raw) => {
    calls.push(raw);
    return fail ? json({}, 500) : json({ results: hits("search-brad-pitt.json") });
  };
  let now = 1_000;
  const deps = { tmdb: config, fetchImpl, now: () => now };
  const [first, second] = await Promise.all([searchPeople("Brad  Pitt", "en-US", deps), searchPeople("brad pitt", "en-US", deps)]);
  assert.equal(first?.[0]?.name, "Brad Pitt");
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!);
  assert.equal(url.pathname, "/3/search/person");
  assert.equal(url.searchParams.get("query"), "Brad Pitt");
  assert.equal(url.searchParams.get("include_adult"), "false");

  assert.deepEqual(await searchPeople("b", "en-US", deps), []);
  assert.equal(calls.length, 1, "a one-letter query asks nobody");

  fail = true;
  assert.equal(await searchPeople("nobody known", "en-US", deps), null);
  assert.equal(await searchPeople("nobody known", "en-US", deps), null);
  assert.equal(calls.length, 2);
  now += 61_000;
  fail = false;
  assert.ok((await searchPeople("nobody known", "en-US", deps))?.length);
  assert.equal(calls.length, 3);
});
