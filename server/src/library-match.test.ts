import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  autoAccept, browseMeta, cacheFieldsFromMeta, clipText, dropKeyed, episodeKey, episodeNumberOf, episodesFromMeta, isExtraName,
  knownTitleOf, lookupSkipped, mosaicSkipped, matchKeyFor, pinInherited, matchStatus, needsBackfill, needsEpisodes, needsRefresh, pickSuggestion, remapKeyed, scanMiss,
  scannedRecently, scanSkipReason, scoreHit, suggestionFor, titleUnits, unmatchAt, viewMeta,
} from "./library-match.js";
import { parseMediaPath } from "./library-parse.js";
import type { FoundFile } from "./library.js";
import type { MetaItem } from "./types.js";

const file = (relative: string): FoundFile => ({ relative, size: 1, modified: "2026-01-01T00:00:00.000Z" });
const keys = (files: string[]) => titleUnits(files.map(file)).map((unit) => `${unit.kind}:${unit.key}`).sort();
const meta = (name: string, year: string | number | undefined, type: string, id = name): MetaItem => ({
  id, type, name, ...(year != null ? { releaseInfo: String(year) } : {}),
});

test("movie folder, season series, and an unrelated collection", () => {
  assert.deepEqual(
    keys(["Practical Magic/Practical Magic.mkv"]),
    ["movie:Practical Magic"],
  );
  assert.deepEqual(
    keys(["Father Ted/01 serie/01 - Good Luck, Father Ted.mkv"]),
    ["series:Father Ted"],
  );
  assert.deepEqual(
    keys(["xxx/one.mp4", "xxx/two.mp4", "xxx/I Prefer Anal/I Prefer Anal.mp4"]),
    [],
  );
});

test("a typed library keeps the boundaries and changes only the kind", () => {
  const files = ["Father Ted/01 serie/01 - Good Luck, Father Ted.mkv", "Interstellar.avi"].map(file);
  assert.deepEqual(
    titleUnits(files, "mixed").map((unit) => `${unit.kind}:${unit.key}`).sort(),
    ["movie:Interstellar.avi", "series:Father Ted"],
  );
  assert.deepEqual(
    titleUnits(files, "movie").map((unit) => `${unit.kind}:${unit.key}`).sort(),
    ["movie:Father Ted", "movie:Interstellar.avi"],
    "a season folder no longer turns the folder into a series",
  );
  assert.deepEqual(
    titleUnits(files, "series").map((unit) => `${unit.kind}:${unit.key}`).sort(),
    ["series:Father Ted", "series:Interstellar.avi"],
    "a loose file at the root is a series of one file",
  );
  assert.deepEqual(
    titleUnits(files, "series").map((unit) => unit.key),
    titleUnits(files).map((unit) => unit.key),
    "only the kind is forced, never the unit set",
  );
});

test("same-title copies and a trailer next to one movie are one movie unit", () => {
  assert.deepEqual(
    keys(["Obsession/Obsession.mkv", "Obsession/Obsession (2).mkv"]),
    ["movie:Obsession"],
  );
  assert.deepEqual(
    keys(["Movie/Movie.mkv", "Movie/Movie-trailer.mkv"]),
    ["movie:Movie"],
  );
  assert.equal(isExtraName("Movie-trailer.mkv"), true);
  assert.deepEqual(keys(["Trailers/sample.mkv", "Trailers/bonus.mkv"]), []);
});

test("flat SxxExx files in one folder are a series", () => {
  assert.deepEqual(
    keys(["Show/Show S01E01.mkv", "Show/Show S01E02.mkv"]),
    ["series:Show"],
  );
});

test("loose files at a container sit next to title folders", () => {
  const files = ["Interstellar.avi", "Practical Magic/Practical Magic.mkv"].map(file);
  const units = titleUnits(files);
  assert.deepEqual(units.map((unit) => `${unit.kind}:${unit.key}`).sort(), [
    "movie:Interstellar.avi",
    "movie:Practical Magic",
  ]);
  assert.equal(matchKeyFor("Interstellar.avi", files), "Interstellar.avi");
  assert.equal(matchKeyFor("Practical Magic/Practical Magic.mkv", files), "Practical Magic");
});

test("grouping folders recurse and leftover files are units", () => {
  const files = [
    "Webshare/Movies/Title/file.mkv",
    "Webshare/Movies/leftover.mkv",
  ].map(file);
  const units = titleUnits(files);
  assert.deepEqual(units.map((unit) => `${unit.kind}:${unit.key}`).sort(), [
    "movie:Webshare/Movies/Title",
    "movie:Webshare/Movies/leftover.mkv",
  ]);
  assert.equal(units.some((unit) => unit.key === "Movies" || unit.kind === "series" && unit.key.endsWith("Movies")), false);
  assert.equal(matchKeyFor("Webshare/Movies/Title/file.mkv", files), "Webshare/Movies/Title");
});

test("matchKeyFor walks from an episode to the show and from a collection child to itself", () => {
  const series = ["Father Ted/01 serie/01 - Good Luck, Father Ted.mkv"].map(file);
  assert.equal(matchKeyFor("Father Ted/01 serie/01 - Good Luck, Father Ted.mkv", series), "Father Ted");
  const dump = ["xxx/one.mp4", "xxx/two.mp4", "xxx/I Prefer Anal/I Prefer Anal.mp4"].map(file);
  assert.equal(matchKeyFor("xxx/one.mp4", dump), "xxx/one.mp4");
  assert.equal(matchKeyFor(path.join("xxx", "I Prefer Anal", "I Prefer Anal.mp4"), dump), path.join("xxx", "I Prefer Anal"));
});

test("a unique year-and-title hit auto-accepts; close years do not", () => {
  const parsed = parseMediaPath("Practical Magic");
  const hit = scoreHit(parsed, meta("Practical Magic", 1998, "movie", "tt0120794"), "movie");
  assert.ok(hit.titleSimilarity >= 0.9);
  assert.equal(autoAccept([hit])?.item.id, "tt0120794");

  const obsession = parseMediaPath("Obsession");
  const years = [1949, 1976, 2009].map((year, index) => scoreHit(obsession, meta("Obsession", year, "movie", `tt${index}`), "movie"));
  assert.equal(autoAccept(years, 2026), undefined);
  assert.equal(pickSuggestion(years)?.id, years.sort((a, b) => b.score - a.score)[0]!.item.id);
});

test("the same title with a current year wins over older namesakes", () => {
  const parsed = parseMediaPath("The Secret Woman");
  const hits = [
    scoreHit(parsed, meta("The Secret Woman", 2026, "movie", "tt37275992"), "movie"),
    scoreHit(parsed, meta("The Secret Woman", 1918, "movie", "tt0009595"), "movie"),
    scoreHit(parsed, meta("Secret Woman", 2023, "movie", "tt39106713"), "movie"),
  ];
  assert.equal(autoAccept(hits, 2026)?.item.id, "tt37275992");
});

test("a 15-point gap at score 85 auto-accepts the series", () => {
  const parsed = parseMediaPath("Father Ted");
  const show = scoreHit(parsed, meta("Father Ted", 1995, "series", "tt0111958"), "series");
  const special = scoreHit(parsed, meta("Father Ted Christmas Special", 1996, "movie", "tt012"), "series");
  assert.ok(show.score >= 85);
  assert.ok(show.score - special.score >= 15);
  assert.equal(autoAccept([show, special])?.item.id, "tt0111958");
});

test("a type mismatch is not auto-accepted", () => {
  const parsed = parseMediaPath("Brave (2012)");
  const wrong = scoreHit(parsed, meta("The Brave One", 2007, "movie", "tt"), "series");
  assert.equal(wrong.autoEligible, false);
  assert.equal(autoAccept([wrong]), undefined);
});

test("Cinemeta series releaseInfo 1995-1998 uses 1995", () => {
  const parsed = parseMediaPath("Father Ted");
  const hit = scoreHit(parsed, { id: "tt0111958", type: "series", name: "Father Ted", releaseInfo: "1995-1998" }, "series");
  assert.equal(hit.yearDelta, undefined);
  parsed.year = 1995;
  const withYear = scoreHit(parsed, { id: "tt0111958", type: "series", name: "Father Ted", releaseInfo: "1995-1998" }, "series");
  assert.equal(withYear.yearDelta, 0);
});

test("legacy libraryMeta rows are download and locked", () => {
  assert.deepEqual(viewMeta({ type: "movie", id: "tt1" }), {
    type: "movie", id: "tt1", source: "download", locked: true,
  });
  assert.equal(scanSkipReason({ type: "movie", id: "tt1" }), "bound");
  assert.equal(scanSkipReason({ type: "movie", id: "tt1", source: "scan", locked: false }), "bound");
  assert.equal(scanSkipReason({ type: "movie", id: "", source: "user", locked: true }), undefined);
  assert.equal(scanSkipReason({ type: "movie", id: "", source: "user", skipLookup: true }), "ignored");
  assert.equal(scanSkipReason(undefined), undefined);
});

test("a nameless catalog hit does not throw", () => {
  const parsed = parseMediaPath("The Secret Woman");
  const hit = scoreHit(parsed, { id: "x", type: "movie" } as MetaItem, "movie");
  assert.equal(hit.autoEligible, false);
  assert.equal(autoAccept([hit], 2026), undefined);
});

test("knownTitleOf ignores unmatch sentinels and walks parents", () => {
  const records = {
    "Father Ted": { type: "series", id: "tt0111958", name: "Father Ted", year: "1995" },
    "xxx": { type: "movie", id: "", source: "user" as const, skipLookup: true },
  };
  assert.equal(knownTitleOf("Father Ted/01 serie/01.mkv", records)?.id, "tt0111958");
  assert.equal(knownTitleOf("xxx/one.mp4", records), undefined);
  assert.equal(matchStatus("Father Ted", records), "matched");
  assert.equal(matchStatus("xxx", records), "rejected");
  assert.equal(matchStatus("orphan", records, { orphan: { type: "movie", id: "tt1", name: "Orphan", score: 90 } }), "suggested");
  assert.equal(matchStatus("missing", records), "unmatched");
});

test("unmatching one episode does not unmatch the rest of the series", () => {
  const records = {
    "Father Ted": { type: "series", id: "tt0111958", name: "Father Ted", year: "1995" },
  };
  const episode = "Father Ted/01 serie/01 - Good Luck, Father Ted.mkv";
  const other = "Father Ted/01 serie/02 - Entertaining Father Stone.avi";
  const next = unmatchAt(records, episode);
  assert.equal(knownTitleOf(episode, next), undefined);
  assert.equal(matchStatus(episode, next), "unmatched");
  assert.equal(knownTitleOf(other, next)?.id, "tt0111958");
  assert.equal(knownTitleOf("Father Ted", next)?.id, "tt0111958");
  assert.equal(unmatchAt(records, "Father Ted")["Father Ted"], undefined);
});

test("excluding a folder skips matching of its children", () => {
  const records = { Movies: { type: "movie", id: "", source: "user" as const, skipLookup: true } };
  assert.equal(lookupSkipped("Movies/Title", records), true);
  assert.equal(lookupSkipped("Movies", records), true);
  assert.equal(lookupSkipped("Other", records), false);
});

test("keeping a folder out of the mosaic covers everything below it", () => {
  const records = {
    Movies: { type: "movie", id: "", source: "user" as const, skipMosaic: true },
    "Movies/Extra": { type: "movie", id: "tt1", source: "user" as const },
  };
  assert.equal(mosaicSkipped("Movies/Extra/deep/one.mkv", records), true);
  assert.equal(mosaicSkipped("Movies", records), true);
  assert.equal(mosaicSkipped("Other", records), false);
});

test("keeping one file out of the mosaic leaves its neighbours alone", () => {
  const records = {
    Movies: { type: "movie", id: "", source: "user" as const },
    "Movies/one.mkv": { type: "movie", id: "tt1", source: "user" as const, skipMosaic: true },
  };
  assert.equal(mosaicSkipped("Movies/one.mkv", records), true);
  assert.equal(mosaicSkipped("Movies/two.mkv", records), false);
  assert.equal(mosaicSkipped("Movies", records), false);
});

test("clearing the folder flag stops covering its children and keeps their own", () => {
  const records = {
    Movies: { type: "movie", id: "", source: "user" as const, skipMosaic: true },
    "Movies/one.mkv": { type: "movie", id: "tt1", source: "user" as const, skipMosaic: true },
  };
  assert.equal(mosaicSkipped("Movies/two.mkv", records), true);
  const cleared = { ...records, Movies: { type: "movie", id: "", source: "user" as const } };
  assert.equal(mosaicSkipped("Movies/two.mkv", cleared), false);
  assert.equal(mosaicSkipped("Movies/one.mkv", cleared), true, "the child keeps its own flag");
});

test("browse meta reports the mosaic flag a key owns, not one it inherits", () => {
  const records = {
    Movies: { type: "movie", id: "", source: "user" as const, skipMosaic: true },
    "Movies/one.mkv": { type: "movie", id: "tt1", source: "user" as const, skipMosaic: true },
  };
  assert.equal(browseMeta("Movies", "Movies", records).skipMosaic, true);
  assert.equal(browseMeta("Movies/one.mkv", "one", records).skipMosaic, true);
  const inherited = { Movies: { type: "movie", id: "", source: "user" as const, skipMosaic: true } };
  assert.equal(browseMeta("Movies/one.mkv", "one", inherited).skipMosaic, undefined);
});

test("browse copy uses cached fields and a normalised catalog name", () => {
  const records = {
    "Practical Magic": { type: "movie", id: "tt1", name: "Practical Magic", year: "1998", description: "A witch." },
  };
  assert.deepEqual(browseMeta("Practical Magic", "Practical Magic", records), {
    match: "matched", year: "1998", description: "A witch.",
  });
  assert.equal(browseMeta("Practical Magic", "practical magic", records).catalogName, undefined);
  assert.equal(browseMeta("Practical Magic", "Kouzla", records).catalogName, "Practical Magic");
  assert.equal(needsBackfill({ type: "movie", id: "tt1" }), true);
  assert.equal(needsBackfill({ type: "movie", id: "tt1", name: "X", year: "1998" }), true);
  assert.equal(needsBackfill({ type: "movie", id: "tt1", name: "X", year: "1998", description: "Hi" }), false);
  assert.deepEqual(cacheFieldsFromMeta({ id: "tt1", type: "movie", name: "Film", releaseInfo: "2024", description: "Hi" }), {
    name: "Film", year: "2024", description: "Hi",
  });
});

test("only a bound series older than the TTL needs a refresh", () => {
  const ttl = 14 * 24 * 60 * 60_000;
  const now = Date.parse("2026-06-01T00:00:00.000Z");
  const old = new Date(now - ttl - 1).toISOString();
  const fresh = new Date(now - ttl + 1).toISOString();
  assert.equal(needsRefresh({ type: "series", id: "tt1" }, ttl, now), true, "a series without a refresh date is due");
  assert.equal(needsRefresh({ type: "series", id: "tt1", refreshedAt: old }, ttl, now), true);
  assert.equal(needsRefresh({ type: "series", id: "tt1", refreshedAt: fresh }, ttl, now), false);
  assert.equal(needsRefresh({ type: "movie", id: "tt1" }, ttl, now), false, "a movie carries all it will ever carry");
  assert.equal(needsRefresh({ type: "series", id: "" }, ttl, now), false, "an id-less sentinel is not a binding");
  assert.equal(needsRefresh(undefined, ttl, now), false);
});

test("suggestions remap and drop like libraryMeta", () => {
  const suggestions = { "Foo/Bar": { type: "movie", id: "tt1", name: "Foo", score: 90 } };
  assert.deepEqual(remapKeyed(suggestions, "Foo", "Baz")["Baz/Bar"]?.id, "tt1");
  assert.deepEqual(dropKeyed(suggestions, "Foo"), {});
});

const seriesMeta = (): MetaItem => ({
  id: "tt1", type: "series", name: "Father Ted", description: "A priest.",
  videos: [
    { season: 1, episode: 1, name: "Good Luck", overview: "The parochial house.", released: "1995-04-21", thumbnail: "https://art/1.jpg" },
    { season: 1, episode: 2, name: "Entertaining Father", overview: "A visitor.", released: "1995-04-28" },
  ],
});

test("episode rows are read out of the series meta", () => {
  const rows = episodesFromMeta(seriesMeta());
  assert.deepEqual(rows[episodeKey("series", "tt1", 1, 1)], {
    season: 1, episode: 1, name: "Good Luck", description: "The parochial house.",
    released: "1995-04-21", thumbnail: "https://art/1.jpg",
  });
  assert.equal(rows[episodeKey("series", "tt1", 1, 2)]?.thumbnail, undefined);
  assert.deepEqual(episodesFromMeta({ id: "tt1", type: "series", name: "X" }), {});
});

test("episode numbering comes from the file name, then from the season folder", () => {
  assert.deepEqual(episodeNumberOf("Ted/Ted.S01E02.mkv"), { season: 1, episode: 2 });
  assert.deepEqual(episodeNumberOf("Ted/Ted 1x03.mkv"), { season: 1, episode: 3 });
  assert.deepEqual(episodeNumberOf(path.join("Ted", "Serie 2", "04 - Nazev.mkv")), { season: 2, episode: 4 });
  assert.equal(episodeNumberOf("Film (2024)/Film.mkv"), undefined);
  assert.deepEqual(episodeNumberOf("Ted/anything.mkv", { type: "series", id: "tt1", season: 3, episode: 7 }), { season: 3, episode: 7 });
});

test("each episode of a bound series gets its own copy, never the series plot", () => {
  const records = { Ted: { type: "series", id: "tt1", name: "Father Ted", year: "1995", description: "A priest." } };
  const episodes = episodesFromMeta(seriesMeta());
  const first = browseMeta(path.join("Ted", "Ted.S01E01.mkv"), "Ted.S01E01", records, {}, episodes);
  const second = browseMeta(path.join("Ted", "Ted.S01E02.mkv"), "Ted.S01E02", records, {}, episodes);
  assert.equal(first.description, "The parochial house.");
  assert.equal(second.description, "A visitor.");
  assert.equal(first.catalogName, "Good Luck");
  assert.equal(first.year, "1995");
  assert.deepEqual([first.season, first.episode], [1, 1]);
  // An episode nobody cached says nothing rather than repeating the series plot.
  const unknown = browseMeta(path.join("Ted", "Ted.S09E09.mkv"), "Ted.S09E09", records, {}, episodes);
  assert.equal(unknown.description, undefined);
  assert.equal(unknown.match, "matched");
  // The series folder itself still carries it.
  assert.equal(browseMeta("Ted", "Ted", records, {}, episodes).description, "A priest.");
  // And so does no season folder under it.
  assert.equal(browseMeta(path.join("Ted", "Serie 1"), "Serie 1", records, {}, episodes).description, undefined);
});

test("a file bound to one episode wins over the numbering in its name", () => {
  const key = path.join("Ted", "whatever.mkv");
  const records = {
    Ted: { type: "series", id: "tt1", name: "Father Ted" },
    [key]: { type: "series", id: "tt1", source: "user" as const, season: 1, episode: 2 },
  };
  const view = browseMeta(key, "whatever", records, {}, episodesFromMeta(seriesMeta()));
  assert.equal(view.description, "A visitor.");
  assert.deepEqual([view.season, view.episode], [1, 2]);
});

test("unmatching a file inside a matched folder leaves a sentinel, not the parent binding", () => {
  const key = path.join("Ted", "a.mkv");
  const records = {
    Ted: { type: "series", id: "tt1" },
    [key]: { type: "series", id: "tt2", source: "user" as const },
  };
  const next = unmatchAt(records, key);
  assert.equal(next[key]?.id, "");
  assert.equal(knownTitleOf(key, next), undefined);
  assert.equal(knownTitleOf(path.join("Ted", "b.mkv"), next)?.id, "tt1");
  // Exclusion from matching survives the unmatch.
  const excluded = unmatchAt({ ...records, [key]: { type: "movie", id: "tt2", skipLookup: true } }, key);
  assert.equal(excluded[key]?.skipLookup, true);
});

test("a weak hit is no suggestion and a fruitless search is remembered", () => {
  const parsed = parseMediaPath("Nazev filmu (2024)");
  const weak = pickSuggestion([scoreHit(parsed, { id: "tt9", type: "movie", name: "Something else entirely" })]);
  assert.equal(weak, undefined);
  const miss = scanMiss("movie");
  assert.equal(scannedRecently(miss), true);
  assert.equal(scannedRecently(miss, 1, Date.now() + 10), false);
  assert.equal(scannedRecently(undefined), false);
  assert.equal(matchStatus("Foo", {}, { Foo: miss }), "unmatched");
  assert.equal(suggestionFor("Foo", { Foo: miss }), undefined);
  const real = { type: "movie", id: "tt1", name: "Film", score: 90 };
  assert.equal(matchStatus(path.join("Foo", "a.mkv"), {}, { Foo: real }), "suggested");
  assert.deepEqual(browseMeta(path.join("Foo", "a.mkv"), "a", {}, { Foo: real }).suggestion, real);
});

test("a description is cut on a word boundary and a finished backfill holds", () => {
  const long = `${"slovo ".repeat(400)}konec`;
  const stored = cacheFieldsFromMeta({ id: "tt1", type: "movie", name: "Film", description: long }).description!;
  assert.ok(stored.length <= 1201);
  assert.ok(stored.endsWith("…"));
  assert.equal(stored.includes("slov…"), false);
  assert.equal(clipText("kratky popis", 100), "kratky popis");
  const at = new Date().toISOString();
  assert.equal(needsBackfill({ type: "movie", id: "tt1", backfilledAt: at }), false);
  assert.equal(needsBackfill({ type: "movie", id: "tt1", backfilledAt: "2000-01-01T00:00:00.000Z" }), true);
  assert.equal(needsEpisodes({ type: "series", id: "tt1" }, { season: 1, episode: 1 }, {}), true);
  assert.equal(needsEpisodes({ type: "series", id: "tt1" }, { season: 1, episode: 1 }, episodesFromMeta(seriesMeta())), false);
  assert.equal(needsEpisodes({ type: "movie", id: "tt1" }, undefined, {}), false);
});

const join = (...parts: string[]) => parts.join(path.sep);

test("a moved file takes the title it inherited from the folder it leaves", () => {
  const meta = { "Přátelé": { type: "series", id: "tt0108778", source: "user" as const, locked: true, name: "Přátelé" } };
  const from = join("Přátelé", "01.mkv");
  const to = join("xxx", "01.mkv");
  const pinned = pinInherited(meta, {}, from, to);
  assert.deepEqual(pinned.meta[from], meta["Přátelé"], "the binding becomes the file's own before the move");
  const moved = remapKeyed(pinned.meta, from, to);
  assert.equal(knownTitleOf(to, moved)?.id, "tt0108778");
});

test("a move inside the matched folder does not pin anything", () => {
  const meta = { "Přátelé": { type: "series", id: "tt0108778", source: "user" as const } };
  const from = join("Přátelé", "01 serie", "01.mkv");
  const to = join("Přátelé", "01.mkv");
  assert.deepEqual(pinInherited(meta, {}, from, to).meta, meta, "the folder still covers the new path");
});

test("the destination's title does not take over a moved item", () => {
  const meta = {
    "Přátelé": { type: "series", id: "tt0108778", source: "user" as const },
    "Filmy": { type: "movie", id: "tt0111161", source: "user" as const },
  };
  const from = join("Přátelé", "01.mkv");
  const to = join("Filmy", "01.mkv");
  const moved = remapKeyed(pinInherited(meta, {}, from, to).meta, from, to);
  assert.equal(knownTitleOf(to, moved)?.id, "tt0108778", "its own row wins over the folder it lands in");
  assert.equal(knownTitleOf(join("Filmy", "jiný.mkv"), moved)?.id, "tt0111161", "the neighbours keep the folder's title");
});

test("a suggestion and a switched-off lookup travel with the item too", () => {
  const meta = { "Ignorované": { type: "movie", id: "", source: "user" as const, skipLookup: true } };
  const suggestions = { "Ignorované": { type: "movie", id: "tt1", name: "Něco", score: 80, at: "2026-01-01T00:00:00.000Z" } };
  const from = join("Ignorované", "klip.mkv");
  const to = join("xxx", "klip.mkv");
  const pinned = pinInherited(meta, suggestions, from, to);
  assert.equal(pinned.meta[from]?.skipLookup, true);
  assert.equal(lookupSkipped(to, remapKeyed(pinned.meta, from, to)), true);
  assert.equal(suggestionFor(to, remapKeyed(pinned.suggestions, from, to))?.id, "tt1");
});

test("an item kept out of the mosaic takes the flag from the folder it leaves", () => {
  const meta = { "Skryté": { type: "movie", id: "", source: "user" as const, skipMosaic: true } };
  const from = join("Skryté", "klip.mkv");
  const to = join("xxx", "klip.mkv");
  const pinned = pinInherited(meta, {}, from, to);
  assert.equal(pinned.meta[from]?.skipMosaic, true);
  assert.equal(mosaicSkipped(to, remapKeyed(pinned.meta, from, to)), true);
});

test("an unmatched item inherits nothing and stays unmatched where it lands", () => {
  const meta = { "Filmy": { type: "movie", id: "tt0111161", source: "user" as const } };
  const from = "volný.mkv";
  const to = join("Filmy", "volný.mkv");
  const pinned = pinInherited(meta, {}, from, to);
  assert.deepEqual(pinned.meta, meta, "nothing covered it, so nothing is pinned");
});
