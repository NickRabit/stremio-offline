import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ImageStats } from "./image-stats.js";
import {
  openAppDatabase,
  StorageError,
  type AppDatabase,
  type Statement,
} from "./storage/app-database.js";

const NOW = Date.parse("2026-10-14T12:30:00Z");
const HOUR = 60 * 60 * 1000;

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "image-stats-sqlite-"));
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
    file: path.join(dataDir, "image-stats.json"),
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
  beforeBatch?: (statements: Statement[]) => Promise<void>,
): AppDatabase {
  return new Proxy(database, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: Statement[]) => {
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
  const row = await database.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", ["domain.imageStats"]);
  return row ? JSON.parse(row.value) as Record<string, unknown> : undefined;
}

async function countRows(database: AppDatabase) {
  return await database.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM hourly_counts WHERE domain = ?",
    ["imageStats"],
  );
}

test("an existing JSON file is imported once and a restart loads the table", async (t) => {
  const { dataDir, file, database, reopen } = await fixture(t);
  const saved = [
    {
      at: new Date(NOW - 2 * HOUR).toISOString(),
      catalog: { memory: 1, disk: 0, upstream: 0 },
      library: { memory: 0, disk: 0, upstream: 0 },
      remote: { memory: 2, disk: 1, upstream: 0 },
      home: { memory: 0, disk: 0, upstream: 0 },
    },
    {
      at: new Date(NOW - HOUR).toISOString(),
      catalog: { memory: 0, disk: 0, upstream: 0 },
      library: { memory: 0, disk: 0, upstream: 1 },
      remote: { memory: 0, disk: 0, upstream: 0 },
      home: { memory: 0, disk: 0, upstream: 0 },
    },
  ];
  await writeFile(file, JSON.stringify(saved));
  const baseline = new ImageStats(file, () => NOW);
  await baseline.load();
  const expected = baseline.summary(24);

  const first = new ImageStats(file, () => NOW);
  first.attachDatabase(database);
  await first.load();

  assert.deepEqual(first.summary(24), expected);
  assert.deepEqual(await marker(database), { importedAt: NOW, source: "image-stats.json", count: 4 });
  assert.deepEqual(await countRows(database), { count: 4 });
  await assert.rejects(stat(file), { code: "ENOENT" });
  const backups = await readdir(path.join(dataDir, "migration-backup"));
  assert.deepEqual(backups, [`image-stats-${NOW}.json`]);

  const reopened = await reopen();
  const restarted = new ImageStats(file, () => NOW);
  restarted.attachDatabase(reopened);
  await restarted.load();
  assert.deepEqual(restarted.summary(24), expected);
});

test("three records in one hour flush as one row with the absolute count", async (t) => {
  const { file, database } = await fixture(t);
  const stats = new ImageStats(file, () => NOW);
  stats.attachDatabase(database);
  await stats.load();

  stats.record("remote", "memory");
  stats.record("remote", "memory");
  stats.record("remote", "memory");
  await stats.flush();

  assert.deepEqual(await countRows(database), { count: 1 });
  assert.deepEqual(await database.all("SELECT hour, key, count FROM hourly_counts"), [{
    hour: new Date(Math.floor(NOW / HOUR) * HOUR).toISOString(),
    key: "remote.memory",
    count: 3,
  }]);
});

test("a count recorded during a database write remains dirty for the next flush", async (t) => {
  const { file, database } = await fixture(t);
  let entered!: () => void;
  let release!: () => void;
  const didEnter = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const wrapped = observingBatch(database, async (statements) => {
    if (!statements.some((statement) => statement.sql.startsWith("INSERT INTO hourly_counts"))) return;
    entered();
    await gate;
  });
  const stats = new ImageStats(file, () => NOW);
  stats.attachDatabase(wrapped);
  await stats.load();

  stats.record("remote", "memory");
  const firstFlush = stats.flush();
  await didEnter;
  stats.record("remote", "memory");
  release();
  await firstFlush;
  assert.deepEqual(await database.get("SELECT count FROM hourly_counts"), { count: 1 });

  await stats.flush();
  assert.deepEqual(await database.get("SELECT count FROM hourly_counts"), { count: 2 });
});

test("a failed database batch leaves the pair dirty for a later flush", async (t) => {
  const { file, database } = await fixture(t);
  let fail = false;
  const wrapped = observingBatch(database, async () => {
    if (fail) throw new Error("database write failed");
  });
  const stats = new ImageStats(file, () => NOW);
  stats.attachDatabase(wrapped);
  await stats.load();

  stats.record("catalog", "disk");
  fail = true;
  await assert.rejects(stats.flush(), /database write failed/);
  assert.equal(await database.get("SELECT count FROM hourly_counts"), undefined);

  fail = false;
  await stats.flush();
  assert.deepEqual(await database.get("SELECT count FROM hourly_counts"), { count: 1 });
});

test("an unparsable JSON file is moved and does not block database startup", async (t) => {
  const { dataDir, file, database } = await fixture(t);
  await writeFile(file, "{not json");
  const stats = new ImageStats(file, () => NOW);
  stats.attachDatabase(database);

  await stats.load();

  assert.deepEqual(stats.summary(24), {
    catalog: { memory: 0, disk: 0, upstream: 0 },
    library: { memory: 0, disk: 0, upstream: 0 },
    remote: { memory: 0, disk: 0, upstream: 0 },
    home: { memory: 0, disk: 0, upstream: 0 },
  });
  assert.deepEqual(await marker(database), { importedAt: NOW, source: "unreadable", count: 0 });
  assert.deepEqual(await readdir(path.join(dataDir, "migration-backup")), [`image-stats-unreadable-${NOW}.json`]);
  await assert.rejects(stat(file), { code: "ENOENT" });
  assert.deepEqual(await readFile(path.join(dataDir, "migration-backup", `image-stats-unreadable-${NOW}.json`), "utf8"), "{not json");
});
