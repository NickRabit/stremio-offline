import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { messageKeyOf } from "../errors.js";
import { defaultDownloadSettings } from "../naming.js";
import { roleMiddleware } from "../roles.js";
import { publicAddon } from "../security.js";
import type { Store } from "../store.js";
import type { AddonRecord, AddonRole } from "../types.js";
import { emptyUserData, type UserData, type UserRecord } from "../users.js";
import { registerAddonsRoutes, type AddonsDeps } from "./addons.js";

interface Harness {
  base: string;
  demote: (id: string) => void;
  viewed: AddonRecord[];
  stored: () => AddonRecord[];
  data: (id: string) => UserData | undefined;
  close(): Promise<void>;
}

const addon = (key: string, role: AddonRole = "both"): AddonRecord => ({
  key,
  manifestUrl: `https://${key}.example/manifest.json`,
  role,
  enabled: true,
  globalSearch: true,
  addedAt: "2024-01-01T00:00:00.000Z",
  manifest: { id: key, name: `Addon ${key}`, version: "1.0.0" },
  downloadSettings: defaultDownloadSettings(),
});

const ADA = "usr_00000001";
const BOB = "usr_00000002";
const CAROL = "usr_00000003";
const admin = { id: ADA, username: "ada", role: "admin" } as unknown as UserRecord;
const ordinary = { id: BOB, username: "bob", role: "user" } as unknown as UserRecord;
const other = { id: CAROL, username: "carol", role: "user" } as unknown as UserRecord;
/** An addon both ordinary accounts may see; one without `allowedUsers` is the administrator's alone. */
const granted = (key: string): AddonRecord => ({ ...addon(key), allowedUsers: [BOB, CAROL] });

/** The routes take everything they need from the context, so the app here is a real express
 *  instance over fake collaborators that record what they were asked to do. */
const mount = async (records: AddonRecord[] = [addon("alpha")]): Promise<Harness> => {
  // `users` lives in the state, not only behind `store.users()`: a mutator reads the state,
  // and the write-time role check is one of the things that does.
  const state = { addons: records, users: [admin, ordinary, other], userData: { [BOB]: emptyUserData(), [CAROL]: emptyUserData() } as Record<string, UserData> };
  const viewed: AddonRecord[] = [];
  const userOf = (req: express.Request) =>
    req.header("x-user") === BOB ? ordinary : req.header("x-user") === CAROL ? other : admin;
  const store = {
    addons: () => state.addons,
    libraries: () => [],
    users: () => state.users,
    userData: (id: string) => state.userData[id] ?? emptyUserData(),
    update: async (mutate: (value: typeof state) => void) => { mutate(state); },
  } as unknown as Store;
  const deps: AddonsDeps = {
    store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: userOf,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
    storeRefreshed: async () => undefined,
    publicAddonView: (record) => {
      viewed.push(record);
      const view = { ...publicAddon(record), viewed: true };
      return view;
    },
  };
  const app = express();
  app.use(express.json());
  // The gate index.ts mounts ahead of these routes, so a test of what an ordinary user may
  // reach exercises the same refusal the running server answers with.
  app.use("/api", roleMiddleware({ isOpen: () => false, isInternal: () => false, roleOf: (req) => userOf(req).role }));
  registerAddonsRoutes(app, deps);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error), messageKey: messageKeyOf(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    viewed,
    stored: () => state.addons,
    demote: (id: string) => { state.users = state.users.map((user) => user.id === id ? { ...user, role: "user" } as UserRecord : user); },
    data: (id: string) => state.userData[id],
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

const api = (base: string, pathname: string, init: { method?: string; body?: unknown; user?: string } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.user ? { "x-user": init.user } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

const keysOf = (harness: Harness) => harness.stored().map((record) => record.key);
const failure = async (response: Response) => (await response.json()) as { error: string; messageKey?: string };

test("GET /api/addons passes every record through publicAddonView", async (t) => {
  const harness = await mount([addon("alpha"), addon("beta")]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/addons");
  assert.equal(response.status, 200);
  const body = await response.json() as Array<{ key: string; viewed?: boolean }>;
  assert.deepEqual(body.map((item) => item.key), ["alpha", "beta"]);
  assert.deepEqual(body.map((item) => item.viewed), [true, true]);
  assert.deepEqual(harness.viewed.map((record) => record.key), ["alpha", "beta"]);
});

test("GET /api/addons answers an ordinary user with the addons granted to them", async (t) => {
  const harness = await mount([addon("alpha"), { ...addon("beta"), allowedUsers: [BOB] }]);
  t.after(harness.close);

  const administrator = await (await api(harness.base, "/api/addons")).json() as Array<{ key: string }>;
  assert.deepEqual(administrator.map((item) => item.key), ["alpha", "beta"], "an administrator sees every addon");

  const user = await (await api(harness.base, "/api/addons", { user: BOB })).json() as Array<{ key: string }>;
  assert.deepEqual(user.map((item) => item.key), ["beta"], "a user sees only what was granted to them");
});

test("PATCH /api/addons/:key sets allowedUsers and collapses duplicates", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/addons/alpha", { method: "PATCH", body: { allowedUsers: [BOB, BOB] } });
  assert.equal(response.status, 200);
  assert.deepEqual(harness.stored()[0]!.allowedUsers, [BOB]);
  assert.deepEqual((await response.json() as { allowedUsers: string[] }).allowedUsers, [BOB], "the dashboard is told the grants");
});

test("PATCH /api/addons/:key refuses an account that does not exist", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/addons/alpha", { method: "PATCH", body: { allowedUsers: ["usr_ffffffff"] } });
  assert.equal(response.status, 400);
  const body = await failure(response);
  assert.equal(body.messageKey, "err.unknownUser");
  assert.equal(body.error, "That account does not exist.");
  assert.equal(harness.stored()[0]!.allowedUsers, undefined, "a refused id leaves the addon as it was");
});

test("PATCH /api/addons/:key refuses an administrator's id", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/addons/alpha", { method: "PATCH", body: { allowedUsers: [ADA] } });
  assert.equal(response.status, 400);
  assert.equal((await failure(response)).messageKey, "err.adminAlwaysUsesAddons");
  assert.equal(harness.stored()[0]!.allowedUsers, undefined);
});

test("DELETE /api/addons/:key removes only the named key", async (t) => {
  const harness = await mount([addon("alpha"), addon("beta"), addon("gamma")]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/addons/beta", { method: "DELETE" });
  assert.equal(response.status, 204);
  assert.deepEqual(keysOf(harness), ["alpha", "gamma"]);
});

test("GET /api/addons/:key/export refuses an unknown key", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/addons/nobody/export");
  assert.equal(response.status, 400);
  assert.equal(await response.json().then((body) => (body as { messageKey?: string }).messageKey), "err.addonNotFound");
});

test("GET /api/addons/:key/export hands out the token-bearing address of a known key", async (t) => {
  const record = addon("alpha");
  record.manifestUrl = "https://alpha.example/manifest.json?token=secret";
  const harness = await mount([record]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/addons/alpha/export");
  assert.equal(response.status, 200);
  const body = await response.json() as { manifestUrl?: string; manifest?: { id?: string } };
  assert.equal(body.manifestUrl, "https://alpha.example/manifest.json?token=secret");
  assert.equal(body.manifest?.id, "alpha");
});

test("POST /api/addons/:key/move moves by one in each direction", async (t) => {
  const harness = await mount([addon("alpha"), addon("beta"), addon("gamma")]);
  t.after(harness.close);
  assert.equal((await api(harness.base, "/api/addons/beta/move", { method: "POST", body: { direction: -1 } })).status, 204);
  assert.deepEqual(keysOf(harness), ["beta", "alpha", "gamma"]);
  assert.equal((await api(harness.base, "/api/addons/beta/move", { method: "POST", body: { direction: 1 } })).status, 204);
  assert.deepEqual(keysOf(harness), ["alpha", "beta", "gamma"]);
});

test("POST /api/addons/:key/move is a no-op at either end of the list", async (t) => {
  const harness = await mount([addon("alpha"), addon("beta"), addon("gamma")]);
  t.after(harness.close);
  assert.equal((await api(harness.base, "/api/addons/alpha/move", { method: "POST", body: { direction: -1 } })).status, 204);
  assert.deepEqual(keysOf(harness), ["alpha", "beta", "gamma"]);
  assert.equal((await api(harness.base, "/api/addons/gamma/move", { method: "POST", body: { direction: 1 } })).status, 204);
  assert.deepEqual(keysOf(harness), ["alpha", "beta", "gamma"]);
});

test("POST /api/addons/:key/move stays administrator-only", async (t) => {
  const harness = await mount([addon("alpha"), addon("beta")]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/addons/alpha/move", { method: "POST", user: BOB, body: { direction: 1 } });
  assert.equal(response.status, 403);
  assert.equal((await failure(response)).messageKey, "err.notAllowed");
  assert.deepEqual(keysOf(harness), ["alpha", "beta"], "a refused move leaves the global order alone");
  assert.equal((await api(harness.base, "/api/addons/alpha/move", { method: "POST", body: { direction: 1 } })).status, 204);
  assert.deepEqual(keysOf(harness), ["beta", "alpha"], "the administrator still reorders the instance");
});

test("PUT /api/addons/order writes the caller's own order and nobody else's", async (t) => {
  const harness = await mount([granted("alpha"), granted("beta")]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/addons/order", { method: "PUT", user: BOB, body: { order: ["beta", "alpha"] } });
  assert.equal(response.status, 204);
  assert.deepEqual(harness.data(BOB)?.addonOrder, ["beta", "alpha"]);
  assert.equal(harness.data(CAROL)?.addonOrder, undefined, "another account keeps its own list");
  assert.deepEqual(keysOf(harness), ["alpha", "beta"], "the global order is untouched");
});

test("PUT /api/addons/order drops a key the caller may not see and collapses duplicates", async (t) => {
  const harness = await mount([granted("beta"), addon("alpha")]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/addons/order", { method: "PUT", user: BOB, body: { order: ["alpha", "beta", "beta"] } });
  assert.equal(response.status, 204);
  assert.deepEqual(harness.data(BOB)?.addonOrder, ["beta"], "an invisible key never reaches the record, and one copy of the rest is kept");
});

test("each account reads GET /api/addons in its own order, the administrator in the global one", async (t) => {
  const harness = await mount([granted("alpha"), granted("beta"), granted("gamma")]);
  t.after(harness.close);
  await api(harness.base, "/api/addons/order", { method: "PUT", user: BOB, body: { order: ["gamma", "alpha", "beta"] } });
  await api(harness.base, "/api/addons/order", { method: "PUT", user: CAROL, body: { order: ["beta", "gamma", "alpha"] } });

  const keys = async (user?: string) => ((await (await api(harness.base, "/api/addons", { user })).json()) as Array<{ key: string }>).map((item) => item.key);
  assert.deepEqual(await keys(BOB), ["gamma", "alpha", "beta"]);
  assert.deepEqual(await keys(CAROL), ["beta", "gamma", "alpha"]);
  assert.deepEqual(await keys(), ["alpha", "beta", "gamma"], "the administrator reads the instance's order");
});

test("an administrator with a stored order still reads the global one", async (t) => {
  // Somebody promoted from user keeps whatever overlay they had. Applying it would put them
  // in front of a list that is not the global one while the note says it applies to
  // everybody -- and the arrows they then press edit the global order, so reordering from
  // that view would scramble it.
  const harness = await mount([granted("alpha"), granted("beta"), granted("gamma")]);
  t.after(harness.close);
  await api(harness.base, "/api/addons/order", { method: "PUT", body: { order: ["gamma", "beta", "alpha"] } });

  const keys = ((await (await api(harness.base, "/api/addons")).json()) as Array<{ key: string }>).map((item) => item.key);

  assert.deepEqual(keys, ["alpha", "beta", "gamma"], "the overlay is stored but not applied");
});

test("an addon edit in flight does not survive the administrator losing the role", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  // The gate answers once, at the start of the request. Everything that fetches a manifest
  // or probes a folder before it writes can have that answer go stale inside the request.
  harness.demote(ADA);
  const response = await api(harness.base, "/api/addons/alpha", { method: "PATCH", body: { enabled: false } });

  assert.equal(response.status, 403);
  assert.equal((await failure(response)).messageKey, "err.notAllowed");
  assert.equal(harness.stored()[0]?.enabled, true, "the write landed on a role the account no longer had");
});
