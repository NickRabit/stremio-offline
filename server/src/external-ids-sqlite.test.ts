import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { FetchLike } from "./debrid.js";
import {
  openAppDatabase,
  StorageError,
  type AppDatabase,
  type Statement,
} from "./storage/app-database.js";

process.env.WIKIDATA_GUARD = "0";
const { ExternalIdStore } = await import("./external-ids.js");

const bindings = (rows: Array<Record<string, { value: string }>>) =>
  new Response(JSON.stringify({ results: { bindings: rows } }), {
    status: 200,
    headers: { "content-type": "application/sparql-results+json" },
  });

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "external-ids-sqlite-"));
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
    file: path.join(dataDir, "external-ids.json"),
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
  const row = await database.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", ["domain.externalIds"]);
  return row ? JSON.parse(row.value) as Record<string, unknown> : undefined;
}

const answer = (tmdb: string): FetchLike => async () => bindings([{ tmdbMovie: { value: tmdb } }]);

test("external id JSON is imported once and a restart answers without a lookup", async (t) => {
  const { dataDir, file, database, reopen } = await fixture(t);
  await writeFile(file, JSON.stringify({
    version: 1,
    entries: {
      tt0000001: { csfd: "11", tmdbMovie: "101", at: "2026-01-01T00:00:00.000Z" },
      tt0000002: { tmdbTv: "202", at: "2026-01-02T00:00:00.000Z" },
    },
  }));
  const batches: Statement[][] = [];
  const store = new ExternalIdStore(dataDir, async () => { throw new Error("no lookup expected"); });
  store.attachDatabase(observingBatch(database, batches));
  await store.load();

  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 3, "two entries and the marker commit together");
  const imported = await marker(database);
  assert.equal(imported?.source, "external-ids.json");
  assert.equal(imported?.count, 2);
  assert.equal(typeof imported?.importedAt, "number", "a numeric stamp keeps the backup name free of a colon");
  assert.deepEqual(store.cachedIds("tt0000001"), { csfd: "11", tmdbMovie: "101" });
  await assert.rejects(stat(file), { code: "ENOENT" });

  const restarted = new ExternalIdStore(dataDir, async () => { throw new Error("no lookup expected"); });
  const restartedBatches: Statement[][] = [];
  restarted.attachDatabase(observingBatch(await reopen(), restartedBatches));
  await restarted.load();
  await restarted.flush();
  assert.equal(restartedBatches.length, 0);
  assert.deepEqual(restarted.cachedIds("tt0000002"), { tmdbTv: "202" });
});

test("one changed external id writes one upsert and no JSON file", async (t) => {
  const { dataDir, file, database } = await fixture(t);
  const batches: Statement[][] = [];
  const store = new ExternalIdStore(dataDir, answer("303"));
  store.attachDatabase(observingBatch(database, batches));
  await store.load();
  batches.length = 0;

  assert.deepEqual(await store.ids("tt0000003"), { tmdbMovie: "303" });
  await store.flush();
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 1);
  assert.match(batches[0]![0]!.sql, /^INSERT INTO external_ids/);
  assert.deepEqual(batches[0]![0]!.params?.slice(0, 1), ["tt0000003"]);
  await assert.rejects(stat(file), { code: "ENOENT" });

  batches.length = 0;
  await store.flush();
  assert.equal(batches.length, 0);
});

test("corrupt external id JSON is moved aside as unreadable", async (t) => {
  const { dataDir, file, database } = await fixture(t);
  await writeFile(file, "{ not json");
  const batches: Statement[][] = [];
  const store = new ExternalIdStore(dataDir);
  store.attachDatabase(observingBatch(database, batches));
  await store.load();

  const imported = await marker(database);
  assert.equal(imported?.source, "unreadable");
  assert.equal(imported?.count, 0);
  assert.deepEqual(await database.all("SELECT imdb FROM external_ids"), []);
  await assert.rejects(stat(file), { code: "ENOENT" });
  const backup = (await readdir(path.join(dataDir, "migration-backup")))
    .find((name) => name.startsWith("external-ids-unreadable-"));
  assert.ok(backup);
  assert.equal(await readFile(path.join(dataDir, "migration-backup", backup), "utf8"), "{ not json");
});

test("an external id change during an in-flight batch is written by the next flush", async (t) => {
  const { dataDir, database } = await fixture(t);
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
  let current = "401";
  const store = new ExternalIdStore(dataDir, async () => bindings([{ tmdbMovie: { value: current } }]));
  store.attachDatabase(gated);
  await store.load();

  let release!: () => void;
  hold = new Promise<void>((resolve) => { release = resolve; });
  assert.deepEqual(await store.ids("tt0000004"), { tmdbMovie: "401" });
  const firstFlush = store.flush();
  await writing;
  current = "500";
  assert.deepEqual(await store.ids("tt0000005"), { tmdbMovie: "500" });
  const secondFlush = store.flush();
  release();
  await Promise.all([firstFlush, secondFlush]);

  assert.deepEqual(
    (await database.all<{ imdb: string }>("SELECT imdb FROM external_ids ORDER BY imdb")).map((row) => row.imdb),
    ["tt0000004", "tt0000005"],
  );
});

test("an external id whose batch failed is written by the next flush", async (t) => {
  const { dataDir, database } = await fixture(t);
  let failNext = false;
  const flaky = new Proxy(database, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: Statement[]) => {
          if (failNext) { failNext = false; throw new Error("database busy"); }
          return await target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const store = new ExternalIdStore(dataDir, answer("606"));
  store.attachDatabase(flaky);
  await store.load();

  failNext = true;
  assert.deepEqual(await store.ids("tt0000006"), { tmdbMovie: "606" });
  await store.flush();
  assert.deepEqual(await database.all("SELECT imdb FROM external_ids"), [], "the first attempt failed");
  await store.flush();
  assert.deepEqual(await database.all("SELECT imdb FROM external_ids"), [{ imdb: "tt0000006" }]);
});
