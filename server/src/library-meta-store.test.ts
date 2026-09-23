import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LibraryMetaStore } from "./library-meta-store.js";
import { knownTitleOf, type LibraryMetaRecord } from "./library-match.js";

const record = (id: string): LibraryMetaRecord => ({ type: "movie", id, source: "scan", locked: false, matchedAt: "2026-01-01T00:00:00.000Z" });
const libraryFile = (dataDir: string, id: string) => path.join(dataDir, "library", `${id}.json`);

async function withStore(run: (store: LibraryMetaStore, dataDir: string) => Promise<void>) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "meta-store-"));
  try { await run(new LibraryMetaStore(dataDir), dataDir); }
  finally { await rm(dataDir, { recursive: true, force: true }); }
}

async function seed(dataDir: string, id: string, meta: Record<string, unknown>, suggestions: Record<string, unknown> = {}) {
  await mkdir(path.join(dataDir, "library"), { recursive: true });
  await writeFile(libraryFile(dataDir, id), JSON.stringify({ version: 1, meta, suggestions }));
}

test("a library file is read into the qualified view and back", async () => {
  await withStore(async (store, dataDir) => {
    await seed(dataDir, "lib_a", { "Show/01.mkv": record("tt1") }, { "Other show": { type: "series", id: "tt2", score: 80 } });
    await seed(dataDir, "lib_b", { "Film.mkv": record("tt3") });
    await store.load();
    assert.deepEqual(Object.keys(store.qualifiedMeta()).sort(), ["lib_a/Show/01.mkv", "lib_b/Film.mkv"]);
    assert.deepEqual(Object.keys(store.qualifiedSuggestions()), ["lib_a/Other show"]);
    assert.deepEqual(Object.keys(store.meta("lib_a")), ["Show/01.mkv"], "the file keeps library-relative keys");
  });
});

test("a mosaic-only record round-trips without becoming a binding", async () => {
  await withStore(async (store, dataDir) => {
    await seed(dataDir, "lib_a", { Movies: { type: "movie", id: "", source: "user", skipMosaic: true } });
    await store.load();
    await store.flush();
    const row = store.qualifiedMeta()["lib_a/Movies"]!;
    assert.equal(row.skipMosaic, true, "the flag comes back");
    assert.equal(row.id, "", "a decision, not a title");
    assert.equal(knownTitleOf("lib_a/Movies/Title.mkv", store.qualifiedMeta()), undefined, "it is not read as a binding");
    assert.equal(JSON.parse(await readFile(libraryFile(dataDir, "lib_a"), "utf8")).meta.Movies.skipMosaic, true, "the flag is written back");
  });
});

test("a write only rewrites the library it was made for", async () => {
  await withStore(async (store, dataDir) => {
    await seed(dataDir, "lib_a", { "Show/01.mkv": record("tt1") });
    await seed(dataDir, "lib_b", { "Film.mkv": record("tt3") });
    await store.load();
    const untouched = await stat(libraryFile(dataDir, "lib_b"));
    await store.update("lib_a", (file) => { file.meta["Show/02.mkv"] = record("tt4"); });
    await store.flush();
    assert.deepEqual(Object.keys(store.meta("lib_a")).sort(), ["Show/01.mkv", "Show/02.mkv"]);
    assert.equal((await stat(libraryFile(dataDir, "lib_b"))).mtimeMs, untouched.mtimeMs, "the other library is not touched");
    assert.equal(JSON.parse(await readFile(libraryFile(dataDir, "lib_b"), "utf8")).meta["Film.mkv"].id, "tt3");
  });
});

test("bursts of writes settle into one atomic file", async () => {
  await withStore(async (store, dataDir) => {
    await store.load();
    for (let index = 0; index < 5; index += 1) {
      await store.update("lib_a", (file) => { file.meta[`Film ${index}.mkv`] = record(`tt${index}`); });
    }
    assert.deepEqual(await readdir(path.join(dataDir, "library")).catch(() => []), [], "nothing is written before the debounce runs out");
    await store.flush();
    assert.equal((await stat(libraryFile(dataDir, "lib_a"))).mode & 0o777, 0o600);
    assert.equal(Object.keys(JSON.parse(await readFile(libraryFile(dataDir, "lib_a"), "utf8")).meta).length, 5);
    assert.deepEqual(await readdir(path.join(dataDir, "library")), ["lib_a.json"], "no temporary file is left behind");
  });
});

test("episode rows land in the shared file, not in a library", async () => {
  await withStore(async (store, dataDir) => {
    await seed(dataDir, "lib_a", {});
    await store.load();
    await store.update("lib_a", (file, episodes) => {
      file.meta["Show/01.mkv"] = record("tt1");
      episodes["series:tt1:1:1"] = { type: "series", id: "tt1", season: 1, episode: 1, name: "One" } as never;
    });
    await store.flush();
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(dataDir, "library", "episodes.json"), "utf8"))), ["series:tt1:1:1"]);
    assert.equal(Object.hasOwn(JSON.parse(await readFile(libraryFile(dataDir, "lib_a"), "utf8")).meta["Show/01.mkv"], "episode"), false);
  });
});

const libA = "lib_aaaaaaaa";
const libB = "lib_bbbbbbbb";

test("a move inside one library renames the rows in its own file", async () => {
  await withStore(async (store, dataDir) => {
    await seed(dataDir, libA, { Show: record("tt1"), "Show/01.mkv": record("tt2") });
    await seed(dataDir, libB, { "Film.mkv": record("tt3") });
    await store.load();
    await store.relocate(`${libA}/Show`, `${libA}/Serial`);
    await store.flush();
    assert.deepEqual(Object.keys(store.meta(libA)).sort(), ["Serial", "Serial/01.mkv"]);
    assert.deepEqual(Object.keys(store.meta(libB)), ["Film.mkv"], "the other library is not in this move");
  });
});

test("a move into another library writes both files and pins the inherited title first", async () => {
  await withStore(async (store, dataDir) => {
    // The folder carries the title; the file inside inherits it. In the destination the file
    // sits under another title's folder, so it has to own the binding before it leaves.
    await seed(dataDir, libA, { Show: record("tt1") }, { Show: { type: "movie", id: "tt1", score: 90 } });
    await seed(dataDir, libB, { Archive: record("tt9") });
    await store.load();
    await store.relocate(`${libA}/Show/01.mkv`, `${libB}/Archive/01.mkv`, true);
    await store.flush();
    assert.deepEqual(Object.keys(store.meta(libA)), ["Show"], "only the moved row leaves");
    assert.deepEqual(Object.keys(store.meta(libB)).sort(), ["Archive", "Archive/01.mkv"]);
    assert.equal(store.meta(libB)["Archive/01.mkv"]!.id, "tt1", "the item keeps the title it had");
    assert.deepEqual(Object.keys(store.suggestions(libA)), ["Show"], "the folder keeps its own suggestion");
    assert.deepEqual(Object.keys(store.suggestions(libB)), ["Archive/01.mkv"]);
  });
});

test("copy duplicates metadata without changing the source", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "stremio-meta-"));
  try {
    const store = new LibraryMetaStore(dataDir);
    await store.load();
    await store.update("lib_11111111", (file) => { file.meta.Title = record("tt1"); });
    await store.copy("lib_11111111/Title", "lib_22222222/Title copy");
    assert.equal(store.meta("lib_11111111").Title?.id, "tt1");
    assert.equal(store.meta("lib_22222222")["Title copy"]?.id, "tt1");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a write driven by catalogue identity walks every library", async () => {
  await withStore(async (store, dataDir) => {
    await seed(dataDir, "lib_a", { "One.mkv": record("tt1") });
    await seed(dataDir, "lib_b", { "Two.mkv": record("tt1"), "Three.mkv": record("tt9") });
    await store.load();
    await store.updateAll((file) => {
      for (const [key, row] of Object.entries(file.meta)) if (row.id === "tt1") file.meta[key] = { ...row, name: "Backfilled" };
    });
    await store.flush();
    assert.equal(store.qualifiedMeta()["lib_a/One.mkv"]!.name, "Backfilled");
    assert.equal(store.qualifiedMeta()["lib_b/Two.mkv"]!.name, "Backfilled");
    assert.equal(store.qualifiedMeta()["lib_b/Three.mkv"]!.name, undefined);
  });
});

test("dropping the backfill stamp leaves the rest of the row alone", async () => {
  await withStore(async (store, dataDir) => {
    const filled = (id: string, name: string): LibraryMetaRecord => ({ ...record(id), name, year: "2001", description: `${name} described` });
    const fresh = filled("tt2", "Fresh");
    await seed(dataDir, "lib_a", { "Stamped.mkv": { ...filled("tt1", "Stamped"), backfilledAt: "2026-09-14T15:51:00.000Z" }, "Fresh.mkv": fresh });
    await store.load();
    await store.updateAll((file) => {
      for (const [key, row] of Object.entries(file.meta)) {
        if (!row.backfilledAt) continue;
        const { backfilledAt: _dropped, ...rest } = row;
        file.meta[key] = rest;
      }
    });
    assert.deepEqual(store.meta("lib_a")["Stamped.mkv"], filled("tt1", "Stamped"), "the stamp goes, the answer stays");
    assert.deepEqual(store.meta("lib_a")["Fresh.mkv"], fresh, "a row without a stamp is not rewritten");
  });
});

test("a qualified write touches only the library that owns the key", async () => {
  await withStore(async (store, dataDir) => {
    await seed(dataDir, "lib_aaaaaaaa", { "One.mkv": record("tt1") });
    await seed(dataDir, "lib_bbbbbbbb", { "Two.mkv": record("tt2") });
    await store.load();
    const untouched = await stat(libraryFile(dataDir, "lib_bbbbbbbb"));
    await store.updateQualified((meta, suggestions, episodes) => {
      meta["lib_aaaaaaaa/One.mkv"] = { ...meta["lib_aaaaaaaa/One.mkv"]!, name: "Renamed" };
      delete suggestions["lib_aaaaaaaa/One.mkv"];
      meta["lib_cccccccc/New.mkv"] = record("tt9");
      meta["unqualified.mkv"] = record("tt0");
      suggestions["lib_aaaaaaaa/Other show"] = { type: "series", id: "tt7", name: "Other show", score: 70 };
      episodes["movie:tt1:0:0"] = { type: "movie", id: "tt1" } as never;
    });
    await store.flush();
    assert.equal(store.qualifiedMeta()["lib_aaaaaaaa/One.mkv"]!.name, "Renamed");
    assert.equal(store.qualifiedMeta()["lib_cccccccc/New.mkv"]!.id, "tt9", "a library with no file yet is created");
    assert.equal(store.qualifiedMeta()["unqualified.mkv"], undefined, "an unqualified key is not ours");
    assert.equal(store.qualifiedSuggestions()["lib_aaaaaaaa/Other show"]!.score, 70);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(dataDir, "library", "episodes.json"), "utf8"))), ["movie:tt1:0:0"]);
    assert.equal((await stat(libraryFile(dataDir, "lib_bbbbbbbb"))).mtimeMs, untouched.mtimeMs, "the other library is not rewritten");
    assert.deepEqual((await readdir(path.join(dataDir, "library"))).sort(), ["episodes.json", "lib_aaaaaaaa.json", "lib_bbbbbbbb.json", "lib_cccccccc.json"]);
  });
});

test("forget drops the file and the keys that came from it", async () => {
  await withStore(async (store, dataDir) => {
    await seed(dataDir, "lib_a", { "One.mkv": record("tt1") });
    await seed(dataDir, "lib_b", { "Two.mkv": record("tt2") });
    await store.load();
    await store.forget("lib_a");
    assert.deepEqual(Object.keys(store.qualifiedMeta()), ["lib_b/Two.mkv"]);
    assert.deepEqual(await readdir(path.join(dataDir, "library")), ["lib_b.json"]);
  });
});

test("a broken file is skipped instead of failing the boot", async () => {
  await withStore(async (store, dataDir) => {
    await seed(dataDir, "lib_a", { "One.mkv": record("tt1") });
    await writeFile(libraryFile(dataDir, "lib_b"), "{ not json");
    await store.load();
    assert.deepEqual(Object.keys(store.qualifiedMeta()), ["lib_a/One.mkv"]);
  });
});

test("a suggestion written before the review fields existed still loads and round-trips", async () => {
  await withStore(async (store, dataDir) => {
    await seed(dataDir, "lib_a", {}, {
      // The shape an older install has on disk: nothing but the score and the title.
      "Films/Heat": { type: "movie", id: "tt0113277", name: "Heat", year: 1995, score: 91, scannedAt: "2026-01-01T00:00:00.000Z" },
      "Films/Ronin": { type: "movie", id: "", name: "", score: 0 },
    });
    await store.load();
    assert.deepEqual(store.qualifiedSuggestions()["lib_a/Films/Heat"], {
      type: "movie", id: "tt0113277", name: "Heat", year: 1995, score: 91, scannedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal("reason" in store.qualifiedSuggestions()["lib_a/Films/Heat"]!, false, "no reason is invented for an old row");
    await store.flush();
    const written = JSON.parse(await readFile(libraryFile(dataDir, "lib_a"), "utf8")).suggestions;
    assert.equal(written["Films/Heat"].name, "Heat");
    assert.equal("reason" in written["Films/Heat"], false);
  });
});

test("a qualified write keeps a correction proposal's review fields", async () => {
  await withStore(async (store, dataDir) => {
    await store.load();
    await store.updateQualified((_meta, suggestions) => {
      suggestions["lib_aaaaaaaa/Films/Flashdance"] = {
        type: "movie", id: "tt0085549", name: "Flashdance", score: 100, reason: "correction",
        replacesId: "tt-old", replacesName: "Flashdance", poster: "https://art/f.jpg",
      };
    });
    await store.flush();
    assert.deepEqual(store.qualifiedSuggestions()["lib_aaaaaaaa/Films/Flashdance"], {
      type: "movie", id: "tt0085549", name: "Flashdance", score: 100, reason: "correction",
      replacesId: "tt-old", replacesName: "Flashdance", poster: "https://art/f.jpg",
    });
  });
});
