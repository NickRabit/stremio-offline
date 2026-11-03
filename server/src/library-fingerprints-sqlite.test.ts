import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { HASH_BUDGET_MS, LibraryFingerprints, type FingerprintWalkFile } from "./library-fingerprints.js";
import { openAppDatabase, StorageError, type AppDatabase, type Statement } from "./storage/app-database.js";

const A = "lib_aaaaaaaa";
const B = "lib_bbbbbbbb";
const OLD = "2026-01-01T00:00:00.000Z";
const NEWER = "2026-01-02T00:00:00.000Z";
const NOW = Date.parse("2026-03-01T00:00:00.000Z");

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "library-fingerprints-sqlite-"));
  const root = path.join(dataDir, "media");
  await mkdir(root, { recursive: true });
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
    root,
    get database() { return database; },
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

const file = (relative: string, size: number, modified = OLD): FingerprintWalkFile => ({ relative, size, modified });
const walk = (libraryId: string, root: string, files: FingerprintWalkFile[]) => ({ libraryId, root, files });

async function fingerprints(database: AppDatabase) {
  const store = new LibraryFingerprints({ now: () => NOW });
  store.attachDatabase(database);
  await store.load();
  return store;
}

test("the first walk records rows, a rename moves one, and an unchanged walk writes nothing", async (t) => {
  const { database, root } = await fixture(t);
  await mkdir(path.join(root, "Old"));
  const batches: Statement[][] = [];
  const store = new LibraryFingerprints({ now: () => NOW });
  store.attachDatabase(observingBatch(database, batches));
  await store.load();

  assert.deepEqual(await store.reconcile([walk(A, root, [file("Old/movie.mkv", 10)])]), []);
  assert.deepEqual(await database.all("SELECT library_id, path, size, mtime_ms, hash FROM file_fingerprints"), [{
    library_id: A, path: "Old/movie.mkv", size: 10, mtime_ms: Date.parse(OLD), hash: null,
  }]);
  batches.length = 0;

  const pairs = await store.reconcile([walk(A, root, [file("Old/Renamed.mkv", 10)])]);
  assert.deepEqual(pairs, [{
    libraryId: A, from: "Old/movie.mkv", toLibraryId: A, to: "Old/Renamed.mkv", folder: false,
  }]);
  assert.deepEqual(await database.all("SELECT library_id, path FROM file_fingerprints"), [
    { library_id: A, path: "Old/movie.mkv" },
  ], "the source row waits for the carry");
  await store.commitPair(pairs[0]!);
  assert.deepEqual(await database.all("SELECT library_id, path FROM file_fingerprints"), [
    { library_id: A, path: "Old/Renamed.mkv" },
  ]);
  assert.ok(batches.length > 0, "the moved row was saved");

  batches.length = 0;
  assert.deepEqual(await store.reconcile([walk(A, root, [file("Old/Renamed.mkv", 10)])]), []);
  assert.equal(batches.length, 0, "nothing changed, so no statement was written");
});

test("hashPending stops at the file budget", async (t) => {
  const { database, root } = await fixture(t);
  const files: FingerprintWalkFile[] = [];
  for (let index = 0; index < 501; index += 1) {
    const relative = `Film ${index}.mkv`;
    await writeFile(path.join(root, relative), "");
    files.push(file(relative, 0));
  }
  const seeding = await fingerprints(database);
  await seeding.reconcile([walk(A, root, files)]);

  let opened = 0;
  const store = new LibraryFingerprints({
    now: () => Date.parse("2026-03-01T00:00:00.000Z"),
    open: async (...args) => {
      opened += 1;
      return await open(...args);
    },
  });
  store.attachDatabase(database);
  await store.load();
  assert.equal(await store.hashPending(new Map([[A, root]]), () => false), 500);
  assert.equal(opened, 500);
  assert.equal(await store.hashPending(new Map([[A, root]]), () => false), 1);
});

test("a copy with a different mtime is paired by hashing the new candidate during reconcile", async (t) => {
  const { database, root } = await fixture(t);
  const bytes = Buffer.from("the same bytes on another disk");
  await writeFile(path.join(root, "A.mkv"), bytes);
  const store = await fingerprints(database);
  await store.reconcile([walk(A, root, [file("A.mkv", bytes.length)])]);
  assert.equal(await store.hashPending(new Map([[A, root]]), () => false), 1);

  await rm(path.join(root, "A.mkv"));
  await writeFile(path.join(root, "B.mkv"), bytes);
  const pairs = await store.reconcile([walk(A, root, [file("B.mkv", bytes.length, NEWER)])]);
  assert.deepEqual(pairs, [{
    libraryId: A, from: "A.mkv", toLibraryId: A, to: "B.mkv", folder: false,
  }]);
  await store.commitPair(pairs[0]!);
  assert.deepEqual(await database.all("SELECT path FROM file_fingerprints"), [{ path: "B.mkv" }]);
});

test("a time-matched copy with different bytes is rejected after hashing both files", async (t) => {
  const { database, root } = await fixture(t);
  const source = Buffer.from("source bytes");
  await writeFile(path.join(root, "A.mkv"), source);
  const modified = new Date(Date.now() - 20 * 60_000).toISOString();
  const when = new Date(modified);
  await utimes(path.join(root, "A.mkv"), when, when);
  const store = new LibraryFingerprints({ now: () => Date.now() });
  store.attachDatabase(database);
  await store.load();
  await store.reconcile([walk(A, root, [file("A.mkv", source.length, modified)])]);
  assert.equal(await store.hashPending(new Map([[A, root]]), () => false), 1);

  await rm(path.join(root, "A.mkv"));
  await writeFile(path.join(root, "B.mkv"), Buffer.from("other bytes!"));
  assert.deepEqual(await store.reconcile([walk(A, root, [file("B.mkv", source.length, modified)])]), []);
});

test("a still-writing target leaves the vanished row for the next pass", async (t) => {
  const { database, root } = await fixture(t);
  const bytes = Buffer.from("same bytes");
  await writeFile(path.join(root, "A.mkv"), bytes);
  const store = await fingerprints(database);
  await store.reconcile([walk(A, root, [file("A.mkv", bytes.length)])]);
  await store.hashPending(new Map([[A, root]]), () => false);

  await rm(path.join(root, "A.mkv"));
  await writeFile(path.join(root, "B.mkv"), bytes);
  const writing = new Date(NOW - 60_000).toISOString();
  assert.deepEqual(await store.reconcile([walk(A, root, [file("B.mkv", bytes.length, writing)])]), []);
  assert.deepEqual(await database.all("SELECT path FROM file_fingerprints"), [{ path: "A.mkv" }]);

  const pairs = await store.reconcile([walk(A, root, [file("B.mkv", bytes.length, NEWER)])]);
  assert.deepEqual(pairs.map((pair) => pair.to), ["B.mkv"]);
});

test("busy prevents inline reads and keeps the vanished row", async (t) => {
  const { database, root } = await fixture(t);
  const bytes = Buffer.from("same bytes");
  await writeFile(path.join(root, "A.mkv"), bytes);
  const seeding = await fingerprints(database);
  await seeding.reconcile([walk(A, root, [file("A.mkv", bytes.length)])]);
  await seeding.hashPending(new Map([[A, root]]), () => false);

  await rm(path.join(root, "A.mkv"));
  await writeFile(path.join(root, "B.mkv"), bytes);
  let opened = 0;
  const store = new LibraryFingerprints({
    now: () => NOW,
    open: async (...args) => {
      opened += 1;
      return await open(...args);
    },
  });
  store.attachDatabase(database);
  await store.load();
  assert.deepEqual(await store.reconcile([walk(A, root, [file("B.mkv", bytes.length, NEWER)])], () => true), []);
  assert.equal(opened, 0);
  assert.deepEqual(await database.all("SELECT path FROM file_fingerprints"), [{ path: "A.mkv" }]);
  assert.deepEqual((await store.reconcile([walk(A, root, [file("B.mkv", bytes.length, NEWER)])])).map((pair) => pair.to), ["B.mkv"]);
});

test("a pair can be prepared again until its carry is committed", async (t) => {
  const { database, root } = await fixture(t);
  const store = await fingerprints(database);
  await store.reconcile([walk(A, root, [file("A.mkv", 10)])]);
  const first = await store.reconcile([walk(A, root, [file("B.mkv", 10)])]);
  assert.equal(first.length, 1);
  assert.deepEqual(await database.all("SELECT path FROM file_fingerprints"), [{ path: "A.mkv" }]);
  const second = await store.reconcile([walk(A, root, [file("B.mkv", 10)])]);
  assert.deepEqual(second, first);
});

test("hashPending stops before opening when playback or downloads are busy", async (t) => {
  const { database, root } = await fixture(t);
  await writeFile(path.join(root, "movie.mkv"), "movie");
  const store = await fingerprints(database);
  await store.reconcile([walk(A, root, [file("movie.mkv", 5)])]);
  let opened = 0;
  const hashing = new LibraryFingerprints({
    now: () => Date.parse("2026-03-01T00:00:00.000Z"),
    open: async (...args) => {
      opened += 1;
      return await open(...args);
    },
  });
  hashing.attachDatabase(database);
  await hashing.load();
  assert.equal(await hashing.hashPending(new Map([[A, root]]), () => true), 0);
  assert.equal(opened, 0);
});

test("hashPending stops when its wall-time budget is spent", async (t) => {
  const { database, root } = await fixture(t);
  await writeFile(path.join(root, "one.mkv"), "one");
  await writeFile(path.join(root, "two.mkv"), "two");
  await (await fingerprints(database)).reconcile([walk(A, root, [
    file("one.mkv", 3),
    file("two.mkv", 3),
  ])]);
  const ticks = [0, 0, HASH_BUDGET_MS];
  let tick = 0;
  const store = new LibraryFingerprints({
    now: () => ticks[Math.min(tick++, ticks.length - 1)]!,
  });
  store.attachDatabase(database);
  await store.load();
  assert.equal(await store.hashPending(new Map([[A, root]]), () => false), 1);
});

test("an incomplete library contributes no walk and keeps its rows untouched", async (t) => {
  const { database, root } = await fixture(t);
  const store = await fingerprints(database);
  await store.reconcile([
    walk(A, root, [file("A.mkv", 1)]),
    walk(B, root, [file("B.mkv", 2)]),
  ]);
  await store.reconcile([walk(A, root, [])]);
  assert.deepEqual(await database.all("SELECT library_id, path FROM file_fingerprints ORDER BY library_id, path"), [
    { library_id: B, path: "B.mkv" },
  ]);
});

test("forget deletes only the named library's rows", async (t) => {
  const { database, root } = await fixture(t);
  const store = await fingerprints(database);
  await store.reconcile([
    walk(A, root, [file("A.mkv", 1)]),
    walk(B, root, [file("B.mkv", 2)]),
  ]);
  await store.forget(A);
  assert.deepEqual(await database.all("SELECT library_id, path FROM file_fingerprints"), [
    { library_id: B, path: "B.mkv" },
  ]);
});

test("hashPending hashes the first and last MiB or the whole file at the cutoff", async (t) => {
  const { database, root } = await fixture(t);
  const small = Buffer.alloc(2 * 1024 * 1024, 1);
  const large = Buffer.alloc(2 * 1024 * 1024 + 10, 2);
  await writeFile(path.join(root, "small.mkv"), small);
  await writeFile(path.join(root, "large.mkv"), large);
  const store = await fingerprints(database);
  await store.reconcile([walk(A, root, [
    file("small.mkv", small.length),
    file("large.mkv", large.length),
  ])]);
  assert.equal(await store.hashPending(new Map([[A, root]]), () => false), 2);
  const rows = await database.all<{ path: string; hash: string; size: number }>(
    "SELECT path, hash, size FROM file_fingerprints ORDER BY path",
  );
  assert.ok(rows.every((row) => /^[0-9a-f]{64}$/.test(row.hash)));
  assert.equal(rows.find((row) => row.path === "small.mkv")?.size, small.length);
  assert.equal(rows.find((row) => row.path === "large.mkv")?.size, large.length);
});
