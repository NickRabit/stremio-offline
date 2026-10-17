import assert from "node:assert/strict";
import { test } from "node:test";
import { RangeNotSatisfiable, RemoteReadAhead, UnexpectedAnswer, type OpenRange } from "./remote-read-ahead.js";

const SIZE = 64;
const file = Buffer.from(Array.from({ length: SIZE }, (_, index) => index));

const ranged = (opens: string[]): OpenRange => async (range) => {
  opens.push(range);
  const [, from, to] = /^bytes=(\d+)-(\d*)$/.exec(range)!;
  const start = Number(from);
  const end = Math.min(to ? Number(to) : SIZE - 1, SIZE - 1);
  return new Response(file.subarray(start, end + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${SIZE}` } });
};

const drain = async (reader: RemoteReadAhead, key: string, from: number, until: number): Promise<Buffer> => {
  const block = reader.find(key, from)!;
  const parts: Buffer[] = [];
  for await (const piece of reader.read(block, from, until)) parts.push(piece);
  return Buffer.concat(parts);
};

test("a block is read once and answers every offset inside it", async () => {
  const opens: string[] = [];
  const reader = new RemoteReadAhead(16, 1024);
  await reader.fill("film", 8, ranged(opens));
  assert.deepEqual(await drain(reader, "film", 10, 20), file.subarray(10, 20));
  assert.deepEqual(await drain(reader, "film", 23, 30), file.subarray(23, 24), "a read stops at the end of the block");
  assert.equal(reader.find("film", 24), undefined);
  assert.equal(reader.find("film", 7), undefined);
  assert.equal(reader.find("other", 10), undefined, "a block never answers another source");
  assert.deepEqual(opens, ["bytes=8-23"]);
});

test("the least recently read blocks give way once the budget is spent", async () => {
  let now = 0;
  const reader = new RemoteReadAhead(16, 32, 60_000, 30_000, () => now);
  const open = ranged([]);
  for (const offset of [0, 16, 32]) {
    now += 1;
    await reader.fill("film", offset, open);
    await drain(reader, "film", offset, offset + 16);
  }
  assert.equal(reader.size, 32);
  assert.equal(reader.find("film", 0), undefined);
  assert.ok(reader.find("film", 40));
});

test("an expired block is read again", async () => {
  let now = 0;
  const reader = new RemoteReadAhead(16, 1024, 1_000, 30_000, () => now);
  await reader.fill("film", 0, ranged([]));
  await drain(reader, "film", 0, 16);
  now = 1_001;
  assert.equal(reader.find("film", 0), undefined);
  assert.equal(reader.size, 0);
});

test("a refused or foreign answer is never kept", async () => {
  const reader = new RemoteReadAhead(16, 1024);
  await assert.rejects(reader.fill("film", 99, async () => new Response(null, { status: 416, headers: { "content-range": "bytes */64" } })), RangeNotSatisfiable);
  await assert.rejects(reader.fill("film", 0, async () => new Response(file, { status: 200 })), UnexpectedAnswer);
  await assert.rejects(reader.fill("film", 4, async () => new Response(file, { status: 206, headers: { "content-range": "bytes 0-63/64" } })), UnexpectedAnswer);
  assert.equal(reader.find("film", 4), undefined);
});

test("a read that breaks off fails its readers and leaves nothing behind", async () => {
  const reader = new RemoteReadAhead(16, 1024);
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(file.subarray(0, 4))); controller.error(new Error("reset")); },
  });
  const block = await reader.fill("film", 0, async () => new Response(body, { status: 206, headers: { "content-range": "bytes 0-15/64" } }));
  await assert.rejects(async () => { for await (const _piece of reader.read(block, 0, 16)) { /* drained */ } });
  assert.equal(reader.find("film", 0), undefined);
  assert.equal(reader.size, 0);
});
