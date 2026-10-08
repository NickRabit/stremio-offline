import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { messageKeyOf } from "../errors.js";
import type { NewEpisode } from "../follows.js";
import { images } from "../images.js";
import { parseLibraryPath, relativeWithin, type LibraryRecord } from "../libraries.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import { LibrarySeenStore } from "../library-seen.js";
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
type MetaRecord = { type: string; id: string; name?: string; year?: string; season?: number; episode?: number; unmatched?: boolean };
type EpisodeRow = NewEpisode & { ownerUserId: string };
type SuggestionRow = { key: string; label: string; libraryId: string; library: string; path: string; suggestion: { name: string; year?: number; poster?: string } };

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
  /** The first-seen index the recent row reads; a test seeds it with `observe` or `add`. */
  seen: LibrarySeenStore;
  /** The episodes `newEpisodes()` hands out, each tagged with its owner. */
  episodes: EpisodeRow[];
  episodesThrows: boolean;
  /** Every owner the episodes row asked about, in order. */
  newEpisodesCalls: string[];
  /** The marker reader the episodes row handed to `newEpisodes()`. */
  watched?: (metaId: string) => { season: number; episode: number } | undefined;
  /** The pending proposals `suggestionRows()` hands out. */
  suggestions: SuggestionRow[];
  suggestionsThrow: boolean;
  /** How many times the confirm row read the proposals. */
  suggestionCalls: number;
  /** The clock the tonight seed reads. */
  now: number;
  /** How long the fake metadata lookup waits before answering. */
  metaDelayMs: number;
  metaAnswer: MetaItem | null;
  /** What `locateFileArtwork` answers; a thumbnail URL exists only when there is one. */
  artwork?: string;
  /** Every series id the catalogue side was asked about, in order. */
  lookups: string[];
  data(user: string): UserData;
  close(): Promise<void>;
}

const library = (over: Partial<LibraryRecord> & { id: string; root: string }): LibraryRecord => ({
  name: over.id, type: "mixed", enabled: true, order: 0, addedAt: "", writeArtwork: false, ...over,
});

const fileItem = (relative: string): BrowseItem => {
  const label = relative.slice(relative.lastIndexOf("/") + 1);
  const numbered = /S(\d+)E(\d+)/i.exec(label);
  return {
    kind: "file", path: relative, label,
    season: numbered ? Number(numbered[1]) : null, episode: numbered ? Number(numbered[2]) : null,
    size: 0, modified: "2024-01-01T00:00:00.000Z",
  };
};

const mount = async (options: { libraries?: LibraryRecord[]; deadlineMs?: number; now?: number } = {}): Promise<Harness> => {
  const libraries = options.libraries ?? [];
  const addons: AddonRecord[] = [];
  const records: Record<string, MetaRecord> = {};
  const missing = new Set<string>();
  const broken = new Set<string>();
  const seenDir = await mkdtemp(path.join(tmpdir(), "home-seen-"));
  const seen = new LibrarySeenStore(seenDir);
  await seen.load();
  const state: Harness = {
    base: "", addons, records, missing, broken, completed: [], completedThrows: false, seen,
    episodes: [], episodesThrows: false, newEpisodesCalls: [], suggestions: [], suggestionsThrow: false, suggestionCalls: 0,
    now: options.now ?? Date.parse("2026-01-15T12:00:00.000Z"),
    metaDelayMs: 0, metaAnswer: null, lookups: [],
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
    locateFileArtwork: async () => state.artwork,
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
    thumbUrl: async (_param, value, art, shape) => (art ? `thumb:${value}${shape === "wide" ? ":wide" : ""}` : undefined),
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
    newEpisodes: (ownerUserId, watched) => {
      if (state.episodesThrows) throw new Error("the follows are unavailable");
      state.newEpisodesCalls.push(ownerUserId);
      state.watched = watched;
      return state.episodes.filter((item) => item.ownerUserId === ownerUserId).map(({ ownerUserId: _owner, ...item }) => item);
    },
    describeLibraryPath: personalDeps.describeLibraryPath,
    locateFileArtwork: personalDeps.locateFileArtwork,
    locateFolderArtworkPair: personalDeps.locateFolderArtworkPair,
    thumbUrl: personalDeps.thumbUrl,
    scheduleFileArtwork: personalDeps.scheduleFileArtwork,
    scheduleFolderArtwork: personalDeps.scheduleFolderArtwork,
    wirePath: personalDeps.wirePath,
    dataOf: personalDeps.dataOf,
    markersOf: personalDeps.markersOf,
    progressOf: personalDeps.progressOf,
    metaStore: personalDeps.metaStore,
    seen,
    suggestionRows: async () => {
      state.suggestionCalls += 1;
      if (state.suggestionsThrow) throw new Error("the proposals are unavailable");
      return state.suggestions;
    },
    now: () => state.now,
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
    await rm(seenDir, { recursive: true, force: true });
  };
  return state;
};

const api = (base: string, pathname: string, user?: string) =>
  fetch(`${base}${pathname}`, { headers: user ? { "x-user": user } : {} });

interface HomeRowView { status: string; items: Array<Record<string, unknown>>; hasMore: boolean; partial?: boolean; total?: number; error?: unknown }

const allRows = async (harness: Harness, user: string): Promise<Record<string, HomeRowView>> =>
  (await (await api(harness.base, "/api/home", user)).json() as { rows: Record<string, HomeRowView> }).rows;

test("GET /api/home answers with the whole envelope and private caching", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const response = await api(harness.base, "/api/home", ALICE);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json() as { generatedAt: string; rows: Record<string, unknown> };
  assert.equal(typeof body.generatedAt, "string");
  assert.deepEqual(Object.keys(body.rows).sort(), ["completed", "confirm", "episodes", "favorites", "recent", "resume", "tonight"]);
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
  assert.deepEqual(Object.keys(some).sort(), ["completed", "confirm", "episodes", "favorites", "recent", "resume", "tonight"]);

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

test("a library switched off for Home drops its resume, completed and favourite cards, and switching it back on returns them", async (t) => {
  const quiet = library({ id: "lib_00000002", root: "/media/quiet", visibleTo: [ALICE], showOnHome: false });
  const harness = await mount({ libraries: [library({ id: "lib_00000001", root: "/media/loud", visibleTo: [ALICE] }), quiet] });
  t.after(harness.close);
  harness.data(ALICE).favorites = ["lib_00000001/Loud/Kept.mkv", "lib_00000002/Quiet/Hidden.mkv"];
  harness.data(ALICE).progress = {
    "file:lib_00000001/Loud/Kept.mkv": { position: 60, duration: 600, title: "Kept", path: "lib_00000001/Loud/Kept.mkv", updatedAt: "2024-01-02T00:00:00.000Z" },
    "file:lib_00000002/Quiet/Hidden.mkv": { position: 30, duration: 600, title: "Hidden", path: "lib_00000002/Quiet/Hidden.mkv", updatedAt: "2024-01-01T00:00:00.000Z" },
  };
  harness.completed = [
    { id: "a", title: "Kept", ownerUserId: ALICE, status: "completed", target: "lib_00000001/Kept.mkv", completedAt: "2024-02-01T00:00:00.000Z" },
    { id: "b", title: "Hidden", ownerUserId: ALICE, status: "completed", target: "lib_00000002/Hidden.mkv", completedAt: "2024-02-02T00:00:00.000Z" },
  ];

  const off = await allRows(harness, ALICE);
  assert.deepEqual(off.resume!.items.map((item) => item.key), ["file:lib_00000001/Loud/Kept.mkv"]);
  assert.deepEqual(off.completed!.items.map((item) => item.title), ["Kept"]);
  assert.deepEqual(off.favorites!.items.map((item) => item.path), ["lib_00000001/Loud/Kept.mkv"]);

  quiet.showOnHome = true;
  const on = await allRows(harness, ALICE);
  assert.deepEqual(on.resume!.items.map((item) => item.key).sort(), ["file:lib_00000001/Loud/Kept.mkv", "file:lib_00000002/Quiet/Hidden.mkv"]);
  assert.deepEqual(on.completed!.items.map((item) => item.title).sort(), ["Hidden", "Kept"]);
  assert.deepEqual(on.favorites!.items.map((item) => item.path).sort(), ["lib_00000001/Loud/Kept.mkv", "lib_00000002/Quiet/Hidden.mkv"]);
});

test("an addon switched off for Home drops its stored and pending catalogue cards, and switching it back on returns them", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const quiet = { key: "quiet", manifestUrl: "https://quiet/manifest.json", role: "both", enabled: true, globalSearch: true, showOnHome: false, addedAt: "", allowedUsers: [ALICE], manifest: { id: "quiet", name: "Quiet", version: "1" } } as AddonRecord;
  harness.addons.push(
    quiet,
    { key: "loud", manifestUrl: "https://loud/manifest.json", role: "both", enabled: true, globalSearch: true, showOnHome: true, addedAt: "", allowedUsers: [ALICE], manifest: { id: "loud", name: "Loud", version: "1" } } as AddonRecord,
  );
  harness.metaAnswer = { id: "ttQ", type: "series", name: "Quiet", videos: [{ season: 1, episode: 3, name: "Third" }] } as MetaItem;
  harness.data(ALICE).progress = {
    "movie:tt1": { position: 10, duration: 100, title: "Hidden row", addonKey: "quiet", updatedAt: "2024-01-05T00:00:00.000Z" },
    "movie:tt2": { position: 10, duration: 100, title: "Shown row", addonKey: "loud", updatedAt: "2024-01-04T00:00:00.000Z" },
    "movie:tt3": { position: 10, duration: 100, title: "No addon recorded", updatedAt: "2024-01-03T00:00:00.000Z" },
  };
  harness.data(ALICE).watchedSeries = {
    ttQ: { name: "Quiet show", addonKey: "quiet", season: 1, episode: 2, updatedAt: "2024-01-02T00:00:00.000Z" },
    ttL: { name: "Loud show", addonKey: "loud", season: 1, episode: 2, updatedAt: "2024-01-01T00:00:00.000Z" },
  };

  const off = await allRows(harness, ALICE);
  assert.deepEqual(off.resume!.items.map((item) => item.title).sort(), ["Loud show · Third", "No addon recorded", "Shown row"]);

  quiet.showOnHome = true;
  const on = await allRows(harness, ALICE);
  assert.deepEqual(on.resume!.items.map((item) => item.title).sort(), ["Hidden row", "Loud show · Third", "No addon recorded", "Quiet show · Third", "Shown row"]);
});

test("a library switched off for Home hides only its half of a merged show", async (t) => {
  const harness = await mount({ libraries: [library({ id: "lib_00000001", root: "/media", visibleTo: [ALICE], showOnHome: false })] });
  t.after(harness.close);
  harness.records["lib_00000001/Shows"] = { type: "series", id: "tt1", name: "Show" };
  harness.data(ALICE).progress = {
    "file:lib_00000001/Shows/01.mkv": { position: 60, duration: 600, title: "Pilot", path: "lib_00000001/Shows/01.mkv", updatedAt: "2024-01-02T00:00:00.000Z" },
    "series:tt1:1:2": { position: 10, duration: 600, title: "Show · Second", series: { id: "tt1", name: "Show", season: 1, episode: 2 }, updatedAt: "2024-01-01T00:00:00.000Z" },
  };

  const rows = await allRows(harness, ALICE);
  assert.equal(rows.resume!.items.length, 1);
  assert.equal(rows.resume!.items[0]!.kind, "resume-catalogue");
  assert.deepEqual(rows.resume!.items[0]!.forgetKeys, ["series:tt1:1:2"]);
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

test("a thumbnail is addressed by the wire path, which is the qualified one when libraries are several", async (t) => {
  const harness = await mount({
    libraries: [
      library({ id: "lib_00000001", root: "/media/films", visibleTo: [ALICE] }),
      library({ id: "lib_00000002", root: "/media/shows", visibleTo: [ALICE] }),
    ],
  });
  t.after(harness.close);
  harness.artwork = "art.jpg";
  harness.data(ALICE).favorites = ["lib_00000002/Shows/01.mkv"];
  harness.completed = [{ id: "a", title: "Kept", ownerUserId: ALICE, status: "completed", target: "lib_00000002/Kept.mkv", completedAt: "2024-02-01T00:00:00.000Z" }];

  const rows = await allRows(harness, ALICE);
  assert.equal(rows.completed!.items[0]!.poster, "thumb:lib_00000002/Kept.mkv");
  assert.equal(rows.completed!.items[0]!.wide, "thumb:lib_00000002/Kept.mkv:wide");
  assert.equal(rows.favorites!.items[0]!.poster, "thumb:lib_00000002/Shows/01.mkv");
});

test("new episodes are newest first, only the caller's, and the poster goes through the proxy", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const poster = "https://images.example/poster.jpg";
  harness.episodes = [
    { ownerUserId: ALICE, followId: "f1", type: "series", metaId: "tt1", name: "Show", poster, videoId: "e1", season: 1, episode: 1, title: "One", released: "2024-03-02T00:00:00.000Z" },
    { ownerUserId: ALICE, followId: "f1", type: "series", metaId: "tt1", name: "Show", poster, videoId: "e2", season: 1, episode: 2, title: "Two", released: "2024-03-01T00:00:00.000Z" },
    { ownerUserId: BOB, followId: "f2", type: "movie", metaId: "tt2", name: "Bob film", videoId: "v1", season: 1, episode: 1, released: "2024-03-05T00:00:00.000Z" },
  ];
  harness.data(ALICE).watchedSeries = { tt1: { name: "Show", season: 1, episode: 1, updatedAt: "2024-03-02T00:00:00.000Z" } };

  const rows = await allRows(harness, ALICE);
  assert.deepEqual(rows.episodes!.items.map((item) => item.key), ["episode:f1:e1", "episode:f1:e2"]);
  assert.equal(rows.episodes!.items[0]!.poster, images.proxied(poster));
  assert.deepEqual(harness.newEpisodesCalls, [ALICE]);
  assert.deepEqual(harness.watched?.("tt1"), { season: 1, episode: 1 }, "the row reads the caller's markers");
});

test("tonight draws the same cards for the same seed and other cards for a different shuffle", async (t) => {
  const harness = await mount({ libraries: [library({ id: "lib_00000001", root: "/media", visibleTo: [ALICE] })] });
  t.after(harness.close);
  for (let index = 0; index < 20; index += 1) {
    Object.assign(harness.records, { [`lib_00000001/Films/${String(index).padStart(2, "0")}`]: { type: "movie", id: `tt${index}`, name: `Film ${index}` } });
  }

  const first = await allRows(harness, ALICE);
  const again = await allRows(harness, ALICE);
  assert.equal(first.tonight!.items.length, 12);
  assert.deepEqual(first.tonight!.items.map((item) => item.key), again.tonight!.items.map((item) => item.key));
  const ordered = first.tonight!.items.map((item) => item.key);
  const shuffled = await (await api(harness.base, "/api/home?rows=tonight&shuffle=7", ALICE)).json() as { rows: Record<string, HomeRowView> };
  assert.notDeepEqual(shuffled.rows.tonight!.items.map((item) => item.key), ordered);
});

test("tonight skips a started title, a single episode and an unmatched row", async (t) => {
  const harness = await mount({ libraries: [library({ id: "lib_00000001", root: "/media", visibleTo: [ALICE] })] });
  t.after(harness.close);
  Object.assign(harness.records, {
    "lib_00000001/Films/Started": { type: "movie", id: "ttA", name: "Started" },
    "lib_00000001/Films/SeriesStarted": { type: "series", id: "ttB", name: "SeriesStarted" },
    "lib_00000001/Films/FolderStarted": { type: "movie", id: "ttC", name: "FolderStarted" },
    "lib_00000001/Films/Episode": { type: "series", id: "ttD", name: "Episode", season: 1, episode: 2 },
    "lib_00000001/Films/Unmatched": { type: "movie", id: "", unmatched: true },
    "lib_00000001/Films/Free": { type: "movie", id: "ttE", name: "Free" },
  });
  harness.data(ALICE).progress = {
    "movie:ttA": { position: 10, duration: 100, title: "Started", updatedAt: "2024-01-01T00:00:00.000Z" },
    "series:ttB:1:1": { position: 1, duration: 100, title: "SeriesStarted", series: { id: "ttB", name: "SeriesStarted", season: 1, episode: 1 }, updatedAt: "2024-01-01T00:00:00.000Z" },
    "file:lib_00000001/Films/FolderStarted/Copy.mkv": { position: 1, duration: 100, title: "FolderStarted", path: "lib_00000001/Films/FolderStarted/Copy.mkv", updatedAt: "2024-01-01T00:00:00.000Z" },
  };

  const rows = await allRows(harness, ALICE);
  assert.deepEqual(rows.tonight!.items.map((item) => item.label), ["Free"]);
  assert.equal(rows.tonight!.items[0]!.itemKind, "file");
  assert.equal(rows.tonight!.items[0]!.libraryId, "lib_00000001");
});

test("tonight draws nothing from a library switched off, disabled, away or not granted", async (t) => {
  const harness = await mount({
    libraries: [
      library({ id: "lib_00000001", root: "/a", visibleTo: [ALICE] }),
      library({ id: "lib_00000002", root: "/b", visibleTo: [ALICE], showOnHome: false }),
      library({ id: "lib_00000003", root: "/c", visibleTo: [ALICE], enabled: false }),
      library({ id: "lib_00000004", root: "/d", visibleTo: [ALICE], unreachable: true }),
      library({ id: "lib_00000005", root: "/e", visibleTo: [BOB] }),
    ],
  });
  t.after(harness.close);
  for (const [index, libraryId] of ["lib_00000001", "lib_00000002", "lib_00000003", "lib_00000004", "lib_00000005"].entries()) {
    Object.assign(harness.records, { [`${libraryId}/Films/Only`]: { type: "movie", id: `tt${index}`, name: `Only ${index}` } });
  }

  const rows = await allRows(harness, ALICE);
  assert.deepEqual(rows.tonight!.items.map((item) => item.libraryId), ["lib_00000001"]);
});

test("tonight replaces a file that vanished with a spare", async (t) => {
  const harness = await mount({ libraries: [library({ id: "lib_00000001", root: "/media", visibleTo: [ALICE] })] });
  t.after(harness.close);
  for (let index = 0; index < 20; index += 1) {
    Object.assign(harness.records, { [`lib_00000001/Films/${String(index).padStart(2, "0")}`]: { type: "movie", id: `tt${index}`, name: `Film ${index}` } });
  }

  const before = await allRows(harness, ALICE);
  const firstKey = String(before.tonight!.items[0]!.key);
  harness.missing.add(firstKey);
  const rows = await allRows(harness, ALICE);
  assert.equal(rows.tonight!.items.length, 12);
  assert.equal(rows.tonight!.items.some((item) => item.key === firstKey), false);
  const known = new Set(before.tonight!.items.map((item) => item.key));
  assert.equal(rows.tonight!.items.some((item) => !known.has(item.key)), true, "a spare stood in");
});

test("two accounts get their own tonight picks on the same day", async (t) => {
  const harness = await mount({ libraries: [library({ id: "lib_00000001", root: "/media", visibleTo: [ALICE, BOB] })] });
  t.after(harness.close);
  for (let index = 0; index < 20; index += 1) {
    Object.assign(harness.records, { [`lib_00000001/Films/${String(index).padStart(2, "0")}`]: { type: "movie", id: `tt${index}`, name: `Film ${index}` } });
  }

  const alice = await allRows(harness, ALICE);
  const bob = await allRows(harness, BOB);
  assert.equal(alice.tonight!.items.length, 12);
  assert.notDeepEqual(alice.tonight!.items.map((item) => item.key), bob.tonight!.items.map((item) => item.key));
});

test("an administrator's confirm row lists the proposals sorted by label with an exact total", async (t) => {
  const harness = await mount({ libraries: [library({ id: "lib_00000001", root: "/media" })] });
  t.after(harness.close);
  harness.suggestions = [
    { key: "B", label: "Beta", libraryId: "lib_00000001", library: "Media", path: "B", suggestion: { name: "Beta film", year: 2001, poster: "img_b" } },
    { key: "A", label: "Alpha", libraryId: "lib_00000001", library: "Media", path: "A", suggestion: { name: "Alpha film", year: 1999 } },
  ];

  const rows = await allRows(harness, ADMIN);
  assert.equal(rows.confirm!.total, 2);
  const items = rows.confirm!.items as Array<{ kind: string; label: string; candidate: { name: string; year?: string; poster?: string } }>;
  assert.deepEqual(items.map((item) => item.label), ["Alpha", "Beta"]);
  assert.deepEqual(items.map((item) => item.kind), ["confirm", "confirm"]);
  assert.deepEqual(items.map((item) => item.candidate.name), ["Alpha film", "Beta film"]);
  assert.deepEqual(items.map((item) => item.candidate.year), ["1999", "2001"]);
  assert.deepEqual(items.map((item) => item.candidate.poster), [undefined, "img_b"]);
  assert.equal(harness.suggestionCalls, 1);
  for (const id of ["episodes", "favorites", "recent", "resume", "tonight"]) assert.equal("total" in rows[id]!, false, `${id} carries no total`);
});

test("an ordinary account's confirm row is empty and the proposals are never read", async (t) => {
  const harness = await mount({ libraries: [library({ id: "lib_00000001", root: "/media", visibleTo: [ALICE] })] });
  t.after(harness.close);
  harness.suggestions = [{ key: "A", label: "Alpha", libraryId: "lib_00000001", library: "Media", path: "A", suggestion: { name: "Alpha" } }];

  const rows = await allRows(harness, ALICE);
  assert.deepEqual(rows.confirm, { status: "ok", items: [], hasMore: false });
  assert.equal(harness.suggestionCalls, 0);
});

test("the confirm row drops a proposal whose library is switched off for Home", async (t) => {
  const harness = await mount({
    libraries: [
      library({ id: "lib_00000001", root: "/a" }),
      library({ id: "lib_00000002", root: "/b", showOnHome: false }),
    ],
  });
  t.after(harness.close);
  harness.suggestions = [
    { key: "A", label: "Alpha", libraryId: "lib_00000001", library: "A", path: "A", suggestion: { name: "Alpha" } },
    { key: "B", label: "Beta", libraryId: "lib_00000002", library: "B", path: "B", suggestion: { name: "Beta" } },
  ];

  const rows = await allRows(harness, ADMIN);
  assert.deepEqual(rows.confirm!.items.map((item) => item.label), ["Alpha"]);
  assert.equal(rows.confirm!.total, 1);
});

test("a throwing episodes source leaves the other rows ok", async (t) => {
  const harness = await mount({ libraries: [library({ id: "lib_00000001", root: "/media", visibleTo: [ALICE] })] });
  t.after(harness.close);
  harness.episodesThrows = true;

  const rows = await allRows(harness, ALICE);
  assert.equal(rows.episodes!.status, "error");
  assert.deepEqual(rows.episodes!.items, []);
  assert.equal(rows.tonight!.status, "ok");
  assert.equal(rows.resume!.status, "ok");
  assert.equal(rows.favorites!.status, "ok");
  assert.equal(rows.completed!.status, "ok");
});

test("a throwing proposals source leaves the other rows ok", async (t) => {
  const harness = await mount({ libraries: [library({ id: "lib_00000001", root: "/media" })] });
  t.after(harness.close);
  harness.suggestionsThrow = true;

  const rows = await allRows(harness, ADMIN);
  assert.equal(rows.confirm!.status, "error");
  assert.deepEqual(rows.confirm!.items, []);
  assert.equal(rows.episodes!.status, "ok");
  assert.equal(rows.tonight!.status, "ok");
});

const walk = (relative: string, size: number, modified: string) => ({ relative, size, modified });

test("the recent row shows a file the app met after the baseline, and never a baseline file", async (t) => {
  const harness = await mount({ libraries: [library({ id: "lib_00000001", root: "/media", visibleTo: [ALICE] })] });
  t.after(harness.close);
  harness.seen.observe("lib_00000001", [walk("Films/Old.mkv", 10, "2024-01-01T00:00:00.000Z")], new Date("2024-01-01T00:00:00.000Z"));
  harness.seen.observe("lib_00000001", [
    walk("Films/Old.mkv", 10, "2024-01-01T00:00:00.000Z"),
    walk("Films/New.mkv", 20, "2024-02-01T00:00:00.000Z"),
  ], new Date("2024-02-01T00:00:00.000Z"));

  const rows = await allRows(harness, ALICE);
  assert.equal(rows.recent!.status, "ok");
  assert.deepEqual(rows.recent!.items.map((item) => item.key), ["lib_00000001/Films/New.mkv"], "the baseline file is left out");
  const card = rows.recent!.items[0]!;
  assert.equal(card.label, "New.mkv");
  assert.equal(card.addedAt, "2024-02-01T00:00:00.000Z");
  assert.equal(card.libraryId, "lib_00000001");
});

test("episodes of one bound show collapse into the show's card, kept on the newest file", async (t) => {
  const harness = await mount({ libraries: [library({ id: "lib_00000001", root: "/media", visibleTo: [ALICE] })] });
  t.after(harness.close);
  harness.records["lib_00000001/Shows/Show"] = { type: "series", id: "tt1", name: "Show" };
  harness.seen.observe("lib_00000001", [], new Date("2024-01-01T00:00:00.000Z"));
  harness.seen.observe("lib_00000001", [walk("Shows/Show/Show.S01E01.mkv", 10, "2024-01-02T00:00:00.000Z")], new Date("2024-02-01T00:00:00.000Z"));
  harness.seen.observe("lib_00000001", [
    walk("Shows/Show/Show.S01E01.mkv", 10, "2024-01-02T00:00:00.000Z"),
    walk("Shows/Show/Show.S01E02.mkv", 11, "2024-01-03T00:00:00.000Z"),
  ], new Date("2024-02-02T00:00:00.000Z"));

  const rows = await allRows(harness, ALICE);
  assert.equal(rows.recent!.items.length, 1, "the show is one card");
  const card = rows.recent!.items[0]!;
  assert.equal(card.key, "lib_00000001/Shows/Show/Show.S01E02.mkv", "the newest episode is the card");
  assert.equal(card.label, "Show");
  assert.equal(card.season, 1);
  assert.equal(card.episode, 2);
  assert.equal(card.addedAt, "2024-02-02T00:00:00.000Z");
});

test("the recent row draws nothing from a library off Home, disabled, away or not granted", async (t) => {
  const ids = ["lib_00000001", "lib_00000002", "lib_00000003", "lib_00000004", "lib_00000005"];
  const harness = await mount({
    libraries: [
      library({ id: ids[0]!, root: "/a", visibleTo: [ALICE] }),
      library({ id: ids[1]!, root: "/b", visibleTo: [ALICE], showOnHome: false }),
      library({ id: ids[2]!, root: "/c", visibleTo: [ALICE], enabled: false }),
      library({ id: ids[3]!, root: "/d", visibleTo: [ALICE], unreachable: true }),
      library({ id: ids[4]!, root: "/e", visibleTo: [BOB] }),
    ],
  });
  t.after(harness.close);
  for (const [index, id] of ids.entries()) {
    harness.seen.observe(id, [], new Date("2024-01-01T00:00:00.000Z"));
    harness.seen.observe(id, [walk("Only.mkv", index + 1, "2024-02-01T00:00:00.000Z")], new Date("2024-02-01T00:00:00.000Z"));
  }

  const rows = await allRows(harness, ALICE);
  assert.deepEqual(rows.recent!.items.map((item) => item.libraryId), [ids[0]!]);
});

test("the recent row drops a file that vanished after the walk", async (t) => {
  const harness = await mount({ libraries: [library({ id: "lib_00000001", root: "/media", visibleTo: [ALICE] })] });
  t.after(harness.close);
  harness.seen.observe("lib_00000001", [], new Date("2024-01-01T00:00:00.000Z"));
  harness.seen.observe("lib_00000001", [
    walk("Films/Kept.mkv", 10, "2024-02-01T00:00:00.000Z"),
    walk("Films/Gone.mkv", 11, "2024-02-02T00:00:00.000Z"),
  ], new Date("2024-02-02T00:00:00.000Z"));
  harness.missing.add("lib_00000001/Films/Gone.mkv");

  const rows = await allRows(harness, ALICE);
  assert.deepEqual(rows.recent!.items.map((item) => item.key), ["lib_00000001/Films/Kept.mkv"]);
});

test("the recent row is bounded to twenty and reports hasMore", async (t) => {
  const harness = await mount({ libraries: [library({ id: "lib_00000001", root: "/media", visibleTo: [ALICE] })] });
  t.after(harness.close);
  harness.seen.observe("lib_00000001", [], new Date("2024-01-01T00:00:00.000Z"));
  const files = Array.from({ length: 25 }, (_, index) => walk(`Films/${String(index).padStart(2, "0")}.mkv`, index + 1, `2024-02-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`));
  harness.seen.observe("lib_00000001", files, new Date("2024-03-01T00:00:00.000Z"));

  const rows = await allRows(harness, ALICE);
  assert.equal(rows.recent!.items.length, 20);
  assert.equal(rows.recent!.hasMore, true);
  assert.equal(rows.recent!.items[0]!.addedAt, "2024-03-01T00:00:00.000Z");
});
