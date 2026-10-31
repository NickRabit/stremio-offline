import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import type { FetchLike } from "./debrid.js";
import { clearTitleExtrasCache, titleExtras, type TitleExtrasDeps } from "./title-extras.js";
import { clearTmdbCache, type TmdbConfig } from "./tmdb.js";
import type { MetaItem } from "./types.js";

const config: TmdbConfig = { apiKey: "test-key", language: "cs" };
const SUCCESS_TTL_MS = 24 * 60 * 60_000;
const FAILURE_TTL_MS = 10 * 60_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const externalId = (id: number) => json({ imdb_id: `tt${String(id).padStart(7, "0")}` });

const deps = (
  fetchImpl: FetchLike,
  overrides: Partial<TitleExtrasDeps> = {},
): TitleExtrasDeps => ({
  tmdb: config,
  fetchImpl,
  meta: async () => ({ id: "tt0111161", type: "movie", name: "Film" }),
  copies: async () => [],
  ...overrides,
});

const fresh = (t: TestContext) => {
  clearTitleExtrasCache();
  clearTmdbCache();
  t.after(() => {
    clearTitleExtrasCache();
    clearTmdbCache();
  });
};

test("movie extras map ordered cast, bounded crew, IMDb recommendations and the regional rating", async (t) => {
  fresh(t);
  const calls: string[] = [];
  const cast = Array.from({ length: 22 }, (_, index) => ({
    name: `Actor ${index}`,
    character: `Character ${index}`,
    profile_path: `/actor-${index}.jpg`,
    order: index,
  })).reverse();
  const crew = [
    { name: "Alice", job: "Director", profile_path: "/alice.jpg" },
    { name: "Alice", job: "Director" },
    { name: "Bob", job: "Screenplay" },
    { name: "Cara", job: "Writer" },
    { name: "Dan", job: "Teleplay" },
    { name: "Eve", job: "Novel" },
    { name: "Producer", job: "Producer" },
    { name: "Composer", job: "Original Music Composer" },
    { name: "Frank", job: "Director" },
    { name: "Gina", job: "Writer" },
    { name: "Hank", job: "Director" },
    { name: "Ivy", job: "Writer" },
  ];
  const recommendations = Array.from({ length: 15 }, (_, index) => ({
    id: 1000 + index,
    title: `Related ${index}`,
    release_date: `200${index % 10}-01-02`,
    poster_path: `/related-${index}.jpg`,
  }));
  const fetchImpl: FetchLike = async (raw) => {
    calls.push(raw);
    const url = new URL(raw);
    if (url.pathname === "/3/movie/31410") {
      return json({
        original_title: "Original Film",
        original_language: "en",
        credits: { cast, crew },
        recommendations: { results: recommendations },
        release_dates: {
          results: [
            { iso_3166_1: "CZ", release_dates: [{ certification: "12", type: 4 }, { certification: "15", type: 3 }] },
            { iso_3166_1: "US", release_dates: [{ certification: "R", type: 3 }] },
          ],
        },
      });
    }
    const id = Number(/\/movie\/(\d+)\/external_ids$/.exec(url.pathname)?.[1]);
    return externalId(id);
  };

  const result = await titleExtras("movie", "tmdb:31410", "cs", deps(fetchImpl, {
    meta: async () => ({ id: "tt0111161", type: "movie", name: "Localized Film" }),
    copies: async (_type, id) => id === "tt0001002" ? [{}] : [],
  }));

  assert.equal(calls.filter((call) => call.includes("/movie/31410?")).length, 1);
  assert.ok(calls.filter((call) => call.includes("/external_ids?")).length <= 16);
  assert.deepEqual(result.people.slice(0, 3).map((person) => person.name), ["Actor 0", "Actor 1", "Actor 2"]);
  assert.equal(result.people.filter((person) => person.role === "cast").length, 20);
  assert.equal(result.people.find((person) => person.name === "Actor 20"), undefined);
  assert.deepEqual(
    result.people.filter((person) => person.role !== "cast").map(({ name, role }) => ({ name, role })),
    [
      { name: "Alice", role: "director" },
      { name: "Bob", role: "writer" },
      { name: "Cara", role: "writer" },
      { name: "Dan", role: "writer" },
      { name: "Eve", role: "novel" },
      { name: "Frank", role: "director" },
      { name: "Gina", role: "writer" },
      { name: "Hank", role: "director" },
    ],
  );
  assert.equal(result.people[0]?.photo, "https://image.tmdb.org/t/p/w185/actor-0.jpg");
  assert.equal(result.people[0]?.character, "Character 0");
  assert.equal(result.related.length, 12);
  assert.deepEqual(result.related[0], {
    type: "movie",
    id: "tt0001000",
    name: "Related 0",
    year: "2000",
    poster: "https://image.tmdb.org/t/p/w342/related-0.jpg",
  });
  assert.equal(result.related[2]?.inLibrary, true);
  assert.equal("inLibrary" in result.related[1]!, false);
  assert.equal(result.ageRating, "15");
  assert.equal(result.ageRatingRegion, "CZ");
  assert.equal(result.originalTitle, "Original Film");
  assert.equal(result.originalLanguage, "en");
  assert.equal(result.source, "tmdb");
});

test("series extras put creators first and use aggregate roles and TV ratings", async (t) => {
  fresh(t);
  const fetchImpl: FetchLike = async (raw) => {
    const url = new URL(raw);
    if (url.pathname === "/3/tv/1396") {
      return json({
        original_name: "Breaking Bad",
        original_language: "en",
        created_by: [
          { name: "Vince Gilligan", profile_path: "/vince.jpg" },
          { name: "Second Creator" },
        ],
        aggregate_credits: {
          cast: [
            { name: "Second Actor", order: 2, roles: [{ character: "Second" }] },
            { name: "First Actor", order: 1, roles: [{ character: "First" }] },
          ],
          crew: [
            { name: "Director", jobs: [{ job: "Director" }], profile_path: "/director.jpg" },
            { name: "Writer", jobs: [{ job: "Writer" }, { job: "Writer" }] },
          ],
        },
        recommendations: { results: [] },
        content_ratings: {
          results: [
            { iso_3166_1: "US", rating: "TV-MA" },
            { iso_3166_1: "CZ", rating: "18" },
          ],
        },
      });
    }
    throw new Error(`Unexpected URL ${raw}`);
  };

  const result = await titleExtras("series", "tmdb:1396", "cs", deps(fetchImpl, {
    meta: async () => ({ id: "tt0903747", type: "series", name: "Perníkový táta" }),
  }));

  assert.deepEqual(result.people.slice(0, 4), [
    { name: "Vince Gilligan", role: "creator", photo: "https://image.tmdb.org/t/p/w185/vince.jpg" },
    { name: "Second Creator", role: "creator" },
    { name: "First Actor", role: "cast", character: "First" },
    { name: "Second Actor", role: "cast", character: "Second" },
  ]);
  // A series' directors and writers are those of single episodes: only its creators stand for it.
  assert.deepEqual(result.people.slice(4), []);
  assert.equal(result.ageRating, "18");
  assert.equal(result.ageRatingRegion, "CZ");
  assert.equal(result.source, "tmdb");
});

test("TMDB ratings require 20 votes and round the average to one decimal", async (t) => {
  fresh(t);
  const fetchImpl: FetchLike = async (raw) => {
    const id = Number(/\/movie\/(\d+)$/.exec(new URL(raw).pathname)?.[1]);
    return json({
      vote_average: id === 23 ? 8.66 : 9.91,
      vote_count: id === 23 ? 20 : 19,
      credits: { cast: [], crew: [] },
      recommendations: { results: [] },
      release_dates: { results: [] },
    });
  };

  const sufficient = await titleExtras("movie", "tmdb:23", "cs", deps(fetchImpl));
  const insufficient = await titleExtras("movie", "tmdb:24", "cs", deps(fetchImpl));

  assert.deepEqual(sufficient.ratings, { tmdb: 8.7, tmdbVotes: 20 });
  assert.deepEqual(insufficient.ratings, {});
});

test("IMDb ratings come from the viewer meta in a one-decimal form", async (t) => {
  fresh(t);
  const cases: Array<[unknown, string | undefined]> = [
    ["9.3", "9.3"],
    [8, "8.0"],
    ["N/A", undefined],
  ];

  for (const [rating, expected] of cases) {
    const result = await titleExtras("movie", `tt-${String(rating)}`, "cs", {
      meta: async () => ({ id: "tt1", type: "movie", name: "Film", imdbRating: rating }),
      copies: async () => [],
    });
    assert.equal(result.ratings.imdb, expected);
    assert.deepEqual(result.videos, []);
  }
});

test("TMDB videos are filtered, mapped, ordered, de-duplicated and capped", async (t) => {
  fresh(t);
  const result = await titleExtras("movie", "tmdb:25", "cs", deps(async () => json({
    credits: { cast: [], crew: [] },
    recommendations: { results: [] },
    release_dates: { results: [] },
    videos: { results: [
      { key: "eeeeeeeeeee", name: "English trailer", type: "Trailer", site: "YouTube", official: true, iso_639_1: "en" },
      { key: "cccccccccc1", name: "Czech clip", type: "Clip", site: "YouTube", official: true, iso_639_1: "cs" },
      { key: "fffffffffff", name: "French featurette", type: "Featurette", site: "YouTube", official: true, iso_639_1: "fr" },
      { key: "ddddddddddd", name: "German featurette", type: "Featurette", site: "YouTube", official: true, iso_639_1: "de" },
      { key: "cccccccccc2", name: "Czech teaser trailer", type: "Trailer", site: "YouTube", official: false, iso_639_1: "cs" },
      { key: "cccccccccc3", name: "Czech teaser", type: "Teaser", site: "YouTube", official: true, iso_639_1: "cs" },
      { key: "cccccccccc4", name: "Czech trailer", type: "Trailer", site: "YouTube", official: true, iso_639_1: "cs" },
      { key: "eeeeeeeeee2", name: "English teaser", type: "Teaser", site: "YouTube", official: false, iso_639_1: "en" },
      { key: "cccccccccc6", name: "Czech extras", type: "Behind the Scenes", site: "YouTube", official: true, iso_639_1: "cs" },
      { key: "cccccccccc4", name: "Duplicate", type: "Clip", site: "YouTube", official: true, iso_639_1: "en" },
      { key: "vvvvvvvvvvv", name: "Vimeo trailer", type: "Trailer", site: "Vimeo", official: true, iso_639_1: "cs" },
      { key: "short", name: "Short key", type: "Trailer", site: "YouTube", official: true, iso_639_1: "cs" },
      { key: "uuuuuuuuuuu", name: "Unknown kind", type: "Other", site: "YouTube", official: true, iso_639_1: "cs" },
      { key: "cccccccccc7", type: "Trailer", site: "YouTube", official: true, iso_639_1: "cs" },
    ] },
  })));

  assert.equal(result.videos.length, 8);
  assert.deepEqual(result.videos.map(({ key, kind, language }) => ({ key, kind, language })), [
    { key: "cccccccccc4", kind: "trailer", language: "cs" },
    { key: "cccccccccc2", kind: "trailer", language: "cs" },
    { key: "cccccccccc1", kind: "clip", language: "cs" },
    { key: "cccccccccc3", kind: "teaser", language: "cs" },
    { key: "cccccccccc6", kind: "behindTheScenes", language: "cs" },
    { key: "eeeeeeeeeee", kind: "trailer", language: "en" },
    { key: "eeeeeeeeee2", kind: "teaser", language: "en" },
    { key: "fffffffffff", kind: "featurette", language: "fr" },
  ]);
  assert.equal(result.videos.filter((video) => video.key === "cccccccccc4").length, 1);
  assert.deepEqual(result.videos[0], {
    key: "cccccccccc4",
    name: "Czech trailer",
    kind: "trailer",
    thumbnail: "https://i.ytimg.com/vi/cccccccccc4/hqdefault.jpg",
    language: "cs",
  });
});

test("a successful empty TMDB people list falls back to addon names and the US rating", async (t) => {
  fresh(t);
  const result = await titleExtras("movie", "tmdb:10", "cs", deps(async () => json({
    credits: { cast: [], crew: [] },
    recommendations: { results: [] },
    release_dates: { results: [{ iso_3166_1: "US", release_dates: [{ certification: "PG-13", type: 3 }] }] },
  }), {
    meta: async () => ({ id: "tt1", type: "movie", name: "Film", cast: ["Addon Cast"] }),
  }));

  assert.deepEqual(result.people, [{ name: "Addon Cast", role: "cast" }]);
  assert.equal(result.ageRating, "PG-13");
  assert.equal(result.ageRatingRegion, "US");
  assert.equal(result.source, "tmdb");
});

test("related lookups are bounded, tolerate one failure, and preserve successful people and rating", async (t) => {
  fresh(t);
  const recommendations = Array.from({ length: 16 }, (_, index) => ({
    id: 2_000 + index,
    title: `Related ${index}`,
  }));
  let active = 0;
  let maximumActive = 0;
  let externalRequests = 0;
  const result = await titleExtras("movie", "tmdb:20", "cs", deps(async (raw) => {
    const url = new URL(raw);
    if (url.pathname === "/3/movie/20") {
      return json({
        credits: { cast: [{ name: "Actor", order: 0 }], crew: [] },
        recommendations: { results: recommendations },
        release_dates: { results: [{ iso_3166_1: "CZ", release_dates: [{ certification: "12", type: 3 }] }] },
      });
    }
    externalRequests += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    active -= 1;
    const id = Number(/\/movie\/(\d+)\/external_ids$/.exec(url.pathname)?.[1]);
    return id === 2_000 ? json({}, 500) : externalId(id);
  }));

  assert.ok(externalRequests <= 16);
  assert.ok(maximumActive <= 4);
  assert.equal(result.related.length, 12);
  assert.deepEqual(result.people, [{ name: "Actor", role: "cast" }]);
  assert.equal(result.ageRating, "12");
  assert.equal(result.ageRatingRegion, "CZ");
});

test("without a TMDB key the addon names answer and no related titles are invented", async (t) => {
  fresh(t);
  const result = await titleExtras("movie", "tt1", "cs", {
    meta: async () => ({
      id: "tt1",
      type: "movie",
      name: "Film",
      imdbRating: "8.5",
      cast: ["First", { name: "Second" }, { nope: true }, null],
      director: "Director",
      writer: ["Writer A", { name: "Writer B" }],
    }),
    copies: async () => {
      throw new Error("there are no related titles to ask about");
    },
  });

  assert.deepEqual(result, {
    people: [
      { name: "First", role: "cast" },
      { name: "Second", role: "cast" },
      { name: "Director", role: "director" },
      { name: "Writer A", role: "writer" },
      { name: "Writer B", role: "writer" },
    ],
    related: [],
    ratings: { imdb: "8.5" },
    videos: [],
    source: "addon",
  });
});

test("a TMDB failure answers addon data and is not requested again for ten minutes", async (t) => {
  fresh(t);
  let requests = 0;
  let now = 1_000;
  const fetchImpl: FetchLike = async () => {
    requests += 1;
    return json({ error: "refused" }, 401);
  };
  const input = deps(fetchImpl, {
    now: () => now,
    meta: async () => ({ id: "tt1", type: "movie", name: "Film", cast: ["Addon Actor"] }),
  });

  const failed = await titleExtras("movie", "tmdb:77", "cs", input);
  assert.equal(failed.source, "addon");
  assert.deepEqual(failed.people, [{ name: "Addon Actor", role: "cast" }]);
  assert.equal(requests, 1);

  now += FAILURE_TTL_MS - 1;
  assert.equal((await titleExtras("movie", "tmdb:77", "cs", input)).source, "addon");
  assert.equal(requests, 1, "the failure is reused inside ten minutes");

  now += 1;
  await titleExtras("movie", "tmdb:77", "cs", input);
  assert.equal(requests, 2, "ten minutes later TMDB is asked again");
});

test("the TMDB cache is isolated by API key and skipped entirely without a key", async (t) => {
  fresh(t);
  let requests = 0;
  const fetchImpl: FetchLike = async (raw) => {
    requests += 1;
    const url = new URL(raw);
    if (url.searchParams.get("api_key") === "invalid-key") return json({}, 401);
    return json({
      original_title: "Film",
      original_language: "en",
      credits: { cast: [{ name: "Actor", order: 0 }], crew: [] },
      recommendations: { results: [] },
      release_dates: { results: [] },
    });
  };
  const input = (apiKey?: string) => deps(fetchImpl, {
    ...(apiKey ? { tmdb: { apiKey, language: "cs" } } : { tmdb: undefined }),
    now: () => 1_000,
  });

  assert.equal((await titleExtras("movie", "tmdb:21", "cs", input("invalid-key"))).source, "addon");
  assert.equal(requests, 1);
  const valid = await titleExtras("movie", "tmdb:21", "cs", input("valid-key"));
  assert.equal(valid.source, "tmdb");
  assert.equal(requests, 2);
  const withoutKey = await titleExtras("movie", "tmdb:21", "cs", input());
  assert.equal(withoutKey.source, "addon");
  assert.equal(requests, 2);
});

test("concurrent extras requests share one pending TMDB build", async (t) => {
  fresh(t);
  let detailRequests = 0;
  let started!: () => void;
  const startedSignal = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const fetchImpl: FetchLike = async (raw) => {
    if (new URL(raw).pathname === "/3/movie/22") {
      detailRequests += 1;
      started();
      await released;
      return json({
        credits: { cast: [], crew: [] },
        recommendations: { results: [] },
        release_dates: { results: [] },
      });
    }
    throw new Error(`Unexpected URL ${raw}`);
  };

  const first = titleExtras("movie", "tmdb:22", "cs", deps(fetchImpl, {
    meta: async () => ({ id: "tt1", type: "movie", name: "First" }),
  }));
  await startedSignal;
  const second = titleExtras("movie", "tmdb:22", "cs", deps(fetchImpl, {
    meta: async () => ({ id: "tt1", type: "movie", name: "Second" }),
  }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(detailRequests, 1);
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((result) => result.source), ["tmdb", "tmdb"]);
  assert.equal(detailRequests, 1);
});

test("a successful TMDB part is shared across viewers while library membership is per viewer", async (t) => {
  fresh(t);
  let detailRequests = 0;
  let externalRequests = 0;
  let now = 5_000;
  const fetchImpl: FetchLike = async (raw) => {
    const url = new URL(raw);
    if (url.pathname === "/3/movie/88") {
      detailRequests += 1;
      return json({
        original_title: "Shared Film",
        original_language: "en",
        credits: { cast: [{ name: "Actor", order: 0 }], crew: [] },
        recommendations: { results: [{ id: 501, title: "Related", release_date: "2020-01-01" }] },
        release_dates: { results: [] },
      });
    }
    externalRequests += 1;
    return externalId(501);
  };
  const first = deps(fetchImpl, {
    now: () => now,
    meta: async () => ({ id: "tt1", type: "movie", name: "First viewer meta", imdbRating: "9.3" }),
    copies: async () => [{}],
  });
  const second = deps(fetchImpl, {
    now: () => now,
    meta: async () => ({ id: "tt1", type: "movie", name: "Second viewer meta", imdbRating: 8 }),
    copies: async () => [],
  });

  const withCopy = await titleExtras("movie", "tmdb:88", "cs", first);
  now += SUCCESS_TTL_MS - 1;
  const withoutCopy = await titleExtras("movie", "tmdb:88", "cs", second);

  assert.equal(detailRequests, 1);
  assert.equal(externalRequests, 1);
  assert.equal(withCopy.related[0]?.inLibrary, true);
  assert.equal(withoutCopy.related[0]?.inLibrary, undefined);
  assert.notEqual(withoutCopy.related[0], withCopy.related[0], "viewer membership is composed into new objects");
  assert.deepEqual(withoutCopy.people, withCopy.people);
  assert.equal(withCopy.ratings.imdb, "9.3");
  assert.equal(withoutCopy.ratings.imdb, "8.0", "the viewer's own metadata supplies IMDb");
  assert.notEqual(withoutCopy, withCopy, "the viewer-dependent answer is composed afresh");
});

test("originalTitle and originalLanguage come through whenever TMDB knows them", async (t) => {
  fresh(t);
  const result = await titleExtras("movie", "tmdb:9", "cs", deps(async () => json({
    original_title: "The Same Film",
    original_language: "en",
    credits: { cast: [], crew: [] },
    recommendations: { results: [] },
    release_dates: { results: [] },
  }), {
    meta: async () => ({ id: "tt1", type: "movie", name: "  the SAME film  " }),
  }));

  assert.equal(result.originalTitle, "The Same Film");
  assert.equal(result.originalLanguage, "en");
});

test("nextEpisode picks the earliest valid future episode from out-of-order metadata without TMDB", async (t) => {
  fresh(t);
  const current = Date.parse("2026-10-31T12:00:00Z");
  const result = await titleExtras("series", "tt1", "cs", {
    now: () => current,
    meta: async () => ({
      id: "tt1",
      type: "series",
      name: "Show",
      videos: [
        { season: 0, episode: 1, name: "Special", released: "2026-11-01T00:00:00Z" },
        { season: 1, episode: 1, title: "Past", released: "2026-10-01T00:00:00Z" },
        { season: 1, episode: 2, released: "not a date" },
        { season: 1, episode: 3, name: "Later", released: "2026-12-01T00:00:00Z" },
        { season: "2", number: "1", title: "Soonest", released: "2026-11-02T00:00:00Z" },
      ],
    }),
    copies: async () => [],
  });

  assert.deepEqual(result.nextEpisode, {
    season: 2,
    episode: 1,
    name: "Soonest",
    released: "2026-11-02T00:00:00Z",
  });
});

test("unknown title types answer an empty addon result", async (t) => {
  fresh(t);
  const meta: MetaItem = { id: "x", type: "channel", name: "Channel" };
  const result = await titleExtras("channel", "x", "cs", {
    meta: async () => meta,
    copies: async () => [],
  });
  assert.deepEqual(result, { people: [], related: [], ratings: {}, videos: [], source: "addon" });
});

test("an addon id without IMDb finds TMDB through the meta's imdb_id", async (t) => {
  fresh(t);
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (raw) => {
    const url = new URL(raw);
    calls.push(url.pathname);
    if (url.pathname === "/3/find/tt0241527") return json({ movie_results: [{ id: 671 }] });
    if (url.pathname === "/3/movie/671") {
      return json({ credits: { cast: [{ name: "Daniel Radcliffe", character: "Harry", order: 0 }], crew: [] }, recommendations: { results: [] }, release_dates: { results: [] } });
    }
    return json({}, 404);
  };
  const extras = await titleExtras("movie", "mpa:sosac:35da1549e221b6b74237", "cs", deps(fetchImpl, {
    meta: async () => ({ id: "mpa:sosac:35da1549e221b6b74237", type: "movie", name: "Harry Potter a Kámen mudrců", imdb_id: "tt0241527" }),
  }));
  assert.equal(extras.source, "tmdb");
  assert.equal(extras.people[0]?.name, "Daniel Radcliffe");
  assert.ok(calls.includes("/3/find/tt0241527"));
});
