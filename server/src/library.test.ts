import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { browseDirectory, buildLibrary, describePath, emptiedFolders, listFolders, moveDestination, libraryFingerprint, numberedEpisode, isPathWithin, isVideo, listVideos, orphanedCatalogKeys, pageFiles, parseEpisode, parseSeason, remapPath, resolveInside, sortFiles, summarize } from "./library.js";

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
  assert.equal(parseSeason("Extra"), null);
  assert.equal(parseSeason("Film 2"), null);
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
  assert.equal(resolveInside(root, "Film/Film.mkv"), "/downloads/Film/Film.mkv");
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
    const wanted = path.join("kolekce", "video-70.mp4");
    const result = await browseDirectory(root, "kolekce", "", 0, 60, "name", false, "", new Set([wanted]));
    assert.equal(result.total, 1);
    assert.deepEqual(result.items.map((item) => item.path), [wanted]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listVideos walks the same tree scanLibrary uses", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-videos-"));
  try {
    await mkdir(path.join(root, "Show", "01 serie"), { recursive: true });
    await writeFile(path.join(root, "Show", "01 serie", "01.mkv"), "");
    await writeFile(path.join(root, "note.txt"), "");
    const found = await listVideos(root);
    assert.deepEqual(found.map((item) => item.relative), [path.join("Show", "01 serie", "01.mkv")]);
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

test("the fingerprint moves with a new, a resized or a touched file", () => {
  const base = [file("Foo/a.mkv", 10), file("Bar/b.mkv", 20)];
  assert.equal(libraryFingerprint(base), libraryFingerprint([...base].reverse()), "order is not a change");
  assert.notEqual(libraryFingerprint(base), libraryFingerprint([...base, file("Baz/c.mkv")]));
  assert.notEqual(libraryFingerprint(base), libraryFingerprint([file("Foo/a.mkv", 11), base[1]!]));
  assert.notEqual(libraryFingerprint(base), libraryFingerprint([{ ...base[0]!, modified: "2026-02-02T00:00:00.000Z" }, base[1]!]));
});

test("a moved item keeps its name and lands in the chosen folder", () => {
  assert.deepEqual(moveDestination(path.join("filmy", "Duna.mkv"), "archiv"), { path: path.join("archiv", "Duna.mkv") });
  assert.deepEqual(moveDestination(path.join("filmy", "Duna.mkv"), ""), { path: "Duna.mkv" }, "the root is the empty path");
  assert.deepEqual(moveDestination("Duna.mkv", "filmy"), { path: path.join("filmy", "Duna.mkv") });
});

test("a move that changes nothing and a folder swallowing itself are refused", () => {
  assert.deepEqual(moveDestination(path.join("filmy", "Duna.mkv"), "filmy"), { error: "sameFolder" });
  assert.deepEqual(moveDestination("Duna.mkv", ""), { error: "sameFolder" });
  assert.deepEqual(moveDestination("serialy", path.join("serialy", "Přátelé")), { error: "intoItself" });
  assert.deepEqual(moveDestination("serialy", "serialy"), { error: "intoItself" });
});

test("the folder of the last deleted video is emptied up the tree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-empty-"));
  try {
    const season = path.join("Přátelé", "01 serie");
    await mkdir(path.join(root, season), { recursive: true });
    await writeFile(path.join(root, season, "01.mkv"), "x");
    await writeFile(path.join(root, season, "01.srt"), "x", "utf8");
    const episode = path.join(season, "01.mkv");
    assert.deepEqual(await emptiedFolders(root, episode), [], "the episode is still there");

    await rm(path.join(root, episode));
    assert.deepEqual(await emptiedFolders(root, episode), [season, "Přátelé"],
      "a leftover subtitle does not keep the folder alive");

    await writeFile(path.join(root, "Přátelé", "special.mkv"), "x");
    assert.deepEqual(await emptiedFolders(root, episode), [season], "the show folder still holds a video");
  } finally { await rm(root, { recursive: true, force: true }); }
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
