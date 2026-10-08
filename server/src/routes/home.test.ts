import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { messageKeyOf } from "../errors.js";
import { parseLibraryPath, relativeWithin, type LibraryRecord } from "../libraries.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import type { BrowseItem } from "../library.js";
import { ResourceError } from "../media-resources.js";
import type { Store, UserPrefs } from "../store.js";
import { emptyUserData, type UserData, type UserRecord } from "../users.js";
import type { AddonRecord, MetaItem } from "../types.js";
import { registerPersonalRoutes, type PersonalDeps } from "./personal.js";
import { registerHomeRoutes, type CompletedJobView, type HomeDeps } from "./home.js";

type WatchlistEntry = { type: string; id: string; name: string; poster?: string; addedAt: string };
type StoredProgress = { position: number; duration: number; title: string; path?: string; poster?: string; addonKey?: string; series?: { id: string; name: string; season: number; episode: number }; updatedAt: string };
type WatchedMarker = { name: string; poster?: string; addonKey?: string; season: number; episode: number; updatedAt: string };
type MetaRecord = { type: string; id: string; name: string };

const ALICE = "usr_00000001";
const BOB = "usr_00000002";
const ADMIN = "usr_00000003";

const instancePrefs: UserPrefs = {
  uiLanguage: "en", audioLanguage: "en", subtitleLanguage: "en", downloadTitleLanguage: "ui",
  mergeByName: false, streamSort: "recommended", trackProgress: true, showResumeRow: true,
  catalogTileSize: "medium", libraryTileSize: "medium", catalogTileShape: "poster", libraryTileShape: "poster", homeTileShape: "wide",
};

interface Harness {
  base: string;
  /** The addons the two accounts are pitched against. */
  addons: AddonRecord[];
  /** The library bindings a resume row resolves its show id from. */
  records: Record<string, MetaRecord>;
  /** Keys `describeLibraryPath` must answer as gone. */
  missing: Set<string>;
  /** Keys `describeLibraryPath` must throw on, for the throwing-row case. */
  broken: Set<string>;
  /** The finished jobs `completedJobs()` hands out. */
  completed: CompletedJobView[];
  completedThrows: boolean;
  /** How long the fake metadata lookup waits before answering. */
  metaDelayMs: number;
  metaAnswer: MetaItem | null;
  /** Every series id the catalogue side was asked about, in order. */
  lookups: string[];
  data(user: string): UserData;
  close(): Promise<void>;
}

const library = (over: Partial<LibraryRecord> & { id: string; root: string }): LibraryRecord => ({
  name: over.id, type: "mixed", enabled: true, order: 0, addedAt: "", writeArtwork: false, ...over,
});

const fileItem = (relative: string): BrowseItem => ({
  kind: "file", path: relative, label: relative.slice(relative.lastIndexOf("/") + 1), season: null, episode: null, size: 0, modified: "2024-01-01T00:00:00.000Z",
});

const mount = async (options: { libraries?: LibraryRecord[]; deadlineMs?: number } = {}): Promise<Harness> => {
  const libraries = options.libraries ?? [];
  const addons: AddonRecord[] = [];
  const records: Record<string, MetaRecord> = {};
  const missing = new Set<string>();
  const broken = new Set<string>();
  const state: Harness = {
    base: "", addons, records, missing, broken, completed: [], completedThrows: false, metaDelayMs: 0, metaAnswer: null, lookups: [],
    data: () => { throw new Error("not mounted"); }, close: async () => undefined,
  };
  const users = new Map<string, UserData>([[ALICE, emptyUserData()], [BOB, emptyUserData()], [ADMIN, emptyUserData()]]);
  const roleOf = (id: string) => (id === ADMIN ? "admin" : "user");
  const userOf = (req?: express.Request) => {
    const id = req?.header("x-user");
    return id && users.has(id) ? id : undefined;
  };
  const personalDeps: PersonalDeps = {
    store: { libraries: () => libraries, addons: () => addons, settings: () => ({ ...instancePrefs }) } as unknown as Store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: (req) => {
      const id = userOf(req);
      return id ? { id, username: id, role: roleOf(id) } as unknown as UserRecord : undefined;
    },
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
    attachBrowseMeta: async (item) => ({ item, backfill: false }),
    cachedMeta: async (_type, id) => {
      state.lookups.push(id);
      if (state.metaDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.metaDelayMs));
      return state.metaAnswer;
    },
    dataOf: (req) => {
      const id = userOf(req);
      if (!id) throw new ResourceError(401, "AUTH_REQUIRED");
      return users.get(id)!;
    },
    describeLibraryPath: async (key) => {
      if (broken.has(key)) throw new Error("the library read blew up");
      if (missing.has(key)) return undefined;
      return fileItem(parseLibraryPath(key)?.relative ?? key);
    },
    libraryKey: (value) => value,
    libraryOfKey: (key) => {
      const parsed = parseLibraryPath(key)!;
      return { library: libraries.find((item) => item.id === parsed.libraryId)!, relative: parsed.relative };
    },
    locateFileArtwork: async () => undefined,
    locateFolderArtworkPair: async () => ({ poster: undefined, wide: undefined }),
    markersOf: (data) => data.watchedSeries as Record<string, WatchedMarker>,
    metaStore: { qualifiedMeta: () => records } as unknown as LibraryMetaStore,
    posterOf: (value) => (value ? String(value) : undefined),
    prefsOf: (req) => {
      const id = userOf(req);
      return { ...instancePrefs, ...(id ? users.get(id)!.prefs : {}) } as UserPrefs;
    },
    progressOf: (data) => data.progress as Record<string, StoredProgress>,
    scheduleFileArtwork: () => undefined,
    scheduleFolderArtwork: () => undefined,
    setLibraryFavorite: async () => undefined,
    thumbUrl: async () => undefined,
    updateData: async (req, mutate) => {
      const id = userOf(req);
      if (!id) throw new ResourceError(401, "AUTH_REQUIRED");
      mutate(users.get(id)!);
    },
    watchlistOf: (data) => data.watchlist as Record<string, WatchlistEntry>,
    wirePath: (key) => {
      const parsed = parseLibraryPath(key);
      return parsed && libraries.length === 1 ? relativeWithin(libraries[0]!.id, key) : key;
    },
  };
  const app = express();
  app.use(express.json());
  const personal = registerPersonalRoutes(app, personalDeps);
  const homeDeps: HomeDeps = {
    ...personalDeps,
    personal,
    completedJobs: () => { if (state.completedThrows) throw new Error("the queue is unavailable"); return state.completed; },
    describeLibraryPath: personalDeps.describeLibraryPath,
    locateFileArtwork: personalDeps.locateFileArtwork,
    locateFolderArtworkPair: personalDeps.locateFolderArtworkPair,
    thumbUrl: personalDeps.thumbUrl,
    scheduleFileArtwork: personalDeps.scheduleFileArtwork,
    scheduleFolderArtwork: personalDeps.scheduleFolderArtwork,
    wirePath: personalDeps.wirePath,
    dataOf: personalDeps.dataOf,
    homeLookupDeadlineMs: options.deadlineMs,
  };
  registerHomeRoutes(app, homeDeps);
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
  state.base = `http://127.0.0.1:${port}`;
  state.data = (user) => users.get(user)!;
  state.close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return state;
};

const api = (base: string, pathname: string, user?: string) =>
  fetch(`${base}${pathname}`, { headers: user ? { "x-user": user } : {} });

const allRows = async (harness: Harness, user: string) =>
  (await (await api(harness.base, "/api/home", user)).json() as { rows: Record<string, { status: string; items: Array<Record<string, unknown>>; hasMore: boolean; partial?: boolean }> }).rows;

test("GET /api/home answers with the whole envelope and private caching", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const response = await api(harness.base, "/api/home", ALICE);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json() as { generatedAt: string; rows: Record<string, unknown> };
  assert.equal(typeof body.generatedAt, "string");
  assert.deepEqual(Object.keys(body.rows).sort(), ["completed", "favorites", "resume"]);
});

test("GET /api/home is refused without a session, the way the personal routes refuse", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/home");
  assert.equal(response.status, 401);
  assert.equal((await response.json() as { code?: string }).code, "AUTH_REQUIRED");
});

test("each account sees only its own continue-watching and completed rows", async (t) => {
  const harness = await mount({ libraries: [library({ id: "lib_00000001", root: "/media", visibleTo: [ALICE, BOB] })] });
  t.after(harness.close);
  harness.data(ALICE).progress = { "movie:tt1": { position: 60, duration: 600, title: "Heat", updatedAt: "2024-01-02T00:00:00.000Z" } };
  harness.data(BOB).progress = { "movie:tt2": { position: 30, duration: 600, title: "Ronin", updatedAt: "2024-01-01T00:00:00.000Z" } };
  harness.completed = [
    { id: "a", title: "Alice film", ownerUserId: ALICE, status: "completed", target: "lib_00000001/A.mkv", completedAt: "2024-02-01T00:00:00.000Z" },
    { id: "b", title: "Bob film", ownerUserId: BOB, status: "completed", target: "lib_00000001/B.mkv", completedAt: "2024-02-02T00:00:00.000Z" },
  ];

  const alice = await allRows(harness, ALICE);
  assert.deepEqual(alice.resume!.items.map((item) => item.key), ["movie:tt1"]);
  assert.deepEqual(alice.completed!.items.map((item) => item.title), ["Alice film"]);

  const bob = await allRows(harness, BOB);
  assert.deepEqual(bob.resume!.items.map((item) => item.key), ["movie:tt2"]);
  assert.deepEqual(bob.completed!.items.map((item) => item.title), ["Bob film"]);
});

test("an administrator's completed row holds only their own jobs", async (t) => {
  const harness = await mount({ libraries: [library({ id: "lib_00000001", root: "/media" })] });
  t.after(harness.close);
  harness.completed = [
    { id: "a", title: "Alice film", ownerUserId: ALICE, status: "completed", target: "lib_00000001/A.mkv", completedAt: "2024-02-01T00:00:00.000Z" },
    { id: "b", title: "Admin film", ownerUserId: ADMIN, status: "completed", target: "lib_00000001/B.mkv", completedAt: "2024-02-02T00:00:00.000Z" },
  ];

  const admin = await allRows(harness, ADMIN);
  assert.deepEqual(admin.completed!.items.map((item) => item.title), ["Admin film"]);
});

test("a revoked library drops its resume, completed and favourite cards", async (t) => {
  const harness = await mount({
    libraries: [
      library({ id: "lib_00000001", root: "/media/films" }),
      library({ id: "lib_00000002", root: "/media/shows", visibleTo: [ALICE] }),
    ],
  });
  t.after(harness.close);
  harness.data(ALICE).favorites = ["lib_00000001/Films/Heat.mkv", "lib_00000002/Shows/01.mkv"];
  harness.data(ALICE).progress = {
    "file:lib_00000001/Films/Heat.mkv": { position: 60, duration: 600, title: "Heat", path: "lib_00000001/Films/Heat.mkv", updatedAt: "2024-01-02T00:00:00.000Z" },
    "file:lib_00000002/Shows/01.mkv": { position: 30, duration: 600, title: "Pilot", path: "lib_00000002/Shows/01.mkv", updatedAt: "2024-01-01T00:00:00.000Z" },
  };
  harness.completed = [
    { id: "a", title: "Lost", ownerUserId: ALICE, status: "completed", target: "lib_00000001/Lost.mkv", completedAt: "2024-02-02T00:00:00.000Z" },
    { id: "b", title: "Kept", ownerUserId: ALICE, status: "completed", target: "lib_00000002/Kept.mkv", completedAt: "2024-02-01T00:00:00.000Z" },
  ];

  const rows = await allRows(harness, ALICE);
  assert.deepEqual(rows.resume!.items.map((item) => item.key), ["file:lib_00000002/Shows/01.mkv"]);
  assert.deepEqual(rows.completed!.items.map((item) => item.title), ["Kept"]);
  assert.deepEqual(rows.favorites!.items.map((item) => item.path), ["lib_00000002/Shows/01.mkv"]);
});

test("a completed job whose library is switched off or whose file is gone yields no card", async (t) => {
  const harness = await mount({
    libraries: [
      library({ id: "lib_00000001", root: "/media/on", visibleTo: [ALICE] }),
      library({ id: "lib_00000002", root: "/media/off", enabled: false, visibleTo: [ALICE] }),
    ],
  });
  t.after(harness.close);
  harness.completed = [
    { id: "a", title: "On", ownerUserId: ALICE, status: "completed", target: "lib_00000001/A.mkv", completedAt: "2024-02-03T00:00:00.000Z" },
    { id: "b", title: "Disabled", ownerUserId: ALICE, status: "completed", target: "lib_00000002/B.mkv", completedAt: "2024-02-02T00:00:00.000Z" },
    { id: "c", title: "Gone", ownerUserId: ALICE, status: "completed", target: "lib_00000001/Gone.mkv", completedAt: "2024-02-01T00:00:00.000Z" },
  ];
  harness.missing.add("lib_00000001/Gone.mkv");

  const rows = await allRows(harness, ALICE);
  assert.deepEqual(rows.completed!.items.map((item) => item.title), ["On"]);
});

test("a stored catalogue row of a revoked addon is dropped and its marker is not asked about", async (t) => {
  const harness = await mount({ libraries: [library({ id: "lib_00000001", root: "/media" })] });
  t.after(harness.close);
  harness.addons.push(
    { key: "mine", manifestUrl: "https://mine/manifest.json", role: "both", enabled: true, globalSearch: true, addedAt: "", allowedUsers: [ALICE], manifest: { id: "mine", name: "Mine", version: "1" } } as AddonRecord,
    { key: "theirs", manifestUrl: "https://theirs/manifest.json", role: "both", enabled: true, globalSearch: true, addedAt: "", manifest: { id: "theirs", name: "Theirs", version: "1" } } as AddonRecord);
  harness.data(ALICE).progress = {
    "series:tt1:1:2": { position: 60, duration: 600, title: "Mine", addonKey: "mine", series: { id: "tt1", name: "Mine", season: 1, episode: 2 }, updatedAt: "2024-01-02T00:00:00.000Z" },
    "series:tt2:1:2": { position: 60, duration: 600, title: "Theirs", addonKey: "theirs", series: { id: "tt2", name: "Theirs", season: 1, episode: 2 }, updatedAt: "2024-01-01T00:00:00.000Z" },
  };
  harness.data(ALICE).watchedSeries = {
    tt1: { name: "Mine", addonKey: "mine", season: 1, episode: 2, updatedAt: "2024-01-02T00:00:00.000Z" },
    tt2: { name: "Theirs", addonKey: "theirs", season: 1, episode: 2, updatedAt: "2024-01-01T00:00:00.000Z" },
  };

  const rows = await allRows(harness, ALICE);
  assert.deepEqual(rows.resume!.items.map((item) => item.key), ["series:tt1:1:2"]);
  assert.deepEqual(harness.lookups, [], "neither show is owed a lookup while each has a stored row");
});

test("a marker whose addon the caller may not use is never looked up", async (t) => {
  const harness = await mount({ libraries: [library({ id: "lib_00000001", root: "/media" })] });
  t.after(harness.close);
  harness.addons.push(
    { key: "mine", manifestUrl: "https://mine/manifest.json", role: "both", enabled: true, globalSearch: true, addedAt: "", allowedUsers: [ALICE], manifest: { id: "mine", name: "Mine", version: "1" } } as AddonRecord,
    { key: "theirs", manifestUrl: "https://theirs/manifest.json", role: "both", enabled: true, globalSearch: true, addedAt: "", manifest: { id: "theirs", name: "Theirs", version: "1" } } as AddonRecord);
  harness.metaAnswer = { id: "tt1", type: "series", name: "Mine", videos: [{ season: 1, episode: 2, name: "Second" }] } as MetaItem;
  harness.data(ALICE).watchedSeries = {
    tt1: { name: "Mine", addonKey: "mine", season: 1, episode: 1, updatedAt: "2024-01-02T00:00:00.000Z" },
    tt2: { name: "Theirs", addonKey: "theirs", season: 1, episode: 1, updatedAt: "2024-01-01T00:00:00.000Z" },
  };

  const rows = await allRows(harness, ALICE);
  assert.deepEqual(harness.lookups, ["tt1"], "the addon the account may not use was contacted");
  assert.deepEqual(rows.resume!.items.map((item) => item.key), ["series:tt1:1:2"]);
});

test("a lookup that exceeds the deadline omits its card, marks the row partial and keeps the marker", async (t) => {
  const harness = await mount({ libraries: [library({ id: "lib_00000001", root: "/media" })], deadlineMs: 5 });
  t.after(harness.close);
  harness.metaDelayMs = 60;
  harness.metaAnswer = { id: "tt1", type: "series", name: "Mine", videos: [{ season: 1, episode: 2, name: "Second" }] } as MetaItem;
  harness.data(ALICE).watchedSeries = { tt1: { name: "Mine", season: 1, episode: 1, updatedAt: "2024-01-02T00:00:00.000Z" } };

  const rows = await allRows(harness, ALICE);
  assert.equal(rows.resume!.partial, true);
  assert.deepEqual(rows.resume!.items, []);
  assert.deepEqual(Object.keys(harness.data(ALICE).watchedSeries), ["tt1"], "a timeout never deletes the marker");
});

test("a marker whose show ran out of episodes is deleted, as it is today", async (t) => {
  const harness = await mount({ libraries: [library({ id: "lib_00000001", root: "/media" })] });
  t.after(harness.close);
  harness.metaAnswer = { id: "tt1", type: "series", name: "Mine", videos: [{ season: 1, episode: 1, name: "Only" }] } as MetaItem;
  harness.data(ALICE).watchedSeries = { tt1: { name: "Mine", season: 1, episode: 1, updatedAt: "2024-01-02T00:00:00.000Z" } };

  const rows = await allRows(harness, ALICE);
  assert.deepEqual(rows.resume!.items, []);
  assert.deepEqual(harness.data(ALICE).watchedSeries, {});
});

test("?rows= names which rows come back and an unknown name is ignored", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const some = await allRows(harness, ALICE);
  assert.deepEqual(Object.keys(some).sort(), ["completed", "favorites", "resume"]);

  const filtered = await (await api(harness.base, "/api/home?rows=resume,favorites", ALICE)).json() as { rows: Record<string, unknown> };
  assert.deepEqual(Object.keys(filtered.rows).sort(), ["favorites", "resume"]);

  const unknown = await (await api(harness.base, "/api/home?rows=nope", ALICE)).json() as { rows: Record<string, unknown> };
  assert.deepEqual(unknown.rows, {});
});

test("one row that throws leaves the others ok and carries no total", async (t) => {
  const harness = await mount({ libraries: [library({ id: "lib_00000001", root: "/media" })] });
  t.after(harness.close);
  harness.data(ALICE).progress = { "movie:tt1": { position: 60, duration: 600, title: "Heat", updatedAt: "2024-01-02T00:00:00.000Z" } };
  harness.completedThrows = true;

  const rows = await allRows(harness, ALICE);
  assert.equal(rows.resume!.status, "ok");
  assert.equal(rows.favorites!.status, "ok");
  assert.equal(rows.completed!.status, "error");
  assert.deepEqual(rows.completed!.items, []);
  assert.equal(rows.completed!.hasMore, false);
  for (const row of Object.values(rows)) assert.equal("total" in row, false);
});

test("every row is bounded to the row limit and reports hasMore", async (t) => {
  const harness = await mount({ libraries: [library({ id: "lib_00000001", root: "/media" })] });
  t.after(harness.close);
  harness.data(ALICE).progress = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [
    `series:tt${index}:1:2`,
    { position: 60, duration: 600, title: `Show ${index}`, series: { id: `tt${index}`, name: `Show ${index}`, season: 1, episode: 2 }, updatedAt: `2024-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z` },
  ]));

  const rows = await allRows(harness, ALICE);
  assert.equal(rows.resume!.items.length, 20);
  assert.equal(rows.resume!.hasMore, true);
});

test("a library file and a stored catalogue row for one show merge into a single card", async (t) => {
  const harness = await mount({ libraries: [library({ id: "lib_00000001", root: "/media", visibleTo: [ALICE] })] });
  t.after(harness.close);
  harness.records["lib_00000001/Shows"] = { type: "series", id: "tt1", name: "Show" };
  harness.data(ALICE).progress = {
    "file:lib_00000001/Shows/01.mkv": { position: 60, duration: 600, title: "Pilot", path: "lib_00000001/Shows/01.mkv", updatedAt: "2024-01-02T00:00:00.000Z" },
    "series:tt1:1:2": { position: 10, duration: 600, title: "Show · Second", addonKey: undefined, series: { id: "tt1", name: "Show", season: 1, episode: 2 }, updatedAt: "2024-01-01T00:00:00.000Z" },
  };

  const rows = await allRows(harness, ALICE);
  assert.equal(rows.resume!.items.length, 1);
  assert.equal(rows.resume!.items[0]!.kind, "resume-file");
  assert.deepEqual(rows.resume!.items[0]!.forgetKeys, ["file:Shows/01.mkv", "series:tt1:1:2"]);
});

test("a catalogue row of an addon whose Continue watching switch is off does not reach Home", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  harness.addons.push(
    { key: "quiet", manifestUrl: "https://quiet/manifest.json", role: "both", enabled: true, globalSearch: true, showInContinueWatching: false, addedAt: "", allowedUsers: [ALICE], manifest: { id: "quiet", name: "Quiet", version: "1" } } as AddonRecord,
    { key: "loud", manifestUrl: "https://loud/manifest.json", role: "both", enabled: true, globalSearch: true, showInContinueWatching: true, addedAt: "", allowedUsers: [ALICE], manifest: { id: "loud", name: "Loud", version: "1" } } as AddonRecord,
  );
  harness.data(ALICE).progress = {
    "movie:tt1": { position: 10, duration: 100, title: "Hidden", addonKey: "quiet", updatedAt: "2024-01-02T00:00:00.000Z" },
    "movie:tt2": { position: 10, duration: 100, title: "Shown", addonKey: "loud", updatedAt: "2024-01-01T00:00:00.000Z" },
    "movie:tt3": { position: 10, duration: 100, title: "No addon recorded", updatedAt: "2023-12-01T00:00:00.000Z" },
  };

  const rows = await allRows(harness, ALICE);
  assert.deepEqual(rows.resume!.items.map((item) => item.title).sort(), ["No addon recorded", "Shown"]);
});

test("favourites are read newest first and only as many as the row can use", async (t) => {
  const harness = await mount({ libraries: [library({ id: "lib_00000001", root: "/media/films", visibleTo: [ALICE] })] });
  t.after(harness.close);
  const keys = Array.from({ length: 45 }, (_, index) => `lib_00000001/Films/${String(index).padStart(2, "0")}.mkv`);
  harness.data(ALICE).favorites = keys;

  const rows = await allRows(harness, ALICE);
  assert.equal(rows.favorites!.status, "ok", JSON.stringify(rows.favorites));
  assert.equal(rows.favorites!.items.length, 20);
  assert.equal(rows.favorites!.hasMore, true);
  assert.equal(rows.favorites!.items[0]!.path, "Films/44.mkv");
});
