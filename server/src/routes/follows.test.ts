import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { messageKeyOf } from "../errors.js";
import { FollowService, FollowStore } from "../follows.js";
import type { Store, UserPrefs } from "../store.js";
import type { UserData, UserRecord } from "../users.js";
import { registerFollowRoutes, type FollowDeps } from "./follows.js";

const ADA = "usr_00000001";
const BOB = "usr_00000002";

const account = (id: string, role: "admin" | "user"): UserRecord => ({
  id, username: role === "admin" ? "ada" : "bob", role, createdAt: "2026-01-01T00:00:00.000Z",
  permissions: { downloadToLibrary: true, downloadToDevice: true }, permissionsVersion: 0,
} as unknown as UserRecord);

interface Harness { base: string; close(): Promise<void> }

/** Real express over a real store: the routes take everything from the context, and the
 *  account each request speaks for is named by a header so one server can hold two. */
const mount = async (): Promise<Harness> => {
  const dir = mkdtempSync(path.join(tmpdir(), "routes-follows-"));
  const store = new FollowStore(dir);
  await store.load();
  const users: Record<string, UserRecord> = { A: account(ADA, "admin"), B: account(BOB, "user") };
  const service = new FollowService({
    store,
    now: () => Date.now(),
    owner: (userId) => {
      const user = Object.values(users).find((entry) => entry.id === userId);
      return user ? { id: user.id, role: user.role, disabled: user.disabled } : undefined;
    },
    meta: async (_owner, type, metaId) => ({
      id: metaId, type, name: "Show",
      videos: [{ id: `${metaId}:1:1`, season: 1, episode: 1, name: "Pilot", released: "2024-03-01" }],
    }),
  });
  const deps: FollowDeps = {
    store: {} as Store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: (req) => users[String(req.header("x-as") ?? "A")],
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
    follows: service,
    followStore: store,
    prefsOf: () => ({ uiLanguage: "en" }) as UserPrefs,
    markersOf: () => ({}),
    dataOf: () => ({}) as UserData,
    posterOf: (value) => (value === undefined || value === null ? undefined : String(value)),
  };
  const app = express();
  app.use(express.json());
  registerFollowRoutes(app, deps);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error), messageKey: messageKeyOf(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const api = (base: string, pathname: string, init: { method?: string; body?: unknown; as?: string } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.as ? { "x-as": init.as } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

const keyOf = async (response: Response) => ((await response.json()) as { messageKey?: string }).messageKey;

test("a follow belongs to the account that made it", async () => {
  const h = await mount();
  try {
    const created = await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "series", id: "tt1", name: "Show" } });
    assert.equal(created.status, 201);
    const follow = await created.json() as { id: string; episodeCount: number };
    assert.equal(follow.episodeCount, 0);

    const mine = await (await api(h.base, "/api/follows", { as: "A" })).json() as { follows: Array<{ id: string }> };
    assert.deepEqual(mine.follows.map((entry) => entry.id), [follow.id]);
    const theirs = await (await api(h.base, "/api/follows", { as: "B" })).json() as { follows: unknown[] };
    assert.deepEqual(theirs.follows, []);

    assert.equal((await api(h.base, `/api/follows/${follow.id}`, { method: "PATCH", as: "B", body: { enabled: false } })).status, 404);
    assert.equal((await api(h.base, `/api/follows/${follow.id}`, { method: "DELETE", as: "B" })).status, 404);
    assert.equal((await api(h.base, `/api/follows/${follow.id}/check`, { method: "POST", as: "B" })).status, 404);
    assert.equal((await api(h.base, "/api/follows/by-meta/series/tt1", { as: "B" })).status, 404);

    const patch = await api(h.base, `/api/follows/${follow.id}`, { method: "PATCH", as: "A", body: { enabled: false } });
    assert.equal(patch.status, 200);
    assert.equal(((await patch.json()) as { enabled: boolean }).enabled, false);
    assert.equal((await api(h.base, "/api/follows/by-meta/series/tt1", { as: "A" })).status, 200);

    assert.equal((await api(h.base, `/api/follows/${follow.id}`, { method: "DELETE", as: "A" })).status, 204);
    assert.equal((await api(h.base, "/api/follows/by-meta/series/tt1", { as: "A" })).status, 404);
  } finally { await h.close(); }
});

test("a follow needs a type, an id and a name", async () => {
  const h = await mount();
  try {
    const response = await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "series", id: "tt1" } });
    assert.equal(response.status, 400);
    assert.equal(await keyOf(response), "err.followInvalid");
  } finally { await h.close(); }
});

test("a check is throttled and its episodes show up behind the view", async () => {
  const h = await mount();
  try {
    const follow = await (await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "series", id: "tt1", name: "Show" } })).json() as { id: string };
    const first = await api(h.base, `/api/follows/${follow.id}/check`, { method: "POST", as: "A" });
    assert.equal(first.status, 200);
    assert.equal(((await first.json()) as { episodeCount: number }).episodeCount, 1);
    const second = await api(h.base, `/api/follows/${follow.id}/check`, { method: "POST", as: "A" });
    assert.equal(second.status, 429);
    assert.equal(await keyOf(second), "err.followCooldown");

    const episodes = await (await api(h.base, "/api/follows/new-episodes", { as: "A" })).json() as { items: unknown[] };
    assert.deepEqual(episodes.items, []);
  } finally { await h.close(); }
});
