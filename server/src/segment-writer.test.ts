import assert from "node:assert/strict";
import test from "node:test";
import { SegmentWriter } from "./segment-writer.js";

const chunk = (index: number, size = 16 * 1024) => Buffer.alloc(size, index % 251);

test("chunks that arrive while the disk is busy go out together in fewer writes", async () => {
  const writes: Array<{ at: number; bytes: number }> = [];
  const disk = Buffer.alloc(100 * 16 * 1024);
  let reported = 0;
  const writer = new SegmentWriter(0, async (block, at) => {
    writes.push({ at, bytes: block.length });
    await new Promise((resolve) => setTimeout(resolve, 5));
    block.copy(disk, at);
  }, (bytes) => { reported += bytes; });
  const expected = Buffer.concat(Array.from({ length: 100 }, (_, index) => chunk(index)));
  for (let index = 0; index < 100; index += 1) {
    await writer.push(chunk(index));
    if (index % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await writer.settle();
  assert.ok(writes.length < 25, `${writes.length} writes for 100 chunks`);
  assert.equal(reported, expected.length, "every byte is reported once, after it is written");
  assert.ok(disk.equals(expected), "the bytes land in order at their positions");
  let position = 0;
  for (const write of writes) { assert.equal(write.at, position); position += write.bytes; }
});

test("only written bytes are reported, and settle writes what is still queued", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reported = 0;
  const writer = new SegmentWriter(1000, async () => { await gate; }, (bytes) => { reported += bytes; });
  await writer.push(chunk(1, 100));
  await writer.push(chunk(2, 100));
  assert.equal(reported, 0, "nothing counts before the disk has it");
  release();
  await writer.settle();
  assert.equal(reported, 200);
});

test("a disk that cannot keep up holds the transfer back at the limit", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const writer = new SegmentWriter(0, async () => { await gate; }, () => {}, 32 * 1024);
  await writer.push(chunk(0)); // taken by the first write, which hangs on the disk
  await writer.push(chunk(1)); // 16 KiB waiting: below the limit, the transfer goes on
  let held = true;
  const third = writer.push(chunk(2)).then(() => { held = false; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(held, true, "the push that reaches the limit waits for the disk");
  release();
  await third;
  await writer.settle();
});

test("a failed write is thrown to the transfer and nothing after it is reported", async () => {
  let reported = 0;
  const writer = new SegmentWriter(0, async () => { throw new Error("disk full"); }, (bytes) => { reported += bytes; });
  await writer.push(chunk(0));
  await assert.rejects(writer.settle(), /disk full/);
  await assert.rejects(writer.push(chunk(1)), /disk full/);
  assert.equal(reported, 0);
});
