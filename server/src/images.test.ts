import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ImageProxy, imageId, narrowArtwork } from "./images.js";
import { configureSecureMode } from "./secure.js";
import { initLogger } from "./logger.js";

process.env.LOG_STDOUT = "0";
await initLogger(await mkdtemp(path.join(os.tmpdir(), "stremio-images-log-")));

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const REMOTE = "https://images.example/poster/tt1234.jpg?token=secret";
const DAY = 24 * 60 * 60 * 1000;

const imageResponse = (body: Buffer = PNG, type = "image/png", status = 200) =>
  new Response(status === 200 ? body : null, { status, headers: { "content-type": type } });

const jpeg = async () => imageResponse(Buffer.alloc(64, 7), "image/jpeg");
const cached = async (dir: string) => (await readdir(dir)).filter((name) => /^[\w-]{32}\.jpg$/.test(name));

async function harness(
  responder: (url: string) => Promise<Response> = async () => imageResponse(),
  cap = 1024 * 1024,
  ttlMs = 0,
  indexTtlMs?: number,
  now: () => number = Date.now,
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-images-"));
  const calls: string[] = [];
  const proxy = new ImageProxy(dir, cap, ttlMs, async (url) => { calls.push(url); return responder(url); }, indexTtlMs, now);
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

test("an id nobody handed out is never fetched", async () => {
  const { proxy, calls } = await harness();
  assert.equal(await proxy.fetch(imageId("https://cdn.example/never-offered.jpg")), undefined);
  assert.deepEqual(calls, []);
});

test("only real images are cached", async () => {
  const html = await harness(async () => imageResponse(Buffer.from("<html>"), "text/html"));
  const htmlId = html.proxy.proxied(REMOTE)!.split("/").pop()!;
  assert.equal(await html.proxy.fetch(htmlId), undefined);

  const big = await harness(async () => imageResponse(Buffer.alloc(9 * 1024 * 1024), "image/jpeg"));
  const bigId = big.proxy.proxied(REMOTE)!.split("/").pop()!;
  assert.equal(await big.proxy.fetch(bigId), undefined);

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

test("a picture over the cap is turned away before any resize", async () => {
  const { proxy, calls, dir } = await harness(async () => imageResponse(Buffer.alloc(9 * 1024 * 1024, 7), "image/jpeg"));
  const id = proxy.proxied(REMOTE)!.split("/").pop()!;
  assert.equal(await proxy.fetch(id), undefined);
  assert.deepEqual(calls, [REMOTE]);
  assert.deepEqual((await readdir(dir)).filter((name) => name !== "index.json"), []);
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
  assert.ok(kept * 400 <= 500 * 0.8, `expected at most 400 bytes, found ${kept} files`);
  for (const link of links) assert.ok((await restarted.fetch(link.split("/").pop()!))?.file, "a dropped id fetches again");
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
