import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  openAppDatabase,
  StorageError,
  type AppDatabase,
  type Statement,
} from "./storage/app-database.js";
import { TmdbIdMap } from "./tmdb-ids.js";

const DAY_MS = 24 * 60 * 60_000;

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tmdb-ids-sqlite-"));
  const file = path.join(dataDir, "tmdb-ids.json");
  let database = await openAppDatabase({ dataDir });
  t.after(async () => {
    try {
      await database.close();
    } catch (error) {
      if (!(error instanceof StorageError) || error.code !== "broken") throw error;
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir,
    file,
    get database() { return database; },
    async reopen() {
      await database.close();
      database = await openAppDatabase({ dataDir });
      return database;
    },
  };
}

function observingBatch(database: AppDatabase, seen: Statement[][]): AppDatabase {
  return new Proxy(database, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: Statement[]) => {
          seen.push(statements);
          return await target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function marker(database: AppDatabase) {
  const row = await database.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", ["domain.tmdbIds"]);
  return row ? JSON.parse(row.value) as Record<string, unknown> : undefined;
}

test("TMDB id JSON is imported once and a restart answers the same lookups", async (t) => {
  const { dataDir, file, database, reopen } = await fixture(t);
  await writeFile(file, JSON.stringify({
    version: 1,
    byImdb: {
      "movie:tt0133093": { tmdb: 603, at: 1_000 },
      "series:tt9999999": { tmdb: null, at: 2_000 },
    },
    byTmdb: {
      "movie:603": { imdb: "tt0133093", at: 1_000 },
      "series:604": { imdb: null, at: 2_000 },
    },
  }));

  const first = new TmdbIdMap();
  first.attachDatabase(database);
  await first.load(file);

  assert.equal(first.tmdbOf("movie", "tt0133093", 3_000), 603);
  assert.equal(first.imdbOf("movie", 603, 3_000), "tt0133093");
  assert.equal(first.tmdbOf("series", "tt9999999", 3_000), null);
  assert.equal(first.imdbOf("series", 604, 3_000), null);
  const imported = await marker(database);
  assert.ok(imported);
  assert.equal(typeof imported?.importedAt, "number");
  assert.equal(imported.source, "tmdb-ids.json");
  assert.equal(imported.count, 4);
  await assert.rejects(stat(file), { code: "ENOENT" });
  assert.equal((await readdir(path.join(dataDir, "migration-backup"))).length, 1);

  const reopened = await reopen();
  const restartedBatches: Statement[][] = [];
  const restarted = new TmdbIdMap();
  restarted.attachDatabase(observingBatch(reopened, restartedBatches));
  await restarted.load(file);
  await restarted.flush();
  assert.equal(restartedBatches.length, 0);
  assert.equal(restarted.tmdbOf("movie", "tt0133093", 3_000), 603);
  assert.equal(restarted.imdbOf("movie", 603, 3_000), "tt0133093");
  assert.equal(restarted.tmdbOf("series", "tt9999999", 3_000), null);
  assert.equal(restarted.imdbOf("series", 604, 3_000), null);
});

test("a new pair writes two upserts, and the same pair writes nothing and does not refresh at", async (t) => {
  const { file, database } = await fixture(t);
  const batches: Statement[][] = [];
  const ids = new TmdbIdMap();
  ids.attachDatabase(observingBatch(database, batches));
  await ids.load(file);
  batches.length = 0;

  ids.rememberPair("movie", "tt0133093", 603, 1_000);
  await ids.flush();
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 2);
  assert.ok(batches[0]!.every((statement) => statement.sql.startsWith("INSERT INTO tmdb_ids")));
  const before = await database.all<{ direction: string; key: string; at: number }>(
    "SELECT direction, key, at FROM tmdb_ids ORDER BY direction, key",
  );
  batches.length = 0;

  ids.rememberPair("movie", "tt0133093", 603, 9_000);
  await ids.flush();

  assert.equal(batches.length, 0);
  assert.deepEqual(
    await database.all<{ direction: string; key: string; at: number }>(
      "SELECT direction, key, at FROM tmdb_ids ORDER BY direction, key",
    ),
    before,
  );
});

test("a fresh negative entry writes nothing", async (t) => {
  const { file, database } = await fixture(t);
  const batches: Statement[][] = [];
  const ids = new TmdbIdMap();
  ids.attachDatabase(observingBatch(database, batches));
  await ids.load(file);
  ids.rememberNoTmdb("movie", "tt9999999", 1_000);
  ids.rememberNoImdb("series", 604, 1_000);
  await ids.flush();
  batches.length = 0;

  ids.rememberNoTmdb("movie", "tt9999999", 1_000 + 30 * DAY_MS - 1);
  ids.rememberNoImdb("series", 604, 1_000 + 30 * DAY_MS - 1);
  await ids.flush();

  assert.equal(batches.length, 0);
  assert.deepEqual(await database.all<{ direction: string; key: string; at: number }>(
    "SELECT direction, key, at FROM tmdb_ids ORDER BY direction, key",
  ), [
    { direction: "imdb", key: "movie:tt9999999", at: 1_000 },
    { direction: "tmdb", key: "series:604", at: 1_000 },
  ]);
});

test("trimming past the cap deletes the evicted rows", async (t) => {
  const { file, database } = await fixture(t);
  const ids = new TmdbIdMap(1);
  ids.attachDatabase(database);
  await ids.load(file);
  ids.rememberPair("movie", "tt0000001", 1, 100);
  await ids.flush();

  ids.rememberPair("movie", "tt0000002", 2, 200);
  await ids.flush();

  assert.deepEqual(await database.all("SELECT direction, key, value, at FROM tmdb_ids ORDER BY direction, key"), [
    { direction: "imdb", key: "movie:tt0000002", value: "2", at: 200 },
    { direction: "tmdb", key: "movie:2", value: "tt0000002", at: 200 },
  ]);
});
