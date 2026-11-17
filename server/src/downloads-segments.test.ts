import assert from "node:assert/strict";
import { rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DownloadQueue } from "./downloads.js";
import { defaultDownloadSettings } from "./naming.js";
import { MB, SEGMENTED_TOTAL, assertContent, downloadLibrary, filled, listen, queuedFile, rangeServer, tempQueue, waitFor } from "./downloads-test-support.js";

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
    await assertContent(queuedFile(downloads, job.target), SEGMENTED_TOTAL);
  } finally {
    await queue.stop(); server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a source that lies does not deny ranges to the source that follows it", async () => {
  const { directory, queue, downloads } = await tempQueue({ segments: () => 3 });
  const liar = await listen((req, res) => {
    const range = req.headers.range ?? "";
    if (range === "bytes=0-0") {
      res.writeHead(206, { "content-length": "1", "content-range": `bytes 0-0/${SEGMENTED_TOTAL}` });
      res.end(filled(0, 1));
      return;
    }
    // A 200 whose body stops early: this source answers ranges and the single stream alike without
    // ever sending the file, so the job gives up on it and moves to the next source.
    res.writeHead(200, { "content-type": "video/mp4" });
    res.write(Buffer.alloc(4096));
    res.end();
  });
  const honest = await rangeServer();
  const liarUrl = `http://127.0.0.1:${liar.port}/lie.mkv`;
  queue.setResolver(async ({ tried }) => ({
    stream: { url: tried.includes(liarUrl) ? `http://127.0.0.1:${honest.port}/honest.mkv` : liarUrl },
    settings: defaultDownloadSettings(),
  }));
  try {
    await queue.addPending("Liar", { type: "movie", videoId: "tt2" }, { kind: "movie", title: "Liar" });
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed", 60_000);
    const job = queue.list()[0];
    assert.equal(job.status, "completed", job.error ?? "");
    assert.ok(!job.rangesIgnored, "a flag describing the first source must not reach the second");
    assert.equal(honest.peak(), 3, "the honest source has to be segmented on its own merits");
    await assertContent(queuedFile(downloads, job.target), SEGMENTED_TOTAL);
  } finally {
    await queue.stop(); liar.server.close(); honest.server.close();
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
    await assertContent(queuedFile(downloads, job.target), SEGMENTED_TOTAL);
  } finally {
    await queue.stop(); server.close();
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
    assert.equal((await stat(queuedFile(downloads, `${job.target}.part`))).size, SEGMENTED_TOTAL, "the part file keeps its full size");
    await queue.resume(job.id);
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed", 60_000);
    assert.equal(queue.list()[0].status, "completed", queue.list()[0].error ?? "");
    await assertContent(queuedFile(downloads, job.target), SEGMENTED_TOTAL);
  } finally {
    await queue.stop(); server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a segmented plan is persisted before the part file is allocated", async () => {
  let planSaved = false;
  const { directory, queue, downloads } = await tempQueue({
    segments: () => 2,
    writeState: async (file, data) => {
      const stored = JSON.parse(data) as Array<{ segments?: unknown[] }>;
      if (stored.some((job) => job.segments?.length === 2)) planSaved = true;
      await writeFile(file, data);
    },
  });
  const { server, port, requests } = await rangeServer();
  let restarted: DownloadQueue | undefined;
  try {
    const job = await queue.add("Segmented restart", { url: `http://127.0.0.1:${port}/film.mkv` });
    const deadline = Date.now() + 5_000;
    while (!planSaved && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(planSaved, true, "the segment plan must be on disk before the full-size part file appears");
    await queue.stop();
    assert.equal((await stat(queuedFile(downloads, `${job.target}.part`))).size, SEGMENTED_TOTAL);

    const beforeRestart = requests().length;
    const library = downloadLibrary(downloads);
    restarted = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
      retryDelay: () => 30,
      libraries: () => [library],
      defaultLibrary: () => library,
      segments: () => 2,
    });
    await restarted.load();
    await waitFor(restarted, () => restarted!.list()[0]?.status === "completed" || restarted!.list()[0]?.status === "failed", 60_000);
    assert.equal(restarted.list()[0]?.status, "completed", restarted.list()[0]?.error ?? "");
    const resumedRequests = requests().slice(beforeRestart);
    assert.ok(resumedRequests.length > 0);
    assert.ok(resumedRequests.every((range) => /^bytes=\d+-\d+$/.test(range) && range !== "bytes=0-0"),
      `the restored plan must not probe or fall back to a linear tail: ${resumedRequests.join(", ")}`);
    await assertContent(queuedFile(downloads, job.target), SEGMENTED_TOTAL);
  } finally {
    await queue.stop();
    await restarted?.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
