import assert from "node:assert/strict";
import { test } from "node:test";
import { OriginalQuota } from "./media-server-quota.js";
import { MediaServerError } from "./media-server-types.js";

const busy = (error: unknown): boolean =>
  error instanceof MediaServerError && error.code === "busy";

const body = (size: number, chunkSize = 64 * 1024): Response => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    for (let offset = 0; offset < size; offset += chunkSize) {
      controller.enqueue(new Uint8Array(Math.min(chunkSize, size - offset)));
    }
    controller.close();
  },
}));

test("a stream limit refuses the next distinct source and always admits an open one", () => {
  const quota = new OriginalQuota();
  const first = quota.reserve("connection-1", "user-1:item-1:source-1", { streamLimit: 1 });
  const same = quota.reserve("connection-1", "user-1:item-1:source-1", { streamLimit: 1 });
  assert.throws(
    () => quota.reserve("connection-1", "user-1:item-2:source-2", { streamLimit: 1 }),
    busy,
  );
  same.release();
  first.release();
  const next = quota.reserve("connection-1", "user-1:item-2:source-2", { streamLimit: 1 });
  next.release();
});

test("body completion, upstream errors, cancellation, abort, no body and explicit release free the slot", async () => {
  const quota = new OriginalQuota();
  const signal = new AbortController();

  const ended = quota.reserve("connection-1", "ended", { streamLimit: 1 });
  assert.equal((await ended.wrap(body(16), signal.signal).text()).length, 16);
  const afterEnd = quota.reserve("connection-1", "after-end", { streamLimit: 1 });
  afterEnd.release();

  const failed = quota.reserve("connection-1", "failed", { streamLimit: 1 });
  const failedBody = new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(new Error("upstream failed")); },
  });
  await assert.rejects(failed.wrap(new Response(failedBody), signal.signal).arrayBuffer(), /upstream failed/);
  const afterFailure = quota.reserve("connection-1", "after-failure", { streamLimit: 1 });
  afterFailure.release();

  const cancelled = quota.reserve("connection-1", "cancelled", { streamLimit: 1 });
  const cancelledReader = cancelled.wrap(new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(1)); },
  })), signal.signal).body!.getReader();
  assert.equal((await cancelledReader.read()).done, false);
  await cancelledReader.cancel();
  const afterCancel = quota.reserve("connection-1", "after-cancel", { streamLimit: 1 });
  afterCancel.release();

  const aborted = quota.reserve("connection-1", "aborted", { streamLimit: 1 });
  aborted.wrap(new Response(new ReadableStream<Uint8Array>({ pull: async () => undefined })), signal.signal);
  signal.abort();
  const afterAbort = quota.reserve("connection-1", "after-abort", { streamLimit: 1 });
  afterAbort.release();

  const empty = quota.reserve("connection-1", "empty", { streamLimit: 1 });
  empty.wrap(new Response(null, { status: 204 }), signal.signal);
  const afterEmpty = quota.reserve("connection-1", "after-empty", { streamLimit: 1 });
  afterEmpty.release();

  const explicit = quota.reserve("connection-1", "explicit", { streamLimit: 1 });
  explicit.release();
  explicit.release();
  const afterExplicit = quota.reserve("connection-1", "after-explicit", { streamLimit: 1 });
  afterExplicit.release();
});

test("pacing limits one source to the account bitrate, including concurrent bodies", async () => {
  let now = 0;
  let slept = 0;
  const quota = new OriginalQuota({
    clock: () => now,
    sleep: async (ms, signal) => {
      if (signal.aborted) throw signal.reason;
      slept += ms;
      now += ms;
    },
  });
  const signal = new AbortController();
  const first = quota.reserve("connection-1", "source", { bitrateLimit: 8_000_000 });
  await first.wrap(body(4 * 1024 * 1024), signal.signal).arrayBuffer();
  assert.ok(slept >= 2_900, `expected at least 2.9s of pacing, got ${slept}ms`);

  slept = 0;
  now = 0;
  const a = quota.reserve("connection-2", "source", { bitrateLimit: 8_000_000 });
  const b = quota.reserve("connection-2", "source", { bitrateLimit: 8_000_000 });
  await Promise.all([
    a.wrap(body(2 * 1024 * 1024), signal.signal).arrayBuffer(),
    b.wrap(body(2 * 1024 * 1024), signal.signal).arrayBuffer(),
  ]);
  assert.ok(slept >= 2_900, `expected the shared budget to pace both bodies, got ${slept}ms`);

  slept = 0;
  const unlimited = quota.reserve("connection-3", "source", {});
  await unlimited.wrap(body(4 * 1024 * 1024), signal.signal).arrayBuffer();
  assert.equal(slept, 0);
});

test("sequential bodies of one source keep their pacing debt", async () => {
  let now = 0;
  let slept = 0;
  const quota = new OriginalQuota({
    clock: () => now,
    sleep: async (ms, signal) => {
      if (signal.aborted) throw signal.reason;
      slept += ms;
      now += ms;
    },
  });
  const signal = new AbortController();
  for (let index = 0; index < 8; index += 1) {
    const slot = quota.reserve("connection-1", "source", { bitrateLimit: 8_000_000 });
    await slot.wrap(body(1024 * 1024), signal.signal).arrayBuffer();
  }
  assert.ok(slept >= 7_300, `expected sequential ranges to stay paced, got ${slept}ms`);
});

test("forgetting a connection cannot let an old slot release wipe the new slot map", () => {
  const quota = new OriginalQuota();
  const old = quota.reserve("connection-1", "old", { streamLimit: 1 });
  quota.forget("connection-1");
  const current = quota.reserve("connection-1", "current", { streamLimit: 1 });
  old.release();
  assert.throws(
    () => quota.reserve("connection-1", "next", { streamLimit: 1 }),
    busy,
  );
  current.release();
});

test("an idle pacer held by a paused body is kept, so a second body of the source shares it", async () => {
  let now = 0;
  let slept = 0;
  const quota = new OriginalQuota({
    clock: () => now,
    sleep: async (ms) => { slept += ms; now += ms; },
  });
  const signal = new AbortController();
  const chunk = 64 * 1024;
  let sent = 0;
  // Delivers 64 KiB at a time, but only up to `allowed` bytes until told to go on.
  let allowed = chunk;
  let resume: (() => void) | undefined;
  const pausing = new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent >= 2 * 1024 * 1024) return controller.close();
      while (sent >= allowed) await new Promise<void>((go) => { resume = go; });
      sent += chunk;
      controller.enqueue(new Uint8Array(chunk));
    },
  }));
  const first = quota.reserve("connection-1", "source", { bitrateLimit: 8_000_000 });
  const reader = first.wrap(pausing, signal.signal).body!.getReader();
  await reader.read();
  now += 60_000;
  const second = quota.reserve("connection-1", "source", { bitrateLimit: 8_000_000 });
  slept = 0;
  allowed = Number.MAX_SAFE_INTEGER;
  resume?.();
  const drain = async () => { while (!(await reader.read()).done) { /* drain */ } };
  await Promise.all([drain(), second.wrap(body(2 * 1024 * 1024), signal.signal).arrayBuffer()]);
  assert.ok(slept >= 2_700, `both bodies must share one pacer, got ${slept}ms`);
});
