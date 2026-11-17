import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DownloadQueue, type DownloadJob } from "./downloads.js";
import { AppError } from "./errors.js";
import { REMOTE_ITEM, REMOTE_ITEM_VIDEO_ID, downloadLibrary, remoteRulesAdmission, tempQueue, waitFor } from "./downloads-test-support.js";

test("a failed queue save is tried again without waiting for another change", async () => {
  let locked = false;
  let refused = 0;
  const { directory, queue } = await tempQueue({
    saveRetryMs: 50,
    writeState: async (file, data) => {
      if (locked) {
        refused += 1;
        throw Object.assign(new Error("operation not permitted, rename"), { code: "EPERM" });
      }
      await writeFile(file, data);
    },
  });
  try {
    const first = await queue.add("First", { url: "http://127.0.0.1:1/first.mkv" });
    await queue.pause(first.id);
    const second = await queue.add("Second", { url: "http://127.0.0.1:1/second.mkv" });
    await queue.pause(second.id);
    locked = true;
    await queue.move(second.id, -1);
    assert.equal(refused, 1);
    locked = false;

    const file = path.join(directory, "data", "downloads.json");
    let order: string[] = [];
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      order = (JSON.parse(await readFile(file, "utf8")) as Array<{ id: string }>).map((job) => job.id);
      if (order[0] === second.id) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(order, [second.id, first.id], "the refused reorder reaches the disk on its own");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a malformed queue file is copied aside and the queue starts empty", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const data = path.join(directory, "data");
  const downloads = path.join(directory, "downloads");
  await mkdir(data, { recursive: true });
  const state = path.join(data, "downloads.json");
  const original = "{not-json";
  await writeFile(state, original);
  const library = downloadLibrary(downloads);
  const open = (dir: string) => new DownloadQueue(() => 1, () => 1, dir, downloads, { libraries: () => [library], defaultLibrary: () => library });
  const queue = open(data);
  try {
    await queue.load();
    assert.deepEqual(queue.list(), [], "a state that cannot be parsed loads as an empty queue");
    const damaged = (await readdir(data)).filter((name) => name.startsWith("downloads.json.damaged-"));
    assert.equal(damaged.length, 1, "the original bytes are copied aside under a unique name");
    assert.equal(await readFile(path.join(data, damaged[0]!), "utf8"), original);
    assert.deepEqual(JSON.parse(await readFile(state, "utf8")), [], "the queue file is now a valid empty list");

    // A second malformed file makes a second copy and never touches the first.
    await writeFile(state, "{still-broken");
    const second = open(data);
    try {
      await second.load();
      const copies = (await readdir(data)).filter((name) => name.startsWith("downloads.json.damaged-"));
      assert.equal(copies.length, 2, "a later malformed file is copied aside too");
      assert.equal(await readFile(path.join(data, damaged[0]!), "utf8"), original, "the first copy keeps its bytes");
    } finally {
      await second.stop();
    }
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unreadable queue file blocks new work and is left as it is", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const data = path.join(directory, "data");
  const downloads = path.join(directory, "downloads");
  await mkdir(data, { recursive: true });
  const state = path.join(data, "downloads.json");
  await mkdir(state);
  const library = downloadLibrary(downloads);
  const queue = new DownloadQueue(() => 1, () => 1, data, downloads, { libraries: () => [library], defaultLibrary: () => library });
  try {
    await queue.load();
    assert.deepEqual(queue.list(), []);
    await assert.rejects(queue.add("Film", { url: "http://example.test/film.mp4" }), (error: AppError) => error.messageKey === "err.queueUnreadable");
    assert.equal((await stat(state)).isDirectory(), true, "the unreadable path is still the directory it was");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a job's follow survives a save and a load", async () => {
  const { directory, queue } = await tempQueue();
  try {
    const job = await queue.addPending("Show", { type: "series", videoId: "tt1:1:1" }, undefined, "u1", { followId: "f1", episodeKey: "1:1", intent: "f1:1:1:1" });
    assert.equal(job?.outcome, "queued");
    assert.ok(job && job.outcome === "queued");
    await queue.stop();
    const downloads = path.join(directory, "downloads");
    const reopened = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
      libraries: () => [downloadLibrary(downloads)],
      defaultLibrary: () => downloadLibrary(downloads),
    });
    await reopened.load();
    try {
      assert.deepEqual(reopened.get(job.job.id)?.follow, { followId: "f1", episodeKey: "1:1", intent: "f1:1:1:1" });
    } finally {
      await reopened.stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("adopt writes the follow and it survives a save and a load", async () => {
  const { directory, queue } = await tempQueue();
  try {
    const job = await queue.add("Film", { url: "http://127.0.0.1:1/film.mkv" });
    await queue.pause(job.id);
    await queue.adopt(job.id, { followId: "f1", episodeKey: "1:1", intent: "f1:1:1:1" });
    await queue.stop();
    const downloads = path.join(directory, "downloads");
    const reopened = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
      libraries: () => [downloadLibrary(downloads)],
      defaultLibrary: () => downloadLibrary(downloads),
    });
    await reopened.load();
    try {
      assert.deepEqual(reopened.get(job.id)?.follow, { followId: "f1", episodeKey: "1:1", intent: "f1:1:1:1" });
    } finally {
      await reopened.stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a remoteItem source survives a queue save and load round trip", async () => {
  const { directory, queue } = await tempQueue();
  const accessDenied = {
    status: "accessDenied" as const,
    retryable: false as const,
    observations: {
      probesUsed: 0,
      confirmedRejections: 0,
      temporaryFailures: 0,
      accessDenials: 1,
      unresolvedCandidates: 0,
    },
  };
  queue.setRulesResolver(async () => accessDenied);
  let id: string | undefined;
  try {
    const admitted = await queue.admitPending(
      "Remote episode",
      { type: "series", videoId: REMOTE_ITEM_VIDEO_ID, remoteItem: REMOTE_ITEM },
      { kind: "episode", title: "Remote episode", season: 1, episode: 1 },
      "usr_00000001",
      remoteRulesAdmission(),
    );
    assert.equal(admitted.outcome, "queued");
    if (admitted.outcome !== "queued") return;
    id = admitted.job.id;
    await waitFor(queue, () => queue.get(id!)?.status === "paused");
    await queue.stop();

    const downloads = path.join(directory, "downloads");
    const reopened = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
      libraries: () => [downloadLibrary(downloads)],
      defaultLibrary: () => downloadLibrary(downloads),
    });
    let loadedSource: NonNullable<DownloadJob["source"]> | undefined;
    reopened.setRulesResolver(async ({ source }) => {
      loadedSource = source;
      return accessDenied;
    });
    await reopened.load();
    try {
      assert.equal(reopened.get(id)?.status, "paused");
      await reopened.resume(id);
      await waitFor(reopened, () => loadedSource !== undefined);
      assert.deepEqual(loadedSource?.remoteItem, REMOTE_ITEM);
    } finally {
      await reopened.stop();
    }
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a queue file that is valid JSON but not a list is copied aside", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const data = path.join(directory, "data");
  const downloads = path.join(directory, "downloads");
  await mkdir(data, { recursive: true });
  const state = path.join(data, "downloads.json");
  const original = '{"jobs":[]}';
  await writeFile(state, original);
  const library = downloadLibrary(downloads);
  const queue = new DownloadQueue(() => 1, () => 1, data, downloads, { libraries: () => [library], defaultLibrary: () => library });
  try {
    await queue.load();
    assert.deepEqual(queue.list(), [], "a state that is not a list loads as an empty queue");
    const damaged = (await readdir(data)).filter((name) => name.startsWith("downloads.json.damaged-"));
    assert.equal(damaged.length, 1);
    assert.equal(await readFile(path.join(data, damaged[0]!), "utf8"), original, "the original bytes are copied aside");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
