import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { messageKeyOf } from "../errors.js";
import { starredPath } from "../favorite-identity.js";
import { libraryPath, parseLibraryPath, relativeWithin, resolveLibraryPath, visibleLibraries, type LibraryRecord } from "../libraries.js";
import type { LibraryMetaRecord, LibrarySuggestion } from "../library-match.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import { isPathWithin, type LibraryEntry } from "../library.js";
import type { Store, StoredProgress, UserPrefs } from "../store.js";
import { emptyUserData, type UserRecord } from "../users.js";
import { registerContentRoutes, type ContentDeps } from "./content.js";

const instancePrefs: UserPrefs = {
  uiLanguage: "en", audioLanguage: "en", subtitleLanguage: "en", downloadTitleLanguage: "ui",
  mergeByName: false, streamSort: "recommended", trackProgress: true, showResumeRow: true,
  tileSize: "medium", catalogTileShape: "poster", libraryTileShape: "poster", favoritesTileShape: "poster", resumeTileShape: "poster", followingTileShape: "poster", homeTileShape: "wide",
  startView: "catalog",
  libraryShelf: "resume",
};

interface Calls {
  browsed: string[];
  rootBrowses: number;
  deleted: string[];
  transfers: Array<{ relative: string; folder: string; copy: boolean | undefined; confirmTypeMismatch: boolean | undefined }>;
  relocated: Array<{ key: string; nextKey: string }>;
  thumbAsked: string[];
  entriesAsked: number;
  /** Whether each entries read accepted the held walk. */
  entriesStale: boolean[];
  artworkAsked: string[];
  swept: number;
  scheduledFolder: string[];
  scheduledFile: string[];
  rootPrewarm: boolean[];
  browseMetaPrewarm: boolean[];
}

interface Harness {
  base: string;
  calls: Calls;
  close(): Promise<void>;
}

/** What the meta store and the account's own rows say, per test. */
interface LibraryState {
  records?: Record<string, LibraryMetaRecord>;
  suggestions?: Record<string, LibrarySuggestion>;
  favorites?: string[];
  /** The account's catalogue stars: a copy of a starred title is drawn starred too. */
  watchlist?: Record<string, unknown>;
  /** The stored positions the browse listing reads a file row's `watched` from. */
  progress?: Record<string, StoredProgress>;
  units?: import("../library-match.js").TitleUnit[];
  /** A fake catalogue picture per key, so a test can see where a mosaic reads its posters. */
  artwork?: (key: string) => string | undefined;
  /** Whether a picture for this key is being written right now. */
  writing?: (key: string) => boolean;
}

const library = (id: string, root: string, order = 0, visibleTo?: string[]): LibraryRecord => ({
  id, name: `Library ${id}`, type: "mixed", root, enabled: true, order,
  addedAt: "2024-01-01T00:00:00.000Z", writeArtwork: false, ...(visibleTo ? { visibleTo } : {}),
});

const ADA = "usr_00000001";
const BOB = "usr_00000002";
const admin = { id: ADA, username: "ada", role: "admin", secret: "ada-secret" } as unknown as UserRecord;
const ordinary = { id: BOB, username: "bob", role: "user" } as unknown as UserRecord;

const put = async (root: string, relative: string) => {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), "video");
};

const exists = async (file: string) => Boolean(await stat(file).catch(() => undefined));

const makeRoot = () => mkdtemp(path.join(tmpdir(), "stremio-content-"));

/** The routes take everything they need from the context, so the app here is a real express
 *  instance over fake collaborators that record what they were asked to do. The filesystem
 *  is real: the resolver, the browse walk and the name checks are module singletons. */
const mount = async (libraries: LibraryRecord[], entries: LibraryEntry[] = [], activeItems: () => string[] = () => [], state: LibraryState = {}): Promise<Harness> => {
  const calls: Calls = { browsed: [], rootBrowses: 0, deleted: [], transfers: [], relocated: [], thumbAsked: [], entriesAsked: 0, entriesStale: [], artworkAsked: [], swept: 0, scheduledFolder: [], scheduledFile: [], rootPrewarm: [], browseMetaPrewarm: [] };
  /** A wire path qualified against the single library, the way production does it. */
  const qualify = (value: string) => {
    const parsed = parseLibraryPath(value);
    if (parsed) return libraryPath(parsed.libraryId, parsed.relative);
    return libraries.length === 1 ? libraryPath(libraries[0]!.id, value) : value;
  };
  const deps: ContentDeps = {
    artStamp: async () => "stamp",
    artworkBusy: (key) => state.writing?.(key) === true,
    store: { libraries: () => libraries, users: () => [admin, ordinary] } as unknown as Store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: (req) => (req.header("x-user") === BOB ? ordinary : admin),
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
    attachBrowseMeta: async (item, _language, options) => { calls.browseMetaPrewarm.push(options?.prewarm === true); return { item, backfill: false }; },
    carveOutsOf: () => new Set(),
    dataOf: () => ({ ...emptyUserData(), favorites: state.favorites ?? [], watchlist: state.watchlist ?? {} }),
    deleteLibraryItem: async (relative) => { calls.deleted.push(relative); },
    fileExists: async (file) => exists(file),
    galleryOf: () => [],
    galleryArtwork: () => undefined,
    healthOf: (record) => ({ unreachable: false, readOnly: false, realRoot: record.root, caseInsensitive: false }),
    invalidateLibrary: () => undefined,
    libraryEntries: async (read?: { stale?: boolean }) => { calls.entriesAsked += 1; calls.entriesStale.push(read?.stale === true); return entries; },
    libraryKey: (value) => qualify(value),
    // The same question the server asks: is the key an active job's business, either way round.
    libraryPathBusy: async (keys) => {
      for (const key of keys) {
        const wanted = await resolveLibraryPath(libraries, key);
        if (!wanted) continue;
        for (const item of activeItems()) {
          const active = await resolveLibraryPath(libraries, item);
          if (active && (isPathWithin(active.absolute, wanted.absolute) || isPathWithin(wanted.absolute, active.absolute))) return item;
        }
      }
      return undefined;
    },
    libraryRootBrowse: async (viewer, options) => {
      calls.rootBrowses += 1;
      calls.rootPrewarm.push(options?.prewarm === true);
      const visible = visibleLibraries(libraries, viewer);
      return { path: "", items: visible.map((record) => ({ kind: "library", libraryId: record.id, name: record.name })), total: visible.length, pending: false };
    },
    libraryUnits: async () => state.units ?? [],
    locateArtwork: async (entry) => { calls.artworkAsked.push(entry.key); return undefined; },
    locateFileArtwork: async (key) => { calls.thumbAsked.push(key); return state.artwork?.(key); },
    locateFolderArtwork: async (key) => { calls.thumbAsked.push(key); return state.artwork?.(key); },
    locateFolderArtworkPair: async (key) => ({ poster: state.artwork?.(key), wide: state.artwork?.(key) }),
    markBrowsed: (record) => { calls.browsed.push(record.id); },
    metaStore: {
      qualifiedMeta: () => state.records ?? {},
      qualifiedSuggestions: () => state.suggestions ?? {},
    } as unknown as LibraryMetaStore,
    prefsOf: () => instancePrefs,
    progressOf: () => state.progress ?? {},
    relativeKeyIn: (libraryId, key) => (key.startsWith(`${libraryId}/`) ? key.slice(libraryId.length + 1) : undefined),
    relocateLibraryPath: async (key, nextKey) => { calls.relocated.push({ key, nextKey }); },
    scheduleFileArtwork: (key) => { calls.scheduledFile.push(key); },
    scheduleFolderArtwork: (key) => { calls.scheduledFolder.push(key); },
    sweepArtwork: async () => { calls.swept += 1; },
    thumbUrl: async (param, value, art) => (art ? `${param}:${value}` : undefined),
    transferLibraryItem: async (relative, folder, copy, _progress, confirmTypeMismatch) => {
      calls.transfers.push({ relative, folder, copy, confirmTypeMismatch });
      return `library/${relative}`;
    },
    wirePath: (key) => (libraries.length === 1 ? relativeWithin(libraries[0]!.id, key) : key),
    // The rule the server applies: a row is starred by its own path, or by the title it stands for.
    withFavorites: (items, data, records, units) => items.map((item) => ({
      ...item,
      favorite: starredPath(qualify(item.path), new Set(data.favorites), data.watchlist as Record<string, unknown>, records, units),
    })),
  };
  const app = express();
  app.use(express.json());
  registerContentRoutes(app, deps);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    res.status(status).json({
      error: error instanceof Error ? error.message : String(error),
      messageKey: messageKeyOf(error),
    });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
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

test("GET /api/library/browse answers the root from libraryRootBrowse", async (t) => {
  const harness = await mount([library("lib_00000001", "/media/films"), library("lib_00000002", "/media/shows", 1)]);
  t.after(harness.close);

  const response = await api(harness.base, "/api/library/browse");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    path: "",
    items: [
      { kind: "library", libraryId: "lib_00000001", name: "Library lib_00000001" },
      { kind: "library", libraryId: "lib_00000002", name: "Library lib_00000002" },
    ],
    total: 2,
    pending: false,
  });
  assert.equal(harness.calls.rootBrowses, 1);
  assert.deepEqual(harness.calls.browsed, [], "the root row lists libraries, it does not open one");
});

test("GET /api/library/browse lists what is inside one library", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat.mkv");
  const harness = await mount([library("lib_00000001", root)]);
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, "/api/library/browse?path=Films");

  assert.equal(response.status, 200);
  const body = await response.json() as { path: string; items: Array<{ kind: string; path: string; label?: string }>; total: number };
  assert.equal(body.path, "Films");
  assert.equal(body.total, 1);
  assert.deepEqual(body.items.map((item) => [item.kind, item.path, item.label]), [["file", "Films/Heat.mkv", "Heat"]]);
  assert.equal(harness.calls.rootBrowses, 0, "one library is opened, not listed");
});

test("a prewarm browse schedules no artwork and sweeps nothing", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat.mkv");
  const harness = await mount([library("lib_00000001", root)]);
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, "/api/library/browse?path=Films&prewarm=1");

  assert.equal(response.status, 200);
  const body = await response.json() as { items: Array<{ path: string }> };
  assert.deepEqual(body.items.map((item) => item.path), ["Films/Heat.mkv"], "the rows are the ordinary ones");
  assert.equal(harness.calls.swept, 0, "a prewarm does not sweep the artwork cache");
  assert.deepEqual(harness.calls.scheduledFile, [], "a prewarm schedules no file artwork");
  assert.deepEqual(harness.calls.scheduledFolder, [], "a prewarm schedules no folder artwork");
  assert.deepEqual(harness.calls.browsed, [], "a prewarm does not count as a library visit");
  assert.deepEqual(harness.calls.browseMetaPrewarm, [true], "a prewarm cannot schedule metadata backfill");
});

test("an ordinary browse still sweeps and schedules the missing artwork", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat.mkv");
  const harness = await mount([library("lib_00000001", root)]);
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, "/api/library/browse?path=Films");

  assert.equal(response.status, 200);
  assert.equal(harness.calls.swept, 1, "an ordinary browse sweeps the artwork cache");
  assert.deepEqual(harness.calls.scheduledFile, ["lib_00000001/Films/Heat.mkv", "lib_00000001/Films/Heat.mkv"], "the missing poster and backdrop are scheduled");
});

test("a bound film's browse row reports the position its title is stored under", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat/Heat.mkv");
  const harness = await mount([library("lib_00000001", root)], [], () => [], {
    records: { "lib_00000001/Films/Heat": { type: "movie", id: "tt1", name: "Heat" } },
    units: [{ key: "lib_00000001/Films/Heat", kind: "movie", relative: "Films/Heat", sampleFiles: ["lib_00000001/Films/Heat/Heat.mkv"] }],
    progress: { "movie:tt1": { position: 300, duration: 2400, title: "Heat", path: "lib_00000001/Films/Heat/Heat.mkv", updatedAt: "2024-01-01T00:00:00.000Z" } },
  });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, "/api/library/browse?path=Films/Heat");

  assert.equal(response.status, 200);
  const body = await response.json() as { items: Array<{ kind: string; path: string; progress?: { position: number } }> };
  assert.deepEqual(body.items.map((item) => [item.kind, item.path, item.progress?.position]), [["file", "Films/Heat/Heat.mkv", 300]]);
});

test("a starred title draws every bound copy of it starred in the listing", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat/Heat.mkv");
  await put(root, "Films/Copies/Heat.mkv");
  const unit = (key: string, file: string): import("../library-match.js").TitleUnit =>
    ({ key, kind: "movie", relative: key.slice("lib_00000001/".length), sampleFiles: [file] });
  const state: LibraryState = {
    records: {
      "lib_00000001/Films/Heat": { type: "movie", id: "tt1", name: "Heat" },
      "lib_00000001/Films/Copies": { type: "movie", id: "tt1", name: "Heat" },
    },
    units: [unit("lib_00000001/Films/Heat", "lib_00000001/Films/Heat/Heat.mkv"), unit("lib_00000001/Films/Copies", "lib_00000001/Films/Copies/Heat.mkv")],
    // Only the first copy carries a path star of its own; the title's star is the other side.
    favorites: ["lib_00000001/Films/Heat"],
  };
  const harness = await mount([library("lib_00000001", root)], [], () => [], state);
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });
  const rows = async () => ((await (await api(harness.base, "/api/library/browse?path=Films")).json()) as { items: Array<{ path: string; favorite: boolean }> }).items
    .map((item) => [item.path, item.favorite]);

  assert.deepEqual(await rows(), [["Films/Copies", false], ["Films/Heat", true]], "a path star is one copy's alone");

  state.watchlist = { "movie:tt1": { type: "movie", id: "tt1", name: "Heat", addedAt: "" } };
  assert.deepEqual(await rows(), [["Films/Copies", true], ["Films/Heat", true]], "the title's star is every copy's");
});

test("a file row reports a title row that names it, whichever key that row kept", async (t) => {
  const root = await makeRoot();
  await put(root, "Shows/Dark/S01/Dark.S01E01.mkv");
  const harness = await mount([library("lib_00000001", root)], [], () => [], {
    records: { "lib_00000001/Shows/Dark": { type: "series", id: "tt5", name: "Dark" } },
    units: [{ key: "lib_00000001/Shows/Dark", kind: "series", relative: "Shows/Dark", sampleFiles: ["lib_00000001/Shows/Dark/S01/Dark.S01E01.mkv"] }],
    // The row kept the numbering of the season the file was moved out of; only its `path` names
    // this file, so the listing reads it through that.
    progress: { "series:tt5:3:9": { position: 300, duration: 2400, title: "Dark", path: "lib_00000001/Shows/Dark/S01/Dark.S01E01.mkv", updatedAt: "2024-01-01T00:00:00.000Z" } },
  });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, "/api/library/browse?path=Shows/Dark/S01");

  assert.equal(response.status, 200);
  const body = await response.json() as { items: Array<{ kind: string; path: string; progress?: { position: number } }> };
  assert.deepEqual(body.items.map((item) => [item.kind, item.path, item.progress?.position]), [["file", "Shows/Dark/S01/Dark.S01E01.mkv", 300]]);
});

test("a prewarm root browse sweeps nothing and asks the root listing for a prewarm", async (t) => {
  const harness = await mount([library("lib_00000001", "/media/films"), library("lib_00000002", "/media/shows", 1)]);
  t.after(harness.close);

  const response = await api(harness.base, "/api/library/browse?prewarm=1");

  assert.equal(response.status, 200);
  assert.equal(harness.calls.rootBrowses, 1);
  assert.deepEqual(harness.calls.rootPrewarm, [true], "the prewarm option reaches the root listing");
  assert.equal(harness.calls.swept, 0, "a prewarm root browse does not sweep the artwork cache");
});

test("GET /api/library/browse lists only granted libraries to an ordinary user", async (t) => {
  const harness = await mount([
    library("lib_00000001", "/media/films", 0, [BOB]),
    library("lib_00000002", "/media/shows", 1),
  ]);
  t.after(harness.close);

  const user = await (await api(harness.base, "/api/library/browse", { user: BOB })).json() as { items: Array<{ libraryId: string }> };
  assert.deepEqual(user.items.map((item) => item.libraryId), ["lib_00000001"]);

  const administrator = await (await api(harness.base, "/api/library/browse")).json() as { items: Array<{ libraryId: string }> };
  assert.deepEqual(administrator.items.map((item) => item.libraryId), ["lib_00000001", "lib_00000002"], "an administrator sees every library");
});

test("browsing into a library the caller may not see answers like one that does not exist", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat.mkv");
  const harness = await mount([library("lib_00000001", root), library("lib_00000002", "/media/shows", 1, [BOB])]);
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const invisible = await api(harness.base, `/api/library/browse?path=${encodeURIComponent("lib_00000001/Films")}`, { user: BOB });
  const missing = await api(harness.base, `/api/library/browse?path=${encodeURIComponent("lib_00000099/Films")}`, { user: BOB });

  assert.equal(invisible.status, missing.status);
  assert.deepEqual(await invisible.json(), await missing.json(), "the two are indistinguishable");
});

test("GET /api/library/thumb answers 404 for a path in a library the caller may not see", async (t) => {
  const harness = await mount([
    library("lib_00000001", "/media/films"),
    library("lib_00000002", "/media/shows", 1, [BOB]),
  ]);
  t.after(harness.close);

  const response = await api(harness.base, `/api/library/thumb?path=${encodeURIComponent("lib_00000001/Films/Heat.mkv")}`, { user: BOB });

  assert.equal(response.status, 404);
  assert.deepEqual(harness.calls.thumbAsked, [], "the artwork is never looked up for a library the caller may not see");
});

test("GET /api/library/folders refuses a path in a library the caller may not see", async (t) => {
  const harness = await mount([
    library("lib_00000001", "/media/films"),
    library("lib_00000002", "/media/shows", 1, [BOB]),
  ]);
  t.after(harness.close);

  const response = await api(harness.base, `/api/library/folders?path=${encodeURIComponent("lib_00000001/Films")}`, { user: BOB });

  assert.equal(response.status, 400);
  assert.equal((await response.json() as { messageKey?: string }).messageKey, "err.invalidPath");
});

test("GET /api/library/folders lets an ordinary user into a visible, writable library", async (t) => {
  const root = await makeRoot();
  await mkdir(path.join(root, "Archive"), { recursive: true });
  const harness = await mount([library("lib_00000001", root, 0, [BOB])]);
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, "/api/library/folders", { user: BOB });

  assert.equal(response.status, 200);
  const body = await response.json() as { folders: Array<{ name: string }> };
  assert.deepEqual(body.folders.map((folder) => folder.name), ["Archive"]);
});

test("GET /api/library/folders keeps an ordinary user out of a read-only library", async (t) => {
  const root = await makeRoot();
  await mkdir(path.join(root, "Archive"), { recursive: true });
  const harness = await mount([{ ...library("lib_00000001", root, 0, [BOB]), readOnly: true }]);
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, "/api/library/folders", { user: BOB });

  assert.equal(response.status, 400);
  assert.equal((await response.json() as { messageKey?: string }).messageKey, "err.invalidPath");
});

test("GET /api/library/folders still shows an administrator a read-only library", async (t) => {
  const root = await makeRoot();
  await mkdir(path.join(root, "Archive"), { recursive: true });
  const harness = await mount([{ ...library("lib_00000001", root, 0, [BOB]), readOnly: true }]);
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, "/api/library/folders");

  assert.equal(response.status, 200);
  const body = await response.json() as { folders: Array<{ name: string }> };
  assert.deepEqual(body.folders.map((folder) => folder.name), ["Archive"]);
});

test("GET /api/library/browse marks the library it read as browsed", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat.mkv");
  const harness = await mount([library("lib_00000001", root)]);
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, "/api/library/browse?path=Films");

  assert.equal(response.status, 200);
  assert.deepEqual(harness.calls.browsed, ["lib_00000001"]);
});

test("GET /api/library/browse gives a collection folder a mosaic of its distinct films", async (t) => {
  const root = await makeRoot();
  await put(root, "Collection/Heat (1995).mkv");
  await put(root, "Collection/Heat (1995) 1080p.mkv");
  await put(root, "Collection/Ronin (1998).mkv");
  await put(root, "Solo/Solo (2018).mkv");
  const heat = "lib_00000001/Collection/Heat (1995).mkv";
  const heatEncode = "lib_00000001/Collection/Heat (1995) 1080p.mkv";
  const ronin = "lib_00000001/Collection/Ronin (1998).mkv";
  const harness = await mount([library("lib_00000001", root)], [], () => [], {
    units: [
      { key: heat, kind: "movie", relative: "Collection/Heat (1995).mkv", sampleFiles: [heat, heatEncode] },
      { key: ronin, kind: "movie", relative: "Collection/Ronin (1998).mkv", sampleFiles: [ronin] },
      { key: "lib_00000001/Solo", kind: "movie", relative: "Solo", sampleFiles: ["Solo/Solo (2018).mkv"] },
    ],
    records: {
      [heat]: { type: "movie", id: "tt-heat", source: "scan" },
      [heatEncode]: { type: "movie", id: "tt-heat", source: "scan" },
      [ronin]: { type: "movie", id: "tt-ronin", source: "scan" },
      "lib_00000001/Solo": { type: "movie", id: "tt-solo", source: "scan" },
    },
    artwork: (key) => key.endsWith("Heat (1995).mkv") ? "heat.jpg" : key.endsWith("Ronin (1998).mkv") ? "ronin.jpg" : key.endsWith("Solo") ? "solo.jpg" : undefined,
  });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const body = await (await api(harness.base, "/api/library/browse")).json() as {
    items: Array<{ path: string; kind: string; posters?: string[]; mosaic?: string; poster?: string }>; pending: boolean;
  };
  const collection = body.items.find((item) => item.path === "Collection")!;
  assert.equal(collection.kind, "folder");
  assert.deepEqual(collection.posters, ["path:Collection/Heat (1995).mkv", "path:Collection/Ronin (1998).mkv"],
    "one catalogue picture per distinct film, deduplicated by identity");
  assert.match(collection.mosaic ?? "", /^\/api\/library\/mosaic\?key=lib_00000001%2FCollection&v=[A-Za-z0-9_-]+$/,
    "the collection also names the one address its fan is composed at");
  assert.equal(collection.poster, undefined, "the collection shows the mosaic instead of a folder frame");
  const solo = body.items.find((item) => item.path === "Solo")!;
  assert.equal(solo.posters, undefined, "a folder holding one film keeps its own poster");
  assert.equal(solo.poster, "dir:Solo");
  assert.equal(body.pending, false, "a mosaic is not a missing poster and does not keep the page asking");
});

test("a row whose picture is being written keeps the page asking until the write lands", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat.mkv");
  let writing = true;
  const harness = await mount([library("lib_00000001", root)], [], () => [], {
    artwork: (key) => (key.endsWith("Heat.mkv") ? "heat.jpg" : undefined),
    writing: (key) => writing && key.endsWith("Heat.mkv"),
  });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });
  const page = async () => {
    const response = await api(harness.base, "/api/library/browse?path=Films");
    return await response.json() as { items: Array<Record<string, unknown>>; pending: boolean };
  };

  const during = await page();
  assert.equal(during.pending, true, "the address the row drew names the picture the job is about to replace");
  assert.deepEqual(during.items.map((item) => "moving" in item), [false], "why a page has to ask again is not part of a row");

  writing = false;
  const after = await page();
  assert.equal(after.pending, false, "a row that has its picture and nothing being written is asked for once");
});

test("a fan whose cell is being rewritten keeps the page asking too", async (t) => {
  const root = await makeRoot();
  await put(root, "Collection/Heat (1995).mkv");
  await put(root, "Collection/Ronin (1998).mkv");
  const heat = "lib_00000001/Collection/Heat (1995).mkv";
  const ronin = "lib_00000001/Collection/Ronin (1998).mkv";
  const harness = await mount([library("lib_00000001", root)], [], () => [], {
    units: [
      { key: heat, kind: "movie", relative: "Collection/Heat (1995).mkv", sampleFiles: [heat] },
      { key: ronin, kind: "movie", relative: "Collection/Ronin (1998).mkv", sampleFiles: [ronin] },
    ],
    records: {
      [heat]: { type: "movie", id: "tt-heat", source: "scan" },
      [ronin]: { type: "movie", id: "tt-ronin", source: "scan" },
    },
    artwork: (key) => (key.includes("Heat") ? "heat.jpg" : "ronin.jpg"),
    writing: (key) => key === ronin,
  });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const body = await (await api(harness.base, "/api/library/browse")).json() as { items: Array<{ path: string; mosaic?: string }>; pending: boolean };
  const collection = body.items.find((item) => item.path === "Collection")!;
  assert.match(collection.mosaic ?? "", /^\/api\/library\/mosaic\?/, "the fan is drawn from the cells it names");
  assert.equal(body.pending, true, "the fan's address is minted from the files a job is rewriting");
});

test("a folder mosaic obeys the flags and leaves a series alone", async (t) => {
  const root = await makeRoot();
  await put(root, "Collection/Heat (1995).mkv");
  await put(root, "Collection/Ronin (1998).mkv");
  await put(root, "Show/Season 1/Show S01E01.mkv");
  const heat = "lib_00000001/Collection/Heat (1995).mkv";
  const ronin = "lib_00000001/Collection/Ronin (1998).mkv";
  const state: LibraryState = {
    units: [
      { key: heat, kind: "movie", relative: "Collection/Heat (1995).mkv", sampleFiles: [heat] },
      { key: ronin, kind: "movie", relative: "Collection/Ronin (1998).mkv", sampleFiles: [ronin] },
      { key: "lib_00000001/Show", kind: "series", relative: "Show", sampleFiles: ["Show/Season 1/Show S01E01.mkv"] },
    ],
    records: {
      [heat]: { type: "movie", id: "tt-heat", source: "scan" },
      [ronin]: { type: "movie", id: "tt-ronin", source: "scan", skipMosaic: true },
      "lib_00000001/Show": { type: "series", id: "tt-show", source: "scan" },
    },
    artwork: (key) => key.endsWith("Heat (1995).mkv") ? "heat.jpg" : key.endsWith("Ronin (1998).mkv") ? "ronin.jpg" : undefined,
  };
  const harness = await mount([library("lib_00000001", root)], [], () => [], state);
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const body = await (await api(harness.base, "/api/library/browse")).json() as { items: Array<{ path: string; posters?: string[] }> };
  // One of the two films is kept out of the mosaic, so the folder no longer has two to show.
  assert.equal(body.items.find((item) => item.path === "Collection")?.posters, undefined);
  assert.equal(body.items.find((item) => item.path === "Show")?.posters, undefined, "a series is never a poster mosaic");
});

test("a library with its mosaic switched off gets no folder collage", async (t) => {
  const root = await makeRoot();
  await put(root, "Collection/Heat (1995).mkv");
  await put(root, "Collection/Ronin (1998).mkv");
  const heat = "lib_00000001/Collection/Heat (1995).mkv";
  const ronin = "lib_00000001/Collection/Ronin (1998).mkv";
  const harness = await mount([{ ...library("lib_00000001", root), mosaic: false }], [], () => [], {
    units: [
      { key: heat, kind: "movie", relative: "Collection/Heat (1995).mkv", sampleFiles: [heat] },
      { key: ronin, kind: "movie", relative: "Collection/Ronin (1998).mkv", sampleFiles: [ronin] },
    ],
    records: {
      [heat]: { type: "movie", id: "tt-heat", source: "scan" },
      [ronin]: { type: "movie", id: "tt-ronin", source: "scan" },
    },
    artwork: (key) => (key.includes("Heat") ? "heat.jpg" : "ronin.jpg"),
  });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const body = await (await api(harness.base, "/api/library/browse")).json() as { items: Array<{ path: string; posters?: string[] }> };
  assert.equal(body.items.find((item) => item.path === "Collection")?.posters, undefined);
});

test("GET /api/library/browse lists only the unconfirmed rows when asked to", async (t) => {
  const root = await makeRoot();
  await put(root, "Heat/Heat.mkv");
  await put(root, "Ronin.mkv");
  await put(root, "Sisters/Sisters.mkv");
  const harness = await mount([library("lib_00000001", root)], [], () => [], {
    suggestions: {
      "lib_00000001/Ronin.mkv": { type: "movie", id: "tt0122690", name: "Ronin", score: 88 },
      "lib_00000001/Heat/Heat.mkv": { type: "movie", id: "tt0113277", name: "Heat", score: 92 },
    },
  });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const everything = await (await api(harness.base, "/api/library/browse")).json() as { total: number };
  assert.equal(everything.total, 3, "without the parameter nothing about the listing changes");

  const body = await (await api(harness.base, "/api/library/browse?unconfirmed=1")).json() as { items: Array<{ path: string }>; total: number };

  assert.deepEqual(body.items.map((item) => item.path), ["Heat", "Ronin.mkv"], "a row with no pending suggestion is left out");
  assert.equal(body.total, 2, "the total counts the rows that are listed, not the ones the folder holds");

  const page = await (await api(harness.base, "/api/library/browse?unconfirmed=1&limit=1")).json() as { items: Array<{ path: string }>; total: number };
  assert.deepEqual(page.items.map((item) => item.path), ["Heat"]);
  assert.equal(page.total, 2, "the filter runs before the page is cut, so the total holds for every page");
});

test("GET /api/library/browse keeps a folder whose child carries the suggestion", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat/Heat.mkv");
  await put(root, "Films/Ronin.mkv");
  const harness = await mount([library("lib_00000001", root)], [], () => [], {
    suggestions: { "lib_00000001/Films/Heat/Heat.mkv": { type: "movie", id: "tt0113277", name: "Heat", score: 92 } },
  });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const body = await (await api(harness.base, "/api/library/browse?path=Films&unconfirmed=1")).json() as { items: Array<{ path: string; kind: string }>; total: number };

  assert.deepEqual(body.items.map((item) => [item.kind, item.path]), [["folder", "Films/Heat"]]);
  assert.equal(body.total, 1);
});

test("GET /api/library/browse narrows unconfirmed to the favourites when both are asked for", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat.mkv");
  await put(root, "Films/Ronin.mkv");
  await put(root, "Films/Thief.mkv");
  const harness = await mount([library("lib_00000001", root)], [], () => [], {
    suggestions: {
      "lib_00000001/Films/Heat.mkv": { type: "movie", id: "tt0113277", name: "Heat", score: 92 },
      "lib_00000001/Films/Ronin.mkv": { type: "movie", id: "tt0122690", name: "Ronin", score: 88 },
    },
    favorites: [
      libraryPath("lib_00000001", "Films/Heat.mkv"),
      libraryPath("lib_00000001", "Films/Thief.mkv"),
    ],
  });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const pending = await (await api(harness.base, "/api/library/browse?path=Films&unconfirmed=1")).json() as { items: Array<{ path: string }>; total: number };
  assert.deepEqual(pending.items.map((item) => item.path), ["Films/Heat.mkv", "Films/Ronin.mkv"]);

  const both = await (await api(harness.base, "/api/library/browse?path=Films&unconfirmed=1&favorites=1")).json() as { items: Array<{ path: string }>; total: number };

  assert.deepEqual(both.items.map((item) => item.path), ["Films/Heat.mkv"], "a row has to be a favourite and pending at once");
  assert.equal(both.total, 1);
});

test("DELETE /api/library/item goes through deleteLibraryItem and touches no file itself", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat.mkv");
  const harness = await mount([library("lib_00000001", root)]);
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, `/api/library/item?path=${encodeURIComponent("  Films/Heat.mkv  ")}`, { method: "DELETE" });

  assert.equal(response.status, 204);
  assert.deepEqual(harness.calls.deleted, ["Films/Heat.mkv"], "the relative path travels trimmed");
  assert.equal(await exists(path.join(root, "Films/Heat.mkv")), true, "the route deletes nothing of its own");
});

test("move, rename and delete refuse a path a library job is working on, and work once it ends", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat.mkv");
  await put(root, "Films/Ronin.mkv");
  let active: string[] = ["Films"];
  const harness = await mount([library("lib_00000001", root)], [], () => active);
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const move = () => api(harness.base, "/api/library/move", { method: "POST", body: { path: "Films/Heat.mkv", folder: "Archive" } });
  const rename = () => api(harness.base, "/api/library/rename", { method: "POST", body: { path: "Films/Ronin.mkv", name: "Thief.mkv" } });
  const remove = (pathname: string) => api(harness.base, `/api/library/item?path=${encodeURIComponent(pathname)}`, { method: "DELETE" });

  for (const [name, response] of [["move", await move()], ["rename", await rename()], ["delete", await remove("Films/Heat.mkv")]] as const) {
    assert.equal(response.status, 409, `${name} waits for the job under way`);
    assert.equal((await response.json() as { messageKey?: string }).messageKey, "err.pathBusy");
  }
  assert.deepEqual(harness.calls.transfers.map((call) => call.relative), [], "nothing moved");
  assert.equal(harness.calls.relocated.length, 0, "nothing was renamed");
  assert.deepEqual(harness.calls.deleted.slice(), [], "nothing was deleted");
  assert.equal(await exists(path.join(root, "Films/Heat.mkv")), true);

  active = ["Films/Heat.mkv"];
  assert.equal((await remove("Films")).status, 409, "the folder holding a busy file waits for the same job");

  active = [];
  assert.equal((await move()).status, 200);
  assert.equal((await rename()).status, 200);
  assert.equal((await remove("Films/Ronin.mkv")).status, 204);
  assert.deepEqual(harness.calls.transfers.map((call) => call.relative), ["Films/Heat.mkv"]);
  assert.deepEqual(harness.calls.deleted, ["Films/Ronin.mkv"]);
});

test("POST /api/library/rename refuses a target that already exists", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat.mkv");
  await put(root, "Films/Ronin.mkv");
  const harness = await mount([library("lib_00000001", root)]);
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, "/api/library/rename", { method: "POST", body: { path: "Films/Heat.mkv", name: "Ronin.mkv" } });

  assert.equal(response.status, 400);
  assert.equal((await response.json() as { messageKey?: string }).messageKey, "err.nameTaken");
  assert.equal(await exists(path.join(root, "Films/Heat.mkv")), true);
  assert.equal(await exists(path.join(root, "Films/Ronin.mkv")), true);
});

// The handler runs the name through safeName before it resolves the target, so a name that
// would leave the library is never refused -- it is stripped of the escape and kept inside.
test("POST /api/library/rename refuses a name it cannot use rather than inventing one", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat.mkv");
  const harness = await mount([library("lib_00000001", root)]);
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, "/api/library/rename", { method: "POST", body: { path: "Films/Heat.mkv", name: "../../Thief" } });

  // The escape never happens either way. What changed is the answer: the name used to be
  // quietly rewritten to something usable -- "video" -- and reported as a success, so the
  // file came back called something nobody asked for.
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { messageKey?: string }).messageKey, "err.unusableName");
  assert.equal(await exists(path.join(root, "Films/Heat.mkv")), true, "the file was renamed anyway");
  assert.equal(await exists(path.join(root, "Films/video.mkv")), false);
  assert.equal(await exists(path.join(root, "Thief.mkv")), false);
  assert.deepEqual(harness.calls.relocated, [], "a refusal must not move any binding");
});

test("POST /api/library/move passes copy through to transferLibraryItem", async (t) => {
  const harness = await mount([library("lib_00000001", "/media/films")]);
  t.after(harness.close);

  const copied = await api(harness.base, "/api/library/move", { method: "POST", body: { path: "Films/Heat.mkv", folder: "Archive", copy: true } });
  assert.equal(copied.status, 200);
  assert.deepEqual(await copied.json(), { path: "library/Films/Heat.mkv" });

  const moved = await api(harness.base, "/api/library/move", { method: "POST", body: { path: "Films/Ronin.mkv", folder: "Archive", confirmTypeMismatch: true } });
  assert.equal(moved.status, 200);

  assert.deepEqual(harness.calls.transfers, [
    { relative: "Films/Heat.mkv", folder: "Archive", copy: true, confirmTypeMismatch: false },
    { relative: "Films/Ronin.mkv", folder: "Archive", copy: false, confirmTypeMismatch: true },
  ]);
});

test("GET /api/library/thumb answers 404 for a path with no artwork", async (t) => {
  const harness = await mount([library("lib_00000001", "/media/films")]);
  t.after(harness.close);

  const response = await api(harness.base, `/api/library/thumb?path=${encodeURIComponent("Films/Missing.mkv")}`);

  assert.equal(response.status, 404);
  assert.deepEqual(harness.calls.thumbAsked, ["lib_00000001/Films/Missing.mkv"], "the wire path is qualified before it is looked up");
});

test("GET /api/library/thumb answers 404 for a key whose artwork is missing", async (t) => {
  const entry: LibraryEntry = { key: "lib_00000001/Films", kind: "collection", title: "Films", files: [], size: 0, modified: "" };
  const harness = await mount([library("lib_00000001", "/media/films")], [entry]);
  t.after(harness.close);

  const response = await api(harness.base, `/api/library/thumb?key=${encodeURIComponent("lib_00000001/Films")}`);

  assert.equal(response.status, 404);
  assert.equal(harness.calls.entriesAsked, 1);
  assert.deepEqual(harness.calls.entriesStale, [true], "a mosaic tile never waits for a new walk of every library");
  assert.deepEqual(harness.calls.artworkAsked, ["lib_00000001/Films"], "the key is looked up among the library entries");
});

test("library thumbnails revalidate cached bytes and still enforce library visibility", async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const art = path.join(root, "poster.jpg");
  await writeFile(art, "poster bytes");
  const harness = await mount([library("lib_00000001", root, 0, [ADA])], [], () => [], { artwork: () => art });
  t.after(() => harness.close());
  const url = `${harness.base}/api/library/thumb?path=Films/Heat.mkv&v=stamp`;
  const first = await fetch(url);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(first.headers.get("content-type"), "image/jpeg");
  assert.equal(await first.text(), "poster bytes");
  const etag = first.headers.get("etag")!;
  assert.ok(etag);
  const cached = await fetch(url, { headers: { "if-none-match": etag, "cache-control": "max-age=0" } });
  assert.equal(cached.status, 304);
  assert.equal(cached.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(await cached.text(), "");
  const denied = await fetch(url, { headers: { "if-none-match": etag, "cache-control": "max-age=0", "x-user": BOB } });
  assert.equal(denied.status, 404);
  await writeFile(art, "updated poster bytes");
  const changed = await fetch(url, { headers: { "if-none-match": etag, "cache-control": "max-age=0" } });
  assert.equal(changed.status, 200);
  assert.equal(await changed.text(), "updated poster bytes");
});

test("a fresh thumbnail address never serves the bytes of the picture it replaced", async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const art = path.join(root, "poster.jpg");
  await writeFile(art, "the old picture");
  const harness = await mount([library("lib_00000001", root, 0, [ADA])], [], () => [], { artwork: () => art });
  t.after(() => harness.close());
  const address = (version: string) => `${harness.base}/api/library/thumb?path=${encodeURIComponent("Films/Heat.mkv")}&v=${version}`;

  const before = await fetch(address("one"));
  assert.equal(await before.text(), "the old picture");
  // Re-assigning a title writes a new picture over the same file. The memory copy of the old one
  // belongs to the address that named it, and never to the address the listing mints next -- the
  // browser would keep that one for a year.
  await writeFile(art, "the picture the new binding wrote");
  const after = await fetch(address("two"));
  assert.equal(after.status, 200);
  assert.equal(await after.text(), "the picture the new binding wrote");
});
