import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { createSession, hashPassword, parseCookies, readSession, SESSION_COOKIE, sessionUserId, type SessionInfo } from "../auth.js";
import { messageKeyOf } from "../errors.js";
import { flushLog, initLogger } from "../logger.js";
import { profileAttempts } from "../profile-attempts.js";
import { roleMiddleware } from "../roles.js";
import { defaultInstanceSettings, Store, type State } from "../store.js";
import { emptyUserData, findUserById, newUserPermissions, type UserRecord } from "../users.js";
import { registerAuthRoutes } from "./auth.js";
import type { RouteContext } from "./context.js";
import { registerProfilesRoutes } from "./profiles.js";

const ALICE = "usr_00000001";
const BOB = "usr_00000002";
const CAROL = "usr_00000003";
const DAVE = "usr_00000004";
const ERIN = "usr_00000005";

type AccountOptions = Partial<UserRecord> & Pick<UserRecord, "id" | "username"> & { password?: string };

const account = async (over: AccountOptions): Promise<UserRecord> => {
  const { password, ...fields } = over;
  return {
    passwordHash: await hashPassword(password || "current-secret"),
    secret: `secret-${over.id}`,
    role: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    permissions: newUserPermissions(),
    permissionsVersion: 0,
    switcher: true,
    ...fields,
  };
};

interface Harness {
  base: string;
  dir: string;
  store: Store;
  stopped: string[];
  forgotten: string[];
  writes: number;
  beforeNextUpdate(run: () => Promise<void>): void;
  close(): Promise<void>;
}

const mount = async (users: UserRecord[]): Promise<Harness> => {
  const dir = await mkdtemp(path.join(tmpdir(), "routes-profiles-"));
  await writeFile(path.join(dir, "state.json"), JSON.stringify({
    schemaVersion: 3,
    addons: [],
    settings: defaultInstanceSettings(),
    defaultsInstalled: true,
    users,
    userData: Object.fromEntries(users.map((user) => [user.id, {
      ...emptyUserData(),
      prefs: { uiLanguage: user.id === BOB ? "cs" : "en" },
    }])),
    libraries: [],
    mediaConnections: [],
    remoteLibraries: [],
  }));
  const store = new Store(dir, dir);
  await store.load();

  const stopped: string[] = [];
  const forgotten: string[] = [];
  let writes = 0;
  let beforeUpdate: (() => Promise<void>) | undefined;
  const update = store.update.bind(store);
  (store as unknown as { update(mutate: (state: State) => unknown): Promise<void> }).update = async (mutate) => {
    writes += 1;
    const hook = beforeUpdate;
    beforeUpdate = undefined;
    if (hook) await hook();
    return update(mutate);
  };

  const currentSession = (req: express.Request): SessionInfo | undefined => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const id = sessionUserId(token);
    const user = id ? findUserById(store.users(), id) : undefined;
    if (!user || user.disabled) return undefined;
    const info = readSession(user.secret, token);
    if (!info || info.userId !== user.id || user.revoked?.[info.sid]) return undefined;
    return info;
  };
  const currentUser = (req: express.Request): UserRecord | undefined => {
    const session = currentSession(req);
    return session ? findUserById(store.users(), session.userId) : undefined;
  };
  const ctx: RouteContext = {
    store,
    needsSetup: () => !store.users().length,
    currentSession,
    currentUser,
    isSecure: () => false,
    stopOwnedPlayback: async (sid) => { stopped.push(sid); },
    stopUserSessions: async () => undefined,
    forgetMediaPlayback: (userId) => { forgotten.push(userId); },
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
  };

  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use("/api", roleMiddleware({ isOpen: () => false, isInternal: () => false, roleOf: (req) => currentUser(req)?.role }));
  registerAuthRoutes(app, ctx);
  registerProfilesRoutes(app, ctx);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    const vars = (error as { vars?: unknown }).vars;
    res.status(status).json({
      error: error instanceof Error ? error.message : String(error),
      messageKey: messageKeyOf(error),
      ...(vars ? { vars } : {}),
    });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    dir,
    store,
    stopped,
    forgotten,
    get writes() { return writes; },
    beforeNextUpdate: (run) => { beforeUpdate = run; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
};

const api = (
  base: string,
  pathname: string,
  init: { method?: string; body?: unknown; cookie?: string; ip?: string } = {},
) => fetch(`${base}${pathname}`, {
  method: init.method ?? "GET",
  headers: {
    ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    ...(init.cookie ? { cookie: `${SESSION_COOKIE}=${init.cookie}` } : {}),
    ...(init.ip ? { "x-forwarded-for": init.ip } : {}),
  },
  body: init.body === undefined ? undefined : JSON.stringify(init.body),
});

const cookieFor = (user: UserRecord, sid: string, expiresAt = Date.now() + 120_000) =>
  createSession(user.secret, user.id, expiresAt, sid);

const keyOf = async (response: Response) =>
  ((await response.json()) as { messageKey?: string }).messageKey;

test("GET /api/profiles lists only enterable switcher members and the current account", async (t) => {
  const alice = await account({ id: ALICE, username: "alice", unlock: "pin", pinHash: await hashPassword("1234") });
  const bob = await account({ id: BOB, username: "bob", unlock: "none" });
  const carol = await account({ id: CAROL, username: "carol", switcher: false });
  const disabled = await account({ id: DAVE, username: "disabled", disabled: true });
  const changing = await account({ id: ERIN, username: "changing", mustChangePassword: true });
  const harness = await mount([alice, bob, carol, disabled, changing]);
  t.after(harness.close);
  profileAttempts.succeed(ALICE);
  t.after(() => profileAttempts.succeed(ALICE));

  const response = await api(harness.base, "/api/profiles", { cookie: cookieFor(alice, "sid-list") });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), {
    profiles: [
      { id: ALICE, username: "alice", unlock: "pin", current: true, pinLocked: false },
      { id: BOB, username: "bob", unlock: "none", current: false },
    ],
  });

  const guest = await api(harness.base, "/api/profiles", { cookie: cookieFor(carol, "sid-guest") });
  assert.deepEqual(await guest.json(), { profiles: [] });
});

test("a caller outside the group cannot distinguish a member, a non-member or an unknown id", async (t) => {
  const guest = await account({ id: ALICE, username: "guest", switcher: false });
  const member = await account({ id: BOB, username: "member", unlock: "none" });
  const hidden = await account({ id: CAROL, username: "hidden", switcher: false });
  const disabled = await account({ id: DAVE, username: "disabled", disabled: true });
  const changing = await account({ id: ERIN, username: "changing", mustChangePassword: true });
  const harness = await mount([guest, member, hidden, disabled, changing]);
  t.after(harness.close);
  const cookie = cookieFor(guest, "sid-guest-switch");

  const responses = await Promise.all([member.id, hidden.id, disabled.id, changing.id, "usr_deadbeef"].map((id) =>
    api(harness.base, "/api/profiles/switch", { method: "POST", cookie, body: { id } })));
  for (const response of responses) {
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), {
      error: "That profile is not available.",
      messageKey: "err.profileUnavailable",
    });
  }
});

test("a member gets the same 404 for every target that GET /api/profiles does not list", async (t) => {
  const alice = await account({ id: ALICE, username: "alice" });
  const hidden = await account({ id: BOB, username: "hidden", switcher: false });
  const disabled = await account({ id: CAROL, username: "disabled", disabled: true });
  const changing = await account({ id: DAVE, username: "changing", mustChangePassword: true });
  const harness = await mount([alice, hidden, disabled, changing]);
  t.after(harness.close);
  const cookie = cookieFor(alice, "sid-hidden");

  for (const id of [hidden.id, disabled.id, changing.id, alice.id, "usr_deadbeef"]) {
    const response = await api(harness.base, "/api/profiles/switch", { method: "POST", cookie, body: { id } });
    assert.equal(response.status, 404, id);
    assert.equal(await keyOf(response), "err.profileUnavailable", id);
  }
});

test("a none profile switches in one write, revokes and stops the old session, and keeps its expiry", async (t) => {
  const alice = await account({ id: ALICE, username: "alice" });
  const bob = await account({ id: BOB, username: "bob", unlock: "none" });
  const harness = await mount([alice, bob]);
  t.after(harness.close);
  const expiresAt = Date.now() + 120_000;
  const cookie = cookieFor(alice, "sid-old", expiresAt);
  const before = Date.now();

  const response = await api(harness.base, "/api/profiles/switch", {
    method: "POST", cookie, body: { id: BOB },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    username: "bob", role: "user", language: "cs", mustChangePassword: false,
  });
  assert.equal(harness.writes, 1);
  assert.deepEqual(harness.stopped, ["sid-old"]);
  assert.deepEqual(harness.forgotten, [ALICE]);
  assert.equal(findUserById(harness.store.users(), ALICE)?.revoked?.["sid-old"], expiresAt);
  assert.ok(findUserById(harness.store.users(), BOB)?.lastSeenAt);

  const issued = parseCookies(response.headers.get("set-cookie") ?? "")[SESSION_COOKIE];
  const switched = readSession(bob.secret, issued);
  assert.equal(switched?.userId, BOB);
  assert.equal(switched?.expiresAt, expiresAt);
  const maxAge = Number(/Max-Age=(\d+)/.exec(response.headers.get("set-cookie") ?? "")?.[1]);
  assert.ok(maxAge >= Math.floor((expiresAt - before) / 1000) - 2 && maxAge <= 120);

  const old = await api(harness.base, "/api/auth/me", { cookie });
  assert.equal(old.status, 401);
});

test("wrong PIN, wrong password and a missing password fail without a state write", async (t) => {
  const alice = await account({ id: ALICE, username: "alice" });
  const pin = await account({ id: BOB, username: "pin", unlock: "pin", pinHash: await hashPassword("1234") });
  const password = await account({ id: CAROL, username: "password", unlock: "password" });
  const none = await account({ id: DAVE, username: "none", unlock: "none" });
  const harness = await mount([alice, pin, password, none]);
  t.after(harness.close);
  profileAttempts.succeed(BOB);
  profileAttempts.succeed(CAROL);
  t.after(() => { profileAttempts.succeed(BOB); profileAttempts.succeed(CAROL); });
  const cookie = cookieFor(alice, "sid-errors");

  const cases = [
    { body: { id: BOB, pin: "9999" }, key: "err.badPin" },
    { body: { id: CAROL, password: "wrong" }, key: "err.badCredentials" },
    { body: { id: CAROL }, key: "err.badCredentials" },
    { body: { id: BOB, pin: "1234", password: "wrong" }, key: "err.badCredentials" },
    { body: { id: DAVE, password: "wrong" }, key: "err.badCredentials" },
  ];
  for (const entry of cases) {
    const response = await api(harness.base, "/api/profiles/switch", { method: "POST", cookie, body: entry.body });
    assert.equal(response.status, 401);
    assert.equal(await keyOf(response), entry.key);
  }
  assert.equal(harness.writes, 0);
  assert.deepEqual(harness.stopped, []);
});

test("a PIN profile accepts its PIN or its password, and a password profile enters with its password", async (t) => {
  for (const kind of ["pin", "password"] as const) {
    const alice = await account({ id: ALICE, username: "alice" });
    const bob = await account({
      id: BOB,
      username: "bob",
      unlock: kind,
      ...(kind === "pin" ? { pinHash: await hashPassword("1234") } : {}),
    });
    const harness = await mount([alice, bob]);
    profileAttempts.succeed(BOB);
    try {
      const response = await api(harness.base, "/api/profiles/switch", {
        method: "POST",
        cookie: cookieFor(alice, `sid-${kind}`),
        body: kind === "pin" ? { id: BOB, pin: "1234" } : { id: BOB, password: "current-secret" },
      });
      assert.equal(response.status, 200, kind);
      assert.equal((await response.json() as { username: string }).username, "bob");
    } finally {
      profileAttempts.succeed(BOB);
      await harness.close();
    }
  }

  const alice = await account({ id: ALICE, username: "alice" });
  const bob = await account({ id: BOB, username: "bob", unlock: "pin", pinHash: await hashPassword("1234") });
  const harness = await mount([alice, bob]);
  t.after(harness.close);
  profileAttempts.succeed(BOB);
  t.after(() => profileAttempts.succeed(BOB));
  const response = await api(harness.base, "/api/profiles/switch", {
    method: "POST",
    cookie: cookieFor(alice, "sid-pin-password"),
    body: { id: BOB, password: "current-secret" },
  });
  assert.equal(response.status, 200, "the password is accepted for a PIN profile");
});

test("the sixth failure waits, counting is per target across callers and addresses, and the tenth locks", async (t) => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ["Date"], now });
  const alice = await account({ id: ALICE, username: "alice" });
  const carol = await account({ id: CAROL, username: "carol" });
  const bob = await account({ id: BOB, username: "bob", unlock: "pin", pinHash: await hashPassword("1234") });
  const harness = await mount([alice, carol, bob]);
  t.after(harness.close);
  profileAttempts.succeed(BOB);
  t.after(() => profileAttempts.succeed(BOB));

  const aliceCookie = cookieFor(alice, "sid-alice-limit", now + 24 * 60 * 60_000);
  const carolCookie = cookieFor(carol, "sid-carol-limit", now + 24 * 60 * 60_000);
  for (let count = 1; count <= 5; count += 1) {
    const response = await api(harness.base, "/api/profiles/switch", {
      method: "POST", cookie: aliceCookie, ip: `10.0.0.${count}`, body: { id: BOB, pin: "9999" },
    });
    assert.equal(response.status, 401);
  }
  const sixth = await api(harness.base, "/api/profiles/switch", {
    method: "POST", cookie: carolCookie, ip: "10.0.0.99", body: { id: BOB, pin: "9999" },
  });
  assert.equal(sixth.status, 401);
  assert.equal(profileAttempts.retryAfterMs(BOB), 30_000);

  const blocked = await api(harness.base, "/api/profiles/switch", {
    method: "POST", cookie: aliceCookie, ip: "10.0.0.200", body: { id: BOB, password: "current-secret" },
  });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "30");
  assert.equal(await keyOf(blocked), "err.tooManyAttempts");

  for (let count = 7; count <= 10; count += 1) {
    t.mock.timers.tick(profileAttempts.retryAfterMs(BOB));
    await api(harness.base, "/api/profiles/switch", {
      method: "POST", cookie: carolCookie, body: { id: BOB, pin: "9999" },
    });
  }
  assert.equal(profileAttempts.pinLocked(BOB), true);
  t.mock.timers.tick(profileAttempts.retryAfterMs(BOB));
  const wrongPin = await api(harness.base, "/api/profiles/switch", {
    method: "POST", cookie: aliceCookie, body: { id: BOB, pin: "1234" },
  });
  assert.equal(wrongPin.status, 403);
  assert.equal(await keyOf(wrongPin), "err.pinLocked");

  const password = await api(harness.base, "/api/profiles/switch", {
    method: "POST", cookie: carolCookie, body: { id: BOB, password: "current-secret" },
  });
  assert.equal(password.status, 200, "a password enters a profile whose PIN is locked");
  assert.equal(profileAttempts.pinLocked(BOB), false);
});

test("a caller removed from the group between the secret check and the write is refused", async (t) => {
  const alice = await account({ id: ALICE, username: "alice" });
  const bob = await account({ id: BOB, username: "bob", unlock: "none" });
  const harness = await mount([alice, bob]);
  t.after(harness.close);
  const original = harness.store.update.bind(harness.store);
  harness.beforeNextUpdate(async () => {
    await original((state) => {
      state.users = (state.users ?? []).map((user) => user.id === ALICE ? { ...user, switcher: false } : user);
    });
  });

  const response = await api(harness.base, "/api/profiles/switch", {
    method: "POST", cookie: cookieFor(alice, "sid-removed"), body: { id: BOB },
  });
  assert.equal(response.status, 404);
  assert.equal(await keyOf(response), "err.profileUnavailable");
  assert.deepEqual(harness.stopped, []);
  assert.equal(findUserById(harness.store.users(), ALICE)?.revoked?.["sid-removed"], undefined);
});

test("a target PIN changed while its hash is checked is refused", async (t) => {
  const alice = await account({ id: ALICE, username: "alice" });
  const bob = await account({ id: BOB, username: "bob", unlock: "pin", pinHash: await hashPassword("1234") });
  const harness = await mount([alice, bob]);
  t.after(harness.close);
  profileAttempts.succeed(BOB);
  t.after(() => profileAttempts.succeed(BOB));
  const nextHash = await hashPassword("5678");
  const original = harness.store.update.bind(harness.store);
  harness.beforeNextUpdate(async () => {
    await original((state) => {
      state.users = (state.users ?? []).map((user) => user.id === BOB ? { ...user, pinHash: nextHash } : user);
    });
  });

  const response = await api(harness.base, "/api/profiles/switch", {
    method: "POST", cookie: cookieFor(alice, "sid-pin-changed"), body: { id: BOB, pin: "1234" },
  });
  assert.equal(response.status, 404);
  assert.deepEqual(harness.stopped, []);
});

test("invalid switch bodies are refused as invalid requests", async (t) => {
  const alice = await account({ id: ALICE, username: "alice" });
  const bob = await account({ id: BOB, username: "bob", unlock: "none" });
  const harness = await mount([alice, bob]);
  t.after(harness.close);
  const cookie = cookieFor(alice, "sid-invalid");

  for (const body of [{}, { id: 1 }, { id: BOB, pin: 1234 }, { id: BOB, password: false }]) {
    const response = await api(harness.base, "/api/profiles/switch", { method: "POST", cookie, body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(await keyOf(response), "err.invalidRequest");
  }
});

test("restricted mode lists no profiles and refuses a switch", async (t) => {
  const previous = process.env.RESTRICTED_MODE;
  const alice = await account({ id: ALICE, username: "alice" });
  const bob = await account({ id: BOB, username: "bob", unlock: "none" });
  const harness = await mount([alice, bob]);
  t.after(async () => {
    if (previous === undefined) delete process.env.RESTRICTED_MODE;
    else process.env.RESTRICTED_MODE = previous;
    await harness.close();
  });
  process.env.RESTRICTED_MODE = "1";
  const cookie = cookieFor(alice, "sid-restricted");

  const list = await api(harness.base, "/api/profiles", { cookie });
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await list.json(), { profiles: [] });
  const switched = await api(harness.base, "/api/profiles/switch", { method: "POST", cookie, body: { id: BOB } });
  assert.equal(switched.status, 403);
  assert.equal(await keyOf(switched), "err.restricted");
  assert.equal(switched.headers.get("cache-control"), "private, no-store");
});

test("PIN switch and PIN setting never expose the PIN, its hash or its length", async (t) => {
  const previousStdout = process.env.LOG_STDOUT;
  process.env.LOG_STDOUT = "0";
  const alice = await account({ id: ALICE, username: "alice" });
  const bob = await account({ id: BOB, username: "bob", unlock: "pin", pinHash: await hashPassword("1234") });
  const harness = await mount([alice, bob]);
  t.after(async () => {
    if (previousStdout === undefined) delete process.env.LOG_STDOUT;
    else process.env.LOG_STDOUT = previousStdout;
    profileAttempts.succeed(BOB);
    await harness.close();
  });
  profileAttempts.succeed(BOB);
  await initLogger(harness.dir);
  const bodies: string[] = [];

  const failed = await api(harness.base, "/api/profiles/switch", {
    method: "POST", cookie: cookieFor(alice, "sid-leak-failed"), body: { id: BOB, pin: "9999" },
  });
  bodies.push(await failed.text());

  const switched = await api(harness.base, "/api/profiles/switch", {
    method: "POST", cookie: cookieFor(alice, "sid-leak-success"), body: { id: BOB, pin: "1234" },
  });
  bodies.push(await switched.text());

  const set = await api(harness.base, "/api/auth/pin", {
    method: "PATCH",
    cookie: cookieFor(bob, "sid-leak-pin"),
    body: { currentPassword: "current-secret", pin: "5678" },
  });
  bodies.push(await set.text());
  await flushLog();
  const logs = await readFile(path.join(harness.dir, "app.log"), "utf8");
  const everything = `${bodies.join("\n")}\n${logs}`;

  assert.equal(everything.includes("1234"), false);
  assert.equal(everything.includes("9999"), false);
  assert.equal(everything.includes("5678"), false);
  assert.equal(everything.includes("scrypt$"), false);
  assert.equal(everything.includes('"length"'), false);
});
