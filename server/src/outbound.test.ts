import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initLogger } from "./logger.js";
import { GuardRejection, OutboundGuard, configFromEnv, metadataConfigFromEnv, retryAfterMs } from "./outbound.js";

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
const boom = async (): Promise<Response> => { throw new Error("connection refused"); };
/** What AbortSignal.timeout produces -- our own deadline, not the host's trouble. */
const ownTimeout = async (): Promise<Response> => {
  throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
};

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
