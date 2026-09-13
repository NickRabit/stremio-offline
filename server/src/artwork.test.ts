import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { ArtworkQueue, artworkBesideMedia, fileMayUseFolderArtwork } from "./artwork.js";

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
