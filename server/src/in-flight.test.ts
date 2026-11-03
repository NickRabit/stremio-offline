import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Request, Response } from "express";
import { InFlight } from "./in-flight.js";

const begin = (inFlight: InFlight) => {
  const res = new EventEmitter();
  inFlight.middleware()({} as Request, res as unknown as Response, () => {});
  return res;
};

test("a request counts until it finishes or its connection closes, once", () => {
  const inFlight = new InFlight();
  const first = begin(inFlight);
  const second = begin(inFlight);
  assert.equal(inFlight.active(), 2);
  first.emit("finish");
  first.emit("close");
  assert.equal(inFlight.active(), 1);
  second.emit("close");
  assert.equal(inFlight.active(), 0);
});

test("draining waits for a request that arrives after it started", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const inFlight = new InFlight();
  const drained = inFlight.drained(100, 2_000, 5);
  let result: boolean | undefined;
  void drained.then((value) => { result = value; });

  t.mock.timers.tick(10);
  const late = begin(inFlight);
  t.mock.timers.tick(90);
  await Promise.resolve();
  assert.equal(result, undefined, "the deadline is measured from when the late request ended");

  t.mock.timers.tick(50);
  late.emit("finish");
  t.mock.timers.tick(5);
  t.mock.timers.tick(100);
  await Promise.resolve();
  assert.equal(result, true, "the drain completes after a full quiet spell");
  assert.equal(Date.now(), 255);
  assert.equal(await drained, true);
});

test("draining gives up at the limit while a request never ends", async () => {
  const inFlight = new InFlight();
  begin(inFlight);
  const started = Date.now();
  assert.equal(await inFlight.drained(50, 200, 5), false);
  assert.ok(Date.now() - started < 1_000);
});
