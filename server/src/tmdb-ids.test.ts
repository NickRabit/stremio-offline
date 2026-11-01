import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { TmdbIdMap } from "./tmdb-ids.js";

const DAY_MS = 24 * 60 * 60_000;

const tempDir = async (t: TestContext): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-tmdb-ids-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test("a pair answers in both directions and kinds stay separate", () => {
  const ids = new TmdbIdMap();
  ids.rememberPair("movie", "tt0133093", 603, 1_000);

  assert.equal(ids.tmdbOf("movie", "tt0133093", 1_000), 603);
  assert.equal(ids.imdbOf("movie", 603, 1_000), "tt0133093");
  assert.equal(ids.tmdbOf("series", "tt0133093", 1_000), undefined);
  assert.equal(ids.imdbOf("series", 603, 1_000), undefined);
});

test("negative answers expire after thirty days", () => {
  const ids = new TmdbIdMap();
  ids.rememberNoTmdb("movie", "tt9999999", 1_000);
  ids.rememberNoImdb("series", 604, 1_000);

  assert.equal(ids.tmdbOf("movie", "tt9999999", 1_000 + 30 * DAY_MS - 1), null);
  assert.equal(ids.tmdbOf("movie", "tt9999999", 1_000 + 30 * DAY_MS), undefined);
  assert.equal(ids.imdbOf("series", 604, 1_000 + 30 * DAY_MS - 1), null);
  assert.equal(ids.imdbOf("series", 604, 1_000 + 30 * DAY_MS), undefined);
});

test("a positive pair replaces a negative answer in both directions", () => {
  const ids = new TmdbIdMap();
  ids.rememberNoTmdb("movie", "tt0133093", 1_000);
  ids.rememberNoImdb("movie", 603, 1_000);
  ids.rememberPair("movie", "tt0133093", 603, 2_000);

  assert.equal(ids.tmdbOf("movie", "tt0133093", 2_000), 603);
  assert.equal(ids.imdbOf("movie", 603, 2_000), "tt0133093");
});

test("missing, broken and wrong-version files start empty", async (t) => {
  const dir = await tempDir(t);
  const missing = path.join(dir, "missing.json");
  const broken = path.join(dir, "broken.json");
  const wrong = path.join(dir, "wrong.json");
  await writeFile(broken, "{");
  await writeFile(wrong, JSON.stringify({ version: 2, byImdb: {}, byTmdb: {} }));

  for (const file of [missing, broken, wrong]) {
    const ids = new TmdbIdMap();
    await ids.load(file);
    assert.equal(ids.tmdbOf("movie", "tt0133093", 1_000), undefined);
    assert.equal(ids.imdbOf("movie", 603, 1_000), undefined);
  }
});

test("pairs survive a write and malformed entries are dropped", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "tmdb-ids.json");
  const ids = new TmdbIdMap();
  await ids.load(file);
  ids.rememberPair("movie", "tt0133093", 603, 1_000);
  ids.rememberNoTmdb("series", "tt9999999", 2_000);
  ids.rememberNoImdb("series", 604, 2_000);
  await ids.flush();

  const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  const byImdb = parsed.byImdb as Record<string, unknown>;
  const byTmdb = parsed.byTmdb as Record<string, unknown>;
  byImdb["movie:not-an-id"] = { tmdb: 1, at: 1_000 };
  byImdb["movie:tt0000001"] = { tmdb: -1, at: 1_000 };
  byTmdb["movie:0"] = { imdb: "tt0000001", at: 1_000 };
  byTmdb["movie:605"] = { imdb: "not-an-id", at: 1_000 };
  await writeFile(file, JSON.stringify(parsed));

  const loaded = new TmdbIdMap();
  await loaded.load(file);
  assert.equal(loaded.tmdbOf("movie", "tt0133093", 10_000), 603);
  assert.equal(loaded.imdbOf("movie", 603, 10_000), "tt0133093");
  assert.equal(loaded.tmdbOf("series", "tt9999999", 10_000), null);
  assert.equal(loaded.imdbOf("series", 604, 10_000), null);
  assert.equal(loaded.tmdbOf("movie", "tt0000001", 10_000), undefined);
  assert.equal(loaded.imdbOf("movie", 605, 10_000), undefined);
});

test("the oldest timestamps are dropped past the cap", async (t) => {
  const dir = await tempDir(t);
  const ids = new TmdbIdMap(2);
  await ids.load(path.join(dir, "tmdb-ids.json"));
  ids.rememberPair("movie", "tt0000001", 1, 100);
  ids.rememberPair("movie", "tt0000002", 2, 300);
  ids.rememberPair("movie", "tt0000003", 3, 200);

  assert.equal(ids.tmdbOf("movie", "tt0000001", 400), undefined);
  assert.equal(ids.imdbOf("movie", 1, 400), undefined);
  assert.equal(ids.tmdbOf("movie", "tt0000002", 400), 2);
  assert.equal(ids.tmdbOf("movie", "tt0000003", 400), 3);
  await ids.flush();
});
