import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { messageKeyOf } from "../errors.js";
import { mergeGrants } from "../library-grants.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import type { LibraryOps } from "../library-ops.js";
import type { LibraryHealth } from "../library-probe.js";
import type { LibraryRecord, RootGrant } from "../libraries.js";
import type { Store } from "../store.js";
import { registerLibrariesRoutes, type LibrariesDeps } from "./libraries.js";

interface Harness {
  base: string;
  viewed: Array<{ id: string; health: LibraryHealth; stats: { titles: number; files: number; bytes: number } }>;
  enqueued: unknown[];
  stored: () => LibraryRecord[];
  userGrants: () => RootGrant[];
  allGrants: () => RootGrant[];
  close(): Promise<void>;
}

const library = (id: string, order: number): LibraryRecord => ({
  id, name: `Library ${id}`, type: "mixed", root: `/media/${id}`, enabled: true, order,
  addedAt: "2024-01-01T00:00:00.000Z", writeArtwork: false,
});

const stats = new Map([["alpha", { titles: 3, files: 4, bytes: 5 }]]);

/** The routes take everything they need from the context, so the app here is a real express
 *  instance over fake collaborators that record what they were asked to do. */
const mount = async (records: LibraryRecord[] = [library("alpha", 0)], env: RootGrant[] = []): Promise<Harness> => {
  const state = { libraries: records, grants: [] as RootGrant[], departed: [] as Array<{ id: string; root: string; removedAt: string }> };
  const viewed: Harness["viewed"] = [];
  const enqueued: unknown[] = [];
  const store = {
    libraries: () => state.libraries,
    grants: () => state.grants,
    departed: () => state.departed,
    update: async (mutate: (value: typeof state) => void) => { mutate(state); },
  } as unknown as Store;
  const deps: LibrariesDeps = {
    store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: () => undefined,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    accountIdOf: () => "usr_00000001",
    grantRows: async () => mergeGrants(env, state.grants).map((grant) => ({ ...grant, writable: true })),
    healthOf: (record) => ({ unreachable: record.id === "alpha", readOnly: record.id === "beta" }),
    invalidateLibrary: () => undefined,
    libraryGrants: () => mergeGrants(env, state.grants),
    libraryStats: async () => stats,
    libraryView: (record, health, totals) => {
      viewed.push({ id: record.id, health, stats: totals });
      return { id: record.id, name: record.name, unreachable: health.unreachable, readOnly: health.readOnly, ...totals };
    },
    mutateData: (_state, _id, mutate) => mutate({ prefs: {}, favorites: [], watchlist: {}, progress: {}, watchedSeries: {} }),
    progressOf: () => ({}),
    refreshLibraryHealth: async () => new Map(),
    libraryProbe: {
      probe: async () => ({ unreachable: false, readOnly: false }),
      cached: async () => ({ unreachable: false, readOnly: false }),
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
    stored: () => state.libraries,
    userGrants: () => state.grants,
    allGrants: () => mergeGrants(env, state.grants),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

const api = (base: string, pathname: string, init: { method?: string; body?: unknown } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
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
  assert.deepEqual(harness.viewed[0].health, { unreachable: true, readOnly: false });
  assert.deepEqual(harness.viewed[0].stats, { titles: 3, files: 4, bytes: 5 });
  assert.deepEqual(harness.viewed[1].stats, { titles: 0, files: 0, bytes: 0 });
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
