import assert from "node:assert/strict";
import { test } from "node:test";
import { SearchScheduler } from "./search-scheduler.js";

class ManualTimers {
  now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; callback: () => void; every?: number }>();

  setTimeout = (callback: () => void, milliseconds: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + milliseconds, callback });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };

  setInterval = (callback: () => void, milliseconds: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + milliseconds, callback, every: milliseconds });
    return id;
  };

  clearInterval = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };

  tick(milliseconds: number): void {
    const target = this.now + milliseconds;
    for (;;) {
      let next: { id: number; at: number; callback: () => void; every?: number } | undefined;
      for (const [id, task] of this.tasks) {
        if (task.at <= target && (next === undefined || task.at < next.at || (task.at === next.at && id < next.id))) {
          next = { id, ...task };
        }
      }
      if (next === undefined) break;
      this.now = next.at;
      if (next.every === undefined) this.tasks.delete(next.id);
      else this.tasks.set(next.id, { ...next, at: next.at + next.every });
      next.callback();
    }
    this.now = target;
  }
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

const deferred = <T = void>(): Deferred<T> => {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = (value) => done(value as T);
    reject = fail;
  });
  return { promise, resolve, reject };
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const runningJob = (
  sessionId: string,
  sourceClass: "catalog" | "local" | "remote",
  poolKey = "pool",
  order = 0,
) => {
  const pending = deferred();
  return {
    pending,
    job: {
      sessionId,
      sourceClass,
      poolKey,
      order,
      run: () => pending.promise,
    },
  };
};

test("the server-wide cap bounds active jobs and releases slots", async () => {
  const timers = new ManualTimers();
  const scheduler = new SearchScheduler(
    { jobsServerWide: 2, sourceHardLimitMs: 10_000 },
    () => timers.now,
    timers,
  );
  const jobs = [0, 1, 2].map((order) => runningJob("a", "catalog", "pool", order));
  const tasks = jobs.map(({ job }) => scheduler.enqueue(job));
  assert.deepEqual(scheduler.stats(), { active: 2, queued: 1 });
  jobs[0]!.pending.resolve();
  await flush();
  assert.deepEqual(scheduler.stats(), { active: 2, queued: 0 });
  for (const task of tasks) task.cancel();
});

test("catalog, local and remote caps are independent within a session", () => {
  const timers = new ManualTimers();
  const scheduler = new SearchScheduler({
    jobsServerWide: 10,
    catalogJobsPerSession: 1,
    localJobsPerSession: 1,
    remoteJobsPerSession: 1,
    remoteJobsPerPool: 10,
    sourceHardLimitMs: 10_000,
  }, () => timers.now, timers);
  const jobs = [
    runningJob("a", "catalog", "c1"),
    runningJob("a", "catalog", "c2"),
    runningJob("a", "local", "l1"),
    runningJob("a", "local", "l2"),
    runningJob("a", "remote", "r1"),
    runningJob("a", "remote", "r2"),
  ];
  const tasks = jobs.map(({ job }) => scheduler.enqueue(job));
  assert.deepEqual(scheduler.stats(), { active: 3, queued: 3 });
  scheduler.cancelSession("a");
  assert.deepEqual(scheduler.stats(), { active: 3, queued: 0 });
  for (const task of tasks) task.done.catch(() => undefined);
});

test("a remote connection is shared by all sessions", () => {
  const timers = new ManualTimers();
  const scheduler = new SearchScheduler({
    jobsServerWide: 10,
    remoteJobsPerSession: 8,
    remoteJobsPerPool: 2,
    sourceHardLimitMs: 10_000,
  }, () => timers.now, timers);
  const jobs = [
    runningJob("a", "remote", "same"),
    runningJob("b", "remote", "same"),
    runningJob("a", "remote", "same"),
    runningJob("b", "remote", "same"),
  ];
  for (const { job } of jobs) scheduler.enqueue(job);
  assert.equal(scheduler.stats().active, 2);
  scheduler.cancelSession("a");
  scheduler.cancelSession("b");
});

test("sessions are fair even when one has a large backlog", async () => {
  const timers = new ManualTimers();
  const scheduler = new SearchScheduler({
    jobsServerWide: 1,
    catalogJobsPerSession: 100,
    sourceHardLimitMs: 10_000,
  }, () => timers.now, timers);
  const started: string[] = [];
  const pending: Deferred<void>[] = [];
  for (let index = 0; index < 100; index += 1) {
    const wait = deferred();
    pending.push(wait);
    scheduler.enqueue({
      sessionId: "a",
      sourceClass: "catalog",
      poolKey: "pool",
      order: index,
      run: () => { started.push(`a:${index}`); return wait.promise; },
    });
  }
  const b = deferred();
  scheduler.enqueue({
    sessionId: "b",
    sourceClass: "catalog",
    poolKey: "pool",
    order: 0,
    run: () => { started.push("b:0"); return b.promise; },
  });
  assert.deepEqual(started, ["a:0"]);
  pending[0]!.resolve();
  await flush();
  assert.deepEqual(started, ["a:0", "b:0"]);
  b.resolve();
  await flush();
  assert.deepEqual(started, ["a:0", "b:0", "a:1"]);
  scheduler.cancelSession("a");
  scheduler.cancelSession("b");
});

test("queued and active cancellation settle once and never make stats negative", async () => {
  const timers = new ManualTimers();
  const scheduler = new SearchScheduler(
    { jobsServerWide: 1, sourceHardLimitMs: 1000 },
    () => timers.now,
    timers,
  );
  const active = runningJob("a", "catalog");
  const queued = runningJob("a", "catalog");
  const activeTask = scheduler.enqueue(active.job);
  const queuedTask = scheduler.enqueue(queued.job);
  queuedTask.cancel();
  assert.equal(await queuedTask.done, "cancelled");
  assert.deepEqual(scheduler.stats(), { active: 1, queued: 0 });

  let signal: AbortSignal | undefined;
  const second = scheduler.enqueue({
    sessionId: "a",
    sourceClass: "catalog",
    poolKey: "second",
    order: 1,
    run: (abort) => { signal = abort; return deferred().promise; },
  });
  activeTask.cancel();
  assert.equal(await activeTask.done, "cancelled");
  assert.deepEqual(scheduler.stats(), { active: 1, queued: 1 });
  active.pending.resolve();
  await flush();
  assert.equal(signal?.aborted, false);
  assert.deepEqual(scheduler.stats(), { active: 1, queued: 0 });
  second.cancel();
  assert.equal(await second.done, "cancelled");
  assert.equal(signal?.aborted, true);
  timers.tick(1000);
  assert.deepEqual(scheduler.stats(), { active: 0, queued: 0 });
});

test("a hard limit frees a slot even when run never settles", async () => {
  const timers = new ManualTimers();
  const scheduler = new SearchScheduler(
    { jobsServerWide: 1, sourceHardLimitMs: 50 },
    () => timers.now,
    timers,
  );
  const stuck = scheduler.enqueue({
    sessionId: "a",
    sourceClass: "catalog",
    poolKey: "a",
    order: 0,
    run: () => new Promise(() => undefined),
  });
  const next = runningJob("b", "catalog");
  scheduler.enqueue(next.job);
  timers.tick(50);
  assert.equal(await stuck.done, "hardLimit");
  assert.deepEqual(scheduler.stats(), { active: 1, queued: 0 });
  scheduler.cancelSession("b");
  timers.tick(100);
  assert.deepEqual(scheduler.stats(), { active: 0, queued: 0 });
});

test("cancelSession removes queued and aborts active jobs", async () => {
  const timers = new ManualTimers();
  const scheduler = new SearchScheduler(
    { jobsServerWide: 1, sourceHardLimitMs: 1000 },
    () => timers.now,
    timers,
  );
  const first = runningJob("a", "catalog");
  const second = runningJob("a", "catalog");
  const other = runningJob("b", "catalog");
  let signal: AbortSignal | undefined;
  const firstTask = scheduler.enqueue({
    ...first.job,
    run: (abort) => { signal = abort; return first.pending.promise; },
  });
  const secondTask = scheduler.enqueue(second.job);
  const otherTask = scheduler.enqueue(other.job);
  scheduler.cancelSession("a");
  assert.equal(await firstTask.done, "cancelled");
  assert.equal(await secondTask.done, "cancelled");
  assert.equal(signal?.aborted, true);
  first.pending.resolve();
  await flush();
  assert.deepEqual(scheduler.stats(), { active: 1, queued: 0 });
  otherTask.cancel();
});
