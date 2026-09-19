import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { messageKeyOf } from "../errors.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import { ResourceError } from "../media-resources.js";
import type { Store, UserPrefs } from "../store.js";
import { emptyUserData, type UserData } from "../users.js";
import { registerPersonalRoutes, type PersonalDeps } from "./personal.js";

type WatchlistEntry = { type: string; id: string; name: string; poster?: string; addedAt: string };
type StoredProgress = { position: number; duration: number; title: string; path?: string; poster?: string; addonKey?: string; series?: { id: string; name: string; season: number; episode: number }; updatedAt: string };
type WatchedMarker = { name: string; poster?: string; addonKey?: string; season: number; episode: number; updatedAt: string };

const ALICE = "usr_00000001";
const BOB = "usr_00000002";

/** The instance says tracking is on in every test; only a person's own flag may switch it off. */
const instancePrefs: UserPrefs = {
  uiLanguage: "en", audioLanguage: "en", subtitleLanguage: "en", downloadTitleLanguage: "ui",
  mergeByName: false, streamSort: "recommended", trackProgress: true, showResumeRow: true,
  catalogTileSize: "medium", libraryTileSize: "medium", catalogTileShape: "poster", libraryTileShape: "poster",
};

interface Harness {
  base: string;
  /** Whose preferences each `prefsOf` call asked for. */
  prefsAsked: string[];
  favoriteCalls: Array<{ relative: string; wanted: boolean }>;
  data(user: string): UserData;
  close(): Promise<void>;
}

/** The header stands in for the session: the two users are the two callers the routes
 *  have to keep apart, and `dataOf`/`updateData` refuse a request that names neither. */
const mount = async (): Promise<Harness> => {
  const users = new Map<string, UserData>([[ALICE, emptyUserData()], [BOB, emptyUserData()]]);
  const prefsAsked: string[] = [];
  const favoriteCalls: Harness["favoriteCalls"] = [];
  const userOf = (req?: express.Request) => {
    const id = req?.header("x-user");
    return id && users.has(id) ? id : undefined;
  };
  const deps: PersonalDeps = {
    store: { libraries: () => [], settings: () => ({ ...instancePrefs }) } as unknown as Store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: () => undefined,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    attachBrowseMeta: (item) => ({ item, backfill: false }),
    cachedMeta: async () => null,
    dataOf: (req) => {
      const id = userOf(req);
      if (!id) throw new ResourceError(401, "AUTH_REQUIRED");
      return users.get(id)!;
    },
    describeLibraryPath: async () => undefined,
    libraryKey: (value) => value,
    libraryOfKey: () => { throw new Error("the resume row is not under test"); },
    locateFileArtwork: async () => undefined,
    locateFolderArtworkPair: async () => ({ poster: undefined, wide: undefined }),
    markersOf: (data) => data.watchedSeries as Record<string, WatchedMarker>,
    metaStore: { qualifiedMeta: () => ({}) } as unknown as LibraryMetaStore,
    posterOf: (value) => (value ? String(value) : undefined),
    prefsOf: (req) => {
      const id = userOf(req);
      prefsAsked.push(id ?? "anonymous");
      return { ...instancePrefs, ...(id ? users.get(id)!.prefs : {}) } as UserPrefs;
    },
    progressOf: (data) => data.progress as Record<string, StoredProgress>,
    scheduleFileArtwork: () => undefined,
    scheduleFolderArtwork: () => undefined,
    setLibraryFavorite: async (relative, wanted) => { favoriteCalls.push({ relative, wanted }); },
    thumbUrl: async () => undefined,
    updateData: async (req, mutate) => {
      const id = userOf(req);
      if (!id) throw new ResourceError(401, "AUTH_REQUIRED");
      mutate(users.get(id)!);
    },
    watchlistOf: (data) => data.watchlist as Record<string, WatchlistEntry>,
    wirePath: (key) => key,
  };
  const app = express();
  app.use(express.json());
  registerPersonalRoutes(app, deps);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    res.status(status).json({
      error: error instanceof Error ? error.message : String(error),
      code: error instanceof ResourceError ? error.code : undefined,
      messageKey: messageKeyOf(error),
    });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    prefsAsked,
    favoriteCalls,
    data: (user) => users.get(user)!,
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

test("GET /api/watchlist answers each caller with their own rows", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  harness.data(ALICE).watchlist = { "movie:tt1": { type: "movie", id: "tt1", name: "Alice's film", addedAt: "2024-01-01T00:00:00.000Z" } };
  harness.data(BOB).watchlist = { "series:tt2": { type: "series", id: "tt2", name: "Bob's show", addedAt: "2024-02-02T00:00:00.000Z" } };

  const alice = await api(harness.base, "/api/watchlist", { user: ALICE });
  assert.equal(alice.status, 200);
  const aliceRows = await alice.json() as Array<{ key: string; name: string }>;
  const bobRows = await (await api(harness.base, "/api/watchlist", { user: BOB })).json() as Array<{ key: string; name: string }>;

  assert.deepEqual(aliceRows.map((row) => [row.key, row.name]), [["movie:tt1", "Alice's film"]]);
  assert.deepEqual(bobRows.map((row) => [row.key, row.name]), [["series:tt2", "Bob's show"]]);
});

test("POST /api/progress writes the position through updateData", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const response = await api(harness.base, "/api/progress", {
    method: "POST", user: ALICE,
    body: { key: "movie:tt1", position: 120, duration: 3600, title: "Heat", path: "Films/Heat.mkv", poster: "heat.jpg" },
  });

  assert.equal(response.status, 204);
  assert.deepEqual(Object.keys(harness.data(ALICE).progress), ["movie:tt1"]);
  const stored = harness.data(ALICE).progress["movie:tt1"] as StoredProgress;
  assert.equal(stored.position, 120);
  assert.equal(stored.duration, 3600);
  assert.equal(stored.title, "Heat");
  assert.equal(stored.path, "Films/Heat.mkv");
  assert.equal(stored.poster, "heat.jpg");
  assert.equal(typeof stored.updatedAt, "string");
  assert.deepEqual(harness.data(BOB).progress, {}, "the position is the caller's own");
});

test("POST /api/progress is refused without a user, the way dataOf refuses", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const response = await api(harness.base, "/api/progress", { method: "POST", body: { key: "movie:tt1", position: 10, duration: 100 } });

  assert.equal(response.status, 401);
  assert.equal((await response.json() as { code?: string }).code, "AUTH_REQUIRED");
  assert.deepEqual(harness.data(ALICE).progress, {});
});

test("POST /api/progress is a no-op when the caller's own trackProgress is off", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  harness.data(BOB).prefs = { trackProgress: false };

  const response = await api(harness.base, "/api/progress", {
    method: "POST", user: BOB, body: { key: "movie:tt1", position: 120, duration: 3600, title: "Heat" },
  });

  assert.equal(response.status, 204);
  assert.deepEqual(harness.data(BOB).progress, {}, "the instance keeps tracking on; the person's preference decides");
  assert.deepEqual(harness.prefsAsked, [BOB], "the flag is read through prefsOf");
});

test("DELETE /api/progress/:key removes one key and leaves the rest", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  harness.data(ALICE).progress = {
    "movie:tt1": { position: 60, duration: 600, title: "Heat", updatedAt: "2024-01-01T00:00:00.000Z" },
    "movie:tt2": { position: 30, duration: 600, title: "Ronin", updatedAt: "2024-01-02T00:00:00.000Z" },
  };

  const response = await api(harness.base, "/api/progress/movie:tt1", { method: "DELETE", user: ALICE });

  assert.equal(response.status, 204);
  assert.deepEqual(Object.keys(harness.data(ALICE).progress), ["movie:tt2"]);
  assert.deepEqual(harness.data(BOB).progress, {});
});

test("POST /api/library/favorite hands setLibraryFavorite the relative path and the wanted state", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const added = await api(harness.base, "/api/library/favorite", { method: "POST", user: ALICE, body: { path: "  Films/Heat.mkv  ", favorite: true } });
  assert.equal(added.status, 200);
  assert.deepEqual(await added.json(), { path: "Films/Heat.mkv", favorite: true });

  const removed = await api(harness.base, "/api/library/favorite", { method: "POST", user: BOB, body: { path: "Films/Heat.mkv" } });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { path: "Films/Heat.mkv", favorite: false });

  assert.deepEqual(harness.favoriteCalls, [
    { relative: "Films/Heat.mkv", wanted: true },
    { relative: "Films/Heat.mkv", wanted: false },
  ]);
});
