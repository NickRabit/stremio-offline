import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { createSession, hashPassword, parseCookies, readSession, SESSION_COOKIE, sessionCookie, sessionUserId, verifyPassword, type SessionInfo } from "../auth.js";
import { messageKeyOf } from "../errors.js";
import { Store, type UserPrefs } from "../store.js";
import { findUserById, type UserRecord } from "../users.js";
import { registerAuthRoutes } from "./auth.js";
import type { RouteContext } from "./context.js";

interface Harness {
  base: string;
  store: Store;
  stopped: Array<string | undefined>;
  stoppedUsers: string[];
  /** Which sweep ran, so a test can tell a session teardown from a whole-account one. */
  sweeps: string[];
  close(): Promise<void>;
}

/** The routes take everything they need from the context, so the app here is a real
 *  express instance with the same state the server passes in -- only the store is
 *  redirected to a throwaway directory. A `state` replaces the file it loads. */
const mount = async (state?: unknown): Promise<Harness> => {
  const dir = await mkdtemp(path.join(tmpdir(), "routes-auth-"));
  if (state) await writeFile(path.join(dir, "state.json"), JSON.stringify(state));
  const store = new Store(dir, dir);
  await store.load();
  const stopped: Array<string | undefined> = [];
  const stoppedUsers: string[] = [];
  const sweeps: string[] = [];
  const currentSession = (req: express.Request): SessionInfo | undefined => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const id = sessionUserId(token);
    const user = id ? findUserById(store.users(), id) : undefined;
    if (!user || user.disabled) return undefined;
    const info = readSession(user.secret, token);
    if (!info || info.userId !== user.id) return undefined;
    return user.revoked?.[info.sid] ? undefined : info;
  };
  const ctx: RouteContext = {
    store,
    needsSetup: () => !store.users().length,
    currentSession,
    currentUser: (req) => {
      const session = currentSession(req);
      return session ? findUserById(store.users(), session.userId) : undefined;
    },
    isSecure: (req) => req.headers["x-forwarded-proto"] === "https" || req.protocol === "https",
    stopOwnedPlayback: async (sid) => { stopped.push(sid); },
    stopUserAccess: async (userId) => { stoppedUsers.push(userId); sweeps.push(`full:${userId}`); },
    stopUserSessions: async (userId) => { stoppedUsers.push(userId); sweeps.push(`sessions:${userId}`); },
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
  };
  const app = express();
  // The sign-in throttle counts failures per address, and every test here talks to one
  // address: a test that counts failures names its own through `x-forwarded-for`.
  app.set("trust proxy", true);
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
    stoppedUsers, sweeps,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
};

const api = (base: string, pathname: string, init: { method?: string; body?: unknown; cookie?: string; ip?: string } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.ip ? { "x-forwarded-for": init.ip } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

const keyOf = async (response: Response) => ((await response.json()) as { messageKey?: string }).messageKey;

interface SeedOptions {
  username?: string;
  id?: string;
  password?: string;
  secret?: string;
  disabled?: boolean;
  prefs?: Partial<UserPrefs>;
}

const seedUser = async (store: Store, options: SeedOptions = {}): Promise<UserRecord> => {
  const record: UserRecord = {
    id: options.id ?? "usr_00000001",
    username: options.username ?? "owner",
    passwordHash: await hashPassword(options.password ?? "current-secret"),
    secret: options.secret ?? "signing-secret",
    role: "admin",
    createdAt: "2026-01-01T00:00:00.000Z",
    permissions: { downloadToLibrary: true, downloadToDevice: true },
    permissionsVersion: 0,
    ...(options.disabled ? { disabled: true } : {}),
  };
  await store.update((state) => {
    state.users = [...(state.users ?? []), record];
    state.userData = { ...(state.userData ?? {}), [record.id]: { prefs: { ...(options.prefs ?? {}) }, favorites: [], watchlist: {}, progress: {}, watchedSeries: {} } };
  });
  return record;
};

/** The oldest shape on disk: one account outside any list, with the personal data beside
 *  it. `Store.load()` is what turns it into the accounts shape. */
const singleAccountState = async (password = "current-secret", secret = "signing-secret") => ({
  schemaVersion: 2,
  addons: [],
  defaultsInstalled: true,
  settings: { uiLanguage: "cs", concurrentDownloads: 2 },
  auth: { username: "Ondra", passwordHash: await hashPassword(password), secret, isDefault: false },
  favorites: ["/media/film.mkv"],
  progress: { "movie:tt1": { position: 12, duration: 100, title: "Neco", updatedAt: "2026-01-01T00:00:00.000Z" } },
});

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
  // The account is the only one there is, so the screen that is about to be shown speaks
  // its language even though nobody is signed in yet.
  await seedUser(harness.store, { prefs: { uiLanguage: "cs" } });
  const response = await api(harness.base, "/api/auth/me");
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Not signed in.", messageKey: "err.notSignedIn", language: "cs" });
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
  const created = await api(harness.base, "/api/auth/setup", { method: "POST", body: { username: "owner", password: "secret1", language: "cs" } });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { username: "owner", language: "cs" });
  const [record] = harness.store.users();
  assert.equal(harness.store.users().length, 1, "a fresh install ends up with one account");
  assert.equal(record?.username, "owner");
  assert.equal(record?.role, "admin");
  assert.deepEqual(record?.permissions, { downloadToLibrary: true, downloadToDevice: true });
  assert.equal(record?.permissionsVersion, 0);
  // The chosen language is a personal setting now, so it lands on the record's data.
  assert.equal(harness.store.prefs(record?.id).uiLanguage, "cs");
  assert.equal(harness.store.prefs(record?.id).audioLanguage, "cs");
  // The cookie the setup hands back is a session of the account it just made.
  const cookie = parseCookies(created.headers.get("set-cookie") ?? "")[SESSION_COOKIE];
  assert.equal(sessionUserId(cookie), record?.id);
  const again = await api(harness.base, "/api/auth/setup", { method: "POST", body: { username: "intruder", password: "secret2" } });
  assert.equal(await keyOf(again), "err.setupDone");
});

test("POST /api/auth/login answers 401, then 429 with retry-after after six failures", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  await seedUser(harness.store, { password: "right-password" });
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

test("signing in as the migrated user works and the cookie names the user id", async (t) => {
  const harness = await mount(await singleAccountState("migrated-secret", "migrated-signing-secret"));
  t.after(harness.close);
  const [owner] = harness.store.users();
  assert.equal(harness.store.users().length, 1, "the migration leaves the install with one account");
  const response = await api(harness.base, "/api/auth/login", { method: "POST", body: { username: "Ondra", password: "migrated-secret" }, ip: "10.1.0.1" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { username: "Ondra" });
  const cookie = parseCookies(response.headers.get("set-cookie") ?? "")[SESSION_COOKIE];
  assert.equal(sessionUserId(cookie), owner?.id);
  assert.equal(readSession(owner?.secret ?? "", cookie)?.userId, owner?.id);
  // The language and the personal data came across with the account.
  const me = await api(harness.base, "/api/auth/me", { cookie: `${SESSION_COOKIE}=${cookie}` });
  assert.deepEqual(await me.json(), { username: "Ondra", language: "cs" });
  assert.deepEqual(harness.store.userData(owner?.id ?? "").progress, { "movie:tt1": { position: 12, duration: 100, title: "Neco", updatedAt: "2026-01-01T00:00:00.000Z" } });
});

test("a disabled account is refused exactly like a wrong password", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  await seedUser(harness.store, { password: "current-secret", disabled: true });
  const response = await api(harness.base, "/api/auth/login", { method: "POST", body: { username: "owner", password: "current-secret" }, ip: "10.1.0.2" });
  assert.equal(response.status, 401);
  assert.equal(await keyOf(response), "err.badCredentials", "a different answer would tell a guesser the account exists");
  assert.equal(response.headers.get("set-cookie"), null);
});

test("an unknown name and a wrong password answer the same way", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  await seedUser(harness.store, { password: "current-secret" });
  const unknown = await api(harness.base, "/api/auth/login", { method: "POST", body: { username: "nikdo", password: "current-secret" }, ip: "10.1.0.3" });
  const wrong = await api(harness.base, "/api/auth/login", { method: "POST", body: { username: "owner", password: "spatne" }, ip: "10.1.0.3" });
  assert.equal(unknown.status, wrong.status);
  assert.deepEqual(await unknown.json(), await wrong.json());
  assert.equal(unknown.headers.get("set-cookie"), null);
  assert.equal(wrong.headers.get("set-cookie"), null);
});

test("POST /api/auth/logout with everywhere rotates only that account's secret", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const owner = await seedUser(harness.store, { password: "current-secret", secret: "old-secret" });
  const other = await seedUser(harness.store, { id: "usr_00000002", username: "petr", password: "druhe-heslo", secret: "other-secret" });
  const otherSession = createSession(other.secret, other.id, Date.now() + 60_000, "sid-other");
  const cookie = sessionCookie(createSession("old-secret", owner.id, Date.now() + 60_000, "sid-everywhere"), true, false);
  const response = await api(harness.base, "/api/auth/logout", { method: "POST", body: { everywhere: true }, cookie });
  assert.equal(response.status, 204);
  const secret = findUserById(harness.store.users(), owner.id)?.secret;
  assert.ok(secret && secret !== "old-secret");
  const otherAfter = findUserById(harness.store.users(), other.id);
  assert.equal(otherAfter?.secret, "other-secret");
  assert.equal(readSession(otherAfter!.secret, otherSession)?.userId, other.id, "the other person's session still verifies");
  // Every device of that one account is swept, and nobody else's: "sign out everywhere"
  // stops the streams the other devices left running, not the whole instance's.
  assert.deepEqual(harness.stoppedUsers, [owner.id]);
  assert.deepEqual(harness.stopped, []);
});

test("signing out everywhere leaves the account's downloads queued", async (t) => {
  // A queued download is owner-bound, not session-bound: it is queued precisely so it can
  // outlive the browser. Sweeping the whole account here would stop a film downloading
  // because somebody closed a laptop, so sign-out reaches only what is held open.
  const harness = await mount();
  t.after(harness.close);
  const owner = await seedUser(harness.store, { password: "current-secret", secret: "old-secret" });
  const cookie = sessionCookie(createSession("old-secret", owner.id, Date.now() + 60_000, "sid-queue"), true, false);

  const response = await api(harness.base, "/api/auth/logout", { method: "POST", body: { everywhere: true }, cookie });

  assert.equal(response.status, 204);
  assert.deepEqual(harness.sweeps, [`sessions:${owner.id}`],
    "the session sweep runs; the full account sweep, which pauses downloads, does not");
});

test("POST /api/auth/logout without everywhere records the session id in revoked", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const owner = await seedUser(harness.store, { password: "current-secret", secret: "old-secret" });
  const expiresAt = Date.now() + 60_000;
  const cookie = sessionCookie(createSession("old-secret", owner.id, expiresAt, "sid-single"), true, false);
  const response = await api(harness.base, "/api/auth/logout", { method: "POST", body: {}, cookie });
  assert.equal(response.status, 204);
  assert.equal(findUserById(harness.store.users(), owner.id)?.secret, "old-secret");
  assert.equal(findUserById(harness.store.users(), owner.id)?.revoked?.["sid-single"], expiresAt);
  assert.deepEqual(harness.stopped, ["sid-single"]);
});

test("PATCH /api/auth/password refuses a wrong current password and a short new one", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const owner = await seedUser(harness.store, { password: "current-secret" });
  const cookie = `${SESSION_COOKIE}=${createSession(owner.secret, owner.id, Date.now() + 60_000, "sid-password-form")}`;
  const wrong = await api(harness.base, "/api/auth/password", { method: "PATCH", cookie, body: { currentPassword: "not-it", newPassword: "long-enough" } });
  assert.equal(wrong.status, 400);
  assert.equal(await keyOf(wrong), "err.wrongCurrentPassword");
  const short = await api(harness.base, "/api/auth/password", { method: "PATCH", cookie, body: { currentPassword: "current-secret", newPassword: "12345" } });
  assert.equal(short.status, 400);
  assert.equal(await keyOf(short), "auth.newPasswordTooShort");
});

test("PATCH /api/auth/password rotates the caller's secret and leaves another account alone", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const owner = await seedUser(harness.store, { password: "current-secret", secret: "old-secret" });
  const other = await seedUser(harness.store, { id: "usr_00000002", username: "petr", password: "druhe-heslo", secret: "other-secret" });
  const token = createSession("old-secret", owner.id, Date.now() + 60_000, "sid-password");
  const response = await api(harness.base, "/api/auth/password", {
    method: "PATCH", cookie: `${SESSION_COOKIE}=${token}`,
    body: { currentPassword: "current-secret", newPassword: "nove-heslo" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { username: "owner" });
  const changed = findUserById(harness.store.users(), owner.id);
  assert.ok(changed && changed.secret !== "old-secret", "every token issued before the change stops working");
  assert.ok(await verifyPassword("nove-heslo", changed.passwordHash));
  // The device that made the change is given a session of the new secret straight away.
  const issued = parseCookies(response.headers.get("set-cookie") ?? "")[SESSION_COOKIE];
  assert.equal(readSession(changed.secret, issued)?.userId, owner.id);
  assert.equal((await api(harness.base, "/api/auth/me", { cookie: `${SESSION_COOKIE}=${issued}` })).status, 200);
  assert.equal(findUserById(harness.store.users(), other.id)?.secret, "other-secret", "the other person is untouched");
  assert.deepEqual(harness.stoppedUsers, [owner.id], "every session of that account is swept, and only that account's");
});
