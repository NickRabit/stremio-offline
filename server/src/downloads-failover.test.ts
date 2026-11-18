import assert from "node:assert/strict";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DownloadQueue, type DownloadJob } from "./downloads.js";
import { AppError } from "./errors.js";
import { defaultDownloadSettings } from "./naming.js";
import { deferred, downloadLibrary, listen, queueAdmission, queuedFile, send, tempQueue, waitFor } from "./downloads-test-support.js";

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
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a legacy lazy source stays selected when its partial cleanup is denied", async () => {
  const payload = Buffer.from(Array.from({ length: 8192 }, (_unused, index) => index % 251));
  const partialSize = 2048;
  const firstBody = deferred();
  let videoRequests = 0;
  let nextSourceHits = 0;
  const { server, port } = await listen(async (req, res) => {
    if (req.url === "/subtitle.srt") {
      res.writeHead(200, { "content-type": "application/x-subrip" });
      res.end("1\n00:00:01,000 --> 00:00:02,000\nSubtitle\n");
      return;
    }
    if (req.url === "/next.mp4") {
      nextSourceHits += 1;
      res.writeHead(200, { "content-length": String(payload.length), "content-type": "video/mp4" });
      res.end(payload);
      return;
    }
    videoRequests += 1;
    if (videoRequests === 1) {
      res.writeHead(200, { "content-length": String(payload.length), "content-type": "video/mp4" });
      res.write(payload.subarray(0, partialSize));
      await firstBody.promise;
      req.socket.destroy();
      return;
    }
    if (!cleanupRepaired) {
      res.writeHead(404);
      res.end();
      return;
    }
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    assert.ok(range, "the repaired retry must resume at the existing partial");
    const offset = Number(range![1]);
    res.writeHead(206, {
      "content-length": String(payload.length - offset),
      "content-range": `bytes ${offset}-${payload.length - 1}/${payload.length}`,
      "content-type": "video/mp4",
    });
    res.end(payload.subarray(offset));
  });
  let cleanupRepaired = false;
  const cleanupAttempts: string[] = [];
  const { directory, queue, downloads } = await tempQueue({
    retryDelay: () => 30,
    unlinkFile: async (file) => {
      cleanupAttempts.push(file);
      if (!cleanupRepaired) throw Object.assign(new Error(`EACCES: ${file}`), { code: "EACCES" });
      await unlink(file);
    },
  });
  let resolverCalls = 0;
  const sourceA = `http://127.0.0.1:${port}/source.mp4`;
  const sourceB = `http://127.0.0.1:${port}/next.mp4`;
  queue.setResolver(async () => {
    resolverCalls += 1;
    return {
      stream: { url: resolverCalls === 1 ? sourceA : sourceB },
      subtitle: { url: `http://127.0.0.1:${port}/subtitle.srt`, lang: "cs" },
      resolution: {
        checkedCandidates: 1, audioLanguage: "en", subtitleLanguage: "cs",
        subtitleSource: "addon", subtitleStatus: "ready",
      },
      settings: defaultDownloadSettings(),
    };
  });
  try {
    await queue.addPending("Film", { type: "movie", videoId: "tt-cleanup" }, { kind: "movie", title: "Film" });
    const internal = queue as unknown as { jobs: DownloadJob[]; active: Map<string, AbortController> };
    const job = internal.jobs[0]!;
    await waitFor(queue, () => {
      if (!job.target) return false;
      const video = queuedFile(downloads, `${job.target}.part`);
      const subtitle = path.join(
        path.dirname(queuedFile(downloads, job.target)),
        `${path.basename(job.target, path.extname(job.target))}.cs.vtt.part`,
      );
      return existsSync(video) && statSync(video).size === partialSize && existsSync(subtitle);
    });
    const originalTarget = job.target;
    const originalFile = queuedFile(downloads, originalTarget);
    const videoPart = `${originalFile}.part`;
    const subtitlePart = path.join(
      path.dirname(originalFile),
      `${path.basename(originalFile, path.extname(originalFile))}.cs.vtt.part`,
    );
    await writeFile(originalFile, "foreign destination");
    firstBody.release();

    await waitFor(queue, () => queue.list()[0]?.status === "failed" || queue.list()[0]?.status === "completed");
    await waitFor(queue, () => !internal.active.has(job.id));
    await queue.flush();
    const failed = queue.list()[0]!;
    assert.equal(failed.status, "failed", "the source cannot be abandoned while its partials remain");
    assert.equal(failed.errorKey, "err.downloadCleanupFailed");
    assert.equal(failed.error, "Could not remove the previous download's temporary files. Check storage access and retry.");
    assert.doesNotMatch(failed.error ?? "", /http|\/tmp|\.part|EACCES/);
    assert.deepEqual(cleanupAttempts, [videoPart, subtitlePart], "both partials are attempted");
    assert.equal(resolverCalls, 1, "no fallback resolver runs after cleanup fails");
    assert.equal(nextSourceHits, 0);
    assert.equal(job.target, originalTarget);
    assert.equal(job.stream?.url, sourceA);
    assert.equal(job.subtitle?.url, `http://127.0.0.1:${port}/subtitle.srt`);
    assert.deepEqual(job.source?.tried, []);
    assert.equal(job.received, partialSize);
    assert.equal(job.total, payload.length);
    assert.equal(job.retryCount, 1);
    assert.equal(existsSync(videoPart), true);
    assert.equal(existsSync(subtitlePart), true);

    const stored = JSON.parse(await readFile(path.join(directory, "data", "downloads.json"), "utf8")) as DownloadJob[];
    const persisted = stored.find((item) => item.id === job.id)!;
    assert.equal(persisted.status, "failed");
    assert.equal(persisted.errorKey, "err.downloadCleanupFailed");
    assert.equal(persisted.target, originalTarget);
    assert.equal(persisted.stream?.url, sourceA);
    assert.deepEqual(persisted.source?.tried, []);
    assert.equal(persisted.received, partialSize);
    assert.equal(persisted.total, payload.length);

    cleanupRepaired = true;
    await queue.retry(job.id);
    await waitFor(queue, () => queue.list()[0]?.status === "completed" || queue.list()[0]?.status === "failed");
    const completed = queue.list()[0]!;
    assert.equal(completed.status, "completed", completed.error);
    assert.match(completed.target, /Film \(2\)\.mp4$/);
    assert.equal(await readFile(originalFile, "utf8"), "foreign destination");
    assert.deepEqual(await readFile(queuedFile(downloads, completed.target)), payload);
    assert.equal(resolverCalls, 1, "manual retry resumes the retained source");
    assert.equal(nextSourceHits, 0);
  } finally {
    firstBody.release();
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a subtitle-only cleanup failure prevents legacy source failover", async () => {
  let resolverCalls = 0;
  const cleanupAttempts: string[] = [];
  const { server, port } = await listen((req, res) => {
    if (req.url === "/subtitle.srt") {
      res.writeHead(200, { "content-type": "application/x-subrip" });
      res.end("1\n00:00:01,000 --> 00:00:02,000\nSubtitle\n");
    } else {
      res.writeHead(404); res.end();
    }
  });
  const { directory, queue, downloads } = await tempQueue({
    unlinkFile: async (file) => {
      cleanupAttempts.push(file);
      if (file.endsWith(".vtt.part")) throw Object.assign(new Error("denied"), { code: "EACCES" });
      await unlink(file);
    },
  });
  queue.setResolver(async () => {
    resolverCalls += 1;
    return {
      stream: { url: `http://127.0.0.1:${port}/missing.mp4` },
      subtitle: { url: `http://127.0.0.1:${port}/subtitle.srt`, lang: "cs" },
      resolution: { checkedCandidates: 1, audioLanguage: "en", subtitleLanguage: "cs", subtitleSource: "addon", subtitleStatus: "ready" },
      settings: defaultDownloadSettings(),
    };
  });
  try {
    await queue.addPending("Subtitle", { type: "movie", videoId: "tt-subtitle-cleanup" });
    await waitFor(queue, () => queue.list()[0]?.status === "failed");
    const job = queue.list()[0]!;
    assert.equal(job.errorKey, "err.downloadCleanupFailed");
    assert.equal(resolverCalls, 1);
    assert.equal(cleanupAttempts.length, 2);
    assert.equal(existsSync(queuedFile(downloads, `${job.target}.part`)), false);
    assert.equal(existsSync(cleanupAttempts[1]), true);
  } finally {
    await queue.stop(); server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy lazy failover treats missing partials as already cleaned up", async () => {
  const release404 = deferred();
  let resolverCalls = 0;
  const enoentCalls: string[] = [];
  const { server, port } = await listen(async (req, res) => {
    if (req.url === "/subtitle.srt") {
      res.writeHead(200, { "content-type": "application/x-subrip" });
      res.end("1\n00:00:01,000 --> 00:00:02,000\nSubtitle\n");
      return;
    }
    if (req.url === "/first.mp4") {
      await release404.promise;
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-length": "64", "content-type": "video/mp4" });
    res.end(Buffer.alloc(64, 7));
  });
  const { directory, queue, downloads } = await tempQueue({
    retryDelay: () => 30,
    unlinkFile: async (file) => {
      try {
        await unlink(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") enoentCalls.push(file);
        throw error;
      }
    },
  });
  queue.setResolver(async () => {
    resolverCalls += 1;
    return {
      stream: { url: `http://127.0.0.1:${port}/${resolverCalls === 1 ? "first" : "second"}.mp4` },
      subtitle: { url: `http://127.0.0.1:${port}/subtitle.srt`, lang: "cs" },
      resolution: {
        checkedCandidates: 1, audioLanguage: "en", subtitleLanguage: "cs",
        subtitleSource: "addon", subtitleStatus: "ready",
      },
      settings: defaultDownloadSettings(),
    };
  });
  try {
    await queue.addPending("Missing", { type: "movie", videoId: "tt-missing" }, { kind: "movie", title: "Missing" });
    const internal = queue as unknown as { jobs: DownloadJob[] };
    const job = internal.jobs[0]!;
    let subtitlePart = "";
    await waitFor(queue, () => {
      if (!job.target) return false;
      const target = queuedFile(downloads, job.target);
      subtitlePart = path.join(
        path.dirname(target),
        `${path.basename(target, path.extname(target))}.cs.vtt.part`,
      );
      return existsSync(subtitlePart);
    });
    await unlink(subtitlePart);
    release404.release();
    await waitFor(queue, () => queue.list()[0]?.status === "completed" || queue.list()[0]?.status === "failed");
    const completed = queue.list()[0]!;
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(resolverCalls, 2, "ENOENT lets failover continue");
    assert.deepEqual(new Set(enoentCalls), new Set([
      queuedFile(downloads, `${job.target}.part`),
      subtitlePart,
    ]));
  } finally {
    release404.release();
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a profile source stays selected when its partial cleanup is denied", { skip: process.platform === "win32" }, async () => {
  const payload = Buffer.from(Array.from({ length: 8192 }, (_unused, index) => index % 251));
  const partialSize = 2048;
  const firstBody = deferred();
  const nextBody = deferred();
  let resolverCalls = 0;
  let nextSourceHits = 0;
  const { server, port } = await listen(async (req, res) => {
    if (req.url === "/next.mp4") {
      nextSourceHits += 1;
      await nextBody.promise;
      res.writeHead(200, { "content-length": String(payload.length), "content-type": "video/mp4" });
      res.end(payload);
      return;
    }
    res.writeHead(200, { "content-length": String(payload.length), "content-type": "video/mp4" });
    res.write(payload.subarray(0, partialSize));
    await firstBody.promise;
    req.socket.destroy();
  });
  const { directory, queue, downloads } = await tempQueue({ retryDelay: () => 30 });
  const sourceA = `http://127.0.0.1:${port}/source.mp4`;
  const sourceB = `http://127.0.0.1:${port}/next.mp4`;
  queue.setProviderPriorityResolver(async () => {
    resolverCalls += 1;
    return {
      status: "selected",
      stream: { url: resolverCalls === 1 ? sourceA : sourceB, addonKey: "addon:http-only" },
      resolution: { checkedCandidates: 1, audioLanguage: "en" },
      settings: defaultDownloadSettings(),
      streamAddonIdentity: "a".repeat(64),
      searchStatus: "complete",
    };
  });
  let lockedDirectory: string | undefined;
  let originalMode = 0o755;
  try {
    const selection = {
      addonKeys: ["addon:http-only"],
      sourceStrategy: "priority" as const,
      audioLanguage: "en",
      audioMode: "preferred" as const,
      subtitleMode: "off" as const,
      targetSettings: defaultDownloadSettings().movie,
    };
    const queued = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-profile-cleanup", selection },
      { kind: "movie", title: "Film", id: "tt-profile-cleanup" },
      "usr_00000001",
      undefined,
      queueAdmission(),
    );
    assert.ok(queued);
    const internal = queue as unknown as { jobs: DownloadJob[]; active: Map<string, AbortController> };
    const job = internal.jobs[0]!;
    await waitFor(queue, () => {
      if (!job.target) return false;
      const partial = queuedFile(downloads, `${job.target}.part`);
      return existsSync(partial) && statSync(partial).size === partialSize;
    });
    const originalTarget = job.target;
    const originalFile = queuedFile(downloads, originalTarget);
    const videoPart = `${originalFile}.part`;
    lockedDirectory = path.dirname(originalFile);
    originalMode = (await stat(lockedDirectory)).mode & 0o777;
    await chmod(lockedDirectory, 0o555);
    firstBody.release();

    await waitFor(queue, () => job.status === "failed" || resolverCalls > 1);
    await waitFor(queue, () => !internal.active.has(job.id));
    await queue.flush();
    assert.equal(job.status, "failed", "the source cannot be abandoned while its partial remains");
    assert.equal(job.errorKey, "err.downloadCleanupFailed");
    assert.equal(job.error, "Could not remove the previous download's temporary files. Check storage access and retry.");
    assert.doesNotMatch(job.error ?? "", /http|\/tmp|\.part|EACCES/);
    assert.equal(resolverCalls, 1, "no fallback resolver runs after cleanup fails");
    assert.equal(nextSourceHits, 0);
    assert.equal(job.target, originalTarget);
    assert.equal(job.stream?.url, sourceA);
    assert.deepEqual(job.source?.tried, []);
    assert.equal(job.sourceFallbackAttempts, undefined);
    assert.equal(job.received, partialSize);
    assert.equal(job.total, payload.length);
    assert.equal(job.retryCount, undefined);
    assert.equal(existsSync(videoPart), true);

    const stored = JSON.parse(await readFile(path.join(directory, "data", "downloads.json"), "utf8")) as DownloadJob[];
    const persisted = stored.find((item) => item.id === job.id)!;
    assert.equal(persisted.status, "failed");
    assert.equal(persisted.errorKey, "err.downloadCleanupFailed");
    assert.equal(persisted.target, originalTarget);
    assert.equal(persisted.stream?.url, sourceA);
    assert.deepEqual(persisted.source?.tried, []);
    assert.equal(persisted.sourceFallbackAttempts, undefined);
    assert.equal(persisted.received, partialSize);
    assert.equal(persisted.total, payload.length);

    await assert.rejects(queue.retry(job.id), /temporary files/, "a retry is refused while the partial cannot be removed");
    assert.equal(job.status, "failed");
    assert.equal(job.target, originalTarget);
    assert.equal(job.stream?.url, sourceA);
    assert.equal(resolverCalls, 1);

    const restarted = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
      libraries: () => [downloadLibrary(downloads)], defaultLibrary: () => downloadLibrary(downloads),
    });
    try {
      await restarted.load();
      const reloaded = restarted.list().find((item) => item.id === job.id)!;
      assert.equal(reloaded.status, "failed");
      assert.equal(reloaded.target, originalTarget, "a restart keeps the name of the partial it could not remove");
      assert.equal(existsSync(videoPart), true);
    } finally {
      await restarted.stop();
    }

    await chmod(lockedDirectory, originalMode);
    nextBody.release();
    await queue.retry(job.id);
    await waitFor(queue, () => job.status === "completed" || job.status === "failed");
    assert.equal(job.status, "completed", job.error);
    assert.equal(job.target, originalTarget);
    assert.deepEqual(await readFile(originalFile), payload);
    assert.equal(existsSync(videoPart), false);
    assert.equal(resolverCalls, 2, "the retry selects the next source");
    assert.equal(nextSourceHits, 1);
  } finally {
    firstBody.release();
    nextBody.release();
    if (lockedDirectory) await chmod(lockedDirectory, originalMode).catch(() => undefined);
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("profile failover treats missing partials as already cleaned up", async () => {
  const release404 = deferred();
  let resolverCalls = 0;
  const enoentCalls: string[] = [];
  const { server, port } = await listen(async (req, res) => {
    if (req.url === "/subtitle.srt") {
      res.writeHead(200, { "content-type": "application/x-subrip" });
      res.end("1\n00:00:01,000 --> 00:00:02,000\nSubtitle\n");
      return;
    }
    if (req.url === "/first.mp4") {
      await release404.promise;
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-length": "64", "content-type": "video/mp4" });
    res.end(Buffer.alloc(64, 7));
  });
  const { directory, queue, downloads } = await tempQueue({
    unlinkFile: async (file) => {
      try {
        await unlink(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") enoentCalls.push(file);
        throw error;
      }
    },
  });
  queue.setProviderPriorityResolver(async () => {
    resolverCalls += 1;
    return {
      status: "selected",
      stream: { url: `http://127.0.0.1:${port}/${resolverCalls === 1 ? "first" : "second"}.mp4` },
      subtitle: { url: `http://127.0.0.1:${port}/subtitle.srt`, lang: "cs" },
      resolution: {
        checkedCandidates: 1, audioLanguage: "en", subtitleLanguage: "cs",
        subtitleSource: "addon", subtitleStatus: "ready",
      },
      settings: defaultDownloadSettings(),
      streamAddonIdentity: "b".repeat(64),
      subtitleAddonIdentity: "c".repeat(64),
      searchStatus: "complete",
    };
  });
  try {
    const selection = {
      addonKeys: ["addon:http-only"],
      sourceStrategy: "priority" as const,
      audioLanguage: "en",
      audioMode: "preferred" as const,
      subtitleMode: "off" as const,
      targetSettings: defaultDownloadSettings().movie,
    };
    const queued = await queue.addPending(
      "Missing",
      { type: "movie", videoId: "tt-profile-missing", selection },
      { kind: "movie", title: "Missing", id: "tt-profile-missing" },
      "usr_00000001",
      undefined,
      queueAdmission(),
    );
    assert.ok(queued);
    const job = (queue as unknown as { jobs: DownloadJob[] }).jobs[0]!;
    let subtitlePart = "";
    await waitFor(queue, () => {
      if (!job.target) return false;
      const target = queuedFile(downloads, job.target);
      subtitlePart = path.join(
        path.dirname(target),
        `${path.basename(target, path.extname(target))}.cs.vtt.part`,
      );
      return existsSync(subtitlePart);
    });
    await unlink(subtitlePart);
    release404.release();
    await waitFor(queue, () => job.status === "completed" || job.status === "failed");
    assert.equal(job.status, "completed", job.error);
    assert.equal(resolverCalls, 2, "ENOENT lets profile failover continue");
    assert.deepEqual(new Set(enoentCalls), new Set([
      queuedFile(downloads, `${job.target}.part`),
      subtitlePart,
    ]));
  } finally {
    release404.release();
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed partial removal does not reject removing a download", async () => {
  const cleanupAttempts: string[] = [];
  let cleanupDenied = false;
  const transfer = deferred();
  const { server, port } = await listen(async (_req, res) => {
    await transfer.promise;
    if (!res.destroyed) res.end();
  });
  const { directory, queue, downloads } = await tempQueue({
    unlinkFile: async (file) => {
      cleanupAttempts.push(file);
      if (cleanupDenied) throw Object.assign(new Error("denied"), { code: "EACCES" });
      await unlink(file);
    },
  });
  try {
    const job = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    await waitFor(queue, () => queue.get(job.id)?.status === "downloading");
    await queue.pause(job.id);
    const internal = (queue as unknown as { jobs: DownloadJob[] }).jobs[0]!;
    internal.subtitle = { url: "http://127.0.0.1:1/subtitle.srt", lang: "cs" };
    internal.resolution = {
      checkedCandidates: 1, audioLanguage: "en", subtitleLanguage: "cs",
      subtitleSource: "addon", subtitleStatus: "ready",
    };
    const target = queuedFile(downloads, internal.target);
    const videoPart = `${target}.part`;
    const subtitlePart = path.join(
      path.dirname(target),
      `${path.basename(target, path.extname(target))}.cs.vtt.part`,
    );
    await mkdir(path.dirname(videoPart), { recursive: true });
    await writeFile(videoPart, "video");
    await writeFile(subtitlePart, "subtitle");
    cleanupDenied = true;

    await queue.remove(job.id);
    assert.equal(queue.get(job.id), undefined);
    assert.deepEqual(cleanupAttempts, [videoPart, subtitlePart]);
    assert.equal(existsSync(videoPart), true);
    assert.equal(existsSync(subtitlePart), true);
  } finally {
    transfer.release();
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed partial removal does not throw from a non-failover discard", async () => {
  const cleanupAttempts: string[] = [];
  let cleanupDenied = false;
  const transfer = deferred();
  const { server, port } = await listen(async (_req, res) => {
    await transfer.promise;
    if (!res.destroyed) res.end();
  });
  const { directory, queue, downloads } = await tempQueue({
    unlinkFile: async (file) => {
      cleanupAttempts.push(file);
      if (cleanupDenied) throw Object.assign(new Error("denied"), { code: "EACCES" });
      await unlink(file);
    },
  });
  queue.setProviderPriorityResolver(async () => ({
    status: "noMatch",
    checkedCandidates: 0,
    temporaryFailures: 0,
    truncated: false,
  }));
  try {
    const job = await queue.add("Discard", { url: `http://127.0.0.1:${port}/film.mp4` });
    await waitFor(queue, () => queue.get(job.id)?.status === "downloading");
    await queue.pause(job.id);
    const frozen = (queue as unknown as { jobs: DownloadJob[] }).jobs[0]!;
    frozen.sourceAdmission = queueAdmission();
    frozen.source = { type: "movie", videoId: "tt-discard", tried: [], selection: {
      addonKeys: ["addon:http-only"],
      sourceStrategy: "priority",
      audioLanguage: "en",
      audioMode: "preferred",
      subtitleMode: "off",
      targetSettings: defaultDownloadSettings().movie,
    } };
    frozen.subtitle = { url: "http://127.0.0.1:1/subtitle.srt", lang: "cs" };
    frozen.resolution = {
      checkedCandidates: 1, audioLanguage: "en", subtitleLanguage: "cs",
      subtitleSource: "addon", subtitleStatus: "ready",
    };
    const target = queuedFile(downloads, frozen.target);
    const videoPart = `${target}.part`;
    const subtitlePart = path.join(
      path.dirname(target),
      `${path.basename(target, path.extname(target))}.cs.vtt.part`,
    );
    await mkdir(path.dirname(videoPart), { recursive: true });
    await writeFile(videoPart, "video");
    await writeFile(subtitlePart, "subtitle");
    cleanupDenied = true;

    await queue.resume(job.id);
    await waitFor(queue, () => queue.get(job.id)?.status === "failed");
    assert.ok(queue.get(job.id));
    assert.equal(frozen.target, "");
    assert.equal(frozen.stream, undefined);
    assert.equal(frozen.subtitle, undefined);
    assert.deepEqual(cleanupAttempts, [videoPart, subtitlePart]);
    assert.equal(existsSync(videoPart), true);
    assert.equal(existsSync(subtitlePart), true);
  } finally {
    transfer.release();
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an account removal that cannot be saved stops a direct transfer before returning", async () => {
  const size = 8192;
  const first = Buffer.alloc(2048, 1);
  let release!: () => void;
  let finished!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const responseFinished = new Promise<void>((resolve) => { finished = resolve; });
  const { server, port } = await listen(async (_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    res.write(first);
    await gate;
    if (!res.destroyed) res.end(Buffer.alloc(size - first.length, 2));
    finished();
  });
  let failing = false;
  let closed = false;
  const { directory, queue, downloads } = await tempQueue({
    writeState: async (file, data) => {
      if (failing) throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      await writeFile(file, data);
    },
    createWriteStream: (file, options) => {
      const stream = createWriteStream(file, options);
      stream.once("close", () => { closed = true; });
      return stream;
    },
  });
  try {
    const added = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    const partial = `${queuedFile(downloads, added.target)}.part`;
    await waitFor(queue, () => queue.get(added.id)?.received === first.length
      && existsSync(partial) && statSync(partial).size === first.length);
    failing = true;
    await assert.rejects(queue.removeMatching(() => true), (error: AppError) => error.messageKey === "err.queueNotSaved");
    await waitFor(queue, () => closed, 5_000);
    const stoppedAt = (await stat(partial)).size;
    release();
    await responseFinished;
    assert.equal((await stat(partial)).size, stoppedAt, "no bytes may flow after account removal refuses the job");
    assert.equal(stoppedAt, first.length, "the gated second half must never reach the partial file");
    assert.equal(queue.get(added.id)?.status, "paused");
    assert.equal(queue.get(added.id)?.pauseReason, "permission");
  } finally {
    release();
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a removal guard that throws refuses the removal and keeps the row", async () => {
  const { directory, queue } = await tempQueue({ beforeRemove: async () => { throw new Error("no removal"); } });
  try {
    const job = await queue.addPending("Show", { type: "series", videoId: "tt1:1:1" }, undefined, "u1");
    await assert.rejects(queue.remove(job!.id), /no removal/);
    assert.ok(queue.get(job!.id), "the row is still there");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("removeMatching tells the guard the removal is an account's", async () => {
  const reasons: string[] = [];
  const { directory, queue } = await tempQueue({ beforeRemove: async (_job, reason) => { reasons.push(reason); } });
  try {
    await queue.addPending("Show", { type: "series", videoId: "tt1:1:1" }, undefined, "u1");
    await queue.removeMatching(() => true);
    assert.deepEqual(reasons, ["account"]);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a clear guard that throws clears nothing", async () => {
  const size = 128;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    void send(res, size).then(() => res.end());
  });
  const { directory, queue } = await tempQueue({ beforeClearCompleted: async () => { throw new Error("no clear"); } });
  try {
    const job = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    await waitFor(queue, () => queue.list().find((item) => item.id === job.id)?.status === "completed", 30_000);
    await assert.rejects(queue.clearCompleted(), /no clear/);
    assert.equal(queue.list().length, 1, "the finished row is kept");
    assert.equal(queue.list()[0].status, "completed");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a lazy job that finds no source fails with the no-matching-source key", async () => {
  const { directory, queue } = await tempQueue();
  queue.setResolver(async () => undefined);
  try {
    await queue.addPending("Show", { type: "series", videoId: "tt1:1:1" }, { kind: "episode", title: "Show", season: 1, episode: 1 });
    await waitFor(queue, () => queue.list()[0]?.status === "failed");
    assert.equal(queue.list()[0].errorKey, "err.noMatchingSource");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit retry signals the failed lazy source once before resolving it again", async () => {
  const { directory, queue } = await tempQueue();
  const retried: Array<{ type: string; videoId: string }> = [];
  let resolutions = 0;
  queue.setResolver(async () => { resolutions += 1; return undefined; });
  queue.setRetrySourceHook((source) => retried.push(source));
  try {
    await queue.addPending("Show", { type: "series", videoId: "tt1:1:1" }, { kind: "episode", title: "Show", season: 1, episode: 1 });
    await waitFor(queue, () => queue.list()[0]?.status === "failed");
    assert.deepEqual(retried, []);

    await queue.retry(queue.list()[0].id);
    await waitFor(queue, () => resolutions === 2 && queue.list()[0]?.status === "failed");
    assert.deepEqual(retried, [{ type: "series", videoId: "tt1:1:1" }]);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit retry clears a failed lazy source so it can be offered again", async () => {
  const bad = "/failed.mp4";
  const good = "/recovered.mp4";
  const { server, port } = await listen((req, res) => {
    if (req.url === bad) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-length": "64" });
    res.end(Buffer.alloc(64));
  });
  const { directory, queue } = await tempQueue();
  let repaired = false;
  const offered: string[][] = [];
  queue.setResolver(async ({ tried }) => {
    offered.push([...tried]);
    if (tried.includes(`http://127.0.0.1:${port}${bad}`)) return undefined;
    return { stream: { url: `http://127.0.0.1:${port}${repaired ? good : bad}` }, settings: defaultDownloadSettings() };
  });
  try {
    await queue.addPending("Show", { type: "series", videoId: "tt1:1:1" }, { kind: "episode", title: "Show", season: 1, episode: 1 });
    const job = (queue as unknown as { jobs: DownloadJob[] }).jobs[0]!;
    await waitFor(queue, () => job.status === "failed");
    const failedUrl = `http://127.0.0.1:${port}${bad}`;
    assert.deepEqual(job.source?.tried, [failedUrl]);

    repaired = true;
    await queue.retry(job.id);
    await waitFor(queue, () => job.status === "completed" || job.status === "failed");

    assert.equal(job.status, "completed", job.error);
    assert.deepEqual(offered.at(-1), [], "the manual retry offers the source again");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
