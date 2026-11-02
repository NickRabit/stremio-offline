import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { LibrarySeenStore, type SeenFile } from "./library-seen.js";
import {
  openAppDatabase,
  StorageError,
  type AppDatabase,
  type Statement,
} from "./storage/app-database.js";

const file = (relative: string, size: number, modified: string) => ({ relative, size, modified });
const seenFile = (dataDir: string) => path.join(dataDir, "library-seen.json");

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "library-seen-sqlite-"));
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
  const row = await database.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", ["domain.librarySeen"]);
  return row ? JSON.parse(row.value) as Record<string, unknown> : undefined;
}

test("library-seen JSON is imported once and a restart answers the same", async (t) => {
  const { dataDir, database, reopen } = await fixture(t);
  await writeFile(seenFile(dataDir), JSON.stringify({
    version: 1,
    libraries: {
      lib_a: {
        baselineAt: "2026-01-01T00:00:00.000Z",
        files: {
          "Old.mkv": { at: "2026-01-01T00:00:00.000Z", baseline: true, size: 10, mtimeMs: 100 },
          "New.mkv": { at: "2026-02-01T00:00:00.000Z", size: 20, mtimeMs: 200 },
        },
      },
    },
  }));
  const batches: Statement[][] = [];
  const store = new LibrarySeenStore(dataDir);
  store.attachDatabase(observingBatch(database, batches));
  await store.load();

  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.filter((statement) => statement.sql.startsWith("INSERT INTO library_seen ")).length, 2);
  assert.equal(batches[0]!.filter((statement) => statement.sql.startsWith("INSERT INTO library_seen_libraries")).length, 1);
  const imported = await marker(database);
  assert.equal(imported?.source, "library-seen.json");
  assert.equal(imported?.count, 2);
  assert.equal(typeof imported?.importedAt, "number", "a numeric stamp keeps the backup name free of a colon");
  assert.deepEqual(store.recent(["lib_a"], 60), [
    { libraryId: "lib_a", relative: "New.mkv", at: "2026-02-01T00:00:00.000Z" },
  ]);
  await assert.rejects(stat(seenFile(dataDir)), { code: "ENOENT" });

  const restarted = new LibrarySeenStore(dataDir);
  const restartedBatches: Statement[][] = [];
  restarted.attachDatabase(observingBatch(await reopen(), restartedBatches));
  await restarted.load();
  await restarted.flush();
  assert.equal(restartedBatches.length, 0);
  assert.deepEqual(restarted.recent(["lib_a"], 60), store.recent(["lib_a"], 60));
});

test("one library-seen change writes one upsert and no JSON file", async (t) => {
  const { dataDir, database } = await fixture(t);
  const batches: Statement[][] = [];
  const store = new LibrarySeenStore(dataDir);
  store.attachDatabase(observingBatch(database, batches));
  await store.load();
  batches.length = 0;

  store.observe("lib_a", [file("A.mkv", 10, "2026-01-01T00:00:00.000Z")], new Date("2026-02-01T00:00:00.000Z"));
  await store.flush();
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 2, "the library baseline and its only file");
  batches.length = 0;

  store.observe("lib_a", [file("A.mkv", 11, "2026-01-02T00:00:00.000Z")], new Date("2026-02-02T00:00:00.000Z"));
  await store.flush();
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 1);
  assert.match(batches[0]![0]!.sql, /^INSERT INTO library_seen /);
  assert.deepEqual(batches[0]![0]!.params?.slice(0, 2), ["lib_a", "A.mkv"]);
  await assert.rejects(stat(seenFile(dataDir)), { code: "ENOENT" });

  batches.length = 0;
  await store.flush();
  assert.equal(batches.length, 0);
});

test("a vanished library-seen file writes a delete and forget removes its rows", async (t) => {
  const { dataDir, database } = await fixture(t);
  const batches: Statement[][] = [];
  const store = new LibrarySeenStore(dataDir);
  store.attachDatabase(observingBatch(database, batches));
  await store.load();
  store.observe("lib_a", [
    file("A.mkv", 10, "2026-01-01T00:00:00.000Z"),
    file("B.mkv", 20, "2026-01-01T00:00:00.000Z"),
  ], new Date("2026-02-01T00:00:00.000Z"));
  store.observe("lib_b", [file("C.mkv", 30, "2026-01-01T00:00:00.000Z")], new Date("2026-02-01T00:00:00.000Z"));
  await store.flush();
  batches.length = 0;

  store.observe("lib_a", [file("A.mkv", 10, "2026-01-01T00:00:00.000Z")], new Date("2026-03-01T00:00:00.000Z"));
  await store.flush();
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 1);
  assert.match(batches[0]![0]!.sql, /^DELETE FROM library_seen /);
  assert.deepEqual(batches[0]![0]!.params, ["lib_a", "B.mkv"]);

  batches.length = 0;
  await store.forget("lib_a");
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 2);
  assert.ok(batches[0]!.every((statement) => statement.sql.startsWith("DELETE")));
  assert.deepEqual(await database.all("SELECT library_id, path FROM library_seen ORDER BY library_id, path"), [
    { library_id: "lib_b", path: "C.mkv" },
  ]);
  assert.deepEqual(await database.all("SELECT library_id FROM library_seen_libraries"), [{ library_id: "lib_b" }]);
});

test("a damaged library-seen JSON is preserved, moved aside, and the store starts empty and writable", async (t) => {
  const { dataDir, database } = await fixture(t);
  await writeFile(seenFile(dataDir), "{ not json");
  const batches: Statement[][] = [];
  const store = new LibrarySeenStore(dataDir);
  store.attachDatabase(observingBatch(database, batches));
  await store.load();

  const preserved = (await readdir(dataDir)).filter((name) => name.startsWith("library-seen.json.damaged-"));
  assert.equal(preserved.length, 1);
  assert.equal(await readFile(path.join(dataDir, preserved[0]!), "utf8"), "{ not json");
  assert.equal((await marker(database))?.source, "damaged");
  await assert.rejects(readFile(seenFile(dataDir), "utf8"), { code: "ENOENT" }, "the damaged file no longer blocks the next start");
  const backups = await readdir(path.join(dataDir, "migration-backup"));
  assert.ok(backups.every((name) => !name.includes(":")), backups.join(","));

  store.observe("lib_a", [file("A.mkv", 10, "2026-01-01T00:00:00.000Z")], new Date("2026-02-01T00:00:00.000Z"));
  await store.flush();
  assert.ok(batches.length > 0, "the store records first-seen files again");
});

test("a library-seen change during an in-flight batch is written by the next flush", async (t) => {
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
  const store = new LibrarySeenStore(dataDir);
  store.attachDatabase(gated);
  await store.load();
  store.observe("lib_a", [file("A.mkv", 10, "2026-01-01T00:00:00.000Z")], new Date("2026-02-01T00:00:00.000Z"));
  await store.flush();

  let release!: () => void;
  hold = new Promise<void>((resolve) => { release = resolve; });
  store.observe("lib_a", [file("A.mkv", 11, "2026-01-02T00:00:00.000Z")], new Date("2026-02-02T00:00:00.000Z"));
  const firstFlush = store.flush();
  await writing;
  store.add("lib_a", "B.mkv", 20, 2_000, new Date("2026-02-03T00:00:00.000Z"));
  const secondFlush = store.flush();
  release();
  await Promise.all([firstFlush, secondFlush]);

  const rows = await database.all<{ path: string; data: string }>(
    "SELECT path, data FROM library_seen WHERE library_id = 'lib_a' ORDER BY path",
  );
  assert.deepEqual(rows.map((row) => row.path), ["A.mkv", "B.mkv"]);
  assert.equal((JSON.parse(rows[0]!.data) as SeenFile).size, 11);
});
