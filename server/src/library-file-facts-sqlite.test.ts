import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createLibraryFileFacts, type LibraryFileStamp } from "./library-file-facts.js";
import type { MediaInfo } from "./probe.js";
import {
  openAppDatabase,
  StorageError,
  type AppDatabase,
  type Statement,
} from "./storage/app-database.js";

const NOW = Date.parse("2026-10-14T12:30:00Z");

const info = (height = 1080): MediaInfo => ({
  container: "matroska,webm",
  duration: 1320,
  video: { codec: "hevc", width: 1920, height },
  audio: { codec: "eac3", channels: 6 },
  audioTracks: [{ index: 0, codec: "eac3", language: "cs", channels: 6 }],
  subtitleTracks: [{ index: 0, codec: "subrip", language: "cs" }],
});

const stamp = (key: string, overrides: Partial<LibraryFileStamp> = {}): LibraryFileStamp => ({
  key,
  size: 100,
  modified: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "library-file-facts-sqlite-"));
  const file = path.join(dataDir, "library", "file-facts.json");
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
  const row = await database.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", ["domain.fileFacts"]);
  return row ? JSON.parse(row.value) as Record<string, unknown> : undefined;
}

test("a file fact cache is imported once and a restart does not probe unchanged files", async (t) => {
  const { dataDir, file, database, reopen } = await fixture(t);
  await mkdir(path.dirname(file), { recursive: true });
  const stored = info(2160);
  await writeFile(file, JSON.stringify({
    version: 1,
    entries: {
      "lib_1/movie.mkv": {
        size: 100,
        modified: "2026-01-01T00:00:00.000Z",
        info: stored,
        at: NOW,
      },
    },
  }));

  const first = createLibraryFileFacts({ file, database, now: () => NOW, probe: async () => info() });
  assert.equal((await first.read([stamp("lib_1/movie.mkv")])).get("lib_1/movie.mkv")?.video?.height, 2160);
  assert.deepEqual(await marker(database), { importedAt: NOW, source: "file-facts.json", count: 1 });
  await assert.rejects(stat(file), { code: "ENOENT" });
  assert.deepEqual(await readdir(path.join(dataDir, "migration-backup")), [`file-facts-${NOW}.json`]);

  const reopened = await reopen();
  let reads = 0;
  const restarted = createLibraryFileFacts({
    file,
    database: reopened,
    now: () => NOW,
    probe: async () => { reads += 1; return info(); },
  });
  assert.equal((await restarted.read([stamp("lib_1/movie.mkv")])).get("lib_1/movie.mkv")?.video?.height, 2160);
  assert.equal(reads, 0);
});

test("two remembered files are written as one batch with two upserts", async (t) => {
  const { file, database } = await fixture(t);
  const batches: Statement[][] = [];
  const facts = createLibraryFileFacts({
    file,
    database: observingBatch(database, batches),
    now: () => NOW,
    saveDelayMs: 60_000,
    probe: async () => info(),
  });
  await facts.read([stamp("lib_1/a.mkv"), stamp("lib_1/b.mkv")]);
  await facts.flush();

  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 2);
  assert.ok(batches[0]!.every((statement) => statement.sql.startsWith("INSERT INTO file_facts")));
  assert.deepEqual(
    await database.all<{ key: string }>("SELECT key FROM file_facts ORDER BY key"),
    [{ key: "lib_1/a.mkv" }, { key: "lib_1/b.mkv" }],
  );
});

test("eviction past the small entry limit deletes the persisted row", async (t) => {
  const { file, database } = await fixture(t);
  const batches: Statement[][] = [];
  const facts = createLibraryFileFacts({
    file,
    database: observingBatch(database, batches),
    maxEntries: 2,
    now: () => NOW,
    saveDelayMs: 60_000,
    probe: async () => info(),
  });
  await facts.read([stamp("lib_1/a.mkv"), stamp("lib_1/b.mkv")]);
  await facts.flush();
  batches.length = 0;

  await facts.read([stamp("lib_1/c.mkv")]);
  await facts.flush();

  assert.equal(batches.length, 1);
  assert.deepEqual(
    batches[0]!.find((statement) => statement.sql.startsWith("DELETE FROM file_facts"))?.params,
    ["lib_1/a.mkv"],
  );
  assert.deepEqual(
    await database.all<{ key: string }>("SELECT key FROM file_facts ORDER BY key"),
    [{ key: "lib_1/b.mkv" }, { key: "lib_1/c.mkv" }],
  );
});

test("an identical JSON entry is not written again", async (t) => {
  const { file } = await fixture(t);
  let reads = 0;
  const facts = createLibraryFileFacts({
    file,
    now: () => NOW,
    saveDelayMs: 60_000,
    probe: async () => { reads += 1; return info(); },
  });
  await facts.read([stamp("lib_1/a.mkv")]);
  await facts.flush();
  await writeFile(file, "sentinel");

  assert.equal((await facts.read([stamp("lib_1/a.mkv")])).size, 1);
  await facts.flush();

  assert.equal(reads, 1);
  assert.equal(await readFile(file, "utf8"), "sentinel");
});
