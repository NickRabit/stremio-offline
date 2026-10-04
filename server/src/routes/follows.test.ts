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
import type { LibraryRecord } from "../libraries.js";
import { defaultDownloadSettings } from "../naming.js";
import type { Store, UserPrefs } from "../store.js";
import type { UserData, UserRecord } from "../users.js";
import { registerFollowRoutes, type FollowDeps } from "./follows.js";

const ADA = "usr_00000001";
const BOB = "usr_00000002";
const CARL = "usr_00000003";

const account = (id: string, role: "admin" | "user", downloadToLibrary = true): UserRecord => ({
  id, username: role === "admin" ? "ada" : "bob", role, createdAt: "2026-01-01T00:00:00.000Z",
  permissions: { downloadToLibrary, downloadToDevice: true }, permissionsVersion: 0,
} as unknown as UserRecord);

interface Harness { base: string; store: FollowStore; close(): Promise<void> }

/** Real express over a real store: the routes take everything from the context, and the
 *  account each request speaks for is named by a header so one server can hold two. */
const mount = async (): Promise<Harness> => {
  const dir = mkdtempSync(path.join(tmpdir(), "routes-follows-"));
  const store = new FollowStore(dir);
  await store.load();
  const users: Record<string, UserRecord> = { A: account(ADA, "admin"), B: account(BOB, "user"), C: account(CARL, "user", false) };
  const jobs: Array<{ id: string; status: string; follow?: { followId: string; episodeKey: string; intent: string }; source?: { type: string; videoId: string } }> = [];
  let nextId = 1;
  const queue = {
    addPending: async (_title: string, source: { type: string; videoId: string }, _media: unknown, _ownerUserId: string, follow: { followId: string; episodeKey: string; intent: string }) => {
      const job = { id: `job-${nextId++}`, status: "queued", follow, source: { type: source.type, videoId: source.videoId } };
      jobs.push(job);
      return { id: job.id };
    },
    findActiveEpisode: () => undefined,
    adopt: async () => undefined,
    followJobs: () => jobs,
    get: (id: string) => jobs.find((job) => job.id === id),
    retry: async () => undefined,
    remove: async () => undefined,
  };
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
    queue,
    mayDownload: (ownerUserId) => Boolean(Object.values(users).find((entry) => entry.id === ownerUserId)?.permissions.downloadToLibrary),
  });
  const libraries: LibraryRecord[] = [{ id: "lib_shows", name: "Shows", type: "series", root: dir, enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: false }];
  const addons = [
    { key: "stream-addon", enabled: true, role: "source", allowedUsers: [BOB], manifest: { id: "stream-addon", name: "Stream" }, downloadSettings: defaultDownloadSettings() },
    { key: "admin-addon", enabled: true, role: "source", allowedUsers: [ADA], manifest: { id: "admin-addon", name: "Admin" }, downloadSettings: defaultDownloadSettings() },
  ];
  const userData: Record<string, UserData> = {};
  const keyOfReq = (req: express.Request | undefined) => String(req?.header("x-as") ?? "A");
  const deps: FollowDeps = {
    store: { addons: () => addons, libraries: () => libraries, settings: () => ({}) } as unknown as Store,
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
    dataOf: (req) => userData[keyOfReq(req)] ?? ({} as UserData),
    updateData: async (req, mutate) => {
      const key = keyOfReq(req);
      const data = userData[key] ?? ({} as UserData);
      mutate(data);
      userData[key] = data;
    },
    posterOf: (value) => (value === undefined || value === null ? undefined : String(value)),
    cachedMeta: async () => null,
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
    store,
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
    assert.equal(((await (await api(h.base, "/api/follows/by-meta/series/tt1", { as: "B" })).json()) as { follow: unknown }).follow, null);

    const patch = await api(h.base, `/api/follows/${follow.id}`, { method: "PATCH", as: "A", body: { enabled: false } });
    assert.equal(patch.status, 200);
    assert.equal(((await patch.json()) as { enabled: boolean }).enabled, false);
    assert.ok(((await (await api(h.base, "/api/follows/by-meta/series/tt1", { as: "A" })).json()) as { follow: unknown }).follow);

    assert.equal((await api(h.base, `/api/follows/${follow.id}`, { method: "DELETE", as: "A" })).status, 204);
    assert.equal(((await (await api(h.base, "/api/follows/by-meta/series/tt1", { as: "A" })).json()) as { follow: unknown }).follow, null);
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

test("switching a follow to automatic needs the right to queue", async () => {
  const h = await mount();
  try {
    const follow = await (await api(h.base, "/api/follows", { method: "POST", as: "C", body: { type: "series", id: "tt1", name: "Show" } })).json() as { id: string };
    const denied = await api(h.base, `/api/follows/${follow.id}`, {
      method: "PATCH", as: "C",
      body: { autoDownload: { startMode: "new", selection: { addonKeys: ["stream-addon"], audioLanguage: "en" } } },
    });
    assert.equal(denied.status, 403);
    assert.equal(await keyOf(denied), "err.downloadLibraryNotAllowed");

    const allowed = await api(h.base, `/api/follows/${follow.id}`, {
      method: "PATCH", as: "B",
      body: { autoDownload: { startMode: "new", selection: { addonKeys: ["stream-addon"], audioLanguage: "en" } } },
    });
    assert.equal(allowed.status, 404, "the follow belongs to another account");
  } finally { await h.close(); }
});

test("an automatic rule stores an explicit, concrete target", async () => {
  const h = await mount();
  try {
    const follow = await (await api(h.base, "/api/follows", { method: "POST", as: "B", body: { type: "series", id: "tt1", name: "Show" } })).json() as { id: string };
    const response = await api(h.base, `/api/follows/${follow.id}`, {
      method: "PATCH", as: "B",
      body: { autoDownload: { startMode: "new", selection: { addonKeys: ["stream-addon"], audioLanguage: "en" } } },
    });
    assert.equal(response.status, 200);
    const view = await response.json() as { autoDownload?: { enabledAt: string; startMode: string; selection: { addonKeys: string[]; targetSettings: Record<string, unknown> } } };
    assert.ok(view.autoDownload?.enabledAt);
    assert.equal(view.autoDownload?.startMode, "new");
    assert.deepEqual(view.autoDownload?.selection.addonKeys, ["stream-addon"]);
    assert.deepEqual(view.autoDownload?.selection.targetSettings, { libraryId: "lib_shows", subfolder: "", layout: "structured", explicit: true });
  } finally { await h.close(); }
});

test("another account's follow answers 404 on every new route", async () => {
  const h = await mount();
  try {
    const follow = await (await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "series", id: "tt1", name: "Show" } })).json() as { id: string };
    const routes: Array<{ method: string; path: string }> = [
      { method: "GET", path: `/api/follows/${follow.id}/episodes` },
      { method: "GET", path: `/api/follows/${follow.id}/preview?startMode=new` },
      { method: "POST", path: `/api/follows/${follow.id}/episodes/1:1/skip` },
      { method: "POST", path: `/api/follows/${follow.id}/episodes/1:1/retry` },
    ];
    for (const route of routes) {
      const response = await api(h.base, route.path, { method: route.method, as: "B" });
      assert.equal(response.status, 404, `${route.method} ${route.path}`);
    }
  } finally { await h.close(); }
});

test("follow defaults round-trip and drop unknown keys", async () => {
  const h = await mount();
  try {
    const empty = await (await api(h.base, "/api/follows/defaults", { as: "A" })).json() as { defaults: unknown };
    assert.equal(empty.defaults, null, "nothing stored yet");

    const put = await api(h.base, "/api/follows/defaults", {
      method: "PUT", as: "A",
      body: {
        mode: "download", startMode: "from", unknownTop: "dropped",
        selection: {
          addonKeys: ["stream-addon"], sourceStrategy: "largest", audioLanguage: " en ",
          audioMode: "preferred", subtitleMode: "optional", subtitleLanguage: "cs", unknownInner: 1,
        },
        target: { libraryId: " lib_shows ", subfolder: "Shows", layout: "flat", explicit: true },
      },
    });
    assert.equal(put.status, 204);

    const read = await (await api(h.base, "/api/follows/defaults", { as: "A" })).json() as { defaults: Record<string, unknown> };
    assert.deepEqual(read.defaults, {
      mode: "download", startMode: "from",
      selection: { addonKeys: ["stream-addon"], sourceStrategy: "largest", audioLanguage: "en", audioMode: "preferred", subtitleMode: "optional", subtitleLanguage: "cs" },
      target: { libraryId: "lib_shows", subfolder: "Shows", layout: "flat" },
    });
  } finally { await h.close(); }
});

test("a stale addon key and an invisible library are dropped on read", async () => {
  const h = await mount();
  try {
    const body = {
      mode: "download", startMode: "new",
      selection: { addonKeys: ["stream-addon", "admin-addon", "gone-addon"], sourceStrategy: "priority", audioLanguage: "en", audioMode: "listed", subtitleMode: "off" },
      target: { libraryId: "lib_shows", layout: "structured" },
    };
    assert.equal((await api(h.base, "/api/follows/defaults", { method: "PUT", as: "B", body })).status, 204);
    assert.equal((await api(h.base, "/api/follows/defaults", { method: "PUT", as: "A", body })).status, 204);

    const theirs = await (await api(h.base, "/api/follows/defaults", { as: "B" })).json() as { defaults: { selection: { addonKeys: string[] }; target?: unknown } };
    assert.deepEqual(theirs.defaults.selection.addonKeys, ["stream-addon"], "an addon they may not use and one that is gone are dropped");
    assert.equal(theirs.defaults.target, undefined, "a library they may not see is dropped");

    const admins = await (await api(h.base, "/api/follows/defaults", { as: "A" })).json() as { defaults: { selection: { addonKeys: string[] }; target?: { libraryId: string } } };
    assert.deepEqual(admins.defaults.selection.addonKeys, ["stream-addon", "admin-addon"], "an administrator may use both addons");
    assert.equal(admins.defaults.target?.libraryId, "lib_shows", "an administrator sees the library");
  } finally { await h.close(); }
});

test("an invalid defaults body answers 400", async () => {
  const h = await mount();
  try {
    const bodies = [
      {},
      { mode: "sometimes" },
      { mode: "download", startMode: "later" },
      { mode: "download", selection: { addonKeys: ["stream-addon"] } },
      { mode: "download", target: {} },
      { mode: "download", selection: { addonKeys: Array.from({ length: 51 }, (_unused, index) => `addon-${index}`), sourceStrategy: "priority", audioLanguage: "en", audioMode: "listed", subtitleMode: "off" } },
    ];
    for (const body of bodies) {
      const response = await api(h.base, "/api/follows/defaults", { method: "PUT", as: "A", body });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(await keyOf(response), "err.followInvalid");
    }
  } finally { await h.close(); }
});

test("GET /api/follows/defaults is not read as a follow id", async () => {
  const h = await mount();
  try {
    assert.equal((await api(h.base, "/api/follows/defaults", { as: "A" })).status, 200);
    assert.equal((await api(h.base, "/api/follows/defaults", { method: "PUT", as: "A", body: { mode: "notify" } })).status, 204);
    const read = await (await api(h.base, "/api/follows/defaults", { as: "A" })).json() as { defaults: { mode: string } };
    assert.equal(read.defaults.mode, "notify");
    // The `:id` routes still treat `defaults` as an id, which is why the two new verbs are registered first.
    assert.equal((await api(h.base, "/api/follows/defaults", { method: "PATCH", as: "A", body: { enabled: false } })).status, 404);
  } finally { await h.close(); }
});

test("the calendar window is validated", async () => {
  const h = await mount();
  try {
    const missing = await api(h.base, "/api/follows/calendar", { as: "A" });
    assert.equal(missing.status, 400);
    assert.equal(await keyOf(missing), "err.followInvalid");

    const reversed = await api(h.base, "/api/follows/calendar?from=2024-04-01&to=2024-03-01", { as: "A" });
    assert.equal(reversed.status, 400);
    assert.equal(await keyOf(reversed), "err.followInvalid");

    const tooWide = await api(h.base, "/api/follows/calendar?from=2024-01-01&to=2024-04-01", { as: "A" });
    assert.equal(tooWide.status, 400, "ninety-one days is more than the window allows");

    const atLimit = await api(h.base, "/api/follows/calendar?from=2024-01-01&to=2024-03-03", { as: "A" });
    assert.equal(atLimit.status, 200, "sixty-two days is allowed");
    const window = await atLimit.json() as { items: unknown[]; undated: unknown[] };
    assert.deepEqual(window.items, []);
    assert.deepEqual(window.undated, []);
  } finally { await h.close(); }
});

test("the calendar reports an uncertain episode without a date apart", async () => {
  const h = await mount();
  try {
    const follow = await (await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "series", id: "tt1", name: "Show" } })).json() as { id: string };
    // Let the first check settle, then replace its episode with the shape a TMDB placeholder leaves.
    await api(h.base, `/api/follows/${follow.id}/check`, { method: "POST", as: "A" });
    await h.store.update(follow.id, (current) => {
      current.episodes["1:1"] = { key: "1:1", videoId: "tt1:1:1", season: 1, episode: 1, firstSeenAt: new Date().toISOString(), dateUncertain: true };
    });

    const body = await (await api(h.base, "/api/follows/calendar?from=2024-03-01&to=2024-04-01", { as: "A" })).json() as { items: unknown[]; undated: Array<{ season: number; episode: number; dateUncertain?: boolean }> };
    assert.deepEqual(body.items, []);
    assert.deepEqual(body.undated.map((item) => [item.season, item.episode, item.dateUncertain]), [[1, 1, true]]);
  } finally { await h.close(); }
});

test("another account never sees A's calendar or activity", async () => {
  const h = await mount();
  try {
    const follow = await (await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "series", id: "tt1", name: "Show" } })).json() as { id: string };
    assert.equal((await api(h.base, `/api/follows/${follow.id}/check`, { method: "POST", as: "A" })).status, 200);
    const rule = await api(h.base, `/api/follows/${follow.id}`, {
      method: "PATCH", as: "A",
      body: { autoDownload: { startMode: "from", startSeason: 1, startEpisode: 1, selection: { addonKeys: ["stream-addon"], audioLanguage: "en" } } },
    });
    assert.equal(rule.status, 200, "the followed episode is queued so it has a download state");

    const mine = await (await api(h.base, "/api/follows/calendar?from=2024-03-01&to=2024-04-01", { as: "A" })).json() as { items: Array<{ followId: string; season: number; episode: number; state: string }> };
    assert.deepEqual(mine.items.map((item) => [item.followId, item.season, item.episode, item.state]), [[follow.id, 1, 1, "queued"]]);
    const theirs = await (await api(h.base, "/api/follows/calendar?from=2024-03-01&to=2024-04-01", { as: "B" })).json() as { items: unknown[] };
    assert.deepEqual(theirs.items, []);

    const mineActivity = await (await api(h.base, "/api/follows/activity", { as: "A" })).json() as { items: Array<{ episode: number; state: string }> };
    assert.deepEqual(mineActivity.items.map((item) => [item.episode, item.state]), [[1, "queued"]]);
    const theirActivity = await (await api(h.base, "/api/follows/activity", { as: "B" })).json() as { items: unknown[] };
    assert.deepEqual(theirActivity.items, []);
  } finally { await h.close(); }
});

test("only a series or a film can be followed", async () => {
  const h = await mount();
  try {
    const film = await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "movie", id: "tt9", name: "Film" } });
    assert.equal(film.status, 201);
    const other = await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "channel", id: "c1", name: "Channel" } });
    assert.equal(other.status, 400);
    assert.equal(await keyOf(other), "err.followInvalid");
  } finally { await h.close(); }
});
