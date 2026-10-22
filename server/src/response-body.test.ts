import assert from "node:assert/strict";
import test from "node:test";
import { cancelResponseBody, readLimitedBody, ResponseTooLargeError } from "./response-body.js";

const MiB = 1024 * 1024;
const chunk = new Uint8Array(MiB);

function streamed(chunks: number, options: {
  contentLength?: string;
  cancelPending?: boolean;
  onPull?: () => void;
  onCancel?: () => void;
} = {}) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) { controller.close(); return; }
      pulled += 1;
      options.onPull?.();
      controller.enqueue(chunk);
    },
    cancel() {
      options.onCancel?.();
      if (options.cancelPending) return new Promise<void>(() => undefined);
    },
  });
  const headers = options.contentLength === undefined ? undefined : { "content-length": options.contentLength };
  return { response: new Response(body, { headers }), pulled: () => pulled };
}

test("a declared body over the limit is cancelled before it is read", async () => {
  let pulled = 0;
  let cancelled = false;
  const source = streamed(1, {
    contentLength: String(4 * MiB + 1),
    cancelPending: true,
    onPull: () => { pulled += 1; },
    onCancel: () => { cancelled = true; },
  });

  await assert.rejects(readLimitedBody(source.response, 4 * MiB), ResponseTooLargeError);
  assert.equal(source.pulled(), 0);
  assert.equal(pulled, 0);
  assert.equal(cancelled, true);
});

test("an absent length is enforced while reading", async () => {
  const source = streamed(6);
  await assert.rejects(readLimitedBody(source.response, 4 * MiB), ResponseTooLargeError);
});

test("a lying-low length is enforced while reading", async () => {
  const source = streamed(6, { contentLength: "1" });
  await assert.rejects(readLimitedBody(source.response, 4 * MiB), ResponseTooLargeError);
});

test("an invalid length does not bypass the streaming limit", async () => {
  const source = streamed(6, { contentLength: "not-a-length" });
  await assert.rejects(readLimitedBody(source.response, 4 * MiB), ResponseTooLargeError);
});

test("a body at the exact limit is accepted", async () => {
  const source = streamed(4, { contentLength: String(4 * MiB) });
  const data = await readLimitedBody(source.response, 4 * MiB);
  assert.equal(data.length, 4 * MiB);
});

test("overflow cancels immediately without waiting for a hanging cancellation", async () => {
  let cancelled = false;
  const source = streamed(20, {
    cancelPending: true,
    onCancel: () => { cancelled = true; },
  });

  await assert.rejects(readLimitedBody(source.response, 4 * MiB), ResponseTooLargeError);
  assert.equal(cancelled, true);
  assert.ok(source.pulled() < 20, `the source stopped after ${source.pulled()} chunks`);
});

test("a reader timeout is rethrown after cancellation rather than becoming a size error", async () => {
  let cancelled = false;
  const failure = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const body = {
    getReader: () => ({
      read: async () => { throw failure; },
      cancel: async () => { cancelled = true; },
    }),
  } as unknown as ReadableStream<Uint8Array>;
  const response = { body, headers: new Headers() } as unknown as Response;

  await assert.rejects(readLimitedBody(response, MiB), (error: unknown) => error === failure);
  assert.equal(cancelled, true);
});

test("an aborted read cancels a blocked body without waiting for its cancellation", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start() {},
    cancel() {
      cancelled = true;
      return new Promise<void>(() => undefined);
    },
  });
  const controller = new AbortController();
  const reading = readLimitedBody(new Response(body), 4 * MiB, controller.signal);
  controller.abort();

  await assert.rejects(reading, (error: unknown) =>
    error instanceof DOMException && error.name === "AbortError");
  assert.equal(cancelled, true);
});

test("a rejected response body is cancelled without being awaited", () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start() {},
    cancel() {
      cancelled = true;
      return new Promise<void>(() => undefined);
    },
  }));

  cancelResponseBody(response);
  assert.equal(cancelled, true);
});

test("a null body is empty", async () => {
  const data = await readLimitedBody(new Response(null), 4 * MiB);
  assert.equal(data.length, 0);
});
