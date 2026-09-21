import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { messageKeyOf } from "../errors.js";
import { parseLibraryPath, type LibraryRecord } from "../libraries.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import { ResourceError } from "../media-resources.js";
import type { Store, UserPrefs } from "../store.js";
import { emptyUserData, type UserData, type UserRecord } from "../users.js";
import type { MetaItem, AddonRecord } from "../types.js";
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
  favoriteCalls: Array<{ relative: string; wanted: boolean; userId: string | undefined }>;
  data(user: string): UserData;
  close(): Promise<void>;
}

/** The header stands in for the session: the two users are the two callers the routes
 *  have to keep apart, and `dataOf`/`updateData` refuse a request that names neither. */
const addons: AddonRecord[] = [];
let metaLookups: Array<{ type: string; id: string; viewer: string | undefined }> = [];
let metaAnswer: MetaItem | null = null;

const mount = async (libraries: LibraryRecord[] = []): Promise<Harness> => {
  const users = new Map<string, UserData>([[ALICE, emptyUserData()], [BOB, emptyUserData()]]);
  const prefsAsked: string[] = [];
  const favoriteCalls: Harness["favoriteCalls"] = [];
  const userOf = (req?: express.Request) => {
    const id = req?.header("x-user");
    return id && users.has(id) ? id : undefined;
  };
  const deps: PersonalDeps = {
    store: { libraries: () => libraries, addons: () => addons, settings: () => ({ ...instancePrefs }) } as unknown as Store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: (req) => {
      const id = userOf(req);
      return id ? { id, username: id, role: "user" } as unknown as UserRecord : undefined;
    },
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
    attachBrowseMeta: (item) => ({ item, backfill: false }),
    cachedMeta: async (type, id, language, viewer) => { metaLookups.push({ type, id, viewer: viewer?.id }); return metaAnswer; },
    dataOf: (req) => {
      const id = userOf(req);
      if (!id) throw new ResourceError(401, "AUTH_REQUIRED");
      return users.get(id)!;
    },
    describeLibraryPath: async (key) => {
      const relative = parseLibraryPath(key)?.relative ?? key;
      return { kind: "file", path: relative, label: relative.slice(relative.lastIndexOf("/") + 1), season: null, episode: null, size: 0, modified: "2024-01-01T00:00:00.000Z" };
    },
    libraryKey: (value) => value,
    libraryOfKey: (key) => {
      const parsed = parseLibraryPath(key)!;
      return { library: libraries.find((item) => item.id === parsed.libraryId)!, relative: parsed.relative };
    },
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
    setLibraryFavorite: async (relative, wanted, userId) => { favoriteCalls.push({ relative, wanted, userId }); },
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

  // The account that clicked, not whoever is first in the list: a star is one person's, and
  // two different people starred and unstarred here.
  assert.deepEqual(harness.favoriteCalls, [
    { relative: "Films/Heat.mkv", wanted: true, userId: ALICE },
    { relative: "Films/Heat.mkv", wanted: false, userId: BOB },
  ]);
});

const granted: LibraryRecord = { id: "lib_00000002", name: "Shows", type: "mixed", root: "/media/shows", enabled: true, order: 1, addedAt: "", writeArtwork: false, visibleTo: [ALICE] };
const lost: LibraryRecord = { id: "lib_00000001", name: "Films", type: "mixed", root: "/media/films", enabled: true, order: 0, addedAt: "", writeArtwork: false };

test("GET /api/library/resume drops a row whose library the caller has lost and still answers", async (t) => {
  const harness = await mount([lost, granted]);
  t.after(harness.close);
  harness.data(ALICE).progress = {
    "file:lib_00000001/Films/Heat.mkv": { position: 60, duration: 600, title: "Heat", path: "lib_00000001/Films/Heat.mkv", updatedAt: "2024-01-02T00:00:00.000Z" },
    "file:lib_00000002/Shows/01.mkv": { position: 30, duration: 600, title: "Pilot", path: "lib_00000002/Shows/01.mkv", updatedAt: "2024-01-01T00:00:00.000Z" },
  };

  const response = await api(harness.base, "/api/library/resume", { user: ALICE });

  assert.equal(response.status, 200, "losing a library must not fail the whole request");
  const body = await response.json() as { items: Array<{ path: string }>; total: number };
  assert.deepEqual(body.items.map((item) => item.path), ["lib_00000002/Shows/01.mkv"], "the row from the library the caller lost is gone, the other stays");
  assert.equal(body.total, 1);
});

test("GET /api/library/favorites drops a row whose library the caller has lost", async (t) => {
  const harness = await mount([lost, granted]);
  t.after(harness.close);
  harness.data(ALICE).favorites = ["lib_00000001/Films/Heat.mkv", "lib_00000002/Shows/01.mkv"];

  const response = await api(harness.base, "/api/library/favorites", { user: ALICE });

  assert.equal(response.status, 200);
  const body = await response.json() as { items: Array<{ path: string }> };
  assert.deepEqual(body.items.map((item) => item.path), ["lib_00000002/Shows/01.mkv"]);
});

test("Continue watching neither shows nor asks an addon the caller may not use", async (t) => {
  addons.splice(0, addons.length,
    { key: "mine", manifestUrl: "https://mine.example/manifest.json", role: "both", enabled: true, globalSearch: true,
      addedAt: "", allowedUsers: [ALICE], manifest: { id: "mine", name: "Mine", version: "1" } } as AddonRecord,
    { key: "theirs", manifestUrl: "https://theirs.example/manifest.json", role: "both", enabled: true, globalSearch: true,
      addedAt: "", manifest: { id: "theirs", name: "Theirs", version: "1" } } as AddonRecord);
  t.after(() => { addons.splice(0, addons.length); });
  metaLookups = [];
  metaAnswer = { id: "tt1", type: "series", name: "Mine", videos: [{ season: 1, episode: 2, name: "Second" }] } as MetaItem;
  t.after(() => { metaAnswer = null; });

  const harness = await mount([granted]);
  t.after(harness.close);
  harness.data(ALICE).watchedSeries = {
    tt1: { name: "Mine", addonKey: "mine", season: 1, episode: 1, updatedAt: "2024-01-02T00:00:00.000Z" },
    tt2: { name: "Theirs", addonKey: "theirs", season: 1, episode: 1, updatedAt: "2024-01-01T00:00:00.000Z" },
  };

  const response = await api(harness.base, "/api/progress", { user: ALICE });
  assert.equal(response.status, 200);
  const body = await response.json() as Array<{ key: string }>;
  // Offering a next episode from an addon this account was never given is one thing; finding
  // out whether there is one, by asking that addon, is the leak itself.
  assert.deepEqual(metaLookups.map((entry) => entry.id), ["tt1"], "the addon the account may not use was contacted");
  assert.equal(metaLookups[0]?.viewer, ALICE, "the lookup merged every addon on the instance");
  assert.deepEqual(body.filter((row) => row.key?.startsWith("series:")).map((row) => row.key), ["series:tt1:1:2"]);
});

test("GET /api/progress drops the rows whose library the caller has lost", async (t) => {
  const harness = await mount([lost, granted]);
  t.after(harness.close);
  harness.data(ALICE).progress = {
    "file:lib_00000001/Films/Heat.mkv": { position: 60, duration: 600, title: "Heat", path: "lib_00000001/Films/Heat.mkv", updatedAt: "2024-01-02T00:00:00.000Z" },
    "file:lib_00000002/Shows/01.mkv": { position: 30, duration: 600, title: "Pilot", path: "lib_00000002/Shows/01.mkv", updatedAt: "2024-01-01T00:00:00.000Z" },
  };

  const response = await api(harness.base, "/api/progress", { user: ALICE });

  assert.equal(response.status, 200);
  const body = await response.json() as Array<{ path?: string }>;
  assert.deepEqual(body.map((row) => row.path), ["lib_00000002/Shows/01.mkv"], "the same row resume drops is dropped here too");

  const one = await api(harness.base, `/api/progress/${encodeURIComponent("file:lib_00000001/Films/Heat.mkv")}`, { user: ALICE });
  assert.equal(one.status, 200);
  assert.equal(await one.json(), null, "and one row read by key answers as if it were not stored");
});

const defaultDownloads = { sort: "order", direction: "asc", status: "", dateField: "createdAt", pageSize: 20 };

test("GET /api/views answers each caller with their own browsing chrome", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const patched = await api(harness.base, "/api/views", { method: "PATCH", user: ALICE, body: {
    libraries: { lib_0000000a: { sort: "size", order: "desc", favoritesOnly: true, view: "list" } },
  } });
  assert.equal(patched.status, 200);
  assert.deepEqual(await patched.json(), {
    libraries: { lib_0000000a: { sort: "size", order: "desc", favoritesOnly: true, view: "list" } },
    extras: {},
    downloads: defaultDownloads,
  });

  const alice = await (await api(harness.base, "/api/views", { user: ALICE })).json() as {
    libraries: Record<string, unknown>; downloads: unknown;
  };
  assert.deepEqual(alice.libraries, { lib_0000000a: { sort: "size", order: "desc", favoritesOnly: true, view: "list" } });

  const bob = await (await api(harness.base, "/api/views", { user: BOB })).json() as { libraries: unknown; downloads: unknown };
  assert.deepEqual(bob.libraries, {}, "Alice's library is not Bob's");
  assert.deepEqual(bob.downloads, defaultDownloads);
  assert.deepEqual(harness.data(BOB).views, undefined, "nothing is written to an account that never asked");
});

test("PATCH /api/views keeps one account's queue chrome out of another's", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const patched = await api(harness.base, "/api/views", { method: "PATCH", user: BOB, body: { downloads: { sort: "titleSort", pageSize: 50 } } });
  assert.equal(patched.status, 200);
  assert.deepEqual(await patched.json(), {
    libraries: {},
    extras: {},
    downloads: { ...defaultDownloads, sort: "titleSort", pageSize: 50 },
  });

  const alice = await api(harness.base, "/api/views", { user: ALICE });
  assert.deepEqual((await alice.json() as { downloads: unknown }).downloads, defaultDownloads);
});

test("/api/views is refused without a session, the way dataOf refuses", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const read = await api(harness.base, "/api/views");
  const write = await api(harness.base, "/api/views", { method: "PATCH", body: { libraries: { lib_0000000a: { sort: "size" } } } });

  assert.equal(read.status, 401);
  assert.equal(write.status, 401);
  assert.equal((await write.json() as { code?: string }).code, "AUTH_REQUIRED");
  assert.deepEqual(harness.data(ALICE).views, undefined);
});

test("PATCH /api/views stores nothing but the fields it knows", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const response = await api(harness.base, "/api/views", { method: "PATCH", user: ALICE, body: { query: "foo", from: "2026-01-01" } });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { libraries: {}, extras: {}, downloads: defaultDownloads });
  assert.deepEqual(harness.data(ALICE).views, { libraries: {}, extras: {}, downloads: defaultDownloads });
});
