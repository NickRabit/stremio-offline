import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DownloadQueue, type DownloadJob } from "./downloads.js";
import { AppError } from "./errors.js";
import type { LibraryRecord } from "./libraries.js";
import {
  openAppDatabase,
  StorageError,
  type AppDatabase,
  type Statement,
} from "./storage/app-database.js";

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "downloads-sqlite-"));
  const databases: AppDatabase[] = [];
  const queues: DownloadQueue[] = [];
  const downloads = path.join(dataDir, "downloads");
  const library: LibraryRecord = {
    id: "lib_d10ad10a",
    name: "Downloads",
    type: "mixed",
    root: downloads,
    enabled: true,
    order: 0,
    addedAt: "2026-11-01T00:00:00.000Z",
    writeArtwork: false,
  };
  let database = await openAppDatabase({ dataDir });
  databases.push(database);
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    for (const queue of queues.reverse()) await queue.stop();
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
    file: path.join(dataDir, "downloads.json"),
    get database() { return database; },
    async reopen() {
      await database.close();
      database = await openAppDatabase({ dataDir });
      databases.push(database);
      return database;
    },
    queue(attached: AppDatabase = database) {
      const queue = new DownloadQueue(() => 1, () => 1, dataDir, downloads, {
        libraries: () => [library],
        defaultLibrary: () => library,
      });
      queue.attachDatabase(attached);
      queues.push(queue);
      return queue;
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
  const row = await database.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", ["domain.downloads"]);
  return row ? JSON.parse(row.value) as Record<string, unknown> : undefined;
}

function job(id: string, title: string): DownloadJob {
  return {
    id,
    title,
    stream: { url: `https://example.test/${id}.mp4` },
    status: "paused",
    pauseReason: "user",
    target: `${title}/${title}.mp4`,
    received: 10,
    speed: 0,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:01:00.000Z",
  };
}

test("the download queue imports JSON once and restores rows in order", async (t) => {
  const { file, database, reopen, queue, close } = await fixture(t);
  const saved = [job("job-a", "Alpha"), job("job-b", "Beta"), job("job-c", "Gamma")];
  await writeFile(file, JSON.stringify(saved, null, 2));

  const first = queue();
  await first.load();

  assert.deepEqual(first.list().map((item) => [item.id, item.title, item.target]), saved.map((item) => [item.id, item.title, item.target]));
  const rows = await database.all<{ id: string; position: number; data: string }>(
    "SELECT id, position, data FROM download_jobs ORDER BY position",
  );
  assert.deepEqual(rows.map((row) => [row.id, row.position]), [["job-a", 0], ["job-b", 1], ["job-c", 2]]);
  assert.deepEqual(rows.map((row) => JSON.parse(row.data)), saved);
  assert.ok(rows.every((row) => !row.data.includes("\n")));

  const imported = await marker(database);
  assert.equal(typeof imported?.importedAt, "number");
  assert.deepEqual({ ...imported, importedAt: undefined }, {
    importedAt: undefined,
    source: "downloads.json",
    count: 3,
  });
  await assert.rejects(stat(file), { code: "ENOENT" });
  assert.equal((await readdir(path.join(path.dirname(file), "migration-backup"))).length, 1);

  await first.stop();
  const restarted = queue(await reopen());
  await restarted.load();
  assert.deepEqual(restarted.list().map((item) => [item.id, item.title, item.target]), saved.map((item) => [item.id, item.title, item.target]));
  await close();
});

test("a progress checkpoint writes exactly one upsert", async (t) => {
  const { database, queue, close } = await fixture(t);
  const batches: Statement[][] = [];
  const target = queue(observingBatch(database, batches));
  await target.load();
  const added = await target.add("Film", { url: "https://example.test/film.mp4" });
  await target.pause(added.id);
  batches.length = 0;

  const internal = target as unknown as {
    jobs: DownloadJob[];
    save(): Promise<void>;
  };
  internal.jobs[0]!.received = 1234;
  internal.jobs[0]!.updatedAt = "2026-11-01T10:02:00.000Z";
  await internal.save();

  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 1);
  assert.match(batches[0]![0]!.sql, /^INSERT INTO download_jobs /);
  assert.deepEqual(batches[0]![0]!.params?.slice(0, 2), [added.id, 0]);
  await close();
});

test("a save with no changes executes no statement", async (t) => {
  const { database, queue, close } = await fixture(t);
  const batches: Statement[][] = [];
  const target = queue(observingBatch(database, batches));
  await target.load();
  batches.length = 0;

  await (target as unknown as { save(): Promise<void> }).save();

  assert.equal(batches.length, 0);
  await close();
});

test("removing the middle job deletes its row and shifts later positions", async (t) => {
  const { file, database, reopen, queue, close } = await fixture(t);
  const saved = [job("job-a", "Alpha"), job("job-b", "Beta"), job("job-c", "Gamma")];
  await writeFile(file, JSON.stringify(saved));
  const first = queue();
  await first.load();

  await first.remove("job-b");

  assert.deepEqual(await database.all("SELECT id, position FROM download_jobs ORDER BY position"), [
    { id: "job-a", position: 0 },
    { id: "job-c", position: 1 },
  ]);

  await first.stop();
  const restarted = queue(await reopen());
  await restarted.load();
  assert.deepEqual(restarted.list().map((item) => item.id), ["job-a", "job-c"]);
  await close();
});

test("a failed admission is rejected, removed from memory and leaves no row", async (t) => {
  const { database, queue, close } = await fixture(t);
  const target = queue(failingBatch(database));
  await target.load();

  await assert.rejects(
    target.add("Film", { url: "https://example.test/film.mp4" }),
    (error: AppError) => error.messageKey === "err.queueNotSaved",
  );

  assert.deepEqual(target.list(), []);
  assert.equal(await database.get("SELECT id FROM download_jobs"), undefined);
  await close();
});

test("an unreadable queue file blocks the import without moving it or writing a marker", async (t) => {
  const { file, database, queue, close } = await fixture(t);
  await mkdir(file);
  const target = queue();
  await target.load();

  assert.equal((await stat(file)).isDirectory(), true);
  await assert.rejects(
    target.add("Film", { url: "https://example.test/film.mp4" }),
    (error: AppError) => error.messageKey === "err.queueUnreadable",
  );
  assert.equal(await marker(database), undefined);
  assert.equal(await database.get("SELECT id FROM download_jobs"), undefined);
  await close();
});

test("two concurrent admissions are serialized and choose different targets", async (t) => {
  const { database, queue, close } = await fixture(t);
  const target = queue();
  await target.load();

  const [first, second] = await Promise.all([
    target.add("Film", { url: "https://example.test/one.mp4" }),
    target.add("Film", { url: "https://example.test/two.mp4" }),
  ]);

  assert.equal(target.list().length, 2);
  assert.notEqual(first.target, second.target);
  assert.deepEqual(await database.all("SELECT id, position FROM download_jobs ORDER BY position"), [
    { id: first.id, position: 0 },
    { id: second.id, position: 1 },
  ]);
  await close();
});
