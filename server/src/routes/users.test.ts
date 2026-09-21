import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { AirPlayAccess } from "../airplay-access.js";
import { createSession, parseCookies, readSession, SESSION_COOKIE, sessionUserId, verifyPassword, type SessionInfo } from "../auth.js";
import { DownloadQueue, type DownloadJob } from "../downloads.js";
import { messageKeyOf } from "../errors.js";
import type { LibraryRecord } from "../libraries.js";
import { MediaResources, type DeviceDownloadTicket, type ResourceOwner } from "../media-resources.js";
import { Revocations, type ActiveTransfer, type RevocationQueue } from "../revocation.js";
import { roleMiddleware } from "../roles.js";
import { defaultInstanceSettings, Store, type State } from "../store.js";
import type { AddonRecord } from "../types.js";
import { emptyUserData, findUser, findUserById, newUserPermissions, PASSWORD_MIN, USERNAME_MIN, type UserData, type UserRecord } from "../users.js";
import { registerAuthRoutes } from "./auth.js";
import type { RouteContext } from "./context.js";
import { registerUsersRoutes, type UsersDeps } from "./users.js";

const ADA = "usr_00000001";
const BOB = "usr_00000002";
const CAROL = "usr_00000003";
const LIBRARY = "lib_d10ad10a";

/** A record shaped the way the store keeps one. The hash and the secret are fake: only the
 *  tests that sign in need a password that verifies. */
const account = (over: Partial<UserRecord> & Pick<UserRecord, "id" | "username">): UserRecord => ({
  passwordHash: "scrypt$aa$bb",
  secret: `secret-${over.id}`,
  role: "user",
  createdAt: "2026-01-01T00:00:00.000Z",
  permissions: newUserPermissions(),
  permissionsVersion: 0,
  ...over,
});

const admin = account({ id: ADA, username: "ada", role: "admin", permissions: { downloadToLibrary: true, downloadToDevice: true } });
const bob = account({ id: BOB, username: "bob" });
const carol = account({ id: CAROL, username: "carol" });

const library = (root: string, visibleTo?: string[]): LibraryRecord => ({
  id: LIBRARY, name: "Downloads", type: "mixed", root, enabled: true, order: 0,
  addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: false,
  ...(visibleTo ? { visibleTo } : {}),
});

const addon = (key: string, allowedUsers?: string[]): AddonRecord => ({
  key, manifestUrl: `https://${key}.example/manifest.json`, role: "both", enabled: true, globalSearch: true,
  addedAt: "2026-01-01T00:00:00.000Z", manifest: { id: key, name: `Addon ${key}`, version: "1.0.0" },
  downloadSettings: { movie: { subfolder: "", layout: "flat" }, series: { subfolder: "", layout: "flat" } },
  ...(allowedUsers ? { allowedUsers } : {}),
});

const job = (id: string, ownerUserId: string, over: Partial<DownloadJob> = {}): DownloadJob => ({
  id, title: id, status: "paused", pauseReason: "user", target: "", received: 0, speed: 0,
  ownerUserId, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

interface Harness {
  base: string;
  /** The throwaway directory the state and the download files live in. */
  dir: string;
  store: Store;
  /** The queue's own view of its jobs, whichever queue the harness built. */
  jobs(): Array<{ id: string; status: string; pauseReason?: string; ownerUserId?: string }>;
  paused: string[];
  removed: string[];
  resources: MediaResources;
  activeMedia: Set<ActiveTransfer>;
  deviceTickets: Map<string, DeviceDownloadTicket>;
  stoppedPlayback: string[];
  /** How many writes are waiting for `releaseWrites`, so a test can interleave two of them. */
  pendingWrites(): number;
  holdWrites(): void;
  releaseWrites(): void;
  close(): Promise<void>;
}

/**
 * The routes take everything they need from the context, so the app here is a real express
 * instance with the same state the server passes in: a real store and a real revocation
 * sweep over throwaway paths. Only the queue can be swapped, because a route test needs to
 * hold its jobs still.
 */
const mount = async (options: {
  users?: UserRecord[];
  userData?: Record<string, UserData>;
  libraries?: (dir: string) => LibraryRecord[];
  addons?: AddonRecord[];
  jobs?: DownloadJob[];
  /** A real queue, so the file a cancelled job leaves behind can be looked at. */
  realQueue?: boolean;
  files?: (dir: string) => Promise<void>;
} = {}): Promise<Harness> => {
  const dir = await mkdtemp(path.join(tmpdir(), "routes-users-"));
  const users = options.users ?? [admin];
  await writeFile(path.join(dir, "state.json"), JSON.stringify({
    schemaVersion: 3,
    addons: options.addons ?? [],
    settings: defaultInstanceSettings(),
    defaultsInstalled: true,
    users,
    userData: options.userData ?? Object.fromEntries(users.map((entry) => [entry.id, emptyUserData()])),
    libraries: options.libraries?.(dir) ?? [],
  }));
  if (options.files) await options.files(dir);
  const store = new Store(dir, dir);
  await store.load();

  // Mirrors the two status filters `DownloadQueue` applies: a pause reaches work that is
  // running, a cancel drops everything that is not finished.
  const jobs = options.jobs ?? [];
  const paused: string[] = [];
  const removed: string[] = [];
  const fakeQueue: RevocationQueue = {
    ownerOf: (candidate) => candidate.ownerUserId,
    pauseMatching: async (match) => {
      const hit = jobs.filter((candidate) => ["queued", "waiting", "checking", "downloading"].includes(candidate.status) && match(candidate));
      for (const candidate of hit) { candidate.status = "paused"; candidate.pauseReason = "permission"; paused.push(candidate.id); }
      return hit.length;
    },
    removeMatching: async (match) => {
      const hit = jobs.filter((candidate) => candidate.status !== "completed" && match(candidate));
      for (const candidate of hit) { jobs.splice(jobs.indexOf(candidate), 1); removed.push(candidate.id); }
      return hit.length;
    },
  };
  let real: DownloadQueue | undefined;
  let queue: RevocationQueue = fakeQueue;
  if (options.realQueue) {
    await mkdir(path.join(dir, "queue"), { recursive: true });
    await writeFile(path.join(dir, "queue", "downloads.json"), JSON.stringify(jobs));
    real = new DownloadQueue(() => 1, () => 1, path.join(dir, "queue"), path.join(dir, "downloads"), {
      retryDelay: () => 60_000,
      libraries: () => store.libraries(),
    });
    await real.load();
    queue = real;
  }

  const resources = new MediaResources();
  const activeMedia = new Set<ActiveTransfer>();
  const deviceTickets = new Map<string, DeviceDownloadTicket>();
  const playbackOwners = new Map<string, { owner: ResourceOwner; resourceId: string }>();
  const stoppedPlayback: string[] = [];
  const revocations = new Revocations({
    source: { users: () => store.users(), addons: () => store.addons(), libraries: () => store.libraries() },
    resources,
    airplay: new AirPlayAccess(resources),
    playbackOwners,
    activeMedia,
    deviceTickets,
    stopPlayback: async (id) => { stoppedPlayback.push(id); },
    queue,
  });

  // A write can be held, so two requests can both reach their mutator before either runs.
  const write = store.update.bind(store);
  let held: Array<() => void> = [];
  let holding = false;
  (store as unknown as { update(mutate: (state: State) => void): Promise<void> }).update = (mutate) => {
    if (!holding) return write(mutate);
    return new Promise<void>((resolve, reject) => {
      held.push(() => { void write(mutate).then(resolve, reject); });
    });
  };

  const currentSession = (req: express.Request): SessionInfo | undefined => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const id = sessionUserId(token);
    const user = id ? findUserById(store.users(), id) : undefined;
    if (!user || user.disabled) return undefined;
    const info = readSession(user.secret, token);
    if (!info || info.userId !== user.id) return undefined;
    return user.revoked?.[info.sid] ? undefined : info;
  };
  /** A cookie names the caller; without one the header does, so a test can act as any
   *  account without signing in first. Nobody named means the administrator. */
  const currentUser = (req: express.Request): UserRecord | undefined => {
    const session = currentSession(req);
    if (session) return findUserById(store.users(), session.userId);
    return findUserById(store.users(), req.header("x-user") ?? ADA);
  };
  const ctx: RouteContext = {
    store,
    needsSetup: () => !store.users().length,
    currentSession,
    currentUser,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: (userId) => revocations.stopUserSessions(userId),
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
  };
  const deps: UsersDeps = {
    ...ctx,
    deleteUserAccess: (userId) => revocations.deleteUser(userId),
    permissionsChanged: (before, after) => revocations.permissionsChanged(before, after),
  };

  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  // The real order: the role gate first, so the accounts API is administrator-only here too.
  app.use("/api", roleMiddleware({ isOpen: () => false, isInternal: () => false, roleOf: (req) => currentUser(req)?.role }));
  registerUsersRoutes(app, deps);
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
    dir,
    store,
    jobs: () => (real ? real.list() : jobs),
    paused, removed, resources, activeMedia, deviceTickets, stoppedPlayback,
    pendingWrites: () => held.length,
    holdWrites: () => { holding = true; },
    releaseWrites: () => { const waiting = held; held = []; for (const run of waiting) run(); },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (real) await real.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
};

const api = (base: string, pathname: string, init: { method?: string; body?: unknown; user?: string; cookie?: string } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.user ? { "x-user": init.user } : {}),
      ...(init.cookie ? { cookie: `${SESSION_COOKIE}=${init.cookie}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

const keyOf = async (response: Response) => ((await response.json()) as { messageKey?: string }).messageKey;

const exists = (file: string) => access(file).then(() => true, () => false);

test("GET /api/users lists every account with its grants and none of its secrets", async (t) => {
  const harness = await mount({
    users: [admin, bob],
    libraries: (dir) => [library(path.join(dir, "downloads"), [BOB])],
    addons: [addon("alpha", [BOB])],
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/users");
  assert.equal(response.status, 200);
  const body = await response.json() as Array<Record<string, unknown>>;
  assert.deepEqual(body.map((entry) => entry.username), ["ada", "bob"]);
  assert.deepEqual(body[1], {
    id: BOB, username: "bob", role: "user", disabled: false, mustChangePassword: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    permissions: newUserPermissions(), libraries: 1, addons: 1,
  });
  assert.deepEqual(body[0]!.libraries, 0, "an administrator is granted nothing by a list");
  const wire = JSON.stringify(body);
  for (const secret of ["passwordHash", "secret", "revoked", "scrypt", `secret-${BOB}`]) {
    assert.equal(wire.includes(secret), false, `${secret} must not travel`);
  }
  // Every response goes through publicUser, not just the list.
  const created = await api(harness.base, "/api/users", { method: "POST", body: { username: "carol", password: "hunter2" } });
  const createdBody = await created.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(createdBody).sort(), ["addons", "createdAt", "disabled", "id", "libraries", "mustChangePassword", "permissions", "role", "username"]);
});

test("POST /api/users creates an account with the defaults of a new user", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const response = await api(harness.base, "/api/users", { method: "POST", body: { username: "Carol", password: "hunter2", role: "user" } });
  assert.equal(response.status, 201);
  const body = await response.json() as { id: string; username: string; role: string; permissions: unknown };
  assert.equal(body.username, "Carol", "the record keeps the spelling that was typed");
  assert.equal(body.role, "user");
  assert.deepEqual(body.permissions, newUserPermissions());
  const record = findUser(harness.store.users(), "carol")!;
  assert.equal(record.id, body.id);
  assert.equal(record.passwordHash.startsWith("scrypt$"), true);
  assert.equal(record.secret.length, 64);
  assert.equal(await verifyPassword("hunter2", record.passwordHash), true);
  // Empty but for the language, which is seeded from the administrator making the account:
  // nothing has been watched, queued or reordered yet.
  assert.deepEqual({ ...harness.store.userData(record.id), prefs: undefined }, { ...emptyUserData(), prefs: undefined });
  assert.equal(harness.store.users().length, 2);
});

test("POST /api/users refuses a name or a password under the bounds the model sets", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const shortName = await api(harness.base, "/api/users", { method: "POST", body: { username: "a".repeat(USERNAME_MIN - 1), password: "longenough" } });
  assert.equal(shortName.status, 400);
  assert.equal(await keyOf(shortName), "auth.usernameTooShort");
  const shortPassword = await api(harness.base, "/api/users", { method: "POST", body: { username: "a".repeat(USERNAME_MIN), password: "b".repeat(PASSWORD_MIN - 1) } });
  assert.equal(shortPassword.status, 400);
  assert.equal(await keyOf(shortPassword), "auth.passwordTooShort");
  assert.equal(harness.store.users().length, 1, "nothing was created");
});

test("a new account starts in the language the administrator is using", async (t) => {
  const harness = await mount({
    users: [admin],
    userData: { [ADA]: { ...emptyUserData(), prefs: { uiLanguage: "cs", audioLanguage: "cs", subtitleLanguage: "cs" } } },
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/users", { method: "POST", body: { username: "bob", password: "hunter2" } });
  assert.equal(response.status, 201);
  const created = await response.json() as { id: string };
  // Left unseeded it would answer the built-in English default, and somebody on a Czech
  // install would sign in for the first time into a language nobody here chose.
  assert.equal(harness.store.prefs(created.id).uiLanguage, "cs");
  assert.equal(harness.store.prefs(created.id).audioLanguage, "cs");
  assert.equal(harness.store.prefs(created.id).subtitleLanguage, "cs");
});

test("an account creation in flight does not survive the administrator losing the role", async (t) => {
  const harness = await mount({ users: [admin, { ...bob, role: "admin" as const }] });
  t.after(harness.close);

  // Hashing takes long enough for the gate's answer to go stale inside the request. Ada is
  // demoted while her creation is in the middle of it; without a second look at the write,
  // the request lands and mints an administrator on the authority of a role she no longer has.
  const creating = api(harness.base, "/api/users", { method: "POST", body: { username: "carol", password: "hunter2", role: "admin" } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await harness.store.update((state) => {
    state.users = (state.users ?? []).map((user) => user.id === ADA ? { ...user, role: "user" as const } : user);
  });

  const response = await creating;
  assert.equal(response.status, 403);
  assert.equal(await keyOf(response), "err.notAllowed");
  assert.equal(findUser(harness.store.users(), "carol"), undefined, "the account was created anyway");
});

test("a password reset in flight does not survive the administrator losing the role", async (t) => {
  const harness = await mount({ users: [admin, bob, carol] });
  t.after(harness.close);
  const before = findUserById(harness.store.users(), BOB)!.passwordHash;

  const resetting = api(harness.base, `/api/users/${BOB}/password`, { method: "PATCH", body: { password: "nastaveno-adminem" } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await harness.store.update((state) => {
    state.users = (state.users ?? []).map((user) => user.id === ADA ? { ...user, disabled: true } : user);
  });

  const response = await resetting;
  assert.equal(response.status, 403);
  assert.equal(findUserById(harness.store.users(), BOB)?.passwordHash, before, "somebody else's password was set anyway");
});

test("POST /api/users refuses a name that is taken, whatever its case", async (t) => {
  const harness = await mount({ users: [admin, bob] });
  t.after(harness.close);

  const response = await api(harness.base, "/api/users", { method: "POST", body: { username: "BOB", password: "hunter2" } });
  assert.equal(response.status, 409);
  assert.equal(await keyOf(response), "err.usernameTaken");
  assert.equal(harness.store.users().length, 2);
});

test("the accounts API is administrator-only", async (t) => {
  const harness = await mount({ users: [admin, bob] });
  t.after(harness.close);

  const list = await api(harness.base, "/api/users", { user: BOB });
  assert.equal(list.status, 403);
  assert.equal(await keyOf(list), "err.notAllowed");
  const removed = await api(harness.base, `/api/users/${ADA}`, { method: "DELETE", user: BOB });
  assert.equal(removed.status, 403);
  assert.equal(findUserById(harness.store.users(), ADA)?.username, "ada");
});

test("promoting an account leaves its grants where they are", async (t) => {
  const harness = await mount({
    users: [admin, bob, carol],
    libraries: (dir) => [library(path.join(dir, "downloads"), [BOB, CAROL])],
    addons: [addon("alpha", [BOB, CAROL])],
  });
  t.after(harness.close);

  const response = await api(harness.base, `/api/users/${BOB}`, { method: "PATCH", body: { role: "admin" } });
  assert.equal(response.status, 200);
  assert.equal(findUserById(harness.store.users(), BOB)?.role, "admin");

  // The role grants everything, so the entry grants nothing while it sits there. Taking it
  // out would be the one thing nobody can undo: what an account was granted is not written
  // down anywhere else.
  assert.deepEqual(harness.store.libraries()[0]?.visibleTo, [BOB, CAROL], "the grant lies dormant on the library");
  assert.deepEqual(harness.store.addons()[0]?.allowedUsers, [BOB, CAROL], "the grant lies dormant on the addon");
  const promoted = await response.json() as { libraries: number; addons: number };
  assert.deepEqual([promoted.libraries, promoted.addons], [0, 0], "a dormant list is not counted as a grant");
});

test("a promotion and a demotion leave the account with the grants it had", async (t) => {
  const harness = await mount({
    users: [admin, bob, carol],
    libraries: (dir) => [library(path.join(dir, "downloads"), [BOB, CAROL])],
    addons: [addon("alpha", [BOB, CAROL])],
  });
  t.after(harness.close);

  for (const role of ["admin", "user"]) {
    const response = await api(harness.base, `/api/users/${BOB}`, { method: "PATCH", body: { role } });
    assert.equal(response.status, 200);
  }

  assert.equal(findUserById(harness.store.users(), BOB)?.role, "user");
  assert.deepEqual(harness.store.libraries()[0]?.visibleTo, [BOB, CAROL], "the library grant came back with the role");
  assert.deepEqual(harness.store.addons()[0]?.allowedUsers, [BOB, CAROL], "the addon grant came back with the role");
  const rows = await (await api(harness.base, "/api/users")).json() as Array<{ id: string; libraries: number; addons: number }>;
  const back = rows.find((row) => row.id === BOB);
  assert.deepEqual([back?.libraries, back?.addons], [1, 1], "and the dashboard counts them again");
});

test("the last administrator cannot be demoted or switched off", async (t) => {
  const harness = await mount({ users: [admin, bob] });
  t.after(harness.close);

  for (const body of [{ role: "user" }, { disabled: true }]) {
    const response = await api(harness.base, `/api/users/${ADA}`, { method: "PATCH", body });
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal(await keyOf(response), "err.lastAdmin");
  }
  const record = findUserById(harness.store.users(), ADA)!;
  assert.equal(record.role, "admin");
  assert.equal(Boolean(record.disabled), false);
});

test("a delete that would leave the instance without an administrator is refused", async (t) => {
  // The gate would never hand a switched-off administrator a session; the route must not
  // depend on that, so the guard is asked of the state rather than of the caller.
  const harness = await mount({ users: [account({ id: ADA, username: "ada", role: "admin", disabled: true }), account({ id: BOB, username: "bob", role: "admin" })] });
  t.after(harness.close);

  const response = await api(harness.base, `/api/users/${BOB}`, { method: "DELETE" });
  assert.equal(response.status, 409);
  assert.equal(await keyOf(response), "err.lastAdmin");
  assert.equal(findUserById(harness.store.users(), BOB)?.username, "bob");
});

test("two overlapping demotions leave one administrator standing", async (t) => {
  const harness = await mount({ users: [admin, account({ id: BOB, username: "bob", role: "admin" })] });
  t.after(harness.close);
  harness.holdWrites();

  // Both requests reach their mutator before either write runs: the interleaving a check
  // before the await would let through.
  const first = api(harness.base, `/api/users/${ADA}`, { method: "PATCH", body: { role: "user" } });
  const second = api(harness.base, `/api/users/${BOB}`, { method: "PATCH", body: { role: "user" } });
  while (harness.pendingWrites() < 2) await new Promise((resolve) => setImmediate(resolve));
  harness.releaseWrites();
  const [one, two] = await Promise.all([first, second]);

  assert.deepEqual([one.status, two.status].sort(), [200, 409]);
  assert.equal(harness.store.users().filter((entry) => entry.role === "admin").length, 1);
});

test("PATCH /api/users/:id keeps a key the body does not name and bumps the version it changes", async (t) => {
  const harness = await mount({ users: [admin, bob] });
  t.after(harness.close);

  const response = await api(harness.base, `/api/users/${BOB}`, { method: "PATCH", body: { role: "admin", permissions: { downloadToLibrary: true } } });
  assert.equal(response.status, 200);
  const body = await response.json() as { role: string; permissions: { downloadToLibrary: boolean; downloadToDevice: boolean }; disabled: boolean };
  assert.equal(body.role, "admin");
  assert.deepEqual(body.permissions, { downloadToLibrary: true, downloadToDevice: true }, "the key the body left out keeps its value");
  assert.equal(body.disabled, false);
  assert.equal(findUserById(harness.store.users(), BOB)?.permissionsVersion, 1);
});

test("losing the right to queue pauses that account's downloads and leaves the film playing", async (t) => {
  const harness = await mount({ users: [admin, account({ id: BOB, username: "bob", permissions: { downloadToLibrary: true, downloadToDevice: true } })], jobs: [job("job-bob", BOB, { status: "downloading" })] });
  t.after(harness.close);
  const watching = { owner: { userId: BOB, sid: "sid-bob", expiresAt: Date.now() + 60_000 }, res: { destroy: () => undefined } };
  harness.activeMedia.add(watching);

  const response = await api(harness.base, `/api/users/${BOB}`, { method: "PATCH", body: { permissions: { downloadToLibrary: false } } });
  assert.equal(response.status, 200);
  assert.deepEqual(harness.paused, ["job-bob"]);
  assert.equal(harness.jobs()[0]?.pauseReason, "permission");
  assert.equal(harness.activeMedia.has(watching), true, "watching was never in question");
});

test("switching an account off ends its sessions, so switching it back on asks for the password", async (t) => {
  const harness = await mount({ users: [admin, { ...bob, secret: "bob-secret" }] });
  t.after(harness.close);

  const off = await api(harness.base, `/api/users/${BOB}`, { method: "PATCH", body: { disabled: true } });
  assert.equal(off.status, 200);
  const disabled = findUserById(harness.store.users(), BOB)!;
  // Refusing while the switch is down is not enough on its own: the cookie would start
  // answering again the moment somebody switched the account back on, and the device it was
  // taken away from would be back in without signing in.
  assert.notEqual(disabled.secret, "bob-secret", "the tokens it holds are still valid");
  assert.deepEqual(disabled.revoked ?? {}, {});

  const on = await api(harness.base, `/api/users/${BOB}`, { method: "PATCH", body: { disabled: false } });
  assert.equal(on.status, 200);
  const back = findUserById(harness.store.users(), BOB)!;
  assert.equal(back.secret, disabled.secret, "switching it on again must not rotate anything else");
  assert.equal(readSession("bob-secret", createSession("bob-secret", BOB, Date.now() + 60_000, "sid-old")) !== undefined, true);
  assert.equal(readSession(back.secret, createSession("bob-secret", BOB, Date.now() + 60_000, "sid-old")), undefined,
    "a token signed with the old secret still opens the account");
});

test("an administrator's password reset ends the sessions and leaves the queue running", async (t) => {
  const harness = await mount({ users: [admin, bob], jobs: [job("job-bob", BOB, { status: "downloading" })] });
  t.after(harness.close);
  const owner = { userId: BOB, sid: "sid-bob", expiresAt: Date.now() + 60_000 };
  const open = harness.resources.add({ url: "http://alpha.test/film.mkv" }, owner, "media");

  const response = await api(harness.base, `/api/users/${BOB}/password`, { method: "PATCH", body: { password: "novy-tajny" } });
  assert.equal(response.status, 200);
  assert.throws(() => harness.resources.get(open, "sid-bob", "media"), "what the account held open survived the reset");
  // A reset changes which credential opens the door and takes away no right. The account may
  // still queue, and a download to the server is not something it is holding open, so pausing
  // it would be punishing somebody for an administrator's action. Switching the account off is
  // the tool for taking the right away.
  assert.deepEqual(harness.paused, [], "the reset paused the queue");
  assert.equal(harness.jobs()[0]?.status, "downloading");
});

test("a demotion cuts what the role was granting", async (t) => {
  const harness = await mount({
    users: [admin, { ...bob, role: "admin" as const }],
    libraries: (dir) => [library(path.join(dir, "downloads"))],
    addons: [addon("alpha")],
  });
  t.after(harness.close);
  const owner = { userId: BOB, sid: "sid-bob", expiresAt: Date.now() + 60_000 };
  // Held by the role alone: nothing names this account on either the library or the addon.
  const byLibrary = harness.resources.add({ url: `file://${LIBRARY}/Film.mkv` }, owner, "media");
  const byAddon = harness.resources.add({ url: "http://alpha.test/film.mkv", addonKey: "alpha" }, owner, "media");
  let destroyed = false;
  harness.activeMedia.add({ owner, res: { destroy: () => { destroyed = true; } }, resourceId: byLibrary });

  const response = await api(harness.base, `/api/users/${BOB}`, { method: "PATCH", body: { role: "user" } });
  assert.equal(response.status, 200);
  // The counter stops the next request; this is about what is already open. Coming down from
  // administrator is the largest withdrawal there is and no counter names what it costs.
  assert.throws(() => harness.resources.get(byLibrary, "sid-bob", "media"), "the library resource the old role allowed is still open");
  assert.throws(() => harness.resources.get(byAddon, "sid-bob", "media"), "the addon resource the old role allowed is still open");
  assert.equal(destroyed, true, "the transfer already being written was left running");
});

test("a demotion leaves alone what the account was granted in its own right", async (t) => {
  const harness = await mount({
    users: [admin, { ...bob, role: "admin" as const }],
    libraries: (dir) => [library(path.join(dir, "downloads"), [BOB])],
    addons: [addon("alpha", [BOB])],
  });
  t.after(harness.close);
  const owner = { userId: BOB, sid: "sid-bob", expiresAt: Date.now() + 60_000 };
  const byLibrary = harness.resources.add({ url: `file://${LIBRARY}/Film.mkv` }, owner, "media");
  const byAddon = harness.resources.add({ url: "http://alpha.test/film.mkv", addonKey: "alpha" }, owner, "media");
  let destroyed = false;
  harness.activeMedia.add({ owner, res: { destroy: () => { destroyed = true; } }, resourceId: byLibrary });

  assert.equal((await api(harness.base, `/api/users/${BOB}`, { method: "PATCH", body: { role: "user" } })).status, 200);
  // The sweep measures what is held against what is allowed now rather than cutting
  // everything: a library and an addon this account is named on stay its to read.
  assert.doesNotThrow(() => harness.resources.get(byLibrary, "sid-bob", "media"), "a granted library was swept away");
  assert.doesNotThrow(() => harness.resources.get(byAddon, "sid-bob", "media"), "a granted addon was swept away");
  assert.equal(destroyed, false, "a transfer the account still has the right to was destroyed");
});

test("switching an account off sweeps what it holds and keeps its history", async (t) => {
  const history = { ...emptyUserData(), watchlist: { "movie:tt1": { type: "movie", id: "tt1", name: "Film", addedAt: "2026-01-01T00:00:00.000Z" } } };
  const harness = await mount({
    users: [admin, bob],
    userData: { [ADA]: emptyUserData(), [BOB]: history },
    jobs: [job("job-bob", BOB, { status: "downloading" }), job("job-ada", ADA, { status: "downloading" })],
  });
  t.after(harness.close);
  const resourceId = harness.resources.add({ url: "http://example.test/film.mkv" }, { userId: BOB, sid: "sid-bob", expiresAt: Date.now() + 60_000 }, "media");
  harness.deviceTickets.set("ticket-bob", { owner: { userId: BOB, sid: "sid-bob", expiresAt: Date.now() + 60_000 } } as DeviceDownloadTicket);

  const response = await api(harness.base, `/api/users/${BOB}`, { method: "PATCH", body: { disabled: true } });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { disabled: boolean }).disabled, true);
  assert.deepEqual(harness.paused, ["job-bob"], "only the switched-off account's work pauses");
  assert.deepEqual(harness.removed, [], "a pause keeps the queue position");
  assert.notEqual(harness.store.userData(BOB).watchlist["movie:tt1"], undefined, "its history survives");
  assert.equal(harness.store.users().some((entry) => entry.id === BOB), true, "the record is kept");
  assert.equal(harness.deviceTickets.size, 0, "an in-flight grant is dropped");
  assert.throws(() => harness.resources.get(resourceId, "sid-bob", "media"), "a resource already open is revoked");

  const back = await api(harness.base, `/api/users/${BOB}`, { method: "PATCH", body: { disabled: false } });
  assert.equal(back.status, 200);
  assert.equal((await back.json() as { disabled: boolean }).disabled, false, "nothing was lost and it is reversible");
});

test("an administrator setting a password sweeps that account and leaves their own session alone", async (t) => {
  const harness = await mount({ users: [admin, bob] });
  t.after(harness.close);
  const mine = harness.resources.add({ url: "http://example.test/mine.mkv" }, { userId: ADA, sid: "sid-ada", expiresAt: Date.now() + 60_000 }, "media");
  const theirs = harness.resources.add({ url: "http://example.test/theirs.mkv" }, { userId: BOB, sid: "sid-bob", expiresAt: Date.now() + 60_000 }, "media");

  const response = await api(harness.base, `/api/users/${BOB}/password`, { method: "PATCH", body: { password: "brand-new" } });
  assert.equal(response.status, 200);
  const body = await response.json() as { mustChangePassword: boolean };
  assert.equal(body.mustChangePassword, true);
  const record = findUserById(harness.store.users(), BOB)!;
  assert.notEqual(record.secret, `secret-${BOB}`, "the secret is rotated");
  assert.equal(await verifyPassword("brand-new", record.passwordHash), true);
  assert.throws(() => harness.resources.get(theirs, "sid-bob", "media"), "the target's own resources go");
  assert.equal(harness.resources.get(mine, "sid-ada", "media").id, mine, "the administrator's session is untouched");
});

test("DELETE /api/users/:id sweeps the grant lists, the data and the unfinished work", async (t) => {
  const unfinished = path.join("Bob", "Film.mkv");
  const harness = await mount({
    users: [admin, bob, carol],
    userData: { [ADA]: emptyUserData(), [BOB]: emptyUserData(), [CAROL]: emptyUserData() },
    libraries: (dir) => [library(path.join(dir, "downloads"), [BOB, CAROL])],
    addons: [addon("alpha", [BOB, CAROL])],
    jobs: [
      job("job-bob", BOB, { target: `${LIBRARY}/${unfinished}`, libraryId: LIBRARY, received: 12 }),
      job("job-bob-done", BOB, { status: "completed", target: `${LIBRARY}/Bob/Done.mkv`, libraryId: LIBRARY, received: 10, total: 10 }),
      job("job-carol", CAROL, { target: `${LIBRARY}/Carol/Other.mkv`, libraryId: LIBRARY }),
    ],
    realQueue: true,
    files: async (dir) => {
      const root = path.join(dir, "downloads");
      await mkdir(path.join(root, "Bob"), { recursive: true });
      await mkdir(path.join(root, "Carol"), { recursive: true });
      await writeFile(path.join(root, unfinished + ".part"), "half");
      await writeFile(path.join(root, "Bob", "Done.mkv"), "whole");
      await writeFile(path.join(root, "Carol", "Other.mkv.part"), "half");
    },
  });
  t.after(harness.close);

  const response = await api(harness.base, `/api/users/${BOB}`, { method: "DELETE" });
  assert.equal(response.status, 204);
  assert.equal(findUserById(harness.store.users(), BOB), undefined);
  assert.equal(findUserById(harness.store.users(), CAROL)?.username, "carol");
  assert.deepEqual(harness.store.libraries()[0]?.visibleTo, [CAROL]);
  assert.deepEqual(harness.store.addons()[0]?.allowedUsers, [CAROL]);
  assert.deepEqual(harness.jobs().map((entry) => entry.id).sort(), ["job-bob-done", "job-carol"]);

  // The partial file goes with the job; the finished film is library content and stays.
  const downloads = path.join(harness.dir, "downloads");
  assert.equal(await exists(path.join(downloads, "Bob", "Film.mkv.part")), false, "the partial file is cleaned up");
  assert.equal(await exists(path.join(downloads, "Bob", "Done.mkv")), true, "a completed file is not the account's to take");
  assert.equal(await exists(path.join(downloads, "Carol", "Other.mkv.part")), true, "another account's work is untouched");
});

test("DELETE /api/users/:id refuses the account the administrator is signed in with", async (t) => {
  const harness = await mount({ users: [admin, bob] });
  t.after(harness.close);

  const response = await api(harness.base, `/api/users/${ADA}`, { method: "DELETE" });
  assert.equal(response.status, 409);
  assert.equal(await keyOf(response), "err.cannotDeleteSelf");
  assert.equal(findUserById(harness.store.users(), ADA)?.username, "ada");
});

test("an ordinary account can be created and can sign in", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const created = await api(harness.base, "/api/users", { method: "POST", body: { username: "bob", password: "hunter2", role: "user" } });
  assert.equal(created.status, 201);
  const { id } = await created.json() as { id: string };

  const login = await api(harness.base, "/api/auth/login", { method: "POST", body: { username: "bob", password: "hunter2", remember: false } });
  assert.equal(login.status, 200);
  const cookie = parseCookies(login.headers.get("set-cookie") ?? "")[SESSION_COOKIE];
  assert.equal(sessionUserId(cookie), id, "the session is the new account's own");

  // It is an ordinary account: the accounts API is not its to call.
  const refused = await api(harness.base, "/api/users", { cookie });
  assert.equal(refused.status, 403);
  assert.equal(await keyOf(refused), "err.notAllowed");
});
