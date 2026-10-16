import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { messageKeyOf } from "../errors.js";
import type { RemoteHomeCard } from "../home.js";
import { parseLibraryPath, type LibraryRecord } from "../libraries.js";
import type { LibraryMetaRecord, TitleUnit } from "../library-match.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import { ResourceError } from "../media-resources.js";
import type { Store, UserPrefs } from "../store.js";
import { emptyUserData, type UserData, type UserRecord } from "../users.js";
import type { MetaItem, AddonRecord } from "../types.js";
import { registerPersonalRoutes, type PersonalDeps } from "./personal.js";

type WatchlistEntry = { type: string; id: string; name: string; poster?: string; addedAt: string };
type StoredProgress = { position: number; duration: number; title: string; path?: string; poster?: string; addonKey?: string; series?: { id: string; name: string; season: number; episode: number }; remote?: { libraryId: string; itemId: string; mediaSourceId: string }; stableKey?: string; updatedAt: string };
type WatchedMarker = { name: string; poster?: string; addonKey?: string; season: number; episode: number; updatedAt: string };

const ALICE = "usr_00000001";
const BOB = "usr_00000002";

/** The instance says tracking is on in every test; only a person's own flag may switch it off. */
const instancePrefs: UserPrefs = {
  uiLanguage: "en", audioLanguage: "en", subtitleLanguage: "en", downloadTitleLanguage: "ui",
  mergeByName: false, streamSort: "recommended", trackProgress: true, showResumeRow: true,
  tileSize: "medium", catalogTileShape: "poster", libraryTileShape: "poster", favoritesTileShape: "poster", resumeTileShape: "poster", followingTileShape: "poster", homeTileShape: "wide",
  startView: "catalog",
  libraryShelf: "resume",
};

interface Harness {
  base: string;
  /** Whose preferences each `prefsOf` call asked for. */
  prefsAsked: string[];
  favoriteCalls: Array<{ relative: string; wanted: boolean; userId: string | undefined }>;
  /** The library bindings the progress routes resolve a file's title through. */
  records: Record<string, LibraryMetaRecord>;
  /** The title units the library walk found. */
  units: TitleUnit[];
  /** The media-server connections and libraries a written position may name. */
  mediaConnections: Array<Record<string, unknown>>;
  remoteLibraries: Array<Record<string, unknown>>;
  /** Keys `describeLibraryPath` must throw on, the way a library that is gone does. */
  broken: Set<string>;
  /** The media-server stars the card projection hands out, and every page it was asked for. */
  remoteCards: RemoteHomeCard[];
  remoteCalls: Array<{ filter: string; skip: number; limit: number }>;
  /** Every media-server star the account cleared, and every title whose position was forgotten. */
  clearedTitles: string[];
  forgottenTitles: string[][];
  /** How many writes reached `updateData`, so a single-operation forget can be counted. */
  updates: number;
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
  const records: Record<string, LibraryMetaRecord> = {};
  const units: TitleUnit[] = [];
  const broken = new Set<string>();
  const mediaConnections: Array<Record<string, unknown>> = [];
  const remoteLibraries: Array<Record<string, unknown>> = [];
  const remoteCards: RemoteHomeCard[] = [];
  const remoteCalls: Harness["remoteCalls"] = [];
  const clearedTitles: string[] = [];
  const forgottenTitles: string[][] = [];
  let updates = 0;
  const userOf = (req?: express.Request) => {
    const id = req?.header("x-user");
    return id && users.has(id) ? id : undefined;
  };
  const deps: PersonalDeps = {
    store: {
      libraries: () => libraries, addons: () => addons, settings: () => ({ ...instancePrefs }),
      mediaConnections: () => mediaConnections, remoteLibraries: () => remoteLibraries,
    } as unknown as Store,
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
    attachBrowseMeta: async (item) => ({ item, backfill: false }),
    cachedMeta: async (type, id, language, viewer) => { metaLookups.push({ type, id, viewer: viewer?.id }); return metaAnswer; },
    dataOf: (req) => {
      const id = userOf(req);
      if (!id) throw new ResourceError(401, "AUTH_REQUIRED");
      return users.get(id)!;
    },
    describeLibraryPath: async (key) => {
      if (broken.has(key)) throw new Error("the library is gone");
      const relative = parseLibraryPath(key)?.relative ?? key;
      const label = relative.slice(relative.lastIndexOf("/") + 1);
      const numbered = /S(\d+)E(\d+)/i.exec(label);
      return {
        kind: "file", path: relative, label,
        season: numbered ? Number(numbered[1]) : null, episode: numbered ? Number(numbered[2]) : null,
        size: 0, modified: "2024-01-01T00:00:00.000Z",
      };
    },
    libraryKey: (value) => value,
    libraryOfKey: (key) => {
      const parsed = parseLibraryPath(key)!;
      return { library: libraries.find((item) => item.id === parsed.libraryId)!, relative: parsed.relative };
    },
    libraryUnits: async () => units,
    locateFileArtwork: async () => undefined,
    locateFolderArtworkPair: async () => ({ poster: undefined, wide: undefined }),
    markersOf: (data) => data.watchedSeries as Record<string, WatchedMarker>,
    metaStore: { qualifiedMeta: () => records } as unknown as LibraryMetaStore,
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
      updates += 1;
      mutate(users.get(id)!);
    },
    watchlistOf: (data) => data.watchlist as Record<string, WatchlistEntry>,
    remotePersonal: {
      clearTitleFavorites: (_data: unknown, typeId: string) => { clearedTitles.push(typeId); },
      forgetTitlePositions: async (_userId: string | undefined, keys: ReadonlySet<string>) => { forgottenTitles.push([...keys]); },
      cards: async (_authority: unknown, options: { filter: string; skip?: number; limit?: number }) => {
        remoteCalls.push({ filter: options.filter, skip: options.skip ?? 0, limit: options.limit ?? 60 });
        const skip = options.skip ?? 0;
        const limit = options.limit ?? 60;
        return { items: remoteCards.slice(skip, skip + limit), total: remoteCards.length };
      },
      assertCardsCurrent: () => undefined,
    } as unknown as PersonalDeps["remotePersonal"],
    authorityOf: () => ({ actor: { id: ALICE, secret: "unused" }, assertCurrent: () => undefined }),
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
    records,
    units,
    broken,
    mediaConnections,
    remoteLibraries,
    remoteCards,
    remoteCalls,
    clearedTitles,
    forgottenTitles,
    get updates() { return updates; },
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

const SOURCE_KEY = "t:0123456789abcdef01234567";

test("POST /api/progress keeps the source the position was played from, and every read hands it back", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const response = await api(harness.base, "/api/progress", {
    method: "POST", user: ALICE,
    body: { key: FILM_KEY, position: 120, duration: 3600, title: "Heat", stableKey: SOURCE_KEY },
  });

  assert.equal(response.status, 204);
  assert.equal((harness.data(ALICE).progress[FILM_KEY] as StoredProgress).stableKey, SOURCE_KEY);

  const read = await api(harness.base, `/api/progress/${encodeURIComponent(FILM_KEY)}`, { user: ALICE });
  assert.equal(read.status, 200);
  assert.equal(((await read.json()) as StoredProgress).stableKey, SOURCE_KEY);
  const listed = await (await api(harness.base, "/api/progress", { user: ALICE })).json() as StoredProgress[];
  assert.equal(listed[0]!.stableKey, SOURCE_KEY);
});

test("a write that names another source stops claiming the file the title used to play from", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  harness.data(ALICE).progress = {
    [FILM_KEY]: {
      position: 60, duration: 3600, title: "Heat", path: FILM_FILE,
      stableKey: `f:${"a".repeat(24)}`, updatedAt: "2024-01-01T00:00:00.000Z",
    },
  };

  const response = await api(harness.base, "/api/progress", {
    method: "POST", user: ALICE,
    body: { key: FILM_KEY, position: 120, duration: 3600, title: "Heat", stableKey: SOURCE_KEY },
  });

  assert.equal(response.status, 204);
  const stored = harness.data(ALICE).progress[FILM_KEY] as StoredProgress;
  assert.equal(stored.stableKey, SOURCE_KEY, "the row now names the source it is played from");
  assert.equal(stored.path, undefined, "and no longer claims the library file it came from");
});

test("an invalid stable key stores none and leaves the write as it was", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  harness.data(ALICE).progress = {
    [FILM_KEY]: {
      position: 60, duration: 3600, title: "Heat", path: FILM_FILE,
      stableKey: SOURCE_KEY, updatedAt: "2024-01-01T00:00:00.000Z",
    },
  };

  await api(harness.base, "/api/progress", {
    method: "POST", user: ALICE,
    body: { key: FILM_KEY, position: 120, duration: 3600, title: "Heat", stableKey: `x:${"a".repeat(24)}` },
  });
  const kept = harness.data(ALICE).progress[FILM_KEY] as StoredProgress;
  assert.equal(kept.stableKey, SOURCE_KEY, "the source the row already named is kept");
  assert.equal(kept.path, FILM_FILE, "and the path it held stays, exactly as before");

  await api(harness.base, "/api/progress", {
    method: "POST", user: ALICE,
    body: { key: "movie:tt10", position: 120, duration: 3600, title: "Ronin", stableKey: "not-a-handle" },
  });
  const fresh = harness.data(ALICE).progress["movie:tt10"] as StoredProgress;
  assert.equal("stableKey" in fresh, false, "a malformed handle is never stored");
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

test("POST /api/progress/forget removes several keys and their markers in one write", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  harness.data(ALICE).progress = {
    "series:tt1:1:2": { position: 60, duration: 600, title: "Pilot", series: { id: "tt1", name: "Show", season: 1, episode: 2 }, updatedAt: "2024-01-01T00:00:00.000Z" },
    "file:lib_00000002/Shows/01.mkv": { position: 30, duration: 600, title: "Pilot", path: "lib_00000002/Shows/01.mkv", updatedAt: "2024-01-02T00:00:00.000Z" },
    "movie:tt9": { position: 90, duration: 600, title: "Ronin", updatedAt: "2024-01-03T00:00:00.000Z" },
  };
  harness.data(ALICE).watchedSeries = { tt1: { name: "Show", season: 1, episode: 3, updatedAt: "2024-01-04T00:00:00.000Z" } };

  const response = await api(harness.base, "/api/progress/forget", {
    method: "POST", user: ALICE,
    body: { keys: ["series:tt1:1:2", "file:lib_00000002/Shows/01.mkv"] },
  });

  assert.equal(response.status, 204);
  assert.deepEqual(Object.keys(harness.data(ALICE).progress), ["movie:tt9"], "the unrelated movie stays");
  assert.deepEqual(harness.data(ALICE).watchedSeries, {}, "the marker the forgotten show implies goes too");
  assert.equal(harness.updates, 1, "every key is forgotten inside one updateData");
  assert.deepEqual(harness.data(BOB).progress, {}, "and the write is the caller's own");
});

test("POST /api/progress/forget ignores a key that is not stored", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  harness.data(ALICE).progress = { "movie:tt9": { position: 90, duration: 600, title: "Ronin", updatedAt: "2024-01-03T00:00:00.000Z" } };

  const response = await api(harness.base, "/api/progress/forget", { method: "POST", user: ALICE, body: { keys: ["movie:absent"] } });

  assert.equal(response.status, 204);
  assert.deepEqual(Object.keys(harness.data(ALICE).progress), ["movie:tt9"]);
});

test("POST /api/progress/forget refuses more than fifty keys and does nothing for an empty list", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const tooMany = await api(harness.base, "/api/progress/forget", {
    method: "POST", user: ALICE, body: { keys: Array.from({ length: 51 }, (_, index) => `movie:t${index}`) },
  });
  assert.equal(tooMany.status, 400);
  assert.equal((await tooMany.json() as { messageKey?: string }).messageKey, "err.invalidRequest");

  const none = await api(harness.base, "/api/progress/forget", { method: "POST", user: ALICE, body: { keys: [] } });
  assert.equal(none.status, 204);
  assert.equal(harness.updates, 0, "an empty list is a no-op, not a write");
});

const FILM_FILE = "lib_00000001/Films/Heat/Heat.mkv";
const FILM_KEY = "movie:tt9";
/** The library the bound-file tests play from; both accounts may see it. */
const filmLibrary: LibraryRecord = {
  id: "lib_00000001", name: "Films", type: "mixed", root: "/media/films",
  enabled: true, order: 0, addedAt: "", writeArtwork: false, visibleTo: [ALICE, BOB],
};

/** Binds the film's folder the way the library scan does, so a file under it is its title. */
const bindFilm = (harness: Harness): void => {
  harness.records["lib_00000001/Films/Heat"] = { type: "movie", id: "tt9", name: "Heat" };
  harness.units.push({ key: "lib_00000001/Films/Heat", kind: "movie", relative: "Films/Heat", sampleFiles: [FILM_FILE] });
};

const SHOW_FILE = "lib_00000001/Shows/Dark/S01/Dark.S01E02.mkv";
/** One show whose episode file the harness knows, so a starred episode can stand for its show. */
const bindShow = (harness: Harness): void => {
  harness.records["lib_00000001/Shows/Dark"] = { type: "series", id: "tt5", name: "Dark" };
  harness.units.push({ key: "lib_00000001/Shows/Dark", kind: "series", relative: "Shows/Dark", sampleFiles: [SHOW_FILE] });
};

const legacyFilmRow = (position: number, updatedAt: string): StoredProgress =>
  ({ position, duration: 3600, title: "Heat", path: FILM_FILE, updatedAt });

const readProgress = async (harness: Harness, key: string, user = ALICE): Promise<StoredProgress | null> =>
  (await (await api(harness.base, `/api/progress/${encodeURIComponent(key)}`, { user })).json()) as StoredProgress | null;

test("a bound file's position is stored as its title and read back under both keys", async (t) => {
  const harness = await mount([filmLibrary]);
  t.after(harness.close);
  bindFilm(harness);

  const response = await api(harness.base, "/api/progress", {
    method: "POST", user: ALICE,
    body: { key: `file:${FILM_FILE}`, path: FILM_FILE, title: "Heat", position: 120, duration: 3600 },
  });

  assert.equal(response.status, 204);
  assert.deepEqual(Object.keys(harness.data(ALICE).progress), [FILM_KEY], "one title keeps one row");
  const stored = harness.data(ALICE).progress[FILM_KEY] as StoredProgress;
  assert.equal(stored.position, 120);
  assert.equal(stored.path, FILM_FILE, "the title's row keeps the file it was played from");
  assert.equal((await readProgress(harness, `file:${FILM_FILE}`))?.position, 120, "the file key answers the title's row");
  assert.equal((await readProgress(harness, FILM_KEY))?.position, 120);
});

test("a legacy file row is read as its title, and the newest of the two answers", async (t) => {
  const harness = await mount([filmLibrary]);
  t.after(harness.close);
  bindFilm(harness);
  const fileKey = `file:${FILM_FILE}`;

  harness.data(ALICE).progress = { [fileKey]: legacyFilmRow(10, "2024-01-01T00:00:00.000Z") };
  assert.equal((await readProgress(harness, FILM_KEY))?.position, 10, "a row stored before this change is the title's too");

  harness.data(ALICE).progress[FILM_KEY] = legacyFilmRow(20, "2024-01-02T00:00:00.000Z");
  assert.equal((await readProgress(harness, FILM_KEY))?.position, 20, "the newer title row wins");

  harness.data(ALICE).progress[fileKey] = legacyFilmRow(30, "2024-01-03T00:00:00.000Z");
  assert.equal((await readProgress(harness, FILM_KEY))?.position, 30, "a newer legacy row wins too");
});

test("playing a title the catalogue way leaves no legacy file row behind", async (t) => {
  const harness = await mount([filmLibrary]);
  t.after(harness.close);
  bindFilm(harness);
  harness.data(ALICE).progress = { [`file:${FILM_FILE}`]: legacyFilmRow(10, "2024-01-01T00:00:00.000Z") };

  const response = await api(harness.base, "/api/progress", {
    method: "POST", user: ALICE, body: { key: FILM_KEY, title: "Heat", position: 40, duration: 3600 },
  });

  assert.equal(response.status, 204);
  assert.deepEqual(Object.keys(harness.data(ALICE).progress), [FILM_KEY]);
  assert.equal((harness.data(ALICE).progress[FILM_KEY] as StoredProgress).position, 40);
});

test("a file key reads and forgets a title row that names it", async (t) => {
  const harness = await mount([filmLibrary]);
  t.after(harness.close);
  const file = "lib_00000001/Shows/Dark/S01/Dark.S01E01.mkv";
  const fileKey = `file:${file}`;
  harness.records["lib_00000001/Shows/Dark"] = { type: "series", id: "tt5", name: "Dark" };
  harness.units.push({ key: "lib_00000001/Shows/Dark", kind: "series", relative: "Shows/Dark", sampleFiles: [file] });
  // A row keeps the key it was written with when the file moves to another season; only its
  // `path` says which file it came from, and that is what a read through the file key finds.
  harness.data(ALICE).progress = { "series:tt5:3:9": { position: 30, duration: 100, title: "Dark", path: file, updatedAt: "2024-01-03T00:00:00.000Z" } };

  assert.equal((await readProgress(harness, fileKey))?.position, 30, "the row that names the file answers it");

  const removed = await api(harness.base, `/api/progress/${encodeURIComponent(fileKey)}`, { method: "DELETE", user: ALICE });
  assert.equal(removed.status, 204);
  assert.deepEqual(harness.data(ALICE).progress, {}, "forgetting the file forgets the row that names it");
});

test("forgetting either key forgets the title and its legacy row", async (t) => {
  const harness = await mount([filmLibrary]);
  t.after(harness.close);
  bindFilm(harness);
  const fileKey = `file:${FILM_FILE}`;
  const both = () => ({ [fileKey]: legacyFilmRow(10, "2024-01-01T00:00:00.000Z"), [FILM_KEY]: legacyFilmRow(20, "2024-01-02T00:00:00.000Z") });

  harness.data(ALICE).progress = both();
  const removed = await api(harness.base, `/api/progress/${encodeURIComponent(fileKey)}`, { method: "DELETE", user: ALICE });
  assert.equal(removed.status, 204);
  assert.deepEqual(harness.data(ALICE).progress, {});
  assert.equal(await readProgress(harness, fileKey), null);
  assert.equal(await readProgress(harness, FILM_KEY), null);

  harness.data(ALICE).progress = both();
  const forgotten = await api(harness.base, "/api/progress/forget", { method: "POST", user: ALICE, body: { keys: [FILM_KEY] } });
  assert.equal(forgotten.status, 204);
  assert.deepEqual(harness.data(ALICE).progress, {});
  assert.equal(await readProgress(harness, fileKey), null, "the legacy row went with the title");
});

test("a bound episode file writes the show's episode row and leaves the catalogue marker", async (t) => {
  const harness = await mount([filmLibrary]);
  t.after(harness.close);
  const file = "lib_00000001/Shows/Dark/S01/Dark.S01E02.mkv";
  harness.records["lib_00000001/Shows/Dark"] = { type: "series", id: "tt5", name: "Dark" };
  harness.units.push({ key: "lib_00000001/Shows/Dark", kind: "series", relative: "Shows/Dark", sampleFiles: [file] });

  const response = await api(harness.base, "/api/progress", {
    method: "POST", user: ALICE,
    body: { key: `file:${file}`, path: file, title: "Dark · Episode Two", position: 120, duration: 2400 },
  });

  assert.equal(response.status, 204);
  assert.deepEqual(Object.keys(harness.data(ALICE).progress), ["series:tt5:1:2"]);
  assert.deepEqual((harness.data(ALICE).progress["series:tt5:1:2"] as StoredProgress).series,
    { id: "tt5", name: "Dark", season: 1, episode: 2 }, "the binding names the show");

  const finished = await api(harness.base, "/api/progress", {
    method: "POST", user: ALICE, body: { key: `file:${file}`, path: file, title: "Dark · Episode Two", position: 95, duration: 100 },
  });
  assert.equal(finished.status, 204);
  assert.deepEqual(harness.data(ALICE).progress, {}, "a finished episode keeps no row of its own");

  const catalogue = await api(harness.base, "/api/progress", {
    method: "POST", user: BOB,
    body: { key: "series:tt5:1:2", title: "Dark · Episode Two", position: 95, duration: 100, series: { id: "tt5", name: "Dark", season: 1, episode: 2 } },
  });
  assert.equal(catalogue.status, 204);
  const fromFile = harness.data(ALICE).watchedSeries?.tt5;
  const fromCatalogue = harness.data(BOB).watchedSeries?.tt5;
  assert.ok(fromFile && fromCatalogue);
  assert.deepEqual(
    { ...fromFile, updatedAt: "" },
    { ...fromCatalogue, updatedAt: "" },
    "the file's episode leaves the marker a catalogue episode leaves",
  );
});

test("an unbound file keeps its own file key", async (t) => {
  const harness = await mount([filmLibrary]);
  t.after(harness.close);
  const key = "file:lib_00000001/Films/Loose.mkv";

  assert.equal((await api(harness.base, "/api/progress", {
    method: "POST", user: ALICE, body: { key, path: "lib_00000001/Films/Loose.mkv", title: "Loose", position: 120, duration: 2400 },
  })).status, 204);

  assert.deepEqual(Object.keys(harness.data(ALICE).progress), [key]);
  assert.equal((await readProgress(harness, key))?.position, 120);
  assert.equal((await api(harness.base, `/api/progress/${encodeURIComponent(key)}`, { method: "DELETE", user: ALICE })).status, 204);
  assert.deepEqual(harness.data(ALICE).progress, {});
});

test("a file key naming a library that is gone still reads and removes its stored row", async (t) => {
  const harness = await mount([filmLibrary]);
  t.after(harness.close);
  const file = "lib_00000009/Films/Gone.mkv";
  const key = `file:${file}`;
  harness.broken.add(file);
  harness.data(ALICE).progress = { [key]: { position: 10, duration: 100, title: "Gone", path: file, updatedAt: "2024-01-01T00:00:00.000Z" } };

  const read = await api(harness.base, `/api/progress/${encodeURIComponent(key)}`, { user: ALICE });
  assert.equal(read.status, 200, "the read is answered, not refused");
  assert.equal(await read.json(), null, "the row is hidden along with the library that owned it");

  const removed = await api(harness.base, `/api/progress/${encodeURIComponent(key)}`, { method: "DELETE", user: ALICE });
  assert.equal(removed.status, 204);
  assert.deepEqual(harness.data(ALICE).progress, {}, "the stored row is removed");
});

test("a bound file's position is written nowhere while tracking is off", async (t) => {
  const harness = await mount([filmLibrary]);
  t.after(harness.close);
  bindFilm(harness);
  harness.data(BOB).prefs = { trackProgress: false };

  const response = await api(harness.base, "/api/progress", {
    method: "POST", user: BOB, body: { key: `file:${FILM_FILE}`, path: FILM_FILE, title: "Heat", position: 120, duration: 3600 },
  });

  assert.equal(response.status, 204);
  assert.deepEqual(harness.data(BOB).progress, {}, "the person's own switch decides before the key is resolved");
});

/** One attached media server the account may see, as the store holds it. */
const attachMediaServer = (harness: Harness, allowedUsers: string[] = [ALICE]): void => {
  harness.mediaConnections.push({ id: "mconn_1", provider: "jellyfin", name: "Home", baseUrl: "http://media", enabled: true, serverId: "srv1", accountId: "acc1", secretRef: "secret1", order: 0, addedAt: "" });
  harness.remoteLibraries.push({ id: "rlib_a", connectionId: "mconn_1", remoteId: "1", name: "Films", type: "movie", enabled: true, order: 0, showOnHome: true, showInContinueWatching: true, provider: "jellyfin", allowedUsers, addedAt: "", capabilities: {} });
};
const writePosition = (harness: Harness, body: Record<string, unknown>, user = ALICE) =>
  api(harness.base, "/api/progress", { method: "POST", user, body: { position: 120, duration: 3600, title: "One", ...body } });

test("a position names the media-server version that wrote it, while its library is the viewer's", async (t) => {
  const harness = await mount([filmLibrary]);
  t.after(harness.close);
  attachMediaServer(harness);

  const response = await writePosition(harness, { key: "movie:tt1", remote: { libraryId: "rlib_a", itemId: "1", mediaSourceId: "ms1" } });

  assert.equal(response.status, 204);
  assert.deepEqual((harness.data(ALICE).progress["movie:tt1"] as StoredProgress).remote, { libraryId: "rlib_a", itemId: "1", mediaSourceId: "ms1" });

  const read = await api(harness.base, `/api/progress/${encodeURIComponent("movie:tt1")}`, { user: ALICE });
  assert.deepEqual((await read.json() as StoredProgress).remote, { libraryId: "rlib_a", itemId: "1", mediaSourceId: "ms1" });

  // A viewer who may not browse that library still reads the row, without the version it names.
  harness.data(BOB).progress = { "movie:tt1": { ...(harness.data(ALICE).progress["movie:tt1"] as StoredProgress) } };
  const other = await api(harness.base, `/api/progress/${encodeURIComponent("movie:tt1")}`, { user: BOB });
  const answer = await other.json() as StoredProgress;
  assert.equal(answer.position, 120, "the row is the viewer's own");
  assert.equal(answer.remote, undefined, "the version is not");

  // The list answers the same: the row with its version for the viewer who may see it, without it for the other.
  const listed = async (user: string) => (await (await api(harness.base, "/api/progress", { user })).json() as Array<StoredProgress & { key: string }>)
    .find((row) => row.key === "movie:tt1");
  assert.deepEqual((await listed(ALICE))?.remote, { libraryId: "rlib_a", itemId: "1", mediaSourceId: "ms1" });
  assert.equal((await listed(BOB))?.remote, undefined);
});

test("a row a media-server version wrote without a poster shows that item's picture", async (t) => {
  const harness = await mount([filmLibrary]);
  t.after(harness.close);
  attachMediaServer(harness);
  await writePosition(harness, { key: "movie:tt1", remote: { libraryId: "rlib_a", itemId: "1", mediaSourceId: "ms1" } });
  const listed = async (user: string) => (await (await api(harness.base, "/api/progress", { user })).json() as Array<StoredProgress & { key: string }>)
    .find((row) => row.key === "movie:tt1");
  assert.equal((await listed(ALICE))?.poster, "/api/remote-libraries/rlib_a/items/1/artwork/Primary");
  // A viewer who may not browse that library gets no picture of it.
  harness.data(BOB).progress = { "movie:tt1": { ...(harness.data(ALICE).progress["movie:tt1"] as StoredProgress) } };
  assert.equal((await listed(BOB))?.poster, undefined);
});

test("a malformed remote is dropped while the write still lands, and a write without one clears it", async (t) => {
  const harness = await mount([filmLibrary]);
  t.after(harness.close);
  attachMediaServer(harness);
  const stored = () => harness.data(ALICE).progress["movie:tt1"] as StoredProgress;

  await writePosition(harness, { key: "movie:tt1", remote: { libraryId: "rlib_a", itemId: "1", mediaSourceId: "ms1" } });
  assert.deepEqual(stored().remote, { libraryId: "rlib_a", itemId: "1", mediaSourceId: "ms1" });

  for (const remote of [{ libraryId: "rlib_a", itemId: "1" }, { libraryId: "rlib_a", itemId: 7, mediaSourceId: "ms1" }, { libraryId: "rlib_a", itemId: "1", mediaSourceId: "x".repeat(300) }]) {
    await writePosition(harness, { key: "movie:tt1", remote });
    assert.equal(stored().remote, undefined, `a malformed remote stores none: ${JSON.stringify(remote)}`);
    assert.equal(stored().position, 120, "and the position still lands");
  }

  await writePosition(harness, { key: "movie:tt1", remote: { libraryId: "rlib_a", itemId: "1", mediaSourceId: "ms1" } });
  await writePosition(harness, { key: "movie:tt1" });
  assert.equal(stored().remote, undefined, "the version a later write names, or does not, is what stands");
});

test("unstarring a title through the watchlist clears the library paths that stand for it", async (t) => {
  const harness = await mount([filmLibrary]);
  t.after(harness.close);
  bindFilm(harness);
  harness.data(ALICE).favorites = [FILM_FILE, "lib_00000001/Films/Heat/Copy.mkv", "lib_00000001/Films/Loose.mkv"];
  harness.data(ALICE).watchlist = { "movie:tt9": { type: "movie", id: "tt9", name: "Heat", addedAt: "2024-01-01T00:00:00.000Z" } };

  const response = await api(harness.base, "/api/watchlist", { method: "POST", user: ALICE, body: { type: "movie", id: "tt9", favorite: false } });

  assert.equal(response.status, 200);
  assert.deepEqual(harness.data(ALICE).watchlist, {});
  assert.deepEqual(harness.data(ALICE).favorites, ["lib_00000001/Films/Loose.mkv"], "every copy of the film goes, the unbound star stays");
  assert.deepEqual(harness.clearedTitles, ["movie:tt9"], "and a media-server record of the title loses its star with it");
});

test("forgetting a title also forgets the media-server position of it", async (t) => {
  const harness = await mount([filmLibrary]);
  t.after(harness.close);

  harness.data(ALICE).progress = { "movie:tt9": { position: 60, duration: 600, title: "One", updatedAt: "2024-01-01T00:00:00.000Z" } };
  assert.equal((await api(harness.base, `/api/progress/${encodeURIComponent("movie:tt9")}`, { method: "DELETE", user: ALICE })).status, 204);
  assert.deepEqual(harness.forgottenTitles, [["movie:tt9"]]);

  harness.data(ALICE).progress = { "series:tt5:1:2": { position: 30, duration: 600, title: "Show", series: { id: "tt5", name: "Show", season: 1, episode: 2 }, updatedAt: "2024-01-01T00:00:00.000Z" } };
  assert.equal((await api(harness.base, "/api/progress/forget", { method: "POST", user: ALICE, body: { keys: ["series:tt5:1:2"] } })).status, 204);
  assert.deepEqual(harness.forgottenTitles[1], ["series:tt5:1:2"]);

  // A file key stands for its title once it is bound: forgetting the file forgets the title too.
  bindFilm(harness);
  harness.data(ALICE).progress = { [`file:${FILM_FILE}`]: { position: 30, duration: 600, title: "Heat", path: FILM_FILE, updatedAt: "2024-01-01T00:00:00.000Z" } };
  assert.equal((await api(harness.base, `/api/progress/${encodeURIComponent(`file:${FILM_FILE}`)}`, { method: "DELETE", user: ALICE })).status, 204);
  assert.deepEqual(harness.forgottenTitles[2], ["movie:tt9"], "the file key resolved to its title's key");
});

test("a starred episode stands for its show in every title read", async (t) => {
  const harness = await mount([filmLibrary]);
  t.after(harness.close);
  bindShow(harness);
  harness.data(ALICE).favorites = [SHOW_FILE];
  harness.data(ALICE).watchlist = { "series:tt5": { type: "series", id: "tt5", name: "Dark", addedAt: "2024-01-01T00:00:00.000Z" } };

  const body = await (await api(harness.base, "/api/favorites", { user: ALICE })).json() as {
    items: Array<{ kind: string; title?: { type: string; id: string }; catalogId?: string }>;
  };

  assert.equal(body.items.length, 1, "the episode and the show's star are one card");
  assert.deepEqual(body.items[0]!.title, { type: "series", id: "tt5" });
  assert.equal(body.items[0]!.catalogId, "tt5");
});

test("a film starred in the library and in the catalogue is one card that names its title", async (t) => {
  const harness = await mount([filmLibrary]);
  t.after(harness.close);
  bindFilm(harness);
  harness.data(ALICE).favorites = [FILM_FILE];
  harness.data(ALICE).watchlist = { "movie:tt9": { type: "movie", id: "tt9", name: "Heat", addedAt: "2024-01-01T00:00:00.000Z" } };

  const body = await (await api(harness.base, "/api/favorites", { user: ALICE })).json() as {
    items: Array<{ kind: string; path: string; catalogId?: string; title?: { type: string; id: string } }>;
  };

  assert.equal(body.items.length, 1);
  assert.equal(body.items[0]!.kind, "library");
  assert.equal(body.items[0]!.catalogId, "tt9");
  assert.deepEqual(body.items[0]!.title, { type: "movie", id: "tt9" }, "the card opens the one title detail");
});

test("the Favourites filters read the titles, local copies and media-server stars alike", async (t) => {
  const harness = await mount([filmLibrary]);
  t.after(harness.close);
  bindFilm(harness);
  bindShow(harness);
  harness.data(ALICE).favorites = [FILM_FILE, SHOW_FILE, "lib_00000001/Films/Loose.mkv"];
  harness.data(ALICE).watchlist = { "movie:tt7": { type: "movie", id: "tt7", name: "Starred film", addedAt: "2024-01-02T00:00:00.000Z" } };
  harness.remoteCards.push(
    { kind: "remote", key: "remote:a", title: "Remote film", libraryId: "rlib_a", itemId: "1", provider: "jellyfin", libraryName: "Server", itemType: "movie", updatedAt: "2024-01-03T00:00:00.000Z" },
    { kind: "remote", key: "remote:b", title: "Remote episode", libraryId: "rlib_a", itemId: "2", provider: "jellyfin", libraryName: "Server", itemType: "episode", season: 1, episode: 1, updatedAt: "2024-01-04T00:00:00.000Z" },
  );
  type Page = { items: Array<{ kind: string; path?: string; id?: string; itemId?: string }>; total: number };
  const page = async (filter: string) => (await (await api(harness.base, `/api/favorites?filter=${filter}`, { user: ALICE })).json()) as Page;
  const labels = (body: Page) => body.items.map((item) => item.kind === "remote" ? item.itemId : item.path ?? item.id).sort();

  const movies = await page("movies");
  assert.equal(movies.total, 3, "the film, the media-server film and the catalogue star of the film's id");
  assert.deepEqual(labels(movies), ["1", "lib_00000001/Films/Heat", "tt7"]);
  const series = await page("series");
  assert.equal(series.total, 2, "the show's library copy and the media-server episode");
  assert.deepEqual(labels(series), ["2", "lib_00000001/Shows/Dark"]);
  // The names an older client still sends answer the way they always did.
  assert.deepEqual(labels(await page("library")), ["lib_00000001/Films/Heat", "lib_00000001/Films/Loose.mkv", "lib_00000001/Shows/Dark"]);
  assert.deepEqual(labels(await page("catalog")), ["tt7"]);
  assert.deepEqual(labels(await page("remote")), ["1", "2"]);
  assert.deepEqual(labels(await page("all")), ["1", "2", "lib_00000001/Films/Heat", "lib_00000001/Films/Loose.mkv", "lib_00000001/Shows/Dark", "tt7"].sort());
  assert.deepEqual(labels(await page("nonsense")), labels(await page("all")), "an unknown filter reads as all");
});

test("the Favourites page asks the media server once for all of its stars", async (t) => {
  const harness = await mount([filmLibrary]);
  t.after(harness.close);
  harness.remoteCards.push(
    { kind: "remote", key: "remote:a", title: "Remote film", libraryId: "rlib_a", itemId: "1", provider: "jellyfin", libraryName: "Server", itemType: "movie", updatedAt: "2024-01-03T00:00:00.000Z" },
    { kind: "remote", key: "remote:b", title: "Remote show", libraryId: "rlib_a", itemId: "2", provider: "jellyfin", libraryName: "Server", itemType: "series", updatedAt: "2024-01-04T00:00:00.000Z" },
  );

  const page = await (await api(harness.base, "/api/favorites?filter=movies", { user: ALICE })).json() as { items: Array<{ itemId?: string }> };

  assert.deepEqual(harness.remoteCalls, [{ filter: "favorites", skip: 0, limit: 1000 }], "one read of every card the filter may keep");
  assert.deepEqual(page.items.map((item) => item.itemId), ["1"]);
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

test("GET /api/library/favorites omits a library that opted out and keeps another's star", async (t) => {
  const optedOut: LibraryRecord = { id: "lib_00000003", name: "Quiet", type: "mixed", root: "/media/quiet", enabled: true, order: 2, addedAt: "", writeArtwork: false, showInFavorites: false, visibleTo: [ALICE] };
  const harness = await mount([granted, optedOut]);
  t.after(harness.close);
  harness.data(ALICE).favorites = ["lib_00000002/Shows/01.mkv", "lib_00000003/Quiet/Hidden.mkv"];

  const response = await api(harness.base, "/api/library/favorites", { user: ALICE });

  assert.equal(response.status, 200);
  const body = await response.json() as { items: Array<{ path: string }> };
  assert.deepEqual(body.items.map((item) => item.path), ["lib_00000002/Shows/01.mkv"], "the stars stay stored, the opted-out library just does not answer");
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

const defaultSearch = { saveHistory: true, liveSearch: true, defaultOrder: "source", recent: [] };
const searchOf = (harness: Harness, user: string) => harness.data(user).search as { recent: Array<{ query: string }> } | undefined;

test("GET /api/search/state answers the defaults when nothing is stored", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const response = await api(harness.base, "/api/search/state", { user: ALICE });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), defaultSearch);
  assert.deepEqual(harness.data(ALICE).search, undefined, "a read prunes nothing back into the store");
});

test("POST /api/search/history records a trimmed query the account can read back", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const recorded = await api(harness.base, "/api/search/history", { method: "POST", user: ALICE, body: { query: "  Heat  " } });
  assert.equal(recorded.status, 204);

  const body = await (await api(harness.base, "/api/search/state", { user: ALICE })).json() as { recent: Array<{ query: string; usedAt: string }> };
  assert.deepEqual(body.recent.map((entry) => entry.query), ["Heat"]);
  assert.equal(typeof body.recent[0]!.usedAt, "string");
});

test("one account's search history is not another's", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  await api(harness.base, "/api/search/history", { method: "POST", user: ALICE, body: { query: "Heat" } });

  const bob = await (await api(harness.base, "/api/search/state", { user: BOB })).json() as { recent: unknown[] };
  assert.deepEqual(bob.recent, []);
  assert.deepEqual(searchOf(harness, BOB), undefined, "nothing is written to an account that never asked");
});

test("POST /api/search/history keeps at most twenty entries", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  for (let index = 0; index < 21; index += 1) {
    const response = await api(harness.base, "/api/search/history", { method: "POST", user: ALICE, body: { query: `q${index}` } });
    assert.equal(response.status, 204);
  }

  const body = await (await api(harness.base, "/api/search/state", { user: ALICE })).json() as { recent: Array<{ query: string }> };
  const queries = body.recent.map((entry) => entry.query);
  assert.equal(queries.length, 20);
  assert.equal(queries[0], "q20", "the newest is first");
  assert.ok(!queries.includes("q0"), "the oldest was evicted");
});

test("turning saving off empties recent, and a later record is a 204 no-op", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  await api(harness.base, "/api/search/history", { method: "POST", user: ALICE, body: { query: "Heat" } });

  const off = await api(harness.base, "/api/search/preferences", { method: "PATCH", user: ALICE, body: { saveHistory: false } });
  assert.equal(off.status, 200);
  assert.deepEqual(await off.json(), { ...defaultSearch, saveHistory: false });
  assert.deepEqual(searchOf(harness, ALICE)?.recent, [], "the same write deletes the list");

  const noop = await api(harness.base, "/api/search/history", { method: "POST", user: ALICE, body: { query: "Ronin" } });
  assert.equal(noop.status, 204);
  assert.deepEqual(searchOf(harness, ALICE)?.recent, [], "nothing is stored while saving is off");

  const on = await api(harness.base, "/api/search/preferences", { method: "PATCH", user: ALICE, body: { saveHistory: true } });
  assert.equal(on.status, 200);
  assert.deepEqual(await on.json(), defaultSearch, "turning it back on starts empty");
});

test("DELETE /api/search/history empties recent, keeps preferences and is idempotent", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  await api(harness.base, "/api/search/preferences", { method: "PATCH", user: ALICE, body: { liveSearch: false, defaultOrder: "titleMatch" } });
  await api(harness.base, "/api/search/history", { method: "POST", user: ALICE, body: { query: "Heat" } });

  const kept = { saveHistory: true, liveSearch: false, defaultOrder: "titleMatch", recent: [] };
  const cleared = await api(harness.base, "/api/search/history", { method: "DELETE", user: ALICE });
  assert.equal(cleared.status, 200);
  assert.deepEqual(await cleared.json(), kept);

  const again = await api(harness.base, "/api/search/history", { method: "DELETE", user: ALICE });
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), kept, "a second clear changes nothing");
});

test("POST /api/search/history/forget drops one query and keeps the rest in order", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  for (const query of ["Heat", "Ronin", "Alien"]) {
    await api(harness.base, "/api/search/history", { method: "POST", user: ALICE, body: { query } });
  }

  const forgotten = await api(harness.base, "/api/search/history/forget", { method: "POST", user: ALICE, body: { query: "Ronin" } });
  assert.equal(forgotten.status, 200);
  assert.equal(forgotten.headers.get("cache-control"), "no-store");

  const body = await (await api(harness.base, "/api/search/state", { user: ALICE })).json() as { recent: Array<{ query: string }> };
  assert.deepEqual(body.recent.map((entry) => entry.query), ["Alien", "Heat"], "newest first, the middle entry gone");
});

test("forgetting a query as one account leaves the other account's history alone", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  await api(harness.base, "/api/search/history", { method: "POST", user: ALICE, body: { query: "Heat" } });
  await api(harness.base, "/api/search/history", { method: "POST", user: BOB, body: { query: "Ronin" } });

  const response = await api(harness.base, "/api/search/history/forget", { method: "POST", user: ALICE, body: { query: "Heat" } });
  assert.equal(response.status, 200);

  const alice = await (await api(harness.base, "/api/search/state", { user: ALICE })).json() as { recent: unknown[] };
  const bob = await (await api(harness.base, "/api/search/state", { user: BOB })).json() as { recent: Array<{ query: string }> };
  assert.deepEqual(alice.recent, []);
  assert.deepEqual(bob.recent.map((entry) => entry.query), ["Ronin"], "Bob's history is his own");
});

test("forgetting an unknown query answers 200 and changes nothing", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  await api(harness.base, "/api/search/history", { method: "POST", user: ALICE, body: { query: "Heat" } });

  const response = await api(harness.base, "/api/search/history/forget", { method: "POST", user: ALICE, body: { query: "unknown" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json() as { recent: Array<{ query: string }> };
  assert.deepEqual(body.recent.map((entry) => entry.query), ["Heat"]);
  assert.deepEqual(searchOf(harness, ALICE)?.recent.map((entry) => entry.query), ["Heat"]);
});

test("bad forget bodies are refused with err.invalidRequest and store nothing", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  for (const body of [{}, { query: "Heat", extra: 1 }, { query: "   " }]) {
    const response = await api(harness.base, "/api/search/history/forget", { method: "POST", user: ALICE, body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json() as { messageKey?: string }).messageKey, "err.invalidRequest");
  }
  assert.deepEqual(harness.data(ALICE).search, undefined, "a refused body never reaches the store");
});

test("bad search bodies are refused with err.invalidRequest and store nothing", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const cases: Array<[string, unknown]> = [
    ["/api/search/preferences", { unknown: true }],
    ["/api/search/preferences", { saveHistory: "yes" }],
    ["/api/search/preferences", []],
    ["/api/search/history", { query: "" }],
    ["/api/search/history", { query: "Heat", extra: 1 }],
    ["/api/search/history", { query: 7 }],
  ];
  for (const [path, body] of cases) {
    const response = await api(harness.base, path, { method: path.endsWith("preferences") ? "PATCH" : "POST", user: ALICE, body });
    assert.equal(response.status, 400, `${path} ${JSON.stringify(body)}`);
    assert.equal((await response.json() as { messageKey?: string }).messageKey, "err.invalidRequest");
  }
  assert.deepEqual(harness.data(ALICE).search, undefined, "a refused body never reaches the store");
});

test("/api/search routes are refused without a session, the way dataOf refuses", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const read = await api(harness.base, "/api/search/state");
  const patch = await api(harness.base, "/api/search/preferences", { method: "PATCH", body: {} });
  const record = await api(harness.base, "/api/search/history", { method: "POST", body: { query: "Heat" } });
  const clear = await api(harness.base, "/api/search/history", { method: "DELETE" });

  assert.equal(read.status, 401);
  assert.equal(patch.status, 401);
  assert.equal(record.status, 401);
  assert.equal(clear.status, 401);
  assert.deepEqual(harness.data(ALICE).search, undefined);
});

test("the generic progress map refuses the reserved remote prefix end to end", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const key = `remote:${"a".repeat(64)}`;

  const write = await api(harness.base, "/api/progress", { method: "POST", user: ALICE, body: { key, position: 5, duration: 10, title: "Remote" } });
  assert.equal(write.status, 404, "a forged remote key cannot be written");
  assert.equal(Object.keys(harness.data(ALICE).progress ?? {}).length, 0, "nothing entered the generic map");

  const read = await api(harness.base, `/api/progress/${encodeURIComponent(key)}`, { user: ALICE });
  assert.equal(read.status, 200);
  assert.equal(await read.json(), null, "an unknown remote read answers null, never foreign metadata");

  const list = await api(harness.base, "/api/progress", { user: ALICE });
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), [], "no remote row appears in the list");

  const forget = await api(harness.base, "/api/progress/forget", { method: "POST", user: ALICE, body: { keys: [key] } });
  assert.equal(forget.status, 204);

  const remove = await api(harness.base, `/api/progress/${encodeURIComponent(key)}`, { method: "DELETE", user: ALICE });
  assert.equal(remove.status, 404, "deleting a remote key touches nothing");
});
