import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "./debrid.js";
import {
  clearPersonCache,
  composePerson,
  normalizePerson,
  ownedTitleKeys,
  personCredits,
  type PersonCreditTitle,
  type PersonCredits,
} from "./person-filmography.js";
import type { TmdbConfig, TmdbPersonResponse } from "./tmdb.js";

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
  assert.match(pulp.role ?? "", /Director/);
  assert.match(pulp.role ?? "", /Writer/);
  assert.match(pulp.role ?? "", /Jimmie Dimmick/);
  assert.equal(credits.acting.some((item) => item.tmdbId === 680), false);
  assert.equal(credits.crew.some((item) => item.tmdbId === 507), false, "Producer-only Killing Zoe is absent");
  assert.equal(credits.crew.some((item) => item.tmdbId === 339403), false, "Thanks-only Baby Driver is absent");

  const filmography = composePerson(credits, { owned: new Set(), imdbOf: () => undefined });
  assert.equal(filmography.sections[0]?.key, "crew");
});

test("Gilligan's creator credit for Breaking Bad is a series in crew", () => {
  const credits = normalizePerson(fixture("vince-gilligan-66633.json"), 66633);
  assert.ok(credits);
  const breakingBad = credits.crew.find((item) => item.tmdbId === 1396);
  assert.ok(breakingBad);
  assert.equal(breakingBad.type, "series");
  assert.match(breakingBad.role ?? "", /Creator/);
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
  assert.match(familyGuy[0]!.role ?? "", /Dr\. Jewish/);
  assert.match(familyGuy[0]!.role ?? "", /Bert \/ Judge/);
  const breakingBad = credits.crew.find((item) => item.tmdbId === 1396);
  assert.ok(breakingBad);
  assert.match(breakingBad.role ?? "", /Director/);
  assert.match(breakingBad.role ?? "", /Walter White/);
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
  );
  const credits = normalizePerson(raw, 287);
  assert.ok(credits);
  const ids = new Set([...credits.acting, ...credits.crew].map((item) => item.tmdbId));
  for (const id of [9001, 9002, 9003, 9004, 9005]) assert.equal(ids.has(id), false, String(id));
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
    crew: [credit({ tmdbId: 680, name: "Pulp Fiction", posterPath: "/pulp.jpg", role: "Director" })],
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
