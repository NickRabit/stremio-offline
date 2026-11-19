import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DownloadQueue } from "./downloads.js";
import type { DebridAdvance } from "./debrid.js";
import { defaultDownloadSettings } from "./naming.js";
import { torrentKey } from "./download-selection.js";
import { HASH, LIBRARY_ID, downloadLibrary, listen, queuedFile, tempQueue, waitFor } from "./downloads-test-support.js";

test("a restored waiting job with a revoked owner makes no Real-Debrid request", async () => {
  let advances = 0;
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const data = path.join(directory, "data");
  const downloads = path.join(directory, "downloads");
  await mkdir(data, { recursive: true });
  await writeFile(path.join(data, "downloads.json"), JSON.stringify([{
    id: "revoked-wait", title: "Film", stream: { infoHash: HASH, fileIdx: 0 },
    status: "waiting", target: `${LIBRARY_ID}/Film/Film.mkv`, received: 0, speed: 0,
    debrid: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }]));
  const library = downloadLibrary(downloads);
  const queue = new DownloadQueue(() => 1, () => 1, data, downloads, {
    libraries: () => [library], defaultLibrary: () => library,
    ownerAllowed: () => false,
    debridPollMs: 0,
    debrid: {
      configured: () => true,
      advance: async () => { advances += 1; return { ready: false, torrentId: "rd1", status: "downloading" }; },
    },
  });
  try {
    await queue.load();
    await waitFor(queue, () => queue.list()[0]?.status === "paused");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(advances, 0, "a restored waiting job must not reach Real-Debrid after revocation");
    assert.equal(queue.list()[0].pauseReason, "permission");
    assert.equal(queue.list()[0].retryCount, undefined, "permission refusal does not spend a retry");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("revocation while a Real-Debrid advance is pending discards its ready result", async () => {
  let allowed = true;
  let advances = 0;
  let requests = 0;
  let started!: () => void;
  let finish!: (result: DebridAdvance) => void;
  const advanceStarted = new Promise<void>((resolve) => { started = resolve; });
  const pending = new Promise<DebridAdvance>((resolve) => { finish = resolve; });
  const { server, port } = await listen((_req, res) => {
    requests += 1;
    res.writeHead(200, { "content-length": "1" });
    res.end(Buffer.from([1]));
  });
  const { directory, queue } = await tempQueue({
    ownerAllowed: () => allowed,
    debridPollMs: 0,
    debrid: {
      configured: () => true,
      advance: async () => {
        advances += 1;
        started();
        return pending;
      },
    },
  });
  try {
    await queue.add("Film", { infoHash: HASH, fileIdx: 0 });
    await advanceStarted;
    allowed = false;
    finish({ ready: true, torrentId: "rd1", url: `http://127.0.0.1:${port}/film.mp4`, filename: "Film.mkv" });
    await waitFor(queue, () => queue.list()[0]?.status === "paused");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(advances, 1, "the discarded result must not schedule another advance");
    assert.equal(requests, 0, "the ready link must not start an HTTP download");
    assert.equal(queue.list()[0].pauseReason, "permission");
    assert.equal(queue.list()[0].debridProgress, undefined, "the returned result is not applied");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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
    assert.equal((await stat(queuedFile(downloads, torrent.target))).size, payload.length);
    assert.ok(calls >= 2);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("a torrent downloaded on its first status read is remembered", async () => {
  const payload = Buffer.alloc(16 * 1024, 7);
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(payload.length), "content-type": "video/mp4" });
    res.end(payload);
  });
  const remembered: string[] = [];
  const { directory, queue } = await tempQueue({
    rememberDebridReady: (infoHash) => { remembered.push(infoHash); },
    debrid: {
      configured: () => true,
      advance: async (input) => {
        await input.onFirstStatus?.("downloaded");
        return {
          ready: true,
          torrentId: "rd1",
          url: `http://127.0.0.1:${port}/movie.mp4`,
          filename: "Movie.mkv",
        };
      },
    },
  });
  try {
    await queue.add("Film", { infoHash: HASH, fileIdx: 0 });
    await waitFor(queue, () => queue.list()[0]?.status === "completed");
    assert.deepEqual(remembered, [HASH]);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a torrent that reported downloading is not remembered when it later becomes ready", async () => {
  const payload = Buffer.alloc(16 * 1024, 8);
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(payload.length), "content-type": "video/mp4" });
    res.end(payload);
  });
  const remembered: string[] = [];
  let ready = false;
  const { directory, queue } = await tempQueue({
    debridPollMs: 20,
    rememberDebridReady: (infoHash) => { remembered.push(infoHash); },
    debrid: {
      configured: () => true,
      advance: async (input) => {
        await input.onFirstStatus?.(ready ? "downloaded" : "downloading");
        return ready
          ? {
            ready: true,
            torrentId: "rd1",
            url: `http://127.0.0.1:${port}/movie.mp4`,
            filename: "Movie.mkv",
          }
          : { ready: false, torrentId: "rd1", progress: 10, status: "downloading" };
      },
    },
  });
  try {
    await queue.add("Film", { infoHash: HASH, fileIdx: 0 });
    await waitFor(queue, () => queue.get(queue.list()[0]!.id)?.debridProgress === 10);
    ready = true;
    await waitFor(queue, () => queue.list()[0]?.status === "completed");
    assert.deepEqual(remembered, []);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
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
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a new Real-Debrid torrent id is durable before a stopped queue can lose its timer", async () => {
  const { directory, queue } = await tempQueue({
    debridPollMs: 60_000,
    debrid: {
      configured: () => true,
      advance: async () => ({ ready: false, torrentId: "rd1", progress: 10, status: "downloading" }),
    },
  });
  try {
    await queue.add("Film", { infoHash: HASH, fileIdx: 0 });
    await waitFor(queue, () => queue.list()[0]?.debridProgress === 10);
    await queue.stop();
    const stored = JSON.parse(await readFile(path.join(directory, "data", "downloads.json"), "utf8")) as Array<{ debrid?: { torrentId?: string } }>;
    assert.equal(stored[0]?.debrid?.torrentId, "rd1", "the next poll must reuse the torrent instead of adding its magnet again");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed first Real-Debrid write retries without failing the waiting job", async () => {
  let fail = false;
  let calls = 0;
  const torrentIds: Array<string | undefined> = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const { directory, queue } = await tempQueue({
    debridPollMs: 20,
    debridRetryMs: 20,
    debrid: {
      configured: () => true,
      advance: async ({ torrentId }) => {
        calls += 1;
        torrentIds.push(torrentId);
        if (calls === 1) await held;
        return { ready: false, torrentId: "rd1", progress: 10, status: "downloading" };
      },
    },
    writeState: async (file, data) => {
      if (fail) throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      await writeFile(file, data);
    },
  });
  try {
    await queue.add("Film", { infoHash: HASH, fileIdx: 0 });
    fail = true;
    release();
    await waitFor(queue, () => calls === 1 && queue.get(queue.list()[0]!.id)?.debridProgress === 10);
    assert.equal(queue.get(queue.list()[0]!.id)?.status, "waiting");
    assert.equal(torrentIds[0], undefined);

    fail = false;
    let stored: Array<{ debrid?: { torrentId?: string } }> = [];
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      stored = JSON.parse(await readFile(path.join(directory, "data", "downloads.json"), "utf8"));
      if (stored[0]?.debrid?.torrentId === "rd1") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(stored[0]?.debrid?.torrentId, "rd1");
    assert.equal(torrentIds[1], "rd1", "the retry reuses the in-memory id instead of adding the magnet again");
    assert.equal(queue.get(queue.list()[0]!.id)?.status, "waiting");
  } finally {
    release();
    await queue.stop();
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
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a torrent without a token is refused", async () => {
  const { directory, queue } = await tempQueue();
  try {
    await assert.rejects(queue.add("Film", { infoHash: HASH }), /Real-Debrid/);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a lazy job falls back to a torrent and downloads it through Real-Debrid", async () => {
  const payload = Buffer.alloc(16 * 1024, 3);
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(payload.length), "content-type": "video/mp4" });
    res.end(payload);
  });
  let ready = false;
  const { directory, queue, downloads } = await tempQueue({
    debridPollMs: 20,
    debrid: {
      configured: () => true,
      advance: async () => ready
        ? { ready: true, torrentId: "rd1", url: `http://127.0.0.1:${port}/movie.mp4`, filename: "Film.mkv" }
        : { ready: false, torrentId: "rd1", progress: 10, status: "downloading" },
    },
  });
  queue.setResolver(async () => ({ stream: { infoHash: HASH, fileIdx: 0, title: "Film 1080p" }, settings: defaultDownloadSettings() }));
  try {
    await queue.addPending("Film", { type: "movie", videoId: "tt9" }, { kind: "movie", title: "Film" });
    await waitFor(queue, () => (queue.list()[0]?.debridProgress ?? 0) > 0, 30_000);
    assert.equal(queue.list()[0].status, "waiting", "the torrent waits for Real-Debrid before any transfer");
    ready = true;
    await waitFor(queue, () => queue.list()[0]?.status === "completed", 30_000);
    const job = queue.list()[0];
    assert.equal(job.status, "completed");
    assert.equal(job.debridProgress, 100);
    assert.equal((await stat(queuedFile(downloads, job.target))).size, payload.length);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failing torrent on a lazy job tries the next source and finally fails", async () => {
  const first = { infoHash: HASH, fileIdx: 0, title: "Show CZ" };
  const second = { infoHash: "1111111111111111111111111111111111111111", fileIdx: 0, title: "Show CZ" };
  let calls = 0;
  const { directory, queue } = await tempQueue({
    debridPollMs: 20,
    debrid: { configured: () => true, advance: async () => { calls += 1; throw new Error("Real-Debrid refused this torrent."); } },
  });
  queue.setResolver(async ({ tried }) => {
    const next = [first, second].find((stream) => !tried.includes(torrentKey(stream)));
    return next ? { stream: next, settings: defaultDownloadSettings() } : undefined;
  });
  try {
    await queue.addPending("Show", { type: "series", videoId: "tt1" }, { kind: "episode", title: "Show", season: 1, episode: 1 });
    await waitFor(queue, () => queue.list()[0]?.status === "failed", 30_000);
    const job = queue.list()[0];
    assert.equal(job.status, "failed");
    assert.equal(job.errorKey, "err.noMatchingSource");
    assert.equal(calls, 2, "both torrents were handed to Real-Debrid before the job gave up");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Real-Debrid link that fails over HTTP rules its torrent out, not only its address", async () => {
  const { server, port } = await listen((_req, res) => { res.writeHead(404); res.end(); });
  const first = { infoHash: HASH, fileIdx: 0, title: "Show CZ" };
  const second = { infoHash: "1111111111111111111111111111111111111111", fileIdx: 0, title: "Show CZ" };
  const handed: string[] = [];
  const { directory, queue } = await tempQueue({
    debridPollMs: 20,
    debrid: { configured: () => true, advance: async ({ infoHash }) => {
      handed.push(infoHash);
      return { ready: true, torrentId: `rd-${handed.length}`, url: `http://127.0.0.1:${port}/gone-${handed.length}.mkv`, filename: "Show.S01E01.mkv" };
    } },
  });
  queue.setResolver(async ({ tried }) => {
    const next = [first, second].find((stream) => !tried.includes(torrentKey(stream)));
    return next ? { stream: next, settings: defaultDownloadSettings() } : undefined;
  });
  try {
    await queue.addPending("Show", { type: "series", videoId: "tt1" }, { kind: "episode", title: "Show", season: 1, episode: 1 });
    await waitFor(queue, () => queue.list()[0]?.status === "failed", 30_000);
    assert.equal(queue.list()[0].errorKey, "err.noMatchingSource");
    assert.deepEqual(handed, [first.infoHash, second.infoHash], "each torrent is tried once, then the job gives up");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the Real-Debrid timeout counts from debridStartedAt rather than createdAt", async () => {
  const payload = Buffer.alloc(8 * 1024, 5);
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(payload.length), "content-type": "video/mp4" });
    res.end(payload);
  });
  const longAgo = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  const waiting = (debridStartedAt?: string) => [{
    id: "rd-timeout", title: "Film", status: "waiting", target: "Film/Film.mkv", received: 0, speed: 0,
    stream: { infoHash: HASH, fileIdx: 0 }, media: { kind: "movie", title: "Film" },
    debrid: {}, createdAt: longAgo, updatedAt: longAgo, ...(debridStartedAt ? { debridStartedAt } : {}),
  }];
  const boot = async (seeded: unknown[]) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
    const downloads = path.join(directory, "downloads");
    const data = path.join(directory, "data");
    await mkdir(data, { recursive: true });
    await writeFile(path.join(data, "downloads.json"), JSON.stringify(seeded));
    const queue = new DownloadQueue(() => 1, () => 1, data, downloads, {
      libraries: () => [downloadLibrary(downloads)], defaultLibrary: () => downloadLibrary(downloads),
      debridPollMs: 20, debridTimeoutMs: 3_600_000,
      debrid: { configured: () => true, advance: async () => ({ ready: true, torrentId: "rd1", url: `http://127.0.0.1:${port}/movie.mp4`, filename: "Film.mkv" }) },
    });
    await queue.load();
    return { directory, queue, downloads };
  };
  try {
    const fresh = await boot(waiting(new Date().toISOString()));
    try {
      await waitFor(fresh.queue, () => fresh.queue.list()[0]?.status === "completed", 30_000);
      assert.equal(fresh.queue.list()[0].status, "completed", "a recent debridStartedAt keeps a job whose createdAt is old");
      assert.equal((await stat(path.join(fresh.downloads, "Film", "Film.mkv"))).size, payload.length);
    } finally {
      await fresh.queue.stop();
      await rm(fresh.directory, { recursive: true, force: true });
    }
    const stale = await boot(waiting());
    try {
      await waitFor(stale.queue, () => stale.queue.list()[0]?.status === "failed", 30_000);
      assert.equal(stale.queue.list()[0].errorKey, "err.debridTimeout", "without debridStartedAt the old createdAt times it out");
    } finally {
      await stale.queue.stop();
      await rm(stale.directory, { recursive: true, force: true });
    }
  } finally {
    server.close();
  }
});

test("a manual torrent job still fails when Real-Debrid refuses it", async () => {
  const { directory, queue } = await tempQueue({
    debridPollMs: 20,
    debrid: { configured: () => true, advance: async () => { throw new Error("Real-Debrid refused this torrent."); } },
  });
  try {
    await queue.add("Film", { infoHash: HASH, fileIdx: 0 });
    await waitFor(queue, () => queue.list()[0]?.status === "failed", 30_000);
    const job = queue.list()[0];
    assert.equal(job.status, "failed");
    assert.match(job.error ?? "", /refused/);
    assert.equal(queue.list().length, 1, "a manual torrent is not turned back into a pending lazy job");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a season pack file that names another episode is rejected", async () => {
  const payload = Buffer.alloc(4 * 1024, 4);
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(payload.length), "content-type": "video/mp4" });
    res.end(payload);
  });
  const first = { infoHash: HASH, fileIdx: 3, title: "Show CZ" };
  const second = { infoHash: "2222222222222222222222222222222222222222", fileIdx: 4, title: "Show CZ" };
  const filenames = ["Show.S01E05.mkv", "Show.S01E02.mkv"];
  let calls = 0;
  const { directory, queue, downloads } = await tempQueue({
    debridPollMs: 20,
    debrid: {
      configured: () => true,
      advance: async () => {
        const filename = filenames[calls];
        calls += 1;
        return { ready: true, torrentId: "rd1", url: `http://127.0.0.1:${port}/show.mp4`, filename };
      },
    },
  });
  queue.setResolver(async ({ tried }) => {
    const next = [first, second].find((stream) => !tried.includes(torrentKey(stream)));
    return next ? { stream: next, settings: defaultDownloadSettings() } : undefined;
  });
  try {
    await queue.addPending("Show", { type: "series", videoId: "tt1:1:2" }, { kind: "episode", title: "Show", season: 1, episode: 2 });
    await waitFor(queue, () => queue.list()[0]?.status === "completed", 30_000);
    const job = queue.list()[0];
    assert.equal(calls, 2, "the wrong episode is rejected before its link is downloaded");
    assert.equal((await stat(queuedFile(downloads, job.target))).size, payload.length);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a lazy torrent job that is waiting resumes polling after a restart", async () => {
  const payload = Buffer.alloc(8 * 1024, 9);
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(payload.length), "content-type": "video/mp4" });
    res.end(payload);
  });
  let ready = false;
  let directory = "";
  let downloads = "";
  const boot = async () => {
    const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
      libraries: () => [downloadLibrary(downloads)], defaultLibrary: () => downloadLibrary(downloads),
      ownerAllowed: () => true,
      debridPollMs: 20,
      debrid: {
        configured: () => true,
        advance: async () => ready
          ? { ready: true, torrentId: "rd1", url: `http://127.0.0.1:${port}/show.mp4`, filename: "Show.S01E01.mkv" }
          : { ready: false, torrentId: "rd1", progress: 5, status: "downloading" },
      },
    });
    await queue.load();
    return queue;
  };
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
    downloads = path.join(directory, "downloads");
    const first = await boot();
    first.setResolver(async () => ({ stream: { infoHash: HASH, fileIdx: 0, title: "Show CZ" }, settings: defaultDownloadSettings() }));
    await first.addPending("Show", { type: "series", videoId: "tt1:1:1" }, { kind: "episode", title: "Show", season: 1, episode: 1 });
    await waitFor(first, () => first.list()[0]?.status === "waiting", 30_000);
    await first.stop();
    const reopened = await boot();
    try {
      await waitFor(reopened, () => reopened.list()[0]?.status === "waiting", 5_000);
      ready = true;
      await waitFor(reopened, () => reopened.list()[0]?.status === "completed", 30_000);
      const job = reopened.list()[0];
      assert.equal(job.status, "completed");
      assert.equal((await stat(queuedFile(downloads, job.target))).size, payload.length);
    } finally {
      await reopened.stop();
    }
  } finally {
    server.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

test("stopping the queue drains an in-flight debrid poll and persists its handle", async () => {
  let polling = false;
  let finish!: (result: DebridAdvance) => void;
  const pending = new Promise<DebridAdvance>((resolve) => { finish = resolve; });
  const { directory, queue } = await tempQueue({
    debrid: { configured: () => true, advance: () => { polling = true; return pending; } },
  });
  try {
    await queue.add("Film", { infoHash: HASH, fileIdx: 0 });
    await waitFor(queue, () => polling);
    let stopped = false;
    const stopping = queue.stop().then(() => { stopped = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    finish({ ready: false, torrentId: "in-flight", status: "downloading" });
    await stopping;
    const jobs = JSON.parse(await readFile(path.join(directory, "data", "downloads.json"), "utf8"));
    assert.equal(jobs[0].debrid.torrentId, "in-flight");
  } finally {
    finish({ ready: false, torrentId: "in-flight", status: "downloading" });
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
