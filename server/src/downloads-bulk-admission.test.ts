import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DownloadQueue, type PendingAdmissionOutcome, type PendingAdmissionRequest, type QueueHooks } from "./downloads.js";
import { LIBRARY_ID, queueAdmission, tempQueue, windowAt } from "./downloads-test-support.js";
import { AppError } from "./errors.js";
import type { LibraryRecord } from "./libraries.js";
import { openAppDatabase, StorageError, type AppDatabase, type Statement } from "./storage/app-database.js";

const owner = "usr_00000001";
const otherOwner = "usr_00000002";
const closedWindow = {
  now: () => windowAt(12),
  timeZone: () => "UTC",
  downloadWindow: () => ({ start: "01:00", end: "07:00" }),
};

function admissionRequests(count: number, offset = 0): PendingAdmissionRequest[] {
  return Array.from({ length: count }, (_, index) => {
    const episode = offset + index + 1;
    return {
      title: `Show · S01E${String(episode).padStart(2, "0")}`,
      source: { type: "series", videoId: `tt-show:1:${episode}` },
      media: { kind: "episode", title: "Show", season: 1, episode },
    };
  });
}

function outcomes(results: PendingAdmissionOutcome[]) {
  return results.map((result) => result.outcome);
}

function observingBatch(database: AppDatabase, onBatch: (statements: Statement[]) => Promise<void> | void): AppDatabase {
  return new Proxy(database, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: Statement[]) => {
          await onBatch(statements);
          return await target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function sqliteFixture(t: TestContext, hooks: QueueHooks = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "downloads-bulk-sqlite-"));
  const downloads = path.join(dataDir, "downloads");
  const library: LibraryRecord = {
    id: LIBRARY_ID,
    name: "Downloads",
    type: "mixed",
    root: downloads,
    enabled: true,
    order: 0,
    addedAt: "2026-11-01T00:00:00.000Z",
    writeArtwork: false,
  };
  let database = await openAppDatabase({ dataDir });
  const queues: DownloadQueue[] = [];
  const openQueue = (attached: AppDatabase = database, extra: QueueHooks = {}) => {
    const queue = new DownloadQueue(() => 1, () => 1, dataDir, downloads, {
      libraries: () => [library],
      defaultLibrary: () => library,
      ...closedWindow,
      ...hooks,
      ...extra,
    });
    queue.attachDatabase(attached);
    queues.push(queue);
    return queue;
  };
  t.after(async () => {
    for (const queue of queues.reverse()) await queue.stop();
    try {
      await database.close();
    } catch (error) {
      if (!(error instanceof StorageError) || error.code !== "broken") throw error;
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, downloads, openQueue, get database() { return database; } };
}

async function jsonFixture(t: TestContext, hooks: QueueHooks = {}) {
  const setup = await tempQueue({ ...closedWindow, ...hooks });
  t.after(async () => {
    await setup.queue.stop();
    await rm(setup.directory, { recursive: true, force: true });
  });
  return setup;
}

test("one batch admission writes once on the JSON backend", async (t) => {
  let writes = 0;
  const { queue } = await jsonFixture(t, {
    writeState: async (file, data) => {
      writes += 1;
      await writeFile(file, data);
    },
  });

  const requests = admissionRequests(24);
  const beforeBatch = writes;
  const admitted = await queue.admitPendingBatch(requests, owner);
  const batchWrites = writes - beforeBatch;

  assert.deepEqual(outcomes(admitted), Array(24).fill("queued"));
  assert.equal(batchWrites, 1);
  assert.deepEqual(queue.list().map((job) => job.title), requests.map((request) => request.title));

  const beforeSingles = writes;
  for (const request of admissionRequests(24, 24)) {
    assert.equal((await queue.admitPending(
      request.title,
      request.source,
      request.media,
      owner,
      request.sourceAdmissionInput,
    )).outcome, "queued");
  }
  const singleWrites = writes - beforeSingles;
  assert.equal(singleWrites, 24);
  t.diagnostic(`JSON admission writes: batch=${batchWrites}, per-entry=${singleWrites}`);
});

test("one batch admission writes once on the SQLite backend", async (t) => {
  let admissionBatches = 0;
  const fixture = await sqliteFixture(t);
  const observed = observingBatch(fixture.database, (statements) => {
    if (statements.some((statement) => statement.sql.includes("download_jobs"))) admissionBatches += 1;
  });
  const queue = fixture.openQueue(observed);
  await queue.load();

  const requests = admissionRequests(24);
  const beforeBatch = admissionBatches;
  const admitted = await queue.admitPendingBatch(requests, owner);
  const batchWrites = admissionBatches - beforeBatch;

  assert.deepEqual(outcomes(admitted), Array(24).fill("queued"));
  assert.equal(batchWrites, 1);
  assert.deepEqual(queue.list().map((job) => job.title), requests.map((request) => request.title));

  const beforeSingles = admissionBatches;
  for (const request of admissionRequests(24, 24)) {
    assert.equal((await queue.admitPending(
      request.title,
      request.source,
      request.media,
      owner,
      request.sourceAdmissionInput,
    )).outcome, "queued");
  }
  const singleWrites = admissionBatches - beforeSingles;
  assert.equal(singleWrites, 24);
  t.diagnostic(`SQLite admission writes: batch=${batchWrites}, per-entry=${singleWrites}`);
});

test("zero accepted entries make no admission write on either backend", async (t) => {
  for (const backend of ["json", "sqlite"] as const) {
    let writes = 0;
    const admission = queueAdmission();
    const hooks = {
      existingLocalCopy: async ({ source }: { source: { videoId: string } }) => source.videoId === "tt-present"
        ? { status: "present" as const, copy: { key: `${LIBRARY_ID}/Show/Show - S01E02.mkv`, libraryId: LIBRARY_ID, actualSize: 10 } }
        : { status: "absent" as const },
    };
    let queue: DownloadQueue;
    let cleanup: () => Promise<void>;
    if (backend === "json") {
      const setup = await jsonFixture(t, {
        ...hooks,
        writeState: async (file, data) => {
          writes += 1;
          await writeFile(file, data);
        },
      });
      queue = setup.queue;
      cleanup = async () => undefined;
    } else {
      const fixture = await sqliteFixture(t, hooks);
      const observed = observingBatch(fixture.database, (statements) => {
        if (statements.some((statement) => statement.sql.includes("download_jobs"))) writes += 1;
      });
      queue = fixture.openQueue(observed);
      await queue.load();
      cleanup = async () => undefined;
    }

    assert.equal((await queue.admitPending("Queued", { type: "series", videoId: "tt-queued" }, undefined, owner)).outcome, "queued");
    const before = writes;
    const admitted = await queue.admitPendingBatch([
      { title: "Queued", source: { type: "series", videoId: "tt-queued" }, media: undefined },
      {
        title: "Present",
        source: { type: "series", videoId: "tt-present" },
        media: undefined,
        sourceAdmissionInput: admission,
      },
    ], owner);
    assert.deepEqual(outcomes(admitted), ["alreadyQueued", "presentLocally"]);
    assert.equal(writes - before, 0);
    await cleanup();
  }
});

test("mixed batch outcomes match sequential admission", async (t) => {
  const admission = queueAdmission();
  const settings = {
    existingLocalCopy: async ({ source }: { source: { videoId: string } }) => {
      if (source.videoId === "tt-present") {
        return { status: "present" as const, copy: { key: `${LIBRARY_ID}/Show/Show - S01E05.mkv`, libraryId: LIBRARY_ID, actualSize: 10 } };
      }
      if (source.videoId === "tt-unresolved") return { status: "unresolved" as const, reason: "lookupFailed" as const };
      return { status: "absent" as const };
    },
  };
  const first = await jsonFixture(t, settings);
  const second = await jsonFixture(t, settings);
  for (const queue of [first.queue, second.queue]) {
    await queue.admitPending("Already", { type: "series", videoId: "tt-already" }, undefined, owner);
    await queue.admitPending("Other", { type: "series", videoId: "tt-other" }, undefined, otherOwner);
  }

  const requests: PendingAdmissionRequest[] = [
    { title: "New", source: { type: "series", videoId: "tt-new" }, media: undefined },
    { title: "Already", source: { type: "series", videoId: "tt-already" }, media: undefined },
    { title: "Other", source: { type: "series", videoId: "tt-other" }, media: undefined },
    {
      title: "Present",
      source: { type: "series", videoId: "tt-present" },
      media: undefined,
      sourceAdmissionInput: admission,
    },
    {
      title: "Unknown",
      source: { type: "series", videoId: "tt-unresolved" },
      media: undefined,
      sourceAdmissionInput: admission,
    },
    { title: "New again", source: { type: "series", videoId: "tt-new" }, media: undefined },
  ];
  const batched = await first.queue.admitPendingBatch(requests, owner);
  const sequential: PendingAdmissionOutcome[] = [];
  for (const request of requests) {
    sequential.push(await second.queue.admitPending(
      request.title,
      request.source,
      request.media,
      owner,
      request.sourceAdmissionInput,
    ));
  }
  assert.deepEqual(outcomes(batched), outcomes(sequential));
  assert.deepEqual(outcomes(batched), [
    "queued",
    "alreadyQueued",
    "queued",
    "presentLocally",
    "unresolved",
    "alreadyQueued",
  ]);
});

test("overlapping batches admit every episode exactly once", async (t) => {
  const { queue } = await jsonFixture(t);
  const first = admissionRequests(3, 0);
  const second = admissionRequests(3, 1);
  const admitted = await Promise.all([
    queue.admitPendingBatch(first, owner),
    queue.admitPendingBatch(second, owner),
  ]);

  assert.equal(admitted[0].filter((result) => result.outcome === "queued").length, 3);
  assert.equal(admitted[1].filter((result) => result.outcome === "queued").length + admitted[1].filter((result) => result.outcome === "alreadyQueued").length, 3);
  assert.deepEqual(queue.list().map((job) => job.title), admissionRequests(4).map((request) => request.title));
});

test("a failed batch write leaves no jobs and a retry survives a restart on the JSON backend", async (t) => {
  let failNext = false;
  const setup = await jsonFixture(t, {
    writeState: async (file, data) => {
      if (failNext) {
        failNext = false;
        throw Object.assign(new Error("state write failed"), { code: "EIO" });
      }
      await writeFile(file, data);
    },
  });
  const { queue, directory, downloads } = setup;
  const requests = admissionRequests(3);
  failNext = true;
  await assert.rejects(queue.admitPendingBatch(requests, owner), (error: AppError) => error.messageKey === "err.queueNotSaved" && error.status === 503);
  assert.deepEqual(queue.list(), []);

  const admitted = await queue.admitPendingBatch(requests, owner);
  assert.deepEqual(outcomes(admitted), ["queued", "queued", "queued"]);
  const successful = queue.list();
  await queue.stop();

  const reopened = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
    ...closedWindow,
    libraries: () => [{ id: LIBRARY_ID, name: "Downloads", type: "mixed", root: downloads, enabled: true, order: 0, addedAt: "2026-11-01T00:00:00.000Z", writeArtwork: false }],
  });
  await reopened.load();
  try {
    assert.deepEqual(reopened.list(), successful);
  } finally {
    await reopened.stop();
  }
});

test("a failed batch write leaves no jobs and a retry survives a restart on the SQLite backend", async (t) => {
  let failNext = false;
  const fixture = await sqliteFixture(t);
  const observed = observingBatch(fixture.database, () => {
    if (failNext) {
      failNext = false;
      throw new Error("database write failed");
    }
  });
  const queue = fixture.openQueue(observed);
  await queue.load();

  const requests = admissionRequests(3);
  failNext = true;
  await assert.rejects(queue.admitPendingBatch(requests, owner), (error: AppError) => error.messageKey === "err.queueNotSaved" && error.status === 503);
  assert.deepEqual(queue.list(), []);

  const admitted = await queue.admitPendingBatch(requests, owner);
  assert.deepEqual(outcomes(admitted), ["queued", "queued", "queued"]);
  const successful = queue.list();
  await queue.stop();

  const reopened = fixture.openQueue();
  await reopened.load();
  assert.deepEqual(reopened.list(), successful);
});

test("a successful batch wakes the scheduler once and starts jobs after its write resolves", async (t) => {
  let blockNext = false;
  let releaseWrite!: () => void;
  let enteredWrite!: () => void;
  const writeEntered = new Promise<void>((resolve) => { enteredWrite = resolve; });
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  let writeResolved = false;
  const setup = await tempQueue({
    writeState: async (file, data) => {
      if (blockNext) {
        blockNext = false;
        enteredWrite();
        await writeGate;
      }
      await writeFile(file, data);
      writeResolved = true;
    },
  });
  t.after(async () => {
    await setup.queue.stop();
    await rm(setup.directory, { recursive: true, force: true });
  });
  const { queue } = setup;
  writeResolved = false;
  const calls: string[] = [];
  let startedBeforeWrite = false;
  let releaseResolver!: () => void;
  const resolverGate = new Promise<void>((resolve) => { releaseResolver = resolve; });
  queue.setResolver(async (source) => {
    calls.push(source.videoId);
    if (!writeResolved) startedBeforeWrite = true;
    await resolverGate;
    return undefined;
  });

  const internals = queue as unknown as { pump(): void };
  const pump = internals.pump.bind(queue);
  let pumpCalls = 0;
  internals.pump = () => {
    pumpCalls += 1;
    pump();
  };

  const requests = admissionRequests(3);
  blockNext = true;
  const admission = queue.admitPendingBatch(requests, owner);
  await writeEntered;
  assert.equal(queue.list().length, 3);
  assert.deepEqual(calls, []);

  releaseWrite();
  assert.deepEqual(outcomes(await admission), ["queued", "queued", "queued"]);
  const deadline = Date.now() + 5_000;
  while (!calls.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(pumpCalls, 1);
  assert.equal(startedBeforeWrite, false);

  releaseResolver();
  const resolverDeadline = Date.now() + 5_000;
  while (calls.length < 3 && Date.now() < resolverDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(calls, requests.map((request) => request.source.videoId));
});
