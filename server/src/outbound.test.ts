import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppError } from "./errors.js";
import { flushLog, initLogger } from "./logger.js";
import { GuardRejection, OutboundError, OutboundGuard, configFromEnv, metadataConfigFromEnv, retryAfterMs } from "./outbound.js";

process.env.LOG_STDOUT = "0";
await initLogger(await mkdtemp(path.join(os.tmpdir(), "stremio-outbound-")));

const config = (overrides: Partial<ReturnType<typeof configFromEnv>> = {}) => ({
  enabled: true, maxConcurrent: 2, minIntervalMs: 0, maxQueue: 4,
  failureThreshold: 3, cooldownMs: 30_000, maxCooldownMs: 120_000, countTimeoutsAsFailure: true, ...overrides,
});

/** Guard driven by a clock the test moves by hand, so no case has to wait in real time. */
function harness(overrides: Partial<ReturnType<typeof configFromEnv>> = {}) {
  let now = 1_000_000;
  const guard = new OutboundGuard(config(overrides), () => now, async () => undefined);
  return { guard, advance: (ms: number) => { now += ms; } };
}

const reply = (status: number, headers: Record<string, string> = {}) =>
  async () => new Response("{}", { status, headers });
const jsonReply = (value: unknown = {}) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const boom = async (): Promise<Response> => { throw new Error("connection refused"); };
/** What AbortSignal.timeout produces -- our own deadline, not the host's trouble. */
const ownTimeout = async (): Promise<Response> => {
  throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
};

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("failures below the threshold keep the host in service", async () => {
  const { guard } = harness();
  for (let attempt = 0; attempt < 2; attempt += 1) await assert.rejects(guard.run("addon.test", boom));
  await assert.rejects(guard.run("addon.test", boom), /connection refused/);
});

test("the breaker opens after the threshold and stops calling the host", async () => {
  const { guard } = harness();
  for (let attempt = 0; attempt < 3; attempt += 1) await assert.rejects(guard.run("addon.test", boom));

  let called = false;
  await assert.rejects(
    guard.run("addon.test", async () => { called = true; return new Response("{}"); }),
    (error: unknown) => error instanceof GuardRejection && /the next attempt is in/.test(error.message),
  );
  assert.equal(called, false);
});

test("a client error is an answer, not an outage", async () => {
  const { guard } = harness();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await guard.run("addon.test", reply(404));
    assert.equal(response.status, 404);
  }
  assert.deepEqual(guard.diagnostics(), []);
});

test("server errors open the breaker", async () => {
  const { guard } = harness();
  for (let attempt = 0; attempt < 3; attempt += 1) assert.equal((await guard.run("addon.test", reply(503))).status, 503);
  await assert.rejects(guard.run("addon.test", reply(200)), GuardRejection);
});

test("our own timeout still takes the addon out of service", async () => {
  const { guard } = harness();
  for (let attempt = 0; attempt < 3; attempt += 1) await assert.rejects(guard.run("addon.test", ownTimeout), /timeout/);
  await assert.rejects(guard.run("addon.test", reply(200)), GuardRejection);
});

test("a guard that counts only the provider's failures ignores our own timeout", async () => {
  const { guard } = harness({ countTimeoutsAsFailure: false });
  for (let attempt = 0; attempt < 5; attempt += 1) await assert.rejects(guard.run("wikidata.test", ownTimeout), /timeout/);
  assert.equal((await guard.run("wikidata.test", reply(200))).status, 200);
});

test("a plain error still opens that guard", async () => {
  const { guard } = harness({ countTimeoutsAsFailure: false });
  for (let attempt = 0; attempt < 3; attempt += 1) await assert.rejects(guard.run("wikidata.test", boom));
  await assert.rejects(guard.run("wikidata.test", reply(200)), GuardRejection);
});

test("a 429 still opens that guard, and Retry-After decides the pause", async () => {
  const { guard, advance } = harness({ countTimeoutsAsFailure: false });
  assert.equal((await guard.run("wikidata.test", reply(429, { "retry-after": "90" }))).status, 429);

  const [entry] = guard.diagnostics();
  assert.equal(entry.state, "open");
  assert.equal(entry.opensInSeconds, 90);

  advance(60_000);
  await assert.rejects(guard.run("wikidata.test", reply(200)), GuardRejection);
  advance(30_000);
  assert.equal((await guard.run("wikidata.test", reply(200))).status, 200);
});

test("a successful trial after the cooldown puts the host back in service", async () => {
  const { guard, advance } = harness();
  for (let attempt = 0; attempt < 3; attempt += 1) await assert.rejects(guard.run("addon.test", boom));

  advance(30_000);
  assert.equal((await guard.run("addon.test", reply(200))).status, 200);
  assert.equal((await guard.run("addon.test", reply(200))).status, 200);
  assert.deepEqual(guard.diagnostics(), []);
});

test("only one request probes a half-open host", async () => {
  const { guard, advance } = harness();
  for (let attempt = 0; attempt < 3; attempt += 1) await assert.rejects(guard.run("addon.test", boom));
  advance(30_000);

  let released = () => {};
  const trial = guard.run("addon.test", () => new Promise<Response>((resolve) => { released = () => resolve(new Response("{}")); }));
  await assert.rejects(guard.run("addon.test", reply(200)), (error: unknown) => error instanceof GuardRejection && /being retried/.test(error.message));
  released();
  await trial;
});

test("a failed trial doubles the cooldown", async () => {
  const { guard, advance } = harness();
  for (let attempt = 0; attempt < 3; attempt += 1) await assert.rejects(guard.run("addon.test", boom));

  advance(30_000);
  await assert.rejects(guard.run("addon.test", boom));
  advance(30_000);
  await assert.rejects(guard.run("addon.test", reply(200)), GuardRejection);

  advance(30_000);
  assert.equal((await guard.run("addon.test", reply(200))).status, 200);
});

test("an interactive call is admitted while the breaker is open, and its success closes it", async () => {
  const { guard } = harness();
  for (let attempt = 0; attempt < 3; attempt += 1) await assert.rejects(guard.run("addon.test", boom));

  assert.equal((await guard.run("addon.test", reply(200), true)).status, 200);
  assert.deepEqual(guard.diagnostics(), []);
});

test("a second interactive call waits while the interactive trial is in flight", async () => {
  const { guard } = harness();
  for (let attempt = 0; attempt < 3; attempt += 1) await assert.rejects(guard.run("addon.test", boom));

  let released = () => {};
  const trial = guard.run("addon.test", () => new Promise<Response>((resolve) => { released = () => resolve(new Response("{}")); }), true);
  await assert.rejects(guard.run("addon.test", reply(200), true), (error: unknown) => error instanceof GuardRejection && /being retried/.test(error.message));
  released();
  await trial;
});

test("a background call still fails fast and leaves the trial slot to the person", async () => {
  const { guard } = harness();
  for (let attempt = 0; attempt < 3; attempt += 1) await assert.rejects(guard.run("addon.test", boom));

  let called = false;
  await assert.rejects(
    guard.run("addon.test", async () => { called = true; return new Response("{}"); }),
    (error: unknown) => error instanceof GuardRejection && /the next attempt is in/.test(error.message),
  );
  assert.equal(called, false);
  assert.equal(guard.diagnostics()[0].state, "open", "the slot is still there for an interactive call");
  assert.equal((await guard.run("addon.test", reply(200), true)).status, 200);
});

test("a failed interactive trial doubles the cooldown", async () => {
  const { guard, advance } = harness();
  for (let attempt = 0; attempt < 3; attempt += 1) await assert.rejects(guard.run("addon.test", boom));

  await assert.rejects(guard.run("addon.test", boom, true), /connection refused/);

  advance(30_000);
  await assert.rejects(guard.run("addon.test", reply(200)), GuardRejection);
  advance(30_000);
  assert.equal((await guard.run("addon.test", reply(200))).status, 200);
});

test("the refusal carries a 503, its key and the retry-after", async () => {
  const { guard } = harness();
  for (let attempt = 0; attempt < 3; attempt += 1) await assert.rejects(guard.run("addon.test", boom));

  await assert.rejects(guard.run("addon.test", reply(200)), (error: unknown) => {
    assert.ok(error instanceof GuardRejection);
    assert.equal(error.status, 503);
    assert.equal(error.messageKey, "err.hostUnavailable");
    assert.equal(error.retryAfterMs, 30_000);
    assert.deepEqual(error.vars, { host: "addon.test", seconds: 30 });
    return true;
  });
});

test("a Retry-After pause outweighs the default cooldown", async () => {
  const { guard, advance } = harness();
  assert.equal((await guard.run("addon.test", reply(429, { "retry-after": "90" }))).status, 429);

  const [entry] = guard.diagnostics();
  assert.equal(entry.state, "open");
  assert.equal(entry.opensInSeconds, 90);

  advance(60_000);
  await assert.rejects(guard.run("addon.test", reply(200)), GuardRejection);
  advance(30_000);
  assert.equal((await guard.run("addon.test", reply(200))).status, 200);
});

test("no more than the configured number of requests reach one host at a time", async () => {
  const { guard } = harness({ maxConcurrent: 2 });
  let active = 0;
  let peak = 0;
  const release: Array<() => void> = [];
  const started = Array.from({ length: 4 }, () => guard.run("addon.test", () => new Promise<Response>((resolve) => {
    active += 1; peak = Math.max(peak, active);
    release.push(() => { active -= 1; resolve(new Response("{}")); });
  })));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, 2);
  while (release.length) release.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  while (release.length) release.shift()!();
  await Promise.all(started);
  assert.equal(peak, 2);
});

test("requests are spaced apart only when a gap is configured", async () => {
  const record = (gap: number) => {
    const waits: number[] = [];
    let now = 1000;
    const guard = new OutboundGuard(config({ minIntervalMs: gap }), () => now, async (ms) => { waits.push(ms); now += ms; });
    return { waits, run: () => Promise.all(Array.from({ length: 3 }, () => guard.run("addon.test", reply(200)))) };
  };

  const spaced = record(200);
  await spaced.run();
  assert.deepEqual(spaced.waits, [200, 200]);

  const immediate = record(0);
  await immediate.run();
  assert.deepEqual(immediate.waits, []);
});

test("hosts do not share a breaker", async () => {
  const { guard } = harness();
  for (let attempt = 0; attempt < 3; attempt += 1) await assert.rejects(guard.run("broken.test", boom));
  assert.equal((await guard.run("healthy.test", reply(200))).status, 200);
});

test("the guard can be switched off entirely", async () => {
  let now = 0;
  const guard = new OutboundGuard(config({ enabled: false }), () => now, async () => undefined);
  for (let attempt = 0; attempt < 5; attempt += 1) await assert.rejects(guard.run("addon.test", boom));
  assert.equal((await guard.run("addon.test", reply(200))).status, 200);
  assert.deepEqual(guard.diagnostics(), []);
});

test("Retry-After is read both as seconds and as a date", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(retryAfterMs("30", now), 30_000);
  assert.equal(retryAfterMs("0", now), undefined);
  assert.equal(retryAfterMs(null, now), undefined);
  assert.equal(retryAfterMs("nonsense", now), undefined);
  assert.equal(retryAfterMs("Thu, 01 Jan 2026 00:01:00 GMT", now), 60_000);
  assert.equal(retryAfterMs("Thu, 01 Jan 2020 00:00:00 GMT", now), undefined);
});

test("the environment falls back to sane defaults", () => {
  const defaults = configFromEnv({});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.maxConcurrent, 8);
  assert.equal(defaults.minIntervalMs, 0);
  assert.equal(defaults.failureThreshold, 5);
  assert.equal(defaults.countTimeoutsAsFailure, true);
  assert.equal(configFromEnv({ ADDON_GUARD: "0" }).enabled, false);
  assert.equal(configFromEnv({ ADDON_MAX_CONCURRENT: "0" }).maxConcurrent, 8);
  assert.equal(configFromEnv({ ADDON_MAX_CONCURRENT: "8" }).maxConcurrent, 8);
  assert.equal(configFromEnv({ ADDON_BREAKER_COOLDOWN_MS: "5" }).cooldownMs, 30_000);
});

test("the metadata guard is slower and does not count our own timeouts", () => {
  const defaults = metadataConfigFromEnv({});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.maxConcurrent, 2);
  assert.equal(defaults.minIntervalMs, 1500);
  assert.equal(defaults.maxQueue, 4);
  assert.equal(defaults.failureThreshold, 3);
  assert.equal(defaults.cooldownMs, 30_000);
  assert.equal(defaults.maxCooldownMs, 300_000);
  assert.equal(defaults.countTimeoutsAsFailure, false);
  assert.equal(metadataConfigFromEnv({ WIKIDATA_GUARD: "0" }).enabled, false);
});

test("aborting a queued runJson removes it and the next waiter takes the slot", async () => {
  const { guard } = harness({ maxConcurrent: 1, maxQueue: 4 });
  let releaseFirst = () => {};
  const first = guard.runJson("queue.test", () => new Promise<Response>((resolve) => {
    releaseFirst = () => resolve(jsonReply());
  }), { deadlineMs: 5_000, maxBytes: 1024 });
  await tick();

  const controller = new AbortController();
  const aborted = guard.runJson("queue.test", () => Promise.resolve(jsonReply()), {
    signal: controller.signal, deadlineMs: 5_000, maxBytes: 1024,
  });
  let followingCalled = false;
  const following = guard.runJson("queue.test", () => {
    followingCalled = true;
    return Promise.resolve(jsonReply());
  }, { deadlineMs: 5_000, maxBytes: 1024 });
  await tick();
  assert.equal(guard.diagnostics()[0]?.queued, 2);

  controller.abort();
  await assert.rejects(aborted, (error: unknown) => error instanceof OutboundError && error.code === "cancelled");
  assert.equal(guard.diagnostics()[0]?.queued, 1);
  assert.equal(followingCalled, false);

  releaseFirst();
  await first;
  await following;
  assert.equal(followingCalled, true);
});

test("an abort after admission is cancelled and is not an outage", async () => {
  const { guard } = harness();
  const controller = new AbortController();
  let admitted = false;
  const request = guard.runJson("abort.test", (signal) => {
    admitted = true;
    return new Promise<Response>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }, { signal: controller.signal, deadlineMs: 5_000, maxBytes: 1024 });
  await tick();
  assert.equal(admitted, true);

  controller.abort();
  await assert.rejects(request, (error: unknown) => error instanceof OutboundError && error.code === "cancelled");
  assert.deepEqual(guard.diagnostics(), []);
});

test("the deadline starts at admission, not while queued", async () => {
  const { guard } = harness({ maxConcurrent: 1 });
  let releaseFirst = () => {};
  const first = guard.runJson("deadline.test", () => new Promise<Response>((resolve) => {
    releaseFirst = () => resolve(jsonReply());
  }), { deadlineMs: 5_000, maxBytes: 1024 });
  await tick();

  const second = guard.runJson("deadline.test", () => Promise.resolve(jsonReply({ value: 2 })), {
    deadlineMs: 80, maxBytes: 1024,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(guard.diagnostics()[0]?.queued, 1);

  releaseFirst();
  await first;
  assert.deepEqual(await second, { value: 2 });
});

test("the deadline covers reading the body", async () => {
  const { guard } = harness();
  const stream = new ReadableStream<Uint8Array>({ start() {} });
  const request = guard.runJson("body.test", () => Promise.resolve(new Response(stream, {
    headers: { "content-type": "application/json" },
  })), { deadlineMs: 40, maxBytes: 1024 });
  const keepAlive = setTimeout(() => undefined, 200);
  try {
    await assert.rejects(request, (error: unknown) => error instanceof OutboundError && error.code === "timeout");
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(guard.diagnostics()[0]?.failures, 1);
});

test("too-large and invalid JSON answers count as failures", async () => {
  const tooLarge = harness();
  await assert.rejects(tooLarge.guard.runJson("large.test", () => Promise.resolve(new Response("x".repeat(20), {
    headers: { "content-type": "application/json" },
  })), { deadlineMs: 5_000, maxBytes: 10 }), (error: unknown) => error instanceof OutboundError && error.code === "too-large");
  assert.equal(tooLarge.guard.diagnostics()[0]?.failures, 1);

  const badJson = harness();
  await assert.rejects(badJson.guard.runJson("bad-json.test", () => Promise.resolve(new Response("{", {
    headers: { "content-type": "application/json" },
  })), { deadlineMs: 5_000, maxBytes: 1024 }), (error: unknown) => error instanceof OutboundError && error.code === "invalid-json");
  assert.equal(badJson.guard.diagnostics()[0]?.failures, 1);

  const notJson = harness();
  await assert.rejects(notJson.guard.runJson("not-json.test", () => Promise.resolve(new Response("{}", {
    headers: { "content-type": "text/plain" },
  })), { deadlineMs: 5_000, maxBytes: 1024 }), (error: unknown) => error instanceof OutboundError && error.code === "invalid-json");
  assert.equal(notJson.guard.diagnostics()[0]?.failures, 1);
});

test("runJson keeps an explained validation error for the caller", async () => {
  const { guard } = harness({ failureThreshold: 1 });
  const failure = new AppError("Invalid URL.", "err.invalidUrl");

  await assert.rejects(guard.runJson("validation.test", async () => { throw failure; }, {
    deadlineMs: 5_000, maxBytes: 1024,
  }), (error: unknown) => error === failure);

  assert.equal(guard.diagnostics()[0]?.failures, 1);
});

test("queued keys are served round-robin", async () => {
  const { guard } = harness({ maxConcurrent: 1, maxQueue: 20 });
  let releaseFirst = () => {};
  const first = guard.runJson("fair.test", () => new Promise<Response>((resolve) => {
    releaseFirst = () => resolve(jsonReply());
  }), { key: "a", deadlineMs: 5_000, maxBytes: 1024 });
  await tick();

  const order: string[] = [];
  const queuedA = Array.from({ length: 10 }, (_, index) => guard.runJson("fair.test", () => {
    order.push(`a${index}`);
    return Promise.resolve(jsonReply());
  }, { key: "a", deadlineMs: 5_000, maxBytes: 1024 }));
  const queuedB = guard.runJson("fair.test", () => {
    order.push("b");
    return Promise.resolve(jsonReply());
  }, { key: "b", deadlineMs: 5_000, maxBytes: 1024 });
  await tick();
  assert.equal(guard.diagnostics()[0]?.queued, 11);

  releaseFirst();
  await first;
  await Promise.all([...queuedA, queuedB]);
  assert.deepEqual(order.slice(0, 2), ["b", "a0"]);
});

test("the breaker log carries a fixed reason, never the upstream text", async () => {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "stremio-outbound-log-"));
  await initLogger(logDir);
  const { guard } = harness({ failureThreshold: 1 });
  await assert.rejects(guard.run("addon.test", async () => {
    throw new Error("fetch failed https://x/catalog/movie/top/search=zz-sentinel.json");
  }), /zz-sentinel/);
  await flushLog();

  const lines = await readFile(path.join(logDir, "app.log"), "utf8");
  assert.equal(lines.includes("zz-sentinel"), false);
  assert.match(lines, /"reason":"network"/);
});
