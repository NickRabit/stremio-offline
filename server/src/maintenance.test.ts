import assert from "node:assert/strict";
import { test } from "node:test";
import { createMaintenance, type MaintenanceTask } from "./maintenance.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Everything `log` mirrors to stdout while `run` does its work. */
const captureStdout = async <T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> => {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { return { result: await run(), lines }; }
  finally { process.stdout.write = original; }
};

test("run executes the tasks in order, logs a failure and still runs the next", async () => {
  const order: string[] = [];
  const tasks: MaintenanceTask[] = [
    { name: "one", run: async () => { order.push("one"); } },
    { name: "boom", run: async () => { order.push("boom"); throw new Error("nope"); } },
    { name: "two", run: async () => { order.push("two"); } },
  ];
  const maintenance = createMaintenance({ tasks });
  const { lines } = await captureStdout(async () => {
    await maintenance.run();
    assert.deepEqual(order, ["one", "boom", "two"]);
    order.length = 0;
    // Never rejects, and the later pass still runs every task.
    await maintenance.run();
  });
  assert.deepEqual(order, ["one", "boom", "two"]);
  assert.ok(lines.some((line) => line.includes("A maintenance task failed") && line.includes("boom")),
    "the failing task is named in the log");
});

test("two overlapping passes share the one run", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started = 0;
  const maintenance = createMaintenance({ tasks: [{ name: "slow", run: async () => { started += 1; await gate; } }] });
  const first = maintenance.run();
  const second = maintenance.run();
  assert.equal(first, second, "the running pass is handed back");
  release();
  await Promise.all([first, second]);
  assert.equal(started, 1, "each task ran once");
});

test("start schedules passes on its own, never overlapping, and stop ends them", async () => {
  let passes = 0;
  let running = 0;
  let peak = 0;
  const signals: AbortSignal[] = [];
  const maintenance = createMaintenance({
    firstDelayMs: 5,
    intervalMs: 8,
    tasks: [{
      name: "pass",
      run: async (signal) => {
        signals.push(signal);
        passes += 1;
        running += 1;
        peak = Math.max(peak, running);
        await sleep(20);
        running -= 1;
      },
    }],
  });

  // The armed timer has to be unref'd or a plain child process would stay alive for it.
  const armed: NodeJS.Timeout[] = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const timer = realSetTimeout(handler, ms, ...args) as unknown as NodeJS.Timeout;
    armed.push(timer);
    return timer;
  }) as unknown as typeof setTimeout;
  maintenance.start();
  globalThis.setTimeout = realSetTimeout;
  assert.ok(armed.length > 0, "start armed a timer");
  assert.ok(armed.every((timer) => timer.hasRef() === false), "the maintenance timer is unref'd");

  await sleep(150);
  assert.ok(passes >= 2, "passes run without a request");
  assert.equal(peak, 1, "a pass that outlasts the interval does not overlap itself");

  await maintenance.stop();
  assert.ok(signals.at(-1)!.aborted, "stop aborts the signal the tasks were given");
  const stopped = passes;
  await sleep(6 * 8);
  assert.equal(passes, stopped, "no pass starts after stop");
});

test("stop resolves within the grace even when a task ignores the signal", async () => {
  let began = false;
  let signal: AbortSignal | undefined;
  const maintenance = createMaintenance({
    firstDelayMs: 1,
    intervalMs: 1_000,
    tasks: [{
      name: "stubborn",
      run: async (given) => {
        began = true;
        signal = given;
        await sleep(150);
      },
    }],
  });
  maintenance.start();
  while (!began) await sleep(1);
  const before = Date.now();
  await maintenance.stop(30);
  assert.ok(Date.now() - before < 140, "stop waits no longer than the grace period");
  assert.ok(signal!.aborted, "the signal is aborted even though the task ignored it");
});
