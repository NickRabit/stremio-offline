import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request, Response } from "express";
import { loopbackHostCheck } from "./host-check.js";

const run = (env: NodeJS.ProcessEnv, host: string | undefined) => {
  let passed = false;
  let status: number | null = null;
  const req = { headers: host === undefined ? {} : { host } } as Request;
  const res = {
    status(code: number) { status = code; return this; },
    type() { return this; },
    send() { return this; },
  } as unknown as Response;
  loopbackHostCheck(env)(req, res, () => { passed = true; });
  return { passed, status };
};

test("without HOST_CHECK every Host is accepted, as on a NAS", () => {
  assert.deepEqual(run({ PORT: "8080" }, "nas.local:8080"), { passed: true, status: null });
  assert.deepEqual(run({}, undefined), { passed: true, status: null });
});

test("the loopback check accepts the bound port on 127.0.0.1 and localhost", () => {
  const env = { HOST_CHECK: "loopback", PORT: "53001" };
  assert.equal(run(env, "127.0.0.1:53001").passed, true);
  assert.equal(run(env, "localhost:53001").passed, true);
  assert.equal(run(env, "LocalHost:53001").passed, true);
});

test("the loopback check refuses a rebound name, another port and a missing Host", () => {
  const env = { HOST_CHECK: "loopback", PORT: "53001" };
  assert.deepEqual(run(env, "attacker.example:53001"), { passed: false, status: 421 });
  assert.deepEqual(run(env, "127.0.0.1:53002"), { passed: false, status: 421 });
  assert.deepEqual(run(env, "127.0.0.1"), { passed: false, status: 421 });
  assert.deepEqual(run(env, undefined), { passed: false, status: 421 });
});

test("the port is read when the request arrives, after the listener wrote it back", () => {
  const env: NodeJS.ProcessEnv = { HOST_CHECK: "loopback", PORT: "0" };
  const check = loopbackHostCheck(env);
  env.PORT = "53003";
  let passed = false;
  check({ headers: { host: "127.0.0.1:53003" } } as Request, {} as Response, () => { passed = true; });
  assert.equal(passed, true);
});

test("the published check accepts an IP literal, a bracketed IPv6, localhost and the machine's names", () => {
  const env = { HOST_CHECK: "published", PORT: "8091", HOST_NAMES: "mac.local" };
  assert.equal(run(env, "192.168.1.41:8091").passed, true);
  assert.equal(run(env, "127.0.0.1:8091").passed, true);
  assert.equal(run(env, "[fe80::1]:8091").passed, true);
  assert.equal(run(env, "localhost:8091").passed, true);
  assert.equal(run(env, "mac.local:8091").passed, true);
  assert.equal(run(env, "MAC.LOCAL:8091").passed, true);
});

test("the published check refuses a rebound name, another port, a missing Host and a name not shared", () => {
  const env = { HOST_CHECK: "published", PORT: "8091", HOST_NAMES: "mac.local" };
  assert.deepEqual(run(env, "evil.example:8091"), { passed: false, status: 421 });
  assert.deepEqual(run(env, "192.168.1.41:8092"), { passed: false, status: 421 });
  assert.deepEqual(run(env, "192.168.1.41"), { passed: false, status: 421 });
  assert.deepEqual(run(env, undefined), { passed: false, status: 421 });
  assert.deepEqual(run(env, "nas.local:8091"), { passed: false, status: 421 });
});
