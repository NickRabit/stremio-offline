import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import {
  openAppDatabase,
  StorageError,
  type AppDatabase,
  type OpenAppDatabaseOptions,
} from "./app-database.js";
import { MIGRATIONS, type Migration } from "./migrations.js";

function fixture(t: TestContext) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "app-database-"));
  const opened: AppDatabase[] = [];
  t.after(async () => {
    for (const database of opened) {
      try {
        await database.close();
      } catch (error) {
        if (!(error instanceof StorageError) || error.code !== "broken") throw error;
      }
    }
    rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir,
    async open(options: Omit<OpenAppDatabaseOptions, "dataDir"> = {}) {
      const database = await openAppDatabase({ dataDir, ...options });
      opened.push(database);
      return database;
    },
  };
}

test("a fresh database has the schema and an owner-only file", async (t) => {
  const { open } = fixture(t);
  const database = await open();
  assert.equal(database.info.schemaVersion, 11);
  assert.equal(database.info.journalMode, "wal");
  assert.deepEqual(
    await database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'"),
    { name: "meta" },
  );
  assert.deepEqual(
    await database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'image_sources'"),
    { name: "image_sources" },
  );
  assert.deepEqual(
    await database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hourly_counts'"),
    { name: "hourly_counts" },
  );
  assert.deepEqual(
    await database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'activity'"),
    { name: "activity" },
  );
  assert.deepEqual(
    await database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'traffic_events'"),
    { name: "traffic_events" },
  );
  assert.deepEqual(
    await database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_facts'"),
    { name: "file_facts" },
  );
  assert.deepEqual(
    await database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tmdb_ids'"),
    { name: "tmdb_ids" },
  );
  assert.deepEqual(
    await database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'download_jobs'"),
    { name: "download_jobs" },
  );
  assert.deepEqual(
    await database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'follows'"),
    { name: "follows" },
  );
  assert.deepEqual(
    await database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'library_meta'"),
    { name: "library_meta" },
  );
  assert.deepEqual(
    await database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'library_episodes'"),
    { name: "library_episodes" },
  );
  assert.deepEqual(
    await database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'personal_rows'"),
    { name: "personal_rows" },
  );
  assert.deepEqual(
    await database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_fingerprints'"),
    { name: "file_fingerprints" },
  );
  if (process.platform !== "win32") {
    assert.equal(statSync(database.info.file).mode & 0o777, 0o600);
  }
});

test("reopening applies only migrations newer than the stored schema version", async (t) => {
  const { open } = fixture(t);
  const migration: Migration = {
    version: 12,
    statements: [
      "CREATE TABLE migration_runs (id INTEGER PRIMARY KEY)",
      "INSERT INTO migration_runs (id) VALUES (1)",
    ],
  };
  const migrations = [...MIGRATIONS, migration];
  const first = await open({ migrations });
  await first.close();
  const second = await open({ migrations });
  assert.deepEqual(await second.all("SELECT id FROM migration_runs"), [{ id: 1 }]);
  assert.equal(second.info.schemaVersion, 12);
});

test("a failed batch statement rolls back the whole transaction", async (t) => {
  const { open } = fixture(t);
  const database = await open();
  await database.run("CREATE TABLE entries (id INTEGER PRIMARY KEY)");
  await assert.rejects(
    database.batch([
      { sql: "INSERT INTO entries (id) VALUES (1)" },
      { sql: "INSERT INTO missing_table (id) VALUES (2)" },
    ]),
    { name: "StorageError", code: "sql" },
  );
  assert.deepEqual(await database.all("SELECT id FROM entries"), []);
});

test("interleaved calls resolve in submission order and see earlier writes", async (t) => {
  const { open } = fixture(t);
  const database = await open();
  await database.run("CREATE TABLE values_table (id INTEGER PRIMARY KEY)");
  const resolved: number[] = [];
  const calls: Promise<unknown>[] = [];
  for (let index = 0; index < 100; index += 1) {
    if (index % 2 === 0) {
      const id = index / 2;
      calls.push(database.run("INSERT INTO values_table (id) VALUES (?)", [id]).then((result) => {
        resolved.push(index);
        return result;
      }));
    } else {
      const id = (index - 1) / 2;
      calls.push(database.get<{ id: number }>("SELECT id FROM values_table WHERE id = ?", [id]).then((row) => {
        resolved.push(index);
        return row;
      }));
    }
  }
  const results = await Promise.all(calls);
  assert.deepEqual(resolved, Array.from({ length: 100 }, (_, index) => index));
  for (let index = 1; index < results.length; index += 2) {
    assert.deepEqual(results[index], { id: (index - 1) / 2 });
  }
});

test("calls beyond maxPending are rejected as busy", async (t) => {
  const { open } = fixture(t);
  const database = await open({ maxPending: 2 });
  const first = database.all("SELECT 1 AS value");
  const second = database.all("SELECT 2 AS value");
  await assert.rejects(database.all("SELECT 3 AS value"), { name: "StorageError", code: "busy" });
  await Promise.all([first, second]);
});

test("close drains accepted calls and rejects later calls", async (t) => {
  const { open } = fixture(t);
  const database = await open();
  await database.run("CREATE TABLE entries (id INTEGER PRIMARY KEY)");
  const accepted = database.run("INSERT INTO entries (id) VALUES (1)");
  const closing = database.close();
  await accepted;
  await assert.rejects(database.run("INSERT INTO entries (id) VALUES (2)"), { name: "StorageError", code: "closed" });
  await closing;
  assert.equal(database.state, "closed");
  await database.close();
});

test("a newer schema is refused without changing the file", async (t) => {
  const { dataDir, open } = fixture(t);
  const file = path.join(dataDir, "application.sqlite");
  const handmade = new DatabaseSync(file);
  handmade.exec("PRAGMA user_version = 99");
  handmade.close();
  const before = readFileSync(file);
  await assert.rejects(open(), { name: "StorageError", code: "newer-schema" });
  assert.deepEqual(readFileSync(file), before);
  const check = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 99);
  } finally {
    check.close();
  }
});

test("a worker crash breaks pending and later calls", async (t) => {
  const { open } = fixture(t);
  let worker: Worker | undefined;
  const database = await open({ onWorker: (created) => { worker = created; } });
  assert.ok(worker);
  // A query long enough that the worker is still inside it when it is terminated; a trivial
  // one can finish first on a fast runner, and then nothing is pending to break.
  const pending = database.get("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 200000000) SELECT count(*) AS value FROM c");
  const terminated = worker.terminate();
  await assert.rejects(pending, { name: "StorageError", code: "broken" });
  await terminated;
  assert.equal(database.state, "broken");
  await assert.rejects(database.get("SELECT 1 AS value"), { name: "StorageError", code: "broken" });
});
