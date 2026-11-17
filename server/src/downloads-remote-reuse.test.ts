import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DownloadQueue, SOURCE_FALLBACK_ATTEMPT_LIMIT, type DownloadJob, type QueuedExistingLocalCopyLookup } from "./downloads.js";
import { AppError } from "./errors.js";
import { defaultDownloadSettings } from "./naming.js";
import { SOURCE_PROFILE_DEFINITIONS, SOURCE_PROFILE_IDS } from "./source-profiles.js";
import { materializeSourceAdmissionPolicy, parseSourceAdmissionSnapshotV1, type SourceAdmissionSnapshotV1 } from "./source-admission.js";
import { LIBRARY_ID, REMOTE_ITEM, REMOTE_ITEM_VIDEO_ID, deferred, downloadLibrary, listen, queueAdmission, queuedFile, remoteRulesAdmission, tempQueue, waitFor } from "./downloads-test-support.js";

const travelProfile = SOURCE_PROFILE_DEFINITIONS.find((definition) => definition.id === SOURCE_PROFILE_IDS.travel);

assert.ok(travelProfile);

const travelQueueAdmission = (): SourceAdmissionSnapshotV1 => parseSourceAdmissionSnapshotV1({
  schemaVersion: 1,
  profile: { id: SOURCE_PROFILE_IDS.travel, revision: 1, template: "travel" },
  operation: "downloadToLibrary",
  providerKeys: ["addon:http-only"],
  policy: materializeSourceAdmissionPolicy(
    travelProfile.policy,
    ["addon:http-only"],
    { audioLanguage: "English", subtitleLanguage: "cs" },
  ),
});

test("a synthetic remote-item id skips both existing-copy hooks and access denial pauses it", async () => {
  let admissionLookups = 0;
  let queueLookups = 0;
  const { directory, queue } = await tempQueue({
    existingLocalCopy: async () => {
      admissionLookups += 1;
      return { status: "absent" };
    },
    existingLocalCopyForQueue: async () => {
      queueLookups += 1;
      return { status: "absent" };
    },
  });
  queue.setRulesResolver(async () => ({
    status: "accessDenied",
    retryable: false as const,
    observations: {
      probesUsed: 0,
      confirmedRejections: 0,
      temporaryFailures: 0,
      accessDenials: 1,
      unresolvedCandidates: 0,
    },
  }));
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
    await waitFor(queue, () => queue.get(admitted.job.id)?.status === "paused");
    assert.equal(queue.get(admitted.job.id)?.pauseReason, "permission");
    assert.equal(queue.get(admitted.job.id)?.errorKey, "download.pausedNoPermission");
    assert.equal(admissionLookups, 0);
    assert.equal(queueLookups, 0);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a remote-item job without an admission fails without consulting the legacy resolver", async () => {
  let resolverCalls = 0;
  const { directory, queue } = await tempQueue();
  queue.setResolver(async () => {
    resolverCalls += 1;
    return undefined;
  });
  try {
    const admitted = await queue.admitPending(
      "Remote episode",
      { type: "series", videoId: REMOTE_ITEM_VIDEO_ID, remoteItem: REMOTE_ITEM },
      { kind: "episode", title: "Remote episode", season: 1, episode: 1 },
      "usr_00000001",
    );
    assert.equal(admitted.outcome, "queued");
    if (admitted.outcome !== "queued") return;
    await waitFor(queue, () => queue.get(admitted.job.id)?.status === "failed");
    assert.equal(queue.get(admitted.job.id)?.errorKey, "err.noMatchingSource");
    assert.equal(resolverCalls, 0);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a queued profile job completes by reference from a copy that appeared after admission", async () => {
  let requests = 0;
  const { server, port } = await listen((_req, res) => {
    requests += 1;
    res.writeHead(200, { "content-length": "64", "content-type": "video/mp4" });
    res.end(Buffer.alloc(64));
  });
  const relative = `${LIBRARY_ID}/Film/Existing.mkv`;
  const completed: Readonly<DownloadJob>[] = [];
  const completedOnce = deferred();
  let admissionLookups = 0;
  let resolverCalls = 0;
  let progressBytes = 0;
  const queueAdmissions: QueuedExistingLocalCopyLookup[] = [];
  const { directory, queue, downloads } = await tempQueue({
    existingLocalCopy: async () => {
      admissionLookups += 1;
      return { status: "absent" };
    },
    existingLocalCopyForQueue: async (input) => {
      queueAdmissions.push(input);
      return {
        status: "present",
        copy: { key: relative, libraryId: LIBRARY_ID, actualSize: 321 },
      };
    },
  });
  const existing = queuedFile(downloads, relative);
  await mkdir(path.dirname(existing), { recursive: true });
  await writeFile(existing, Buffer.alloc(321, 7));
  const before = await stat(existing);
  queue.setResolver(async () => {
    resolverCalls += 1;
    return {
      stream: { name: "fallback.mkv", url: `http://127.0.0.1:${port}/fallback.mkv` },
      settings: defaultDownloadSettings(),
    };
  });
  queue.onProgress = (_job, bytes) => { progressBytes += bytes; };
  queue.onCompleted = async (job) => { completed.push(job); completedOnce.release(); };
  try {
    const follow = { followId: "follow-1", episodeKey: "1:1", intent: "follow-1:1:1" };
    const queued = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-existing" },
      { kind: "movie", title: "Film", id: "tt-existing" },
      "usr_00000001",
      follow,
      queueAdmission(),
    );
    assert.ok(queued && queued.outcome === "queued");
    const queuedId = queued.job.id;
    await waitFor(queue, () => queue.get(queuedId)?.status === "completed");
    const job = queue.get(queuedId)!;
    assert.equal(admissionLookups, 1);
    assert.equal(queueAdmissions[0]?.ownerUserId, "usr_00000001");
    assert.deepEqual(queueAdmissions[0]?.source, { type: "movie", videoId: "tt-existing", tried: [] });
    assert.equal(resolverCalls, 0, "the resolver is not called");
    assert.equal(requests, 0, "no source bytes are requested");
    assert.equal(progressBytes, 0, "no transferred byte is recorded");
    assert.equal(job.target, relative);
    assert.equal(job.libraryId, LIBRARY_ID);
    assert.equal(job.status, "completed");
    assert.ok(job.completedAt);
    assert.equal(job.received, 0);
    assert.equal(job.total, 321);
    assert.equal(job.speed, 0);
    assert.equal(job.reusedLocalCopy, true);
    assert.equal(queue.list()[0]?.reusedLocalCopy, true);
    assert.equal(job.pending, false);
    assert.equal(queue.list()[0]?.pending, false);
    assert.equal(Object.hasOwn(queue.list()[0]!, "source"), false);
    assert.equal(Object.hasOwn(queue.list()[0]!, "sourceAdmission"), false);
    assert.deepEqual(queue.history(), [], "a reused row is not download statistics");
    await completedOnce.promise;
    assert.equal(completed.length, 1);
    assert.equal(completed[0]?.media?.id, "tt-existing");
    assert.deepEqual(completed[0]?.follow, follow);
    const after = await stat(existing);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs, "the existing file is untouched");
    assert.deepEqual(await readFile(existing), Buffer.alloc(321, 7));

    const stored = JSON.parse(await readFile(path.join(directory, "data", "downloads.json"), "utf8")) as Array<Record<string, unknown>>;
    assert.equal(stored[0]?.reusedLocalCopy, true);
    assert.equal(stored[0]?.completedAt, job.completedAt);
    assert.equal(stored[0]?.received, 0);
    assert.equal(stored[0]?.total, 321);
    await queue.stop();

    const reopened = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
      libraries: () => [downloadLibrary(downloads)],
      defaultLibrary: () => downloadLibrary(downloads),
    });
    await reopened.load();
    try {
      assert.equal(reopened.get(queuedId)?.status, "completed");
      assert.equal(reopened.get(queuedId)?.reusedLocalCopy, true);
      assert.equal(reopened.get(queuedId)?.pending, false);
      assert.deepEqual(reopened.history(), []);
    } finally {
      await reopened.stop();
    }
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reuse clears exhausted Travel continuation state instead of failing the queued job", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const data = path.join(directory, "data");
  const downloads = path.join(directory, "downloads");
  await mkdir(data, { recursive: true });
  const selection = {
    addonKeys: ["addon:http-only"],
    sourceStrategy: "priority" as const,
    audioLanguage: "en",
    audioMode: "preferred" as const,
    subtitleMode: "off" as const,
    targetSettings: defaultDownloadSettings().movie,
  };
  await writeFile(path.join(data, "downloads.json"), JSON.stringify([{
    id: "travel-reuse",
    title: "Film",
    ownerUserId: "usr_00000001",
    media: { kind: "movie", title: "Film", id: "tt-travel" },
    source: { type: "movie", videoId: "tt-travel", tried: [], selection },
    sourceAdmission: travelQueueAdmission(),
    travelCursor: {
      schemaVersion: 1,
      scopeFingerprint: "a".repeat(64),
      listingFingerprint: "b".repeat(64),
      nextIndex: 2,
      rejectedIndices: [0, 1],
    },
    sourceFallbackAttempts: SOURCE_FALLBACK_ATTEMPT_LIMIT,
    travelTemporaryFailures: 2,
    travelBudgetAttempts: 3,
    retryCount: 1,
    pauseReason: "user",
    status: "queued",
    target: "",
    received: 0,
    speed: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }]));
  const library = downloadLibrary(downloads);
  const queue = new DownloadQueue(() => 1, () => 1, data, downloads, {
    libraries: () => [library],
    defaultLibrary: () => library,
    existingLocalCopyForQueue: async () => ({
      status: "present",
      copy: {
        key: `${LIBRARY_ID}/Film/Existing.mkv`,
        libraryId: LIBRARY_ID,
        actualSize: 77,
      },
    }),
  });
  try {
    await queue.load();
    await waitFor(queue, () => queue.get("travel-reuse")?.status === "completed");
    const job = queue.get("travel-reuse")!;
    assert.equal(job.reusedLocalCopy, true);
    assert.equal(job.retryCount, undefined);
    assert.equal(job.pauseReason, undefined);
    assert.equal(job.error, undefined);
    const cleared = [
      "travelCursor", "sourceFallbackAttempts", "travelTemporaryFailures", "travelBudgetAttempts",
      "retryCount", "pauseReason", "error", "errorKey", "errorVars",
    ];
    // The completed job reaches the disk after the queue's own save, which a Windows read-back can
    // refuse once; poll unhurriedly so the save's retry gets its turn.
    let stored: Array<Record<string, unknown>> = [];
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      stored = JSON.parse(await readFile(path.join(data, "downloads.json"), "utf8")) as Array<Record<string, unknown>>;
      if (stored[0]?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(stored[0]?.status, "completed");
    for (const key of cleared) assert.equal(Object.hasOwn(stored[0]!, key), false, `${key} must be cleared`);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a copy revoked while an earlier write is pending is re-proved before reuse", async () => {
  const firstProofEntered = deferred();
  const releaseFirstProof = deferred();
  const heldWriteEntered = deferred();
  const releaseHeldWrite = deferred();
  let holdNextWrite = false;
  let copyPresent = true;
  let proofCalls = 0;
  let completed = 0;
  const relative = `${LIBRARY_ID}/Film/RevokedWhileWriting.mkv`;
  const { directory, queue, downloads } = await tempQueue({
    writeState: async (file, data) => {
      if (holdNextWrite) {
        holdNextWrite = false;
        heldWriteEntered.release();
        await releaseHeldWrite.promise;
      }
      await writeFile(file, data);
    },
    existingLocalCopyForQueue: async () => {
      proofCalls += 1;
      if (proofCalls === 1) {
        firstProofEntered.release();
        await releaseFirstProof.promise;
      }
      return copyPresent
        ? { status: "present", copy: { key: relative, libraryId: LIBRARY_ID, actualSize: 41 } }
        : { status: "absent" };
    },
  });
  const existing = queuedFile(downloads, relative);
  await mkdir(path.dirname(existing), { recursive: true });
  await writeFile(existing, Buffer.alloc(41));
  queue.onCompleted = async () => { completed += 1; };
  try {
    const job = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-revoked-while-writing" },
      { kind: "movie", title: "Film", id: "tt-revoked-while-writing" },
      "usr_00000001",
      undefined,
      queueAdmission(),
    );
    assert.ok(job);
    await firstProofEntered.promise;

    holdNextWrite = true;
    const adopted = queue.adopt(job.id, { followId: "held", episodeKey: "1:1", intent: "held" });
    await heldWriteEntered.promise;
    releaseFirstProof.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(proofCalls, 1, "the completion proof waits behind the earlier write");

    copyPresent = false;
    await unlink(existing);
    releaseHeldWrite.release();
    await adopted;
    await waitFor(queue, () => queue.get(job.id)?.status !== "checking");
    assert.equal(proofCalls, 2, "the stale reference is checked again inside the serialized write");
    assert.notEqual(queue.get(job.id)?.status, "completed");
    assert.equal(queue.get(job.id)?.reusedLocalCopy, undefined);
    assert.equal(completed, 0);

    await queue.stop();
    const stored = JSON.parse(await readFile(path.join(directory, "data", "downloads.json"), "utf8")) as Array<Record<string, unknown>>;
    assert.notEqual(stored[0]?.status, "completed");
    assert.equal(Object.hasOwn(stored[0]!, "reusedLocalCopy"), false);
  } finally {
    releaseFirstProof.release();
    releaseHeldWrite.release();
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a cancellation during the queued local-copy lookup prevents reuse completion", async () => {
  const entered = deferred();
  const release = deferred();
  let resolverCalls = 0;
  const relative = `${LIBRARY_ID}/Film/Cancelled.mkv`;
  const { directory, queue, downloads } = await tempQueue({
    existingLocalCopyForQueue: async () => {
      entered.release();
      await release.promise;
      return {
        status: "present",
        copy: { key: relative, libraryId: LIBRARY_ID, actualSize: 16 },
      };
    },
  });
  queue.setResolver(async () => {
    resolverCalls += 1;
    return undefined;
  });
  try {
    const job = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-cancelled" },
      { kind: "movie", title: "Film", id: "tt-cancelled" },
      "usr_00000001",
      undefined,
      queueAdmission(),
    );
    assert.ok(job);
    await entered.promise;
    const paused = queue.pause(job.id);
    release.release();
    await paused;
    assert.equal(queue.get(job.id)?.status, "paused");
    assert.equal(queue.get(job.id)?.reusedLocalCopy, undefined);
    assert.equal(resolverCalls, 0, "a cancelled lookup does not fall through to source resolution");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("no queued local-copy proof and a legacy job both keep the normal resolver path", async () => {
  const size = 128;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    res.end(Buffer.alloc(size));
  });
  let lookups = 0;
  let resolverCalls = 0;
  const { directory, queue } = await tempQueue({
    existingLocalCopyForQueue: async () => {
      lookups += 1;
      return { status: "absent" };
    },
  });
  queue.setTravelResolver(async () => {
    resolverCalls += 1;
    return {
      status: "selected",
      stream: { name: "resolved.mkv", url: `http://127.0.0.1:${port}/resolved.mkv` },
      settings: defaultDownloadSettings(),
      resolution: { checkedCandidates: 1 },
      streamAddonIdentity: "a".repeat(64),
      searchStatus: "complete",
      retryable: false,
      observations: {
        probesUsed: 1,
        confirmedRejections: 0,
        temporaryFailures: 0,
        accessDenials: 0,
        unresolvedCandidates: 0,
      },
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
    const profile = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-no-copy", selection },
      { kind: "movie", title: "Film", id: "tt-no-copy" },
      "usr_00000001",
      undefined,
      travelQueueAdmission(),
    );
    assert.ok(profile);
    await waitFor(queue, () => queue.get(profile.id)?.status === "completed");
    assert.equal(lookups, 1);
    assert.equal(resolverCalls, 1);
    assert.equal(queue.get(profile.id)?.reusedLocalCopy, undefined);
    assert.equal(queue.history().length, 1, "a normal download is still statistics");

    const legacy = await queue.addPending("Legacy", { type: "movie", videoId: "tt-legacy" }, undefined, "usr_00000001");
    assert.ok(legacy);
    await waitFor(queue, () => queue.get(legacy.id)?.status === "failed");
    assert.equal(lookups, 1, "a legacy queued job never asks for a local-copy reference");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed reuse completion write leaves no completed job in memory", async () => {
  let failing = false;
  const entered = deferred();
  const release = deferred();
  const relative = `${LIBRARY_ID}/Film/WriteFails.mkv`;
  const { directory, queue, downloads } = await tempQueue({
    writeState: async (file, data) => {
      if (failing) throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      await writeFile(file, data);
    },
    existingLocalCopyForQueue: async () => {
      entered.release();
      await release.promise;
      return {
        status: "present",
        copy: { key: relative, libraryId: LIBRARY_ID, actualSize: 32 },
      };
    },
  });
  try {
    const job = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-write-fails" },
      { kind: "movie", title: "Film", id: "tt-write-fails" },
      "usr_00000001",
      undefined,
      queueAdmission(),
    );
    assert.ok(job);
    await entered.promise;
    failing = true;
    release.release();
    await waitFor(queue, () => queue.get(job.id)?.status !== "checking");
    assert.notEqual(queue.get(job.id)?.status, "completed");
    assert.equal(queue.get(job.id)?.reusedLocalCopy, undefined);
    const stored = JSON.parse(await readFile(path.join(directory, "data", "downloads.json"), "utf8")) as Array<Record<string, unknown>>;
    assert.notEqual(stored[0]?.status, "completed");
    assert.equal(Object.hasOwn(stored[0]!, "reusedLocalCopy"), false);
  } finally {
    failing = false;
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a misplaced durable reuse marker makes the queue unreadable", async () => {
  const malformed = [
    { reusedLocalCopy: false },
    { status: "queued" },
    { target: "Film/Film.mkv" },
    { libraryId: "lib_ffffffff" },
    { stream: { name: "Film.mkv", url: "http://example.invalid/film.mkv" } },
  ];
  for (const patch of malformed) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
    const data = path.join(directory, "data");
    const downloads = path.join(directory, "downloads");
    await mkdir(data, { recursive: true });
    const state = path.join(data, "downloads.json");
    await writeFile(state, JSON.stringify([{
      id: "invalid-reuse",
      title: "Film",
      ownerUserId: "usr_00000001",
      source: { type: "movie", videoId: "tt-invalid", tried: [] },
      sourceAdmission: queueAdmission(),
      status: "completed",
      target: `${LIBRARY_ID}/Film/Existing.mkv`,
      libraryId: LIBRARY_ID,
      received: 0,
      total: 1,
      speed: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.000Z",
      reusedLocalCopy: true,
      ...patch,
    }]));
    const original = await readFile(state, "utf8");
    const queue = new DownloadQueue(() => 1, () => 1, data, downloads, {
      libraries: () => [downloadLibrary(downloads)],
      defaultLibrary: () => downloadLibrary(downloads),
    });
    try {
      await queue.load();
      assert.deepEqual(queue.list(), []);
      await assert.rejects(queue.add("Film", { url: "http://127.0.0.1:1/film.mkv" }), (error: AppError) => error.messageKey === "err.queueUnreadable");
      assert.equal(await readFile(state, "utf8"), original, "the invalid private state is not overwritten");
    } finally {
      await queue.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
