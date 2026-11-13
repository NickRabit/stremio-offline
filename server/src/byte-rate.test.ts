import assert from "node:assert/strict";
import test from "node:test";
import { ByteRateLimiter } from "./byte-rate.js";

const MB = 1024 * 1024;
const signalOf = () => new AbortController().signal;

test("an unlimited rate never sleeps", async () => {
  for (const rate of [0, -5]) {
    let slept = 0;
    const limiter = new ByteRateLimiter(() => rate, () => 0, async (ms) => { slept += ms; });
    await limiter.take(50 * MB, signalOf());
    assert.equal(slept, 0);
  }
});

test("at 1 MB/s, taking 3 MB in 64 KiB chunks sleeps for about 2 s", async () => {
  const rate = MB;
  let now = 0;
  let slept = 0;
  const limiter = new ByteRateLimiter(() => rate, () => now, async (ms) => {
    slept += ms;
    now += ms;
  });
  const signal = signalOf();
  const chunk = 64 * 1024;
  for (let left = 3 * MB; left > 0; left -= chunk) await limiter.take(Math.min(chunk, left), signal);
  // The bucket starts full, so the first megabyte is free and the other two wait.
  assert.ok(Math.abs(slept - 2000) < 1, `slept ${slept} ms`);
});

test("a rate change clamps the balance and the next take uses the new rate", async () => {
  let rate = 2 * MB;
  let now = 0;
  let slept = 0;
  const limiter = new ByteRateLimiter(() => rate, () => now, async (ms) => {
    slept += ms;
    now += ms;
  });
  const signal = signalOf();
  await limiter.take(MB, signal);
  assert.equal(slept, 0, "a full bucket covers the first megabyte");

  rate = 512 * 1024;
  await limiter.take(512 * 1024, signal);
  assert.equal(slept, 0, "the leftover balance is clamped down to the new capacity");

  rate = MB;
  await limiter.take(MB, signal);
  assert.ok(Math.abs(slept - 1000) < 1, `the next take waits at the new rate, slept ${slept} ms`);

  // An idle second refills one second of capacity, so a source slower than the cap is not delayed again.
  now += 1000;
  const afterRefill = slept;
  await limiter.take(MB, signal);
  assert.equal(slept, afterRefill);

  rate = 0;
  await limiter.take(10 * MB, signal);
  assert.equal(slept, afterRefill, "dropping the limit removes the wait immediately");
  rate = MB;
  await limiter.take(MB, signal);
  assert.equal(slept, afterRefill, "the first take after a limit is imposed starts from a full bucket");
});

test("an aborted take rejects with the signal reason and leaves no timer", async () => {
  const limiter = new ByteRateLimiter(() => 1_000);
  const controller = new AbortController();
  const signal = controller.signal;
  await limiter.take(64 * 1024, signal);

  const pending = new Set<unknown>();
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const timer = originalSet(handler, timeout, ...args);
    pending.add(timer);
    return timer;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    pending.delete(timer);
    originalClear(timer);
  }) as typeof globalThis.clearTimeout;
  try {
    const reason = new Error("stopped");
    const waiting = limiter.take(64 * 1024, signal);
    await Promise.resolve();
    assert.equal(pending.size, 1, "the overdraft is waiting on one timer");
    controller.abort(reason);
    await assert.rejects(waiting, (error: unknown) => {
      assert.equal(error, reason);
      return true;
    });
    assert.equal(pending.size, 0, "abort clears the timer");
  } finally {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
    controller.abort();
  }
});
