import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  autoAccept, browseMeta, cacheFieldsFromMeta, clipText, dropKeyed, episodeKey, episodeNumberOf, episodesFromMeta, isExtraName,
  folderMosaicUnits, knownTitleOf, knownTitleForUnit, lookupSkipped, mosaicSkipped, matchKeyFor, mosaicIdentities, needsReevaluation, parseUnit, pendingSuggestionKeys, pinInherited, matchStatus, needsBackfill, needsEpisodes, needsRefresh, pickSuggestion, remapKeyed, scanMiss, unitFor,
  scannedRecently, scanSkipReason, scoreHit, staleSuggestionKeys, suggestionFor, titleUnits, unmatchAt, viewMeta,
  MATCH_RULE_VERSION, type LibrarySuggestion, type TitleUnit,
} from "./library-match.js";
import { parseMediaPath, partSignature } from "./library-parse.js";
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
    ["movie:xxx/I Prefer Anal", "movie:xxx/one.mp4", "movie:xxx/two.mp4"],
    "a folder of unrelated films exposes each identity on its own file name",
  );
});

test("a multipart film and its extra are one identity, not three films", () => {
  const twilight = [
    "Twilight Saga/Twilight/dmd-twilight-cd1.mkv",
    "Twilight Saga/Twilight/dmd-twilight-cd2.mkv",
    "Twilight Saga/Twilight/Twilight.2009.Deleted.Scene.mkv",
  ];
  const units = titleUnits(twilight.map(file));
  assert.deepEqual(units.map((unit) => `${unit.kind}:${unit.key}`), ["movie:Twilight Saga/Twilight"]);
  assert.equal(units[0]!.sampleFiles.length, 3, "the extra stays with the film it belongs to");

  // Adding or removing another part leaves the one identity alone.
  const withEncode = [...twilight, "Twilight Saga/Twilight/dmd-twilight-cd3.mkv"];
  assert.deepEqual(titleUnits(withEncode.map(file)).map((unit) => unit.key), ["Twilight Saga/Twilight"]);
  const withoutEncode = twilight.filter((name) => !name.includes("cd2"));
  assert.deepEqual(titleUnits(withoutEncode.map(file)).map((unit) => unit.key), ["Twilight Saga/Twilight"]);
});

test("independent films, encodes and parts in one folder keep one identity each", () => {
  const files = [
    "Dump/First Movie (2001).mkv",
    "Dump/First Movie (2001) 1080p.mkv",
    "Dump/Second Film Part 1.mkv",
    "Dump/Second Film Part 2.mkv",
    "Dump/Third.Film.2010.Extended.mkv",
  ].map(file);
  const units = titleUnits(files);
  assert.equal(units.length, 3, "three distinct films, not five files");
  const first = units.find((unit) => unit.sampleFiles.some((name) => name.includes("First Movie")));
  assert.equal(first?.sampleFiles.length, 2, "the two encodes are one film");
  const second = units.find((unit) => unit.key.startsWith("Dump/Second"));
  assert.equal(second?.sampleFiles.length, 2, "the two parts are one film");
  assert.ok(units.find((unit) => unit.sampleFiles.some((name) => name.includes("Third.Film"))));
});

test("a series stays grouped by series, season and episode", () => {
  const files = [
    "Show/Season 1/Show S01E01.mkv",
    "Show/Season 1/Show S01E02.mkv",
    "Show/Season 2/Show S02E01.mkv",
  ].map(file);
  assert.deepEqual(titleUnits(files).map((unit) => `${unit.kind}:${unit.key}`), ["series:Show"]);
  assert.equal(titleUnits(files)[0]!.sampleFiles.length, 3);
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

test("a unit is searched by its own name: the film for a loose file, the folder for an encode set", () => {
  // An independent film sitting in a collection folder is searched as the film, not as the
  // folder that happens to hold it.
  const dump = ["Collection/Heat (1995).mkv", "Collection/Ronin (1998).mkv"].map(file);
  const units = titleUnits(dump);
  const heat = units.find((unit) => unit.key.includes("Heat"))!;
  assert.equal(heat.key, "Collection/Heat (1995).mkv");
  assert.deepEqual(parseUnit(heat), { title: "Heat", query: "Heat", year: 1995 });
  // A folder named for a film keeps the folder title even when the files inside are encodes.
  const encoded = [
    "Practical Magic (1998)/Practical.Magic.1080p.mkv",
    "Practical Magic (1998)/Practical.Magic.1080p (2).mkv",
  ].map(file);
  const [folderUnit] = titleUnits(encoded);
  assert.equal(folderUnit!.key, "Practical Magic (1998)");
  assert.deepEqual(parseUnit(folderUnit!), { title: "Practical Magic", query: "Practical Magic", year: 1998 });
});

test("every sample file of a unit resolves to that unit, not to its own path", () => {
  const files = [
    "Twilight Saga/Twilight/dmd-twilight-cd1.mkv",
    "Twilight Saga/Twilight/dmd-twilight-cd2.mkv",
    "Twilight Saga/Twilight/Twilight.2009.Deleted.Scene.mkv",
  ].map(file);
  const units = titleUnits(files);
  assert.equal(units.length, 1);
  const [unit] = units;
  assert.equal(unitFor(unit!.sampleFiles[0]!, units)?.key, unit!.key);
  assert.equal(matchKeyFor(unit!.sampleFiles[1]!, files), unit!.key, "an alternate part resolves to the film");
  assert.equal(matchKeyFor(unit!.sampleFiles[2]!, files), unit!.key, "the extra resolves to the film too");
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

test("a record in another language than the wanted one is stale again", () => {
  const full = { type: "movie", id: "tt1", name: "X", year: "1998", description: "Hi" };
  assert.equal(needsBackfill({ ...full, metaLanguage: "en" }, undefined, "cs"), true);
  assert.equal(needsBackfill({ ...full, metaLanguage: "en" }, undefined, "en"), false);
  assert.equal(needsBackfill(full, undefined, "cs"), true);
  assert.equal(needsBackfill(full, undefined, undefined), false);
  const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
  assert.equal(needsBackfill({ ...full, metaLanguage: "en", backfilledAt: hourAgo }, undefined, "cs"), false);
});

test("the language of the meta is cached with the fields it filled", () => {
  assert.deepEqual(cacheFieldsFromMeta({ id: "tt1", type: "movie", name: "Film", nameLanguage: "cs" }), { name: "Film", metaLanguage: "cs" });
  assert.deepEqual(cacheFieldsFromMeta({ id: "tt1", type: "movie", name: "Film" }), { name: "Film" });
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

test("pendingSuggestionKeys keeps what the scan proposed and nobody confirmed", () => {
  const records = {
    "Films/Heat": { type: "movie", id: "tt0113277" },
    "Films/Ignored": { type: "movie", id: "", source: "user" as const, skipLookup: true },
  };
  const suggestions = {
    "Films/Heat": { type: "movie", id: "tt0113277", name: "Heat", score: 92 },
    "Films/Ignored": { type: "movie", id: "tt0118688", name: "Batman & Robin", score: 80 },
    "Films/Ronin": { type: "movie", id: "tt0122690", name: "Ronin", score: 88 },
    "Films/Nothing": { type: "movie", id: "", name: "", score: 0 },
  };

  assert.deepEqual(pendingSuggestionKeys(records, suggestions), ["Films/Ronin"]);
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

test("browse meta says how many pictures a title's gallery holds, and nothing where it holds none", () => {
  const withGallery = {
    "Movies/one.mkv": {
      type: "movie", id: "tt1", source: "download" as const,
      gallery: [{ kind: "poster" as const, shape: "poster" as const }, { kind: "still" as const, shape: "wide" as const }],
    },
  };
  assert.equal(browseMeta("Movies/one.mkv", "one", withGallery).gallery, 2);
  const without = { "Movies/one.mkv": { type: "movie", id: "tt1", source: "download" as const } };
  assert.equal(browseMeta("Movies/one.mkv", "one", without).gallery, undefined);
  // A title bound through its folder does not lend its gallery to the files inside it: the
  // pictures are stored under the key that owns them.
  const folder = { Movies: { type: "movie", id: "tt1", source: "download" as const, gallery: [{ kind: "logo" as const, shape: "wide" as const }] } };
  assert.equal(browseMeta("Movies/one.mkv", "one", folder).gallery, undefined);
});

/** A hit built by hand, for the branches no amount of real title text reaches. */
const rawHit = (id: string, name: string, score: number, titleSimilarity = 1, autoEligible = true, yearDelta?: number) =>
  ({ item: { id, type: "movie", name } as MetaItem, score, titleSimilarity, autoEligible, ...(yearDelta != null ? { yearDelta } : {}) });

test("a proposal says why a high score still wants a look", () => {
  // The Avengers: one exact name and a sequel the score already separates. The file names no
  // year, so there is no year to check and nothing else to explain.
  const parsed = parseMediaPath("Avengers");
  const avengers = scoreHit(parsed, meta("The Avengers", 2012, "movie", "tt0848228"), "movie");
  const ultron = scoreHit(parsed, meta("Avengers: Age of Ultron", 2015, "movie", "tt2395427"), "movie");
  assert.equal(avengers.score, 100);
  const proposal = pickSuggestion([avengers, ultron]);
  assert.equal(proposal?.id, "tt0848228");
  assert.equal(proposal?.reason, undefined, "a missing file year is not a year to check");

  const ambiguous = pickSuggestion([rawHit("tt1", "Avengers", 100), rawHit("tt2", "Avengers Assemble", 96, 0.95)]);
  assert.equal(ambiguous?.reason, "ambiguous");

  const settled = parseMediaPath("Practical Magic (1998)");
  const exact = scoreHit(settled, meta("Practical Magic", 1998, "movie", "tt0120794"), "movie");
  assert.equal(pickSuggestion([exact])?.reason, undefined, "nothing to explain when the year agrees");

  // A year the file states and the candidate disagrees with is the one real year conflict.
  const offByOne = parseMediaPath("Heat (1996)");
  const previous = scoreHit(offByOne, meta("Heat", 1995, "movie", "tt0113277"), "movie");
  assert.equal(pickSuggestion([previous])?.reason, "year");
});

test("the displayed title similarity is independent of the year-adjusted ranking score", () => {
  const parsed = parseMediaPath("Heat (1996)");
  const oneYearOff = scoreHit(parsed, meta("Heat", 1995, "movie", "tt0113277"), "movie");
  const proposal = pickSuggestion([oneYearOff]);
  assert.equal(proposal?.score, 90, "the existing ranking still applies its year penalty");
  assert.equal(proposal?.titleSimilarity, 100, "the UI can report the name-only percentage accurately");
});

test("a proposal carries the candidate's own poster and nothing when it has none", () => {
  const parsed = parseMediaPath("Flashdance (1983)");
  const withPoster = scoreHit(parsed, { id: "tt0085549", type: "movie", name: "Flashdance", releaseInfo: "1983", poster: "https://art/f.jpg" }, "movie");
  assert.equal(pickSuggestion([withPoster])?.poster, "https://art/f.jpg");
  const without = scoreHit(parsed, meta("Flashdance", 1983, "movie", "tt0085549"), "movie");
  assert.equal("poster" in (pickSuggestion([without]) ?? {}), false);
});

test("a wrong-type or strongly conflicting-year candidate is not offered as a safe match", () => {
  const parsed = parseMediaPath("Brave (2012)");
  const wrong = scoreHit(parsed, meta("Brave", 2012, "movie", "tt1217209"), "series");
  assert.equal(pickSuggestion([wrong]), undefined);
  const farOff = scoreHit(parsed, meta("Brave", 1930, "movie", "tt0000001"), "movie");
  assert.equal(farOff.autoEligible, false);
  assert.equal(pickSuggestion([farOff]), undefined);
});

test("a correction of an unlocked automatic binding is a pending key, an ordinary one is not", () => {
  const records = {
    "Films/Ronin": { type: "movie", id: "tt0122690", source: "scan" as const, locked: false },
    "Films/User": { type: "movie", id: "tt-user", source: "user" as const },
    "Films/Locked": { type: "movie", id: "tt-locked", source: "scan" as const, locked: true },
    "Films/Heat": { type: "movie", id: "tt0113277", source: "scan" as const, locked: false },
  };
  const suggestions = {
    "Films/Ronin": { type: "movie", id: "tt1111111", name: "Ronin", score: 95, reason: "correction" as const, replacesId: "tt0122690", replacesName: "Ronin (old)" },
    "Films/User": { type: "movie", id: "tt2", name: "User pick", score: 90, reason: "correction" as const, replacesId: "tt-user" },
    "Films/Locked": { type: "movie", id: "tt3", name: "Locked pick", score: 90, reason: "correction" as const, replacesId: "tt-locked" },
    "Films/Heat": { type: "movie", id: "tt0113277", name: "Heat", score: 92 },
  };

  assert.deepEqual(pendingSuggestionKeys(records, suggestions), ["Films/Ronin"]);
});

test("a finished scan drops the proposals whose title unit is gone, and only those", () => {
  const units: TitleUnit[] = [
    { key: "lib_aaaaaaaa/Films/Ronin", kind: "movie", relative: "Films/Ronin", sampleFiles: [] },
    { key: "lib_aaaaaaaa/Shows/Ted", kind: "series", relative: "Shows/Ted", sampleFiles: [] },
  ];
  const suggestions: Record<string, LibrarySuggestion> = {
    "lib_aaaaaaaa/Films/Ronin": { type: "movie", id: "tt0122690", name: "Ronin", score: 88 },
    "lib_aaaaaaaa/Films/Removed": { type: "movie", id: "tt999", name: "Removed", score: 99 },
    "lib_aaaaaaaa/Shows/Ted/01.mkv": { type: "series", id: "tt0111958", name: "Father Ted", score: 91 },
    // A library that is away keeps everything it remembers.
    "lib_bbbbbbbb/Films/Gone": { type: "movie", id: "tt1", name: "Gone", score: 90 },
  };

  assert.deepEqual(
    staleSuggestionKeys(suggestions, units, new Set(["lib_aaaaaaaa"])),
    ["lib_aaaaaaaa/Films/Removed"],
  );
  assert.deepEqual(
    staleSuggestionKeys(suggestions, [], new Set(["lib_aaaaaaaa", "lib_bbbbbbbb"])).sort(),
    ["lib_aaaaaaaa/Films/Removed", "lib_aaaaaaaa/Films/Ronin", "lib_aaaaaaaa/Shows/Ted/01.mkv", "lib_bbbbbbbb/Films/Gone"],
    "the scan speaks about a library it can reach, and about nothing else",
  );
});

test("a candidate is judged on its original title as well as its localized one", () => {
  const czech = parseMediaPath("Sirotcinec");
  const localized = scoreHit(czech, { id: "tt1", type: "movie", name: "The Orphanage", originalTitle: "El Orfanato" }, "movie");
  const original = scoreHit(czech, { id: "tt2", type: "movie", name: "Sedm statečných", originalTitle: "Sirotčinec" }, "movie");
  assert.ok(localized.score < 60, "no phrase in common is no evidence, so the row is not even a proposal");
  assert.equal(pickSuggestion([localized]), undefined);
  assert.ok(original.titleSimilarity >= 0.9, "the original title carries the match");
  assert.equal(autoAccept([original])?.item.id, "tt2");
});

test("a token coincidence is not title evidence", () => {
  const wallE = parseMediaPath("WALL-E");
  const wallGame = scoreHit(wallE, meta("Eton Wall Game", 2017, "movie", "tt1"), "movie");
  assert.ok(wallGame.score < 60, "a shared word is not title evidence");
  assert.equal(pickSuggestion([wallGame]), undefined, "WALL-E is not Eton Wall Game");
  const real = scoreHit(wallE, meta("WALL-E", 2008, "movie", "tt0910970"), "movie");
  assert.equal(autoAccept([real])?.item.id, "tt0910970");

  const orphanage = parseMediaPath("Sirotčinec");
  assert.equal(pickSuggestion([scoreHit(orphanage, meta("Semi-Pro", 2008, "movie", "tt2"), "movie")]), undefined);
});

test("sequel and part markers are evidence, and a conflict is never auto-accepted", () => {
  const partOne = parseMediaPath("Second Film Part 1");
  const partTwo = scoreHit(partOne, meta("Second Film Part 2", 2004, "movie", "tt2"), "movie");
  assert.equal(partTwo.partConflict, true);
  assert.equal(partTwo.autoEligible, false);
  assert.equal(autoAccept([partTwo]), undefined, "a different part is a different film");
  assert.equal(pickSuggestion([partTwo])?.reason, "part");

  const whole = parseMediaPath("Second Film");
  const sequel = scoreHit(whole, meta("Second Film 2", 2006, "movie", "tt3"), "movie");
  assert.equal(sequel.partConflict, true);
  const first = scoreHit(whole, meta("Second Film", 2004, "movie", "tt1"), "movie");
  assert.equal(first.partConflict, undefined);
  assert.equal(autoAccept([first, sequel])?.item.id, "tt1");
});

test("a missing year on both sides leans on the name alone", () => {
  const parsed = parseMediaPath("Some Obscure Film");
  const hit = scoreHit(parsed, { id: "tt9", type: "movie", name: "Some Obscure Film" }, "movie");
  assert.equal(hit.yearDelta, undefined);
  assert.equal(hit.score, 100);
  assert.equal(autoAccept([hit])?.item.id, "tt9");
});

test("a Czech part marker is read, and two parts stay two films", () => {
  assert.notEqual(partSignature("Nymfomanka - část 1"), "", "the Czech word for a part is a part marker");
  assert.equal(partSignature("Nymfomanka díl 3"), partSignature("Nymfomanka cast 3"), "the plain spelling counts too");
  assert.notEqual(partSignature("Nymfomanka - část 1"), partSignature("Nymfomanka, část II"), "the two halves carry different markers");

  const first = parseMediaPath("Nymfomanka - část 1");
  const second = scoreHit(first, meta("Nymfomanka, část II.", 2009, "movie", "tt-part-2"), "movie");
  assert.equal(second.partConflict, true, "the two halves are not one film");
  assert.equal(second.autoEligible, false);
  assert.equal(autoAccept([second]), undefined);
  assert.equal(pickSuggestion([second])?.reason, "part");
});

test("same-title remakes stay a proposal: their ambiguity names them, a lone exact title says nothing", () => {
  // The Dictator, 1940 and 2012, and the file never wrote a year down.
  const parsed = parseMediaPath("Diktátor");
  const hits = [
    scoreHit(parsed, meta("Diktátor", 1940, "movie", "tt-old"), "movie"),
    scoreHit(parsed, meta("Diktátor", 2012, "movie", "tt-new"), "movie"),
  ];
  assert.equal(autoAccept(hits, 2026), undefined, "two same-name remakes are not bound on their own");
  const proposal = pickSuggestion(hits);
  assert.equal(proposal?.reason, "ambiguous", "the missing year is not itself the reason");
  assert.equal(proposal?.titleSimilarity, 100, "the number beside the row stays name-only");
  const named = [proposal?.id, ...(proposal?.alternatives ?? []).map((item) => item.id)].sort();
  assert.deepEqual(named, ["tt-new", "tt-old"], "both remakes are named");

  // A lone exact title with no year on either side is not a review item at all.
  const lone = parseMediaPath("Some Obscure Film");
  const only = scoreHit(lone, { id: "tt9", type: "movie", name: "Some Obscure Film" }, "movie");
  assert.equal(pickSuggestion([only])?.reason, undefined);
  assert.equal(pickSuggestion([only])?.id, "tt9");
});

test("an ambiguous proposal carries its competing candidates, bounded and without payloads", () => {
  const parsed = parseMediaPath("Avengers");
  const hits = [
    scoreHit(parsed, meta("The Avengers", 2012, "movie", "tt0848228"), "movie"),
    scoreHit(parsed, meta("Avengers: Age of Ultron", 2015, "movie", "tt2395427"), "movie"),
    scoreHit(parsed, meta("Avengers: Endgame", 2019, "movie", "tt4154796"), "movie"),
  ];
  const proposal = pickSuggestion(hits)!;
  assert.ok(proposal.alternatives?.length, "the competing identities are named");
  const allowed = new Set(["type", "id", "name", "year", "score", "titleSimilarity"]);
  for (const alternative of proposal.alternatives ?? []) {
    for (const key of Object.keys(alternative)) {
      assert.ok(allowed.has(key), `${key} is not part of a bounded alternative`);
    }
    assert.equal("poster" in alternative, false, "no image address is persisted");
  }
  assert.ok((proposal.alternatives?.length ?? 0) <= 3, "the list stays bounded");
});

test("a suggestion carries the rule version and a stale one asks to be re-evaluated", () => {
  const parsed = parseMediaPath("Practical Magic (1998)");
  const proposal = pickSuggestion([scoreHit(parsed, meta("Practical Magic", 1998, "movie", "tt0120794"), "movie")])!;
  assert.equal(proposal.rule, MATCH_RULE_VERSION);
  assert.equal(needsReevaluation(proposal), false);
  assert.equal(needsReevaluation({ ...proposal, rule: MATCH_RULE_VERSION - 1 }), true);
  assert.equal(needsReevaluation({ ...proposal, rule: undefined }), true, "a row from before the field existed is stale");
  assert.equal(needsReevaluation(scanMiss("movie")), false, "a fresh miss is current");
  assert.equal(needsReevaluation({ ...scanMiss("movie"), rule: MATCH_RULE_VERSION - 1 }), true);
  assert.equal(needsReevaluation(scanMiss("movie", undefined, true)), false, "a dismissal is never stale");
  assert.equal(needsReevaluation(undefined), false);
});

test("a collection mosaic shows one poster per distinct film identity", () => {
  const entries = [
    { key: "lib/Films/A", meta: { type: "movie", id: "tt1" } },
    { key: "lib/Films/A-copy", meta: { type: "movie", id: "tt1" } },
    { key: "lib/Films/B", meta: { type: "movie", id: "tt2" } },
    { key: "lib/Films/Loose", meta: undefined },
    { key: "lib/Films/Loose" },
    { key: "lib/Films/C", meta: { type: "movie", id: "tt3" } },
    { key: "lib/Films/D", meta: { type: "movie", id: "tt4" } },
  ];
  assert.deepEqual(mosaicIdentities(entries, 5).map((entry) => entry.key), [
    "lib/Films/A", "lib/Films/B", "lib/Films/Loose", "lib/Films/C", "lib/Films/D",
  ]);
});

test("a folder mosaic names each distinct film once, honours the exclusion flag, and skips a series", () => {
  const files = [
    "lib_00000001/Collection/Heat (1995).mkv",
    "lib_00000001/Collection/Heat (1995) 1080p.mkv",
    "lib_00000001/Collection/Ronin (1998).mkv",
    "lib_00000001/Series/Season 1/Show S01E01.mkv",
  ].map(file);
  const units = titleUnits(files);
  const records = {
    "lib_00000001/Collection/Heat (1995).mkv": { type: "movie", id: "tt-heat", source: "scan" as const },
    "lib_00000001/Collection/Heat (1995) 1080p.mkv": { type: "movie", id: "tt-heat", source: "scan" as const },
    "lib_00000001/Collection/Ronin (1998).mkv": { type: "movie", id: "tt-ronin", source: "scan" as const },
  };
  const collection = folderMosaicUnits(units, "lib_00000001/Collection", records, {}, 5);
  assert.equal(collection.length, 2, "the two encodes of Heat are one identity, Ronin is the other");
  assert.deepEqual(collection.map((unit) => records[unit.key as keyof typeof records]?.id).sort(), ["tt-heat", "tt-ronin"]);
  assert.deepEqual(folderMosaicUnits(units, "lib_00000001/Series", records, {}, 5), [], "a series is not a movie mosaic");

  const hidden = { ...records, "lib_00000001/Collection/Ronin (1998).mkv": { type: "movie", id: "tt-ronin", source: "scan" as const, skipMosaic: true } };
  assert.equal(folderMosaicUnits(units, "lib_00000001/Collection", hidden, {}, 5).length, 1, "a film kept out of the mosaic is left out");
});

test("a collection binding does not replace identities of loose movies inside it", () => {
  const files = [
    "lib/Whisper Man/Whisper Man.mkv",
    "lib/Whisper Man/Whisper Man 1080p.mkv",
    "lib/Whisper Man/Harry Potter and the Sorcerer's Stone.mp4",
  ].map(file);
  const units = titleUnits(files);
  const records = {
    "lib/Whisper Man": { type: "movie", id: "tt-whisper", source: "scan" as const },
  };
  const harry = units.find((unit) => unit.key.endsWith("Harry Potter and the Sorcerer's Stone.mp4"))!;
  const whisper = units.find((unit) => parseUnit(unit).title === "Whisper Man")!;
  assert.equal(knownTitleForUnit(whisper, records)?.id, "tt-whisper", "a title-named folder retains its binding for same-title copies");
  assert.equal(knownTitleForUnit(harry, records)?.id, undefined, "a differently named loose file does not inherit the collection binding");
  assert.equal(browseMeta(harry.key, "Harry Potter", records, {}, {}, harry).match, "unmatched",
    "a file row shows its own matching state instead of the collection's metadata");
  const folder = browseMeta("lib/Whisper Man", "Whisper Man", records, {}, {}, undefined, true);
  assert.equal(folder.match, "unmatched", "a mosaic folder does not present its stale parent binding as the collection's identity");
  assert.equal(folder.description, undefined);
  const posters = folderMosaicUnits(units, "lib/Whisper Man", records);
  assert.deepEqual(posters.map((unit) => knownTitleForUnit(unit, records)?.id ?? unit.key), ["tt-whisper", harry.key],
    "alternate encodes collapse to one poster while the distinct unmatched film remains its own tile");
});
