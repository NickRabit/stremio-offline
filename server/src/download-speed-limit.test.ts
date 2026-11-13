import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DownloadQueue } from "./downloads.js";
import { relativeWithin, type LibraryRecord } from "./libraries.js";

// The speed-limit tests measure real throughput over seconds of wall-clock time, so they live
// in a file of their own and run beside the rest of the queue suite instead of inside it.

process.env.ALLOW_PRIVATE_ADDONS = "1";

const MB = 1024 * 1024;
const LIBRARY_ID = "lib_d10ad10a";

const waitFor = async (queue: DownloadQueue, predicate: () => boolean, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout: ${JSON.stringify(queue.snapshot())}`);
};

const downloadLibrary = (root: string): LibraryRecord => ({
  id: LIBRARY_ID, name: "Downloads", type: "mixed", root, enabled: true, order: 0,
  addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: false,
});
const queuedFile = (downloads: string, target: string) => path.join(downloads, relativeWithin(LIBRARY_ID, target));

const tempQueue = async (hooks: ConstructorParameters<typeof DownloadQueue>[4] = {}) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const downloads = path.join(directory, "downloads");
  const library = downloadLibrary(downloads);
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
    retryDelay: () => 30,
    stallInitialMs: 5_000,
    stallTransferMs: 5_000,
    libraries: () => [library],
    defaultLibrary: () => library,
    ...hooks,
  });
  await queue.load();
  return { directory, queue, downloads };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const RATE_CHUNK = 64 * 1024;

const openQueue = async (concurrency: number, perProvider: number, hooks: ConstructorParameters<typeof DownloadQueue>[4] = {}) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const downloads = path.join(directory, "downloads");
  const library = downloadLibrary(downloads);
  const queue = new DownloadQueue(() => concurrency, () => perProvider, path.join(directory, "data"), downloads, {
    retryDelay: () => 30,
    stallInitialMs: 5_000,
    stallTransferMs: 5_000,
    libraries: () => [library],
    defaultLibrary: () => library,
    ...hooks,
  });
  await queue.load();
  return { directory, queue, downloads };
};

const receivedBytes = (queue: DownloadQueue) => queue.list().reduce((sum, job) => sum + job.received, 0);

const measureRate = async (queue: DownloadQueue, ms: number) => {
  const before = receivedBytes(queue);
  const started = performance.now();
  await sleep(ms);
  return (receivedBytes(queue) - before) / ((performance.now() - started) / 1000);
};

/** A local source that writes 64 KiB pieces and answers the one-byte range probe.
 *  `gateAfterFirst` holds the body after the first piece so a test can see it land
 *  before any further bytes exist to read. */
const pacedServer = (total: number, options: { gateAfterFirst?: boolean } = {}) => new Promise<{
  server: Server; port: number; peak: () => number; release: () => void;
}>((resolve) => {
  let inflight = 0;
  let peak = 0;
  let release = () => {};
  const gate = options.gateAfterFirst ? new Promise<void>((done) => { release = done; }) : null;
  const server = createServer((req, res) => {
    req.on("error", () => undefined);
    res.on("error", () => undefined);
    req.socket?.setNoDelay(true);
    const closed = new Promise<void>((done) => {
      req.once("close", done);
      res.once("close", done);
    });
    void (async () => {
      let counted = false;
      let holdOpen = false;
      try {
        const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
        if (match && match[1] === "0" && match[2] === "0") {
          res.writeHead(206, {
            "content-type": "video/mp4",
            "content-length": "1",
            "content-range": `bytes 0-0/${total}`,
          });
          res.end(Buffer.alloc(1));
          return;
        }
        const from = match ? Number(match[1]) : 0;
        const to = match?.[2] ? Number(match[2]) : total - 1;
        const length = Math.max(0, to - from + 1);
        if (match) {
          inflight += 1;
          peak = Math.max(peak, inflight);
          counted = true;
          res.writeHead(206, {
            "content-type": "video/mp4",
            "content-length": String(length),
            "content-range": `bytes ${from}-${to}/${total}`,
          });
        } else {
          res.writeHead(200, { "content-type": "video/mp4", "content-length": String(total) });
        }
        const piece = Buffer.alloc(RATE_CHUNK);
        let sent = 0;
        let pieces = 0;
        while (sent < length && !res.destroyed) {
          const size = Math.min(RATE_CHUNK, length - sent);
          const ok = res.write(size === piece.length ? piece : piece.subarray(0, size));
          sent += size;
          pieces += 1;
          if (!ok && !res.destroyed) {
            await new Promise<void>((done) => {
              const finish = () => {
                res.off("drain", finish);
                res.off("close", finish);
                res.off("error", finish);
                done();
              };
              res.once("drain", finish);
              res.once("close", finish);
              res.once("error", finish);
            });
          }
          if (gate && pieces === 1) {
            await gate;
            if (!res.destroyed && sent < length) {
              const extra = Math.min(RATE_CHUNK, length - sent);
              res.write(extra === piece.length ? piece : piece.subarray(0, extra));
            }
            holdOpen = true;
            await closed;
            break;
          }
        }
        if (!holdOpen && !res.destroyed && !res.writableEnded) res.end();
      } finally {
        if (counted) inflight -= 1;
      }
    })().catch(() => undefined);
  });
  server.listen(0, "127.0.0.1", () => resolve({
    server,
    port: (server.address() as { port: number }).port,
    peak: () => peak,
    release: () => release(),
  }));
});

const assertNear = (rate: number, expected: number) => {
  assert.ok(rate >= expected * 0.75 && rate <= expected * 1.25, `rate ${Math.round(rate)} bytes/s, expected ${expected}`);
};

test("two transfers share one speed limit", async () => {
  const total = 16 * MB;
  const { directory, queue } = await openQueue(2, 2, { speedLimit: () => 1_000_000 });
  const { server, port } = await pacedServer(total);
  try {
    await queue.add("One", { url: `http://127.0.0.1:${port}/one.mkv` });
    await queue.add("Two", { url: `http://127.0.0.1:${port}/two.mkv` });
    await waitFor(queue, () => queue.list().filter((job) => job.status === "downloading" && job.received > 0).length === 2);
    await sleep(1000);
    const rate = await measureRate(queue, 3000);
    assertNear(rate, 1_000_000);
    assert.ok(queue.list().every((job) => job.received > 0));
    assert.ok(queue.list().every((job) => job.status === "downloading"));
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a segmented transfer is limited as one budget", async () => {
  const total = 64 * MB;
  const { directory, queue } = await openQueue(1, 1, { segments: () => 4, speedLimit: () => 1_000_000 });
  const { server, port, peak } = await pacedServer(total);
  try {
    await queue.add("Segmented", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => {
      const job = queue.list()[0];
      return job?.status === "downloading" && job.segments === 4 && job.received > 0;
    });
    await sleep(1000);
    const rate = await measureRate(queue, 3000);
    assert.equal(queue.list()[0]?.segments, 4);
    assert.equal(peak(), 4, "all four segments should have run at once");
    assertNear(rate, 1_000_000);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("raising the speed limit speeds up a running transfer", async () => {
  let limit = 1_000_000;
  const { directory, queue } = await openQueue(1, 1, { speedLimit: () => limit });
  const { server, port } = await pacedServer(48 * MB);
  try {
    const added = await queue.add("Live", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.list()[0]?.status === "downloading" && queue.list()[0]!.received > 0);
    const startedAt = queue.list()[0]!.startedAt;
    await sleep(1000);
    const low = await measureRate(queue, 1000);
    limit = 10_000_000;
    const high = await measureRate(queue, 2000);
    const after = queue.list()[0]!;
    assert.ok(low > 0, `the limited window moved nothing (${low})`);
    assert.ok(high > 4_000_000, `raised rate ${Math.round(high)}`);
    assert.ok(high > low * 2, `low ${Math.round(low)} high ${Math.round(high)}`);
    assert.equal(after.startedAt, startedAt);
    assert.equal(after.retryCount ?? 0, 0);
    assert.equal(after.status, "downloading");
    assert.equal(after.id, added.id);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pausing a throttled transfer aborts the wait and keeps the offset", async () => {
  const { directory, queue, downloads } = await tempQueue({ speedLimit: () => 1_000 });
  const { server, port, release } = await pacedServer(8 * MB, { gateAfterFirst: true });
  try {
    const added = await queue.add("Hold", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => (queue.list()[0]?.received ?? 0) >= RATE_CHUNK);
    release();
    await sleep(400);
    const held = queue.list()[0]!;
    assert.equal(held.status, "downloading");
    const received = held.received;
    await sleep(300);
    assert.equal(queue.list()[0]!.received, received, "the limiter is holding the next chunk");
    const started = performance.now();
    await queue.pause(added.id);
    assert.ok(performance.now() - started < 1000, `pause took ${Math.round(performance.now() - started)} ms`);
    const paused = queue.list()[0]!;
    assert.equal(paused.status, "paused");
    assert.equal(paused.pauseReason, "user");
    assert.ok(paused.received > 0);
    assert.equal(paused.retryCount ?? 0, 0);
    const size = statSync(`${queuedFile(downloads, paused.target)}.part`).size;
    assert.ok(size > 0, "the bytes already taken stay on disk");
    assert.ok(size <= paused.received);
    assert.equal(queue.transferring(), false);
    await sleep(200);
    assert.equal(queue.list()[0]!.status, "paused");
    assert.equal(queue.list()[0]!.received, paused.received);
  } finally {
    release();
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

