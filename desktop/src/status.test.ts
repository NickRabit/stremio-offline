import assert from "node:assert/strict";
import { createServer, type AddressInfo, type Socket } from "node:net";
import test from "node:test";
import { fetchStatus, readStatus } from "./status.js";

const answering = (body: unknown, status = 200) => (async () => ({ status, json: async () => body })) as unknown as typeof fetch;

test("a status body keeps the version, restricted and secure", () => {
  assert.deepEqual(readStatus({ status: "ok", version: "0.4.62", restricted: false, secure: true, builtAt: "x", commit: "abc" }), { version: "0.4.62", restricted: false, secure: true });
});

test("a body that is not this app's status is rejected", () => {
  const rejected: unknown[] = [null, { status: "ok" }, { status: "no", version: "1", restricted: false, secure: false }, { status: "ok", version: 4, restricted: false, secure: false }, { status: "ok", version: "1", restricted: false }];
  for (const body of rejected) assert.equal(readStatus(body), null, JSON.stringify(body));
});

test("a probe that could not be sent never reaches the network", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls += 1; return { status: 200, json: async () => ({}) }; }) as unknown as typeof fetch;
  assert.deepEqual(await fetchStatus("http://8.8.8.8", fetchImpl), { ok: false, reason: "insecure-transport" });
  assert.deepEqual(await fetchStatus("http://192.168.1.20:8090/library", fetchImpl), { ok: false, reason: "invalid" });
  assert.equal(calls, 0);
});

test("a probe that throws is unreachable", async () => {
  const fetchImpl = (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch;
  assert.deepEqual(await fetchStatus("http://192.168.1.20:8090", fetchImpl), { ok: false, reason: "unreachable" });
});

test("only a 200 with this app's status is ok", async () => {
  assert.deepEqual(await fetchStatus("http://192.168.1.20:8090", answering({}, 302)), { ok: false, reason: "not-status" });
  assert.deepEqual(await fetchStatus("http://192.168.1.20:8090", answering({})), { ok: false, reason: "not-status" });
  assert.deepEqual(await fetchStatus("http://192.168.1.20:8090", answering({ status: "ok", version: "0.4.62", restricted: true, secure: false })), { ok: true, version: "0.4.62", restricted: true, secure: false });
});

test("a server that never answers is unreachable within the given timeout", async () => {
  const sockets = new Set<Socket>();
  let closed = false;
  const server = createServer((socket) => {
    if (closed) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const started = Date.now();
  let result: unknown;
  try {
    result = await fetchStatus(`http://127.0.0.1:${port}`, fetch, 200);
  } finally {
    closed = true;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const elapsed = Date.now() - started;
  assert.deepEqual(result, { ok: false, reason: "unreachable" });
  assert.ok(elapsed >= 150, `the probe gave up after ${elapsed} ms, before the timeout`);
  assert.ok(elapsed < 5000, `the probe gave up after ${elapsed} ms, past the default timeout`);
});
