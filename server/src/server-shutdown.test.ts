import assert from "node:assert/strict";
import { test } from "node:test";
import { createShutdown, installSignalHandlers, type ShutdownDeps } from "./server-shutdown.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A timer the test fires by hand, so the bounded waits cost no real time and their bound can
 *  be read back. */
class FakeTimers {
  readonly pending: Array<{ callback: () => void; ms: number; fired: boolean }> = [];
  setTimer = (callback: () => void, ms: number) => {
    this.pending.push({ callback, ms, fired: false });
    return { unref() {} };
  };
  fireNext() {
    const entry = this.pending.find((item) => !item.fired);
    assert.ok(entry, "a bounded wait was armed");
    entry.fired = true;
    entry.callback();
  }
}

const buildShutdown = (overrides: Partial<ShutdownDeps> = {}) => {
  const order: string[] = [];
  const timers = new FakeTimers();
  let drains = 0;
  const deps: ShutdownDeps = {
    inFlight: { active: () => 0, drained: async () => { drains += 1; order.push(drains === 1 ? "drain" : "late-drain"); return true; } },
    maintenance: { stop: async () => { order.push("maintenance"); } },
    followService: { stop: async () => { order.push("follow"); } },
    killRunningMedia: () => { order.push("kill"); return 0; },
    flushes: [() => { order.push("flush-a"); return Promise.resolve(); }, () => { order.push("flush-b"); return Promise.resolve(); }],
    lateFlushes: [],
    store: { flush: async () => { order.push("store-flush"); } },
    closeStorage: async () => { order.push("close-storage"); },
    flushLog: async () => { order.push("log-flush"); },
    log: () => {},
    now: () => 0,
    setTimer: timers.setTimer,
    ...overrides,
  };
  return { shutdown: createShutdown(deps), order, timers };
};

test("the shutdown runs every step in order", async () => {
  const order: string[] = [];
  const timers = new FakeTimers();
  let activeCalls = 0;
  let drains = 0;
  const shutdown = createShutdown({
    inFlight: { active: () => { activeCalls += 1; return activeCalls === 1 ? 1 : 0; }, drained: async () => { drains += 1; order.push(drains === 1 ? "drain" : "late-drain"); return true; } },
    maintenance: { stop: async () => { order.push("maintenance"); } },
    followService: { stop: async () => { order.push("follow"); } },
    killRunningMedia: () => { order.push("kill"); return 1; },
    flushes: [() => { order.push("flush-a"); return Promise.resolve(); }],
    lateFlushes: [],
    store: { flush: async () => { order.push("store-flush"); } },
    closeStorage: async () => { order.push("close-storage"); },
    flushLog: async () => { order.push("log-flush"); },
    log: () => {},
    now: () => 0,
    setTimer: timers.setTimer,
  });
  await shutdown("SIGTERM");
  assert.deepEqual(order, [
    "drain", "maintenance", "follow", "kill",
    "store-flush", "flush-a", "late-drain", "store-flush", "store-flush", "close-storage", "log-flush",
  ]);
});

test("a follow service that never settles costs at most its one-second bound", async () => {
  const { shutdown, order, timers } = buildShutdown({
    followService: { stop: () => new Promise<void>(() => {}) },
  });
  const run = shutdown("SIGTERM");
  await tick();
  assert.equal(timers.pending.length, 1, "the follow service was given a bound");
  assert.ok(timers.pending[0].ms <= 1_000, "the bound is at most a second");
  timers.fireNext();
  await run;
  assert.ok(!order.includes("follow"), "the stuck stop never finished");
  assert.deepEqual(order, ["drain", "maintenance", "kill", "store-flush", "flush-a", "flush-b", "store-flush", "close-storage", "log-flush"]);
});

test("a flush that rejects neither stops the other flushes nor the log flush", async () => {
  const { shutdown, order } = buildShutdown({
    flushes: [
      () => { order.push("flush-a"); return Promise.resolve(); },
      () => { order.push("flush-b"); return Promise.reject(new Error("no space left")); },
      () => { order.push("flush-c"); return Promise.resolve(); },
    ],
  });
  await shutdown("SIGTERM");
  assert.ok(order.includes("store-flush") && order.includes("flush-a") && order.includes("flush-c"), "the other flushes ran");
  assert.ok(order.includes("log-flush"), "the log was still flushed");
  assert.equal(order.at(-1), "log-flush");
});

test("a request that queues a save during the first flush is written before storage closes", async () => {
  let active = 0;
  let releaseFirstFlush!: () => void;
  const firstFlush = new Promise<void>((resolve) => { releaseFirstFlush = resolve; });
  const { shutdown, order } = buildShutdown({
    inFlight: {
      active: () => active,
      drained: async () => {
        if (active > 0) {
          order.push("late-drain");
          active = 0;
        } else {
          order.push("drain");
        }
        return true;
      },
    },
    flushes: [() => {
      order.push("first-flush");
      active = 1;
      return firstFlush;
    }],
    lateFlushes: [() => { order.push("late-flush"); return Promise.resolve(); }],
    closeStorage: async () => { order.push("close-storage"); },
  });

  const running = shutdown("SIGTERM");
  await tick();
  assert.ok(order.includes("first-flush"));
  releaseFirstFlush();
  await running;

  assert.equal(order.filter((entry) => entry === "late-flush").length, 2, "the late store is flushed during and after the drain");
  assert.equal(order.filter((entry) => entry === "close-storage").length, 1, "storage closes once");
  assert.ok(order.lastIndexOf("late-flush") < order.indexOf("close-storage"));
  assert.ok(order.indexOf("close-storage") < order.indexOf("log-flush"));
});

test("installSignalHandlers runs the shutdown on the first signal, ignores the rest and exits zero", async () => {
  const handlers = new Map<string, () => void>();
  const exits: number[] = [];
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  installSignalHandlers(
    async () => { runs += 1; await gate; },
    (code) => { exits.push(code ?? -1); },
    (signal, handler) => { handlers.set(signal, handler); },
  );
  assert.deepEqual([...handlers.keys()].sort(), ["SIGINT", "SIGTERM"]);
  handlers.get("SIGTERM")!();
  assert.equal(runs, 1);
  handlers.get("SIGTERM")!();
  handlers.get("SIGINT")!();
  await tick();
  assert.equal(runs, 1, "a second signal during the shutdown is ignored");
  assert.deepEqual(exits, [], "nothing exits before the shutdown finishes");
  release();
  await tick();
  assert.deepEqual(exits, [0]);
});
