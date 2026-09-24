import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { resolveListenTarget, startServer, utilityParentPort, type UtilityParentPort } from "./server-start.js";

const close = (server: ReturnType<typeof createServer>) => new Promise<void>((resolve) => server.close(() => resolve()));

const collector = () => {
  const messages: unknown[] = [];
  const parentPort: UtilityParentPort = { postMessage: (message) => { messages.push(message); } };
  return { messages, parentPort };
};

test("host defaults to every interface and port to 8080", () => {
  assert.deepEqual(resolveListenTarget({}), { port: 8080, host: "0.0.0.0" });
  assert.deepEqual(resolveListenTarget({ PORT: "9000" }), { port: 9000, host: "0.0.0.0" });
  assert.deepEqual(resolveListenTarget({ HOST: "127.0.0.1" }), { port: 8080, host: "127.0.0.1" });
  assert.deepEqual(resolveListenTarget({ PORT: "0", HOST: "127.0.0.1" }), { port: 0, host: "127.0.0.1" });
});

test("a plain node process has no utility parent", () => {
  assert.equal(utilityParentPort(), null);
});

test("a bound listener reports its actual address and writes the port back", async () => {
  const env: NodeJS.ProcessEnv = { PORT: "0" };
  const { messages, parentPort } = collector();
  const bound = await startServer({ app: createServer(), port: 0, host: "127.0.0.1", env, parentPort });
  try {
    assert.equal(bound.port > 0, true);
    assert.equal(bound.address, "127.0.0.1");
    assert.equal(env.PORT, String(bound.port));
    assert.deepEqual(messages, [{ type: "ready", port: bound.port, address: "127.0.0.1" }]);
  } finally {
    await close(bound.server);
  }
});

test("a start without a utility parent still binds and writes the port back", async () => {
  const env: NodeJS.ProcessEnv = {};
  const bound = await startServer({ app: createServer(), port: 0, host: "127.0.0.1", env, parentPort: null });
  try {
    assert.equal(env.PORT, String(bound.port));
  } finally {
    await close(bound.server);
  }
});

test("a listener that cannot bind reports the error to the parent", async () => {
  const taken = createServer();
  await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
  const port = (taken.address() as AddressInfo).port;
  const { messages, parentPort } = collector();
  try {
    await assert.rejects(
      startServer({ app: createServer(), port, host: "127.0.0.1", env: {}, parentPort }),
      (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE",
    );
    assert.deepEqual(messages.length, 1);
    const message = messages[0] as { type: string; code: string | null };
    assert.equal(message.type, "error");
    assert.equal(message.code, "EADDRINUSE");
  } finally {
    await close(taken);
  }
});

test("an express app that cannot bind reports the error instead of a missing address", async () => {
  const taken = createServer();
  await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
  const port = (taken.address() as AddressInfo).port;
  const { messages, parentPort } = collector();
  try {
    // Express calls its `listen` callback on a bind failure as well, with the error.
    await assert.rejects(
      startServer({ app: express(), port, host: "127.0.0.1", env: {}, parentPort }),
      (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE",
    );
    assert.deepEqual(messages.map((message) => (message as { type: string; code: string | null }).type), ["error"]);
    assert.equal((messages[0] as { code: string | null }).code, "EADDRINUSE");
  } finally {
    await close(taken);
  }
});
