import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { StatsLog, summarize, type TrafficEvent, type TrafficMeta } from "./stats.js";
import {
  openAppDatabase,
  StorageError,
  type AppDatabase,
  type Statement,
} from "./storage/app-database.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function fixture(t: TestContext, limit?: number) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "stats-sqlite-"));
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
    file: path.join(dataDir, "stats.json"),
    get database() { return database; },
    open() {
      return new StatsLog(dataDir, limit === undefined ? {} : { limit });
    },
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

function failingBatch(database: AppDatabase, seen: Statement[][]): AppDatabase {
  let fail = true;
  return new Proxy(database, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: Statement[]) => {
          seen.push(statements);
          if (!fail) return await target.batch(statements);
          fail = false;
          await target.batch(statements);
          throw new Error("database reply was lost");
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function marker(database: AppDatabase) {
  const row = await database.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", ["domain.traffic"]);
  return row ? JSON.parse(row.value) as Record<string, unknown> : undefined;
}

const meta: TrafficMeta = {
  source: "download",
  provider: "cdn.jedna.cz",
  addonKey: "torrentio",
  addonName: "Torrentio",
  title: "Dune",
  kind: "movie",
};

function event(at: number, bytes: number, overrides: Partial<TrafficEvent> = {}): TrafficEvent {
  return {
    at: new Date(at).toISOString(),
    source: "download",
    provider: "cdn.jedna.cz",
    addonKey: "torrentio",
    addonName: "Torrentio",
    title: "Dune",
    kind: "movie",
    bytes,
    items: 1,
    ...overrides,
  };
}

test("traffic JSON imports once and a restart gives the same summary", async (t) => {
  const { dataDir, file, database, open, reopen } = await fixture(t);
  const now = Date.now();
  const saved = [
    event(now - 3 * HOUR, 300),
    event(now - 2 * HOUR, 200, { source: "catalog", provider: "cdn.dva.cz" }),
    { ...event(now - HOUR, 100), items: 0 },
  ];
  await writeFile(file, JSON.stringify(saved));
  const expected = summarize(saved, 24);

  const first = open();
  first.attachDatabase(database);
  await first.load();
  assert.deepEqual(first.summary(24), expected);
  assert.equal((await marker(database) as { source: string }).source, "stats.json");
  assert.equal((await marker(database) as { count: number }).count, 3);
  await assert.rejects(stat(file), { code: "ENOENT" });
  assert.ok((await readdir(path.join(dataDir, "migration-backup"))).some((name) => name.startsWith("stats-")));

  const restarted = open();
  restarted.attachDatabase(await reopen());
  await restarted.load();
  assert.deepEqual(restarted.summary(24), expected);
});

test("one add and flush inserts only one row, and the next empty flush writes nothing", async (t) => {
  const { database, open } = await fixture(t);
  const batches: Statement[][] = [];
  const stats = open();
  stats.attachDatabase(observingBatch(database, batches));
  await stats.load();
  batches.length = 0;

  stats.add(meta, 123);
  await stats.flush();

  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 1);
  assert.match(batches[0]![0]!.sql, /^INSERT INTO traffic_events/);
  assert.deepEqual(await database.all("SELECT seq, bytes, items FROM traffic_events"), [{ seq: 1, bytes: 123, items: 0 }]);

  await stats.flush();
  assert.equal(batches.length, 1);
});

test("a committed batch with a lost reply is retried without duplicating traffic", async (t) => {
  const { database, open } = await fixture(t);
  const batches: Statement[][] = [];
  const stats = open();
  stats.attachDatabase(failingBatch(database, batches));
  await stats.load();

  stats.add(meta, 123);
  await assert.rejects(stats.flush(), /database reply was lost/);
  assert.deepEqual(await database.get("SELECT COUNT(*) AS count FROM traffic_events"), { count: 1 });

  await stats.flush();
  assert.equal(batches.length, 2);
  assert.deepEqual(await database.all("SELECT seq, bytes FROM traffic_events"), [{ seq: 1, bytes: 123 }]);
});

test("compaction replaces only old rows and preserves the seq of newer rows", async (t) => {
  const { dataDir, file, database, open } = await fixture(t);
  const now = Date.now();
  const old = Math.floor((now - 2 * DAY) / HOUR) * HOUR;
  const newer = now - HOUR;
  const saved = [
    event(old + 5 * 60_000, 10),
    event(old + 20 * 60_000, 20),
    event(newer, 30, { title: "Newer" }),
  ];
  await writeFile(file, JSON.stringify(saved));
  const batches: Statement[][] = [];
  const stats = open();
  stats.attachDatabase(observingBatch(database, batches));
  await stats.load();
  batches.length = 0;

  stats.add(meta, 40);
  await stats.flush();

  const compactionDelete = batches.flat().find((statement) => statement.sql === "DELETE FROM traffic_events WHERE at < ?");
  assert.ok(compactionDelete);
  const rows = await database.all<{ seq: number; at: string; bytes: number }>(
    "SELECT seq, at, bytes FROM traffic_events ORDER BY seq",
  );
  assert.deepEqual(rows, [
    { seq: 1, at: new Date(old).toISOString(), bytes: 30 },
    { seq: 3, at: new Date(newer).toISOString(), bytes: 30 },
    { seq: 4, at: rows[2]!.at, bytes: 40 },
  ]);
});

test("a compaction that changes nothing does not issue its delete", async (t) => {
  const { dataDir, file, database, open } = await fixture(t);
  const oldHour = Math.floor((Date.now() - 2 * DAY) / HOUR) * HOUR;
  await writeFile(file, JSON.stringify([event(oldHour, 10)]));
  const batches: Statement[][] = [];
  const stats = open();
  stats.attachDatabase(observingBatch(database, batches));
  await stats.load();
  batches.length = 0;

  stats.add(meta, 20);
  await stats.flush();

  assert.equal(batches.flat().some((statement) => statement.sql === "DELETE FROM traffic_events WHERE at < ?"), false);
  assert.deepEqual(await database.all("SELECT seq, at FROM traffic_events ORDER BY seq"), [
    { seq: 1, at: new Date(oldHour).toISOString() },
    { seq: 2, at: batches.flat()[0]!.params![1] },
  ]);
});

test("trimming with a small limit deletes only the oldest rows", async (t) => {
  const { dataDir, file, database, open } = await fixture(t, 2);
  const now = Date.now();
  await writeFile(file, JSON.stringify([
    event(now - 3 * HOUR, 10, { title: "Oldest" }),
    event(now - 2 * HOUR, 20),
    event(now - HOUR, 30),
  ]));
  const stats = open();
  stats.attachDatabase(database);
  await stats.load();

  stats.add(meta, 40);
  await stats.flush();

  assert.deepEqual(await database.all("SELECT seq, bytes FROM traffic_events ORDER BY seq"), [
    { seq: 3, bytes: 30 },
    { seq: 4, bytes: 40 },
  ]);
});
