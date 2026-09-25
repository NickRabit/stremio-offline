import assert from "node:assert/strict";
import { test } from "node:test";
import { isPackagingFolderName, parseMediaName, parseMediaPath, partSignature, stripPartMarkers, stripSegmentMarkers, titleVariants } from "./library-parse.js";

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

test("the web of a release is a tag, the Web of a name is a name", () => {
  assert.equal(parseMediaName("Charlotte's Web").title, "Charlotte's Web");
  assert.equal(parseMediaName("Charlotte's Web 2006 1080p WEB-DL x264").title, "Charlotte's Web");
  assert.equal(parseMediaName("Charlotte's.Web.2006.WEBRip.x264").title, "Charlotte's Web");
});

test("brackets separate fields without losing their content", () => {
  const result = parseMediaName("Transformers[2007]DvDrip[Eng]-aXXo");
  assert.equal(result.title, "Transformers");
  assert.equal(result.year, 2007);
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

test("a trailing country tag is read as a country, not as part of the name", () => {
  const office = parseMediaPath("The Office (US)");
  assert.equal(office.title, "The Office");
  assert.equal(office.country, "US");
  assert.equal(parseMediaPath("The Office (UK)").country, "UK");
  assert.equal(parseMediaPath("Doctor Who (2005)").year, 2005, "a parenthesised year is not a country");
  assert.equal(parseMediaPath("Doctor Who (2005)").country, undefined);
});

test("a part signature canonicalises the number, ignores tags and leaves segments alone", () => {
  assert.equal(partSignature("Saw 3", true), partSignature("Saw III", true), "Arabic and Roman spellings are one installment");
  assert.equal(partSignature("Rocky III", true), "part:3");
  assert.notEqual(partSignature("Saw III", true), partSignature("Saw IV", true), "another installment is another part");
  assert.equal(partSignature("Saw III IMAX", true), "part:3", "a release tag is not a part");
  assert.equal(partSignature("Saw III Director's Cut", true), "part:3", "an apostrophe in the tag does not hide the number");
  assert.equal(partSignature("Saw III Extended Edition", true), "part:3");
  assert.equal(partSignature("Nymfomanka - část 1"), "part:1");
  assert.equal(partSignature("Nymfomanka CD2"), "", "a CD half is a segment of one film, not an installment");
  assert.equal(partSignature("Blade Runner 2049", true), "", "a year-sized number is not an installment");
});

test("segment markers collapse while installment markers survive", () => {
  assert.equal(stripSegmentMarkers("dmd twilight cd2"), "dmd twilight", "the CD halves of one film are one name");
  assert.equal(stripSegmentMarkers("godfather part ii"), "godfather part ii", "an installment is no segment");
  assert.equal(stripSegmentMarkers("kill bill vol 2"), "kill bill vol 2");
});

test("a physical segment behind the installment numeral does not hide the installment", () => {
  assert.equal(partSignature("Saw III CD1", true), "part:3", "the first CD of part three is part three");
  assert.equal(partSignature("Saw 3 CD1", true), "part:3", "the Arabic spelling reads the same way");
  assert.equal(partSignature("Apollo 13 CD1", true), "part:13", "and so does a bare number in front of a segment");
  assert.equal(partSignature("Saw III Disc 2", true), "part:3");
  assert.equal(partSignature("Saw III CD1", true), partSignature("Saw III", true), "the split copy is the same installment as the whole one");
  assert.equal(partSignature("Rocky V Disc 1", true), "part:5");
  assert.equal(partSignature("Saw III CD1", false), "part:3", "a Roman numeral needs no bare-numeral permission");
  assert.equal(partSignature("Blade Runner 2049 Disc 1", true), "", "a year-sized number is no installment, segment or not");
  assert.equal(partSignature("Saw CD1", true), "", "a segment alone names no installment");
  assert.equal(partSignature("I Am Legend CD1", true), "", "a Roman-looking word is not the title's trailing numeral");
  assert.equal(partSignature("Kill Bill Vol 1 CD1", true), "part:1", "a spelled-out installment is the title's own");
});

test("the words a matcher drops carry the installment a segment left behind", () => {
  assert.equal(stripPartMarkers("saw iii cd1"), "saw", "scoring compares the film's own words");
  assert.equal(stripPartMarkers("apollo 13 cd1"), "apollo", "the bare number after the title goes with it");
  assert.equal(stripSegmentMarkers("saw iii cd1"), "saw iii", "only the physical half is a segment");
});

test("a number in front of a subtitle is the part the whole name states", () => {
  assert.equal(partSignature("Doba ledová 4: Země v pohybu", true), "part:4");
  assert.equal(partSignature("Hellboy II: The Golden Army", true), "part:2");
  assert.equal(partSignature("Ice Age: Continental Drift", true), "");
  assert.equal(partSignature("Alita: Battle Angel", true), "", "a single-token head names no part");
  assert.equal(partSignature("2001: A Space Odyssey", true), "");
  assert.equal(partSignature("Doba ledová 4: Země v pohybu", false), "", "a bare number still needs the caller's leave");
});

test("a scene name glued with hyphens is read field by field", () => {
  const name = (value: string) => {
    const result = parseMediaName(value);
    return { title: result.title, year: result.year };
  };
  assert.deepEqual(name("REZISTENCE-2015-HDRip-2.0-CZ-titulky - 2.dil"), { title: "REZISTENCE - 2 dil", year: 2015 });
  assert.deepEqual(name("Allegiant.2016.BRRip.XviD.CZtit - 3.dil"), { title: "Allegiant - 3 dil", year: 2016 });
  assert.deepEqual(name("The-Interview-(2014)-TIT"), { title: "The Interview", year: 2014 });
  assert.deepEqual(name("Sirotčinec-slečny-Peregrinové-pro-podivné-děti-(2016)-CZ-titulky"), {
    title: "Sirotčinec slečny Peregrinové pro podivné děti", year: 2016,
  });
  assert.deepEqual(name("Spider-Man"), { title: "Spider-Man", year: undefined }, "one hyphen with no year or quality is the word's own");
  assert.deepEqual(name("WALL-E"), { title: "WALL-E", year: undefined });
  assert.deepEqual(name("K-pop - Lovkyně démonů"), { title: "K-pop - Lovkyně démonů", year: undefined });
});

test("a name is compared and searched in every form worth trying", () => {
  assert.deepEqual(titleVariants(parseMediaName("Alita - Bojový Anděl")), [
    { text: "Alita", side: false },
    { text: "Alita - Bojový Anděl", side: false },
    { text: "Bojový Anděl", side: true },
  ]);
  assert.deepEqual(titleVariants(parseMediaName("Spider-Man")), [{ text: "Spider-Man", side: false }],
    "a hyphen without spaces never splits a name");
  assert.deepEqual(titleVariants(parseMediaName("Na hrane zitrka - Edge of Tomorrow")), [
    { text: "Na hrane zitrka - Edge of Tomorrow", side: false },
    { text: "Na hrane zitrka", side: true },
    { text: "Edge of Tomorrow", side: true },
  ]);
  assert.deepEqual(titleVariants(parseMediaName("Kill Bill - Vol 1")).map((variant) => variant.text),
    ["Kill Bill - Vol 1", "Kill Bill"],
    "a half that is only an installment marker is not a form of the name");
});

test("only a release-group folder is packaging, never a title or a season", () => {
  assert.equal(isPackagingFolderName("REFF"), true);
  assert.equal(isPackagingFolderName("SPARKS"), true);
  assert.equal(isPackagingFolderName("Alien"), false);
  assert.equal(isPackagingFolderName("UP 2009"), false);
  assert.equal(isPackagingFolderName("2012"), false);
  assert.equal(isPackagingFolderName("S01"), false);
});
