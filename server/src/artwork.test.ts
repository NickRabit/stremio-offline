import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  artNames, artOutput, artVariantKey, ArtworkQueue, artworkBesideMedia, BACKDROP_NAMES, fileMayUseFolderArtwork,
  findArtwork, POSTER_NAMES, saveBackdropAs, savePosterAs,
} from "./artwork.js";
import { ArtworkCache } from "./artwork-cache.js";

process.env.ALLOW_PRIVATE_ADDONS = "1";

const ffmpeg = promisify(execFile);
const hasFfmpeg = await ffmpeg("ffmpeg", ["-version"]).then(() => true, () => false);

test("a shape names the pictures in a folder and the file we write", () => {
  assert.deepEqual(artNames("poster"), POSTER_NAMES);
  assert.deepEqual(artNames("wide"), BACKDROP_NAMES);
  assert.equal(artOutput("poster"), "poster.jpg");
  assert.equal(artOutput("wide"), "backdrop.jpg");
  assert.equal(artOutput("wide"), BACKDROP_NAMES[0], "the wide variant is the name Jellyfin reads first");
});

test("the backdrop names keep their order: fanart.jpg serves, backdrop.jpg beats it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "artwork-names-"));
  try {
    assert.equal(await findArtwork(directory, BACKDROP_NAMES), undefined);
    await writeFile(path.join(directory, "fanart.jpg"), Buffer.from([1]));
    assert.equal(await findArtwork(directory, BACKDROP_NAMES), "fanart.jpg", "a fanart is a backdrop where backdrop.jpg is absent");
    assert.equal(await findArtwork(directory), undefined, "and it is not a poster");
    await writeFile(path.join(directory, "backdrop.jpg"), Buffer.from([1]));
    assert.equal(await findArtwork(directory, BACKDROP_NAMES), "backdrop.jpg");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the poster key stays byte-for-byte what it is today, the wide one is a second sha1", () => {
  const key = "lib_ab12cd34/Show/01 serie/01.mkv";
  const cache = new ArtworkCache("/data/artwork-test");
  const named = (name: string) => `${createHash("sha1").update(name).digest("hex")}.jpg`;
  assert.equal(artVariantKey(key, "poster"), key, "no file on disk is renamed by the second variant");
  assert.equal(artVariantKey(key, "wide"), `${key}#wide`);
  assert.notEqual(artVariantKey(key, "wide"), artVariantKey(key, "poster"));
  assert.equal(path.basename(cache.file(artVariantKey(key, "poster"))), named("Show/01 serie/01.mkv"));
  // The same directory, so the byte accounting and the eviction of the cache need no change.
  assert.equal(path.dirname(cache.file(artVariantKey(key, "wide"))), path.dirname(cache.file(key)));
  assert.equal(path.basename(cache.file(artVariantKey(key, "wide"))), named("Show/01 serie/01.mkv#wide"));
  // A folder key takes the same suffix, and lands beside the folder's poster.
  const folder = "dir:lib_ab12cd34/Show";
  assert.equal(path.basename(cache.file(artVariantKey(folder, "wide"))), named("dir:Show#wide"));
  assert.equal(path.dirname(cache.file(artVariantKey(folder, "wide"))), path.dirname(cache.file(folder)));
});

test("a poster lands next to the media only where the library allows writing", () => {
  const healthy = { unreachable: false, readOnly: false };
  assert.equal(artworkBesideMedia({ writeArtwork: true }, healthy), true, "the library's own switch is the one control");
  assert.equal(artworkBesideMedia({ writeArtwork: false }, healthy), false, "a curated library keeps its folder to itself");
  assert.equal(artworkBesideMedia({ writeArtwork: true }, { unreachable: false, readOnly: true }), false);
  assert.equal(artworkBesideMedia({ writeArtwork: true }, { unreachable: true, readOnly: false }), false, "a mount that is down is not written to");
});

test("a movie file may reuse the folder poster, a series episode may not", () => {
  assert.equal(fileMayUseFolderArtwork(path.join("Practical Magic", "Practical Magic.mkv"), "movie"), true);
  assert.equal(fileMayUseFolderArtwork("Practical Magic.mkv", "movie"), false);
  assert.equal(fileMayUseFolderArtwork(path.join("Father Ted", "01 serie", "01.mkv"), "series"), false);
  assert.equal(fileMayUseFolderArtwork(path.join("xxx", "one.mp4"), "movie"), false, "a folder of unrelated videos is not this film's folder");
  assert.equal(fileMayUseFolderArtwork(path.join("xxx", "one.mp4")), false);
  assert.equal(fileMayUseFolderArtwork(path.join("xxx", "one.mp4"), "series"), false);
});

test("the binding decides whose folder it is, not the shape of the path", () => {
  const file = path.join("xxx", "Playing something.mp4");
  const film = path.join("Practical Magic", "Practical Magic (CZ).mkv");
  // The binding that covers the file sits on the folder: the folder is the title's folder,
  // whatever the file is called.
  assert.equal(fileMayUseFolderArtwork(film, "movie", "Practical Magic"), true);
  // It sits on the file: the folder is a container, and its picture belongs to none of the
  // films inside it.
  assert.equal(fileMayUseFolderArtwork(file, "movie", file), false);
  assert.equal(fileMayUseFolderArtwork(path.join("Practical Magic", "Practical Magic.mkv"), "movie", path.join("Practical Magic", "Practical Magic.mkv")), true, "a film named after its own folder keeps it");
  assert.equal(fileMayUseFolderArtwork(film, "series", "Practical Magic"), false);
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

test("a catalogue backdrop is narrowed before it is stored", { skip: !hasFfmpeg }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backdrop-"));
  const source = path.join(directory, "source.jpg");
  await ffmpeg("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=1280x720:duration=1", "-frames:v", "1", "-y", source]);
  const data = await readFile(source);
  const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "image/jpeg" }).end(data); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const target = path.join(directory, "backdrop.jpg");
    assert.deepEqual(await saveBackdropAs(target, `${base}/wide.jpg`), { ok: true });
    const { stdout } = await ffmpeg("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=width", "-of", "csv=p=0", target]);
    assert.ok(Number(stdout.trim()) <= 640, `stored ${stdout.trim()} px wide`);
  } finally {
    await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
