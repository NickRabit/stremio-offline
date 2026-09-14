import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { DownloadQueue, isPlaylist } from "./downloads.js";
import { defaultDownloadSettings } from "./naming.js";

const MB = 1024 * 1024;
const GiB = 1024 ** 3;
const TOTAL = 120 * MB;
const DROP_AFTER = 51 * MB;

process.env.ALLOW_PRIVATE_ADDONS = "1";

const send = async (res: NodeJS.WritableStream, bytes: number) => {
  const chunk = Buffer.alloc(Math.min(MB, bytes));
  for (let sent = 0; sent < bytes; ) {
    const size = Math.min(chunk.length, bytes - sent);
    const piece = size === chunk.length ? chunk : chunk.subarray(0, size);
    if (!res.write(piece)) await new Promise((resolve) => res.once("drain", resolve));
    sent += size;
  }
};

const waitFor = async (queue: DownloadQueue, predicate: () => boolean, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout: ${JSON.stringify(queue.snapshot())}`);
};

const tempQueue = async (hooks: ConstructorParameters<typeof DownloadQueue>[4] = {}) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), path.join(directory, "downloads"), {
    retryDelay: () => 30,
    stallInitialMs: 5_000,
    stallTransferMs: 5_000,
    ...hooks,
  });
  await queue.load();
  return { directory, queue, downloads: path.join(directory, "downloads") };
};

const listen = (handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) => new Promise<{ server: Server; port: number }>((resolve) => {
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
});

const flakyServer = () => new Promise<{ server: Server; port: number; drops: () => number }>((resolve) => {
  let drops = 0;
  const server = createServer(async (req, res) => {
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    if (!range) {
      res.writeHead(200, { "content-length": String(TOTAL), "content-type": "video/mp4" });
      await send(res, DROP_AFTER);
      drops += 1;
      req.socket.destroy();
      return;
    }
    const offset = Number(range[1]);
    res.writeHead(206, { "content-length": String(TOTAL - offset), "content-range": `bytes ${offset}-${TOTAL - 1}/${TOTAL}` });
    await send(res, TOTAL - offset);
    res.end();
  });
  server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port, drops: () => drops }));
});

test("after an outage and a resumed transfer the retry budget comes back", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const { server, port, drops } = await flakyServer();
  const manager = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), path.join(directory, "downloads"));
  try {
    await manager.load();
    await manager.add("Pokus", { url: `http://127.0.0.1:${port}/video.mp4` });
    await waitFor(manager, () => {
      const job = manager.list()[0];
      return job.status === "completed" || job.status === "failed";
    }, 60_000);
    const job = manager.list()[0];
    assert.equal(drops(), 1, "the server should have cut the connection exactly once");
    assert.equal(job.status, "completed", `the download should have finished, status: ${job.status} ${job.error ?? ""}`);
    assert.ok(job.startedAt);
    assert.ok(job.completedAt);
    assert.ok(Date.parse(job.completedAt) >= Date.parse(job.startedAt));
    assert.equal(job.retryCount, 0, "after a resumed transfer the retry budget should be full again");
    assert.equal((await stat(path.join(directory, "downloads", job.target))).size, TOTAL);
  } finally {
    manager.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

const countingServer = (bytes = 2 * MB) => new Promise<{ server: Server; port: number; peak: () => number }>((resolve) => {
  let inflight = 0; let peak = 0;
  const server = createServer(async (_req, res) => {
    inflight += 1; peak = Math.max(peak, inflight);
    res.writeHead(200, { "content-length": String(bytes), "content-type": "video/mp4" });
    await new Promise((done) => setTimeout(done, 300));
    await send(res, bytes);
    res.end();
    inflight -= 1;
  });
  server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port, peak: () => peak }));
});

const runThree = async (perProvider: number) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const { server, port, peak } = await countingServer();
  const queue = new DownloadQueue(() => 4, () => perProvider, path.join(directory, "data"), path.join(directory, "downloads"));
  try {
    await queue.load();
    for (const name of ["Prvni", "Druhy", "Treti"]) await queue.add(name, { url: `http://127.0.0.1:${port}/${name}.mp4` });
    await waitFor(queue, () => queue.list().every((job) => job.status === "completed" || job.status === "failed"), 30_000);
    assert.deepEqual(queue.list().map((job) => job.status), ["completed", "completed", "completed"]);
    return peak();
  } finally {
    queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
};

test("only the allowed number of transfers runs from one provider", async () => {
  assert.equal(await runThree(1), 1, "at one, transfers from a single host must not meet");
});

test("a higher per-provider limit lets transfers run side by side again", async () => {
  assert.equal(await runThree(2), 2, "at two, exactly two should run at once");
});

test("the same source cannot be queued twice", async () => {
  const { directory, queue } = await tempQueue();
  try {
    const url = "http://127.0.0.1:1/film.mkv";
    const first = await queue.add("Film", { url });
    await queue.pause(first.id);
    await assert.rejects(() => queue.add("Film", { url }), /already in the queue/);
    await assert.rejects(() => queue.add("A different title", { url }), /already in the queue/, "the source decides, not the title");
    const other = await queue.add("Another film", { url: "http://127.0.0.1:1/other.mkv" });
    await queue.pause(other.id);
    assert.equal(queue.list().length, 2);
  } finally {
    queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a save rule sends the file into the library it names", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const downloadDir = path.join(directory, "downloads");
  const archiveRoot = path.join(directory, "archive");
  const archive = { id: "lib_12345678", name: "Archive", type: "movie" as const, root: archiveRoot, enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: true };
  const size = 4096;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    void send(res, size).then(() => res.end());
  });
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloadDir, {
    stallInitialMs: 5_000, stallTransferMs: 5_000,
    libraries: () => [archive],
    targetLibrary: (_kind, libraryId) => libraryId === archive.id ? archive : undefined,
  });
  await queue.load();
  try {
    const job = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` }, undefined, { subfolder: "", layout: "structured", libraryId: archive.id });
    assert.equal(job.target, "lib_12345678/Film/Film.mp4", "the job stores the qualified target");
    await waitFor(queue, () => queue.list()[0]?.status === "completed");
    assert.equal((await stat(path.join(archiveRoot, "Film", "Film.mp4"))).size, size, "it landed in the library the rule named");
    await assert.rejects(stat(path.join(downloadDir, "Film", "Film.mp4")), "and not in the download directory");

    // A rule that names a library this instance does not have is the default again, so an
    // imported backup or a removed library cannot strand a download.
    const fallback = await queue.add("Other", { url: `http://127.0.0.1:${port}/other.mp4` }, undefined, { subfolder: "", layout: "structured", libraryId: "lib_99999999" });
    assert.equal(fallback.target, "Other/Other.mp4");
    await waitFor(queue, () => queue.list().find((item) => item.id === fallback.id)?.status === "completed");
    assert.equal((await stat(path.join(downloadDir, "Other", "Other.mp4"))).size, size);
  } finally {
    queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a clean close short of Content-Length is retried from the .part file", async () => {
  const size = 32 * 1024;
  const drop = 8 * 1024;
  let requests = 0;
  const { server, port } = await listen(async (req, res) => {
    requests += 1;
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    if (!range) {
      res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
      await send(res, drop);
      res.end();
      return;
    }
    const offset = Number(range[1]);
    res.writeHead(206, { "content-length": String(size - offset), "content-range": `bytes ${offset}-${size - 1}/${size}` });
    await send(res, size - offset);
    res.end();
  });
  const { directory, queue, downloads } = await tempQueue({ stallTransferMs: 200, stallInitialMs: 200 });
  try {
    await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed");
    const job = queue.list()[0];
    assert.equal(job.status, "completed", job.error);
    assert.ok(requests >= 2, "the short first response must be followed by a Range resume");
    assert.equal((await stat(path.join(downloads, job.target))).size, size);
  } finally {
    queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a clean close without a known size is not treated as finished", async () => {
  const { server, port } = await listen(async (_req, res) => {
    res.writeHead(200, { "content-type": "video/mp4" });
    await send(res, 4096);
    res.end();
  });
  const { directory, queue } = await tempQueue();
  try {
    await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4`, behaviorHints: { videoSize: 40_000 } });
    await waitFor(queue, () => queue.list()[0].status === "failed" || queue.list()[0].retryCount === 3);
    const job = queue.list()[0];
    assert.notEqual(job.status, "completed");
    assert.match(job.error ?? "", /ended early|does not match|retry/);
  } finally {
    queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("ENOSPC pauses the queue and leaves later jobs untouched", async () => {
  let hits = 0;
  const { server, port } = await listen((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-length": "4096", "content-type": "video/mp4" });
    res.end(Buffer.alloc(4096));
  });
  const boom = () => new Writable({
    write(_chunk, _enc, cb) {
      cb(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }) as NodeJS.ErrnoException);
    },
  });
  const { directory, queue } = await tempQueue({
    createWriteStream: () => boom(),
    freeSpace: async () => ({ freeBytes: 0, totalBytes: 8 * GiB }),
  });
  try {
    await queue.add("Prvni", { url: `http://127.0.0.1:${port}/a.mp4` });
    await queue.add("Druhy", { url: `http://127.0.0.1:${port}/b.mp4` });
    await waitFor(queue, () => queue.haltInfo()?.reason === "storage");
    assert.equal(queue.list()[0].status, "paused");
    assert.equal(queue.list()[0].pauseReason, "storage");
    assert.equal(queue.list()[1].status, "queued");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(hits, 1, "the second job must not start while storage is halted");
  } finally {
    queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the queue resumes by itself once free space returns", async () => {
  const size = 4096;
  let failWrite = true;
  let freeBytes = 0;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    res.end(Buffer.alloc(size));
  });
  const { directory, queue, downloads } = await tempQueue({
    spaceCheckMs: 40,
    freeSpace: async () => ({ freeBytes, totalBytes: 8 * GiB }),
    createWriteStream: (file, options) => failWrite
      ? new Writable({ write(_c, _e, cb) { cb(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }) as NodeJS.ErrnoException); } })
      : createWriteStream(file, options),
  });
  try {
    await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    await waitFor(queue, () => queue.haltInfo()?.reason === "storage");
    failWrite = false;
    freeBytes = 8 * GiB;
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed");
    assert.equal(queue.list()[0].status, "completed", queue.list()[0].error);
    assert.equal(queue.haltInfo(), null);
    assert.equal((await stat(path.join(downloads, queue.list()[0].target))).size, size);
  } finally {
    queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a 206 that restarts at byte 0 does not append onto the .part file", async () => {
  const size = 16 * 1024;
  const drop = 4 * 1024;
  const { server, port } = await listen(async (req, res) => {
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    if (!range) {
      res.writeHead(200, { "content-length": String(size) });
      res.end(Buffer.alloc(drop, 1));
      return;
    }
    res.writeHead(206, { "content-length": String(size), "content-range": `bytes 0-${size - 1}/${size}` });
    res.end(Buffer.alloc(size, 2));
  });
  const { directory, queue, downloads } = await tempQueue({ stallTransferMs: 200, stallInitialMs: 200 });
  try {
    await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed");
    const job = queue.list()[0];
    assert.equal(job.status, "completed", job.error);
    const body = await readFile(path.join(downloads, job.target));
    assert.equal(body.length, size);
    assert.ok(body.every((byte) => byte === 2), "the restarted payload must replace the partial, not follow it");
  } finally {
    queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("notBefore stops pump from retrying immediately", async () => {
  let hits = 0;
  const { server, port } = await listen((_req, res) => {
    hits += 1;
    res.writeHead(429, { "retry-after": "60" });
    res.end();
  });
  const { directory, queue } = await tempQueue({ retryDelay: (_count, after) => after ?? 60_000 });
  try {
    await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    await waitFor(queue, () => (queue.list()[0].retryCount ?? 0) >= 1);
    const hitsAfterFirst = hits;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(hits, hitsAfterFirst, "Retry-After must be honoured");
    assert.equal(queue.list()[0].status, "queued");
  } finally {
    queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a downloading job is requeued from the .part file after load", async () => {
  const size = 8192;
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const data = path.join(directory, "data");
  const downloads = path.join(directory, "downloads");
  await mkdir(data, { recursive: true });
  await mkdir(downloads, { recursive: true });
  await writeFile(path.join(downloads, "Film.mp4.part"), Buffer.alloc(2048, 9));
  const { server, port } = await listen((req, res) => {
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    assert.ok(range, "the restored job must send Range");
    assert.equal(Number(range![1]), 2048);
    res.writeHead(206, { "content-length": String(size - 2048), "content-range": `bytes 2048-${size - 1}/${size}` });
    res.end(Buffer.alloc(size - 2048, 8));
  });
  await writeFile(path.join(data, "downloads.json"), JSON.stringify([{
    id: "job-1", title: "Film", status: "downloading", target: "Film.mp4", received: 2048, total: size,
    speed: 100, createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z",
    stream: { url: `http://127.0.0.1:${port}/film.mp4` },
  }]));
  const restored = new DownloadQueue(() => 1, () => 1, data, downloads, { retryDelay: () => 30 });
  try {
    await restored.load();
    await waitFor(restored, () => restored.list()[0].status === "completed" || restored.list()[0].status === "failed");
    assert.equal(restored.list()[0].status, "completed", restored.list()[0].error);
    assert.equal((await stat(path.join(downloads, "Film.mp4"))).size, size);
  } finally {
    restored.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP 404 fails a direct job and moves a lazy job to the next source", async () => {
  let goodHits = 0;
  const { server, port } = await listen((req, res) => {
    if (req.url === "/missing.mp4") { res.writeHead(404); res.end(); return; }
    goodHits += 1;
    res.writeHead(200, { "content-length": "2048" });
    res.end(Buffer.alloc(2048));
  });
  const { directory, queue } = await tempQueue();
  try {
    await queue.add("Primo", { url: `http://127.0.0.1:${port}/missing.mp4` });
    await waitFor(queue, () => queue.list()[0].status === "failed");
    assert.match(queue.list()[0].error ?? "", /HTTP 404/);

    queue.setResolver(async ({ tried }) => {
      const url = tried.includes(`http://127.0.0.1:${port}/missing.mp4`)
        ? `http://127.0.0.1:${port}/ok.mp4`
        : `http://127.0.0.1:${port}/missing.mp4`;
      return { stream: { url }, settings: defaultDownloadSettings() };
    });
    await queue.addPending("Díl", { type: "series", videoId: "tt1" }, { kind: "episode", title: "Show", season: 1, episode: 1 });
    await waitFor(queue, () => queue.list().some((job) => job.title === "Díl" && (job.status === "completed" || job.status === "failed")));
    const lazy = queue.list().find((job) => job.title === "Díl")!;
    assert.equal(lazy.status, "completed", lazy.error);
    assert.ok(goodHits >= 1);
  } finally {
    queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a smart job stores selected addon subtitles beside the completed episode", async () => {
  const { server, port } = await listen((req, res) => {
    if (req.url === "/episode.srt") {
      res.writeHead(200, { "content-type": "application/x-subrip" });
      res.end("1\n00:00:01,000 --> 00:00:02,000\nAhoj\n");
      return;
    }
    res.writeHead(200, { "content-length": "2048", "content-type": "video/mp4" });
    res.end(Buffer.alloc(2048));
  });
  const { directory, queue, downloads } = await tempQueue();
  try {
    queue.setResolver(async () => ({
      stream: { url: `http://127.0.0.1:${port}/episode.mp4`, addonKey: "source" },
      subtitle: { url: `http://127.0.0.1:${port}/episode.srt`, lang: "cs" },
      resolution: { checkedCandidates: 1, audioLanguage: "cs", audioTrack: 0, subtitleLanguage: "cs", subtitleSource: "addon", subtitleStatus: "ready" },
      settings: defaultDownloadSettings(),
    }));
    await queue.addPending("Díl", { type: "series", videoId: "tt1:1:1", selection: {
      addonKeys: ["source"], sourceStrategy: "priority", audioLanguage: "cs", subtitleMode: "required",
      subtitleLanguage: "cs", targetSettings: defaultDownloadSettings().series,
    } }, { kind: "episode", title: "Show", season: 1, episode: 1 });
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed");
    assert.equal(queue.list()[0].status, "completed", queue.list()[0].error);
    assert.match(await readFile(path.join(downloads, "Show", "01 serie", "01.cs.vtt"), "utf8"), /WEBVTT[\s\S]*00:00:01\.000[\s\S]*Ahoj/);
  } finally {
    queue.stop(); server.close(); await rm(directory, { recursive: true, force: true });
  }
});

const HASH = "59e11cef8c2152ac73681092844ebd3db19025bc";

test("a torrent waits on Real-Debrid then downloads over HTTP without taking a slot", async () => {
  const payload = Buffer.alloc(32 * 1024, 7);
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(payload.length), "content-type": "video/mp4" });
    res.end(payload);
  });
  let calls = 0;
  let ready = false;
  const { directory, queue, downloads } = await tempQueue({
    debridPollMs: 20,
    debrid: {
      configured: () => true,
      advance: async () => {
        calls += 1;
        if (!ready) return { ready: false, torrentId: "rd1", progress: 40, status: "downloading" };
        return { ready: true, torrentId: "rd1", url: `http://127.0.0.1:${port}/movie.mp4`, filename: "Movie.mkv" };
      },
    },
  });
  try {
    const waiting = await queue.add("Film", { infoHash: HASH, fileIdx: 0, name: "1080p" });
    assert.equal(waiting.status, "waiting");
    await queue.add("Http", { url: `http://127.0.0.1:${port}/other.mp4` });
    await waitFor(queue, () => queue.list().some((job) => job.title === "Http" && job.status === "completed"));
    assert.equal(queue.list().find((job) => job.title === "Film")?.status, "waiting");
    ready = true;
    await waitFor(queue, () => queue.list().every((job) => job.status === "completed"));
    const torrent = queue.list().find((job) => job.title === "Film")!;
    assert.equal(torrent.status, "completed");
    assert.equal(torrent.debridProgress, 100);
    assert.equal((await stat(path.join(downloads, torrent.target))).size, payload.length);
    assert.ok(calls >= 2);
  } finally {
    queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("the same infoHash is not queued twice", async () => {
  const { directory, queue } = await tempQueue({
    debrid: { configured: () => true, advance: async () => ({ ready: false, torrentId: "rd1", progress: 1, status: "queued" }) },
  });
  try {
    await queue.add("Film", { infoHash: HASH, fileIdx: 0 });
    await assert.rejects(queue.add("Film", { infoHash: HASH, fileIdx: 0 }), /already in the queue/);
  } finally {
    queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a dropped Real-Debrid call is retried instead of failing the job", async () => {
  let calls = 0;
  const { directory, queue } = await tempQueue({
    debridPollMs: 20,
    debridRetryMs: 20,
    debrid: {
      configured: () => true,
      advance: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed");
        return { ready: false, torrentId: "rd1", progress: 10, status: "downloading" };
      },
    },
  });
  try {
    await queue.add("Film", { infoHash: HASH, fileIdx: 0 });
    await waitFor(queue, () => calls >= 2 && queue.list()[0].status === "waiting");
    assert.equal(queue.list()[0].status, "waiting");
  } finally {
    queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a torrent without a token is refused", async () => {
  const { directory, queue } = await tempQueue();
  try {
    await assert.rejects(queue.add("Film", { infoHash: HASH }), /Real-Debrid/);
  } finally {
    queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a damaged queue file is quarantined and the server still starts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const data = path.join(directory, "data");
  await mkdir(data, { recursive: true });
  const state = path.join(data, "downloads.json");
  await writeFile(state, "{not-json");
  const queue = new DownloadQueue(() => 1, () => 1, data, path.join(directory, "downloads"));
  try {
    await queue.load();
    assert.equal(queue.list().length, 0);
    assert.equal(await readFile(`${state}.bak`, "utf8"), "{not-json");
  } finally {
    queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

const SEGMENTED_TOTAL = 48 * MB;
const byteAt = (position: number) => position % 251;
const filled = (from: number, length: number) => Buffer.from(Array.from({ length }, (_unused, index) => byteAt(from + index)));

/** Serves byte ranges, and every byte says where in the file it belongs, so a segment written
 *  to the wrong offset cannot pass unnoticed. */
const rangeServer = (options: { total?: number; ranges?: boolean; cutAt?: number } = {}) => new Promise<{
  server: Server; port: number; peak: () => number; requests: () => string[];
}>((resolve) => {
  const total = options.total ?? SEGMENTED_TOTAL;
  let inflight = 0; let peak = 0; let cut = options.cutAt != null;
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    requests.push(req.headers.range ?? "");
    const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    if (!match || options.ranges === false) {
      res.writeHead(200, { "content-length": String(total), "content-type": "video/mp4" });
      for (let sent = 0; sent < total; sent += MB) res.write(filled(sent, Math.min(MB, total - sent)));
      res.end();
      return;
    }
    inflight += 1; peak = Math.max(peak, inflight);
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : total - 1;
    res.writeHead(206, { "content-length": String(to - from + 1), "content-range": `bytes ${from}-${to}/${total}` });
    for (let sent = from; sent <= to; sent += 64 * 1024) {
      const length = Math.min(64 * 1024, to - sent + 1);
      if (cut && options.cutAt != null && sent + length > from + options.cutAt) { cut = false; req.socket.destroy(); inflight -= 1; return; }
      res.write(filled(sent, length));
      await new Promise((done) => setTimeout(done, 1));
    }
    res.end();
    inflight -= 1;
  });
  server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port, peak: () => peak, requests: () => requests }));
});

const assertContent = async (file: string, total: number) => {
  const data = await readFile(file);
  assert.equal(data.length, total);
  for (let position = 0; position < total; position += 7919) {
    assert.equal(data[position], byteAt(position), `byte ${position} came from the wrong place in the file`);
  }
};

test("a file is fetched over several connections and lands byte for byte", async () => {
  const { directory, queue, downloads } = await tempQueue({ segments: () => 3 });
  const { server, port, peak } = await rangeServer();
  try {
    const job = await queue.add("Segmented", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.list()[0].status !== "downloading" && queue.list()[0].status !== "queued", 60_000);
    const done = queue.list()[0];
    assert.equal(done.status, "completed", done.error ?? "");
    assert.equal(done.segments, undefined, "a finished download keeps no plan");
    assert.equal(peak(), 3, "all three segments should have run at once");
    await assertContent(path.join(downloads, job.target), SEGMENTED_TOTAL);
  } finally {
    queue.stop(); server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a source that ignores ranges is downloaded over one stream", async () => {
  const { directory, queue, downloads } = await tempQueue({ segments: () => 4 });
  const { server, port, peak } = await rangeServer({ ranges: false });
  try {
    const job = await queue.add("Plain", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed", 60_000);
    assert.equal(queue.list()[0].status, "completed", queue.list()[0].error ?? "");
    assert.equal(peak(), 0, "no ranged transfer should have started");
    await assertContent(path.join(downloads, job.target), SEGMENTED_TOTAL);
  } finally {
    queue.stop(); server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a segment cut mid-transfer resumes at its own offset", async () => {
  const { directory, queue, downloads } = await tempQueue({ segments: () => 2 });
  const { server, port, requests } = await rangeServer({ cutAt: 2 * MB });
  try {
    const job = await queue.add("Broken", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed", 60_000);
    assert.equal(queue.list()[0].status, "completed", queue.list()[0].error ?? "");
    assert.ok(requests().some((range) => /^bytes=[1-9]\d+-\d+$/.test(range)), `a retry should have asked for a later offset: ${requests().join(", ")}`);
    await assertContent(path.join(downloads, job.target), SEGMENTED_TOTAL);
  } finally {
    queue.stop(); server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a paused segmented download keeps its plan and finishes after a resume", async () => {
  const { directory, queue, downloads } = await tempQueue({ segments: () => 2 });
  const { server, port } = await rangeServer();
  try {
    const job = await queue.add("Paused", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.list()[0].received > MB, 30_000);
    await queue.pause(job.id);
    const paused = queue.list()[0];
    assert.equal(paused.status, "paused");
    assert.equal(paused.segments, 2, "the plan has to survive the pause");
    assert.equal((await stat(path.join(downloads, `${job.target}.part`))).size, SEGMENTED_TOTAL, "the part file keeps its full size");
    await queue.resume(job.id);
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed", 60_000);
    assert.equal(queue.list()[0].status, "completed", queue.list()[0].error ?? "");
    await assertContent(path.join(downloads, job.target), SEGMENTED_TOTAL);
  } finally {
    queue.stop(); server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a playlist is told apart from a file, whatever the segments are named", () => {
  // The addresses that prompted this: the extension sits after another one, and
  // a query string follows it.
  assert.equal(isPlaylist("https://cdn.example/media/1080.mp4.m3u8"), true);
  assert.equal(isPlaylist("https://cdn.example/a/index.M3U8?token=x"), true);
  assert.equal(isPlaylist("https://cdn.example/video-1080p.mp4"), false);
  assert.equal(isPlaylist("https://cdn.example/clip.vid"), false);
  // A path that merely mentions it is still a file.
  assert.equal(isPlaylist("https://cdn.example/m3u8/clip.mp4"), false);
  assert.equal(isPlaylist("not a url"), false);
});
