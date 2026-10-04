import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ArtworkCache } from "./artwork-cache.js";

const hash = (key: string) => `${createHash("sha1").update(key).digest("hex")}.jpg`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The recognised thumbnail files under a cache root, as index-shaped names. */
const listed = async (dir: string): Promise<string[]> => {
  const found: string[] = [];
  for (const library of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!library.isDirectory()) continue;
    for (const file of await readdir(path.join(dir, library.name), { withFileTypes: true }).catch(() => [])) {
      if (file.isFile() && /^[0-9a-f]{40}\.jpg$/.test(file.name)) found.push(path.join(library.name, file.name));
    }
  }
  return found.sort();
};

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

test("a picture follows its key into a library that has no directory yet", async () => {
  await withCache(1024 * 1024, async (cache) => {
    const from = await put(cache, "lib_aaaaaaaa/Show/01.mkv", 2048);
    const to = cache.file("lib_bbbbbbbb/Archive/01.mkv");
    // The destination library has never had a thumbnail, so its directory does not exist.
    await assert.rejects(stat(path.dirname(to)));
    assert.deepEqual(await cache.moveKey("lib_aaaaaaaa/Show/01.mkv", "lib_bbbbbbbb/Archive/01.mkv"), { carried: true });
    assert.equal((await stat(to)).size, 2048, "the picture arrived");
    await assert.rejects(stat(from), "and did not stay behind");
    assert.equal(cache.size, 1, "the index followed it");
  });
});

test("a copy leaves the source picture where it is", async () => {
  await withCache(1024 * 1024, async (cache) => {
    const from = await put(cache, "lib_aaaaaaaa/Show/01.mkv", 2048);
    const to = cache.file("lib_bbbbbbbb/Archive/01.mkv");
    assert.deepEqual(await cache.copyKey("lib_aaaaaaaa/Show/01.mkv", "lib_bbbbbbbb/Archive/01.mkv"), { carried: true });
    assert.equal((await stat(from)).size, 2048);
    assert.equal((await stat(to)).size, 2048);
    assert.equal(cache.size, 2, "both are counted");
  });
});

test("an item with no picture of its own says so rather than failing", async () => {
  await withCache(1024 * 1024, async (cache) => {
    assert.deepEqual(await cache.moveKey("lib_aaaaaaaa/Show/01.mkv", "lib_bbbbbbbb/Archive/01.mkv"), { carried: false, reason: "absent" });
    assert.deepEqual(await cache.copyKey("lib_aaaaaaaa/Show/01.mkv", "lib_bbbbbbbb/Archive/01.mkv"), { carried: false, reason: "absent" });
    assert.equal(cache.size, 0);
  });
});

test("a missing or malformed index still counts the thumbnails on disk", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "artwork-cache-"));
  const dir = path.join(dataDir, "artwork");
  try {
    const file = path.join(dir, "lib_aaaaaaaa", hash("One.mkv"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.alloc(2048));

    const missing = new ArtworkCache(dir, 1024 * 1024);
    await missing.load();
    assert.equal(missing.size, 1, "with no index the file is still found");
    assert.equal((await stat(file)).size, 2048);

    await writeFile(path.join(dir, "index.json"), "{ not json");
    const malformed = new ArtworkCache(dir, 1024 * 1024);
    await malformed.load();
    assert.equal(malformed.size, 1, "a malformed index is treated as empty");

    await writeFile(path.join(dir, "index.json"), "5");
    const notAnObject = new ArtworkCache(dir, 1024 * 1024);
    await notAnObject.load();
    assert.equal(notAnObject.size, 1, "an index that is not an object is treated as empty");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("load rebuilds the index from the files, trusting the disk over the record", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "artwork-cache-"));
  const dir = path.join(dataDir, "artwork");
  try {
    const one = path.join(dir, "lib_aaaaaaaa", hash("One.mkv"));
    const two = path.join(dir, "lib_aaaaaaaa", hash("Two.mkv"));
    await mkdir(path.dirname(one), { recursive: true });
    await writeFile(one, Buffer.alloc(2048));
    await writeFile(two, Buffer.alloc(1024));
    await writeFile(path.join(dir, "index.json"), JSON.stringify({
      [path.join("lib_aaaaaaaa", hash("One.mkv"))]: { bytes: 999, at: 4242 },
      [path.join("lib_cccccccc", hash("Gone.mkv"))]: { bytes: 512, at: 1 },
    }));

    const cache = new ArtworkCache(dir, 1024 * 1024);
    await cache.load();
    assert.equal(cache.size, 2, "the missing record is dropped");
    const stored = JSON.parse(await readFile(path.join(dir, "index.json"), "utf8")) as Record<string, { bytes: number; at: number }>;
    assert.deepEqual(Object.keys(stored).sort(), [
      path.join("lib_aaaaaaaa", hash("One.mkv")),
      path.join("lib_aaaaaaaa", hash("Two.mkv")),
    ].sort());
    assert.equal(stored[path.join("lib_aaaaaaaa", hash("One.mkv"))]!.bytes, 2048, "a wrong stored size is repaired");
    assert.equal(stored[path.join("lib_aaaaaaaa", hash("One.mkv"))]!.at, 4242, "a known age is kept");
    assert.equal(stored[path.join("lib_aaaaaaaa", hash("Two.mkv"))]!.at, (await stat(two)).mtimeMs, "an unindexed file ages from its mtime");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("load neither counts nor deletes anything that is not a hashed thumbnail", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "artwork-cache-"));
  const dir = path.join(dataDir, "artwork");
  try {
    const library = path.join(dir, "lib_aaaaaaaa");
    await mkdir(library, { recursive: true });
    const valid = path.join(library, hash("One.mkv"));
    await writeFile(valid, Buffer.alloc(1024));
    const temp = path.join(library, "0123456789abcdef0123456789abcdef01234567.tmp");
    await writeFile(temp, Buffer.alloc(16));
    const odd = path.join(library, "not-a-hash.jpg");
    await writeFile(odd, Buffer.alloc(16));
    const nested = path.join(library, "nested");
    await mkdir(nested);
    const deep = path.join(nested, hash("Deep.mkv"));
    await writeFile(deep, Buffer.alloc(16));
    await writeFile(path.join(dir, "index.json"), "{}");

    const outsideFile = path.join(dataDir, "outside.jpg");
    await writeFile(outsideFile, Buffer.alloc(16));
    const outsideDir = path.join(dataDir, "outside-dir");
    await mkdir(outsideDir);
    const linkToFile = path.join(library, `${"a".repeat(40)}.jpg`);
    await symlink(outsideFile, linkToFile);
    const linkToDir = path.join(dir, `${"b".repeat(40)}.jpg`);
    await symlink(outsideDir, linkToDir);

    const cache = new ArtworkCache(dir, 1024 * 1024);
    await cache.load();
    assert.equal(cache.size, 1, "only the real thumbnail is counted");
    for (const kept of [valid, temp, odd, deep, path.join(dir, "index.json"), linkToFile, linkToDir, outsideFile, outsideDir]) {
      await stat(kept);
    }
    assert.ok((await lstat(linkToFile)).isSymbolicLink(), "the file link survives");
    assert.ok((await lstat(linkToDir)).isSymbolicLink(), "the directory link survives");
    assert.equal((await stat(outsideFile)).size, 16, "the link target is untouched");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a lowered cap is enforced at load and maintain is quiet under it", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "artwork-cache-"));
  const dir = path.join(dataDir, "artwork");
  try {
    const library = path.join(dir, "lib_aaaaaaaa");
    await mkdir(library, { recursive: true });
    for (const [index, key] of ["One.mkv", "Two.mkv", "Three.mkv"].entries()) {
      const file = path.join(library, hash(key));
      await writeFile(file, Buffer.alloc(4096));
      await utimes(file, 1000 + index, 1000 + index);
    }

    const cache = new ArtworkCache(dir, 9000);
    await cache.load();
    assert.equal(cache.size, 1, "load enforces the lowered cap");

    const before = await listed(dir);
    await cache.maintain();
    assert.equal(cache.size, 1, "maintain is a no-op while under the cap");
    assert.deepEqual(await listed(dir), before);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("overlapping writes and one maintenance pass keep the accounting true", async () => {
  await withCache(10 * 1024, async (cache, dir) => {
    await Promise.all([
      put(cache, "lib_aaaaaaaa/One.mkv", 4096),
      put(cache, "lib_aaaaaaaa/Two.mkv", 4096),
      put(cache, "lib_aaaaaaaa/Three.mkv", 4096),
      cache.maintain(),
    ]);
    await cache.flush();
    assert.equal(cache.size, (await listed(dir)).length, "the index counts exactly the files that are there");
    assert.ok(cache.size <= 3);
  });
});

test("a thumbnail served while a pass is deciding is not the one dropped", async () => {
  await withCache(9000, async (cache) => {
    const one = await put(cache, "lib_aaaaaaaa/One.mkv", 4096);
    await sleep(2);
    const two = await put(cache, "lib_aaaaaaaa/Two.mkv", 4096);
    const three = cache.file("lib_aaaaaaaa/Three.mkv");
    await mkdir(path.dirname(three), { recursive: true });
    await writeFile(three, Buffer.alloc(4096));
    // `served` records a file without running the eviction, so the cache is over
    // its cap with all three counted and a pass is the first thing to act on it.
    await cache.served(three);
    await sleep(5);
    assert.equal(cache.size, 3);

    const pass = cache.maintain();
    // One microtask is enough for the pass to take its snapshot and suspend on the
    // first removal; the serve then lands before the entry it touches is re-checked.
    await Promise.resolve();
    await cache.served(two);
    await pass;
    assert.equal((await stat(two)).size, 4096, "the thumbnail served while the pass ran was kept");
    await assert.rejects(stat(one), "the oldest, untouched one was dropped");
    assert.equal(cache.size, 1);
  });
});

test("a thumbnail that cannot be removed stays indexed and is retried", async () => {
  await withCache(100, async (cache) => {
    const one = cache.file("lib_aaaaaaaa/One.mkv");
    await mkdir(path.dirname(one), { recursive: true });
    await writeFile(one, Buffer.alloc(4096));
    await cache.served(one);
    assert.equal(cache.size, 1);

    await rm(one, { force: true });
    await mkdir(one);
    await writeFile(path.join(one, "keep"), "x");
    await cache.maintain();
    assert.equal(cache.size, 1, "an entry whose file could not be removed keeps counting");

    await rm(one, { recursive: true, force: true });
    await cache.maintain();
    assert.equal(cache.size, 0, "the next pass retries and drops it");
  });
});
