import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { messageKeyOf } from "../errors.js";
import { mergeGrants } from "../library-grants.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import type { LibraryOps } from "../library-ops.js";
import type { LibraryHealth } from "../library-probe.js";
import type { LibraryRecord, RootGrant } from "../libraries.js";
import type { Store } from "../store.js";
import type { UserRecord } from "../users.js";
import { registerLibrariesRoutes, type LibrariesDeps } from "./libraries.js";

interface Harness {
  base: string;
  /** Makes the session stop resolving, the way a sign-out everywhere or a switched-off
   *  account does. `after` lets it answer the handler's own first read and nothing after. */
  loseSession: (after: number) => void;
  disable: (id: string) => void;
  viewed: Array<{ id: string; health: LibraryHealth; stats: { titles: number; files: number; bytes: number }; admin: boolean }>;
  enqueued: unknown[];
  invalidated: string[];
  stored: () => LibraryRecord[];
  userGrants: () => RootGrant[];
  allGrants: () => RootGrant[];
  close(): Promise<void>;
}

const library = (id: string, order: number): LibraryRecord => ({
  id, name: `Library ${id}`, type: "mixed", root: `/media/${id}`, enabled: true, order,
  addedAt: "2024-01-01T00:00:00.000Z", writeArtwork: false,
});

const ADA = "usr_00000001";
const BOB = "usr_00000002";
const admin = { id: ADA, username: "ada", role: "admin" } as unknown as UserRecord;
const ordinary = { id: BOB, username: "bob", role: "user" } as unknown as UserRecord;

const stats = new Map([["alpha", { titles: 3, files: 4, bytes: 5 }]]);

/** The routes take everything they need from the context, so the app here is a real express
 *  instance over fake collaborators that record what they were asked to do. */
const mount = async (
  records: LibraryRecord[] = [library("alpha", 0)],
  env: RootGrant[] = [],
  departed: Array<{ id: string; root: string; removedAt: string }> = [],
): Promise<Harness> => {
  let sessionReads: number | undefined;
  // `users` lives in the state, not only behind `store.users()`: a mutator reads the state,
  // and the write-time role check is one of the things that does.
  const state = { libraries: records, users: [admin, ordinary], grants: [] as RootGrant[], departed };
  const viewed: Harness["viewed"] = [];
  const enqueued: unknown[] = [];
  const invalidated: string[] = [];
  const store = {
    libraries: () => state.libraries,
    users: () => state.users,
    grants: () => state.grants,
    departed: () => state.departed,
    update: async (mutate: (value: typeof state) => void) => { mutate(state); },
  } as unknown as Store;
  const deps: LibrariesDeps = {
    store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: (req) => {
      if (sessionReads !== undefined && sessionReads-- <= 0) return undefined;
      return req.header("x-user") === BOB ? ordinary : admin;
    },
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
    grantRows: async () => mergeGrants(env, state.grants).map((grant) => ({ ...grant, writable: true })),
    healthOf: (record) => ({ unreachable: record.id === "alpha", readOnly: record.id === "beta", realRoot: record.root, caseInsensitive: false }),
    invalidateAutoScan: (libraryId) => { invalidated.push(libraryId); },
    invalidateLibrary: () => undefined,
    libraryGrants: () => mergeGrants(env, state.grants),
    libraryStats: async () => stats,
    libraryView: (record, health, totals, admin) => {
      viewed.push({ id: record.id, health, stats: totals, admin });
      return { id: record.id, name: record.name, unreachable: health.unreachable, readOnly: health.readOnly, ...totals };
    },
    progressOf: () => ({}),
    refreshLibraryHealth: async () => new Map(),
    libraryProbe: {
      probe: async (root: string) => ({ unreachable: false, readOnly: false, realRoot: root, caseInsensitive: false }),
      cached: async (root: string) => ({ unreachable: false, readOnly: false, realRoot: root, caseInsensitive: false }),
      invalidate: () => undefined,
    },
    metaStore: { qualifiedMeta: () => ({}), forget: async () => undefined } as unknown as LibraryMetaStore,
    libraryOps: { enqueue: async (operation: unknown) => { enqueued.push(operation); return { id: "op-1" }; } } as unknown as LibraryOps,
  };
  const app = express();
  app.use(express.json());
  registerLibrariesRoutes(app, deps);
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
    enqueued,
    invalidated,
    stored: () => state.libraries,
    userGrants: () => state.grants,
    loseSession: (after: number) => { sessionReads = after; },
    disable: (id: string) => { state.users = state.users.map((user) => user.id === id ? { ...user, disabled: true } : user); },
    allGrants: () => mergeGrants(env, state.grants),
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

const failure = async (response: Response) => await response.json() as { error?: string; messageKey?: string };

test("GET /api/libraries passes every record through libraryView with its health and stats", async (t) => {
  const harness = await mount([library("beta", 2), library("alpha", 0)]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/libraries");
  assert.equal(response.status, 200);
  const body = await response.json() as Array<{ id: string; unreachable?: boolean; readOnly?: boolean; titles?: number; files?: number; bytes?: number }>;
  assert.deepEqual(body.map((item) => item.id), ["alpha", "beta"], "the listing follows the display order");
  assert.deepEqual(body.map((item) => item.unreachable), [true, false]);
  assert.deepEqual(body.map((item) => item.readOnly), [false, true]);
  assert.deepEqual(body.map((item) => [item.titles, item.files, item.bytes]), [[3, 4, 5], [0, 0, 0]]);
  assert.deepEqual(harness.viewed.map((item) => item.id), ["alpha", "beta"]);
  assert.deepEqual(harness.viewed[0].health, { unreachable: true, readOnly: false, realRoot: "/media/alpha", caseInsensitive: false });
  assert.deepEqual(harness.viewed[0].stats, { titles: 3, files: 4, bytes: 5 });
  assert.deepEqual(harness.viewed[1].stats, { titles: 0, files: 0, bytes: 0 });
});

test("GET /api/libraries answers an ordinary user with the libraries granted to them", async (t) => {
  const harness = await mount([library("alpha", 0), { ...library("beta", 1), visibleTo: [BOB] }]);
  t.after(harness.close);

  const administrator = await (await api(harness.base, "/api/libraries")).json() as Array<{ id: string }>;
  assert.deepEqual(administrator.map((item) => item.id), ["alpha", "beta"], "an administrator sees every library");

  const user = await (await api(harness.base, "/api/libraries", { user: BOB })).json() as Array<{ id: string }>;
  assert.deepEqual(user.map((item) => item.id), ["beta"], "a user sees only what was granted to them");
});

test("GET /api/libraries tells the view whether the caller may be shown a root", async (t) => {
  const harness = await mount([{ ...library("alpha", 0), visibleTo: [BOB] }]);
  t.after(harness.close);

  await api(harness.base, "/api/libraries");
  await api(harness.base, "/api/libraries", { user: BOB });

  assert.deepEqual(harness.viewed.map((item) => item.admin), [true, false],
    "only an administrator is offered the path the library lives at on the host");
});

test("PATCH /api/libraries/:id sets visibleTo and collapses duplicates", async (t) => {
  const harness = await mount([library("alpha", 0)]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { visibleTo: [BOB, BOB] } });
  assert.equal(response.status, 200);
  assert.deepEqual(harness.stored()[0]!.visibleTo, [BOB]);
});

test("PATCH /api/libraries/:id refuses an account that does not exist", async (t) => {
  const harness = await mount([library("alpha", 0)]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { visibleTo: ["usr_ffffffff"] } });
  assert.equal(response.status, 400);
  const body = await failure(response);
  assert.equal(body.messageKey, "err.unknownUser");
  assert.equal(body.error, "That account does not exist.");
  assert.equal(harness.stored()[0]!.visibleTo, undefined, "a refused id leaves the library as it was");
});

test("PATCH /api/libraries/:id keeps a dormant grant the request cannot name", async (t) => {
  const harness = await mount([{ ...library("alpha", 0), visibleTo: [ADA, BOB] }]);
  t.after(harness.close);
  // ADA holds that grant from before the promotion. The dashboard hides the grant pane for an
  // administrator, so the list it sends names the ordinary accounts only, and taking the
  // request literally would throw away the one thing a demotion has to give back.
  const cleared = await api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { visibleTo: [] } });
  assert.equal(cleared.status, 200);
  assert.deepEqual(harness.stored()[0]!.visibleTo, [ADA]);

  const echoed = await api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { visibleTo: [ADA, BOB] } });
  assert.equal(echoed.status, 200, "sending the dormant id back is not a grant being made");
  assert.deepEqual(harness.stored()[0]!.visibleTo, [ADA, BOB]);
});

test("PATCH /api/libraries/:id refuses an administrator's id", async (t) => {
  const harness = await mount([library("alpha", 0)]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { visibleTo: [ADA] } });
  assert.equal(response.status, 400);
  assert.equal((await failure(response)).messageKey, "err.adminAlwaysSees");
  assert.equal(harness.stored()[0]!.visibleTo, undefined);
});

test("PATCH /api/libraries/:id refuses an unknown id", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/libraries/nobody", { method: "PATCH", body: { name: "Renamed" } });
  assert.equal(response.status, 404);
  const body = await failure(response);
  assert.equal(body.messageKey, "err.libraryNotFound");
  assert.equal(body.error, "The library was not found.");
});

test("DELETE /api/libraries/:id refuses to remove the last library", async (t) => {
  const harness = await mount([library("only", 0)]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/libraries/only", { method: "DELETE" });
  assert.equal(response.status, 409);
  assert.equal((await failure(response)).messageKey, "err.libraryLast");
  assert.deepEqual(harness.stored().map((record) => record.id), ["only"]);
});

/** A root the picker would accept: inside the grant, and a real folder. */
const grantedRoot = async (name: string) => {
  const root = await mkdtemp(path.join(tmpdir(), `libraries-${name}-`));
  const folders = [path.join(root, "films"), path.join(root, "shows")];
  for (const folder of folders) await mkdir(folder);
  return { root, films: folders[0]!, shows: folders[1]! };
};

test("POST /api/libraries persists the automatic metadata switch and hands the new id over", async (t) => {
  const { root, films, shows } = await grantedRoot("create");
  const harness = await mount([library("alpha", 0)], [{ path: root, source: "env", grantedAt: "2024-01-01T00:00:00.000Z" }]);
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const off = await api(harness.base, "/api/libraries", { method: "POST", body: { name: "Films", type: "movie", root: films, autoScanMetadata: false } });
  assert.equal(off.status, 201);
  const created = harness.stored().at(-1)!;
  assert.equal(created.autoScanMetadata, false);
  assert.deepEqual(harness.invalidated, [created.id], "a fresh library gets a fresh baseline");

  const omitted = await api(harness.base, "/api/libraries", { method: "POST", body: { name: "Shows", type: "series", root: shows } });
  assert.equal(omitted.status, 201);
  const second = harness.stored().at(-1)!;
  assert.equal(second.autoScanMetadata, true, "a request that omits the switch means on");
  assert.deepEqual(harness.invalidated, [created.id, second.id]);
});

test("POST /api/libraries hands a re-added folder's remembered id to the scanner", async (t) => {
  const { root, films } = await grantedRoot("resume");
  const real = await realpath(films);
  const harness = await mount(
    [library("alpha", 0)],
    [{ path: root, source: "env", grantedAt: "2024-01-01T00:00:00.000Z" }],
    [{ id: "lib_deadbeef", root: real, removedAt: new Date().toISOString() }],
  );
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, "/api/libraries", { method: "POST", body: { name: "Back", type: "mixed", root: films } });
  assert.equal(response.status, 201);
  assert.equal(harness.stored().at(-1)!.id, "lib_deadbeef", "the folder takes its old id back");
  assert.deepEqual(harness.invalidated, ["lib_deadbeef"]);
});

test("PATCH /api/libraries/:id persists the automatic metadata switch and invalidates it when it moves", async (t) => {
  const harness = await mount([library("alpha", 0)]);
  t.after(harness.close);

  const off = await api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { autoScanMetadata: false } });
  assert.equal(off.status, 200);
  assert.equal(harness.stored()[0]!.autoScanMetadata, false);
  assert.deepEqual(harness.invalidated, ["alpha"]);

  const renamed = await api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { name: "Renamed" } });
  assert.equal(renamed.status, 200);
  assert.equal(harness.stored()[0]!.autoScanMetadata, false, "a patch that does not mention the switch leaves it alone");
  assert.deepEqual(harness.invalidated, ["alpha"], "and does not buy the library a run of its own");

  const on = await api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { autoScanMetadata: true } });
  assert.equal(on.status, 200);
  assert.equal(harness.stored()[0]!.autoScanMetadata, true);
  assert.deepEqual(harness.invalidated, ["alpha", "alpha"], "switching back on gives the library a fresh baseline");

  const disabled = await api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { enabled: false } });
  assert.equal(disabled.status, 200);
  assert.deepEqual(harness.invalidated, ["alpha", "alpha", "alpha"]);
});

test("PATCH /api/libraries/:id leaves an absent switch absent, which reads as on", async (t) => {
  const harness = await mount([library("alpha", 0)]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { name: "Renamed" } });
  assert.equal(response.status, 200);
  assert.equal(harness.stored()[0]!.autoScanMetadata, undefined, "a record written before the switch keeps no field");
  assert.deepEqual(harness.invalidated, []);
});

test("a non-boolean automatic metadata switch is refused on creation and on an edit", async (t) => {
  const harness = await mount([library("alpha", 0)]);
  t.after(harness.close);

  const created = await api(harness.base, "/api/libraries", { method: "POST", body: { name: "Films", type: "movie", root: "/media/films", autoScanMetadata: "no" } });
  assert.equal(created.status, 400);
  assert.equal((await failure(created)).messageKey, "err.invalidRequest");
  assert.deepEqual(harness.invalidated, [], "a refused request invalidates nothing");

  const patched = await api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { autoScanMetadata: 1 } });
  assert.equal(patched.status, 400);
  assert.equal((await failure(patched)).messageKey, "err.invalidRequest");
  assert.equal(harness.stored()[0]!.autoScanMetadata, undefined);
});

test("POST /api/libraries/grants refuses a relative path", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/libraries/grants", { method: "POST", body: { path: "media/films" } });
  assert.equal(response.status, 400);
  assert.equal((await failure(response)).messageKey, "err.libraryRootAbsolute");
  assert.deepEqual(harness.userGrants(), []);
});

test("DELETE /api/libraries/grants cannot remove an operator grant", async (t) => {
  const env: RootGrant[] = [{ path: "/media", source: "env", grantedAt: "2024-01-01T00:00:00.000Z" }];
  const harness = await mount([library("alpha", 0)], env);
  t.after(harness.close);
  const response = await api(harness.base, "/api/libraries/grants", { method: "DELETE", body: { path: "/media" } });
  assert.equal(response.status, 404);
  assert.equal((await failure(response)).messageKey, "err.grantNotFound");
  assert.deepEqual(harness.userGrants(), [], "the operator's grant is not the store's to drop");
  assert.deepEqual(harness.allGrants().map((grant) => grant.path), ["/media"], "the operator's grant is still in force");
});

test("POST /api/libraries/:id/reroot refuses without moveContent", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/libraries/alpha/reroot", { method: "POST", body: { root: "/media/moved" } });
  assert.equal(response.status, 400);
  assert.equal((await failure(response)).messageKey, "err.invalidRequest");
  assert.deepEqual(harness.enqueued, []);
});

test("the write-time check runs through the route, and refuses rather than failing", async (t) => {
  const harness = await mount([library("alpha", 0)]);
  t.after(harness.close);

  // The account is switched off after the request has already resolved its actor -- which is
  // every case the check exists for, and the point at which the session also stops resolving.
  // Reaching the write on a role that has been taken away must answer 403, and it must be the
  // refusal rather than a crash: the guard reads the captured actor against the list as it is
  // now, so neither half of the comparison can quietly be the same record.
  harness.disable(ADA);
  harness.loseSession(1);

  const response = await api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { visibleTo: [BOB] } });
  assert.equal(response.status, 403, `expected a refusal, got ${response.status}`);
  assert.equal((await failure(response)).messageKey, "err.notAllowed");
  assert.deepEqual(harness.stored()[0]?.visibleTo, undefined, "the edit landed on a role the account no longer had");
});
