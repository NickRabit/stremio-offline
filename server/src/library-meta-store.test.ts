import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LibraryMetaStore } from "./library-meta-store.js";
import type { LibraryMetaRecord } from "./library-match.js";

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
