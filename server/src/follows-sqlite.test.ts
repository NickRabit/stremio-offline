import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { FollowStore, type Follow, type FollowEpisode } from "./follows.js";
import { AppError } from "./errors.js";
import {
  openAppDatabase,
  StorageError,
  type AppDatabase,
  type Statement,
} from "./storage/app-database.js";

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "follows-sqlite-"));
  const databases: AppDatabase[] = [];
  let database = await openAppDatabase({ dataDir });
  databases.push(database);
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    for (const opened of databases.reverse()) {
      try {
        await opened.close();
      } catch (error) {
        if (!(error instanceof StorageError) || error.code !== "broken") throw error;
      }
    }
    await rm(dataDir, { recursive: true, force: true });
  };
  t.after(close);

  return {
    dataDir,
    file: path.join(dataDir, "follows.json"),
    get database() { return database; },
    async reopen() {
      await database.close();
      database = await openAppDatabase({ dataDir });
      databases.push(database);
      return database;
    },
    store(attached: AppDatabase = database) {
      const store = new FollowStore(dataDir);
      store.attachDatabase(attached);
      return store;
    },
    close,
  };
}

function observingBatch(database: AppDatabase, batches: Statement[][]): AppDatabase {
  return new Proxy(database, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: Statement[]) => {
          batches.push(statements);
          return await target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function failingBatch(database: AppDatabase): AppDatabase {
  let fail = true;
  return new Proxy(database, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: Statement[]) => {
          if (fail) {
            fail = false;
            throw new Error("database write failed");
          }
          return await target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function marker(database: AppDatabase) {
  const row = await database.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", ["domain.follows"]);
  return row ? JSON.parse(row.value) as Record<string, unknown> : undefined;
}

function follow(id: string, ownerUserId: string, name: string): Follow {
  return {
    id,
    ownerUserId,
    type: "series",
    metaId: `tt-${id}`,
    name,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:01:00.000Z",
    enabled: true,
    revision: 1,
    nextCheckAt: "2026-11-02T10:00:00.000Z",
    failures: 0,
    episodes: {},
  };
}

function episode(key: string, videoId: string): FollowEpisode {
  const [season, number] = key.split(":").map(Number);
  return {
    key,
    videoId,
    season: season!,
    episode: number!,
    firstSeenAt: "2026-11-01T10:00:00.000Z",
  };
}

test("the follow store imports JSON once and restores rows in order", async (t) => {
  const { file, database, reopen, store, close } = await fixture(t);
  const saved = [follow("follow-a", "user-a", "Alpha"), follow("follow-b", "user-b", "Beta"), follow("follow-c", "user-a", "Gamma")];
  await writeFile(file, JSON.stringify({ version: 1, follows: saved }, null, 2));

  const first = store();
  await first.load();

  assert.deepEqual(first.all().map((item) => [item.id, item.name]), saved.map((item) => [item.id, item.name]));
  const rows = await database.all<{ id: string; position: number; data: string }>(
    "SELECT id, position, data FROM follows ORDER BY position",
  );
  assert.deepEqual(rows.map((row) => [row.id, row.position]), [["follow-a", 0], ["follow-b", 1], ["follow-c", 2]]);
  assert.deepEqual(rows.map((row) => JSON.parse(row.data)), saved);
  assert.ok(rows.every((row) => !row.data.includes("\n")));

  const imported = await marker(database);
  assert.equal(typeof imported?.importedAt, "number");
  assert.deepEqual({ ...imported, importedAt: undefined }, {
    importedAt: undefined,
    source: "follows.json",
    count: 3,
  });
  await assert.rejects(stat(file), { code: "ENOENT" });
  assert.equal((await readdir(path.join(path.dirname(file), "migration-backup"))).length, 1);

  await first.flush();
  const restarted = store(await reopen());
  await restarted.load();
  assert.deepEqual(restarted.all().map((item) => [item.id, item.name]), saved.map((item) => [item.id, item.name]));
  await close();
});

test("a check of one of three follows writes exactly one upsert", async (t) => {
  const { database, store, close } = await fixture(t);
  const batches: Statement[][] = [];
  const target = store(observingBatch(database, batches));
  await target.load();
  const follows = [
    await target.create({ ownerUserId: "user-a", type: "series", metaId: "tt-a", name: "Alpha" }, 1_000),
    await target.create({ ownerUserId: "user-a", type: "series", metaId: "tt-b", name: "Beta" }, 1_000),
    await target.create({ ownerUserId: "user-a", type: "series", metaId: "tt-c", name: "Gamma" }, 1_000),
  ];
  batches.length = 0;

  await target.recordCheck(follows[1]!.id, { episodes: [episode("1:1", "tt-b:1:1")], now: 2_000 });

  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 1);
  assert.match(batches[0]![0]!.sql, /^INSERT INTO follows /);
  assert.deepEqual(batches[0]![0]!.params?.slice(0, 2), [follows[1]!.id, 1]);
  await close();
});

test("a persist with no changes executes no statement", async (t) => {
  const { database, store, close } = await fixture(t);
  const batches: Statement[][] = [];
  const target = store(observingBatch(database, batches));
  await target.load();
  batches.length = 0;

  await target.flush();

  assert.equal(batches.length, 0);
  await close();
});

test("removing the middle follow deletes its row and later positions survive a restart", async (t) => {
  const { file, database, reopen, store, close } = await fixture(t);
  const saved = [follow("follow-a", "user-a", "Alpha"), follow("follow-b", "user-b", "Beta"), follow("follow-c", "user-a", "Gamma")];
  await writeFile(file, JSON.stringify({ version: 1, follows: saved }));
  const first = store();
  await first.load();

  await first.remove("follow-b");

  assert.deepEqual(await database.all("SELECT id, position FROM follows ORDER BY position"), [
    { id: "follow-a", position: 0 },
    { id: "follow-c", position: 1 },
  ]);

  await first.flush();
  const restarted = store(await reopen());
  await restarted.load();
  assert.deepEqual(restarted.all().map((item) => item.id), ["follow-a", "follow-c"]);
  await close();
});

test("removing an owner deletes only that owner's rows", async (t) => {
  const { database, store, close } = await fixture(t);
  const target = store();
  await target.load();
  const first = await target.create({ ownerUserId: "user-a", type: "series", metaId: "tt-a", name: "Alpha" }, 1_000);
  const second = await target.create({ ownerUserId: "user-b", type: "series", metaId: "tt-b", name: "Beta" }, 1_000);
  const third = await target.create({ ownerUserId: "user-a", type: "series", metaId: "tt-c", name: "Gamma" }, 1_000);

  assert.equal(await target.removeOwner("user-a"), 2);

  assert.deepEqual(await database.all("SELECT id, position FROM follows ORDER BY position"), [
    { id: second.id, position: 0 },
  ]);
  assert.equal(await database.get("SELECT id FROM follows WHERE id = ?", [first.id]), undefined);
  assert.equal(await database.get("SELECT id FROM follows WHERE id = ?", [third.id]), undefined);
  await close();
});

test("an unreadable follow file blocks the import without moving it or writing a marker", async (t) => {
  const { file, database, store, close } = await fixture(t);
  await writeFile(file, "{not json");
  const target = store();
  await target.load();

  assert.equal(target.unavailable, true);
  assert.deepEqual(target.all(), []);
  await assert.rejects(
    target.create({ ownerUserId: "user-a", type: "series", metaId: "tt-a", name: "Alpha" }, 1_000),
    (error: AppError) => error.messageKey === "err.followsUnreadable",
  );
  assert.equal(await readFile(file, "utf8"), "{not json");
  assert.equal(await marker(database), undefined);
  assert.equal(await database.get("SELECT id FROM follows"), undefined);
  await close();
});

test("a failing batch rejects the caller and leaves the in-memory follow in place", async (t) => {
  const { database, store, close } = await fixture(t);
  const target = store(failingBatch(database));
  await target.load();

  await assert.rejects(
    target.create({ ownerUserId: "user-a", type: "series", metaId: "tt-a", name: "Alpha" }, 1_000),
    /database write failed/,
  );

  assert.equal(target.all().length, 1);
  assert.equal(await database.get("SELECT id FROM follows"), undefined);

  await target.flush();
  assert.deepEqual(await database.get("SELECT id FROM follows"), { id: target.all()[0]!.id });
  await close();
});

test("database rows are sanitized when loaded", async (t) => {
  const { database, store, close } = await fixture(t);
  const saved = follow("follow-a", "user-a", "Alpha");
  saved.episodes["1:1"] = {
    ...episode("1:1", "tt-a:1:1"),
    download: {
      state: "queued",
      intent: "follow-a:1:1:1",
      generation: 1,
      jobId: "job-a",
      attempts: 0,
      updatedAt: "2026-11-01T10:00:00.000Z",
      sourceAdmission: { schemaVersion: 2 } as never,
    },
  };
  await database.batch([
    {
      sql: "INSERT INTO meta (key, value) VALUES (?, ?)",
      params: ["domain.follows", JSON.stringify({ importedAt: 1, source: "follows.json", count: 1 })],
    },
    {
      sql: "INSERT INTO follows (id, position, data) VALUES (?, ?, ?)",
      params: [saved.id, 0, JSON.stringify(saved)],
    },
  ]);

  const target = store();
  await target.load();

  const download = target.get(saved.id)?.episodes["1:1"]?.download;
  assert.equal(download?.state, "attention");
  assert.equal(download?.reasonKey, "err.followJobMissing");
  assert.equal(download?.sourceAdmission, undefined);
  await close();
});
