import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMediaPath } from "./library-parse.js";

const parsed = (relative: string) => {
  const result = parseMediaPath(relative);
  return {
    title: result.title,
    query: result.query,
    year: result.year,
    hints: result.providerHints,
    season: result.season,
    episode: result.episode,
  };
};

test("the examples table is the parser spec", () => {
  assert.deepEqual(parsed("Practical Magic/Practical Magic.mkv"), {
    title: "Practical Magic", query: "Practical Magic", year: undefined, hints: undefined, season: undefined, episode: undefined,
  });
  assert.deepEqual(parsed("Father Ted"), {
    title: "Father Ted", query: "Father Ted", year: undefined, hints: undefined, season: undefined, episode: undefined,
  });
  assert.deepEqual(parsed("Movie Name (2019)/file.mkv"), {
    title: "Movie Name", query: "Movie Name", year: 2019, hints: undefined, season: undefined, episode: undefined,
  });
  assert.deepEqual(parsed("Show Name (2015) {imdb-tt123}"), {
    title: "Show Name", query: "Show Name", year: 2015, hints: { imdb: "tt123" }, season: undefined, episode: undefined,
  });
  assert.deepEqual(parsed("Name [tmdbid-123] [imdbid-tt456].mkv"), {
    title: "Name", query: "Name", year: undefined, hints: { tmdb: "123", imdb: "tt456" }, season: undefined, episode: undefined,
  });
  assert.deepEqual(parsed("Jižanská pohostinnost-Southern Comfort CZ dabing.Dobrodružný Válečný 1981.avi"), {
    title: "Jižanská pohostinnost-Southern Comfort",
    query: "Southern Comfort",
    year: 1981,
    hints: undefined,
    season: undefined,
    episode: undefined,
  });
  assert.deepEqual(parsed("The.Movie.2020.1080p.BluRay.x264-GROUP.mkv"), {
    title: "The Movie", query: "The Movie", year: 2020, hints: undefined, season: undefined, episode: undefined,
  });
  assert.deepEqual(parsed("Internal Affairs (2002)"), {
    title: "Internal Affairs", query: "Internal Affairs", year: 2002, hints: undefined, season: undefined, episode: undefined,
  });
  assert.deepEqual(parsed("The Cut (2014)"), {
    title: "The Cut", query: "The Cut", year: 2014, hints: undefined, season: undefined, episode: undefined,
  });
});

test("a dotted year next to 1080p is a year, digits inside 1080p are not", () => {
  assert.equal(parseMediaPath("The.Movie.2020.1080p.mkv").year, 2020);
  assert.equal(parseMediaPath("Show.1080p.mkv").year, undefined);
  assert.equal(parseMediaPath("Show.2160p.mkv").year, undefined);
});

test("digits glued to SxxExx are not a year", () => {
  const result = parseMediaPath("Show.S2020E01.mkv");
  assert.equal(result.year, undefined);
  assert.notEqual(result.title, "2020");
});

test("Plex and Jellyfin id tags are stripped", () => {
  assert.deepEqual(parseMediaPath("Title {tmdb-99} {tvdb-12}").providerHints, { tmdb: "99", tvdb: "12" });
  assert.deepEqual(parseMediaPath("Title [tvdbid-12]").providerHints, { tvdb: "12" });
  assert.equal(parseMediaPath("Title imdb-tt0816692").providerHints?.imdb, "tt0816692");
});

test("a hyphen without spaces splits a bilingual query", () => {
  const result = parseMediaPath("Jižanská pohostinnost-Southern Comfort");
  assert.equal(result.title, "Jižanská pohostinnost-Southern Comfort");
  assert.equal(result.query, "Southern Comfort");
});

test("a library id is not a parent folder", () => {
  const flat = parseMediaPath("lib_00000001/Heat.1995.1080p.BluRay.x264.mkv");
  assert.equal(flat.title, "Heat");
  assert.equal(flat.year, 1995);
  assert.equal(parseMediaPath("lib_00000001/Heat.mkv").title, "Heat");
  assert.equal(parseMediaPath("lib_00000001/Films/Heat.mkv").title, "Films");
  assert.equal(parseMediaPath("Films/Heat.mkv").title, "Films");
});

test("a folder that only looks like a library id still counts as a parent", () => {
  assert.equal(parseMediaPath("lib_zzzzzzzz/Heat.mkv").title, "lib zzzzzzzz");
  assert.equal(parseMediaPath("lib_0000001/Heat.mkv").title, "lib 0000001");
});

test("a library root folder keeps its own name", () => {
  assert.equal(parseMediaPath("lib_00000001/Heat (1995)").title, "Heat");
});
