import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ArtworkQueue, artworkBesideMedia, fileMayUseFolderArtwork, savePosterAs } from "./artwork.js";

process.env.ALLOW_PRIVATE_ADDONS = "1";

test("a poster lands next to the media only where the library allows writing", () => {
  const healthy = { unreachable: false, readOnly: false };
  assert.equal(artworkBesideMedia("media", { writeArtwork: true }, healthy), true);
  assert.equal(artworkBesideMedia("data", { writeArtwork: true }, healthy), false, "the setting alone decides in the ordinary case");
  assert.equal(artworkBesideMedia("media", { writeArtwork: false }, healthy), false, "a curated library keeps its folder to itself");
  assert.equal(artworkBesideMedia("media", { writeArtwork: true }, { unreachable: false, readOnly: true }), false);
  assert.equal(artworkBesideMedia("media", { writeArtwork: true }, { unreachable: true, readOnly: false }), false, "a mount that is down is not written to");
});

test("a movie file may reuse the folder poster, a series episode may not", () => {
  assert.equal(fileMayUseFolderArtwork(path.join("Practical Magic", "Practical Magic.mkv"), "movie"), true);
  assert.equal(fileMayUseFolderArtwork("Practical Magic.mkv", "movie"), false);
  assert.equal(fileMayUseFolderArtwork(path.join("Father Ted", "01 serie", "01.mkv"), "series"), false);
  assert.equal(fileMayUseFolderArtwork(path.join("xxx", "one.mp4"), "movie"), true);
  assert.equal(fileMayUseFolderArtwork(path.join("xxx", "one.mp4")), false);
  assert.equal(fileMayUseFolderArtwork(path.join("xxx", "one.mp4"), "series"), false);
});

test("ArtworkQueue.run with the same key twice chains the second task", async () => {
  const queue = new ArtworkQueue();
  const order: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  queue.run("dir:Foo", async () => { order.push(1); await gate; order.push(2); });
  const second = queue.run("dir:Foo", async () => { order.push(3); });
  release();
  await second;
  assert.deepEqual(order, [1, 2, 3]);
});

test("ArtworkQueue.has reports a key only while its job is queued or running", async () => {
  const queue = new ArtworkQueue();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  assert.equal(queue.has("dir:Foo"), false);
  const job = queue.run("dir:Foo", async () => { await gate; });
  assert.equal(queue.has("dir:Foo"), true);
  release();
  await job;
  assert.equal(queue.has("dir:Foo"), false);
});

test("a poster that does not arrive says why", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "poster-"));
  const target = path.join(directory, "poster.jpg");
  const server = createServer((req, res) => {
    if (req.url === "/missing") { res.writeHead(404).end(); return; }
    if (req.url === "/text") { res.writeHead(200, { "content-type": "text/plain" }).end("not a picture"); return; }
    if (req.url === "/big") { res.writeHead(200, { "content-type": "image/jpeg" }).end(Buffer.alloc(9 * 1024 * 1024)); return; }
    res.writeHead(200, { "content-type": "image/jpeg" }).end(Buffer.from([0xff, 0xd8, 0xff]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    // Every refusal is named, because a title that stays blank has to be explainable.
    assert.deepEqual(await savePosterAs(target, `${base}/missing`), { ok: false, reason: "status", detail: "404" });
    assert.deepEqual(await savePosterAs(target, `${base}/text`), { ok: false, reason: "content-type", detail: "text/plain" });
    assert.deepEqual(await savePosterAs(target, `${base}/big`), { ok: false, reason: "size", detail: `${9 * 1024 * 1024}` });
    const refused = await savePosterAs(target, "http://127.0.0.1:1/poster.jpg");
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false && refused.reason, "failed");
    // And the one that works still works.
    assert.deepEqual(await savePosterAs(target, `${base}/ok`), { ok: true });
  } finally {
    await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
