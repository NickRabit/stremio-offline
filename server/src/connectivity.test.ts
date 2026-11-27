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
    connectivity: new Connectivity({ now: () => value, windowMs: 60_000, probeIntervalMs: 15_000, confirmIntervalMs: 30_000 }),
    advance(ms: number) { value += ms; },
  };
};

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const takeOffline = (connectivity: Connectivity) => {
  connectivity.recordLookupFailure("one.example", "EAI_AGAIN");
  connectivity.recordLookupFailure("two.example", "EAI_AGAIN");
  assert.equal(connectivity.state, "offline");
};

test("two distinct hosts with an unreachable resolver take the connection offline", () => {
  const { connectivity } = clock();
  connectivity.recordLookupFailure("one.example", "EAI_AGAIN");
  assert.equal(connectivity.state, "online");
  connectivity.recordLookupFailure("two.example", "ETIMEOUT");
  assert.equal(connectivity.state, "offline");
});

test("names that do not exist never take the connection offline", () => {
  const { connectivity } = clock();
  for (const host of ["gone.example", "typo.example", "dead.example", "old.example"]) {
    connectivity.recordLookupFailure(host, "ENOTFOUND");
  }
  connectivity.recordLookupFailure("nodata.example", "ENODATA");
  assert.equal(connectivity.state, "online");
});

test("an answer in between resets the count, NXDOMAIN included", () => {
  const { connectivity } = clock();
  connectivity.recordLookupFailure("one.example", "EAI_AGAIN");
  connectivity.recordLookupFailure("gone.example", "ENOTFOUND");
  connectivity.recordLookupFailure("two.example", "EAI_AGAIN");
  assert.equal(connectivity.state, "online");
  connectivity.recordLookupSuccess("ok.example");
  connectivity.recordLookupFailure("three.example", "EAI_AGAIN");
  assert.equal(connectivity.state, "online");
});

test("one host failing repeatedly never takes the connection offline", () => {
  const { connectivity } = clock();
  for (let attempt = 0; attempt < 10; attempt += 1) connectivity.recordLookupFailure("one.example", "EAI_AGAIN");
  assert.equal(connectivity.state, "online");
});

test("a lone failure is confirmed against the last host that resolved", async () => {
  const { connectivity, advance } = clock();
  const asked: string[] = [];
  connectivity.useResolver(async (host) => { asked.push(host); throw Object.assign(new Error("down"), { code: "EAI_AGAIN" }); });
  connectivity.recordLookupSuccess("good.example");
  connectivity.recordLookupFailure("addon.example", "EAI_AGAIN");
  await settle();
  assert.deepEqual(asked, ["good.example"]);
  assert.equal(connectivity.state, "offline");
  advance(1);
  assert.equal(connectivity.admitLookup("any.example"), false);
});

test("a confirmation that resolves keeps the connection online", async () => {
  const { connectivity } = clock();
  connectivity.useResolver(async () => [{ address: "93.184.216.34", family: 4 }]);
  connectivity.recordLookupSuccess("good.example");
  connectivity.recordLookupFailure("broken-dns.example", "ESERVFAIL");
  await settle();
  assert.equal(connectivity.state, "online");
});

test("offline lookup admission offers exactly one request after the interval", () => {
  const { connectivity, advance } = clock();
  takeOffline(connectivity);
  assert.equal(connectivity.admitLookup("four.example"), false);
  advance(15_000);
  assert.equal(connectivity.admitLookup("four.example"), true);
  assert.equal(connectivity.admitLookup("five.example"), false);
  connectivity.recordLookupFailure("four.example", "EAI_AGAIN");
  assert.equal(connectivity.admitLookup("five.example"), false);
  advance(15_000);
  assert.equal(connectivity.admitLookup("five.example"), true);
});

test("an NXDOMAIN answer to the request probe proves the resolver is back", () => {
  const { connectivity, advance } = clock();
  takeOffline(connectivity);
  advance(15_000);
  assert.equal(connectivity.admitLookup("gone.example"), true);
  connectivity.recordLookupFailure("gone.example", "ENOTFOUND");
  assert.equal(connectivity.state, "online");
});

test("the background probe asks the last good host and leaves the request slot alone", async () => {
  const { connectivity, advance } = clock();
  const asked: string[] = [];
  let up = false;
  connectivity.useResolver(async (host) => {
    asked.push(host);
    if (!up) throw Object.assign(new Error("down"), { code: "EAI_AGAIN" });
    return [];
  });
  connectivity.recordLookupSuccess("good.example");
  connectivity.recordLookupFailure("one.example", "EAI_AGAIN");
  connectivity.recordLookupFailure("two.example", "EAI_AGAIN");
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

test("failures outside the window do not count towards the offline state", () => {
  const { connectivity, advance } = clock();
  connectivity.recordLookupFailure("old.example", "EAI_AGAIN");
  advance(60_000);
  connectivity.recordLookupFailure("two.example", "EAI_AGAIN");
  assert.equal(connectivity.state, "online");
});

test("IP literals are never counted or refused", () => {
  const { connectivity } = clock();
  takeOffline(connectivity);
  assert.equal(connectivity.admitLookup("93.184.216.34"), true);
  assert.equal(connectivity.admitLookup("[2001:db8::1]"), true);
});

test("without a good host yet, a lone failure is cross-checked against a reference host", async () => {
  const { connectivity } = clock();
  const asked: string[] = [];
  connectivity.useResolver(async (host) => { asked.push(host); throw Object.assign(new Error("down"), { code: "EAI_AGAIN" }); });
  connectivity.recordLookupFailure("v3-cinemeta.strem.io", "EAI_AGAIN");
  await settle();
  assert.equal(asked.length, 1);
  assert.notEqual(asked[0], "v3-cinemeta.strem.io");
  assert.equal(connectivity.state, "offline");
});
