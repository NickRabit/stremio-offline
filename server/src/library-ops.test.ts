import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AppError } from "./errors.js";
import { LibraryOps, type LibraryOp, type LibraryOpsOptions } from "./library-ops.js";

const waitFor = async (predicate: () => boolean, timeout = 2_000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const harness = async (execute?: LibraryOpsOptions["execute"]) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "stremio-ops-"));
  const seen: string[] = [];
  const queue = new LibraryOps({
    file: path.join(dataDir, "library-ops.json"), retryMs: 10,
    execute: execute ?? (async (_operation, item) => { seen.push(item); return {}; }),
  });
  await queue.load();
  return { dataDir, queue, seen, close: () => rm(dataDir, { recursive: true, force: true }) };
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
  try {
    const operation: LibraryOp = { op: "copy", items: ["one", "two"], target: "target" };
    await writeFile(path.join(h.dataDir, "library-ops.json"), JSON.stringify({ version: 1, jobs: [{
      id: "job", operation, op: "copy", status: "running", total: 2, done: 0, failed: 0,
      bytes: 4, bytesTotal: 10, current: "one", startedAt: new Date().toISOString(), results: [],
    }] }));
    const resumed = new LibraryOps({
      file: path.join(h.dataDir, "library-ops.json"), retryMs: 10,
      execute: async (_operation, item) => { h.seen.push(item); return {}; },
    });
    await resumed.load();
    await waitFor(() => resumed.snapshot().jobs[0]?.status === "completed");
    assert.deepEqual(h.seen, ["one", "two"]);
    assert.equal(resumed.snapshot().jobs[0]?.done, 2);
    assert.equal(JSON.parse(await readFile(path.join(h.dataDir, "library-ops.json"), "utf8")).jobs[0].status, "completed");
  } finally { await h.close(); }
});

test("a paused job resumes when its blocker clears", async () => {
  const h = await harness();
  let blocked = true;
  try {
    const queue = new LibraryOps({
      file: path.join(h.dataDir, "paused.json"), retryMs: 10,
      pause: () => blocked ? "playback" : undefined,
      execute: async (_operation, item) => { h.seen.push(item); return {}; },
    });
    await queue.load();
    await queue.enqueue({ op: "delete", items: ["one"] });
    await waitFor(() => queue.snapshot().jobs[0]?.pauseReason === "playback");
    blocked = false;
    await waitFor(() => queue.snapshot().jobs[0]?.status === "completed");
    assert.deepEqual(h.seen, ["one"]);
  } finally { await h.close(); }
});
