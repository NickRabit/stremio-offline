import assert from "node:assert/strict";
import { createWriteStream, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { defaultDownloadSettings } from "./naming.js";
import { LIBRARY_ID, MB, listen, queuedFile, rangeServer, tempQueue, waitFor } from "./downloads-test-support.js";

test("a name taken by a folder sends the finished download to (2)", async () => {
  const size = 4096;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    res.end(Buffer.alloc(size, 3));
  });
  const { directory, queue, downloads } = await tempQueue({
    // By the time the commit looks for the name, it is a folder holding a file. That is the
    // shape an older copy of the film still open in a player makes on Windows.
    createWriteStream: (file, options) => {
      if (file.endsWith(".part")) {
        const target = file.slice(0, -".part".length);
        mkdirSync(target, { recursive: true });
        writeFileSync(path.join(target, "held.mkv"), "an older copy");
      }
      return createWriteStream(file, options);
    },
  });
  try {
    await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed");
    const job = queue.list()[0];
    assert.equal(job.status, "completed", job.error ?? "");
    assert.equal(job.target, `${LIBRARY_ID}/Film/Film (2).mp4`, "the taken name sends it to the next one");
    assert.equal(await readFile(path.join(downloads, "Film", "Film.mp4", "held.mkv"), "utf8"), "an older copy", "the older copy is untouched");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a smart job stores selected addon subtitles beside the completed episode", async () => {
  const { server, port } = await listen((req, res) => {
    if (req.url === "/episode.srt") {
      res.writeHead(200, { "content-type": "application/x-subrip" });
      // In the code page a Czech subtitle saved on Windows is in: "kůň" is k, 0xf9, 0xf2.
      res.end(Buffer.concat([Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nAhoj k"), Buffer.from([0xf9, 0xf2]), Buffer.from("\n")]));
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
    assert.match(await readFile(path.join(downloads, "Show", "01 serie", "Show - S01E01.cs.vtt"), "utf8"), /WEBVTT[\s\S]*00:00:01\.000[\s\S]*Ahoj kůň/);
  } finally {
    await queue.stop(); server.close(); await rm(directory, { recursive: true, force: true });
  }
});

test("an episode published under (2) takes its subtitles along", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { server, port } = await listen(async (req, res) => {
    if (req.url === "/episode.srt") {
      res.writeHead(200, { "content-type": "application/x-subrip" });
      res.end("1\n00:00:01,000 --> 00:00:02,000\nAhoj\n");
      return;
    }
    res.writeHead(200, { "content-length": "4096", "content-type": "video/mp4" });
    res.write(Buffer.alloc(2048, 1));
    await gate;
    res.end(Buffer.alloc(2048, 2));
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
    const season = path.join(downloads, "Show", "01 serie");
    const taken = path.join(season, "Show - S01E01.mp4");
    await waitFor(queue, () => existsSync(`${taken}.part`) && existsSync(path.join(season, "Show - S01E01.cs.vtt.part")), 10_000);
    // Another file lands at the episode's name while it downloads.
    await writeFile(taken, "somebody else's file");
    release();
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed");
    assert.equal(queue.list()[0].status, "completed", queue.list()[0].error);
    assert.match(queue.list()[0].target, /Show - S01E01 \(2\)\.mp4$/);
    assert.match(await readFile(path.join(season, "Show - S01E01 (2).cs.vtt"), "utf8"), /Ahoj/, "the subtitles follow the episode to its new name");
    assert.equal(existsSync(path.join(season, "Show - S01E01.cs.vtt.part")), false, "no partial subtitle is left behind");
  } finally {
    release();
    await queue.stop(); server.close(); await rm(directory, { recursive: true, force: true });
  }
});

test("a file already on disk pushes a job of the same title to (2)", async () => {
  const { directory, queue, downloads } = await tempQueue();
  try {
    // Only the disk holds the name: nothing in the queue does, so the collision is with the file.
    const taken = queuedFile(downloads, `${LIBRARY_ID}/Disk Film/Disk Film.mkv`);
    await mkdir(path.dirname(taken), { recursive: true });
    await writeFile(taken, "");
    const job = await queue.add("Disk Film", { url: "http://127.0.0.1:1/disk-film.mkv" });
    await queue.pause(job.id);
    assert.equal(job.target, `${LIBRARY_ID}/Disk Film/Disk Film (2).mkv`);
    assert.ok(path.basename(queuedFile(downloads, job.target)).includes("(2)"), "the copy carries the suffix");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a .part on disk takes the name so the next job gets (2)", async () => {
  const { directory, queue, downloads } = await tempQueue();
  try {
    // An interrupted transfer leaves only the partial behind, and that is enough to keep the name.
    const partial = queuedFile(downloads, `${LIBRARY_ID}/Part Film/Part Film.mkv`);
    await mkdir(path.dirname(partial), { recursive: true });
    await writeFile(`${partial}.part`, "");
    const job = await queue.add("Part Film", { url: "http://127.0.0.1:1/part-film.mkv" });
    await queue.pause(job.id);
    assert.equal(job.target, `${LIBRARY_ID}/Part Film/Part Film (2).mkv`);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a job already queued takes the name so the next one gets (2)", async () => {
  const { directory, queue } = await tempQueue();
  try {
    const first = await queue.add("Film", { url: "http://127.0.0.1:1/first.mkv" });
    await queue.pause(first.id);
    const second = await queue.add("Film", { url: "http://127.0.0.1:1/second.mkv" });
    await queue.pause(second.id);
    assert.equal(first.target, `${LIBRARY_ID}/Film/Film.mkv`);
    assert.equal(second.target, `${LIBRARY_ID}/Film/Film (2).mkv`);
    assert.notEqual(first.target, second.target);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a download whose name was taken while it ran is published under (2)", async () => {
  const size = 64 * 1024;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { server, port } = await listen(async (_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    res.write(Buffer.alloc(size / 2, 7));
    await gate;
    res.end(Buffer.alloc(size / 2, 9));
  });
  const { directory, queue, downloads } = await tempQueue();
  try {
    const job = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mkv` });
    const taken = queuedFile(downloads, job.target);
    // While the transfer runs only the .part exists, so the name looks free to a move that
    // lands a file of its own there.
    await waitFor(queue, () => existsSync(`${taken}.part`), 10_000);
    const other = Buffer.from("a different film moved in meanwhile");
    await writeFile(taken, other);
    release();
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed");
    const done = queue.list()[0];
    assert.equal(done.status, "completed", done.error ?? "");
    assert.equal(done.target, `${LIBRARY_ID}/Film/Film (2).mkv`, "the name that was taken sends it to the next one");
    assert.deepEqual(await readFile(taken), other, "the file that took the name keeps its own bytes");
    assert.equal((await stat(queuedFile(downloads, done.target))).size, size, "and the download lands beside it");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the empty placeholder a crash left at the name is taken back, not skipped", async () => {
  const size = 64 * 1024;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { server, port } = await listen(async (_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    res.write(Buffer.alloc(size / 2, 7));
    await gate;
    res.end(Buffer.alloc(size / 2, 9));
  });
  const { directory, queue, downloads } = await tempQueue();
  try {
    const job = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mkv` });
    const target = queuedFile(downloads, job.target);
    await waitFor(queue, () => existsSync(`${target}.part`), 10_000);
    // What a stop between the reservation and the rename leaves behind.
    await writeFile(target, "");
    release();
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed");
    const done = queue.list()[0];
    assert.equal(done.status, "completed", done.error ?? "");
    assert.equal(done.target, `${LIBRARY_ID}/Film/Film.mkv`, "the download keeps its own name");
    assert.equal((await stat(target)).size, size);
    assert.deepEqual(await readdir(path.dirname(target)), ["Film.mkv"], "no empty file is left beside a (2)");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a normal download keeps its own name and leaves no placeholder behind", async () => {
  const size = 8192;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    res.end(Buffer.alloc(size, 4));
  });
  const { directory, queue, downloads } = await tempQueue();
  try {
    const job = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed");
    assert.equal(queue.list()[0].status, "completed", queue.list()[0].error ?? "");
    assert.equal(queue.list()[0].target, `${LIBRARY_ID}/Film/Film.mkv`, "nothing took the name, so it keeps it");
    const target = queuedFile(downloads, job.target);
    assert.equal((await stat(target)).size, size);
    assert.deepEqual(await readdir(path.dirname(target)), ["Film.mkv"], "no placeholder and no .part are left");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed final rename leaves no empty placeholder at the target", async () => {
  const { directory, queue, downloads } = await tempQueue({ segments: () => 2, retryDelay: () => 20 });
  // The file the commit would publish is gone the moment the last byte lands: every write is
  // already done and the open handle keeps the unlinked file, but the rename has nothing to
  // move. Deleting it there is deterministic, unlike racing the commit from outside the queue.
  queue.onProgress = (progress) => {
    if (!progress.target || !progress.total || progress.received < progress.total) return;
    try { unlinkSync(`${queuedFile(downloads, progress.target)}.part`); } catch { /* already gone */ }
  };
  const { server, port } = await rangeServer({ total: 32 * MB });
  try {
    const job = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mkv` });
    const target = queuedFile(downloads, job.target);
    await waitFor(queue, () => queue.list()[0].status === "failed", 60_000);
    await assert.rejects(stat(target), "the empty placeholder must not be left at the target");
    await assert.rejects(stat(`${target}.part`));
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
