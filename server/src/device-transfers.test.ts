import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type express from "express";
import { DeviceTransfers, type DeviceTransferMeta } from "./device-transfers.js";

/** A response with no socket behind it: the registry wraps these the way it wraps a real one. */
class FakeResponse extends EventEmitter {
  statusCode = 200;
  writableFinished = false;
  destroyed = false;
  received = 0;
  private headers: Record<string, string | number> = {};
  setHeader(name: string, value: string | number) { this.headers[name.toLowerCase()] = value; return this; }
  getHeader(name: string) { return this.headers[name.toLowerCase()]; }
  write(chunk: unknown) { this.received += Buffer.byteLength(chunk as string); return true; }
  end(chunk?: unknown) { if (chunk != null) this.write(chunk); this.writableFinished = true; this.emit("close"); return this; }
  destroy() { this.destroyed = true; this.emit("close"); }
}

const fake = (headers: Record<string, string | number> = {}) => {
  const response = new FakeResponse();
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  return response;
};

const asRes = (response: FakeResponse) => response as unknown as express.Response;

const meta = (userId: string, username?: string): DeviceTransferMeta =>
  ({ userId, username, filename: `${userId}.mkv`, source: "library" });

const USER = { id: "ada", role: "user" as const };
const ADMIN = { id: "ada", role: "admin" as const };

test("a response of a known length counts its bytes and completes", () => {
  const transfers = new DeviceTransfers();
  const response = fake({ "content-length": 10 });
  transfers.attach("ticket", meta("ada"), asRes(response));

  response.write(Buffer.alloc(4));
  response.write(Buffer.alloc(6));
  response.end();

  const rows = transfers.list(USER);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sent, 10);
  assert.equal(rows[0].total, 10);
  assert.equal(rows[0].state, "completed");
  assert.ok(rows[0].finishedAt);
});

test("two parallel ranges of one ticket make one row covering every byte once", () => {
  const transfers = new DeviceTransfers();
  const first = fake({ "content-range": "bytes 0-4/10" });
  const second = fake({ "content-range": "bytes 5-9/10" });
  transfers.attach("ticket", meta("ada"), asRes(first));
  transfers.attach("ticket", meta("ada"), asRes(second));

  first.write(Buffer.alloc(5));
  second.write(Buffer.alloc(5));
  first.end();
  assert.equal(transfers.list(USER)[0].state, "running", "one response still holds the transfer open");
  second.end();

  const rows = transfers.list(USER);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sent, 10);
  assert.equal(rows[0].total, 10);
  assert.equal(rows[0].state, "completed");
});

test("a repeated range over covered bytes never raises sent past the total", () => {
  const transfers = new DeviceTransfers();
  const first = fake({ "content-range": "bytes 0-9/10" });
  const second = fake({ "content-range": "bytes 0-9/10" });
  transfers.attach("ticket", meta("ada"), asRes(first));
  transfers.attach("ticket", meta("ada"), asRes(second));

  first.write(Buffer.alloc(10));
  second.write(Buffer.alloc(10));
  first.end();
  second.end();

  const rows = transfers.list(USER);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sent, 10, "each offset is counted once");
  assert.equal(rows[0].sent <= rows[0].total!, true);
});

test("a response closed mid-transfer is interrupted and a resume reuses the same row", () => {
  const transfers = new DeviceTransfers();
  const first = fake({ "content-length": 10 });
  transfers.attach("ticket", meta("ada"), asRes(first));
  first.write(Buffer.alloc(3));
  first.emit("close");

  const interrupted = transfers.list(USER)[0];
  assert.equal(interrupted.state, "interrupted");
  assert.equal(interrupted.sent, 3);

  const second = fake({ "content-range": "bytes 3-9/10" });
  transfers.attach("ticket", meta("ada"), asRes(second));
  const resumed = transfers.list(USER);
  assert.equal(resumed.length, 1, "a resume never adds a second row");
  assert.equal(resumed[0].id, interrupted.id, "the public id survives the interruption");
  assert.equal(resumed[0].state, "running");
  assert.equal(resumed[0].finishedAt, undefined);
});

test("a response closed without writing a byte leaves no row", () => {
  const transfers = new DeviceTransfers();
  const response = fake();
  transfers.attach("ticket", meta("ada"), asRes(response));
  response.emit("close");

  assert.deepEqual(transfers.list(ADMIN), []);
  assert.equal(transfers.abort("missing", ADMIN), undefined);
});

test("an HLS-like response without a length completes with no total", () => {
  const transfers = new DeviceTransfers();
  const response = fake();
  transfers.attach("ticket", { ...meta("ada"), source: "hls", addonName: "Example" }, asRes(response));
  response.write(Buffer.alloc(64));
  response.end();

  const rows = transfers.list(USER);
  assert.equal(rows[0].state, "completed");
  assert.equal(rows[0].total, undefined);
  assert.equal(rows[0].sent, 64);
  assert.equal(rows[0].source, "hls");
  assert.equal(rows[0].addonName, "Example");
});

test("a user sees only their own rows and never a username, an admin sees everybody", () => {
  const transfers = new DeviceTransfers();
  transfers.attach("t-ada", meta("ada", "ada"), asRes(fake()));
  transfers.attach("t-bob", meta("bob", "bob"), asRes(fake()));

  const own = transfers.list({ id: "bob", role: "user" });
  assert.deepEqual(own.map((row) => row.userId), ["bob"]);
  assert.equal("username" in own[0], false);

  const all = transfers.list({ id: "ada", role: "admin" });
  assert.deepEqual(all.map((row) => row.userId).sort(), ["ada", "bob"]);
  assert.deepEqual(all.map((row) => row.username).sort(), ["ada", "bob"]);
});

test("abort refuses a stranger without touching the response and stops it for the owner", () => {
  const transfers = new DeviceTransfers();
  const response = fake({ "content-length": 10 });
  transfers.attach("ticket", meta("ada", "ada"), asRes(response));
  response.write(Buffer.alloc(2));
  const id = transfers.list(USER)[0].id;

  assert.equal(transfers.abort(id, { id: "mallory", role: "user" }), undefined);
  assert.equal(response.destroyed, false, "a refused abort destroys nothing");
  assert.equal(transfers.list(USER)[0].state, "running");

  assert.equal(transfers.abort(id, USER), "ticket");
  assert.equal(response.destroyed, true);
  assert.equal(transfers.list(USER)[0].state, "interrupted");
});

test("an administrator may abort somebody else's transfer", () => {
  const transfers = new DeviceTransfers();
  const response = fake({ "content-length": 10 });
  transfers.attach("ticket", meta("bob", "bob"), asRes(response));
  response.write(Buffer.alloc(1));
  const id = transfers.list(ADMIN)[0].id;

  assert.equal(transfers.abort(id, ADMIN), "ticket");
  assert.equal(response.destroyed, true);
});

test("a finished row disappears once the retention window passes", () => {
  const clock = { value: 0 };
  const transfers = new DeviceTransfers({ now: () => clock.value, retainMs: 1000 });
  const response = fake({ "content-length": 1 });
  transfers.attach("ticket", meta("ada"), asRes(response));
  response.write(Buffer.alloc(1));
  response.end();
  assert.equal(transfers.list(USER).length, 1);

  clock.value += 1000;
  assert.deepEqual(transfers.list(USER), []);
});

test("the entry bound drops finished rows before running ones", () => {
  const transfers = new DeviceTransfers({ maxEntries: 2 });
  const running = fake({ "content-length": 10 });
  transfers.attach("running", meta("ada"), asRes(running));
  running.write(Buffer.alloc(1));

  const first = fake({ "content-length": 1 });
  transfers.attach("first", meta("ada"), asRes(first));
  first.write(Buffer.alloc(1));
  first.end();

  const second = fake({ "content-length": 1 });
  transfers.attach("second", meta("ada"), asRes(second));
  second.write(Buffer.alloc(1));
  second.end();

  const rows = transfers.list(ADMIN);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.state).sort(), ["completed", "running"]);
});
