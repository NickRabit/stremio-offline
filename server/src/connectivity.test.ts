import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Connectivity } from "./connectivity.js";
import { flushLog, initLogger } from "./logger.js";

process.env.LOG_STDOUT = "0";
const logDir = await mkdtemp(path.join(os.tmpdir(), "stremio-connectivity-"));
await initLogger(logDir);
after(async () => {
  await flushLog();
  await rm(logDir, { recursive: true, force: true });
});

const clock = () => {
  let value = 1_000;
  return {
    connectivity: new Connectivity({ now: () => value, probeIntervalMs: 15_000, confirmIntervalMs: 5_000 }),
    advance(ms: number) { value += ms; },
  };
};

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const down = () => Object.assign(new Error("resolver unreachable"), { code: "EAI_AGAIN" });
const missing = () => Object.assign(new Error("no such name"), { code: "ENOTFOUND" });

/** A resolver where the listed names fail as "resolver down" and every other name resolves. */
const resolverWith = (failing: (host: string) => boolean) => {
  const asked: string[] = [];
  return {
    asked,
    resolver: async (host: string) => {
      asked.push(host);
      if (failing(host)) throw down();
      return [{ address: "93.184.216.34", family: 4 }];
    },
  };
};

const takeOffline = async (connectivity: Connectivity) => {
  connectivity.useResolver(async () => { throw down(); });
  connectivity.recordLookupFailure("addon.example", "EAI_AGAIN");
  await settle();
  assert.equal(connectivity.state, "offline");
};

test("organic failures alone never take the connection offline", () => {
  const { connectivity } = clock();
  for (const host of ["one.example", "two.example", "three.example", "four.example"]) {
    connectivity.recordLookupFailure(host, "EAI_AGAIN");
  }
  assert.equal(connectivity.state, "online");
});

test("a failure whose cross-check also cannot be resolved takes the connection offline", async () => {
  const { connectivity } = clock();
  const { resolver, asked } = resolverWith(() => true);
  connectivity.useResolver(resolver);
  connectivity.recordLookupSuccess("good.example");
  connectivity.recordLookupFailure("addon.example", "EAI_AGAIN");
  await settle();
  assert.deepEqual(asked, ["good.example"]);
  assert.equal(connectivity.state, "offline");
});

test("domains with broken DNS do not take a healthy server offline", async () => {
  const { connectivity, advance } = clock();
  const { resolver } = resolverWith((host) => host.startsWith("lame"));
  connectivity.useResolver(resolver);
  for (let round = 0; round < 4; round += 1) {
    connectivity.recordLookupFailure("lame-one.example", "EAI_AGAIN");
    connectivity.recordLookupFailure("lame-two.example", "EAI_AGAIN");
    await settle();
    assert.equal(connectivity.state, "online");
    advance(10_000);
  }
});

test("names that do not exist never take the connection offline", async () => {
  const { connectivity } = clock();
  connectivity.useResolver(async () => { throw down(); });
  for (const host of ["gone.example", "typo.example", "dead.example"]) connectivity.recordLookupFailure(host, "ENOTFOUND");
  connectivity.recordLookupFailure("nodata.example", "ENODATA");
  await settle();
  assert.equal(connectivity.state, "online");
});

test("without a good host yet, the cross-check asks a reference host", async () => {
  const { connectivity } = clock();
  const { resolver, asked } = resolverWith(() => true);
  connectivity.useResolver(resolver);
  connectivity.recordLookupFailure("v3-cinemeta.strem.io", "EAI_AGAIN");
  await settle();
  assert.equal(asked.length, 1);
  assert.notEqual(asked[0], "v3-cinemeta.strem.io");
  assert.equal(connectivity.state, "offline");
});

test("the cross-check runs once at a time and at most every interval", async () => {
  const { connectivity, advance } = clock();
  let release!: () => void;
  const asked: string[] = [];
  connectivity.useResolver((host) => { asked.push(host); return new Promise((resolve) => { release = () => resolve([]); }); });
  connectivity.recordLookupSuccess("good.example");
  for (let attempt = 0; attempt < 5; attempt += 1) connectivity.recordLookupFailure(`addon-${attempt}.example`, "EAI_AGAIN");
  assert.equal(asked.length, 1);
  release();
  await settle();
  connectivity.recordLookupFailure("addon-late.example", "EAI_AGAIN");
  assert.equal(asked.length, 1);
  advance(5_000);
  connectivity.recordLookupFailure("addon-later.example", "EAI_AGAIN");
  assert.equal(asked.length, 2);
});

test("a name the router still caches keeps the cross-check online instead of flapping", async () => {
  const { connectivity, advance } = clock();
  const { resolver } = resolverWith((host) => host !== "cached.example");
  connectivity.useResolver(resolver);
  connectivity.recordLookupSuccess("cached.example");
  let flips = 0;
  connectivity.onOnline(() => { flips += 1; });
  for (let round = 0; round < 20; round += 1) {
    connectivity.recordLookupFailure(`uncached-${round}.example`, "EAI_AGAIN");
    await settle();
    advance(5_000);
  }
  assert.equal(connectivity.state, "online");
  assert.equal(flips, 0);
});

test("offline lookup admission offers exactly one request after the interval", async () => {
  const { connectivity, advance } = clock();
  await takeOffline(connectivity);
  assert.equal(connectivity.admitLookup("four.example"), false);
  advance(15_000);
  assert.equal(connectivity.admitLookup("four.example"), true);
  assert.equal(connectivity.admitLookup("five.example"), false);
  connectivity.recordLookupFailure("four.example", "EAI_AGAIN");
  assert.equal(connectivity.state, "offline");
  assert.equal(connectivity.admitLookup("five.example"), false);
  advance(15_000);
  assert.equal(connectivity.admitLookup("five.example"), true);
});

test("an NXDOMAIN answer to the request probe proves the resolver is back", async () => {
  const { connectivity, advance } = clock();
  await takeOffline(connectivity);
  advance(15_000);
  assert.equal(connectivity.admitLookup("gone.example"), true);
  connectivity.recordLookupFailure("gone.example", "ENOTFOUND");
  assert.equal(connectivity.state, "online");
});

test("the background probe asks the host that proved the outage and leaves the request slot alone", async () => {
  const { connectivity, advance } = clock();
  let up = false;
  const asked: string[] = [];
  connectivity.useResolver(async (host) => {
    asked.push(host);
    if (!up) throw down();
    return [];
  });
  connectivity.recordLookupSuccess("good.example");
  connectivity.recordLookupFailure("addon.example", "EAI_AGAIN");
  await settle();
  assert.equal(connectivity.state, "offline");
  asked.length = 0;

  advance(15_000);
  connectivity.probeIfDue();
  await settle();
  assert.deepEqual(asked, ["good.example"]);
  assert.equal(connectivity.admitLookup("addon.example"), true, "the probe did not take the request slot");
  connectivity.recordLookupFailure("addon.example", "EAI_AGAIN");
  connectivity.probeIfDue();
  assert.deepEqual(asked, ["good.example"], "a second probe waits for its own interval");

  let since: number | undefined;
  connectivity.onOnline((began) => { since = began; });
  up = true;
  advance(15_000);
  connectivity.probeIfDue();
  await settle();
  assert.equal(connectivity.state, "online");
  assert.equal(connectivity.offlineSince, undefined);
  assert.equal(since, 1_000);
});

test("a probe answered with NXDOMAIN also ends the outage", async () => {
  const { connectivity, advance } = clock();
  await takeOffline(connectivity);
  connectivity.useResolver(async () => { throw missing(); });
  advance(15_000);
  connectivity.probeIfDue();
  await settle();
  assert.equal(connectivity.state, "online");
});

test("IP literals are never counted or refused", async () => {
  const { connectivity } = clock();
  await takeOffline(connectivity);
  assert.equal(connectivity.admitLookup("93.184.216.34"), true);
  assert.equal(connectivity.admitLookup("[2001:db8::1]"), true);
});
