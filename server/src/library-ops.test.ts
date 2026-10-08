import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AppError } from "./errors.js";
import { isInside } from "./libraries.js";
import { LibraryOps, type LibraryOp, type LibraryOpsOptions, type OpsState } from "./library-ops.js";

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeout = 2_000) => {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeout) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** The queue moves a job in memory first and persists it afterwards, so a wait on the
 *  snapshot says nothing about the file. A test that asserts the file has to wait for it. */
const storedJobs = async (file: string) => JSON.parse(await readFile(file, "utf8")).jobs as { status: string }[];

const harness = async (execute?: LibraryOpsOptions["execute"]) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "stremio-ops-"));
  const seen: string[] = [];
  const queue = new LibraryOps({
    file: path.join(dataDir, "library-ops.json"), retryMs: 10,
    execute: execute ?? (async (_operation, item) => { seen.push(item); return {}; }),
  });
  await queue.load();
  // The queue saves once more after a job reaches its terminal state, to record that the
  // finished hook has run. Removing the directory without waiting for that write races it,
  // and the write lands as an unhandled rejection after the test is over.
  // The queue writes once more after a job reaches its terminal state, to record that the
  // finished hook has run -- and that write is asked for after the pump has moved on, so
  // waiting only for the writes in flight is not enough. `settled` waits for both.
  return { dataDir, queue, seen, close: () => cleanup(dataDir, [queue]) };
};

/** Every queue has to stop before the directory goes away. The save that records a
 *  terminal job is asked for after the pump has moved on, so `settled` is the only
 *  thing that covers it -- see its comment in library-ops.ts. */
const cleanup = async (dataDir: string, queues: LibraryOps[] = []) => {
  for (const queue of queues) await queue.settled();
  await rm(dataDir, { recursive: true, force: true });
};

test("jobs run serially and continue after an item fails", async () => {
  const active: string[] = [];
  let simultaneous = 0;
  const h = await harness(async (_operation, item) => {
    simultaneous += 1;
    assert.equal(simultaneous, 1);
    active.push(item);
    await new Promise((resolve) => setTimeout(resolve, 5));
    simultaneous -= 1;
    if (item === "bad") throw new AppError("Missing", "err.pathMissing");
    return { to: `${item}-done` };
  });
  try {
    const first = await h.queue.enqueue({ op: "delete", items: ["one", "bad", "three"] });
    const second = await h.queue.enqueue({ op: "favorite", items: ["four"], favorite: true });
    await waitFor(() => h.queue.snapshot().jobs.find((job) => job.id === second.id)?.status === "completed");
    const jobs = h.queue.snapshot().jobs;
    assert.deepEqual(active, ["one", "bad", "three", "four"]);
    const firstState = jobs.find((job) => job.id === first.id);
    assert.equal(firstState?.done, 2);
    assert.equal(firstState?.failed, 1);
    assert.equal(firstState?.status, "completed");
    assert.equal(jobs[0]?.results[1]?.errorKey, "err.pathMissing");
  } finally { await h.close(); }
});

test("load resumes a persisted in-flight job at its current item", async () => {
  const h = await harness();
  const queues: LibraryOps[] = [h.queue];
  try {
    const operation: LibraryOp = { op: "copy", items: ["one", "two"], target: "target" };
    const file = path.join(h.dataDir, "library-ops.json");
    await writeFile(file, JSON.stringify({ version: 1, jobs: [{
      id: "job", operation, op: "copy", status: "running", total: 2, done: 0, failed: 0,
      bytes: 4, bytesTotal: 10, current: "one", startedAt: new Date().toISOString(), results: [],
    }] }));
    const resumed = new LibraryOps({
      file, retryMs: 10,
      execute: async (_operation, item) => { h.seen.push(item); return {}; },
    });
    queues.push(resumed);
    await resumed.load();
    // A cold Windows runner takes longer than two seconds to write this file the first time.
    await waitFor(async () => resumed.snapshot().jobs[0]?.status === "completed"
      && (await storedJobs(file))[0]?.status === "completed", 10_000);
    assert.deepEqual(h.seen, ["one", "two"]);
    assert.equal(resumed.snapshot().jobs[0]?.done, 2);
    assert.equal((await storedJobs(file))[0]?.status, "completed");
  } finally { await cleanup(h.dataDir, queues); }
});

test("a paused job resumes when its blocker clears", async () => {
  const h = await harness();
  const queues: LibraryOps[] = [h.queue];
  let blocked = true;
  try {
    const queue = new LibraryOps({
      file: path.join(h.dataDir, "paused.json"), retryMs: 10,
      pause: () => blocked ? "playback" : undefined,
      execute: async (_operation, item) => { h.seen.push(item); return {}; },
    });
    queues.push(queue);
    await queue.load();
    await queue.enqueue({ op: "delete", items: ["one"] });
    await waitFor(() => queue.snapshot().jobs[0]?.pauseReason === "playback");
    blocked = false;
    await waitFor(() => queue.snapshot().jobs[0]?.status === "completed");
    assert.deepEqual(h.seen, ["one"]);
  } finally { await cleanup(h.dataDir, queues); }
});

test("persistence never trims unfinished jobs", async () => {
  const h = await harness();
  const queues: LibraryOps[] = [h.queue];
  try {
    const queue = new LibraryOps({
      file: path.join(h.dataDir, "many.json"), retryMs: 1_000,
      pause: () => "library",
      execute: async () => ({}),
    });
    queues.push(queue);
    await queue.load();
    for (let index = 0; index < 25; index += 1) await queue.enqueue({ op: "delete", items: [`item-${index}`] });
    await waitFor(() => queue.snapshot().jobs[0]?.pauseReason === "library");
    await queue.flush();
    const saved = JSON.parse(await readFile(path.join(h.dataDir, "many.json"), "utf8"));
    assert.equal(saved.jobs.length, 25);
  } finally { await cleanup(h.dataDir, queues); }
});

test("a corrupt state file is copied aside and new work still runs", async () => {
  const h = await harness();
  const queues: LibraryOps[] = [h.queue];
  try {
    const file = path.join(h.dataDir, "corrupt.json");
    await writeFile(file, "{broken");
    const queue = new LibraryOps({ file, execute: async (_operation, item) => { h.seen.push(item); return {}; } });
    queues.push(queue);
    await queue.load();
    const damaged = (await readdir(h.dataDir)).filter((name) => name.startsWith("corrupt.json.damaged-"));
    assert.equal(damaged.length, 1, "the original bytes are copied aside");
    assert.equal(await readFile(path.join(h.dataDir, damaged[0]!), "utf8"), "{broken");
    await queue.enqueue({ op: "delete", items: ["one"] });
    await waitFor(() => queue.snapshot().jobs[0]?.status === "completed");
    assert.deepEqual(h.seen, ["one"]);
  } finally { await cleanup(h.dataDir, queues); }
});

test("an unreadable operations file blocks new work and is left as it is", async () => {
  const h = await harness();
  const queues: LibraryOps[] = [h.queue];
  try {
    const file = path.join(h.dataDir, "unreadable.json");
    await mkdir(file);
    const queue = new LibraryOps({ file, retryMs: 10, execute: async () => ({}) });
    queues.push(queue);
    await queue.load();
    assert.deepEqual(queue.snapshot().jobs, []);
    await assert.rejects(queue.enqueue({ op: "delete", items: ["one"] }), (error: AppError) => error.messageKey === "err.libraryOpsUnreadable");
    assert.equal((await stat(file)).isDirectory(), true, "the directory is still there");
  } finally { await cleanup(h.dataDir, queues); }
});

test("finished fires once, with the state the job ended in", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "stremio-ops-"));
  const queues: LibraryOps[] = [];
  const seen: OpsState[] = [];
  try {
    const queue = new LibraryOps({
      file: path.join(dataDir, "finished.json"), retryMs: 10,
      execute: async () => ({}),
      finished: (job) => { seen.push(job); },
    });
    queues.push(queue);
    await queue.load();
    await queue.enqueue({ op: "delete", items: ["one", "two"] });
    await waitFor(() => seen.length === 1);
    await queue.flush();
    // Nothing else is queued, so a second call would have landed by now.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.status, "completed");
    assert.equal(seen[0]?.op, "delete");
    assert.equal(seen[0]?.done, 2);
  } finally { await cleanup(dataDir, queues); }
});

test("finished reports a failure and a cancellation, and the caller is what decides", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "stremio-ops-"));
  const queues: LibraryOps[] = [];
  const seen: string[] = [];
  const finished = (job: OpsState) => { seen.push(job.status); };
  try {
    const failing = new LibraryOps({
      file: path.join(dataDir, "failed.json"), retryMs: 10,
      execute: async () => { throw new AppError("Missing", "err.pathMissing"); },
      finished,
    });
    queues.push(failing);
    await failing.load();
    await failing.enqueue({ op: "delete", items: ["one"] });
    await waitFor(() => seen.length === 1);
    assert.deepEqual(seen, ["failed"]);

    const cancelling = new LibraryOps({
      file: path.join(dataDir, "cancelled.json"), retryMs: 10,
      execute: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return {}; },
      finished,
    });
    queues.push(cancelling);
    await cancelling.load();
    const job = await cancelling.enqueue({ op: "delete", items: ["one"] });
    await waitFor(() => cancelling.snapshot().jobs[0]?.status === "running");
    await cancelling.cancel(job.id);
    await waitFor(() => seen.length === 2);
    assert.deepEqual(seen, ["failed", "cancelled"]);
    assert.equal(cancelling.snapshot().jobs[0]?.status, "cancelled");
  } finally { await cleanup(dataDir, queues); }
});

test("cancelling a job that never started reports the state exactly once", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "stremio-ops-"));
  const queues: LibraryOps[] = [];
  const seen: string[] = [];
  try {
    const queue = new LibraryOps({
      file: path.join(dataDir, "queued.json"), retryMs: 10,
      pause: () => "playback",
      execute: async () => ({}),
      finished: (job) => { seen.push(job.status); },
    });
    queues.push(queue);
    await queue.load();
    const job = await queue.enqueue({ op: "delete", items: ["one"] });
    await waitFor(() => queue.snapshot().jobs[0]?.pauseReason === "playback");
    await queue.cancel(job.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(seen, ["cancelled"]);
  } finally { await cleanup(dataDir, queues); }
});

test("a cancel that lands while the pause hook waits never reaches the executor", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "stremio-ops-"));
  const queues: LibraryOps[] = [];
  const ran: string[] = [];
  const finished: string[] = [];
  let entered: () => void = () => undefined;
  let release: () => void = () => undefined;
  const hookEntered = new Promise<void>((resolve) => { entered = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  try {
    const queue = new LibraryOps({
      file: path.join(dataDir, "race.json"), retryMs: 10,
      // Slow on purpose, the way the real hook is: it refreshes library health and resolves
      // paths while the job still says "paused" and has an item to run.
      pause: async () => { entered(); await hold; return undefined; },
      execute: async (_operation, item) => { ran.push(item); return {}; },
      finished: (job) => { finished.push(job.status); },
    });
    queues.push(queue);
    await queue.load();
    const job = await queue.enqueue({ op: "delete", items: ["one"] });
    await hookEntered;
    assert.equal(await queue.cancel(job.id), true);
    release();
    await queue.settled();
    assert.deepEqual(ran, [], "the item a user cancelled was not deleted");
    assert.equal(queue.snapshot().jobs[0]?.status, "cancelled");
    assert.deepEqual(finished, ["cancelled"]);
  } finally { await cleanup(dataDir, queues); }
});

test("a finished hook that throws does not stop the next job", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "stremio-ops-"));
  const queues: LibraryOps[] = [];
  const seen: string[] = [];
  try {
    const queue = new LibraryOps({
      file: path.join(dataDir, "throwing.json"), retryMs: 10,
      execute: async (_operation, item) => { seen.push(item); return {}; },
      finished: () => { throw new Error("hook down"); },
    });
    queues.push(queue);
    await queue.load();
    await queue.enqueue({ op: "delete", items: ["one"] });
    const second = await queue.enqueue({ op: "delete", items: ["two"] });
    await waitFor(() => queue.snapshot().jobs.find((job) => job.id === second.id)?.status === "completed");
    assert.deepEqual(seen, ["one", "two"]);
  } finally { await cleanup(dataDir, queues); }
});

test("a terminal job whose hook never ran fires once on the next load", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "stremio-ops-"));
  const queues: LibraryOps[] = [];
  const file = path.join(dataDir, "pending.json");
  const seen: string[] = [];
  // What a crash between the terminal save and the hook leaves behind: the content is
  // moved, the job is terminal, and the flag is still on.
  const stored = {
    version: 1, jobs: [{
      id: "job", operation: { op: "reroot", items: ["Show"], libraryId: "lib_a", from: "/old", to: "/new" },
      op: "reroot", status: "completed", total: 1, done: 1, failed: 0, bytes: 0, bytesTotal: 0,
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), results: [], notifyPending: true,
    }],
  };
  const finished = (job: OpsState) => { seen.push(job.status); };
  try {
    await writeFile(file, JSON.stringify(stored));
    const queue = new LibraryOps({ file, retryMs: 10, execute: async () => ({}), finished });
    queues.push(queue);
    await queue.load();
    await queue.flush();
    assert.deepEqual(seen, ["completed"]);
    assert.equal(JSON.parse(await readFile(file, "utf8")).jobs[0].notifyPending, false);
    // The flag, not the in-memory set, is what keeps a later start quiet.
    const again = new LibraryOps({ file, retryMs: 10, execute: async () => ({}), finished });
    queues.push(again);
    await again.load();
    await again.flush();
    assert.deepEqual(seen, ["completed"]);
  } finally { await cleanup(dataDir, queues); }
});

test("a finished hook that reports an outcome fails the job, and the next start tries again", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "stremio-ops-"));
  const queues: LibraryOps[] = [];
  const file = path.join(dataDir, "outcome.json");
  let blocked = true;
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const finished: LibraryOpsOptions["finished"] = async (job) => {
    calls.push(job.status);
    if (calls.length === 1) await gate;
    return blocked ? { error: "The folder is taken.", errorKey: "err.libraryRerootTaken", vars: { to: "/new" } } : undefined;
  };
  try {
    const queue = new LibraryOps({ file, retryMs: 10, execute: async () => ({}), finished });
    queues.push(queue);
    await queue.load();
    const job = await queue.enqueue({ op: "reroot", items: ["Show"], libraryId: "lib_a", from: "/old", to: "/new" });
    await waitFor(() => calls.length === 1);
    // While the hook has not answered, nobody may read the job as done.
    assert.equal(queue.snapshot().jobs[0]!.status, "running");
    release();
    await waitFor(() => queue.snapshot().jobs[0]!.status === "failed");
    const failed = queue.snapshot().jobs[0]!;
    assert.equal(failed.id, job.id);
    assert.equal(failed.error, "The folder is taken.");
    assert.equal(failed.errorKey, "err.libraryRerootTaken");
    assert.deepEqual(failed.errorVars, { to: "/new" });
    assert.ok(failed.finishedAt);
    assert.deepEqual(queue.unfinished().map((entry) => entry.operation.op), ["reroot"]);
    await queue.settled();
    assert.equal(JSON.parse(await readFile(file, "utf8")).jobs[0].notifyPending, true, "the retry flag came off");

    // The next start finds the way clear: the job completes and the reason goes.
    blocked = false;
    const again = new LibraryOps({ file, retryMs: 10, execute: async () => ({}), finished });
    queues.push(again);
    await again.load();
    await again.settled();
    assert.deepEqual(calls, ["completed", "failed"]);
    const done = again.snapshot().jobs[0]!;
    assert.equal(done.status, "completed");
    assert.equal(done.error, undefined);
    assert.equal(done.errorKey, undefined);
    assert.deepEqual(again.unfinished(), []);
    assert.equal(JSON.parse(await readFile(file, "utf8")).jobs[0].notifyPending, false);
  } finally { await cleanup(dataDir, queues); }
});

test("a job still waiting on its hook outlives the trim of finished jobs", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "stremio-ops-"));
  const queues: LibraryOps[] = [];
  const file = path.join(dataDir, "trim.json");
  try {
    const queue = new LibraryOps({
      file, retryMs: 10, execute: async () => ({}),
      finished: (_job, operation) => operation.op === "reroot" ? { error: "taken" } : undefined,
    });
    queues.push(queue);
    await queue.load();
    const stranded = await queue.enqueue({ op: "reroot", items: ["Show"], libraryId: "lib_a", from: "/old", to: "/new" });
    for (let index = 0; index < 22; index += 1) await queue.enqueue({ op: "delete", items: [`item-${index}`] });
    await waitFor(() => queue.snapshot().jobs.every((job) => job.status === "completed" || job.status === "failed"));
    await queue.settled();
    const stored = JSON.parse(await readFile(file, "utf8")).jobs as Array<{ id: string }>;
    assert.ok(stored.some((job) => job.id === stranded.id), "the job the next start has to retry was trimmed");
    assert.equal(stored.length, 21);
  } finally { await cleanup(dataDir, queues); }
});

test("a terminal job stored without the flag does not fire on load", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "stremio-ops-"));
  const queues: LibraryOps[] = [];
  const file = path.join(dataDir, "legacy.json");
  const seen: string[] = [];
  try {
    await writeFile(file, JSON.stringify({ version: 1, jobs: [{
      id: "job", operation: { op: "delete", items: ["one"] }, op: "delete", status: "completed",
      total: 1, done: 1, failed: 0, bytes: 0, bytesTotal: 0,
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), results: [],
    }] }));
    const queue = new LibraryOps({ file, retryMs: 10, execute: async () => ({}), finished: (job) => { seen.push(job.status); } });
    queues.push(queue);
    await queue.load();
    await queue.flush();
    assert.deepEqual(seen, []);
  } finally { await cleanup(dataDir, queues); }
});

test("a reroot item pauses for playback although it is only a bare name", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "stremio-ops-"));
  const queues: LibraryOps[] = [];
  const from = path.join(dataDir, "from");
  const playing = path.join(from, "Show", "01.mkv");
  const seen: string[] = [];
  let blocked = true;
  try {
    await mkdir(path.join(from, "Show"), { recursive: true });
    await writeFile(playing, "x");
    const queue = new LibraryOps({
      file: path.join(dataDir, "reroot.json"), retryMs: 10,
      // The reroot branch of the real pause: the bare name is joined onto `from`, and a
      // session holding a file under it is what stops the move. No playback module needed.
      pause: (operation, item) => blocked && operation.op === "reroot" && isInside(playing, path.join(operation.from, item)) ? "playback" : undefined,
      execute: async (_operation, item) => { seen.push(item); return {}; },
    });
    queues.push(queue);
    await queue.load();
    await queue.enqueue({ op: "reroot", items: ["Show"], libraryId: "lib_a", from, to: path.join(dataDir, "to") });
    await waitFor(() => queue.snapshot().jobs[0]?.pauseReason === "playback");
    assert.deepEqual(seen, [], "nothing moves while a session holds the folder");
    blocked = false;
    await waitFor(() => queue.snapshot().jobs[0]?.status === "completed");
    assert.deepEqual(seen, ["Show"]);
  } finally { await cleanup(dataDir, queues); }
});

test("activeItems covers every item of a running job, not only the one under way", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = await harness(async (_operation, item) => { if (item === "one") await gate; return {}; });
  try {
    const job = await h.queue.enqueue({ op: "copy", items: ["one", "two"], target: "Archive" });
    await waitFor(() => h.queue.snapshot().jobs.find((candidate) => candidate.id === job.id)?.status === "running");
    assert.deepEqual(h.queue.activeItems(), ["one", "two"], "the item behind the one under way is about to be touched");

    release!();
    await waitFor(() => h.queue.snapshot().jobs.find((candidate) => candidate.id === job.id)?.status === "completed");
    assert.deepEqual(h.queue.activeItems(), [], "a completed job covers nothing");
  } finally { await h.close(); }
});

test("activeItems holds a paused job, drops what ended, and names a reroot's library", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "stremio-ops-"));
  const queues: LibraryOps[] = [];
  let blocked = true;
  try {
    const queue = new LibraryOps({
      file: path.join(dataDir, "active.json"), retryMs: 10,
      pause: () => blocked ? "playback" : undefined,
      execute: async (_operation, item) => { if (item === "bad") throw new AppError("Missing", "err.pathMissing"); return {}; },
    });
    queues.push(queue);
    await queue.load();

    const paused = await queue.enqueue({ op: "delete", items: ["one", "two"] });
    await waitFor(() => queue.snapshot().jobs.find((job) => job.id === paused.id)?.pauseReason === "playback");
    assert.deepEqual(queue.activeItems(), ["one", "two"], "a paused job still covers what it was given");

    blocked = false;
    await waitFor(() => queue.snapshot().jobs.find((job) => job.id === paused.id)?.status === "completed");

    const failed = await queue.enqueue({ op: "delete", items: ["bad"] });
    await waitFor(() => queue.snapshot().jobs.find((job) => job.id === failed.id)?.status === "failed");
    assert.deepEqual(queue.activeItems(), [], "a job that ran out of items covers nothing");

    blocked = true;
    const cancelled = await queue.enqueue({ op: "delete", items: ["three"] });
    await waitFor(() => queue.snapshot().jobs.find((job) => job.id === cancelled.id)?.pauseReason === "playback");
    await queue.cancel(cancelled.id);
    await waitFor(() => queue.snapshot().jobs.find((job) => job.id === cancelled.id)?.status === "cancelled");
    assert.deepEqual(queue.activeItems(), [], "a cancelled job covers nothing");

    const reroot = await queue.enqueue({ op: "reroot", items: ["Show"], libraryId: "lib_00000001", from: "/old", to: "/new" });
    await waitFor(() => queue.snapshot().jobs.find((job) => job.id === reroot.id)?.pauseReason === "playback");
    assert.deepEqual(queue.activeItems(), ["lib_00000001"], "the names of a reroot are relative to the old root, so the library stands for them");

    blocked = false;
    await waitFor(() => queue.snapshot().jobs.find((job) => job.id === reroot.id)?.status === "completed");
    assert.deepEqual(queue.activeItems(), [], "nothing stands once every job has ended");
  } finally { await cleanup(dataDir, queues); }
});

test("enqueue has written the journal when it resolves", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = await harness(async () => { await gate; return {}; });
  try {
    const job = await h.queue.enqueue({ op: "delete", items: ["one"] });
    const saved = JSON.parse(await readFile(path.join(h.dataDir, "library-ops.json"), "utf8"));
    assert.equal(saved.version, 1);
    assert.ok(saved.jobs.some((row: { id: string }) => row.id === job.id), "the job is in the journal");
  } finally {
    release();
    await h.close();
  }
});

test("an absent journal file loads as an empty queue and is written out", async () => {
  const h = await harness();
  const queues = [h.queue];
  try {
    const file = path.join(h.dataDir, "fresh.json");
    const queue = new LibraryOps({ file, retryMs: 10, execute: async () => ({}) });
    queues.push(queue);
    await queue.load();
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { version: 1, jobs: [] });
  } finally { await cleanup(h.dataDir, queues); }
});

test("a journal with a newer version loads as empty and is left alone", async () => {
  const h = await harness();
  const queues = [h.queue];
  try {
    const file = path.join(h.dataDir, "future.json");
    const original = JSON.stringify({ version: 2, jobs: [] });
    await writeFile(file, original);
    const queue = new LibraryOps({ file, retryMs: 10, execute: async () => ({}) });
    queues.push(queue);
    await queue.load();
    assert.deepEqual(queue.snapshot().jobs, [], "an unknown version yields an empty queue");
    assert.equal(await readFile(file, "utf8"), original, "a file a newer version wrote is never overwritten");
    await assert.rejects(queue.enqueue({ op: "delete", items: ["one"] }), (error: AppError) => error.messageKey === "err.libraryOpsUnreadable");
  } finally { await cleanup(h.dataDir, queues); }
});

test("a journal with a version this build never wrote is copied aside, not overwritten silently", async () => {
  const h = await harness();
  const queues = [h.queue];
  try {
    const file = path.join(h.dataDir, "zero.json");
    const original = JSON.stringify({ version: 0, jobs: [] });
    await writeFile(file, original);
    const queue = new LibraryOps({ file, retryMs: 10, execute: async () => ({}) });
    queues.push(queue);
    await queue.load();
    const damaged = (await readdir(h.dataDir)).filter((name) => name.startsWith("zero.json.damaged-"));
    assert.equal(damaged.length, 1);
    assert.equal(await readFile(path.join(h.dataDir, damaged[0]!), "utf8"), original);
  } finally { await cleanup(h.dataDir, queues); }
});

test("record writes the step before it resolves, and the item's end clears it", async () => {
  const h = await harness();
  const queues: LibraryOps[] = [h.queue];
  let sawStep: unknown;
  try {
    const file = path.join(h.dataDir, "record.json");
    const queue = new LibraryOps({
      file, retryMs: 10,
      execute: async (_operation, item, _progress, journal) => {
        await journal.record({ phase: "moving", from: item, to: `${item}-to` });
        sawStep = JSON.parse(await readFile(file, "utf8")).jobs[0].step;
        return { to: `${item}-to` };
      },
    });
    queues.push(queue);
    await queue.load();
    await queue.enqueue({ op: "move", items: ["one"], target: "Archive" });
    await waitFor(() => queue.snapshot().jobs[0]?.status === "completed");
    await queue.settled();
    assert.deepEqual(sawStep, { item: "one", data: { phase: "moving", from: "one", to: "one-to" } }, "the step is on disk before the item's work goes on");
    const finished = JSON.parse(await readFile(file, "utf8")).jobs[0];
    assert.equal(finished.status, "completed");
    assert.equal("step" in finished, false, "the step is cleared once the item ends");
  } finally { await cleanup(h.dataDir, queues); }
});

test("the step is cleared when the item fails", async () => {
  const h = await harness();
  const queues: LibraryOps[] = [h.queue];
  try {
    const file = path.join(h.dataDir, "record-failed.json");
    const queue = new LibraryOps({
      file, retryMs: 10,
      execute: async (_operation, _item, _progress, journal) => {
        await journal.record({ phase: "moving" });
        throw new AppError("Missing", "err.pathMissing");
      },
    });
    queues.push(queue);
    await queue.load();
    await queue.enqueue({ op: "move", items: ["one"], target: "Archive" });
    await waitFor(() => queue.snapshot().jobs[0]?.status === "failed");
    await queue.settled();
    const finished = JSON.parse(await readFile(file, "utf8")).jobs[0];
    assert.equal(finished.status, "failed");
    assert.equal("step" in finished, false, "a failed item leaves no step behind");
  } finally { await cleanup(h.dataDir, queues); }
});

test("a resumed item is handed its recorded step, and one naming another item is ignored", async () => {
  const h = await harness();
  const queues: LibraryOps[] = [h.queue];
  const recorded: Array<[string, unknown]> = [];
  const step = { phase: "moving", from: "a", to: "b" };
  const job = (id: string, item: string, stored: unknown) => ({
    id, operation: { op: "move", items: [item], target: "Archive" }, op: "move", status: "running",
    total: 1, done: 0, failed: 0, bytes: 0, bytesTotal: 0, current: item,
    startedAt: new Date().toISOString(), results: [], step: stored,
  });
  try {
    const file = path.join(h.dataDir, "resumed.json");
    await writeFile(file, JSON.stringify({ version: 1, jobs: [
      job("mine", "one", { item: "one", data: step }),
      job("other", "two", { item: "elsewhere", data: step }),
    ] }));
    const queue = new LibraryOps({
      file, retryMs: 10,
      execute: async (_operation, item, _progress, journal) => { recorded.push([item, journal.recorded]); return {}; },
    });
    queues.push(queue);
    await queue.load();
    await waitFor(() => recorded.length === 2);
    assert.deepEqual(recorded.find(([item]) => item === "one")?.[1], step, "the step stored for the item under way is handed over");
    assert.equal(recorded.find(([item]) => item === "two")?.[1], undefined, "a step naming another item is not");
  } finally { await cleanup(h.dataDir, queues); }
});

test("snapshot never exposes the step", async () => {
  const h = await harness();
  const queues: LibraryOps[] = [h.queue];
  try {
    const file = path.join(h.dataDir, "hidden.json");
    await writeFile(file, JSON.stringify({ version: 1, jobs: [{
      id: "job", operation: { op: "move", items: ["one"], target: "Archive" }, op: "move", status: "running",
      total: 1, done: 0, failed: 0, bytes: 0, bytesTotal: 0, current: "one",
      startedAt: new Date().toISOString(), results: [],
      step: { item: "one", data: { phase: "moving" } },
    }] }));
    const queue = new LibraryOps({ file, retryMs: 10, pause: () => "playback", execute: async () => ({}) });
    queues.push(queue);
    await queue.load();
    await waitFor(() => queue.snapshot().jobs[0]?.pauseReason === "playback");
    assert.ok(JSON.parse(await readFile(file, "utf8")).jobs[0].step, "the step is still on disk");
    assert.equal("step" in queue.snapshot().jobs[0]!, false, "the step is not part of the public state");
  } finally { await cleanup(h.dataDir, queues); }
});

// The write's temporary path is a directory, which no rename can replace on any platform
// the suite runs on. The queue is otherwise idle, so nothing else is writing at the time.
test("a record whose write fails rejects", async () => {
  let outcome = "";
  const h = await harness();
  const queues: LibraryOps[] = [h.queue];
  try {
    const file = path.join(h.dataDir, "unwritable.json");
    const queue = new LibraryOps({
      file, retryMs: 10,
      execute: async (_operation, _item, _progress, journal) => {
        await mkdir(`${file}.tmp`, { recursive: true });
        outcome = await journal.record({ phase: "moving" }).then(() => "resolved", () => "rejected");
        await rm(`${file}.tmp`, { recursive: true, force: true });
        return {};
      },
    });
    queues.push(queue);
    await queue.load();
    await queue.enqueue({ op: "move", items: ["one"], target: "Archive" });
    await queue.settled();
    assert.equal(outcome, "rejected", "the executor hears that its record never reached the disk");
  } finally { await cleanup(h.dataDir, queues); }
});
