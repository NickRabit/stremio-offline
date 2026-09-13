import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrateLibraries, migrateStateFile } from "./library-migrate.js";
import { SCHEMA_VERSION, type State } from "./store.js";

const artworkName = (key: string) => `${createHash("sha1").update(key).digest("hex")}.jpg`;

const v1State = (over: Partial<State> = {}): State => ({
  addons: [],
  settings: { defaultMovieLibrary: "", defaultSeriesLibrary: "" } as State["settings"],
  defaultsInstalled: true,
  libraryMeta: {
    "Show/01 serie": { type: "series", id: "tt1" },
    "Show/01 serie/01.mkv": { type: "series", id: "tt1" },
    "Film.mkv": { type: "movie", id: "tt2" },
  },
  librarySuggestions: { "Other show": { type: "series", id: "tt3", score: 90 } },
  favorites: ["Show/01 serie", "Film.mkv"],
  progress: {
    "file:Show/01 serie/01.mkv": { position: 120, duration: 600, title: "One", path: "Show/01 serie/01.mkv", updatedAt: "2026-01-01T00:00:00.000Z" },
    "series:tt1": { position: 30, duration: 600, title: "Two", path: "Show/01 serie/02.mkv", updatedAt: "2026-01-01T00:00:00.000Z" },
  },
  watchlist: { "series:tt1": { type: "series", id: "tt1", name: "Show", addedAt: "2026-01-01T00:00:00.000Z" } },
  ...over,
}) as State;

test("a v1 state gains one library and qualified keys", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "migrate-"));
  const downloadDir = await mkdtemp(path.join(tmpdir(), "downloads-"));
  await mkdir(path.join(downloadDir, "Show", "01 serie"), { recursive: true });
  await writeFile(path.join(downloadDir, "Show", "01 serie", "01.mkv"), "x");
  await writeFile(path.join(downloadDir, "Film.mkv"), "x");
  const state = v1State();
  try {
    const summary = await migrateLibraries(state, { dataDir, downloadDir });
    const id = summary.libraryId!;
    assert.match(id, /^lib_[0-9a-f]{8}$/);
    assert.equal(summary.migrated, true);
    assert.equal(state.schemaVersion, SCHEMA_VERSION);
    assert.equal(state.libraries?.length, 1);
    assert.equal(state.libraries?.[0]?.root, downloadDir);
    assert.equal(state.libraries?.[0]?.type, "mixed", "the legacy tree keeps inferring");
    assert.equal(state.libraries?.[0]?.writeArtwork, true);
    assert.deepEqual(state.settings.defaultMovieLibrary, id);
    assert.deepEqual(state.settings.defaultSeriesLibrary, id);

    assert.deepEqual(Object.keys(state.libraryMeta!).sort(), [`${id}/Film.mkv`, `${id}/Show/01 serie`, `${id}/Show/01 serie/01.mkv`].sort());
    assert.equal(state.libraryMeta![`${id}/Show/01 serie`]!.id, "tt1");
    assert.deepEqual(state.librarySuggestions!, { [`${id}/Other show`]: { type: "series", id: "tt3", score: 90 } });
    assert.deepEqual(state.favorites, [`${id}/Show/01 serie`, `${id}/Film.mkv`]);
    assert.equal(state.progress![`file:${id}/Show/01 serie/01.mkv`]!.path, `${id}/Show/01 serie/01.mkv`);
    assert.equal(state.progress![`file:${id}/Show/01 serie/01.mkv`]!.position, 120);
    assert.equal(state.progress!["series:tt1"]!.path, `${id}/Show/01 serie/02.mkv`, "a title-keyed entry keeps its key and gets a qualified path");
    assert.deepEqual(Object.keys(state.watchlist!), ["series:tt1"], "the watchlist is catalogue ids, not paths");
  } finally { await rm(dataDir, { recursive: true, force: true }); await rm(downloadDir, { recursive: true, force: true }); }
});

test("a state that never had settings does not gain any", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "migrate-"));
  const downloadDir = await mkdtemp(path.join(tmpdir(), "downloads-"));
  const { settings, ...withoutSettings } = v1State();
  const state = withoutSettings as State;
  try {
    await migrateLibraries(state, { dataDir, downloadDir });
    assert.equal("settings" in state, false, "Store.load fills the defaults in, and a present blob would read as a legacy Czech install");
  } finally { await rm(dataDir, { recursive: true, force: true }); await rm(downloadDir, { recursive: true, force: true }); }
});

test("thumbnails follow their keys into the qualified namespace", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "migrate-"));
  const downloadDir = await mkdtemp(path.join(tmpdir(), "downloads-"));
  const artwork = path.join(dataDir, "artwork");
  await mkdir(path.join(downloadDir, "Show", "01 serie"), { recursive: true });
  await mkdir(artwork, { recursive: true });
  await writeFile(path.join(downloadDir, "Show", "01 serie", "01.mkv"), "x");
  // Exactly the shapes the orphan sweep treats as valid: an entry key, a file, and
  // the directory prefixes above the file (folders are keyed `dir:`).
  const old = ["Show", "Show/01 serie/01.mkv", "dir:Show", "dir:Show/01 serie"].map(artworkName);
  for (const name of old) await writeFile(path.join(artwork, name), "jpeg");
  const orphan = artworkName("Gone/old.mkv");
  await writeFile(path.join(artwork, orphan), "jpeg");
  const past = new Date(Date.now() - 2 * 60 * 60_000);
  await utimes(path.join(artwork, orphan), past, past);
  const fresh = artworkName("Gone/fresh.mkv");
  await writeFile(path.join(artwork, fresh), "jpeg");

  const state = v1State({ libraryMeta: {}, librarySuggestions: {}, favorites: [], progress: {} } as Partial<State>);
  try {
    const summary = await migrateLibraries(state, { dataDir, downloadDir });
    const id = summary.libraryId!;
    assert.equal(summary.artwork.mapped, 4);
    for (const name of old) await assert.rejects(stat(path.join(artwork, name)), "the old name is gone");
    const kept = [`${id}/Show`, `dir:${id}/Show`, `dir:${id}/Show/01 serie`, `${id}/Show/01 serie/01.mkv`].map(artworkName);
    for (const name of kept) assert.equal((await stat(path.join(artwork, name))).size, 4);
    await assert.rejects(stat(path.join(artwork, orphan)), "an orphan past the freshness guard is dropped");
    assert.equal((await stat(path.join(artwork, fresh))).size, 4, "a fresh thumbnail is kept for its arriving file");
  } finally { await rm(dataDir, { recursive: true, force: true }); await rm(downloadDir, { recursive: true, force: true }); }
});

test("the file migration runs once, keeps a v1 backup and survives a restart", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "migrate-"));
  const downloadDir = await mkdtemp(path.join(tmpdir(), "downloads-"));
  const file = path.join(dataDir, "state.json");
  await writeFile(file, JSON.stringify(v1State()));
  try {
    const first = await migrateStateFile(dataDir, downloadDir);
    assert.equal(first.migrated, true);
    const migrated = JSON.parse(await readFile(file, "utf8")) as State;
    assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
    assert.equal(migrated.libraries?.length, 1);
    assert.equal((await stat(`${file}.v1.bak`)).size > 0, true);

    const second = await migrateStateFile(dataDir, downloadDir);
    assert.equal(second.migrated, false);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), migrated);
  } finally { await rm(dataDir, { recursive: true, force: true }); await rm(downloadDir, { recursive: true, force: true }); }
});

test("an unreachable or read-only root comes up flagged rather than failing", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "migrate-"));
  const missing = path.join(dataDir, "gone");
  const state = v1State();
  const summary = await migrateLibraries(state, { dataDir, downloadDir: missing });
  assert.equal(state.libraries?.[0]?.unreachable, true);
  assert.equal(summary.migrated, true);
  await rm(dataDir, { recursive: true, force: true });
});
