import assert from "node:assert/strict";
import test from "node:test";
import { SerialQueue } from "./serial-queue.js";
import { StartGate, StartYieldedError, type StartableBackend } from "./start-gate.js";

/** A backend whose start waits until it is aborted or told to finish, and counts both. */
const backend = () => {
  let finish!: (value: string) => void;
  let fail!: (error: Error) => void;
  const stub = {
    starts: 0,
    aborts: 0,
    start(): Promise<string> {
      stub.starts += 1;
      return new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
    },
    abortStart(): void {
      stub.aborts += 1;
      fail?.(new Error("cancelled"));
    },
    finish: (value: string) => finish(value),
  };
  return stub satisfies StartableBackend<string>;
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

test("a settings change ends the start in flight and then has its turn", async () => {
  const gate = new StartGate();
  const queue = new SerialQueue();
  const local = backend();
  const started = queue.run(() => gate.start(local));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const changed = gate.runFromSettings(queue, async () => "stored");
  await assert.rejects(started, /cancelled/);
  assert.equal(await changed, "stored");
  assert.equal(local.aborts, 1);
});

test("a start that would begin while a settings change waits gives way to it", async () => {
  const gate = new StartGate();
  const queue = new SerialQueue();
  const local = backend();
  // A restart: the old child is still stopping when the settings change asks for the queue.
  const stopping = deferred();
  const restart = queue.run(async () => {
    await stopping.promise;
    return gate.start(local);
  });
  const changed = gate.runFromSettings(queue, async () => "stored");
  stopping.resolve();
  await assert.rejects(restart, StartYieldedError);
  assert.equal(await changed, "stored");
  assert.equal(local.starts, 0);
});

test("a start after the settings change has had its turn begins as usual", async () => {
  const gate = new StartGate();
  const queue = new SerialQueue();
  await gate.runFromSettings(queue, async () => "stored");
  const local = backend();
  const started = queue.run(() => gate.start(local));
  await new Promise<void>((resolve) => setImmediate(resolve));
  local.finish("running");
  assert.equal(await started, "running");
});

test("a settings change that fails still lets the next start begin", async () => {
  const gate = new StartGate();
  const queue = new SerialQueue();
  await assert.rejects(gate.runFromSettings(queue, async () => { throw new Error("disk full"); }), /disk full/);
  const local = backend();
  const started = queue.run(() => gate.start(local));
  await new Promise<void>((resolve) => setImmediate(resolve));
  local.finish("running");
  assert.equal(await started, "running");
});

test("a backend whose start has finished is not aborted", async () => {
  const gate = new StartGate();
  const local = backend();
  const started = gate.start(local);
  local.finish("running");
  await started;
  gate.abort();
  assert.equal(local.aborts, 0);
});
