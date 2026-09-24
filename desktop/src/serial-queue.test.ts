import assert from "node:assert/strict";
import test from "node:test";
import { SerialQueue } from "./serial-queue.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("two overlapping writes that read before writing both survive", async () => {
  const queue = new SerialQueue();
  let store: string[] = [];
  const add = (id: string) => queue.run(async () => {
    const current = [...store];
    await settle();
    store = [...current, id];
  });
  await Promise.all([add("a"), add("b")]);
  assert.deepEqual(store, ["a", "b"]);
});

test("a rejected operation reaches its caller and does not stall later work", async () => {
  const queue = new SerialQueue();
  const order: string[] = [];
  const failed = queue.run(async () => {
    order.push("failed");
    throw new Error("boom");
  });
  const after = queue.run(async () => {
    order.push("after");
    return 7;
  });
  await assert.rejects(failed, /boom/);
  assert.equal(await after, 7);
  assert.deepEqual(order, ["failed", "after"]);
});

test("the queue stays usable after a rejection", async () => {
  const queue = new SerialQueue();
  await assert.rejects(queue.run(async () => {
    throw new Error("nope");
  }), /nope/);
  assert.equal(await queue.run(async () => 1), 1);
});
