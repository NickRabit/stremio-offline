import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ImageProxy, imageId, narrowArtwork, type SaveTimers } from "./images.js";
import { renameWithRetry } from "./fs-retry.js";
import { configureSecureMode } from "./secure.js";
import { initLogger } from "./logger.js";

process.env.LOG_STDOUT = "0";
await initLogger(await mkdtemp(path.join(os.tmpdir(), "stremio-images-log-")));

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const MiB = 1024 * 1024;
const REMOTE = "https://images.example/poster/tt1234.jpg?token=secret";
const PLAIN = "https://cdn.example/backdrop.jpg";
const MEDIUM = "https://images.metahub.space/background/medium/tt0903747/img";
const DETAIL = 1920;
const DAY = 24 * 60 * 60 * 1000;

const imageResponse = (body: Buffer = PNG, type = "image/png", status = 200) =>
  new Response(status === 200 ? new Uint8Array(body) : null, { status, headers: { "content-type": type } });

const jpeg = async () => imageResponse(Buffer.alloc(64, 7), "image/jpeg");
const cached = async (dir: string) => (await readdir(dir)).filter((name) => /^[\w-]{32}\.jpg$/.test(name));
const settle = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

function heldImage(body: Buffer = PNG) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let started!: () => void;
  let cancelled!: () => void;
  const readStarted = new Promise<void>((resolve) => { started = resolve; });
  const bodyCancelled = new Promise<void>((resolve) => { cancelled = resolve; });
  let released = false;
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
  const response = new Response(stream, { headers: { "content-type": "image/png" } });
  return {
    response,
    readStarted,
    bodyCancelled,
    release() {
      if (released) return;
      released = true;
      controller.enqueue(body);
      controller.close();
    },
  };
}

async function harness(
  responder: (url: string, init?: RequestInit) => Promise<Response> = async () => imageResponse(),
  cap = 1024 * 1024,
  ttlMs = 0,
  indexTtlMs?: number,
  now: () => number = Date.now,
  memoryCap = 0,
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-images-"));
  const calls: string[] = [];
  const proxy = new ImageProxy(dir, cap, ttlMs, async (url, init) => { calls.push(url); return await responder(url, init); }, indexTtlMs, now, memoryCap);
  await proxy.load();
  return { dir, proxy, calls };
}

test("the proxied link keeps the address to itself", async () => {
  const { proxy } = await harness();
  const link = proxy.proxied(REMOTE)!;
  assert.match(link, /^\/api\/image\/[\w-]{32}$/);
  assert.ok(!link.includes("example"));
  assert.ok(!Buffer.from(link.split("/").pop()!, "base64url").toString("utf8").includes("example"));
  assert.equal(proxy.proxied(REMOTE), link, "the same address always gets the same id");
});

test("only remote addresses take the detour", async () => {
  const { proxy } = await harness();
  assert.equal(proxy.proxied("/api/library/thumb?path=film.mkv"), "/api/library/thumb?path=film.mkv");
  assert.equal(proxy.proxied("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
  assert.equal(proxy.proxied(undefined), undefined);
});

test("what the page hands back becomes the real address again", async () => {
  const { proxy } = await harness();
  const link = proxy.proxied(REMOTE)!;
  assert.equal(proxy.original(link), REMOTE);
  assert.equal(proxy.original("/api/image/unknownunknownunknownunknown"), undefined);
  assert.equal(proxy.original("https://images.example/other.jpg"), "https://images.example/other.jpg");
});

test("every field the interface can show ends up rewritten", async () => {
  const { proxy } = await harness();
  const meta = proxy.rewriteMeta({
    id: "tt1", type: "movie", name: "Film",
    poster: "https://cdn.example/p.jpg", background: "https://cdn.example/b.jpg", logo: "https://cdn.example/l.png",
    description: "https://cdn.example/not-an-image is only text",
    videos: [{ id: "1", thumbnail: "https://cdn.example/still.jpg" }],
    images: ["https://cdn.example/1.jpg", { url: "https://cdn.example/2.jpg" }, { src: "https://cdn.example/3.jpg" }],
    screenshots: ["https://cdn.example/4.jpg"],
  });
  const serialized = JSON.stringify({ ...meta, description: "" });
  assert.ok(!serialized.includes("cdn.example"), serialized);
  assert.match(String(meta.poster), /^\/api\/image\//);
  assert.match(String((meta.videos as Array<Record<string, unknown>>)[0]!.thumbnail), /^\/api\/image\//);
  assert.equal(meta.description, "https://cdn.example/not-an-image is only text");
});

test("secure mode off leaves the payload as it came", async () => {
  const { proxy } = await harness();
  configureSecureMode(() => false);
  try {
    assert.equal(proxy.proxied(REMOTE), REMOTE);
    assert.equal(proxy.rewriteMeta({ id: "tt1", type: "movie", name: "Film", poster: REMOTE }).poster, REMOTE);
  } finally { configureSecureMode(() => true); }
});

test("the image is fetched once and then served from disk", async () => {
  const { proxy, calls, dir } = await harness();
  const id = proxy.proxied(REMOTE)!.split("/").pop()!;
  const first = await proxy.fetch(id);
  assert.equal(first?.type, "image/png");
  assert.equal(path.dirname(first!.file), dir);
  assert.deepEqual(await readFile(first!.file), PNG);
  assert.deepEqual(await proxy.fetch(id), first);
  assert.deepEqual(calls, [REMOTE]);
});

test("one image waiter leaving does not cancel another waiter's shared download", async () => {
  const held = heldImage();
  let upstream: AbortSignal | undefined;
  const { proxy, calls } = await harness((_url, init) => {
    upstream = init?.signal as AbortSignal;
    return Promise.resolve(held.response);
  });
  const id = proxy.proxied(REMOTE)!.split("/").pop()!;
  const first = new AbortController();
  const second = new AbortController();

  const leaving = proxy.fetch(id, first.signal);
  await held.readStarted;
  const staying = proxy.fetch(id, second.signal);
  first.abort();

  assert.equal(await leaving, undefined);
  assert.equal(upstream?.aborted, false, "the remaining waiter keeps the upstream request alive");
  held.release();
  assert.ok(await staying);
  assert.deepEqual(calls, [REMOTE], "both callers shared one download");
});

test("the last image waiter cancels a held body and a retry starts with a fresh flight", async () => {
  const held = heldImage();
  let requests = 0;
  let upstream: AbortSignal | undefined;
  const { proxy, calls, dir } = await harness(async (_url, init) => {
    requests += 1;
    if (requests === 1) {
      upstream = init?.signal as AbortSignal;
      return held.response;
    }
    return imageResponse();
  });
  const id = proxy.proxied(REMOTE)!.split("/").pop()!;
  const waiter = new AbortController();
  const abandoned = proxy.fetch(id, waiter.signal);
  await held.readStarted;

  waiter.abort();
  assert.equal(await abandoned, undefined);
  await held.bodyCancelled;
  assert.equal(upstream?.aborted, true);
  assert.equal(proxy.inMemory(id), false);
  assert.equal(proxy.takeFetched(id), false);

  const retrying = proxy.fetch(id);
  const retried = await retrying;
  assert.ok(retried, "the retry begins without joining the abandoned flight");
  assert.deepEqual(calls, [REMOTE, REMOTE]);
  assert.deepEqual(await readFile(retried!.file), PNG);
  assert.equal(proxy.takeFetched(id), true);
  assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith(`${id}.`)), [`${id}.png`]);
});

test("an abandoned flight cannot remove a retry committed after its rename", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-images-retry-rename-"));
  const firstBytes = Buffer.from("GIF89a abandoned");
  const retryBytes = Buffer.from("GIF89a successful retry");
  let requests = 0;
  let renames = 0;
  let renamedFirst!: () => void;
  let releaseFirst!: () => void;
  const firstRenamed = new Promise<void>((resolve) => { renamedFirst = resolve; });
  const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const proxy = new ImageProxy(
    dir,
    1024 * 1024,
    0,
    async () => {
      requests += 1;
      return imageResponse(requests === 1 ? firstBytes : retryBytes, "image/gif");
    },
    undefined,
    Date.now,
    0,
    async (from, to) => {
      renames += 1;
      await rename(from, to);
      if (renames === 1) {
        renamedFirst();
        await firstRelease;
      }
    },
  );
  try {
    await proxy.load();
    const id = proxy.proxied(REMOTE)!.split("/").pop()!;
    const abandonedWaiter = new AbortController();
    const abandoned = proxy.fetch(id, abandonedWaiter.signal);
    await firstRenamed;

    abandonedWaiter.abort();
    const retrying = proxy.fetch(id);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const temporary = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
      if (temporary.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    releaseFirst();
    const retried = await retrying;
    assert.ok(retried);
    assert.equal(await abandoned, undefined);
    assert.deepEqual(await readFile(retried.file), retryBytes, "the abandoned flight cannot roll back the retry");
    assert.equal(proxy.takeFetched(id), true, "the retry remains the fetch that published the image");
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    releaseFirst();
    await proxy.flush();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an abandoned rename cannot overtake a retry that is waiting to publish", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-images-publish-order-"));
  const firstBytes = Buffer.from("GIF89a old publish");
  const retryBytes = Buffer.from("GIF89a newer publish");
  let requests = 0;
  let renames = 0;
  let renameStarted!: () => void;
  let releaseRename!: () => void;
  const firstRenameStarted = new Promise<void>((resolve) => { renameStarted = resolve; });
  const firstRenameRelease = new Promise<void>((resolve) => { releaseRename = resolve; });
  const proxy = new ImageProxy(
    dir,
    1024 * 1024,
    0,
    async () => {
      requests += 1;
      return imageResponse(requests === 1 ? firstBytes : retryBytes, "image/gif");
    },
    undefined,
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
  );
  try {
    await proxy.load();
    const id = proxy.proxied(REMOTE)!.split("/").pop()!;
    const abandonedWaiter = new AbortController();
    const abandoned = proxy.fetch(id, abandonedWaiter.signal);
    await firstRenameStarted;

    abandonedWaiter.abort();
    let retrySettled = false;
    const retrying = proxy.fetch(id).finally(() => { retrySettled = true; });
    for (let attempt = 0; attempt < 200 && !retrySettled; attempt += 1) {
      const temporary = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
      if (temporary.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await settle();
    assert.equal(requests, 2, "the retry has reached the publish boundary");

    releaseRename();
    const retried = await retrying;
    assert.ok(retried);
    assert.equal(await abandoned, undefined);
    assert.deepEqual(await readFile(retried.file), retryBytes, "the newer retry publishes last");
    assert.equal(proxy.takeFetched(id), true, "the newer retry remains the published fetch");
  } finally {
    releaseRename();
    await proxy.flush();
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancellation during an image downscale leaves no cache entry or temporary file", {
  skip: process.platform === "win32" ? "the test uses a POSIX script for FFmpeg" : false,
}, async () => {
  const widePng = Buffer.alloc(24);
  widePng.writeUInt32BE(0x89504e47, 0);
  widePng.write("IHDR", 12, "latin1");
  widePng.writeUInt32BE(1_000, 16);
  const { proxy, dir } = await harness(async () => imageResponse(widePng));
  const marker = path.join(dir, "ffmpeg-started");
  const fake = path.join(dir, "ffmpeg");
  await writeFile(fake, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "started");\nsetInterval(() => {}, 1000);\n`);
  await chmod(fake, 0o755);
  const previous = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = fake;
  try {
    const id = proxy.proxied(REMOTE)!.split("/").pop()!;
    const waiter = new AbortController();
    const fetching = proxy.fetch(id, waiter.signal);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await stat(marker);
        break;
      } catch (error) {
        if (attempt >= 100) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    waiter.abort();
    assert.equal(await fetching, undefined);
    let leftovers: string[] = [];
    for (let attempt = 0; attempt < 200; attempt += 1) {
      leftovers = (await readdir(dir)).filter((name) => name.startsWith(`${id}.`) || name.startsWith(".resize-"));
      if (leftovers.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(await proxy.readCached(id), undefined);
    assert.equal(proxy.inMemory(id), false);
    assert.equal(proxy.takeFetched(id), false);
    assert.deepEqual(leftovers, []);
  } finally {
    if (previous === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = previous;
  }
});

test("an id nobody handed out is never fetched", async () => {
  const { proxy, calls } = await harness();
  assert.equal(await proxy.fetch(imageId("https://cdn.example/never-offered.jpg")), undefined);
  assert.deepEqual(calls, []);
});

test("only real images are cached", async () => {
  const html = await harness(async () => imageResponse(Buffer.from("<html>"), "text/html"));
  const htmlId = html.proxy.proxied(REMOTE)!.split("/").pop()!;
  assert.equal(await html.proxy.fetch(htmlId), undefined);

  const failed = await harness(async () => imageResponse(PNG, "image/png", 404));
  const failedId = failed.proxy.proxied(REMOTE)!.split("/").pop()!;
  assert.equal(await failed.proxy.fetch(failedId), undefined);
});

test("a restart keeps the link the page already holds working", async () => {
  const { proxy, dir } = await harness();
  const id = proxy.proxied(REMOTE)!.split("/").pop()!;
  await proxy.fetch(id);
  await proxy.flush();

  const restarted = new ImageProxy(dir, 1024 * 1024, 0, async () => { throw new Error("must not fetch again"); });
  await restarted.load();
  assert.equal(restarted.original(`/api/image/${id}`), REMOTE);
  assert.equal((await restarted.fetch(id))?.type, "image/png");
});

test("the cache stays under its limit and the addresses survive it", async () => {
  const { proxy, dir } = await harness(async () => imageResponse(Buffer.alloc(400, 7), "image/jpeg"), 1000);
  const links = ["a", "b", "c", "d"].map((name) => proxy.proxied(`https://cdn.example/${name}.jpg`)!);
  for (const link of links) await proxy.fetch(link.split("/").pop()!);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".jpg"));
  assert.ok(files.length < 4, `expected an eviction, found ${files.length} files`);
  assert.equal(proxy.original(links[0]!), "https://cdn.example/a.jpg");
});

test("an image nobody looks at any more goes on its own, whatever the limit", async () => {
  const { proxy } = await harness(async () => imageResponse(Buffer.alloc(64, 7), "image/jpeg"), 1024 * 1024, 40);
  const stale = proxy.proxied("https://cdn.example/stale.jpg")!.split("/").pop()!;
  await proxy.fetch(stale);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const fresh = proxy.proxied("https://cdn.example/fresh.jpg")!.split("/").pop()!;
  await proxy.fetch(fresh);
  assert.equal(proxy.source(stale), "https://cdn.example/stale.jpg", "the link the page already holds keeps working");
  assert.equal(await proxy.fetch(stale).then((image) => image?.type), "image/jpeg", "and the bytes come back on the next ask");
  assert.deepEqual(proxy.proxied("https://cdn.example/stale.jpg"), `/api/image/${stale}`, "the id never changes");
});

test("an image served again survives its own age", async () => {
  const { proxy } = await harness(async () => imageResponse(Buffer.alloc(64, 7), "image/jpeg"), 1024 * 1024, 40);
  const id = proxy.proxied("https://cdn.example/kept.jpg")!.split("/").pop()!;
  await proxy.fetch(id);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await proxy.fetch(id);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const other = proxy.proxied("https://cdn.example/other.jpg")!.split("/").pop()!;
  await proxy.fetch(other);
  assert.ok((await proxy.fetch(id))?.file, "a picture somebody keeps looking at is not the one dropped");
});

test("a metahub background steps one size down", () => {
  assert.equal(
    narrowArtwork("https://images.metahub.space/background/medium/tt0903747/img"),
    "https://images.metahub.space/background/small/tt0903747/img",
  );
  assert.equal(
    narrowArtwork("https://images.metahub.space/background/large/tt0903747/img?token=1"),
    "https://images.metahub.space/background/small/tt0903747/img?token=1",
  );
});

test("everything a narrower tile cannot use keeps its address", () => {
  const untouched = [
    "https://images.metahub.space/background/small/tt0903747/img",
    "https://images.metahub.space/poster/medium/tt0903747/img",
    "https://images.metahub.space/logo/large/tt0903747/img",
    "https://images.example/background/medium/tt0903747/img",
    "https://images.metahub.space.evil.example/background/medium/tt0903747/img",
    "images.metahub.space/background/medium/tt0903747/img",
    "",
  ];
  for (const url of untouched) assert.equal(narrowArtwork(url), url);
});

test("only the background is narrowed on the way to the cache", async () => {
  const { proxy, calls } = await harness();
  const meta = proxy.rewriteMeta({
    id: "tt1", type: "movie", name: "Film",
    poster: "https://images.metahub.space/poster/medium/tt0903747/img",
    background: "https://images.metahub.space/background/medium/tt0903747/img",
    logo: "https://images.metahub.space/logo/medium/tt0903747/img",
    videos: [{ id: "1", thumbnail: "https://images.metahub.space/background/medium/tt0903747/still.jpg" }],
  });
  const thumbnail = (meta.videos as Array<Record<string, unknown>>)[0]!.thumbnail as string;
  for (const link of [meta.poster, meta.background, meta.logo, thumbnail]) await proxy.fetch(String(link).split("/").pop()!);
  assert.deepEqual(calls, [
    "https://images.metahub.space/poster/medium/tt0903747/img",
    "https://images.metahub.space/background/small/tt0903747/img",
    "https://images.metahub.space/logo/medium/tt0903747/img",
    "https://images.metahub.space/background/medium/tt0903747/still.jpg",
  ]);
});

test("the default reading still narrows a backdrop to its tile", async () => {
  const { proxy } = await harness();
  const listing = proxy.rewriteMeta({ id: "tt1", type: "movie", name: "Film", background: MEDIUM });
  assert.equal(listing.background, proxy.proxied(narrowArtwork(MEDIUM)), "the listing hands out the narrow tile");
  const detail = proxy.rewriteMeta({ id: "tt1", type: "movie", name: "Film", background: MEDIUM }, true);
  assert.notEqual(detail.background, listing.background, "the detail is a different, wider picture");
});

test("a detail backdrop keeps the full-width address", async () => {
  const { proxy, calls } = await harness();
  const meta = proxy.rewriteMeta({ id: "tt1", type: "movie", name: "Film", background: MEDIUM }, true);
  await proxy.fetch(String(meta.background).split("/").pop()!);
  assert.deepEqual(calls, [MEDIUM], "the full Metahub backdrop is fetched, not the small tile");
});

test("a detail variant never reuses the tile the listing cached", async () => {
  const { proxy, calls } = await harness();
  const listing = proxy.proxied(PLAIN)!;
  const detail = proxy.proxied(PLAIN, DETAIL)!;
  assert.notEqual(detail, listing, "the same address gets a different id per width");
  await proxy.fetch(listing.split("/").pop()!);
  await proxy.fetch(detail.split("/").pop()!);
  assert.deepEqual(calls, [PLAIN, PLAIN], "the wider picture is fetched rather than served from the tile");
});

test("a detail gallery keeps the wider address while the poster stays a tile", async () => {
  const { proxy } = await harness();
  const meta = proxy.rewriteMeta({ id: "tt1", type: "movie", name: "Film", poster: PLAIN, images: [PLAIN] }, true);
  const gallery = (meta.images as string[])[0]!;
  assert.equal(gallery, proxy.proxied(PLAIN, DETAIL), "the wide gallery entry is registered at the detail width");
  assert.equal(meta.poster, proxy.proxied(PLAIN), "the poster keeps the tile width");
});

test("a gallery poster reuses its existing poster cache variant", async () => {
  const { proxy } = await harness();
  const meta = proxy.rewriteMeta({ id: "tt1", type: "movie", name: "Film", poster: PLAIN,
    images: [{ url: PLAIN, kind: "poster", shape: "poster" }, { url: MEDIUM, kind: "background", shape: "wide" }] }, true);
  const gallery = meta.images as Array<{ url: string }>;
  assert.equal(gallery[0]!.url, meta.poster);
  assert.equal(gallery[1]!.url, proxy.proxied(MEDIUM, DETAIL));
});

test("a detail width survives an index reload before the bytes exist", async () => {
  const { proxy, dir } = await harness();
  const id = proxy.proxied(PLAIN, DETAIL)!.split("/").pop()!;
  await proxy.flush();

  const restarted = new ImageProxy(dir, 1024 * 1024, 0, async () => { throw new Error("must not fetch"); });
  await restarted.load();
  // Force the loaded map back to disk; a reload that dropped the width would lose it here.
  restarted.proxied("https://cdn.example/other.jpg");
  await restarted.flush();
  const stored = JSON.parse(await readFile(path.join(dir, "index.json"), "utf8")) as Record<string, { width?: number }>;
  assert.equal(stored[id]!.width, DETAIL, "a variant with no bytes keeps its width across a reload");
});

test("a width nobody serves is clamped to the listing tile", async () => {
  const { dir } = await harness();
  const id = "bogusbogusbogusbogusbogusbogus12";
  await writeFile(path.join(dir, "index.json"), JSON.stringify({ [id]: { url: PLAIN, at: Date.now(), width: 1234 } }));

  const restarted = new ImageProxy(dir, 1024 * 1024, 0, async () => imageResponse());
  await restarted.load();
  restarted.proxied("https://cdn.example/other.jpg");
  await restarted.flush();
  const stored = JSON.parse(await readFile(path.join(dir, "index.json"), "utf8")) as Record<string, { url?: string; width?: number }>;
  assert.equal(stored[id]!.url, PLAIN);
  assert.equal(stored[id]!.width, undefined, "an unknown width reads as the listing width");
});

test("a chunked picture over the cap is turned away before the full body arrives", async () => {
  const totalChunks = 20;
  let pulled = 0;
  let cancelled = false;
  const source = new Uint8Array(MiB);
  const { proxy, calls, dir } = await harness(async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= totalChunks) { controller.close(); return; }
      pulled += 1;
      controller.enqueue(source);
    },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "image/jpeg" } }));
  const id = proxy.proxied(REMOTE)!.split("/").pop()!;
  assert.equal(await proxy.fetch(id), undefined);
  assert.deepEqual(calls, [REMOTE]);
  assert.deepEqual((await readdir(dir)).filter((name) => name !== "index.json"), []);
  assert.equal(cancelled, true);
  assert.ok(pulled < totalChunks, `the source stopped after ${pulled} chunks`);
});

test("a picture ffmpeg cannot read is kept as it was fetched", async () => {
  const { proxy } = await harness();
  const id = proxy.proxied(REMOTE)!.split("/").pop()!;
  const image = await proxy.fetch(id);
  assert.equal(image?.type, "image/png");
  assert.deepEqual(await readFile(image!.file), PNG);
});

test("a metahub address with a dot segment cannot be narrowed onto another host", () => {
  // The first implementation spliced by byte offset into the original string, and a
  // pathname the URL parser had normalised made that offset land inside the hostname.
  const narrowed = narrowArtwork("https://images.metahub.space/background/medium/../medium/tt1/img");
  assert.equal(new URL(narrowed).host, "images.metahub.space");
  assert.equal(narrowed, "https://images.metahub.space/background/small/tt1/img");
});

test("maintain drops the bytes past their age without a download", async () => {
  let clock = 1_000_000;
  const { proxy, dir } = await harness(jpeg, 1024 * 1024, 1000, 90 * DAY, () => clock);
  const id = proxy.proxied(REMOTE)!.split("/").pop()!;
  await proxy.fetch(id);
  assert.equal((await cached(dir)).length, 1);

  clock += 2000;
  await proxy.maintain();
  assert.deepEqual(await cached(dir), [], "old bytes go with no download");
  assert.equal(proxy.source(id), REMOTE, "the link the page holds keeps working");
});

test("with the byte TTL off, maintain keeps everything under the cap", async () => {
  let clock = 1_000_000;
  const { proxy, dir } = await harness(jpeg, 1024 * 1024, 0, 90 * DAY, () => clock);
  const id = proxy.proxied(REMOTE)!.split("/").pop()!;
  await proxy.fetch(id);

  clock += 10 * DAY;
  await proxy.maintain();
  assert.equal((await cached(dir)).length, 1, "nothing ages out when the TTL is 0");
});

test("serving and emitting each refresh an image's age", async () => {
  let clock = 1_000_000;
  const { proxy, dir } = await harness(jpeg, 1024 * 1024, 1000, 90 * DAY, () => clock);
  const link = proxy.proxied(REMOTE)!;
  const id = link.split("/").pop()!;
  await proxy.fetch(id);

  clock += 1500;
  assert.equal(proxy.proxied(REMOTE), link);
  await proxy.maintain();
  assert.equal((await cached(dir)).length, 1, "an emission keeps the bytes");

  clock += 1500;
  await proxy.fetch(id);
  await proxy.maintain();
  assert.equal((await cached(dir)).length, 1, "serving keeps the bytes");
});

test("a lowered cap is enforced when the cache is loaded again", async () => {
  const chunk = async () => imageResponse(Buffer.alloc(400, 7), "image/jpeg");
  const { proxy, dir } = await harness(chunk, 1024 * 1024);
  const links = ["a", "b", "c", "d"].map((name) => proxy.proxied(`https://cdn.example/${name}.jpg`)!);
  for (const link of links) await proxy.fetch(link.split("/").pop()!);
  await proxy.flush();
  assert.equal((await cached(dir)).length, 4);

  const restarted = new ImageProxy(dir, 500, 0, async () => chunk());
  await restarted.load();
  const kept = (await cached(dir)).length;
  // The margin is max(1, floor(500 * 0.02)) = 10, so the floor is 490 bytes: one file remains.
  assert.equal(kept, 1);
  for (const link of links) assert.ok((await restarted.fetch(link.split("/").pop()!))?.file, "a dropped id fetches again");
});

test("a pass drops to the headroom floor, leaving nine where an 80% floor would leave eight", async () => {
  const chunk = async () => imageResponse(Buffer.alloc(1000, 7), "image/jpeg");
  const { proxy, dir } = await harness(chunk, 1024 * 1024);
  const links = Array.from({ length: 12 }, (_, index) => proxy.proxied(`https://cdn.example/${index}.jpg`)!);
  for (const link of links) await proxy.fetch(link.split("/").pop()!);
  await proxy.flush();
  assert.equal((await cached(dir)).length, 12);

  // The floor is 10000 - max(1, floor(10000 * 0.02)) = 9800, so 9 files fit and the cache stops
  // there. A floor of `cap * 0.8` (8000) would have dropped a tenth file as well.
  const restarted = new ImageProxy(dir, 10000, 0, async () => chunk());
  await restarted.load();
  assert.equal((await cached(dir)).length, 9);
});

test("a poster read once is served from memory, and a picture over that cap is not kept", async () => {
  const { proxy } = await harness(jpeg, 1024 * 1024, 0, undefined, Date.now, 1024 * 1024);
  const id = proxy.proxied(REMOTE)!.split("/").pop()!;
  const stored = (await proxy.fetch(id))!.file;
  const first = await proxy.readCached(id);
  assert.deepEqual(first, Buffer.alloc(64, 7), "the miss reads the file once");

  await rm(stored, { force: true });
  assert.deepEqual(await proxy.readCached(id), first, "a memory hit never goes back to the disk");

  const small = await harness(jpeg, 1024 * 1024, 0, undefined, Date.now, 10);
  const { proxy: tight } = small;
  const big = tight.proxied(REMOTE)!.split("/").pop()!;
  const file = (await tight.fetch(big))!.file;
  assert.deepEqual(await tight.readCached(big), Buffer.alloc(64, 7), "the read still succeeds");
  await rm(file, { force: true });
  assert.equal(await tight.readCached(big), undefined, "a buffer over the memory cap is never stored");
});

test("preheat fills the memory with the hottest posters and never reads an old one", async () => {
  let clock = 1_000_000;
  const bytes = Buffer.alloc(1000, 7);
  const { proxy } = await harness(async () => imageResponse(bytes, "image/jpeg"), 1024 * 1024, 0, undefined, () => clock, 2500);
  const files: string[] = [];
  for (const name of ["one", "two", "three"]) {
    const id = proxy.proxied(`https://cdn.example/${name}.jpg`)!.split("/").pop()!;
    files.push((await proxy.fetch(id))!.file);
    clock += 1000;
  }
  const ids = files.map((file) => path.basename(file, ".jpg"));

  await proxy.preheat();
  for (const file of files) await rm(file, { force: true });

  assert.equal(await proxy.readCached(ids[0]!), undefined, "the oldest does not fit and is not read");
  assert.deepEqual(await proxy.readCached(ids[1]!), bytes, "the second newest is in memory");
  assert.deepEqual(await proxy.readCached(ids[2]!), bytes, "the newest is in memory");
});

test("maintain forgets an old link with no bytes and keeps the ones still in use", async () => {
  let clock = 1_000_000;
  const { proxy } = await harness(jpeg, 1024 * 1024, 0, 1000, () => clock);
  const withBytes = proxy.proxied("https://cdn.example/bytes.jpg")!.split("/").pop()!;
  const stale = proxy.proxied("https://cdn.example/stale.jpg")!.split("/").pop()!;
  clock += 500;
  const recent = proxy.proxied("https://cdn.example/recent.jpg")!.split("/").pop()!;
  await proxy.fetch(withBytes);

  clock += 1000;
  await proxy.maintain();
  assert.equal(proxy.source(stale), undefined, "the unused link is forgotten");
  assert.equal(proxy.source(recent), "https://cdn.example/recent.jpg", "a recent link stays");
  assert.equal(proxy.source(withBytes), "https://cdn.example/bytes.jpg", "a link with bytes stays");
});

test("maintain leaves a link whose download is still in flight", async () => {
  let clock = 1_000_000;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { proxy } = await harness(
    async (url) => { if (url.includes("inflight")) await gate; return jpeg(); },
    1024 * 1024, 0, 1000, () => clock,
  );
  const inflight = proxy.proxied("https://cdn.example/inflight.jpg")!.split("/").pop()!;
  const pending = proxy.fetch(inflight);

  clock += 5000;
  await proxy.maintain();
  assert.equal(proxy.source(inflight), "https://cdn.example/inflight.jpg", "an in-flight download is not retired");
  release();
  assert.ok((await pending)?.file);
});

test("indexTtlMs 0 keeps links forever", async () => {
  let clock = 1_000_000;
  const { proxy } = await harness(jpeg, 1024 * 1024, 0, 0, () => clock);
  const id = proxy.proxied(REMOTE)!.split("/").pop()!;

  clock += 10 * 365 * DAY;
  await proxy.maintain();
  assert.equal(proxy.source(id), REMOTE);
});

test("a retired link stays gone across a restart", async () => {
  let clock = 1_000_000;
  const { proxy, dir } = await harness(jpeg, 1024 * 1024, 0, 1000, () => clock);
  const stale = proxy.proxied("https://cdn.example/stale.jpg")!.split("/").pop()!;

  clock += 2000;
  await proxy.maintain();
  await proxy.flush();
  assert.equal(proxy.source(stale), undefined);

  const restarted = new ImageProxy(dir, 1024 * 1024, 0, async () => { throw new Error("must not fetch"); }, 1000, () => clock);
  await restarted.load();
  assert.equal(restarted.source(stale), undefined, "the forgotten link does not come back");
});

test("a retired link answers 404 and is issued again on the next emission", async () => {
  let clock = 1_000_000;
  const { proxy, calls } = await harness(jpeg, 1024 * 1024, 0, 1000, () => clock);
  const link = proxy.proxied(REMOTE)!;
  const id = link.split("/").pop()!;

  clock += 2000;
  await proxy.maintain();
  assert.equal(await proxy.fetch(id), undefined, "the route answers 404");
  assert.equal(proxy.original(link), undefined);

  assert.equal(proxy.proxied(REMOTE), link, "the same address yields the same id");
  assert.ok((await proxy.fetch(id))?.file, "and it fetches again");
  assert.deepEqual(calls, [REMOTE]);
});

test("a cached image that cannot be removed is kept and retried", async () => {
  let clock = 1_000_000;
  const { proxy, calls, dir } = await harness(jpeg, 1024 * 1024, 1000, 90 * DAY, () => clock);
  const id = proxy.proxied(REMOTE)!.split("/").pop()!;
  const file = (await proxy.fetch(id))!.file;
  assert.equal(calls.length, 1);

  await rm(file, { force: true });
  await mkdir(file);
  await writeFile(path.join(file, "keep"), "x");
  clock += 2000;
  await proxy.maintain();
  assert.equal(calls.length, 1, "a failed removal leaves the entry and its bytes");
  assert.equal((await proxy.fetch(id))?.file, file, "and the entry is still served from that path");

  await rm(file, { recursive: true, force: true });
  await writeFile(file, Buffer.alloc(64, 9));
  clock += 2000;
  await proxy.maintain();
  await assert.rejects(stat(file), "the retry removes the bytes");
  assert.equal((await cached(dir)).length, 0);
  await proxy.fetch(id);
  assert.equal(calls.length, 2, "the picture is fetched again");
});

test("concurrent maintenance and a download leave a consistent cache", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { proxy, dir } = await harness(
    async (url) => { if (url.includes("gated")) await gate; return jpeg(); },
  );
  const id = proxy.proxied("https://cdn.example/gated.jpg")!.split("/").pop()!;
  const pending = proxy.fetch(id);
  const first = proxy.maintain();
  const second = proxy.maintain();
  assert.equal(first, second, "a second call shares the running pass");

  release();
  const [image] = await Promise.all([pending, first, second]);
  assert.ok(image?.file);
  assert.deepEqual(await readFile(image!.file), Buffer.alloc(64, 7), "the path it handed out is on disk");
  assert.equal((await cached(dir)).length, 1, "index and disk agree");
  assert.equal(proxy.original(`/api/image/${id}`), "https://cdn.example/gated.jpg");
});

test("an addon that names its own poster as the backdrop has no backdrop", () => {
  const images = new ImageProxy();
  const poster = "https://images.metahub.space/poster/medium/tt1/img";
  const empty = images.rewriteMeta({ id: "tt1", type: "series", name: "One", poster, background: poster });
  assert.equal(empty.poster, `/api/image/${imageId(poster)}`, "the poster still stands");
  assert.equal(empty.background, undefined, "the poster is not a backdrop");
  const real = images.rewriteMeta({ id: "tt1", type: "series", name: "One", poster, background: "https://images.metahub.space/background/medium/tt1/img" });
  assert.match(String(real.background), /^\/api\/image\//, "a real backdrop is kept");
});

test("an index write that failed is made again by the next flush, and writes never overlap", async () => {
  const { proxy, dir } = await harness();
  const first = proxy.proxied("https://cdn.example/first.jpg")!.split("/").pop()!;
  // A directory where the temporary file goes makes the write fail, the way a full disk would.
  await mkdir(path.join(dir, "index.json.tmp"));
  await proxy.flush();
  await rm(path.join(dir, "index.json.tmp"), { recursive: true });
  await proxy.flush();
  const stored = JSON.parse(await readFile(path.join(dir, "index.json"), "utf8")) as Record<string, unknown>;
  assert.ok(stored[first], "the entry the failed write carried reaches the disk with the next flush");

  // Two flushes in flight at once share one temporary file; the second must wait for the first.
  const second = proxy.proxied("https://cdn.example/second.jpg")!.split("/").pop()!;
  const pending = proxy.flush();
  const third = proxy.proxied("https://cdn.example/third.jpg")!.split("/").pop()!;
  await Promise.all([pending, proxy.flush()]);
  const after = JSON.parse(await readFile(path.join(dir, "index.json"), "utf8")) as Record<string, unknown>;
  assert.ok(after[second] && after[third], "the last write to land is the newest index");
});

test("a link that is only handed out again is not written to the index every few seconds", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-images-touch-"));
  let clock = 1_000_000;
  // Only the index schedule is driven by hand; the file system keeps its real timers, so a
  // retry wait inside a write (a locked file on Windows) still runs out on its own.
  let elapsed = 0;
  const scheduled = new Set<{ due: number; run: () => void }>();
  const advance = (ms: number) => {
    elapsed += ms;
    for (const timer of [...scheduled]) if (timer.due <= elapsed) { scheduled.delete(timer); timer.run(); }
  };
  const timers: SaveTimers = {
    set: (run, ms) => { const timer = { due: elapsed + ms, run }; scheduled.add(timer); return timer; },
    clear: (handle) => { scheduled.delete(handle as { due: number; run: () => void }); },
  };
  const proxy = new ImageProxy(dir, MiB, 0, jpeg, undefined, () => clock, 0, renameWithRetry, timers);
  const stored = async () => {
    try { return JSON.parse(await readFile(path.join(dir, "index.json"), "utf8")) as Record<string, { at: number }>; }
    catch { return {}; }
  };
  // Reading the file holds it open, which on Windows makes the index rename wait and retry;
  // a write that has to land gets a generous deadline and is not read back too eagerly.
  const diskShows = async (check: (index: Record<string, { at: number }>) => boolean, withinMs = 10_000) => {
    const deadline = Date.now() + withinMs;
    while (Date.now() < deadline) {
      if (check(await stored())) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  };
  try {
    await proxy.load();
    const id = proxy.proxied(REMOTE)!.split("/").pop()!;
    await proxy.flush();
    const firstUse = clock;

    // An open page asks for the download list every five seconds, and every answer hands the
    // same posters out again; a large index rewritten each time keeps a NAS busy for nothing.
    for (let poll = 0; poll < 24; poll += 1) {
      clock += 5000;
      proxy.proxied(REMOTE);
      advance(5000);
      assert.equal(await diskShows((index) => index[id]?.at !== firstUse, 50), false, `poll ${poll + 1} rewrote the index`);
    }

    const fresh = proxy.proxied(PLAIN)!.split("/").pop()!;
    advance(2000);
    assert.ok(await diskShows((index) => Boolean(index[fresh])), "a new link is still written within seconds");
    assert.equal((await stored())[id]!.at, clock, "and carries the last use of the old one with it");

    clock += 1000;
    proxy.proxied(REMOTE);
    advance(10 * 60_000);
    assert.ok(await diskShows((index) => index[id]?.at === clock), "a use nothing else carries is written later on its own");
  } finally {
    await proxy.flush();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a locked index file still gets written while the index schedule is driven by hand", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-images-locked-"));
  const scheduled: Array<() => void> = [];
  const timers: SaveTimers = { set: (run) => { scheduled.push(run); return run; }, clear: () => undefined };
  let busy = 2;
  // What Windows does while a scanner holds the file: the rename fails with EPERM and the
  // retry waits on a real timer before trying again.
  const lockedOnce: typeof renameWithRetry = (from, to) => renameWithRetry(from, to, {
    platform: "win32",
    renameImpl: async (source, target) => {
      if (path.basename(String(target)) === "index.json" && busy > 0) {
        busy -= 1;
        throw Object.assign(new Error("locked"), { code: "EPERM" });
      }
      await rename(source, target);
    },
  });
  const proxy = new ImageProxy(dir, MiB, 0, jpeg, undefined, Date.now, 0, lockedOnce, timers);
  try {
    await proxy.load();
    const id = proxy.proxied(REMOTE)!.split("/").pop()!;
    scheduled.shift()!();
    await proxy.flush();
    const stored = JSON.parse(await readFile(path.join(dir, "index.json"), "utf8")) as Record<string, unknown>;
    assert.ok(stored[id], "the write waited out the lock and landed");
    assert.equal(busy, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
