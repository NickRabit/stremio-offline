import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { createSession, hashPassword, parseCookies, readSession, SESSION_COOKIE, sessionCookie } from "../auth.js";
import { messageKeyOf } from "../errors.js";
import { Store } from "../store.js";
import { registerAuthRoutes } from "./auth.js";
import type { RouteContext } from "./context.js";

interface Harness {
  base: string;
  store: Store;
  stopped: Array<string | undefined>;
  close(): Promise<void>;
}

/** The routes take everything they need from the context, so the app here is a real
 *  express instance with the same state the server passes in -- only the store is
 *  redirected to a throwaway directory. */
const mount = async (): Promise<Harness> => {
  const dir = await mkdtemp(path.join(tmpdir(), "routes-auth-"));
  const store = new Store(dir, dir);
  await store.load();
  const stopped: Array<string | undefined> = [];
  const currentSession = (req: express.Request) => {
    const auth = store.auth();
    if (!auth) return undefined;
    const info = readSession(auth.secret, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (!info || info.username !== auth.username) return undefined;
    return auth.revoked?.[info.sid] ? undefined : info;
  };
  const ctx: RouteContext = {
    store,
    needsSetup: () => !store.auth(),
    currentSession,
    currentUser: (req) => currentSession(req)?.username,
    secret: () => store.auth()?.secret ?? "",
    isSecure: (req) => req.headers["x-forwarded-proto"] === "https" || req.protocol === "https",
    stopOwnedPlayback: async (sid) => { stopped.push(sid); },
  };
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app, ctx);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error), messageKey: messageKeyOf(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    store,
    stopped,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
};

const api = (base: string, pathname: string, init: { method?: string; body?: unknown; cookie?: string } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

const keyOf = async (response: Response) => ((await response.json()) as { messageKey?: string }).messageKey;

const seedAccount = async (store: Store, password = "current-secret", secret = "signing-secret") => {
  const passwordHash = await hashPassword(password);
  await store.update((state) => {
    state.auth = { username: "owner", passwordHash, secret, isDefault: false, revoked: {} };
  });
};

test("GET /api/auth/me answers the setup flag with the interface language", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/auth/me");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { setup: true, language: "en" });
});

test("GET /api/auth/me without a session is 401 and still carries the language", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  await seedAccount(harness.store);
  const response = await api(harness.base, "/api/auth/me");
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Not signed in.", messageKey: "err.notSignedIn", language: "en" });
});

test("POST /api/auth/setup refuses a short username and a short password", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const shortName = await api(harness.base, "/api/auth/setup", { method: "POST", body: { username: "ab", password: "longenough" } });
  assert.equal(shortName.status, 400);
  assert.equal(await keyOf(shortName), "auth.usernameTooShort");
  const shortPassword = await api(harness.base, "/api/auth/setup", { method: "POST", body: { username: "owner", password: "12345" } });
  assert.equal(shortPassword.status, 400);
  assert.equal(await keyOf(shortPassword), "auth.passwordTooShort");
});

test("POST /api/auth/setup refuses once an account exists", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const created = await api(harness.base, "/api/auth/setup", { method: "POST", body: { username: "owner", password: "secret1" } });
  assert.equal(created.status, 201);
  const again = await api(harness.base, "/api/auth/setup", { method: "POST", body: { username: "intruder", password: "secret2" } });
  assert.equal(await keyOf(again), "err.setupDone");
});

test("POST /api/auth/login answers 401, then 429 with retry-after after six failures", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  await seedAccount(harness.store, "right-password");
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await api(harness.base, "/api/auth/login", { method: "POST", body: { username: "owner", password: "wrong-password" } });
    assert.equal(response.status, 401, `attempt ${attempt + 1}`);
    assert.equal(await keyOf(response), "err.badCredentials");
  }
  const blocked = await api(harness.base, "/api/auth/login", { method: "POST", body: { username: "owner", password: "right-password" } });
  assert.equal(blocked.status, 429);
  assert.equal(await keyOf(blocked), "err.tooManyAttempts");
  assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
});

test("POST /api/auth/logout with everywhere rotates the secret", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  await seedAccount(harness.store, "current-secret", "old-secret");
  const cookie = sessionCookie(createSession("old-secret", "owner", Date.now() + 60_000, "sid-everywhere"), true, false);
  const response = await api(harness.base, "/api/auth/logout", { method: "POST", body: { everywhere: true }, cookie });
  assert.equal(response.status, 204);
  const secret = harness.store.auth()?.secret;
  assert.ok(secret && secret !== "old-secret");
  assert.deepEqual(harness.stopped, [undefined]);
});

test("POST /api/auth/logout without everywhere records the session id in revoked", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  await seedAccount(harness.store, "current-secret", "old-secret");
  const expiresAt = Date.now() + 60_000;
  const cookie = sessionCookie(createSession("old-secret", "owner", expiresAt, "sid-single"), true, false);
  const response = await api(harness.base, "/api/auth/logout", { method: "POST", body: {}, cookie });
  assert.equal(response.status, 204);
  assert.equal(harness.store.auth()?.secret, "old-secret");
  assert.equal(harness.store.auth()?.revoked?.["sid-single"], expiresAt);
  assert.deepEqual(harness.stopped, ["sid-single"]);
});

test("PATCH /api/auth/password refuses a wrong current password and a short new one", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  await seedAccount(harness.store, "current-secret");
  const wrong = await api(harness.base, "/api/auth/password", { method: "PATCH", body: { currentPassword: "not-it", newPassword: "long-enough" } });
  assert.equal(wrong.status, 400);
  assert.equal(await keyOf(wrong), "err.wrongCurrentPassword");
  const short = await api(harness.base, "/api/auth/password", { method: "PATCH", body: { currentPassword: "current-secret", newPassword: "12345" } });
  assert.equal(short.status, 400);
  assert.equal(await keyOf(short), "auth.newPasswordTooShort");
});
