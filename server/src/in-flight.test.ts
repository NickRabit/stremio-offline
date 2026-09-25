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

test("draining waits for a request that arrives after it started", async () => {
  const inFlight = new InFlight();
  const started = Date.now();
  const drained = inFlight.drained(100, 2_000, 5);
  let late: EventEmitter | undefined;
  setTimeout(() => { late = begin(inFlight); }, 30);
  setTimeout(() => late?.emit("finish"), 150);
  assert.equal(await drained, true);
  assert.ok(Date.now() - started >= 240, "the quiet spell restarts after the late request ends");
});

test("draining gives up at the limit while a request never ends", async () => {
  const inFlight = new InFlight();
  begin(inFlight);
  const started = Date.now();
  assert.equal(await inFlight.drained(50, 200, 5), false);
  assert.ok(Date.now() - started < 1_000);
});
