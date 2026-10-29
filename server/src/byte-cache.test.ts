import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { etagMatches, FileSnapCache, fileEtag, preheatFileSnaps } from "./byte-cache.js";
import { initLogger } from "./logger.js";

process.env.LOG_STDOUT = "0";
await initLogger(await mkdtemp(path.join(os.tmpdir(), "stremio-byte-cache-log-")));

const withDir = async (run: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-byte-cache-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

const snapOf = async (file: string) => {
  const info = await stat(file);
  return { bytes: await readFile(file), etag: fileEtag(info.size, info.mtimeMs), size: info.size, mtimeMs: info.mtimeMs };
};

test("the etag spells the size and mtime in hex", () => {
  assert.equal(fileEtag(256, 4096), 'W/"100-1000"');
});

test("If-None-Match accepts weak tags and the exact tag in a list", () => {
  const etag = fileEtag(256, 4096);
  assert.equal(etagMatches(etag, etag), true);
  assert.equal(etagMatches('"100-1000"', etag), true);
  assert.equal(etagMatches(`"other", ${etag}`, etag), true);
  assert.equal(etagMatches("*", etag), true);
  assert.equal(etagMatches('"other"', etag), false);
  assert.equal(etagMatches(undefined, etag), false);
});

test("the cache keeps the newest snaps that fit and drops the oldest for a new one", () => {
  const cache = new FileSnapCache(250);
  cache.put("a", { bytes: Buffer.alloc(100), etag: "a", size: 100, mtimeMs: 1 });
  cache.put("b", { bytes: Buffer.alloc(100), etag: "b", size: 100, mtimeMs: 1 });
  cache.put("c", { bytes: Buffer.alloc(100), etag: "c", size: 100, mtimeMs: 1 });
  assert.equal(cache.byteSize, 200, "the oldest was dropped to make room");
  assert.equal(cache.has("a"), false);
  assert.equal(cache.get("b")?.etag, "b");
  assert.equal(cache.get("c")?.etag, "c");

  cache.put("d", { bytes: Buffer.alloc(300), etag: "d", size: 300, mtimeMs: 1 });
  assert.equal(cache.byteSize, 200, "a snap larger than the cap is never stored");
  assert.equal(cache.has("d"), false);
});

test("a zero cap stores nothing", () => {
  const cache = new FileSnapCache(0);
  cache.put("a", { bytes: Buffer.alloc(1), etag: "a", size: 1, mtimeMs: 1 });
  assert.equal(cache.byteSize, 0);
  assert.equal(cache.has("a"), false);
});

test("preheat fills the memory with the newest files that fit", async () => {
  await withDir(async (dir) => {
    const files = ["one.jpg", "two.jpg", "three.jpg"].map((name) => path.join(dir, name));
    for (const [index, file] of files.entries()) {
      await writeFile(file, Buffer.alloc(1000));
      await utimes(file, 1000 + index, 1000 + index);
    }
    const cache = new FileSnapCache(2500);
    await preheatFileSnaps(cache, [
      { file: files[0]!, at: 1000 },
      { file: files[1]!, at: 2000 },
      { file: files[2]!, at: 3000 },
    ]);
    assert.equal(cache.byteSize, 2000, "the newest two fill the room");
    assert.equal(cache.has(files[2]!), true);
    assert.equal(cache.has(files[1]!), true);
    assert.equal(cache.has(files[0]!), false, "the third no longer fits");
    cache.put(files[0]!, { bytes: Buffer.alloc(1000), etag: "e", size: 1000, mtimeMs: 1000 });
    assert.equal(cache.has(files[2]!), true, "the newest preheated file is the last one evicted");
    assert.equal(cache.has(files[1]!), false, "the older preheated file makes room");
    for (const file of files) await rm(file, { force: true });
    assert.deepEqual(cache.get(files[2]!)?.bytes, Buffer.alloc(1000), "a hit survives the file it was read from");
  });
});

test("preheat of a cache that is already warm logs nothing and reads nothing", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "one.jpg");
    await writeFile(file, Buffer.alloc(10));
    const cache = new FileSnapCache(0);
    await preheatFileSnaps(cache, [{ file, at: 1 }]);
    assert.equal(cache.byteSize, 0);
  });
});

test("a hit keeps the bytes it was given even after the file moves", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "one.jpg");
    await writeFile(file, "first");
    const cache = new FileSnapCache(1024);
    cache.put(file, await snapOf(file));

    // A conditional request is the route's business: the cache hands back the bytes it stored,
    // as they were, without re-stating the file it copied them from.
    await writeFile(file, "a much longer replacement");
    const snap = cache.get(file)!;
    assert.deepEqual(snap.bytes, Buffer.from("first"));
    assert.equal(snap.size, 5);

    await rm(file, { force: true });
    assert.deepEqual(cache.get(file)?.bytes, Buffer.from("first"), "the bytes survive the file");
  });
});
