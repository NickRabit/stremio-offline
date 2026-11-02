import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ACTIVITY_LIMIT, ActivityLog, type Activity } from "./activity.js";
import {
  openAppDatabase,
  StorageError,
  type AppDatabase,
  type Statement,
} from "./storage/app-database.js";

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "activity-sqlite-"));
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
    file: path.join(dataDir, "activity.json"),
    get database() { return database; },
    async reopen() {
      await database.close();
      database = await openAppDatabase({ dataDir });
      return database;
    },
  };
}

function observingBatch(
  database: AppDatabase,
  seen: Statement[][],
  beforeBatch?: (statements: Statement[]) => Promise<void>,
): AppDatabase {
  return new Proxy(database, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: Statement[]) => {
          seen.push(statements);
          await beforeBatch?.(statements);
          return await target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function marker(database: AppDatabase) {
  const row = await database.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", ["domain.activity"]);
  return row ? JSON.parse(row.value) as Record<string, unknown> : undefined;
}

test("activity JSON imports once and a restart loads the same page", async (t) => {
  const { dataDir, file, database, reopen } = await fixture(t);
  const saved: Activity[] = [
    { id: 7, at: new Date(Date.now() - 2 * 60_000).toISOString(), kind: "playback", title: "Heat", userId: "ada", username: "Ada" },
    { id: 9, at: new Date(Date.now() - 60_000).toISOString(), kind: "device", title: "Heat.mkv", filename: "Heat.mkv", partial: true },
  ];
  await writeFile(file, JSON.stringify(saved));
  const baseline = new ActivityLog(dataDir);
  await baseline.load();
  const expected = baseline.page(24);

  const imported = new ActivityLog(dataDir);
  imported.attachDatabase(database);
  await imported.load();

  assert.deepEqual(imported.page(24), expected);
  const importedMarker = await marker(database);
  assert.equal(typeof importedMarker?.importedAt, "number");
  assert.deepEqual({ ...importedMarker, importedAt: undefined }, { importedAt: undefined, source: "activity.json", count: 2 });
  assert.deepEqual(await database.all("SELECT id, title FROM activity ORDER BY id"), [
    { id: 7, title: "Heat" },
    { id: 9, title: "Heat.mkv" },
  ]);
  await assert.rejects(stat(file), { code: "ENOENT" });
  assert.equal((await readdir(path.join(dataDir, "migration-backup"))).length, 1);

  const restarted = new ActivityLog(dataDir);
  restarted.attachDatabase(await reopen());
  await restarted.load();
  assert.deepEqual(restarted.page(24), expected);
});

test("three records flush in one batch with three inserts", async (t) => {
  const { dataDir, database } = await fixture(t);
  const batches: Statement[][] = [];
  const log = new ActivityLog(dataDir);
  log.attachDatabase(observingBatch(database, batches));
  await log.load();

  log.record({ kind: "playback", title: "One" });
  log.record({ kind: "playback", title: "Two" });
  log.record({ kind: "playback", title: "Three" });
  await log.flush();

  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.filter((statement) => statement.sql.startsWith("INSERT INTO activity")).length, 3);
  assert.equal(batches[0]!.some((statement) => statement.sql.startsWith("DELETE FROM activity")), false);
  assert.deepEqual(await database.get("SELECT COUNT(*) AS count FROM activity"), { count: 3 });
});

test("the 5001st activity entry deletes only the oldest row", async (t) => {
  const { dataDir, database } = await fixture(t);
  const log = new ActivityLog(dataDir);
  log.attachDatabase(database);
  await log.load();

  for (let index = 0; index < ACTIVITY_LIMIT + 1; index += 1) {
    log.record({ kind: "playback", title: `Entry ${index + 1}` });
  }
  await log.flush();

  assert.deepEqual(await database.get("SELECT COUNT(*) AS count FROM activity"), { count: ACTIVITY_LIMIT });
  assert.equal(await database.get("SELECT id FROM activity WHERE id = 1"), undefined);
  assert.deepEqual(await database.get("SELECT MAX(id) AS id FROM activity"), { id: ACTIVITY_LIMIT + 1 });
});

test("an ambiguous failed batch stays unsaved and the next flush does not duplicate it", async (t) => {
  const { dataDir, database } = await fixture(t);
  const batches: Statement[][] = [];
  let fail = true;
  const wrapped = observingBatch(database, batches, async (statements) => {
    if (!fail) return;
    fail = false;
    await database.batch(statements);
    throw new Error("database reply was lost");
  });
  const log = new ActivityLog(dataDir);
  log.attachDatabase(wrapped);
  await log.load();

  log.record({ kind: "playback", title: "Heat" });
  await assert.rejects(log.flush(), /database reply was lost/);
  assert.deepEqual(await database.get("SELECT COUNT(*) AS count FROM activity"), { count: 1 });

  await log.flush();
  assert.equal(batches.length, 2);
  assert.equal(batches[1]!.filter((statement) => statement.sql.startsWith("INSERT INTO activity")).length, 1);
  assert.deepEqual(await database.all("SELECT id, title FROM activity"), [
    { id: 1, title: "Heat" },
  ]);
});

test("an unparsable activity file is moved aside and starts empty", async (t) => {
  const { dataDir, file, database } = await fixture(t);
  await writeFile(file, "{not json");
  const log = new ActivityLog(dataDir);
  log.attachDatabase(database);

  await log.load();

  assert.deepEqual(log.page(24).items, []);
  const unreadableMarker = await marker(database);
  assert.equal(typeof unreadableMarker?.importedAt, "number");
  assert.deepEqual({ ...unreadableMarker, importedAt: undefined }, { importedAt: undefined, source: "unreadable", count: 0 });
  const [backup] = await readdir(path.join(dataDir, "migration-backup"));
  assert.equal(await readFile(path.join(dataDir, "migration-backup", backup!), "utf8"), "{not json");
});
