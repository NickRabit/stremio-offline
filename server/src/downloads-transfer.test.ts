import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { DownloadQueue, PROGRESS_SAVE_MS, type DownloadJob } from "./downloads.js";
import { MB, deferred, downloadLibrary, listen, queuedFile, send, tempQueue, waitFor } from "./downloads-test-support.js";

const GiB = 1024 ** 3;

const TOTAL = 120 * MB;

const DROP_AFTER = 51 * MB;

test("download progress checkpoints use the bounded interval", () => {
  assert.equal(PROGRESS_SAVE_MS, 30_000);
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

test("flushing persists queue state without stopping an active transfer", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const downloads = path.join(directory, "downloads");
  const library = downloadLibrary(downloads);
  const finish = deferred();
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": "2", "content-type": "video/mp4" });
    res.write(Buffer.from([1]));
    void finish.promise.then(() => res.end(Buffer.from([2])));
  });
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
    libraries: () => [library],
    defaultLibrary: () => library,
  });
  try {
    await queue.load();
    const added = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    await waitFor(queue, () => queue.transferring() && (queue.list()[0]?.received ?? 0) > 0);
    const internal = queue as unknown as {
      jobs: DownloadJob[];
      debridPersistencePending: Set<string>;
      flush(): Promise<void>;
    };
    internal.debridPersistencePending.add(added.id);
    const retryCount = queue.list()[0]!.retryCount;

    await internal.flush();

    assert.equal(queue.transferring(), true, "the transfer keeps running");
    assert.equal(queue.list()[0]!.retryCount, retryCount, "a clean flush does not spend a retry");
    const stored = JSON.parse(await readFile(path.join(directory, "data", "downloads.json"), "utf8")) as Array<{ received: number }>;
    assert.equal(stored[0]!.received, queue.list()[0]!.received, "the pending progress is on disk");
    finish.release();
    await waitFor(queue, () => queue.list()[0]?.status === "completed");
  } finally {
    finish.release();
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("freezing persistence suppresses a progress save", async (t) => {
  const { directory, queue } = await tempQueue({ ownerAllowed: () => false });
  try {
    await queue.add("Film", { url: "http://127.0.0.1:1/film.mp4" });
    await waitFor(queue, () => queue.list()[0]?.status === "paused");
    // A save still on its way from the pause would land on the sentinel under load; it has to
    // finish first, so only a save after the freeze is under test.
    await queue.flush();
    const file = path.join(directory, "data", "downloads.json");
    await writeFile(file, "sentinel");
    queue.freezePersistence();
    const internal = queue as unknown as {
      jobs: DownloadJob[];
      saveSoon(): void;
    };
    internal.jobs[0]!.received += 1024;
    internal.jobs[0]!.updatedAt = new Date().toISOString();
    t.mock.timers.enable({ apis: ["setTimeout"] });

    internal.saveSoon();
    t.mock.timers.tick(10_000);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(await readFile(file, "utf8"), "sentinel", "a progress save after shutdown is a no-op");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("after an outage and a resumed transfer the retry budget comes back", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const { server, port, drops } = await flakyServer();
  const downloads = path.join(directory, "downloads");
  const library = downloadLibrary(downloads);
  const manager = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
    libraries: () => [library],
    defaultLibrary: () => library,
  });
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
    assert.equal((await stat(queuedFile(downloads, job.target))).size, TOTAL);
  } finally {
    await manager.stop();
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
  const downloads = path.join(directory, "downloads");
  const library = downloadLibrary(downloads);
  const queue = new DownloadQueue(() => 4, () => perProvider, path.join(directory, "data"), downloads, {
    libraries: () => [library],
    defaultLibrary: () => library,
  });
  try {
    await queue.load();
    for (const name of ["Prvni", "Druhy", "Treti"]) await queue.add(name, { url: `http://127.0.0.1:${port}/${name}.mp4` });
    await waitFor(queue, () => queue.list().every((job) => job.status === "completed" || job.status === "failed"), 30_000);
    assert.deepEqual(queue.list().map((job) => job.status), ["completed", "completed", "completed"]);
    return peak();
  } finally {
    await queue.stop();
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

test("a queue reports a transfer only while one is running", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const { server, port } = await countingServer(MB);
  const downloads = path.join(directory, "downloads");
  const library = downloadLibrary(downloads);
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
    libraries: () => [library],
    defaultLibrary: () => library,
  });
  try {
    await queue.load();
    assert.equal(queue.transferring(), false, "nothing queued, nothing moving");
    await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    await waitFor(queue, () => queue.transferring());
    assert.equal(queue.transferring(), true, "a job in flight is a transfer");
    await waitFor(queue, () => queue.list()[0]?.status === "completed", 30_000);
    assert.equal(queue.transferring(), false, "a finished job is not");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
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
    await queue.stop();
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
    assert.equal((await stat(queuedFile(downloads, job.target))).size, size);
  } finally {
    await queue.stop();
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
    await queue.stop();
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
    await queue.stop();
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
    assert.equal((await stat(queuedFile(downloads, queue.list()[0].target))).size, size);
  } finally {
    await queue.stop();
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
    const body = await readFile(queuedFile(downloads, job.target));
    assert.equal(body.length, size);
    assert.ok(body.every((byte) => byte === 2), "the restarted payload must replace the partial, not follow it");
  } finally {
    await queue.stop();
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
    await queue.stop();
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
    await restored.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
