import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { Writable } from "node:stream";
import test from "node:test";
import { DownloadQueue, type DownloadJob } from "./downloads.js";
import { AppError } from "./errors.js";
import { HASH, MB, assertContent, queueAdmission, queuedFile, rangeServer, tempQueue, waitFor, windowAt } from "./downloads-test-support.js";

const windowHooks = (clock: { value: number }, configured: () => { start: string; end: string } | undefined) => ({
  now: () => clock.value,
  timeZone: () => "UTC",
  downloadWindow: configured,
  windowCheckMs: 20,
});

const settled = async (queue: DownloadQueue, id: string) => {
  await (queue as unknown as { runningById: Map<string, Promise<void>> }).runningById.get(id);
};

test("the timer starts queued work when the download window opens", async () => {
  const clock = { value: windowAt(12) };
  const { directory, queue } = await tempQueue(windowHooks(clock, () => ({ start: "01:00", end: "07:00" })));
  const { server, port, requests } = await rangeServer({ total: 2 * MB });
  try {
    const job = await queue.add("Window", { url: `http://127.0.0.1:${port}/film.mkv` });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(queue.get(job.id)?.status, "queued");
    assert.deepEqual(requests(), [], "the closed window starts no transfer");

    clock.value = windowAt(1);
    await waitFor(queue, () => queue.get(job.id)?.status === "completed", 30_000);
    assert.ok(requests().length > 0, "the 30-second check is replaced by the test interval");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a single-stream transfer paused by the window resumes by Range", async () => {
  const clock = { value: windowAt(1) };
  const window = { start: "01:00", end: "07:00" };
  const { directory, queue, downloads } = await tempQueue(windowHooks(clock, () => window));
  const { server, port, requests } = await rangeServer({ total: 8 * MB });
  try {
    const job = await queue.add("Scheduled", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.get(job.id)?.received! > 256 * 1024, 30_000);
    clock.value = windowAt(7);
    queue.changed();
    await waitFor(queue, () => queue.get(job.id)?.pauseReason === "schedule", 5_000);
    await settled(queue, job.id);
    const paused = queue.get(job.id)!;
    const partial = queuedFile(downloads, `${job.target}.part`);
    assert.ok(paused.received > 0);
    const partialSize = (await stat(partial)).size;
    assert.ok(partialSize > 0, "bytes already written stay in the part file");
    assert.equal(paused.received, partialSize, "received is what the part file holds");

    const before = requests().length;
    clock.value = windowAt(1);
    queue.changed();
    await waitFor(queue, () => queue.get(job.id)?.status === "completed", 30_000);
    const resumed = requests().slice(before).find((range) => range.startsWith("bytes="));
    assert.ok(resumed, `the resumed transfer should ask for a range: ${requests().slice(before).join(", ")}`);
    assert.ok(Number(/^bytes=(\d+)-/.exec(resumed!)?.[1]) > 0);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a rule-picked transfer paused by the window resumes by Range instead of from zero", async () => {
  const clock = { value: windowAt(12) };
  const window = { start: "01:00", end: "07:00" };
  const { directory, queue, downloads } = await tempQueue(windowHooks(clock, () => window));
  const { server, port, requests } = await rangeServer({ total: 8 * MB });
  try {
    const job = await queue.add("Rule picked", { url: `http://127.0.0.1:${port}/film.mkv` });
    const stored = (queue as unknown as { jobs: DownloadJob[] }).jobs.find((item) => item.id === job.id)!;
    stored.sourceAdmission = queueAdmission();
    stored.source = { type: "movie", videoId: "tt-window", tried: [] };
    clock.value = windowAt(1);
    queue.changed();
    await waitFor(queue, () => queue.get(job.id)?.received! > 256 * 1024, 30_000);
    clock.value = windowAt(7);
    queue.changed();
    await waitFor(queue, () => queue.get(job.id)?.pauseReason === "schedule", 5_000);
    await settled(queue, job.id);
    const partialSize = (await stat(queuedFile(downloads, `${job.target}.part`))).size;
    assert.ok(partialSize > 0, "bytes already written stay in the part file");

    const before = requests().length;
    clock.value = windowAt(1);
    queue.changed();
    await waitFor(queue, () => queue.get(job.id)?.status === "completed", 30_000);
    const resumed = requests().slice(before).find((range) => range.startsWith("bytes="));
    assert.ok(resumed, `the resumed transfer should ask for a range: ${requests().slice(before).join(", ")}`);
    assert.ok(Number(/^bytes=(\d+)-/.exec(resumed!)?.[1]) > 0, `the transfer restarted from zero: ${resumed}`);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a segmented transfer keeps its plan and offsets across the window", async () => {
  const clock = { value: windowAt(1) };
  const window = { start: "01:00", end: "07:00" };
  const { directory, queue, downloads } = await tempQueue({ ...windowHooks(clock, () => window), segments: () => 2 });
  const total = 32 * MB;
  const { server, port, requests } = await rangeServer({ total });
  try {
    const job = await queue.add("Segmented window", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.get(job.id)?.received! > 256 * 1024, 30_000);
    clock.value = windowAt(7);
    queue.changed();
    await waitFor(queue, () => queue.get(job.id)?.pauseReason === "schedule", 5_000);
    await settled(queue, job.id);
    const internal = (queue as unknown as { jobs: DownloadJob[] }).jobs[0]!;
    assert.equal(internal.segments?.length, 2);
    assert.ok(internal.segments!.some((segment) => segment.received > 0));
    const partial = queuedFile(downloads, `${job.target}.part`);
    assert.equal((await stat(partial)).size, internal.total);

    const before = requests().length;
    clock.value = windowAt(1);
    queue.changed();
    await waitFor(queue, () => queue.get(job.id)?.status === "completed", 30_000);
    assert.ok(requests().slice(before).some((range) => /^bytes=[1-9]\d*-\d+$/.test(range)));
    await assertContent(queuedFile(downloads, job.target), total);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a person's pause remains theirs when the window closes and opens", async () => {
  const clock = { value: windowAt(3) };
  const window = { start: "01:00", end: "07:00" };
  const { directory, queue } = await tempQueue(windowHooks(clock, () => window));
  const { server, port } = await rangeServer({ total: 8 * MB });
  try {
    const job = await queue.add("Personal pause", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.get(job.id)?.received! > 128 * 1024, 30_000);
    const pausing = queue.pause(job.id);
    clock.value = windowAt(7);
    queue.changed();
    await pausing;
    await settled(queue, job.id);
    clock.value = windowAt(1);
    queue.changed();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(queue.get(job.id)?.status, "paused");
    assert.equal(queue.get(job.id)?.pauseReason, "user");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Download now starts a queued job while the window is closed", async () => {
  const clock = { value: windowAt(12) };
  const { directory, queue } = await tempQueue(windowHooks(clock, () => ({ start: "01:00", end: "07:00" })));
  const { server, port, requests } = await rangeServer({ total: 2 * MB });
  try {
    const job = await queue.add("Now", { url: `http://127.0.0.1:${port}/film.mkv` });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(requests(), []);
    await queue.startNow(job.id);
    await waitFor(queue, () => queue.get(job.id)?.status === "completed", 30_000);
    assert.equal(queue.get(job.id)?.windowExempt, true);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Download now releases an aborted scheduled transfer and keeps it exempt", async () => {
  const clock = { value: windowAt(1) };
  const window = { start: "01:00", end: "07:00" };
  const { directory, queue } = await tempQueue(windowHooks(clock, () => window));
  const { server, port } = await rangeServer({ total: 8 * MB });
  try {
    const job = await queue.add("Scheduled now", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.get(job.id)?.received! > 128 * 1024, 30_000);
    clock.value = windowAt(7);
    queue.changed();
    await queue.startNow(job.id);
    queue.changed();
    await waitFor(queue, () => queue.get(job.id)?.status === "completed", 30_000);
    assert.equal(queue.get(job.id)?.windowExempt, true);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Download now refuses every state that is not waiting for the window", async () => {
  const clock = { value: windowAt(12) };
  const { directory, queue } = await tempQueue(windowHooks(clock, () => ({ start: "01:00", end: "07:00" })));
  try {
    const job = await queue.add("Not waiting", { url: "http://127.0.0.1:1/film.mkv" });
    const internal = (queue as unknown as { jobs: DownloadJob[] }).jobs[0]!;
    for (const status of ["checking", "downloading", "waiting", "completed", "failed"] as const) {
      internal.status = status;
      await assert.rejects(queue.startNow(job.id), (error: AppError) =>
        error.status === 409 && error.messageKey === "err.downloadNowNotWaiting", status);
    }
    internal.status = "paused";
    internal.pauseReason = "user";
    await assert.rejects(queue.startNow(job.id), (error: AppError) =>
      error.status === 409 && error.messageKey === "err.downloadNowNotWaiting", "user pause");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("removing the window while an aborted transfer settles releases it without a user pause", async () => {
  const clock = { value: windowAt(1) };
  let window: { start: string; end: string } | undefined = { start: "01:00", end: "07:00" };
  const { directory, queue } = await tempQueue(windowHooks(clock, () => window));
  const { server, port } = await rangeServer({ total: 8 * MB });
  try {
    const job = await queue.add("Window race", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.get(job.id)?.received! > 128 * 1024, 30_000);
    clock.value = windowAt(7);
    queue.changed();
    window = undefined;
    queue.changed();
    await settled(queue, job.id);
    await waitFor(queue, () => {
      const status = queue.get(job.id)?.status;
      return status === "queued" || status === "downloading" || status === "completed";
    }, 5_000);
    assert.notEqual(queue.get(job.id)?.pauseReason, "user");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("resuming a job the window paused while its transfer settles does not count a dropped connection", async () => {
  const clock = { value: windowAt(1) };
  const window = { start: "01:00", end: "07:00" };
  let hold: Promise<void> | undefined;
  let release = () => {};
  const { directory, queue } = await tempQueue({
    ...windowHooks(clock, () => window),
    libraryState: async () => { await hold; return undefined; },
  });
  const { server, port } = await rangeServer({ total: 8 * MB });
  try {
    const job = await queue.add("Resume race", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.get(job.id)?.received! > 128 * 1024, 30_000);
    clock.value = windowAt(7);
    queue.changed();
    await waitFor(queue, () => queue.get(job.id)?.pauseReason === "schedule", 5_000);
    // The row already reads paused, but its aborted transfer has not settled: hold that
    // settling (it asks for the library) while a person presses Resume.
    const resuming = queue.resume(job.id);
    hold = new Promise<void>((done) => { release = done; });
    setTimeout(() => release(), 100);
    await resuming;
    await settled(queue, job.id);
    const after = queue.get(job.id)!;
    assert.equal(after.status, "queued", "the window is still closed, so the resumed job waits");
    assert.equal(after.errorKey, undefined, `no dropped connection is reported: ${after.error ?? ""}`);
    assert.ok(!after.retryCount, `no retry is spent: ${after.retryCount}`);
  } finally {
    release();
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stale Resume on a running transfer is refused at once and cannot undo a later pause", async () => {
  const { directory, queue } = await tempQueue();
  const { server, port } = await rangeServer({ total: 64 * MB });
  try {
    const job = await queue.add("Running", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.get(job.id)?.status === "downloading" && queue.get(job.id)!.received > 0, 30_000);
    const stale = queue.resume(job.id).then(() => "resumed", (error: unknown) => (error as { messageKey?: string }).messageKey);
    const outcome = await Promise.race([stale, new Promise((resolve) => setTimeout(() => resolve("still waiting"), 500))]);
    await queue.pause(job.id);
    await settled(queue, job.id);
    await stale;
    assert.equal(outcome, "err.cannotResume");
    assert.equal(queue.get(job.id)?.status, "paused");
    assert.equal(queue.get(job.id)?.pauseReason, "user", "the person's pause stands");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Download now refuses a running transfer at once instead of waiting for it", async () => {
  const clock = { value: windowAt(1) };
  const { directory, queue } = await tempQueue(windowHooks(clock, () => ({ start: "01:00", end: "07:00" })));
  const { server, port } = await rangeServer({ total: 64 * MB });
  try {
    const job = await queue.add("Running", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.get(job.id)?.status === "downloading" && queue.get(job.id)!.received > 0, 30_000);
    const started = Date.now();
    await assert.rejects(queue.startNow(job.id), (error: unknown) => (error as { messageKey?: string }).messageKey === "err.downloadNowNotWaiting");
    assert.ok(Date.now() - started < 1_000, `the refusal waited ${Date.now() - started} ms`);
    assert.equal(queue.get(job.id)?.status, "downloading");
    assert.equal(queue.get(job.id)?.windowExempt, undefined);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a waiting Real-Debrid job is not paused by the download window", async () => {
  const clock = { value: windowAt(12) };
  const { directory, queue } = await tempQueue({
    ...windowHooks(clock, () => ({ start: "01:00", end: "07:00" })),
    debrid: {
      configured: () => true,
      advance: async () => ({ ready: false, torrentId: "rd1", progress: 3, status: "downloading" }),
    },
    debridPollMs: 1_000,
  });
  try {
    const job = await queue.add("Debrid wait", { infoHash: HASH, fileIdx: 0 });
    assert.equal(queue.get(job.id)?.status, "waiting");
    queue.changed();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(queue.get(job.id)?.status, "waiting");
    assert.equal(queue.get(job.id)?.pauseReason, undefined);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("storage recovery queues a job but the closed window does not start it", async () => {
  const clock = { value: windowAt(1) };
  let storageFull = true;
  const { directory, queue } = await tempQueue({
    ...windowHooks(clock, () => ({ start: "01:00", end: "07:00" })),
    freeSpace: async () => ({ freeBytes: 1024 ** 3, totalBytes: 2 * 1024 ** 3 }),
    createWriteStream: (file, options) => storageFull
      ? new Writable({ write(_chunk, _encoding, callback) {
          callback(Object.assign(new Error("No space left on the disk."), { code: "ENOSPC" }));
        } })
      : createWriteStream(file, options),
    spaceCheckMs: 20,
  });
  const { server, port } = await rangeServer({ total: 2 * MB });
  try {
    const job = await queue.add("Storage", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.get(job.id)?.pauseReason === "storage", 30_000);
    clock.value = windowAt(12);
    storageFull = false;
    await waitFor(queue, () => queue.get(job.id)?.status === "queued", 5_000);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(queue.get(job.id)?.status, "queued", "the window still holds the queued job");
    clock.value = windowAt(1);
    queue.changed();
    await waitFor(queue, () => queue.get(job.id)?.status === "completed", 30_000);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
