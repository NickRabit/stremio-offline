import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ArtworkCache } from "./artwork-cache.js";

const hash = (key: string) => `${createHash("sha1").update(key).digest("hex")}.jpg`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withCache(cap: number, run: (cache: ArtworkCache, dir: string, dataDir: string) => Promise<void>) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "artwork-cache-"));
  const dir = path.join(dataDir, "artwork");
  try { await run(new ArtworkCache(dir, cap), dir, dataDir); }
  finally { await rm(dataDir, { recursive: true, force: true }); }
}

const put = async (cache: ArtworkCache, key: string, bytes: number) => {
  const file = cache.file(key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(bytes));
  await cache.written(file);
  return file;
};

test("a key maps to the directory of its library, folder prefix and all", async () => {
  await withCache(1024, async (cache, dir) => {
    assert.equal(cache.file("lib_ab12cd34/Show/01 serie/01.mkv"), path.join(dir, "lib_ab12cd34", hash("Show/01 serie/01.mkv")));
    assert.equal(cache.file("dir:lib_ab12cd34/Show"), path.join(dir, "lib_ab12cd34", hash("dir:Show")));
    // A folder and a file of the same name must not share a picture.
    assert.notEqual(cache.file("dir:lib_ab12cd34/Show"), cache.file("lib_ab12cd34/Show"));
    assert.throws(() => cache.file("Show/01.mkv"), /without a library/);
  });
});

test("the ceiling drops the oldest thumbnail down to four fifths of it", async () => {
  await withCache(10 * 1024, async (cache, dir) => {
    await put(cache, "lib_aaaaaaaa/One.mkv", 4096);
    await sleep(3);
    await put(cache, "lib_aaaaaaaa/Two.mkv", 4096);
    await sleep(3);
    await put(cache, "lib_aaaaaaaa/Three.mkv", 4096);
    await cache.flush();
    await assert.rejects(stat(cache.file("lib_aaaaaaaa/One.mkv")), "the oldest goes first");
    for (const key of ["Two.mkv", "Three.mkv"]) assert.equal((await stat(cache.file(`lib_aaaaaaaa/${key}`))).size, 4096);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(dir, "index.json"), "utf8"))).sort(),
      [path.join("lib_aaaaaaaa", hash("Three.mkv")), path.join("lib_aaaaaaaa", hash("Two.mkv"))].sort());
  });
});

test("serving a thumbnail keeps it out of the eviction order", async () => {
  await withCache(10 * 1024, async (cache) => {
    const first = await put(cache, "lib_aaaaaaaa/One.mkv", 4096);
    await sleep(3);
    const second = await put(cache, "lib_aaaaaaaa/Two.mkv", 4096);
    await sleep(3);
    await cache.served(second);
    await put(cache, "lib_aaaaaaaa/Three.mkv", 4096);
    await assert.rejects(stat(first), "the one nobody asked for is the one dropped");
    assert.equal((await stat(second)).size, 4096);
  });
});

test("a moved thumbnail keeps its bytes counted under the new key", async () => {
  await withCache(1024 * 1024, async (cache, dir) => {
    const from = await put(cache, "lib_aaaaaaaa/Show/01.mkv", 2048);
    const to = cache.file("lib_bbbbbbbb/Archive/01.mkv");
    await mkdir(path.dirname(to), { recursive: true });
    await rename(from, to);
    await cache.moved(from, to);
    await cache.flush();
    const stored = await readFile(path.join(dir, "index.json"), "utf8");
    assert.deepEqual(Object.keys(JSON.parse(stored)), [path.join("lib_bbbbbbbb", hash("Archive/01.mkv"))]);
    assert.equal(cache.size, 1);
  });
});

test("a picture that is not ours is never counted", async () => {
  await withCache(10 * 1024, async (cache, _dir, dataDir) => {
    const media = path.join(dataDir, "downloads", "poster.jpg");
    await mkdir(path.dirname(media), { recursive: true });
    await writeFile(media, Buffer.alloc(4096));
    await cache.written(media);
    await cache.served(media);
    await cache.flush();
    assert.equal(cache.size, 0, "a poster next to the media belongs to the folder");
  });
});

test("the index survives a restart and forgets files the sweep took", async () => {
  await withCache(10 * 1024, async (cache, dir) => {
    const kept = await put(cache, "lib_aaaaaaaa/One.mkv", 2048);
    const gone = await put(cache, "lib_aaaaaaaa/Two.mkv", 2048);
    await cache.flush();
    const restarted = new ArtworkCache(dir, 10 * 1024);
    await restarted.load();
    assert.equal(restarted.size, 2);
    await rm(gone, { force: true });
    const again = new ArtworkCache(dir, 10 * 1024);
    await again.load();
    assert.equal(again.size, 1);
    assert.equal((await stat(kept)).size, 2048);
  });
});

test("a thumbnail the server deletes stops counting before the next eviction", async () => {
  await withCache(10 * 1024, async (cache, dir) => {
    const gone = await put(cache, "lib_aaaaaaaa/One.mkv", 4096);
    await sleep(3);
    const kept = await put(cache, "lib_aaaaaaaa/Two.mkv", 4096);
    await rm(gone, { force: true });
    await cache.removed(gone);
    await cache.flush();
    assert.equal(cache.size, 1);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(dir, "index.json"), "utf8"))),
      [path.join("lib_aaaaaaaa", hash("Two.mkv"))]);
    // The bytes are out of the sum, so the picture that is still there is not evicted by them.
    await put(cache, "lib_aaaaaaaa/Three.mkv", 4096);
    assert.equal((await stat(kept)).size, 4096);
  });
});

test("removing a library's directory takes its entries with it and nobody else's", async () => {
  await withCache(1024 * 1024, async (cache, dir) => {
    await put(cache, "lib_aaaaaaaa/One.mkv", 1024);
    await put(cache, "dir:lib_aaaaaaaa/Show", 1024);
    await put(cache, "lib_bbbbbbbb/One.mkv", 1024);
    await rm(path.join(dir, "lib_aaaaaaaa"), { recursive: true, force: true });
    await cache.removedTree(path.join(dir, "lib_aaaaaaaa"));
    await cache.flush();
    assert.equal(cache.size, 1);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(dir, "index.json"), "utf8"))),
      [path.join("lib_bbbbbbbb", hash("One.mkv"))]);
  });
});
