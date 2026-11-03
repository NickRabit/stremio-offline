import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express from "express";
import { apiRequestLimiter, authRequestLimiter, BoundedMemoryStore, isMediaTransferRequest, pageRequestLimiter } from "./request-limits.js";

const servers: Array<ReturnType<express.Express["listen"]>> = [];
let origin = "";

before(async () => {
  const app = express();
  app.use((req, res, next) => {
    res.locals.user = typeof req.headers["x-user"] === "string" ? req.headers["x-user"] : undefined;
    next();
  });
  app.use("/api", apiRequestLimiter({
    limit: 2,
    userId: (_req) => undefined,
    skip: (req) => req.path === "/skip" || isMediaTransferRequest(req),
  }));
  app.get("/api/ok", (_req, res) => res.json({ ok: true }));
  app.get("/api/skip", (_req, res) => res.json({ ok: true }));
  app.get("/api/playback/session/1/segment.m4s", (_req, res) => res.end("segment"));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  for (const server of servers) server.close();
});

test("API requests are limited by account without sharing another account's quota", async () => {
  const user = apiRequestLimiter({ limit: 1, userId: (req) => req.headers["x-user"] as string | undefined });
  const app = express();
  app.get("/limit", user, (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  assert.equal((await fetch(`${base}/limit`, { headers: { "x-user": "u1" } })).status, 200);
  const limited = await fetch(`${base}/limit`, { headers: { "x-user": "u1" } });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.deepEqual(await limited.json(), {
    error: "Too many requests. Try again later.",
    messageKey: "err.tooManyRequests",
    vars: { seconds: Number(limited.headers.get("retry-after")) },
  });
  assert.equal((await fetch(`${base}/limit`, { headers: { "x-user": "u2" } })).status, 200);
});

test("skipped requests do not consume the API quota", async () => {
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await fetch(`${origin}/api/skip`)).status, 200);
    assert.equal(await fetch(`${origin}/api/playback/session/1/segment.m4s`).then((response) => response.text()), "segment");
  }
  assert.equal((await fetch(`${origin}/api/ok`)).status, 200);
  assert.equal((await fetch(`${origin}/api/ok`)).status, 200);
});

test("long-lived media range requests are outside the API limiter", () => {
  const request = (method: string, path: string) => ({ method, path } as express.Request);
  assert.equal(isMediaTransferRequest(request("GET", "/playback/id/1/segment.m4s")), true);
  assert.equal(isMediaTransferRequest(request("HEAD", "/media/id")), true);
  assert.equal(isMediaTransferRequest(request("GET", "/device-download/id")), true);
  assert.equal(isMediaTransferRequest(request("GET", "/playback/id/preview")), false);
  assert.equal(isMediaTransferRequest(request("POST", "/playback")), false);
});

test("the limiter store evicts the oldest key instead of growing without bound", async () => {
  const store = new BoundedMemoryStore(2);
  await store.increment("first");
  await store.increment("second");
  await store.increment("current");
  assert.equal(store.current.size + store.previous.size, 2);
  assert.equal((await store.get("current"))?.totalHits, 1);
});

test("auth and page requests have independent IP-based quotas", async () => {
  const auth = authRequestLimiter({ limit: 1, userId: () => undefined });
  const page = pageRequestLimiter({ limit: 1 });
  const app = express();
  app.post("/api/auth/login", auth, (_req, res) => res.json({ ok: true }));
  app.get("/page", page, (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  assert.equal((await fetch(`${base}/api/auth/login`, { method: "POST" })).status, 200);
  assert.equal((await fetch(`${base}/api/auth/login`, { method: "POST" })).status, 429);
  assert.equal((await fetch(`${base}/page`)).status, 200);
  assert.equal((await fetch(`${base}/page`)).status, 429);
});
