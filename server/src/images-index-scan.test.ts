import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { renameWithRetry } from "./fs-retry.js";
import { ImageProxy, imageId, type SaveTimers } from "./images.js";
import { initLogger } from "./logger.js";
import { openAppDatabase, type AppDatabase } from "./storage/app-database.js";

process.env.LOG_STDOUT = "0";
await initLogger(await mkdtemp(path.join(os.tmpdir(), "stremio-images-index-scan-log-")));

const MiB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const GIF = Buffer.from("GIF89a stored poster");

const imageResponse = (body: Buffer = GIF, type = "image/gif") =>
  new Response(new Uint8Array(body), { status: 200, headers: { "content-type": type } });

const noopTimers: SaveTimers = { set: () => 0, clear: () => undefined };

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function countIterations(index: Map<string, unknown>) {
  const stats = { visits: 0 };
  const mutable = index as unknown as Record<PropertyKey, unknown>;
  const counted = <T>(iterable: Iterable<T>) => {
    stats.visits += 1;
    return iterable[Symbol.iterator]();
  };
  for (const name of ["entries", "values", "keys"] as const) {
    const original = index[name];
    mutable[name] = () => counted(original.call(index) as Iterable<unknown>);
  }
  const originalForEach = index.forEach;
  mutable.forEach = (...args: Parameters<Map<string, unknown>["forEach"]>) => {
    stats.visits += 1;
    return originalForEach.call(index, ...args);
  };
  const originalIterator = index[Symbol.iterator];
  mutable[Symbol.iterator] = () => counted(originalIterator.call(index) as Iterable<unknown>);
  return stats;
}

function countStoredBytes(proxy: ImageProxy): number {
  return (proxy as unknown as { recountStoredBytes(): number }).recountStoredBytes();
}

function assertStoredBytes(proxy: ImageProxy): void {
  const internals = proxy as unknown as { storedBytes: number };
  assert.equal(internals.storedBytes, countStoredBytes(proxy));
}

function timeCommitLock(proxy: ImageProxy): { elapsed(): number } {
  const internals = proxy as unknown as {
    exclusively<T>(fn: () => Promise<T>): Promise<T>;
  };
  const exclusive = internals.exclusively.bind(proxy);
  let total = 0;
  internals.exclusively = async <T>(fn: () => Promise<T>) => exclusive(async () => {
    const started = performance.now();
    try {
      return await fn();
    } finally {
      total += performance.now() - started;
    }
  });
  return { elapsed: () => total };
}

function heldImage() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let started!: () => void;
  let cancelled!: () => void;
  const readStarted = new Promise<void>((resolve) => { started = resolve; });
  const bodyCancelled = new Promise<void>((resolve) => { cancelled = resolve; });
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    pull() { return new Promise<void>(() => undefined); },
    cancel() { cancelled(); },
  });
  const getReader = stream.getReader.bind(stream);
  stream.getReader = ((...args: Parameters<typeof getReader>) => {
    started();
    return getReader(...args);
  }) as typeof stream.getReader;
  return {
    response: new Response(stream, { headers: { "content-type": "image/gif" } }),
    readStarted,
    bodyCancelled,
    release() {
      controller.enqueue(new Uint8Array(GIF));
      controller.close();
    },
  };
}

test("fifty undisrupted commits do not iterate the image index", async (t) => {
  const dir = await temporaryDirectory(t, "stremio-images-index-scan-");
  const issued = 60_000;
  const stored = 2_000;
  const clock = 1_000_000_000;
  const entries: Record<string, { url: string; at: number; ext?: string; bytes?: number }> = {};
  const urls = Array.from({ length: issued }, (_, index) => `https://cdn.example/issued-${index}.gif`);
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index]!;
    entries[imageId(url)] = {
      url,
      at: clock - 1_000,
      ...(index < stored ? { ext: "gif", bytes: GIF.length } : {}),
    };
  }
  for (let start = 0; start < stored; start += 100) {
    await Promise.all(urls.slice(start, start + 100).map((url) =>
      writeFile(path.join(dir, `${imageId(url)}.gif`), GIF)
    ));
  }
  await writeFile(path.join(dir, "index.json"), JSON.stringify(entries));

  const calls: string[] = [];
  const proxy = new ImageProxy(
    dir,
    4 * MiB,
    DAY,
    async (url) => {
      calls.push(url);
      return imageResponse();
    },
    0,
    () => clock,
    0,
    renameWithRetry,
    noopTimers,
  );
  await proxy.load();
  const links = Array.from({ length: 50 }, (_, index) => proxy.proxied(`https://cdn.example/new-${index}.gif`)!);
  const index = (proxy as unknown as { index: Map<string, unknown> }).index;
  const iterations = countIterations(index);
  const commits = timeCommitLock(proxy);

  for (const link of links) assert.ok(await proxy.fetch(link.split("/").pop()!));

  t.diagnostic(`50 commits: ${iterations.visits} index iteration calls, ${commits.elapsed().toFixed(2)} ms in exclusively`);
  assert.equal(calls.length, 50);
  assert.equal(iterations.visits, 0, "an undisrupted commit must not scan the full index");
  assertStoredBytes(proxy);
});

test("an aged scan makes the following commits cheap again", async (t) => {
  const dir = await temporaryDirectory(t, "stremio-images-aged-scan-");
  const calls: string[] = [];
  let clock = 1_000_000;
  const proxy = new ImageProxy(
    dir,
    MiB,
    1_000,
    async (url) => {
      calls.push(url);
      return imageResponse();
    },
    0,
    () => clock,
    0,
    renameWithRetry,
    noopTimers,
  );
  await proxy.load();

  const expired = Array.from({ length: 3 }, (_, index) => proxy.proxied(`https://cdn.example/expired-${index}.gif`)!);
  for (const link of expired) await proxy.fetch(link.split("/").pop()!);
  const expiredFiles = expired.map((link) => path.join(dir, `${link.split("/").pop()!}.gif`));
  clock += 2_000;

  const index = (proxy as unknown as { index: Map<string, unknown> }).index;
  const first = countIterations(index);
  const firstNew = proxy.proxied("https://cdn.example/after-expiry.gif")!;
  assert.ok(await proxy.fetch(firstNew.split("/").pop()!));
  assert.ok(first.visits > 0, "the due entries are found by an aged scan");
  for (const file of expiredFiles) await assert.rejects(stat(file), { code: "ENOENT" });

  first.visits = 0;
  const following = Array.from({ length: 5 }, (_, index) => proxy.proxied(`https://cdn.example/cheap-${index}.gif`)!);
  for (const link of following) assert.ok(await proxy.fetch(link.split("/").pop()!));
  assert.equal(first.visits, 0, "the next commits reuse the recomputed oldest age");

  const refetched = await proxy.fetch(expired[0]!.split("/").pop()!);
  assert.ok(refetched);
  assert.equal(calls.filter((url) => url === "https://cdn.example/expired-0.gif").length, 2);
  assertStoredBytes(proxy);
});

test("a cap crossing evicts the oldest bytes down to the floor", async (t) => {
  const dir = await temporaryDirectory(t, "stremio-images-cap-floor-");
  let clock = 1_000_000;
  const chunk = Buffer.alloc(1_000, 7);
  const proxy = new ImageProxy(
    dir,
    10_000,
    0,
    async () => imageResponse(chunk),
    0,
    () => clock,
    0,
    renameWithRetry,
    noopTimers,
  );
  await proxy.load();
  const old = Array.from({ length: 10 }, (_, index) => proxy.proxied(`https://cdn.example/old-${index}.gif`)!.split("/").pop()!);
  for (const id of old) {
    clock += 1_000;
    assert.ok(await proxy.fetch(id));
  }

  const newest = proxy.proxied("https://cdn.example/newest.gif")!.split("/").pop()!;
  clock += 1_000;
  assert.ok(await proxy.fetch(newest));
  const files = new Set(await readdir(dir));
  assert.equal(files.has(`${old[0]}.gif`), false, "the oldest file goes first");
  assert.equal(files.has(`${old[1]}.gif`), false, "the pass reaches the headroom floor");
  assert.equal(files.has(`${old[2]}.gif`), true);
  assert.equal(files.has(`${newest}.gif`), true);
  assertStoredBytes(proxy);
});

test("a failed publish leaves the running byte total unchanged", async (t) => {
  const dir = await temporaryDirectory(t, "stremio-images-failed-publish-");
  let fail = true;
  let requests = 0;
  const proxy = new ImageProxy(
    dir,
    MiB,
    0,
    async () => {
      requests += 1;
      return imageResponse();
    },
    0,
    Date.now,
    0,
    async (from, to) => {
      if (fail && String(to).endsWith(".gif")) {
        fail = false;
        throw new Error("publish failed");
      }
      await rename(from, to);
    },
    noopTimers,
  );
  await proxy.load();
  const id = proxy.proxied("https://cdn.example/retry-publish.gif")!.split("/").pop()!;

  assert.equal(await proxy.fetch(id), undefined);
  assertStoredBytes(proxy);
  assert.equal((proxy as unknown as { storedBytes: number }).storedBytes, 0);

  assert.ok(await proxy.fetch(id));
  assert.equal(requests, 2);
  assertStoredBytes(proxy);
});

test("a failed removal keeps the file accounted for", async (t) => {
  const dir = await temporaryDirectory(t, "stremio-images-failed-removal-");
  let clock = 1_000_000;
  const proxy = new ImageProxy(
    dir,
    MiB,
    1_000,
    async () => imageResponse(),
    0,
    () => clock,
    0,
    renameWithRetry,
    noopTimers,
  );
  await proxy.load();
  const id = proxy.proxied("https://cdn.example/removal-fails.gif")!.split("/").pop()!;
  const file = (await proxy.fetch(id))!.file;
  await rm(file);
  await mkdir(file);
  await writeFile(path.join(file, "keep"), "x");

  clock += 2_000;
  await proxy.maintain();
  assert.equal((await stat(file)).isDirectory(), true);
  assert.equal((proxy as unknown as { storedBytes: number }).storedBytes, GIF.length);
  assertStoredBytes(proxy);
});

test("a cancelled publish leaves the running byte total unchanged", async (t) => {
  const dir = await temporaryDirectory(t, "stremio-images-cancelled-publish-");
  const held = heldImage();
  const proxy = new ImageProxy(
    dir,
    MiB,
    0,
    async () => held.response,
    undefined,
    Date.now,
    0,
    renameWithRetry,
    noopTimers,
  );
  await proxy.load();
  const id = proxy.proxied("https://cdn.example/cancelled.gif")!.split("/").pop()!;
  const controller = new AbortController();
  const abandoned = proxy.fetch(id, controller.signal);
  await held.readStarted;
  controller.abort();

  assert.equal(await abandoned, undefined);
  await held.bodyCancelled;
  assertStoredBytes(proxy);
  assert.equal((proxy as unknown as { storedBytes: number }).storedBytes, 0);
});

test("a slower retry replaces the bytes of the same id instead of adding them", async (t) => {
  const dir = await temporaryDirectory(t, "stremio-images-retry-same-id-");
  const firstBytes = Buffer.from("GIF89a old bytes");
  const retryBytes = Buffer.from("GIF89a newer bytes after retry");
  let requests = 0;
  let renames = 0;
  let renameStarted!: () => void;
  let releaseRename!: () => void;
  const firstRenameStarted = new Promise<void>((resolve) => { renameStarted = resolve; });
  const firstRenameRelease = new Promise<void>((resolve) => { releaseRename = resolve; });
  const proxy = new ImageProxy(
    dir,
    MiB,
    0,
    async () => {
      requests += 1;
      return imageResponse(requests === 1 ? firstBytes : retryBytes);
    },
    0,
    Date.now,
    0,
    async (from, to) => {
      renames += 1;
      if (renames === 1) {
        renameStarted();
        await firstRenameRelease;
      }
      await rename(from, to);
    },
    noopTimers,
  );
  await proxy.load();
  const id = proxy.proxied("https://cdn.example/same-id.gif")!.split("/").pop()!;
  const waiter = new AbortController();
  const abandoned = proxy.fetch(id, waiter.signal);
  await firstRenameStarted;

  waiter.abort();
  const retrying = proxy.fetch(id);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await readdir(dir)).filter((name) => name.endsWith(".tmp")).length >= 2) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  releaseRename();

  const retried = await retrying;
  assert.ok(retried);
  assert.equal(await abandoned, undefined);
  assert.deepEqual(await readFile(retried.file), retryBytes);
  assert.equal((proxy as unknown as { storedBytes: number }).storedBytes, retryBytes.length);
  assertStoredBytes(proxy);
});

test("a JSON restart recounts bytes after reconciling the files", async (t) => {
  const dir = await temporaryDirectory(t, "stremio-images-json-recount-");
  const proxy = new ImageProxy(dir, MiB, 0, async () => imageResponse(), 0, Date.now, 0, renameWithRetry, noopTimers);
  await proxy.load();
  for (let index = 0; index < 3; index += 1) {
    const id = proxy.proxied(`https://cdn.example/restart-${index}.gif`)!.split("/").pop()!;
    assert.ok(await proxy.fetch(id));
  }
  await proxy.flush();
  assertStoredBytes(proxy);

  const restarted = new ImageProxy(dir, MiB, 0, async () => imageResponse(), 0, Date.now, 0, renameWithRetry, noopTimers);
  await restarted.load();
  assert.equal((restarted as unknown as { storedBytes: number }).storedBytes, 3 * GIF.length);
  assertStoredBytes(restarted);
});

test("a SQLite restart recounts bytes while loading database rows", async (t) => {
  // The folder goes only after the database is closed: Windows refuses to delete an open file.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "stremio-images-sqlite-recount-"));
  const imageDir = path.join(dataDir, "images");
  await mkdir(imageDir);
  let database: AppDatabase | undefined = await openAppDatabase({ dataDir });
  t.after(async () => {
    if (database) await database.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const createProxy = (store: AppDatabase) =>
    new ImageProxy(imageDir, MiB, 0, async () => imageResponse(), 0, Date.now, 0, renameWithRetry, noopTimers, store);

  const first = createProxy(database);
  await first.load();
  for (let index = 0; index < 2; index += 1) {
    const id = first.proxied(`https://cdn.example/sqlite-${index}.gif`)!.split("/").pop()!;
    assert.ok(await first.fetch(id));
  }
  await first.flush();
  assertStoredBytes(first);
  await database.close();
  database = await openAppDatabase({ dataDir });

  const restarted = createProxy(database);
  await restarted.load();
  assert.equal((restarted as unknown as { storedBytes: number }).storedBytes, 2 * GIF.length);
  assertStoredBytes(restarted);
});
