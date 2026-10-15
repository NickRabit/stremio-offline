import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initLogger } from "./logger.js";
import { RemoteImageCache, remoteImageKey, type RemoteImageBody } from "./remote-image-cache.js";

process.env.LOG_STDOUT = "0";
await initLogger(await mkdtemp(path.join(os.tmpdir(), "stremio-remote-image-log-")));

const KEY_FILE = /^[0-9a-f]{64}\.(jpg|png|webp|gif)$/;

const withDir = async (run: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-remote-images-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

const until = async (predicate: () => Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the awaited condition was never reached");
};

const stored = async (dir: string): Promise<string[]> =>
  (await readdir(dir).catch(() => [])).filter((name) => KEY_FILE.test(name)).sort();

const drain = async (body: RemoteImageBody): Promise<Buffer> => {
  const reader = body.stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks);
};

const upstreamOf = (bytes: Buffer, type = "image/png", status = 200) => {
  const calls = { count: 0 };
  const load = async (_signal: AbortSignal) => {
    calls.count += 1;
    return new Response(status === 200 ? new Uint8Array(bytes) : null, { status, headers: { "content-type": type } });
  };
  return { load, calls };
};

const never = async (): Promise<Response> => { throw new Error("the upstream must not be read"); };

const keyOf = (tag: string, size: "" | "tile" | "detail" = "") =>
  remoteImageKey({ connectionId: "conn-1", itemId: "item-1", imageType: "Primary", size, tag });

/** A file the index recognises, with a distinct mtime. */
const plant = async (dir: string, index: number, bytes: number, at: number) => {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${index.toString(16).padStart(64, "0")}.jpg`);
  await writeFile(file, Buffer.alloc(bytes));
  await utimes(file, at, at);
  return file;
};

test("the key is a hex digest of the parts and names no tag, token or address", () => {
  const key = remoteImageKey({ connectionId: "conn-1", itemId: "item-1", imageType: "Backdrop", size: "detail", tag: "tag-secret" });
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(key.includes("tag-secret"), false);
  assert.equal(key.includes("conn-1"), false);
  assert.notEqual(key, keyOf("other-secret", "detail"));
  // A width is its own entry: a tile can never be served the detail bytes, or the reverse, and a
  // request that names no size keeps the entry it always had.
  assert.notEqual(keyOf("tag-secret", "tile"), keyOf("tag-secret", "detail"));
  assert.notEqual(keyOf("tag-secret", "tile"), keyOf("tag-secret"));
});

test("close waits for a poster that has just finished, so the file is durable", async () => {
  await withDir(async (dir) => {
    const cache = new RemoteImageCache(dir, 1024 * 1024, 0);
    await cache.load();
    await drain(await cache.open(keyOf("tag-1"), undefined, upstreamOf(Buffer.from("poster")).load));
    await cache.close();
    assert.equal((await stored(dir)).length, 1);
  });
});

test("two proof tags are two files, and an empty size is not the detail size", async () => {
  await withDir(async (dir) => {
    const cache = new RemoteImageCache(dir, 1024 * 1024, 0);
    await cache.load();
    for (const key of [keyOf("tag-1"), keyOf("tag-2"), keyOf("tag-1", "detail")]) {
      await drain(await cache.open(key, undefined, upstreamOf(Buffer.from("poster")).load));
    }
    await until(async () => (await stored(dir)).length === 3);
    assert.equal((await stored(dir)).length, 3, "each tag and each size is its own file");
  });
});

test("a second open after the body ended is a memory hit even with the file gone", async () => {
  await withDir(async (dir) => {
    const cache = new RemoteImageCache(dir);
    await cache.load();
    const upstream = upstreamOf(Buffer.from("poster bytes"));
    const first = await cache.open(keyOf("tag-1"), undefined, upstream.load);
    assert.equal(first.cached, false);
    assert.deepEqual(await drain(first), Buffer.from("poster bytes"));
    await until(async () => (await stored(dir)).length === 1);
    for (const name of await stored(dir)) await rm(path.join(dir, name), { force: true });

    const again = await cache.open(keyOf("tag-1"), undefined, never);
    assert.equal(again.cached, true, "the bytes come from memory");
    assert.deepEqual(await drain(again), Buffer.from("poster bytes"));
    assert.equal(upstream.calls.count, 1);
  });
});

test("a body over five mebibytes or a non-image type is streamed but never stored", async () => {
  await withDir(async (dir) => {
    const cache = new RemoteImageCache(dir);
    await cache.load();
    const big = upstreamOf(Buffer.alloc(5 * 1024 * 1024 + 1), "image/png");
    const over = await cache.open(keyOf("big"), undefined, big.load);
    assert.equal((await drain(over)).length, 5 * 1024 * 1024 + 1, "the waiter still gets every byte");
    const html = upstreamOf(Buffer.from("<html>"), "text/html");
    await drain(await cache.open(keyOf("html"), undefined, html.load));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(await stored(dir), [], "neither body was written");
    await drain(await cache.open(keyOf("big"), undefined, big.load));
    await drain(await cache.open(keyOf("html"), undefined, html.load));
    assert.equal(big.calls.count, 2, "an unstored body is fetched again");
    assert.equal(html.calls.count, 2);
  });
});

test("a pass drops the oldest files down to the floor, not to four fifths of the cap", async () => {
  await withDir(async (dir) => {
    for (let index = 0; index < 12; index += 1) await plant(dir, index, 1000, 1000 + index);
    // The floor is 10000 - max(1, floor(10000 * 0.02)) = 9800, so 9 files fit.
    const cache = new RemoteImageCache(dir, 10000);
    await cache.load();
    const left = await stored(dir);
    assert.equal(left.length, 9);
    assert.equal(left.includes(`${(0).toString(16).padStart(64, "0")}.jpg`), false, "the oldest went first");
    assert.equal(left.includes(`${(3).toString(16).padStart(64, "0")}.jpg`), true, "the tenth newest stayed");
  });
});

test("preheat prefers the newest mtime and keeps nothing that does not fit", async () => {
  await withDir(async (dir) => {
    await plant(dir, 0, 1000, 1000);
    await plant(dir, 1, 1000, 2000);
    await plant(dir, 2, 1000, 3000);
    const cache = new RemoteImageCache(dir, 1024 * 1024, 2500);
    await cache.load();
    await cache.preheat();
    for (const name of await stored(dir)) await rm(path.join(dir, name), { force: true });

    const newest = await cache.open(`${(2).toString(16).padStart(64, "0")}`, undefined, never);
    assert.equal(newest.cached, true);
    assert.equal((await drain(newest)).length, 1000);
    const middle = await cache.open(`${(1).toString(16).padStart(64, "0")}`, undefined, never);
    assert.equal(middle.cached, true);
    await assert.rejects(cache.open(`${(0).toString(16).padStart(64, "0")}`, undefined, never), "the oldest did not fit");
  });
});

test("load drops a half-written temp file and counts only key-shaped names", async () => {
  await withDir(async (dir) => {
    await plant(dir, 0, 10, 1000);
    await writeFile(path.join(dir, `${"b".repeat(64)}.jpg.tmp`), Buffer.alloc(4));
    await writeFile(path.join(dir, "not-a-key.jpg"), Buffer.alloc(4));
    const cache = new RemoteImageCache(dir, 1024 * 1024);
    await cache.load();
    assert.deepEqual(await stored(dir), [`${(0).toString(16).padStart(64, "0")}.jpg`], "the temp file is gone");
    assert.equal(await readdir(dir).then((names) => names.includes("not-a-key.jpg")), true, "another name is left alone");
  });
});

test("a waiter that joins mid-flight receives the prefix and then the live chunks", async () => {
  await withDir(async (dir) => {
    const cache = new RemoteImageCache(dir);
    await cache.load();
    let push!: (chunk: Uint8Array | null) => void;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        push = (chunk) => { if (chunk === null) controller.close(); else controller.enqueue(chunk); };
      },
    });
    let calls = 0;
    const load = async (_signal: AbortSignal) => {
      calls += 1;
      return new Response(stream, { status: 200, headers: { "content-type": "image/png" } });
    };
    const first = await cache.open(keyOf("live"), undefined, load);
    const reader = first.stream.getReader();
    push(new Uint8Array([1]));

    const second = await cache.open(keyOf("live"), undefined, load);
    const other = second.stream.getReader();
    assert.equal(calls, 1, "the second waiter shares the load");

    push(new Uint8Array([2]));
    push(null);
    assert.deepEqual(await reader.read(), { value: new Uint8Array([1]), done: false });
    assert.deepEqual(await reader.read(), { value: new Uint8Array([2]), done: false });
    assert.equal((await reader.read()).done, true);
    assert.deepEqual(await other.read(), { value: new Uint8Array([1]), done: false }, "the prefix arrived");
    assert.deepEqual(await other.read(), { value: new Uint8Array([2]), done: false });
    assert.equal((await other.read()).done, true);
    await until(async () => (await stored(dir)).length === 1);
  });
});

test("the last waiter leaving aborts the upstream and stores nothing", async () => {
  await withDir(async (dir) => {
    const cache = new RemoteImageCache(dir);
    await cache.load();
    let cancelled = 0;
    let push!: (chunk: Uint8Array | null) => void;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        push = (chunk) => { if (chunk === null) controller.close(); else controller.enqueue(chunk); };
      },
      cancel: () => { cancelled += 1; },
    });
    const load = async (_signal: AbortSignal) => new Response(stream, { status: 200, headers: { "content-type": "image/png" } });
    const controller = new AbortController();
    const body = await cache.open(keyOf("gone"), controller.signal, load);
    const reader = body.stream.getReader();
    controller.abort();
    await until(async () => cancelled === 1);
    assert.equal(cancelled, 1, "the upstream read was cancelled");
    assert.deepEqual(await stored(dir), [], "nothing was written");
    await reader.cancel().catch(() => undefined);
    void push;
  });
});
