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
    connectivity: new Connectivity({ now: () => value, hostsToTrip: 3, windowMs: 60_000, probeIntervalMs: 15_000 }),
    advance(ms: number) { value += ms; },
  };
};

test("three distinct failing hosts take the connection offline", () => {
  const { connectivity } = clock();
  connectivity.recordLookupFailure("one.example", "EAI_AGAIN");
  connectivity.recordLookupFailure("two.example", "ENOTFOUND");
  assert.equal(connectivity.state, "online");
  connectivity.recordLookupFailure("three.example", "EAI_AGAIN");
  assert.equal(connectivity.state, "offline");
});

test("one host failing repeatedly never takes the connection offline", () => {
  const { connectivity } = clock();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    connectivity.recordLookupFailure("one.example", "EAI_AGAIN");
  }
  assert.equal(connectivity.state, "online");
});

test("a successful lookup resets the distinct-host count", () => {
  const { connectivity } = clock();
  connectivity.recordLookupFailure("one.example", "EAI_AGAIN");
  connectivity.recordLookupFailure("two.example", "ENOTFOUND");
  connectivity.recordLookupSuccess("two.example");
  connectivity.recordLookupFailure("three.example", "EAI_AGAIN");
  connectivity.recordLookupFailure("four.example", "ENOTFOUND");
  assert.equal(connectivity.state, "online");
  connectivity.recordLookupFailure("five.example", "EAI_AGAIN");
  assert.equal(connectivity.state, "offline");
});

test("offline lookup admission offers exactly one probe after the interval", () => {
  const { connectivity, advance } = clock();
  connectivity.recordLookupFailure("one.example", "EAI_AGAIN");
  connectivity.recordLookupFailure("two.example", "ENOTFOUND");
  connectivity.recordLookupFailure("three.example", "EAI_AGAIN");

  assert.equal(connectivity.admitLookup("four.example"), false);
  advance(15_000);
  assert.equal(connectivity.admitLookup("four.example"), true);
  assert.equal(connectivity.admitLookup("five.example"), false);
});

test("a successful probe restores the connection and notifies listeners once", async () => {
  const { connectivity, advance } = clock();
  connectivity.recordLookupFailure("one.example", "EAI_AGAIN");
  connectivity.recordLookupFailure("two.example", "ENOTFOUND");
  connectivity.recordLookupFailure("three.example", "EAI_AGAIN");
  let notified = 0;
  connectivity.onOnline(() => { notified += 1; });

  advance(15_000);
  connectivity.probeIfDue(async () => ({ address: "93.184.216.34", family: 4 }));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(connectivity.state, "online");
  assert.equal(connectivity.offlineSince, undefined);
  assert.equal(notified, 1);
  connectivity.recordLookupSuccess("three.example");
  assert.equal(notified, 1);
});

test("failures outside the window do not count towards the offline state", () => {
  const { connectivity, advance } = clock();
  connectivity.recordLookupFailure("old.example", "EAI_AGAIN");
  advance(60_000);
  connectivity.recordLookupFailure("two.example", "ENOTFOUND");
  connectivity.recordLookupFailure("three.example", "EAI_AGAIN");
  assert.equal(connectivity.state, "online");
});
