import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ArtworkCache } from "./artwork-cache.js";
import {
  openAppDatabase,
  StorageError,
  type AppDatabase,
  type Statement,
} from "./storage/app-database.js";

const hash = (key: string) => `${createHash("sha1").update(key).digest("hex")}.jpg`;
const name = (libraryId: string, relative: string) => path.join(libraryId, hash(relative));

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "artwork-sqlite-"));
  const artworkDir = path.join(dataDir, "artwork");
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
    artworkDir,
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

async function put(dir: string, key: string, bytes: number, at?: number) {
  const file = path.join(dir, name("lib_aaaaaaaa", key));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(bytes));
  if (at !== undefined) {
    const seconds = at / 1000;
    await utimes(file, seconds, seconds);
  }
  return file;
}

async function marker(database: AppDatabase) {
  const row = await database.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", ["domain.artwork"]);
  return row ? JSON.parse(row.value) as Record<string, unknown> : undefined;
}

test("artwork JSON is imported with its recency and a restart reads the rows", async (t) => {
  const { dataDir, artworkDir, database, reopen } = await fixture(t);
  const one = await put(artworkDir, "One.mkv", 100);
  const two = await put(artworkDir, "Two.mkv", 200);
  await writeFile(path.join(artworkDir, "index.json"), JSON.stringify({
    [name("lib_aaaaaaaa", "One.mkv")]: { bytes: 999, at: 1_000 },
    [name("lib_aaaaaaaa", "Two.mkv")]: { bytes: 1, at: 2_000 },
    [name("lib_bbbbbbbb", "Missing.mkv")]: { bytes: 300, at: 3_000 },
  }));
  const batches: Statement[][] = [];
  const cache = new ArtworkCache(artworkDir, 1024 * 1024);
  cache.attachDatabase(observingBatch(database, batches));
  await cache.load();

  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 3, "two entries and the marker commit together");
  const imported = await marker(database);
  assert.equal(typeof imported?.importedAt, "number");
  assert.equal(imported?.source, "index.json");
  assert.equal(imported?.count, 2);
  assert.deepEqual(
    await database.all("SELECT key, bytes, at FROM artwork_entries ORDER BY key"),
    [
      { key: name("lib_aaaaaaaa", "One.mkv"), bytes: 100, at: 1_000 },
      { key: name("lib_aaaaaaaa", "Two.mkv"), bytes: 200, at: 2_000 },
    ].sort((left, right) => left.key.localeCompare(right.key)),
  );
  await assert.rejects(stat(path.join(artworkDir, "index.json")), { code: "ENOENT" });
  assert.equal((await readdir(path.join(dataDir, "migration-backup"))).filter((file) => file.startsWith("artwork-index-")).length, 1);

  const restartedDatabase = await reopen();
  const restartBatches: Statement[][] = [];
  const restarted = new ArtworkCache(artworkDir, 1024 * 1024);
  restarted.attachDatabase(observingBatch(restartedDatabase, restartBatches));
  await restarted.load();
  await restarted.flush();

  assert.equal(restartBatches.length, 0);
  assert.deepEqual(restarted.hotFiles(), [
    { file: two, at: 2_000 },
    { file: one, at: 1_000 },
  ]);
});

test("one changed artwork writes one upsert and no JSON file", async (t) => {
  const { artworkDir, database } = await fixture(t);
  const batches: Statement[][] = [];
  const cache = new ArtworkCache(artworkDir, 1024 * 1024);
  cache.attachDatabase(observingBatch(database, batches));
  await cache.load();
  batches.length = 0;

  const file = await put(artworkDir, "New.mkv", 64, 12_000);
  await cache.written(file);
  await cache.flush();

  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 1);
  assert.match(batches[0]![0]!.sql, /^INSERT INTO artwork_entries/);
  assert.deepEqual(batches[0]![0]!.params, [name("lib_aaaaaaaa", "New.mkv"), 64, batches[0]![0]!.params![2]]);
  assert.equal(typeof batches[0]![0]!.params![2], "number");
  await assert.rejects(stat(path.join(artworkDir, "index.json")), { code: "ENOENT" });

  batches.length = 0;
  await cache.flush();
  assert.equal(batches.length, 0);
});

test("an artwork removal writes a delete", async (t) => {
  const { artworkDir, database } = await fixture(t);
  const batches: Statement[][] = [];
  const cache = new ArtworkCache(artworkDir, 1024 * 1024);
  cache.attachDatabase(observingBatch(database, batches));
  await cache.load();
  const file = await put(artworkDir, "Gone.mkv", 64);
  await cache.written(file);
  await cache.flush();
  batches.length = 0;

  await rm(file);
  await cache.removed(file);
  await cache.flush();

  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 1);
  assert.match(batches[0]![0]!.sql, /^DELETE FROM artwork_entries/);
  assert.deepEqual(await database.all("SELECT key FROM artwork_entries"), []);
});

test("artwork load reconciles the rows with the files on disk", async (t) => {
  const { artworkDir, database } = await fixture(t);
  const kept = await put(artworkDir, "Kept.mkv", 100);
  const added = await put(artworkDir, "Added.mkv", 200, 7_000);
  const keptInfo = await stat(kept);
  const addedInfo = await stat(added);
  await database.batch([
    {
      sql: "INSERT INTO artwork_entries (key, bytes, at) VALUES (?, ?, ?)",
      params: [name("lib_aaaaaaaa", "Kept.mkv"), 100, 4_000],
    },
    {
      sql: "INSERT INTO artwork_entries (key, bytes, at) VALUES (?, ?, ?)",
      params: [name("lib_bbbbbbbb", "Missing.mkv"), 900, 5_000],
    },
    {
      sql: "INSERT INTO meta (key, value) VALUES (?, ?)",
      params: ["domain.artwork", JSON.stringify({ importedAt: 1, source: "index.json", count: 2 })],
    },
  ]);
  const batches: Statement[][] = [];
  const cache = new ArtworkCache(artworkDir, 1024 * 1024);
  cache.attachDatabase(observingBatch(database, batches));
  await cache.load();

  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0]!.map((statement) => statement.sql.startsWith("DELETE") ? "delete" : "upsert").sort(), ["delete", "upsert"]);
  assert.deepEqual(await database.all("SELECT key, bytes, at FROM artwork_entries ORDER BY key"), [
    { key: name("lib_aaaaaaaa", "Added.mkv"), bytes: 200, at: addedInfo.mtimeMs },
    { key: name("lib_aaaaaaaa", "Kept.mkv"), bytes: 100, at: 4_000 },
  ].sort((left, right) => left.key.localeCompare(right.key)));
  assert.equal(keptInfo.size, 100);
});

test("artwork changed during an in-flight batch is written by the next flush", async (t) => {
  const { artworkDir, database } = await fixture(t);
  let hold: Promise<void> | undefined;
  let entered!: () => void;
  const writing = new Promise<void>((resolve) => { entered = resolve; });
  const gated = new Proxy(database, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: Statement[]) => {
          if (hold) {
            entered();
            await hold;
            hold = undefined;
          }
          return await target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const cache = new ArtworkCache(artworkDir, 1024 * 1024);
  cache.attachDatabase(gated);
  await cache.load();

  const first = await put(artworkDir, "First.mkv", 64);
  const second = await put(artworkDir, "Second.mkv", 64);
  let release!: () => void;
  hold = new Promise<void>((resolve) => { release = resolve; });
  await cache.written(first);
  const firstFlush = cache.flush();
  await writing;
  await cache.written(second);
  const secondFlush = cache.flush();
  release();
  await Promise.all([firstFlush, secondFlush]);

  assert.deepEqual(
    (await database.all<{ key: string }>("SELECT key FROM artwork_entries ORDER BY key")).map((row) => row.key).sort(),
    [name("lib_aaaaaaaa", "First.mkv"), name("lib_aaaaaaaa", "Second.mkv")].sort(),
  );
});

test("a thumbnail removed while the artwork index loads does not abort the load", async (t) => {
  const { artworkDir, database } = await fixture(t);
  const doomed = await put(artworkDir, "Doomed.mkv", 100);
  await put(artworkDir, "Kept.mkv", 200);
  await database.run("INSERT INTO meta (key, value) VALUES (?, ?)", ["domain.artwork", JSON.stringify({ importedAt: 1, source: "index.json", count: 0 })]);
  // The file goes away right after the stored rows are read, mid-reconciliation.
  const racing = new Proxy(database, {
    get(target, property) {
      if (property === "all") {
        return async (...args: Parameters<AppDatabase["all"]>) => {
          const rows = await target.all(...args);
          await rm(doomed, { force: true });
          return rows;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const cache = new ArtworkCache(artworkDir, 1024 * 1024);
  cache.attachDatabase(racing);
  await cache.load();
  assert.ok(cache.size >= 1);
});
