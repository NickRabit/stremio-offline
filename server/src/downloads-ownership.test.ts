import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DownloadQueue } from "./downloads.js";
import { AppError } from "./errors.js";
import { HASH, LIBRARY_ID, listen, queueAdmission, queuedFile, send, tempQueue, waitFor } from "./downloads-test-support.js";

test("a queued source owned by another account does not refuse the caller", async () => {
  const { directory, queue } = await tempQueue();
  try {
    const url = "http://127.0.0.1:1/film.mkv";
    const first = await queue.add("Film", { url }, undefined, undefined, "user1");
    await queue.pause(first.id);
    const second = await queue.add("Film", { url }, undefined, undefined, "user2");
    await queue.pause(second.id);
    assert.equal(queue.list().length, 2, "each account holds its own job for the same source");
    await assert.rejects(() => queue.add("Film", { url }, undefined, undefined, "user1"), /already in the queue/, "the owner is still refused its own source");
    await assert.rejects(() => queue.add("Film", { url }, undefined, undefined, "user2"), /already in the queue/, "and so is the other owner against its own job");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the same infoHash owned by another account does not refuse the caller", async () => {
  const { directory, queue } = await tempQueue({
    debrid: { configured: () => true, advance: async () => ({ ready: false, torrentId: "rd1", progress: 1, status: "queued" }) },
  });
  try {
    await queue.add("Film", { infoHash: HASH, fileIdx: 0 }, undefined, undefined, "user1");
    await queue.add("Film", { infoHash: HASH, fileIdx: 0 }, undefined, undefined, "user2");
    assert.equal(queue.list().length, 2, "each account holds its own torrent for the same infoHash");
    await assert.rejects(() => queue.add("Film", { infoHash: HASH, fileIdx: 0 }, undefined, undefined, "user1"), /already in the queue/);
    await assert.rejects(() => queue.add("Film", { infoHash: HASH, fileIdx: 0 }, undefined, undefined, "user2"), /already in the queue/);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a pending source owned by another account does not refuse the caller", async () => {
  const { directory, queue } = await tempQueue();
  try {
    const first = await queue.addPending("Show", { type: "series", videoId: "tt1:1:1" }, undefined, "user1");
    await queue.pause(first!.id);
    const second = await queue.addPending("Show", { type: "series", videoId: "tt1:1:1" }, undefined, "user2");
    await queue.pause(second!.id);
    assert.equal(queue.list().length, 2, "each account holds its own pending job");
    assert.equal(await queue.addPending("Show", { type: "series", videoId: "tt1:1:1" }, undefined, "user1"), undefined, "the same account repeating the same source is skipped");
    const typed = await queue.addPending("Show", { type: "movie", videoId: "tt1:1:1" }, undefined, "user1");
    assert.ok(typed, "a different type is a different source, even for the same account");
    assert.equal(queue.list().length, 3);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a completed file refuses another account only when it can see the library", async () => {
  const size = 4096;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    void send(res, size).then(() => res.end());
  });
  const url = `http://127.0.0.1:${port}/film.mp4`;
  try {
    let visible = false;
    const { directory, queue } = await tempQueue({ ownerSeesLibrary: () => visible });
    try {
      const first = await queue.add("Film", { url }, undefined, undefined, "user1");
      await waitFor(queue, () => queue.list().find((job) => job.id === first.id)?.status === "completed", 30_000);
      assert.ok(await queue.add("Film", { url }, undefined, undefined, "user2"), "a file the asker cannot see does not refuse the other account");
      visible = true;
      await assert.rejects(() => queue.add("Film", { url }, undefined, undefined, "user3"), /already in the library/, "a file the asker can see does refuse the other account");
    } finally {
      await queue.stop();
      await rm(directory, { recursive: true, force: true });
    }

    // Without the hook the safe answer stands on its own: the other account is never told.
    const { directory: plain, queue: without } = await tempQueue();
    try {
      const first = await without.add("Film", { url }, undefined, undefined, "user1");
      await waitFor(without, () => without.list().find((job) => job.id === first.id)?.status === "completed", 30_000);
      assert.ok(await without.add("Film", { url }, undefined, undefined, "user2"), "without the hook the other account is not refused");
    } finally {
      await without.stop();
      await rm(plain, { recursive: true, force: true });
    }
  } finally {
    server.close();
  }
});

test("a legacy job without an owner belongs to the migrated administrator", async () => {
  const { directory, queue } = await tempQueue({ legacyOwnerId: () => "admin1" });
  try {
    const url = "http://127.0.0.1:1/film.mkv";
    const legacy = await queue.add("Film", { url });
    await queue.pause(legacy.id);
    assert.equal(queue.list().find((job) => job.id === legacy.id)?.ownerUserId, "admin1", "the job resolves to the migrated administrator");
    await assert.rejects(() => queue.add("Film", { url }, undefined, undefined, "admin1"), /already in the queue/, "the migrated administrator is refused its own legacy job");
    assert.ok(await queue.add("Film", { url }, undefined, undefined, "user2"), "another account is not refused by the legacy job");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("two downloads admitted at once get different target files", async () => {
  const { directory, queue } = await tempQueue();
  try {
    const [first, second] = await Promise.all([
      queue.add("Film", { url: "http://example.test/one.mp4" }),
      queue.add("Film", { url: "http://example.test/two.mp4" }),
    ]);
    assert.equal(queue.list().length, 2, "both clicks land as one job each");
    assert.notEqual(first.target, second.target, "the two jobs never carry the same name");
    assert.ok(first.target && second.target);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a double-click on the same source yields one job and one refusal", async () => {
  const { directory, queue } = await tempQueue();
  try {
    const results = await Promise.allSettled([
      queue.add("Film", { url: "http://example.test/same.mp4" }),
      queue.add("Film", { url: "http://example.test/same.mp4" }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one click becomes a job");
    assert.equal(rejected.length, 1, "the other is refused");
    assert.equal((rejected[0]!.reason as AppError).messageKey, "err.sourceQueued");
    assert.equal(queue.list().length, 1, "only one job is in the list");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("two jobs resuming at once never take the same target name", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const downloadDir = path.join(directory, "downloads");
  const archiveRoot = path.join(directory, "archive");
  const archive = { id: "lib_12345678", name: "Archive", type: "movie" as const, root: archiveRoot, enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: true };
  let away = true;
  const size = 4096;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    void send(res, size).then(() => res.end());
  });
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloadDir, {
    stallInitialMs: 5_000, stallTransferMs: 5_000, libraryRetryMs: 60_000,
    libraries: () => away ? [] : [archive],
    defaultLibrary: () => archive,
    libraryState: async (libraryId) => away ? undefined : (libraryId === archive.id ? archive : undefined),
  });
  await queue.load();
  const settings = { subfolder: "", layout: "structured" as const, libraryId: archive.id };
  try {
    const first = await queue.add("Film", { url: `http://127.0.0.1:${port}/one.mp4` }, undefined, settings);
    const second = await queue.add("Film", { url: `http://127.0.0.1:${port}/two.mp4` }, undefined, settings);
    assert.equal(first.status, "paused");
    assert.equal(second.status, "paused");
    assert.equal(first.target, "");
    assert.equal(second.target, "");

    // The library is back, and both jobs resume in the same turn: the free-name search of one
    // must see the name the other is about to claim.
    away = false;
    await Promise.all([queue.resume(first.id), queue.resume(second.id)]);
    const [a, b] = queue.list();
    assert.ok(a!.target && b!.target);
    assert.notEqual(a!.target, b!.target, "the two names must differ");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an admission that cannot be persisted is refused and leaves nothing behind", async () => {
  let failing = false;
  const { directory, queue } = await tempQueue({
    writeState: async (file, data) => {
      if (failing) throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      await writeFile(file, data);
    },
  });
  const stored = async () => JSON.parse(await readFile(path.join(directory, "data", "downloads.json"), "utf8")) as Array<{ id: string; follow?: unknown }>;
  try {
    failing = true;
    await assert.rejects(queue.add("Film", { url: "http://127.0.0.1:1/film.mkv" }), (error: AppError) => error.messageKey === "err.queueNotSaved");
    await assert.rejects(queue.addPending("Ep", { type: "series", videoId: "v1" }), (error: AppError) => error.messageKey === "err.queueNotSaved");
    assert.deepEqual(queue.list(), [], "a refused admission leaves no job in memory");

    failing = false;
    const again = await queue.add("Film", { url: "http://127.0.0.1:1/film.mkv" });
    await queue.pause(again.id);
    assert.ok((await stored()).some((job) => job.id === again.id), "the job reaches the file once the write can land");

    // A follow that cannot be saved is rolled back to the one the job already had.
    await queue.adopt(again.id, { followId: "old", episodeKey: "s1e1", intent: "old" });
    failing = true;
    await assert.rejects(
      queue.adopt(again.id, { followId: "new", episodeKey: "s1e1", intent: "new" }),
      (error: AppError) => error.messageKey === "err.queueNotSaved",
    );
    assert.deepEqual(queue.get(again.id)!.follow, { followId: "old", episodeKey: "s1e1", intent: "old" }, "the old follow stays");
    failing = false;
    await queue.stop();
    assert.deepEqual((await stored()).find((job) => job.id === again.id)?.follow, { followId: "old", episodeKey: "s1e1", intent: "old" }, "and the file keeps it too");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a removal that cannot be saved keeps the row and its partial file", async () => {
  let failing = false;
  const { directory, queue, downloads } = await tempQueue({
    writeState: async (file, data) => {
      if (failing) throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      await writeFile(file, data);
    },
  });
  const stored = async () => JSON.parse(await readFile(path.join(directory, "data", "downloads.json"), "utf8")) as Array<{ id: string }>;
  try {
    const job = await queue.add("Film", { url: "http://127.0.0.1:1/film.mkv" });
    await queue.pause(job.id);
    const partial = `${queuedFile(downloads, job.target)}.part`;
    await mkdir(path.dirname(partial), { recursive: true });
    await writeFile(partial, "half a film");

    failing = true;
    await assert.rejects(queue.remove(job.id), (error: AppError) => error.messageKey === "err.queueNotSaved");
    assert.ok(queue.get(job.id), "the row stays in the queue");
    assert.equal(await readFile(partial, "utf8"), "half a film", "the partial file is still there to resume from");

    failing = false;
    await queue.remove(job.id);
    assert.equal(queue.get(job.id), undefined);
    assert.equal(existsSync(partial), false, "a removal that lands takes the partial file with it");
    assert.deepEqual(await stored(), []);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("clearing history that cannot be saved keeps the finished rows", async () => {
  let failing = false;
  const size = 128;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    void send(res, size).then(() => res.end());
  });
  const { directory, queue } = await tempQueue({
    writeState: async (file, data) => {
      if (failing) throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      await writeFile(file, data);
    },
  });
  try {
    const job = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    await waitFor(queue, () => queue.get(job.id)?.status === "completed", 30_000);
    failing = true;
    await assert.rejects(queue.clearCompleted(), (error: AppError) => error.messageKey === "err.queueNotSaved");
    assert.equal(queue.get(job.id)?.status, "completed", "the finished row is kept");
    failing = false;
    await queue.clearCompleted();
    assert.deepEqual(queue.list(), []);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a write queued after a failed admission does not store the refused job", async () => {
  let failOnce = false;
  let queue!: DownloadQueue;
  const setup = await tempQueue({
    writeState: async (file, data) => {
      if (failOnce) {
        failOnce = false;
        // Another mutation queues its own save while this one is failing.
        void queue.clearCompleted();
        throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      }
      await writeFile(file, data);
    },
  });
  queue = setup.queue;
  try {
    failOnce = true;
    await assert.rejects(queue.add("Film", { url: "http://127.0.0.1:1/film.mkv" }), (error: AppError) => error.messageKey === "err.queueNotSaved");
    await queue.stop();
    const stored = JSON.parse(await readFile(path.join(setup.directory, "data", "downloads.json"), "utf8")) as unknown[];
    assert.deepEqual(stored, [], "the refused job never reaches the file");
    assert.deepEqual(queue.list(), []);
  } finally {
    await queue.stop();
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("a write already waiting before an admission does not store the job if the admission fails", async () => {
  const calls: Array<"hold" | "write" | "fail"> = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const { directory, queue } = await tempQueue({
    writeState: async (file, data) => {
      const plan = calls.shift();
      if (plan === "hold") await held;
      if (plan === "fail") throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      await writeFile(file, data);
    },
  });
  try {
    const existing = await queue.add("Other", { url: "http://127.0.0.1:1/other.mkv" });
    await queue.pause(existing.id);
    // The first save is held on the disk and a second one waits behind it; then the
    // admission queues its own write, which fails.
    calls.push("hold", "write", "fail");
    const first = queue.pause(existing.id);
    const second = queue.pause(existing.id);
    const admission = queue.add("Film", { url: "http://127.0.0.1:1/film.mkv" });
    release();
    await assert.rejects(admission, (error: AppError) => error.messageKey === "err.queueNotSaved");
    await Promise.all([first, second]);
    await queue.stop();
    const stored = JSON.parse(await readFile(path.join(directory, "data", "downloads.json"), "utf8")) as Array<{ id: string }>;
    assert.deepEqual(stored.map((job) => job.id), [existing.id], "only the job that was admitted is on disk");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an added job is in downloads.json once add resolves, and so is a pending one", async () => {
  const { directory, queue } = await tempQueue();
  try {
    const direct = await queue.add("Film", { url: "http://127.0.0.1:1/film.mkv" });
    await queue.pause(direct.id);
    const pending = await queue.addPending("Show", { type: "series", videoId: "tt1:1:1" });
    await queue.pause(pending!.id);
    await queue.stop();
    const stored = JSON.parse(await readFile(path.join(directory, "data", "downloads.json"), "utf8")) as Array<Record<string, unknown> & { source?: { videoId?: string } }>;
    const directRow = stored.find((row) => row.id === direct.id)!;
    assert.ok(directRow, "the direct job is saved");
    assert.equal(directRow.target, `${LIBRARY_ID}/Film/Film.mkv`);
    assert.equal(directRow.libraryId, LIBRARY_ID);
    const pendingRow = stored.find((row) => row.id === pending!.id)!;
    assert.ok(pendingRow, "the pending job is saved");
    assert.equal(pendingRow.source?.videoId, "tt1:1:1");
    assert.equal(pendingRow.target, "");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("addPending skips the owner's own duplicate", async () => {
  const { directory, queue } = await tempQueue();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  queue.setResolver(async () => { await gate; return undefined; });
  try {
    const first = await queue.addPending("Show", { type: "series", videoId: "tt1:1:1" }, undefined, "u1");
    const second = await queue.addPending("Show", { type: "series", videoId: "tt1:1:1" }, undefined, "u1");
    assert.ok(first, "the first job is queued");
    assert.equal(second, undefined, "the same owner repeating the same source is skipped");
    assert.equal(queue.list().length, 1, "only one job is kept");
  } finally {
    release();
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("admitPending reports every admission outcome while addPending keeps its return contract", async () => {
  let releaseResolver!: () => void;
  const resolverGate = new Promise<void>((resolve) => { releaseResolver = resolve; });
  const { directory, queue } = await tempQueue({
    existingLocalCopy: async ({ source }) => source.videoId === "tt-present"
      ? {
          status: "present",
          copy: { key: `${LIBRARY_ID}/Film/Existing.mkv`, libraryId: LIBRARY_ID, actualSize: 10 },
        }
      : source.videoId === "tt-unresolved"
        ? { status: "unresolved", reason: "lookupFailed" }
        : { status: "absent" },
  });
  queue.setResolver(async () => {
    await resolverGate;
    return undefined;
  });
  try {
    const queued = await queue.admitPending("Queued", { type: "movie", videoId: "tt-queued" }, undefined, "usr_00000001");
    assert.equal(queued.outcome, "queued");
    assert.equal(
      (await queue.admitPending("Queued", { type: "movie", videoId: "tt-queued" }, undefined, "usr_00000001")).outcome,
      "alreadyQueued",
    );
    assert.equal(
      (await queue.admitPending(
        "Present",
        { type: "movie", videoId: "tt-present" },
        undefined,
        "usr_00000001",
        queueAdmission(),
      )).outcome,
      "presentLocally",
    );
    assert.equal(
      (await queue.admitPending(
        "Unknown",
        { type: "movie", videoId: "tt-unresolved" },
        undefined,
        "usr_00000001",
        queueAdmission(),
      )).outcome,
      "unresolved",
    );

    const added = await queue.addPending("Added", { type: "movie", videoId: "tt-added" }, undefined, "usr_00000001");
    assert.ok(added);
    assert.equal("outcome" in added, false, "the existing overload still returns the public job");
    assert.equal(
      await queue.addPending("Added", { type: "movie", videoId: "tt-added" }, undefined, "usr_00000001"),
      undefined,
    );
  } finally {
    releaseResolver();
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("activeEpisodeIn matches an owner's video id or destination episode", async () => {
  let releaseResolver!: () => void;
  const resolverGate = new Promise<void>((resolve) => { releaseResolver = resolve; });
  const { directory, queue } = await tempQueue();
  queue.setResolver(async () => {
    await resolverGate;
    return undefined;
  });
  try {
    await queue.addPending(
      "Show · S01E01",
      { type: "series", videoId: "tt-show:1:1" },
      { kind: "episode", title: "Show", season: 1, episode: 1 },
      "usr_00000001",
    );
    await queue.addPending(
      "Other · S01E01",
      { type: "series", videoId: "tt-other:1:1" },
      { kind: "episode", title: "Other", season: 1, episode: 1 },
      "usr_00000002",
    );
    assert.equal(queue.activeEpisodeIn("usr_00000001", {
      type: "series", videoId: "tt-show:1:1", libraryId: LIBRARY_ID,
      seriesFolder: "Show", season: 1, episode: 1,
    }), true);
    assert.equal(queue.activeEpisodeIn("usr_00000001", {
      type: "series", videoId: "different", libraryId: LIBRARY_ID,
      seriesFolder: "Show", season: 1, episode: 1,
    }), true, "the same owner's target episode is a duplicate");
    assert.equal(queue.activeEpisodeIn("usr_00000001", {
      type: "series", videoId: "different", libraryId: LIBRARY_ID,
      seriesFolder: "Other", season: 1, episode: 1,
    }), false, "another owner's episode is ignored");
  } finally {
    releaseResolver();
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
