import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { browseDirectory, buildLibrary, clearBrowseCache, describePath, emptiedFolders, hasVideo, holdsLibraryRoot, listFolders, moveDestination, libraryFingerprint, numberedEpisode, isPathWithin, isVideo, listVideos, listVideosChecked, orphanedCatalogKeys, pageFiles, parseEpisode, parseSeason, remapPath, resolveInside, sortFiles, summarize, type BrowseResult } from "./library.js";

const file = (relative: string, size = 100, modified = "2026-01-01T00:00:00.000Z") => ({ relative, size, modified });

test("the season number is recognised in the different folder spellings", () => {
  assert.equal(parseSeason("01 serie"), 1);
  assert.equal(parseSeason("12 série"), 12);
  assert.equal(parseSeason("Season 2"), 2);
  assert.equal(parseSeason("S03"), 3);
  assert.equal(parseSeason("3"), 3);
  assert.equal(parseSeason("Serie 2"), 2);
  assert.equal(parseSeason("Série 4"), 4);
  assert.equal(parseSeason("Sezona 5"), 5);
  assert.equal(parseSeason("1. série"), 1);
  assert.equal(parseSeason("1. serie"), 1);
  assert.equal(parseSeason("2. řada"), 2);
  assert.equal(parseSeason("Řada 1"), 1);
  assert.equal(parseSeason("1.série"), 1);
  assert.equal(parseSeason("Extra"), null);
  assert.equal(parseSeason("Film 2"), null);
});

test("a season written as a Roman numeral or behind the show's name is recognised too", () => {
  assert.equal(parseSeason("I. SERIE"), 1);
  assert.equal(parseSeason("II. série"), 2);
  assert.equal(parseSeason("IV. SERIE"), 4);
  assert.equal(parseSeason("Season IV"), 4);
  assert.equal(parseSeason("III řada"), 3);
  assert.equal(parseSeason("XX. série"), 20);
  assert.equal(parseSeason("TRUE BLOOD - 1. serie"), 1);
  assert.equal(parseSeason("Show - Season 2"), 2);
  assert.equal(parseSeason("Show - S03"), 3);
  assert.equal(parseSeason("Show - II. série"), 2);
  // A bare Roman numeral is a film's title, not a season.
  assert.equal(parseSeason("I"), null);
  assert.equal(parseSeason("IV"), null);
  assert.equal(parseSeason("Rocky IV"), null);
});

test("a season form followed by a language or note is still that season", () => {
  assert.equal(parseSeason("10. serie - ENG"), 10);
  assert.equal(parseSeason("8. serie CZ"), 8);
  assert.equal(parseSeason("11. serie CZ"), 11);
  assert.equal(parseSeason("9. serie - ENG"), 9);
  // A bare number behind the show's name is the name, not a season.
  assert.equal(parseSeason("Hawaii Five - 0"), null);
  assert.equal(parseSeason("Blade Runner - 2049"), null);
  // None of these is a season either.
  assert.equal(parseSeason("2012"), null);
  assert.equal(parseSeason("Malá velká Británie USA"), null);
  assert.equal(parseSeason("2 Broke Girls"), null);
  assert.equal(parseSeason("300 Rise of an Empire"), null);
  // An unrelated word starting with the same letter as a Roman numeral is not one.
  assert.equal(parseSeason("Svět pod hlavou"), null);
});

test("an episode is numbered the way the show lays its files out", () => {
  const numbered = (relative: string) => numberedEpisode(relative);
  const loose = (relative: string) => numberedEpisode(relative, { loose: true });
  const both = (relative: string, numbers: { season: number; episode: number }) => {
    assert.deepEqual(numbered(relative), numbers, `without loose: ${relative}`);
    assert.deepEqual(loose(relative), numbers, `loose: ${relative}`);
  };
  const onlyLoose = (relative: string, numbers: { season: number; episode: number }) => {
    assert.equal(numbered(relative), undefined, `without loose: ${relative}`);
    assert.deepEqual(loose(relative), numbers, `loose: ${relative}`);
  };

  // Flat NxNN folders: the season and the episode are both in the file name.
  both("Čarodějky/Čarodějky-4x16-Páté-kolo-u-vozu.avi", { season: 4, episode: 16 });
  both("Jiste pane ministře/jiste.pane.ministre.1x01.celem.k.volicum.dvb.xvid-bb.avi", { season: 1, episode: 1 });
  both("Bratrsto neohrožených/Bratrstvo neohrozenych 1x01.avi", { season: 1, episode: 1 });

  // A compact SEE and a padded number behind the title only count for a series unit.
  onlyLoose("Moonlight/Moonlight - 101.avi", { season: 1, episode: 1 });
  onlyLoose("Moonlight/Moonlight - 102 - Out of the Past.avi", { season: 1, episode: 2 });
  onlyLoose("Okupace - Jo Nesbo/Okupace-01-Duben-2015-cz-Dansky-serial.avi", { season: 1, episode: 1 });

  // An episode word carries the number, and the season comes from the folder, or from season 1.
  both("Labyrint/Labyrint E01.avi", { season: 1, episode: 1 });
  both("Labyrint/Labyrint E02.avi", { season: 1, episode: 2 });
  both("Show/I. SERIE/E03.mkv", { season: 1, episode: 3 });
  both("Show - Season 2/Ep. 4.mkv", { season: 2, episode: 4 });
  both("Show - Season 2/Ep04.mkv", { season: 2, episode: 4 });
  both("Show - Season 2/Episode 3.mkv", { season: 2, episode: 3 });
  both("Show - Season 2/díl 3.mkv", { season: 2, episode: 3 });
  both("Show - Season 2/dil 3.mkv", { season: 2, episode: 3 });

  both(
    "The Vampire Diaries/I. SERIE/the-vampire-diaries-s01e01-pilot-hdtv-xvid-fqm-avi/the-vampire-diaries-s01e01-pilot-hdtv-xvid-fqm.avi",
    { season: 1, episode: 1 },
  );
  both("The Vampire Diaries/II. SERIE/The.Vampire.Diaries.S02E01.HDTV.XviD-LOL.avi", { season: 2, episode: 1 });
  both("True Blood/TRUE BLOOD - 1. serie/1x01 - Strange Love (Divná láska)/1x01 - Strange Love.avi", { season: 1, episode: 1 });
  both("True Blood/TRUE BLOOD - 4. serie/True.Blood.S04E01.HDTV.XviD-LOL.avi", { season: 4, episode: 1 });
  both("Rizzoli and Isles/3. serie/Rizzoli.and.Isles.S03E01.HDTV.x264-LOL.mp4", { season: 3, episode: 1 });

  // An episode folder is stepped over: the season is the folder above it.
  both("Show/I. SERIE/Show.S02E03/05 - Name.avi", { season: 1, episode: 5 });

  // The separator between S and E may be a dot, and an episode word carries a number behind it.
  both("Show/S05.E04.mkv", { season: 5, episode: 4 });
  both("Svět pod hlavou/Svět pod hlavou_E10 1983.mkv", { season: 1, episode: 10 });

  // A leading-zero four-digit token is a season and an episode, never a year.
  onlyLoose("True Blood/true.blood.0302.avi", { season: 3, episode: 2 });
  onlyLoose("True Blood/true.blood.0208.avi", { season: 2, episode: 8 });
  // Once more the season the folder names, in front of the episode.
  onlyLoose("6. serie/Sberatele kosti 6-15 Zabijak.avi", { season: 6, episode: 15 });
  // A leading number when the show keeps no season folder at all.
  onlyLoose("Show/01-Velký plán (The Grand Design).avi", { season: 1, episode: 1 });
  // An unpadded episode number at the end of the name.
  onlyLoose("Show/Malá Velká Británie v USA 3.avi", { season: 1, episode: 3 });
});

test("the episode number and the title split out of the file name", () => {
  assert.deepEqual(parseEpisode("07 - Vánoce.mkv"), { episode: 7, title: "Vánoce" });
  assert.deepEqual(parseEpisode("S01E06 The Date.mkv"), { episode: 6, title: "The Date" });
  assert.deepEqual(parseEpisode("03.mkv"), { episode: 3, title: "Epizoda 3" });
  assert.deepEqual(parseEpisode("Bonus.mkv"), { episode: null, title: "Bonus" });
});

test("several files in one folder are one item, not several", () => {
  // Exactly the case where the folder showed up twice: once per file.
  const library = buildLibrary([
    file("xxx/prvni.mp4", 10),
    file("xxx/druhy.mp4", 20),
  ]);
  assert.equal(library.length, 1, "the folder must not repeat");
  assert.equal(library[0].title, "xxx");
  assert.equal(library[0].kind, "collection", "a folder with several files is browsed, it is not a film");
  assert.equal(library[0].files.length, 2);
  assert.equal(library[0].size, 30, "the size is the sum of the files in the folder");
});

test("episodes are gathered under the series and sorted", () => {
  const library = buildLibrary([
    file("Friday Night Dinner/01 serie/06 - The Date.mkv"),
    file("Friday Night Dinner/01 serie/02 - The Jingle.mkv"),
    file("Friday Night Dinner/02 serie/01 - Nový.mkv"),
  ]);
  assert.equal(library.length, 1);
  const serial = library[0];
  assert.equal(serial.kind, "series");
  assert.equal(serial.title, "Friday Night Dinner");
  assert.deepEqual(serial.files.map((f) => `${f.season}x${f.episode}`), ["1x2", "1x6", "2x1"]);
  assert.deepEqual(serial.files.map((f) => f.label), ["The Jingle", "The Date", "Nový"]);
});

test("a film in a folder of its own is named after the folder", () => {
  const [movie] = buildLibrary([file("The Matrix/The Matrix.mkv")]);
  assert.equal(movie.kind, "movie");
  assert.equal(movie.title, "The Matrix");
  assert.equal(movie.files[0].path, "The Matrix/The Matrix.mkv");
});

test("a file in the root stands for itself", () => {
  const library = buildLibrary([file("Interstellar.avi"), file("Jiny.mkv")]);
  assert.equal(library.length, 2, "root files are not merged together");
  assert.deepEqual(library.map((e) => e.title).sort(), ["Interstellar", "Jiny"]);
});

test("a folder with seasons is a series even with loose episodes beside them", () => {
  const [entry] = buildLibrary([file("S/01 serie/01.mkv"), file("S/bonus.mkv")]);
  assert.equal(entry.kind, "series");
  assert.equal(entry.files.length, 2);
});

test("the newest additions come first", () => {
  const library = buildLibrary([
    file("Stary/Stary.mkv", 1, "2025-01-01T00:00:00.000Z"),
    file("Novy/Novy.mkv", 1, "2026-06-01T00:00:00.000Z"),
  ]);
  assert.deepEqual(library.map((item) => item.title), ["Novy", "Stary"]);
});

test("a path cannot get outside the download directory", () => {
  const root = "/downloads";
  assert.equal(resolveInside(root, "Film/Film.mkv"), path.resolve(root, "Film", "Film.mkv"));
  assert.equal(resolveInside(root, "../etc/passwd"), undefined);
  assert.equal(resolveInside(root, "/etc/passwd"), undefined);
  assert.equal(resolveInside(root, "Film/../../secret"), undefined);
  // A directory whose name merely starts the same is not a subdirectory.
  assert.equal(resolveInside("/downloads", "../downloads-jine/x.mkv"), undefined);
});

test("renaming a path keeps its children and leaves a similar name alone", () => {
  assert.equal(remapPath("Serial/01 serie/01.mkv", "Serial", "Novy serial"), "Novy serial/01 serie/01.mkv");
  assert.equal(remapPath("Serial 2/01.mkv", "Serial", "Novy serial"), "Serial 2/01.mkv");
  assert.equal(isPathWithin("Serial/01 serie/01.mkv", "Serial"), true);
  assert.equal(isPathWithin("Serial 2/01.mkv", "Serial"), false);
});

test("a folder is refused when it is another library's root or holds one, at any depth", () => {
  assert.equal(holdsLibraryRoot(new Set(["Archiv"]), "Archiv"), true, "the carve-out itself");
  const deep = new Set(["Archiv/Serialy"]);
  assert.equal(holdsLibraryRoot(deep, "Archiv/Serialy"), true, "the carve-out two levels down");
  assert.equal(holdsLibraryRoot(deep, "Archiv"), true, "the folder that holds it");
  const deeper = new Set(["Inbox/Archiv/Serialy"]);
  assert.equal(holdsLibraryRoot(deeper, "Inbox/Archiv"), true, "a holder at depth one");
  assert.equal(holdsLibraryRoot(deeper, "Inbox"), true, "a holder at depth two");
});

test("a name that only shares a prefix is not a carve-out, and an empty set refuses nothing", () => {
  const carveOuts = new Set(["Archiv"]);
  assert.equal(holdsLibraryRoot(carveOuts, "Archiv2"), false, "a sibling whose name starts the same");
  assert.equal(holdsLibraryRoot(carveOuts, "Archiv/Jine"), false, "a folder inside the carve-out does not hold it");
  assert.equal(holdsLibraryRoot(new Set(), "Archiv"), false, "nothing is excluded");
  assert.equal(holdsLibraryRoot(undefined, "Archiv"), false);
  // Every write guard is handed a non-empty relative path: the root is refused as invalid first.
  assert.equal(holdsLibraryRoot(carveOuts, ""), false, "the library root itself");
});

test("non-video files are ignored", () => {
  assert.equal(isVideo("film.mkv"), true);
  assert.equal(isVideo("film.MP4"), true);
  assert.equal(isVideo("titulky.srt"), false);
  assert.equal(isVideo("film.mkv.part"), false);
});

test("the overview sends no files, only their count", () => {
  const [entry] = buildLibrary([file("xxx/a.mp4", 5), file("xxx/b.mp4", 7)]);
  const prehled = summarize(entry);
  assert.equal(prehled.fileCount, 2);
  assert.equal(prehled.size, 12);
  assert.ok(!("files" in prehled), "the file list does not belong in the overview");
});

test("a large folder is handed out page by page", () => {
  const many = Array.from({ length: 1000 }, (_, i) => file(`xxx/klip ${String(i).padStart(4, "0")}.mp4`, 1));
  const [entry] = buildLibrary(many);
  assert.equal(entry.files.length, 1000);

  const prvni = pageFiles(entry, "", 0, 100);
  assert.equal(prvni.files.length, 100);
  assert.equal(prvni.total, 1000, "the total is reported even while paging");

  const dalsi = pageFiles(entry, "", 100, 100);
  assert.notEqual(prvni.files[0].path, dalsi.files[0].path, "the second page must not repeat the first");

  const posledni = pageFiles(entry, "", 950, 100);
  assert.equal(posledni.files.length, 50, "nothing is invented past the end");
});

test("the filter narrows both the list and the total", () => {
  const many = [
    ...Array.from({ length: 30 }, (_, i) => file(`xxx/klip ${i}.mp4`, 1)),
    file("xxx/jiny nazev.mp4", 1),
  ];
  const [entry] = buildLibrary(many);
  const filtr = pageFiles(entry, "jiny", 0, 100);
  assert.equal(filtr.total, 1);
  assert.equal(filtr.files[0].label, "jiny nazev");
  assert.equal(pageFiles(entry, "KLIP", 0, 100).total, 30, "the filter is case-insensitive");
});

test("the item kind follows from what the folder holds", () => {
  const [film] = buildLibrary([file("Matrix/Matrix.mkv")]);
  assert.equal(film.kind, "movie", "jeden soubor je film");

  const [serial] = buildLibrary([file("S/01 serie/01.mkv"), file("S/01 serie/02.mkv")]);
  assert.equal(serial.kind, "series", "a folder with a season is a series");

  const [kolekce] = buildLibrary([file("xxx/a.mp4"), file("xxx/b.mp4"), file("xxx/c.mp4")]);
  assert.equal(kolekce.kind, "collection", "a pile of files is a collection to browse");
});

test("sorting offers name, date added, size and random", () => {
  const files = [
    { path: "a", label: "Cesta", size: 30, modified: "2026-01-01T00:00:00.000Z" },
    { path: "b", label: "Alej", size: 10, modified: "2026-03-01T00:00:00.000Z" },
    { path: "c", label: "Bota", size: 20, modified: "2026-02-01T00:00:00.000Z" },
  ];
  assert.deepEqual(sortFiles(files, "name", false).map((f) => f.label), ["Alej", "Bota", "Cesta"]);
  assert.deepEqual(sortFiles(files, "name", true).map((f) => f.label), ["Cesta", "Bota", "Alej"]);
  assert.deepEqual(sortFiles(files, "size", true).map((f) => f.size), [30, 20, 10]);
  assert.deepEqual(sortFiles(files, "added", true).map((f) => f.label), ["Alej", "Bota", "Cesta"]);
});

test("a random order is stable for one seed, or pages would repeat", () => {
  const files = Array.from({ length: 40 }, (_, i) => ({ path: `p${i}`, label: `f${i}`, size: i, modified: "2026-01-01T00:00:00.000Z" }));
  const prvni = sortFiles(files, "random", false, "seed-1").map((f) => f.path);
  const znovu = sortFiles(files, "random", false, "seed-1").map((f) => f.path);
  const jine = sortFiles(files, "random", false, "seed-2").map((f) => f.path);
  assert.deepEqual(prvni, znovu, "the same seed has to give the same order");
  assert.notDeepEqual(prvni, jine, "a different seed has to shuffle differently");
  assert.equal(new Set(prvni).size, 40, "nothing is lost or duplicated");
});

test("sorting applies to folders too, not only to files", () => {
  const folders = [
    { path: "b", label: "Beta", size: 10, modified: "2026-03-01T00:00:00.000Z" },
    { path: "a", label: "Alfa", size: 30, modified: "2026-01-01T00:00:00.000Z" },
  ];
  assert.deepEqual(sortFiles(folders, "size", true).map((f) => f.label), ["Alfa", "Beta"]);
  assert.deepEqual(sortFiles(folders, "added", true).map((f) => f.label), ["Beta", "Alfa"]);
});

test("favourites are filtered before paging", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-library-"));
  try {
    await mkdir(path.join(root, "kolekce"));
    await Promise.all(Array.from({ length: 80 }, (_, index) =>
      writeFile(path.join(root, "kolekce", `video-${String(index).padStart(2, "0")}.mp4`), "")));
    const wanted = "kolekce/video-70.mp4";
    const result = await browseDirectory(root, "kolekce", "", 0, 60, "name", false, "", new Set([wanted]));
    assert.equal(result.total, 1);
    assert.deepEqual(result.items.map((item) => item.path), [wanted]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a favourites filter is not served the list a plain call cached", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-favorite-cache-"));
  try {
    await mkdir(path.join(root, "kolekce"));
    await Promise.all(Array.from({ length: 80 }, (_, index) =>
      writeFile(path.join(root, "kolekce", `video-${String(index).padStart(2, "0")}.mp4`), "")));
    // The same folder and query, so only the filter differs. The filter has to stay per request.
    const plain = await browseDirectory(root, "kolekce", "", 0, 60, "name");
    assert.equal(plain.total, 80);
    const wanted = "kolekce/video-70.mp4";
    const filtered = await browseDirectory(root, "kolekce", "", 0, 60, "name", false, "", new Set([wanted]));
    assert.equal(filtered.total, 1);
    assert.deepEqual(filtered.items.map((item) => item.path), [wanted]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a folder listing is the same whichever path built it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-identical-"));
  try {
    await mkdir(path.join(root, "Alpha"));
    await mkdir(path.join(root, "Beta", "01 serie"), { recursive: true });
    await mkdir(path.join(root, "Lehká", "a", "b"), { recursive: true });
    await mkdir(path.join(root, "Bez videa"));
    await writeFile(path.join(root, "Alpha", "01.mkv"), Buffer.alloc(100));
    await writeFile(path.join(root, "Alpha", "02.mkv"), Buffer.alloc(200));
    await writeFile(path.join(root, "Beta", "01 serie", "01.mkv"), Buffer.alloc(50));
    await writeFile(path.join(root, "Beta", "01 serie", "02.mkv"), Buffer.alloc(60));
    await writeFile(path.join(root, "Beta", "03.mkv"), Buffer.alloc(70));
    await writeFile(path.join(root, "Lehká", "a", "b", "hluboko.mp4"), Buffer.alloc(30));
    await writeFile(path.join(root, "Bez videa", "poznámka.txt"), "nic");
    await writeFile(path.join(root, "volný.mp4"), Buffer.alloc(11));

    // The walk a listing has to agree with is the one listVideos did all along.
    const expected = new Map<string, { fileCount: number; size: number }>([
      ["Alpha", { fileCount: 2, size: 300 }],
      ["Beta", { fileCount: 3, size: 180 }],
      ["Lehká", { fileCount: 1, size: 30 }],
    ]);
    for (const [folder, wanted] of expected) {
      const inside = await listVideos(root, folder);
      assert.deepEqual({ fileCount: inside.length, size: inside.reduce((sum, file) => sum + file.size, 0) }, wanted, folder);
    }

    const shape = (result: BrowseResult) => result.items.map((item) => ({
      path: item.path,
      fileCount: item.kind === "folder" ? item.fileCount : 0,
      size: item.size,
    })).sort((a, b) => a.path.localeCompare(b.path));

    // A random order is a hash of the path, so it takes the same cheap path as a name sort.
    const shapes: ReturnType<typeof shape>[] = [];
    for (const sort of ["name", "added", "size", "random"] as const) {
      clearBrowseCache();
      const result = await browseDirectory(root, "", "", 0, 50, sort, sort !== "name");
      assert.equal(result.total, expected.size + 1, `${sort}: the empty folder and the text file are not listed`);
      for (const [folder, wanted] of expected) {
        const item = result.items.find((entry) => entry.path === folder);
        assert.ok(item && item.kind === "folder", `${sort}: ${folder} is listed`);
        assert.deepEqual({ fileCount: item.fileCount, size: item.size }, wanted, `${sort}: ${folder}`);
      }
      shapes.push(shape(result));
    }
    assert.deepEqual(shapes[1], shapes[0], "the order by date is the same list");
    assert.deepEqual(shapes[2], shapes[0], "the order by size is the same list");
    assert.deepEqual(shapes[3], shapes[0], "the random order is the same list");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a folder holding no video is not listed, however deep the video sits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-hasvideo-"));
  try {
    await mkdir(path.join(root, "Jen text"));
    await mkdir(path.join(root, "Hluboko", "a", "b"), { recursive: true });
    await writeFile(path.join(root, "Jen text", "poznámka.txt"), "x");
    await writeFile(path.join(root, "Hluboko", "a", "b", "film.mkv"), "xx");
    const result = await browseDirectory(root, "", "", 0, 20, "name");
    assert.deepEqual(result.items.map((item) => item.path), ["Hluboko"]);
    assert.equal(result.total, 1);
    const folder = result.items[0];
    assert.ok(folder && folder.kind === "folder");
    assert.equal(folder.fileCount, 1);
    assert.equal(folder.size, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("hasVideo answers what the walk would, without stating a single file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-hasvideo-walk-"));
  try {
    await mkdir(path.join(root, "Obrazky", ".skryté"), { recursive: true });
    await mkdir(path.join(root, "Cizí", "Show"), { recursive: true });
    await writeFile(path.join(root, "Obrazky", ".skryté", "film.mkv"), "x");
    await writeFile(path.join(root, "Cizí", "Show", "01.mkv"), "x");
    let deep = path.join(root, "Hloubka");
    for (let level = 0; level < 10; level += 1) deep = path.join(deep, `u${level}`);
    await mkdir(deep, { recursive: true });
    await writeFile(path.join(deep, "film.mkv"), "x");

    assert.equal(await hasVideo(root, "Obrazky"), false, "a dotfile folder is not entered");
    assert.equal(await hasVideo(root, "Cizí"), true);
    assert.equal(await hasVideo(root, "Cizí", new Set(["Cizí/Show"])), false, "a carve-out is not entered either");
    assert.equal(await hasVideo(root, "Hloubka"), false, "the depth cap matches the walk");
    assert.equal(await hasVideo(root, "Nic"), false, "a folder that is not there holds nothing");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a later page of one folder is served from the listing cache", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-page-cache-"));
  try {
    for (const [folder, files] of [["Alfa", 1], ["Beta", 2], ["Gama", 3]] as const) {
      await mkdir(path.join(root, folder));
      for (let index = 0; index < files; index += 1) await writeFile(path.join(root, folder, `${index}.mkv`), Buffer.alloc(100));
    }
    // Ordering by size needs every aggregate, so the first page walks all three folders.
    const first = await browseDirectory(root, "", "", 0, 2, "size", true);
    assert.deepEqual(first.items.map((item) => item.path), ["Gama", "Beta"]);
    assert.deepEqual(first.items.map((item) => item.kind === "folder" ? item.fileCount : 0), [3, 2]);

    // A change inside a subtree leaves the folder's own mtime alone, so a page rebuilt from the
    // disk would see an empty Alfa. The page the cache serves still knows what is in it.
    await rm(path.join(root, "Alfa", "0.mkv"));
    const second = await browseDirectory(root, "", "", 2, 2, "size", true);
    assert.equal(second.total, 3, "the listing was rebuilt instead of read from the cache");
    assert.deepEqual(second.items.map((item) => item.path), ["Alfa"]);
    const folder = second.items[0];
    assert.ok(folder && folder.kind === "folder");
    assert.equal(folder.fileCount, 1);
    assert.equal(folder.size, 100);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a video written into a folder shows up in its listing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-newfile-"));
  try {
    await mkdir(path.join(root, "Alpha"));
    await writeFile(path.join(root, "Alpha", "01.mkv"), "x");
    const before = await browseDirectory(root, "Alpha", "", 0, 20, "name");
    assert.deepEqual(before.items.map((item) => item.path), ["Alpha/01.mkv"]);
    await writeFile(path.join(root, "Alpha", "02.mkv"), "x");
    const after = await browseDirectory(root, "Alpha", "", 0, 20, "name");
    assert.equal(after.total, 2, "the folder's own mtime moved, so the cached listing is stale");
    assert.deepEqual(after.items.map((item) => item.path), ["Alpha/01.mkv", "Alpha/02.mkv"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a folder whose own mtime did not move is still listed afresh", { skip: process.platform !== "win32" && "only NTFS moves a folder's mtime lazily; elsewhere the mtime is the key" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-lazy-mtime-"));
  try {
    const folder = path.join(root, "Alpha");
    await mkdir(folder);
    await writeFile(path.join(folder, "01.mkv"), "x");
    // NTFS moves a folder's mtime lazily, so writing 02.mkv can leave it exactly where it was.
    // Pinning it is what that looks like: the listing still has to notice the second file.
    const frozen = new Date(1_700_000_000_000);
    await utimes(folder, frozen, frozen);
    assert.equal((await stat(folder)).mtimeMs, frozen.getTime());
    const before = await browseDirectory(root, "Alpha", "", 0, 20, "name");
    assert.deepEqual(before.items.map((item) => item.path), ["Alpha/01.mkv"]);

    await writeFile(path.join(folder, "02.mkv"), "x");
    await utimes(folder, frozen, frozen);
    const after = await browseDirectory(root, "Alpha", "", 0, 20, "name");
    assert.equal(after.total, 2, "the listing was served from a folder mtime that never moved");
    assert.deepEqual(after.items.map((item) => item.path), ["Alpha/01.mkv", "Alpha/02.mkv"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("listVideos walks the same tree scanLibrary uses", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-videos-"));
  try {
    await mkdir(path.join(root, "Show", "01 serie"), { recursive: true });
    await writeFile(path.join(root, "Show", "01 serie", "01.mkv"), "");
    await writeFile(path.join(root, "note.txt"), "");
    const found = await listVideos(root);
    assert.deepEqual(found.map((item) => item.relative), ["Show/01 serie/01.mkv"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listVideosChecked agrees with listVideos and reports a complete walk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-videos-"));
  try {
    await mkdir(path.join(root, "Film"), { recursive: true });
    await writeFile(path.join(root, "Film", "film.mkv"), "12345");
    await writeFile(path.join(root, "note.txt"), "");
    const walked = await listVideosChecked(root);
    assert.equal(walked.complete, true);
    assert.deepEqual(walked.files, await listVideos(root));
    assert.deepEqual(walked.files.map((file) => file.relative), ["Film/film.mkv"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a directory that cannot be read leaves the walk incomplete but the rest listed",
  { skip: (process.getuid?.() === 0 && "root ignores the permission bits") || (process.platform === "win32" && "NTFS has no permission bits to close a directory with") }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stremio-videos-"));
    const closed = path.join(root, "Closed");
    try {
      await mkdir(path.join(root, "Open"), { recursive: true });
      await mkdir(closed, { recursive: true });
      await writeFile(path.join(root, "Open", "a.mkv"), "");
      await writeFile(path.join(closed, "b.mkv"), "");
      await chmod(closed, 0o000);
      const walked = await listVideosChecked(root);
      assert.equal(walked.complete, false, "an unreadable directory makes the walk incomplete");
      assert.deepEqual(walked.files.map((file) => file.relative), ["Open/a.mkv"]);
    } finally {
      await chmod(closed, 0o755).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

test("a root that is not there reports an incomplete walk", async () => {
  const root = path.join(tmpdir(), `stremio-videos-missing-${process.pid}-${Date.now()}`);
  const walked = await listVideosChecked(root);
  assert.equal(walked.complete, false);
  assert.deepEqual(walked.files, []);
});

test("the depth cap and a carved-out folder are not incompleteness", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-videos-"));
  try {
    let deep = root;
    for (let level = 0; level < 10; level += 1) deep = path.join(deep, `d${level}`);
    await mkdir(deep, { recursive: true });
    await writeFile(path.join(deep, "deep.mkv"), "");
    await mkdir(path.join(root, "Skipped"), { recursive: true });
    await writeFile(path.join(root, "Skipped", "x.mkv"), "");
    const walked = await listVideosChecked(root, new Set(["Skipped"]));
    assert.equal(walked.complete, true);
    assert.deepEqual(walked.files, [], "the depth cap defines the library, and a carve-out is not ours");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a walk with several calls in flight answers in the order of a sequential one", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-videos-"));
  try {
    await mkdir(path.join(root, "B show", "01 serie"), { recursive: true });
    await mkdir(path.join(root, "D film"), { recursive: true });
    await mkdir(path.join(root, "Skipped"), { recursive: true });
    for (let index = 0; index < 40; index += 1) await writeFile(path.join(root, "B show", "01 serie", `${String(index).padStart(2, "0")}.mkv`), "");
    await writeFile(path.join(root, "A.mkv"), "");
    await writeFile(path.join(root, "C.mkv"), "");
    await writeFile(path.join(root, "D film", "film.mp4"), "12345");
    await writeFile(path.join(root, "Skipped", "x.mkv"), "");
    const parallel = await listVideos(root, "", 0, new Set(["Skipped"]));
    const sequential = await listVideos(root, "", 0, new Set(["Skipped"]), { files: 1_000, until: Date.now() + 60_000 });
    assert.equal(parallel.length, 43);
    assert.deepEqual(parallel, sequential);
    assert.equal(parallel.find((file) => file.relative === "D film/film.mp4")?.size, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a walk with a budget stops where the budget ends", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-videos-"));
  try {
    await mkdir(path.join(root, "Show"), { recursive: true });
    for (let index = 0; index < 5; index += 1) await writeFile(path.join(root, "Show", `${index}.mkv`), "");
    const capped = await listVideos(root, "", 0, undefined, { files: 2, until: Date.now() + 60_000 });
    assert.equal(capped.length, 2, "the file ceiling ends the walk");
    const expired = await listVideos(root, "", 0, undefined, { files: 100, until: Date.now() - 1 });
    assert.deepEqual(expired, [], "a deadline already past walks nothing");
    const full = await listVideos(root);
    assert.equal(full.length, 5, "without a budget the walk is unchanged");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a deleted title loses its catalogue binding", () => {
  const meta = {
    "filmy/Duna": { type: "movie", id: "tt1160419" },
    "serialy/Přátelé": { type: "series", id: "tt0108778" },
  };
  assert.deepEqual([...orphanedCatalogKeys(meta, "filmy/Duna")], ["movie:tt1160419"]);
  assert.deepEqual([...orphanedCatalogKeys(meta, "filmy")], ["movie:tt1160419"], "a deleted parent folder counts too");
  assert.deepEqual([...orphanedCatalogKeys(meta, "filmy/Duna 2")], [], "an unrelated path forgets nothing");
});

test("unmatch sentinel is not a catalog orphan", () => {
  const meta = {
    "filmy/Duna": { type: "movie", id: "" },
    "serialy/Přátelé": { type: "series", id: "tt0108778" },
  };
  assert.deepEqual([...orphanedCatalogKeys(meta, "filmy/Duna")], []);
});

test("a title another path still holds stays", () => {
  const meta = {
    "serialy/Přátelé": { type: "series", id: "tt0108778" },
    "archiv/Přátelé": { type: "series", id: "tt0108778" },
  };
  assert.deepEqual([...orphanedCatalogKeys(meta, "serialy/Přátelé")], [], "the second folder still holds the title");
  assert.deepEqual([...orphanedCatalogKeys(meta, "archiv")], []);
});

test("a browsed file is numbered from its own name, not only from a season folder", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-browse-"));
  try {
    await mkdir(path.join(root, "Ted"), { recursive: true });
    await writeFile(path.join(root, "Ted", "Ted.S02E03.mkv"), "x");
    const result = await browseDirectory(root, "Ted");
    const file = result.items.find((item) => item.kind === "file");
    assert.equal(file?.season, 2);
    assert.equal(file?.episode, 3);
    assert.deepEqual(numberedEpisode(path.join("Ted", "Ted.S02E03.mkv")), { season: 2, episode: 3 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a film is not numbered from a number that only looks like an episode code", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-browse-"));
  try {
    await mkdir(path.join(root, "Room 237"), { recursive: true });
    await writeFile(path.join(root, "Room 237", "Room 237.mkv"), "x");
    const film = await browseDirectory(root, "Room 237");
    assert.equal(film.items.find((item) => item.kind === "file")?.season, null, "a film has no season");
    assert.equal(film.items.find((item) => item.kind === "file")?.episode, null);
    // The same folder inside a series unit is numbered by the show's own style.
    const series = await browseDirectory(root, "Room 237", "", 0, 60, "name", false, "", undefined, undefined, true);
    assert.equal(series.items.find((item) => item.kind === "file")?.season, 2);
    assert.equal(series.items.find((item) => item.kind === "file")?.episode, 37);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the fingerprint moves with a new, a resized or a touched file", () => {
  const base = [file("Foo/a.mkv", 10), file("Bar/b.mkv", 20)];
  assert.equal(libraryFingerprint(base), libraryFingerprint([...base].reverse()), "order is not a change");
  assert.notEqual(libraryFingerprint(base), libraryFingerprint([...base, file("Baz/c.mkv")]));
  assert.notEqual(libraryFingerprint(base), libraryFingerprint([file("Foo/a.mkv", 11), base[1]!]));
  assert.notEqual(libraryFingerprint(base), libraryFingerprint([{ ...base[0]!, modified: "2026-02-02T00:00:00.000Z" }, base[1]!]));
});

test("a moved item keeps its name and lands in the chosen folder", () => {
  assert.deepEqual(moveDestination("filmy/Duna.mkv", "archiv"), { path: "archiv/Duna.mkv" });
  assert.deepEqual(moveDestination("filmy/Duna.mkv", ""), { path: "Duna.mkv" }, "the root is the empty path");
  assert.deepEqual(moveDestination("Duna.mkv", "filmy"), { path: "filmy/Duna.mkv" });
});

test("a move that changes nothing and a folder swallowing itself are refused", () => {
  assert.deepEqual(moveDestination("filmy/Duna.mkv", "filmy"), { error: "sameFolder" });
  assert.deepEqual(moveDestination("Duna.mkv", ""), { error: "sameFolder" });
  assert.deepEqual(moveDestination("serialy", "serialy/Přátelé"), { error: "intoItself" });
  assert.deepEqual(moveDestination("serialy", "serialy"), { error: "intoItself" });
});

test("the folder of the last deleted video is emptied up the tree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-empty-"));
  try {
    const season = "Přátelé/01 serie";
    await mkdir(path.join(root, season), { recursive: true });
    await writeFile(path.join(root, season, "01.mkv"), "x");
    await writeFile(path.join(root, season, "01.srt"), "x", "utf8");
    const episode = `${season}/01.mkv`;
    assert.deepEqual(await emptiedFolders(root, episode), [], "the episode is still there");

    await rm(path.join(root, episode));
    assert.deepEqual(await emptiedFolders(root, episode), [season, "Přátelé"],
      "a leftover subtitle does not keep the folder alive");

    await writeFile(path.join(root, "Přátelé", "special.mkv"), "x");
    assert.deepEqual(await emptiedFolders(root, episode), [season], "the show folder still holds a video");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a folder that could not be read is never taken for empty", async (t) => {
  // A permission bit is the portable way to make one folder unreadable; Windows ignores it and
  // root reads through it, so the check would prove nothing there.
  if (process.platform === "win32" || process.getuid?.() === 0) { t.skip("needs POSIX permissions and a non-root user"); return; }
  const root = await mkdtemp(path.join(tmpdir(), "stremio-unreadable-"));
  const locked = path.join(root, "Show", "02 serie");
  try {
    await mkdir(path.join(root, "Show", "01 serie"), { recursive: true });
    await mkdir(locked, { recursive: true });
    await writeFile(path.join(locked, "01.mkv"), "x");
    await chmod(locked, 0o000);
    // The last episode of season 1 is gone; season 2 is still there but cannot be read now.
    assert.deepEqual(await emptiedFolders(root, "Show/01 serie/01.mkv"), ["Show/01 serie"],
      "the show folder is kept: an unreadable season is not an empty one");
  } finally {
    await chmod(locked, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a folder another library owns is carved out of every walk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-carve-"));
  try {
    await mkdir(path.join(root, "Inbox", "Seriály", "Show"), { recursive: true });
    await mkdir(path.join(root, "Filmy"), { recursive: true });
    await writeFile(path.join(root, "Filmy", "Duna.mkv"), "x");
    await writeFile(path.join(root, "Inbox", "volný.mkv"), "x");
    await writeFile(path.join(root, "Inbox", "Seriály", "Show", "01.mkv"), "x");
    const exclude = new Set(["Inbox/Seriály"]);

    assert.deepEqual(
      (await listVideos(root, "", 0, exclude)).map((entry) => entry.relative).sort(),
      ["Filmy/Duna.mkv", "Inbox/volný.mkv"],
    );

    const browsed = await browseDirectory(root, "Inbox", "", 0, 20, "name", false, "", undefined, exclude);
    assert.deepEqual(browsed.items.map((item) => item.path), ["Inbox/volný.mkv"]);
    assert.deepEqual(await listFolders(root, "Inbox", exclude), [], "the destination picker does not offer it either");
    assert.equal(await describePath(root, "Inbox/Seriály", exclude), undefined);

    await rm(path.join(root, "Inbox", "volný.mkv"));
    assert.deepEqual(await listVideos(root, "Inbox", 0, exclude), [], "the parent's own content is gone");
    assert.deepEqual((await listVideos(root, "Inbox")).map((entry) => entry.relative), ["Inbox/Seriály/Show/01.mkv"],
      "and the child library's file is the only thing left in it");
    assert.deepEqual(await emptiedFolders(root, "Inbox/volný.mkv", exclude), [],
      "so a folder holding another library is never emptied, or the delete would take that library with it");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the destination picker lists folders browsing would hide", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-folders-"));
  try {
    await mkdir(path.join(root, "Archiv"), { recursive: true });
    await mkdir(path.join(root, "Filmy"), { recursive: true });
    await mkdir(path.join(root, ".skryté"), { recursive: true });
    await writeFile(path.join(root, "Filmy", "Duna.mkv"), "x");
    await writeFile(path.join(root, "volný.mkv"), "x");
    assert.deepEqual(await listFolders(root, ""), [
      { path: "Archiv", name: "Archiv" },
      { path: "Filmy", name: "Filmy" },
    ], "an empty folder is a destination, a dotfile and a video are not");
    assert.deepEqual(await listFolders(root, path.join("..", "..")), [], "nothing outside the root");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the carve-out guard compares folders, not spellings, where the volume folds", () => {
  // Platform-dependent on purpose, so the fold is a parameter: on macOS, Windows and an SMB
  // share `Archiv` and `archiv` are one directory; on Linux -- and so on CI -- they are two,
  // and folding there would refuse a delete the user is entitled to.
  const carveOuts = new Set(["Archiv/Serialy"]);
  const folding = (relative: string) => holdsLibraryRoot(carveOuts, relative, true);
  const exact = (relative: string) => holdsLibraryRoot(carveOuts, relative, false);

  assert.equal(folding("Archiv"), true, "the canonical spelling, folding volume");
  assert.equal(exact("Archiv"), true, "the canonical spelling, case-sensitive volume");
  assert.equal(folding("archiv"), true, "the folded spelling is the same folder");
  assert.equal(exact("archiv"), false, "on a case-sensitive volume it is a different folder");
  assert.equal(holdsLibraryRoot(new Set(["Archiv/serialy"]), "Archiv/Serialy", true), true,
    "a carve-out recorded in another case still guards the folder the listing shows");
  assert.equal(folding("Archiv2"), false, "a shared prefix is not containment");
  assert.equal(exact("Archiv2"), false, "a shared prefix is not containment either way");
  // No probe reached the volume, and an unknown fold folds: refusing a delete the user has to
  // do another way costs less than a library taken along by one.
  assert.equal(holdsLibraryRoot(carveOuts, "archiv"), true, "a fold nobody answered with is folded");
});
