import assert from "node:assert/strict";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DownloadQueue } from "./downloads.js";
import { SEGMENTED_TOTAL, assertContent, filled, listen, queuedFile, rangeServer, tempQueue, waitFor } from "./downloads-test-support.js";

test("a source that ignores ranges is downloaded over one stream", async () => {
  const { directory, queue, downloads } = await tempQueue({ segments: () => 4 });
  const { server, port, peak } = await rangeServer({ ranges: false });
  try {
    const job = await queue.add("Plain", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed", 60_000);
    assert.equal(queue.list()[0].status, "completed", queue.list()[0].error ?? "");
    assert.equal(peak(), 0, "no ranged transfer should have started");
    await assertContent(queuedFile(downloads, job.target), SEGMENTED_TOTAL);
  } finally {
    await queue.stop(); server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a source that lies to the probe and then ignores ranges finishes as one stream", async () => {
  const { directory, queue, downloads } = await tempQueue({ segments: () => 4 });
  const { server, port, requests } = await rangeServer({ probeOnly: true });
  const plans: Array<number | undefined> = [];
  queue.onProgress = (job) => plans.push(job.segments?.length);
  try {
    const job = await queue.add("Mendacious", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed", 60_000);
    const done = queue.list()[0];
    assert.equal(done.status, "completed", done.error ?? "");
    assert.equal(done.rangesIgnored, true, "the job has to remember that the source ignores ranges");
    assert.equal(requests().filter((range) => range === "bytes=0-0").length, 1, "the doomed plan must be built exactly once");
    assert.ok(plans.length > 0, "the transfer that succeeds should have reported progress");
    assert.deepEqual([...new Set(plans)], [undefined], "the attempt that succeeds must carry no plan");
    await assertContent(queuedFile(downloads, job.target), SEGMENTED_TOTAL);
  } finally {
    await queue.stop(); server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the part file of an abandoned plan is gone before the single stream writes", async () => {
  const partAtWrite: boolean[] = [];
  const { directory, queue, downloads } = await tempQueue({
    segments: () => 4,
    createWriteStream: (file, options) => { partAtWrite.push(existsSync(file)); return createWriteStream(file, options); },
  });
  const { server, port } = await rangeServer({ probeOnly: true });
  try {
    const job = await queue.add("Mendacious", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed", 60_000);
    assert.equal(queue.list()[0].status, "completed", queue.list()[0].error ?? "");
    assert.equal(queue.list()[0].rangesIgnored, true, "the plan has to have been abandoned for this to prove anything");
    assert.deepEqual(partAtWrite, [false], "a part file written at segment offsets must not survive into the single stream");
    await assertContent(queuedFile(downloads, job.target), SEGMENTED_TOTAL);
  } finally {
    await queue.stop(); server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("falling back to one stream does not spend a retry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const data = path.join(directory, "data");
  const downloads = path.join(directory, "downloads");
  await mkdir(data, { recursive: true });
  await mkdir(downloads, { recursive: true });
  const { server, port } = await rangeServer({ probeOnly: true });
  await writeFile(path.join(data, "downloads.json"), JSON.stringify([{
    id: "job-1", title: "Mendacious", status: "queued", target: "Mendacious.mkv", received: 0, retryCount: 1,
    speed: 0, createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z",
    stream: { url: `http://127.0.0.1:${port}/film.mkv` },
  }]));
  const queue = new DownloadQueue(() => 1, () => 1, data, downloads, { retryDelay: () => 30, segments: () => 4 });
  const seen: number[] = [];
  queue.onProgress = (job) => seen.push(job.retryCount ?? 0);
  try {
    await queue.load();
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed", 60_000);
    assert.equal(queue.list()[0].status, "completed", queue.list()[0].error ?? "");
    assert.ok(seen.length > 0, "the transfer that succeeds should have reported progress");
    assert.deepEqual([...new Set(seen)], [1], "the fallback must leave the retry budget where the connection drops left it");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a 200 on an unsegmented attempt still fails after three retries", async () => {
  const { directory, queue } = await tempQueue({ segments: () => 4 });
  const ranges: string[] = [];
  let probes = 0;
  const { server, port } = await listen((req, res) => {
    const range = req.headers.range ?? "";
    ranges.push(range);
    if (range === "bytes=0-0") {
      probes += 1;
      res.writeHead(206, { "content-length": "1", "content-range": `bytes 0-0/${SEGMENTED_TOTAL}` });
      res.end(filled(0, 1));
      return;
    }
    // A 200 without a size whose body stops early: the source answers, but never the file.
    res.writeHead(200, { "content-type": "video/mp4" });
    res.write(Buffer.alloc(4096));
    res.end();
  });
  try {
    await queue.add("Mendacious", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.list()[0].status === "failed", 30_000);
    const job = queue.list()[0];
    assert.equal(job.retryCount, 3, "an unsegmented 200 has to spend the retry budget like any other failure");
    assert.equal(job.rangesIgnored, true, "the doomed plan has to be abandoned first");
    assert.equal(probes, 1, "the abandoned plan must not be built again");
    assert.ok(ranges.includes(""), "the attempt that failed has to have been the unsegmented one");
  } finally {
    await queue.stop(); server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
