import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ImageProxy, imageId } from "./images.js";
import { configureSecureMode } from "./secure.js";
import { initLogger } from "./logger.js";

process.env.LOG_STDOUT = "0";
await initLogger(await mkdtemp(path.join(os.tmpdir(), "stremio-images-log-")));

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const REMOTE = "https://images.example/poster/tt1234.jpg?token=secret";

const imageResponse = (body: Buffer = PNG, type = "image/png", status = 200) =>
  new Response(status === 200 ? body : null, { status, headers: { "content-type": type } });

async function harness(responder: (url: string) => Promise<Response> = async () => imageResponse(), cap = 1024 * 1024, ttlMs = 0) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-images-"));
  const calls: string[] = [];
  const proxy = new ImageProxy(dir, cap, ttlMs, async (url) => { calls.push(url); return responder(url); });
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
