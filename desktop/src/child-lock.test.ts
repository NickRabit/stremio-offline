import assert from "node:assert/strict";
import test from "node:test";
import { accountMayHaveChanged, ACCOUNT_REQUEST_FILTERS, readChildAccount } from "./child-lock.js";
import type { StatusFetch } from "./status.js";

const answering = (status: number, body?: unknown): StatusFetch => async () =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a child account is read from the server's own answer", async () => {
  const asked: string[] = [];
  const fetchImpl: StatusFetch = async (url) => { asked.push(url); return new Response(JSON.stringify({ username: "kid", child: true }), { status: 200 }); };
  assert.equal(await readChildAccount("http://nas.local:8090", fetchImpl), true);
  assert.deepEqual(asked, ["http://nas.local:8090/api/auth/me"]);
});

test("an ordinary account, an administrator and nobody signed in are not held", async () => {
  assert.equal(await readChildAccount("http://a", answering(200, { username: "ada", role: "admin" })), false);
  assert.equal(await readChildAccount("http://a", answering(200, { username: "bob", child: false })), false);
  assert.equal(await readChildAccount("http://a", answering(200, { username: "bob", child: "true" })), false);
  assert.equal(await readChildAccount("http://a", answering(401, { error: "Not signed in." })), false);
});

test("an answer that could not be read leaves the lock as it was", async () => {
  assert.equal(await readChildAccount("http://a", answering(502)), undefined);
  assert.equal(await readChildAccount("http://a", answering(302)), undefined);
  assert.equal(await readChildAccount("http://a", async () => new Response("<html>", { status: 200 })), undefined);
  assert.equal(await readChildAccount("http://a", answering(200, null)), undefined);
  assert.equal(await readChildAccount("http://a", async () => { throw new Error("offline"); }), undefined);
});

test("only the connected server's sign-in, sign-out and profile switch ask for a new look", () => {
  const origin = "http://nas.local:8090";
  for (const path of ["/api/auth/login", "/api/auth/logout", "/api/auth/setup", "/api/profiles/switch"]) {
    assert.equal(accountMayHaveChanged(origin + path, origin), true, path);
  }
  assert.equal(accountMayHaveChanged(origin + "/api/auth/me", origin), false, "the probe itself never wakes the lock");
  assert.equal(accountMayHaveChanged(origin + "/api/profiles", origin), false);
  assert.equal(accountMayHaveChanged("http://elsewhere:8090/api/auth/login", origin), false);
  assert.equal(accountMayHaveChanged(origin + "/api/auth/login", null), false);
  assert.equal(accountMayHaveChanged("not a url", origin), false);
  assert.equal(ACCOUNT_REQUEST_FILTERS.length, 4);
});
