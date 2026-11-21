import assert from "node:assert/strict";
import test from "node:test";
import { SlotGate } from "./slot-gate.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

test("waiters run in arrival order once a slot frees", async () => {
  const gate = new SlotGate(1);
  const order: number[] = [];
  const first = deferred();
  const running = gate.run(async () => { order.push(0); await first.promise; });
  const rest = [1, 2, 3].map((index) => gate.run(async () => { order.push(index); }));
  assert.equal(gate.queued, 3);
  first.resolve();
  await Promise.all([running, ...rest]);
  assert.deepEqual(order, [0, 1, 2, 3]);
  assert.equal(gate.running, 0);
});

test("an aborted waiter leaves the queue and never runs", async () => {
  const gate = new SlotGate(1);
  const hold = deferred();
  const running = gate.run(() => hold.promise);
  const controller = new AbortController();
  let ran = false;
  const waiting = gate.run(async () => { ran = true; }, controller.signal);
  controller.abort();
  await assert.rejects(waiting);
  assert.equal(gate.queued, 0);
  hold.resolve();
  await running;
  assert.equal(ran, false);
  assert.equal(gate.running, 0);
});

test("a failing call still gives its slot back", async () => {
  const gate = new SlotGate(1);
  await assert.rejects(gate.run(async () => { throw new Error("boom"); }));
  assert.equal(gate.running, 0);
  assert.equal(await gate.run(async () => 7), 7);
});

test("a signal already aborted is refused before taking a slot", async () => {
  const gate = new SlotGate(1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(gate.run(async () => undefined, controller.signal));
  assert.equal(gate.running, 0);
});
