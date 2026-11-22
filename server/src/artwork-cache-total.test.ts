import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ArtworkCache, type ArtworkSaveTimers } from "./artwork-cache.js";
import { openAppDatabase, StorageError, type AppDatabase } from "./storage/app-database.js";

const hash = (key: string) => `${createHash("sha1").update(key).digest("hex")}.jpg`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const timers: ArtworkSaveTimers = {
  set: () => ({}),
  clear: () => undefined,
};

interface TestEntry {
  bytes: number;
  at: number;
}

function internals(cache: ArtworkCache) {
  return cache as unknown as { entries: Map<string, TestEntry>; storedBytes: number };
}

function assertStoredBytes(cache: ArtworkCache, expected: number) {
  const stored = internals(cache).storedBytes;
  const recounted = cache.recountStoredBytes();
  assert.equal(stored, expected);
  assert.equal(recounted, expected);
  assert.equal(internals(cache).storedBytes, expected);
}

async function withCache(cap: number, run: (cache: ArtworkCache, dir: string) => Promise<void>) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "artwork-cache-total-"));
  const dir = path.join(dataDir, "artwork");
  const cache = new ArtworkCache(dir, cap, { saveTimers: timers });
  try {
    await run(cache, dir);
  } finally {
    await cache.flush();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function put(cache: ArtworkCache, key: string, bytes: number) {
  const file = cache.file(key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(bytes));
  await cache.written(file);
  return file;
}

function countIterations(entries: Map<string, TestEntry>) {
  let calls = 0;
  let visits = 0;
  const counted = function* <T>(source: Iterable<T>) {
    for (const value of source) {
      visits += 1;
      yield value;
    }
  };
  const proxied = new Proxy(entries, {
    get(target, property, receiver) {
      if (property === "values") return () => { calls += 1; return counted(target.values()); };
      if (property === "entries") return () => { calls += 1; return counted(target.entries()); };
      if (property === "keys") return () => { calls += 1; return counted(target.keys()); };
      if (property === Symbol.iterator) return () => { calls += 1; return counted(target[Symbol.iterator]()); };
      if (property === "forEach") {
        return (callback: (value: TestEntry, key: string, map: Map<string, TestEntry>) => void, thisArg?: unknown) => {
          calls += 1;
          target.forEach((value, key) => {
            visits += 1;
            callback.call(thisArg, value, key, proxied);
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { map: proxied, stats: () => ({ calls, visits }) };
}

test("writing below the cap does not iterate ten thousand indexed thumbnails", async () => {
  await withCache(1024 * 1024, async (cache) => {
    const map = internals(cache).entries;
    for (let index = 0; index < 10_000; index += 1) {
      map.set(`lib_seed/${index.toString(16).padStart(40, "0")}.jpg`, { bytes: 1, at: index });
    }
    internals(cache).storedBytes = 10_000;

    const file = cache.file("lib_aaaaaaaa/New.mkv");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "new");
    const watched = countIterations(map);
    internals(cache).entries = watched.map;

    await cache.written(file);

    assert.deepEqual(watched.stats(), { calls: 0, visits: 0 });
    assertStoredBytes(cache, 10_003);
  });
});

test("the byte total follows writes, replacements, moves, copies, recency and deletion", async () => {
  await withCache(1024 * 1024, async (cache) => {
    const originalKey = "lib_aaaaaaaa/Show/01.mkv";
    const file = await put(cache, originalKey, 300);
    assertStoredBytes(cache, 300);

    await cache.served(file);
    cache.touch(file);
    assertStoredBytes(cache, 300);

    await writeFile(file, Buffer.alloc(100));
    await cache.written(file);
    assertStoredBytes(cache, 100);

    const renamedKey = "lib_aaaaaaaa/Show/02.mkv";
    const renamed = cache.file(renamedKey);
    await rename(file, renamed);
    await cache.moved(file, renamed);
    assertStoredBytes(cache, 100);

    const movedKey = "lib_aaaaaaaa/Show/03.mkv";
    assert.deepEqual(await cache.moveKey(renamedKey, movedKey), { carried: true });
    assertStoredBytes(cache, 100);

    const copiedKey = "lib_bbbbbbbb/Copy/01.mkv";
    assert.deepEqual(await cache.copyKey(movedKey, copiedKey), { carried: true });
    assertStoredBytes(cache, 200);

    await rm(cache.file(movedKey));
    await cache.removed(cache.file(movedKey));
    assertStoredBytes(cache, 100);

    await rm(cache.dirOf("lib_bbbbbbbb"), { recursive: true, force: true });
    await cache.removedTree(cache.dirOf("lib_bbbbbbbb"));
    assertStoredBytes(cache, 0);
  });
});

test("crossing the cap evicts oldest first down to the floor with an exact total", async () => {
  await withCache(10 * 1024, async (cache) => {
    const first = await put(cache, "lib_aaaaaaaa/One.mkv", 4096);
    await sleep(3);
    const second = await put(cache, "lib_aaaaaaaa/Two.mkv", 4096);
    await sleep(3);
    const third = await put(cache, "lib_aaaaaaaa/Three.mkv", 4096);

    await assert.rejects(stat(first));
    assert.equal((await stat(second)).size, 4096);
    assert.equal((await stat(third)).size, 4096);
    assertStoredBytes(cache, 8192);
  });
});

test("eviction drops a missing file from the total without dropping live bytes", async () => {
  await withCache(100, async (cache) => {
    const missing = await put(cache, "lib_aaaaaaaa/One.mkv", 80);
    await sleep(3);
    const kept = cache.file("lib_aaaaaaaa/Two.mkv");
    await mkdir(path.dirname(kept), { recursive: true });
    await writeFile(kept, Buffer.alloc(80));
    await cache.served(kept);
    assertStoredBytes(cache, 160);

    await rm(missing);
    await cache.maintain();

    assert.equal(cache.size, 1);
    assertStoredBytes(cache, 80);
    assert.equal((await stat(kept)).size, 80);
  });
});

test("a failed eviction removal keeps the entry and byte total", async () => {
  await withCache(100, async (cache) => {
    const file = cache.file("lib_aaaaaaaa/Stuck.mkv");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.alloc(4096));
    await cache.served(file);

    await rm(file);
    await mkdir(file);
    await writeFile(path.join(file, "keep"), "x");
    await cache.maintain();

    assert.equal(cache.size, 1);
    assertStoredBytes(cache, 4096);
  });
});

test("a JSON restart reconstructs the exact byte total", async () => {
  await withCache(1024 * 1024, async (cache, dir) => {
    await put(cache, "lib_aaaaaaaa/One.mkv", 128);
    await put(cache, "lib_aaaaaaaa/Two.mkv", 64);
    await cache.flush();

    const restarted = new ArtworkCache(dir, 1024 * 1024, { saveTimers: timers });
    await restarted.load();
    assertStoredBytes(restarted, 192);
    await restarted.flush();
  });
});

test("a SQLite restart reconstructs the exact byte total", async (t: TestContext) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "artwork-cache-total-sqlite-"));
  const dir = path.join(dataDir, "artwork");
  let database: AppDatabase | undefined = await openAppDatabase({ dataDir });
  t.after(async () => {
    try {
      await database?.close();
    } catch (error) {
      if (!(error instanceof StorageError) || error.code !== "broken") throw error;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  const cache = new ArtworkCache(dir, 1024 * 1024, { saveTimers: timers });
  cache.attachDatabase(database);
  await cache.load();
  await put(cache, "lib_aaaaaaaa/One.mkv", 128);
  await put(cache, "lib_aaaaaaaa/Two.mkv", 64);
  await cache.flush();

  await database.close();
  database = await openAppDatabase({ dataDir });
  const restarted = new ArtworkCache(dir, 1024 * 1024, { saveTimers: timers });
  restarted.attachDatabase(database);
  await restarted.load();
  assertStoredBytes(restarted, 192);
  await restarted.flush();
});
