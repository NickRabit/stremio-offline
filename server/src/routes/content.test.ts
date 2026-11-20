import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { messageKeyOf } from "../errors.js";
import { starredPath } from "../favorite-identity.js";
import { libraryPath, libraryVisible, parseLibraryPath, relativeWithin, resolveLibraryPath, visibleLibraries, type LibraryRecord, type Viewer } from "../libraries.js";
import type { GalleryEntry, LibraryMetaRecord, LibrarySuggestion } from "../library-match.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import { isPathWithin, withinLibraryRoot, type LibraryEntry } from "../library.js";
import type { Store, StoredProgress, UserPrefs, WatchedMarker } from "../store.js";
import { emptyUserData, type UserRecord } from "../users.js";
import { PathReservations } from "../path-reservations.js";
import { LibraryRenameRecovery } from "../library-rename-recovery.js";
import { ArtworkCache } from "../artwork-cache.js";
import { registerContentRoutes, type ContentDeps } from "./content.js";

const instancePrefs: UserPrefs = {
  uiLanguage: "en", audioLanguage: "en", subtitleLanguage: "en", downloadTitleLanguage: "ui",
  mergeByName: false, streamSort: "recommended", trackProgress: true, showResumeRow: true,
  upNextAt: "end", skipSegmentsAuto: false, hideSpoilers: false,
  tileSize: "medium", catalogTileShape: "poster", libraryTileShape: "poster", favoritesTileShape: "poster", resumeTileShape: "poster", followingTileShape: "poster", homeTileShape: "wide", searchTileShape: "poster",
  startView: "catalog",
  libraryShelf: "resume",
};

interface Calls {
  invalidated: number;
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
  /** The local and catalogue markers the browse listing reads too. */
  markers?: Record<string, WatchedMarker>;
  units?: import("../library-match.js").TitleUnit[];
  /** A fake catalogue picture per key, so a test can see where a mosaic reads its posters. */
  artwork?: (key: string) => string | undefined;
  /** Whether a picture for this key is being written right now. */
  writing?: (key: string) => boolean;
  gallery?: GalleryEntry[];
  galleryArtwork?: (key: string, index: number) => string | undefined;
  artStamp?: (file: string) => Promise<string>;
  caseInsensitive?: boolean;
  relocateError?: Error;
  /** Holds the next transfer until the test lets it go; `reached` settles when it starts. */
  transferHold?: { reached: () => void; release: Promise<void> };
  /** Holds the next binding write until the test lets it go; `reached` settles when it starts. */
  relocateHold?: { reached: () => void; release: Promise<void> };
  /** Holds the rename journal's second health refresh -- after the intent (with its subtitles)
   *  is written, before anything on disk moves -- until the test lets it go. */
  recoverHold?: { reached: () => void; release: Promise<void> };
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
  const pathReservations = new PathReservations();
  const calls: Calls = { invalidated: 0, browsed: [], rootBrowses: 0, deleted: [], transfers: [], relocated: [], thumbAsked: [], entriesAsked: 0, entriesStale: [], artworkAsked: [], swept: 0, scheduledFolder: [], scheduledFile: [], rootPrewarm: [], browseMetaPrewarm: [] };
  const nestedRelative = (library: LibraryRecord, other: LibraryRecord): string | undefined => {
    const relative = path.relative(path.resolve(library.root), path.resolve(other.root));
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
    return relative.split(path.sep).join("/");
  };
  const carveOutsOf = (library: LibraryRecord) =>
    new Set(libraries.flatMap((other) => {
      const relative = other.id === library.id ? undefined : nestedRelative(library, other);
      return relative ? [relative] : [];
    }));
  const nestedHidden = (library: LibraryRecord, relative: string, viewer: Viewer | undefined) =>
    Boolean(viewer && libraries.some((other) => {
      if (other.id === library.id || libraryVisible(other, viewer)) return false;
      const nested = nestedRelative(library, other);
      return Boolean(nested && withinLibraryRoot(new Set([nested]), relative, state.caseInsensitive));
    }));
  /** A wire path qualified against the single library, the way production does it. */
  const qualify = (value: string) => {
    const parsed = parseLibraryPath(value);
    if (parsed) return libraryPath(parsed.libraryId, parsed.relative);
    return libraries.length === 1 ? libraryPath(libraries[0]!.id, value) : value;
  };
  const deps: ContentDeps = {
    artStamp: async (file) => state.artStamp?.(file) ?? "stamp",
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
    carveOutsOf,
    nestedHidden,
    dataOf: () => ({ ...emptyUserData(), favorites: state.favorites ?? [], watchlist: state.watchlist ?? {} }),
    deleteLibraryItem: async (relative) => { calls.deleted.push(relative); },
    fileExists: async (file) => exists(file),
    galleryOf: () => state.gallery ?? [],
    galleryArtwork: (key, index) => state.galleryArtwork?.(key, index),
    healthOf: (record) => ({ unreachable: false, readOnly: false, realRoot: record.root, caseInsensitive: state.caseInsensitive ?? false }),
    invalidateLibrary: () => { calls.invalidated += 1; },
    libraryEntries: async (read?: { stale?: boolean }) => { calls.entriesAsked += 1; calls.entriesStale.push(read?.stale === true); return entries; },
    libraryKey: (value) => qualify(value),
    // The same question the server asks: is the key an active job's business, either way round.
    libraryPathBusy: async (keys, options) => {
      for (const key of keys) {
        const wanted = await resolveLibraryPath(libraries, key);
        if (!wanted) continue;
        for (const item of options?.ignoreReservations ? activeItems() : [...activeItems(), ...pathReservations.keys()]) {
          const active = await resolveLibraryPath(libraries, item);
          if (active && (isPathWithin(active.absolute, wanted.absolute) || isPathWithin(wanted.absolute, active.absolute))) return item;
        }
      }
      return undefined;
    },
    libraryPathsBusy: async (keys) => {
      const busy = new Set<string>();
      for (const key of keys) {
        const wanted = await resolveLibraryPath(libraries, key);
        if (!wanted) continue;
        for (const item of [...activeItems(), ...pathReservations.keys()]) {
          const active = await resolveLibraryPath(libraries, item);
          if (active && (isPathWithin(active.absolute, wanted.absolute) || isPathWithin(wanted.absolute, active.absolute))) {
            busy.add(key);
            break;
          }
        }
      }
      return busy;
    },
    pathReservations,
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
    markersOf: () => state.markers ?? {},
    metaStore: {
      qualifiedMeta: () => state.records ?? {},
      qualifiedSuggestions: () => state.suggestions ?? {},
    } as unknown as LibraryMetaStore,
    prefsOf: () => instancePrefs,
    progressOf: () => state.progress ?? {},
    relativeKeyIn: (libraryId, key) => (key.startsWith(`${libraryId}/`) ? key.slice(libraryId.length + 1) : undefined),
    renameLibraryItem: (request) => renames.rename(request),
    scheduleFileArtwork: (key) => { calls.scheduledFile.push(key); },
    scheduleFolderArtwork: (key) => { calls.scheduledFolder.push(key); },
    sweepArtwork: async () => { calls.swept += 1; },
    thumbUrl: async (param, value, art) => (art ? `${param}:${value}` : undefined),
    transferLibraryItem: async (relative, folder, copy, _progress, confirmTypeMismatch) => {
      calls.transfers.push({ relative, folder, copy, confirmTypeMismatch });
      const hold = state.transferHold;
      state.transferHold = undefined;
      if (hold) { hold.reached(); await hold.release; }
      return `library/${relative}`;
    },
    wirePath: (key) => (libraries.length === 1 ? relativeWithin(libraries[0]!.id, key) : key),
    // The rule the server applies: a row is starred by its own path, or by the title it stands for.
    withFavorites: (items, data, records, units) => items.map((item) => ({
      ...item,
      favorite: starredPath(qualify(item.path), new Set(data.favorites), data.watchlist as Record<string, unknown>, records, units),
    })),
  };
  const dataDir = await makeRoot();
  let refreshes = 0;
  const renames = new LibraryRenameRecovery({
    dataDir, libraries: () => libraries, users: () => [admin, ordinary],
    carveOutsOf, healthOf: deps.healthOf, refreshHealth: async () => {
      refreshes += 1;
      const hold = refreshes === 2 ? state.recoverHold : undefined;
      if (hold) { state.recoverHold = undefined; hold.reached(); await hold.release; }
    },
    actions: {
      relocateLibraryPath: async (key, nextKey) => {
        calls.relocated.push({ key, nextKey });
        // One write only: a second rename must answer, held or not, so a test fails instead of hanging.
        const hold = state.relocateHold;
        state.relocateHold = undefined;
        if (hold) { hold.reached(); await hold.release; }
        if (state.relocateError) throw state.relocateError;
      },
    },
    metaStore: { flushLibrary: async () => undefined },
    artworks: new ArtworkCache(path.join(dataDir, "artwork")),
    store: { flush: async () => undefined },
    invalidateLibrary: () => undefined,
  });
  await renames.load();
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
      await rm(dataDir, { recursive: true, force: true });
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

test("GET /api/library/browse answers an empty root when the one library is not the caller's", async (t) => {
  const harness = await mount([library("lib_00000001", "/media/films", 0, [])]);
  t.after(harness.close);

  const response = await api(harness.base, "/api/library/browse", { user: BOB });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { path: "", items: [], total: 0, pending: false });
  assert.deepEqual(harness.calls.browsed, []);
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

test("a local marker marks the unbound episodes it covers", async (t) => {
  const root = await makeRoot();
  const first = "lib_00000001/Shows/Local/Season 01/Local - S01E01.mp4";
  const second = "lib_00000001/Shows/Local/Season 01/Local - S01E02.mp4";
  await put(root, "Shows/Local/Season 01/Local - S01E01.mp4");
  await put(root, "Shows/Local/Season 01/Local - S01E02.mp4");
  const harness = await mount([library("lib_00000001", root)], [], () => [], {
    units: [{
      key: "lib_00000001/Shows/Local",
      kind: "series",
      relative: "Shows/Local",
      sampleFiles: [first, second],
    }],
    markers: {
      "local:lib_00000001/Shows/Local": {
        name: "Local",
        season: 1,
        episode: 1,
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    },
  });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const body = await (await api(harness.base, "/api/library/browse?path=Shows/Local/Season%2001")).json() as {
    items: Array<{ path: string; progress?: { position: number; duration: number } }>;
  };
  assert.deepEqual(body.items.map((item) => [item.path, item.progress]), [
    ["Shows/Local/Season 01/Local - S01E01.mp4", { position: 1, duration: 1 }],
    ["Shows/Local/Season 01/Local - S01E02.mp4", undefined],
  ]);
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

test("browse and folders answer a nested library's parent-spelled key like a missing path", async (t) => {
  const root = await makeRoot();
  await put(root, "Nested/Season 1/secret.mkv");
  await put(root, "Public/Visible.mkv");
  const libraries = [
    library("lib_00000001", root, 0, [BOB]),
    library("lib_00000002", path.join(root, "Nested"), 1),
  ];
  const harness = await mount(libraries, [], () => [], {
  });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const browse = await api(harness.base, `/api/library/browse?path=${encodeURIComponent("lib_00000001/Nested/Season 1")}`, { user: BOB });
  const missingBrowse = await api(harness.base, `/api/library/browse?path=${encodeURIComponent("lib_00000001/Missing/Season 1")}`, { user: BOB });
  assert.equal(browse.status, missingBrowse.status);
  assert.deepEqual({ ...await browse.json() as object, path: "" }, { ...await missingBrowse.json() as object, path: "" });

  const folders = await api(harness.base, `/api/library/folders?path=${encodeURIComponent("lib_00000001/Nested")}`, { user: BOB });
  const missingFolders = await api(harness.base, `/api/library/folders?path=${encodeURIComponent("lib_00000001/Missing")}`, { user: BOB });
  assert.equal(folders.status, missingFolders.status);
  assert.deepEqual({ ...await folders.json() as object, path: "" }, { ...await missingFolders.json() as object, path: "" });

  const ordinary = await api(harness.base, `/api/library/browse?path=${encodeURIComponent("lib_00000001/Public")}`, { user: BOB });
  assert.equal(ordinary.status, 200);
  assert.deepEqual((await ordinary.json() as { items: Array<{ path: string }> }).items.map((item) => item.path), ["lib_00000001/Public/Visible.mkv"]);
});

test("gallery answers an absent visible path like a hidden nested one", async (t) => {
  const root = await makeRoot();
  await put(root, "Nested/Season 1/secret.mkv");
  await put(root, "Public/Visible.mkv");
  const libraries = [
    library("lib_00000001", root, 0, [BOB]),
    library("lib_00000002", path.join(root, "Nested"), 1),
  ];
  const harness = await mount(libraries, [], () => [], {
    gallery: [{ kind: "still", shape: "wide" }],
  });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const hiddenKey = "lib_00000001/Nested/Season 1/secret.mkv";
  const missingKey = "lib_00000001/Missing/Season 1/secret.mkv";
  const hidden = await api(harness.base, `/api/library/gallery?path=${encodeURIComponent(hiddenKey)}`, { user: BOB });
  const missing = await api(harness.base, `/api/library/gallery?path=${encodeURIComponent(missingKey)}`, { user: BOB });
  assert.equal(hidden.status, missing.status);
  assert.deepEqual(await hidden.json(), await missing.json());

  // A NUL byte reaches the filesystem call only for a visible path; it must not answer differently.
  const hiddenNul = await api(harness.base, `/api/library/gallery?path=${encodeURIComponent("lib_00000001/Nested/Season 1/se\0cret.mkv")}`, { user: BOB });
  const missingNul = await api(harness.base, `/api/library/gallery?path=${encodeURIComponent("lib_00000001/Missing/Season 1/se\0cret.mkv")}`, { user: BOB });
  assert.equal(hiddenNul.status, missingNul.status);
  assert.deepEqual(await hiddenNul.json(), await missingNul.json());

  const visible = await api(harness.base, `/api/library/gallery?path=${encodeURIComponent("lib_00000001/Public/Visible.mkv")}`, { user: BOB });
  assert.equal(visible.status, 200);
  assert.equal((await visible.json() as { images: unknown[] }).images.length, 1);
});

test("the parent-spelled carved-out key remains refused when the volume folds case", async (t) => {
  const root = await makeRoot();
  await put(root, "Nested/Season 1/secret.mkv");
  const libraries = [
    library("lib_00000001", root, 0, [BOB]),
    library("lib_00000002", path.join(root, "Nested"), 1),
  ];
  const harness = await mount(libraries, [], () => [], {
    caseInsensitive: true,
  });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const browse = await api(harness.base, `/api/library/browse?path=${encodeURIComponent("lib_00000001/NESTED/Season 1")}`, { user: BOB });
  const missingBrowse = await api(harness.base, `/api/library/browse?path=${encodeURIComponent("lib_00000001/Missing/Season 1")}`, { user: BOB });
  assert.equal(browse.status, missingBrowse.status);
  assert.deepEqual({ ...await browse.json() as object, path: "" }, { ...await missingBrowse.json() as object, path: "" });
});

test("a viewer granted both libraries browses the nested tree through the parent id", async (t) => {
  const root = await makeRoot();
  await put(root, "Nested/Season 1/secret.mkv");
  const libraries = [
    library("lib_00000001", root, 0, [BOB]),
    library("lib_00000002", path.join(root, "Nested"), 1, [BOB]),
  ];
  const harness = await mount(libraries);
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const browse = await api(harness.base, `/api/library/browse?path=${encodeURIComponent("lib_00000001/Nested/Season 1")}`, { user: BOB });
  assert.equal(browse.status, 200);
  assert.deepEqual((await browse.json() as { items: Array<{ path: string }> }).items.map((item) => item.path),
    ["lib_00000001/Nested/Season 1/secret.mkv"]);

  const folders = await api(harness.base, `/api/library/folders?path=${encodeURIComponent("lib_00000001/Nested")}`, { user: BOB });
  assert.equal(folders.status, 200);
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

test("POST /api/library/rename takes the video's subtitles along under its new name", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat.mkv");
  await put(root, "Films/Heat.srt");
  await put(root, "Films/Heat.cs.vtt");
  await put(root, "Films/Heat 2.srt");
  const harness = await mount([library("lib_00000001", root)]);
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, "/api/library/rename", { method: "POST", body: { path: "Films/Heat.mkv", name: "Thief" } });

  assert.equal(response.status, 200);
  assert.equal(await exists(path.join(root, "Films/Thief.mkv")), true);
  assert.equal(await exists(path.join(root, "Films/Thief.srt")), true, "the plain subtitle follows");
  assert.equal(await exists(path.join(root, "Films/Thief.cs.vtt")), true, "a language-tagged subtitle follows");
  assert.equal(await exists(path.join(root, "Films/Heat.srt")), false);
  assert.equal(await exists(path.join(root, "Films/Heat.cs.vtt")), false);
  assert.equal(await exists(path.join(root, "Films/Heat 2.srt")), true, "another title's subtitle stays");
});

test("POST /api/library/rename takes the subtitles along when the bindings cannot move", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat.mkv");
  await put(root, "Films/Heat.cs.srt");
  await put(root, "Films/Heat.en.srt");
  const harness = await mount([library("lib_00000001", root)], [], () => [], {
    relocateError: new Error("metadata write failed"),
  });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, "/api/library/rename", { method: "POST", body: { path: "Films/Heat.mkv", name: "Thief" } });

  assert.equal(response.status, 400);
  assert.equal(await exists(path.join(root, "Films/Thief.mkv")), true);
  assert.equal(await exists(path.join(root, "Films/Thief.cs.srt")), true);
  assert.equal(await exists(path.join(root, "Films/Thief.en.srt")), true);
  assert.equal(await exists(path.join(root, "Films/Heat.cs.srt")), false);
  assert.equal(await exists(path.join(root, "Films/Heat.en.srt")), false);
  assert.equal(harness.calls.invalidated, 1, "the listing that names the old file is dropped");
});

test("POST /api/library/rename holds both names until the bindings have moved", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat.mkv");
  let reached!: () => void;
  const started = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const state: LibraryState = { relocateHold: { reached, release: hold } };
  const harness = await mount([library("lib_00000001", root)], [], () => [], state);
  t.after(async () => { release(); await harness.close(); await rm(root, { recursive: true, force: true }); });

  const first = api(harness.base, "/api/library/rename", { method: "POST", body: { path: "Films/Heat.mkv", name: "Thief" } });
  await started;
  // The video is already called Thief, its bindings are still under Heat.
  const second = await api(harness.base, "/api/library/rename", { method: "POST", body: { path: "Films/Thief.mkv", name: "Ronin" } });
  assert.equal(second.status, 409);
  assert.equal((await second.json() as { messageKey?: string }).messageKey, "err.pathBusy");
  assert.equal(await exists(path.join(root, "Films/Thief.mkv")), true, "the second rename touched the disk");

  release();
  assert.equal((await first).status, 200);
  const later = await api(harness.base, "/api/library/rename", { method: "POST", body: { path: "Films/Thief.mkv", name: "Ronin" } });
  assert.equal(later.status, 200, "the names are released once the first rename is done");
  assert.deepEqual(harness.calls.relocated.map((call) => call.nextKey), ["lib_00000001/Films/Thief.mkv", "lib_00000001/Films/Ronin.mkv"]);
});

test("POST /api/library/rename refuses a job queued for the item while it was checking the name", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat.mkv");
  // The first look at the queue finds nothing; the move is queued while the rename reads the
  // disk, so every later look finds it.
  let reads = 0;
  const harness = await mount([library("lib_00000001", root)], [], () => (reads++ === 0 ? [] : ["lib_00000001/Films/Heat.mkv"]));
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, "/api/library/rename", { method: "POST", body: { path: "Films/Heat.mkv", name: "Thief" } });

  assert.equal(response.status, 409);
  assert.equal((await response.json() as { messageKey?: string }).messageKey, "err.pathBusy");
  assert.equal(await exists(path.join(root, "Films/Heat.mkv")), true, "the queued job's item was renamed under it");
  assert.equal(harness.calls.relocated.length, 0);
});

test("a direct move holds its item: a rename or delete of it meanwhile is refused, and works after", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat.mkv");
  let reached!: () => void;
  const started = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const state: LibraryState = { transferHold: { reached, release: hold } };
  const harness = await mount([library("lib_00000001", root)], [], () => [], state);
  t.after(async () => { release(); await harness.close(); await rm(root, { recursive: true, force: true }); });

  const move = api(harness.base, "/api/library/move", { method: "POST", body: { path: "Films/Heat.mkv", folder: "Archive" } });
  await started;
  const rename = await api(harness.base, "/api/library/rename", { method: "POST", body: { path: "Films/Heat.mkv", name: "Thief" } });
  assert.equal(rename.status, 409, "a rename under a running transfer");
  const remove = await api(harness.base, "/api/library/item?path=Films%2FHeat.mkv", { method: "DELETE" });
  assert.equal(remove.status, 409, "a delete under a running transfer");
  assert.deepEqual(harness.calls.deleted, []);
  assert.equal(await exists(path.join(root, "Films/Heat.mkv")), true);

  release();
  assert.equal((await move).status, 200);
  const later = await api(harness.base, "/api/library/item?path=Films%2FHeat.mkv", { method: "DELETE" });
  assert.equal(later.status, 204, "the item is free once the transfer is done");
});

test("a direct move holds the name it takes in its destination, and nothing else there", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat.mkv");
  await put(root, "Archive/Other.mkv");
  let reached!: () => void;
  const started = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const harness = await mount([library("lib_00000001", root)], [], () => [], { transferHold: { reached, release: hold } });
  t.after(async () => { release(); await harness.close(); await rm(root, { recursive: true, force: true }); });

  const move = api(harness.base, "/api/library/move", { method: "POST", body: { path: "Films/Heat.mkv", folder: "Archive" } });
  await started;
  const onto = await api(harness.base, "/api/library/rename", { method: "POST", body: { path: "Archive/Other.mkv", name: "Heat" } });
  assert.equal(onto.status, 409, "a rename onto the name the moved file takes");
  const beside = await api(harness.base, "/api/library/rename", { method: "POST", body: { path: "Archive/Other.mkv", name: "Ronin" } });
  assert.equal(beside.status, 200, "another name in the same folder is free");
  release();
  assert.equal((await move).status, 200);
});

test("a delete held by a rename in flight is refused", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat.mkv");
  let reached!: () => void;
  const started = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const harness = await mount([library("lib_00000001", root)], [], () => [], { relocateHold: { reached, release: hold } });
  t.after(async () => { release(); await harness.close(); await rm(root, { recursive: true, force: true }); });

  const rename = api(harness.base, "/api/library/rename", { method: "POST", body: { path: "Films/Heat.mkv", name: "Thief" } });
  await started;
  const remove = await api(harness.base, "/api/library/item?path=Films%2FThief.mkv", { method: "DELETE" });
  assert.equal(remove.status, 409);
  assert.deepEqual(harness.calls.deleted, []);
  release();
  assert.equal((await rename).status, 200);
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

test("POST /api/library/rename-plan previews film folders, loose films, episodes and unidentified files", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat/Heat.mkv");
  await put(root, "Loose/Ronin.mkv");
  await put(root, "Shows/Dark/S01/Dark.S01E01.mkv");
  await put(root, "Shows/Dark/S01/Dark.S01E02.mkv");
  await put(root, "Unknown/Mystery.mkv");
  const units = [
    { key: "lib_00000001/Films/Heat", kind: "movie" as const, relative: "Films/Heat", sampleFiles: ["lib_00000001/Films/Heat/Heat.mkv"] },
    { key: "lib_00000001/Loose/Ronin.mkv", kind: "movie" as const, relative: "Loose/Ronin.mkv", sampleFiles: ["lib_00000001/Loose/Ronin.mkv"] },
    {
      key: "lib_00000001/Shows/Dark", kind: "series" as const, relative: "Shows/Dark",
      sampleFiles: ["lib_00000001/Shows/Dark/S01/Dark.S01E01.mkv", "lib_00000001/Shows/Dark/S01/Dark.S01E02.mkv"],
    },
    { key: "lib_00000001/Unknown/Mystery.mkv", kind: "movie" as const, relative: "Unknown/Mystery.mkv", sampleFiles: ["lib_00000001/Unknown/Mystery.mkv"] },
  ];
  const harness = await mount([library("lib_00000001", root)], [], () => [], {
    units,
    records: {
      "lib_00000001/Films/Heat": { type: "movie", id: "tt1", name: "Heat", year: "1995" },
      "lib_00000001/Loose/Ronin.mkv": { type: "movie", id: "tt2", name: "Ronin", year: "1998" },
      "lib_00000001/Shows/Dark": { type: "series", id: "tt3", name: "Dark", year: "2017" },
    },
  });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, "/api/library/rename-plan", {
    method: "POST",
    body: {
      items: ["Films/Heat", "Loose/Ronin.mkv", "Shows/Dark", "Unknown/Mystery.mkv"],
      moviePattern: "{title} ({year})",
      episodePattern: "{title} - S{season:2}E{episode:2}",
    },
  });
  assert.equal(response.status, 200);
  const rows = (await response.json() as { rows: Array<{ key: string; from: string; to?: string; isFile: boolean; kind: string; status: string }> }).rows;
  assert.deepEqual(rows.map((row) => [row.key, row.from, row.to, row.isFile, row.kind, row.status]), [
    ["lib_00000001/Films/Heat", "Heat", "Heat (1995)", false, "movie", "rename"],
    ["lib_00000001/Loose/Ronin.mkv", "Ronin.mkv", "Ronin (1998).mkv", true, "movie", "rename"],
    ["lib_00000001/Shows/Dark/S01/Dark.S01E01.mkv", "Dark.S01E01.mkv", "Dark - S01E01.mkv", true, "episode", "rename"],
    ["lib_00000001/Shows/Dark/S01/Dark.S01E02.mkv", "Dark.S01E02.mkv", "Dark - S01E02.mkv", true, "episode", "rename"],
    ["lib_00000001/Unknown/Mystery.mkv", "Mystery.mkv", undefined, true, "unknown", "unidentified"],
  ]);
});

test("POST /api/library/rename-plan follows the identification, not the folder's shape", async (t) => {
  const root = await makeRoot();
  // A series kept flat in one folder the walk reads as a film: still renamed episode by episode.
  await put(root, "Flat/Show.S01E01.mkv");
  await put(root, "Flat/Show.S01E02.mkv");
  const units = [{
    key: "lib_00000001/Flat", kind: "movie" as const, relative: "Flat",
    sampleFiles: ["lib_00000001/Flat/Show.S01E01.mkv", "lib_00000001/Flat/Show.S01E02.mkv"],
  }];
  const harness = await mount([library("lib_00000001", root)], [], () => [], {
    units,
    records: { "lib_00000001/Flat": { type: "series", id: "tt9", name: "Show" } },
  });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, "/api/library/rename-plan", {
    method: "POST",
    body: { items: ["Flat"], moviePattern: "{title} ({year})", episodePattern: "{title} - S{season:2}E{episode:2}" },
  });
  const rows = (await response.json() as { rows: Array<{ key: string; to?: string; kind: string }> }).rows;
  assert.deepEqual(rows.map((row) => [row.key, row.to, row.kind]), [
    ["lib_00000001/Flat/Show.S01E01.mkv", "Show - S01E01.mkv", "episode"],
    ["lib_00000001/Flat/Show.S01E02.mkv", "Show - S01E02.mkv", "episode"],
  ]);
});

const posixName = (key: string) => key.slice(key.lastIndexOf("/") + 1);

test("POST /api/library/rename-plan reads each episode file as the library does", async (t) => {
  const root = await makeRoot();
  await put(root, "Shows/Dark/Dark.S01E01.mkv");
  await put(root, "Shows/Dark/Dark.S01E02.mkv");
  await put(root, "Shows/Dark/Dark.S01E03.mkv");
  const files = ["Dark.S01E01.mkv", "Dark.S01E02.mkv", "Dark.S01E03.mkv"].map((name) => `lib_00000001/Shows/Dark/${name}`);
  const harness = await mount([library("lib_00000001", root)], [], () => [], {
    units: [{ key: "lib_00000001/Shows/Dark", kind: "series" as const, relative: "Shows/Dark", sampleFiles: files }],
    records: {
      "lib_00000001/Shows/Dark": { type: "series", id: "tt3", name: "Dark" },
      // One file bound to a film, one unmatched on its own.
      [files[0]!]: { type: "movie", id: "tt7", name: "Other Film", year: "2001" },
      [files[1]!]: { type: "movie", id: "", unmatched: true },
    },
  });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });
  const response = await api(harness.base, "/api/library/rename-plan", {
    method: "POST",
    body: { items: ["Shows/Dark"], moviePattern: "{title} ({year})", episodePattern: "{title} - S{season:2}E{episode:2}" },
  });
  const rows = (await response.json() as { rows: Array<{ key: string; to?: string; kind: string; status: string }> }).rows;
  assert.deepEqual(rows.map((row) => [posixName(row.key), row.to, row.kind, row.status]), [
    ["Dark.S01E01.mkv", "Other Film (2001).mkv", "movie", "rename"],
    ["Dark.S01E02.mkv", undefined, "unknown", "unidentified"],
    ["Dark.S01E03.mkv", "Dark - S01E03.mkv", "episode", "rename"],
  ]);
});

test("POST /api/library/rename-plan refuses a film whose parts lie beside its key", async (t) => {
  const root = await makeRoot();
  await put(root, "Loose/Alien.cd1.mkv");
  await put(root, "Loose/Alien.cd2.mkv");
  const parts = ["lib_00000001/Loose/Alien.cd1.mkv", "lib_00000001/Loose/Alien.cd2.mkv"];
  const harness = await mount([library("lib_00000001", root)], [], () => [], {
    units: [{ key: parts[0]!, kind: "movie" as const, relative: parts[0]!, sampleFiles: parts }],
    records: { [parts[0]!]: { type: "movie", id: "tt1", name: "Alien", year: "1979" } },
  });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });
  const response = await api(harness.base, "/api/library/rename-plan", {
    method: "POST",
    body: { items: ["Loose/Alien.cd1.mkv"], moviePattern: "{title} ({year})", episodePattern: "{title}" },
  });
  const rows = (await response.json() as { rows: Array<{ status: string }> }).rows;
  assert.deepEqual(rows.map((row) => row.status), ["parts"]);
});

test("POST /api/library/rename-plan answers a folder that left the disk with the usual key", async (t) => {
  const root = await makeRoot();
  await put(root, "Kept/keep.txt");
  const harness = await mount([library("lib_00000001", root)], [], () => [], {
    units: [{ key: "lib_00000001/Gone/Heat.mkv", kind: "movie" as const, relative: "lib_00000001/Gone/Heat.mkv", sampleFiles: ["lib_00000001/Gone/Heat.mkv"] }],
    records: { "lib_00000001/Gone/Heat.mkv": { type: "movie", id: "tt1", name: "Heat", year: "1995" } },
  });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });
  const response = await api(harness.base, "/api/library/rename-plan", {
    method: "POST",
    body: { items: ["lib_00000001"], moviePattern: "{title} ({year})", episodePattern: "{title}" },
  });
  assert.equal(response.status, 409);
  const body = await response.json() as { messageKey?: string; error?: string };
  assert.equal(body.messageKey, "err.pathMissing");
  assert.ok(!body.error?.includes(root), "no host path in the answer");
});

test("POST /api/library/rename-plan refuses an invalid pattern with its catalogue key", async (t) => {
  const harness = await mount([library("lib_00000001", "/media/films")]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/library/rename-plan", {
    method: "POST",
    body: { items: ["Films/Heat.mkv"], moviePattern: "{title", episodePattern: "{title}" },
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { messageKey?: string }).messageKey, "err.renamePatternInvalid");
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

test("stored gallery addresses carry a replacement-sensitive version and use safe browser caching", async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, "Films/Heat.mkv");
  const art = path.join(root, "gallery.jpg");
  await writeFile(art, "first");
  const replacedAt = new Date("2026-01-02T03:04:05.000Z");
  await utimes(art, replacedAt, replacedAt);
  const fileStamp = async (file: string) => Math.round((await stat(file)).mtimeMs).toString(36);
  const harness = await mount([library("lib_00000001", root)], [], () => [], {
    gallery: [{ kind: "still", shape: "wide" }],
    galleryArtwork: (_key, index) => index === 0 ? art : undefined,
    artStamp: fileStamp,
  });
  t.after(() => harness.close());

  const gallery = await (await api(harness.base, "/api/library/gallery?path=Films%2FHeat.mkv")).json() as { images: Array<{ url: string }> };
  const first = new URL(gallery.images[0]!.url, harness.base);
  assert.equal(first.searchParams.get("gallery"), "0");
  assert.match(first.searchParams.get("v")!, /^[0-9a-z]+-/);

  const served = await fetch(first);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("cache-control"), "private, max-age=31536000, immutable");
  const etag = served.headers.get("etag")!;
  assert.ok(etag);
  const revalidated = await fetch(first, { headers: { "if-none-match": `"other", ${etag}` } });
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.headers.get("cache-control"), "private, max-age=31536000, immutable");

  await writeFile(art, "a replacement with another size");
  await utimes(art, replacedAt, replacedAt);
  const changed = await (await api(harness.base, "/api/library/gallery?path=Films%2FHeat.mkv")).json() as { images: Array<{ url: string }> };
  assert.notEqual(new URL(changed.images[0]!.url, harness.base).searchParams.get("v"), first.searchParams.get("v"),
    "a same-mtime replacement is still a new version");
  const stale = await fetch(first);
  assert.equal(stale.headers.get("cache-control"), "private, no-store", "an old version is never advertised as immutable");
  const unversioned = await fetch(`${harness.base}/api/library/thumb?path=Films%2FHeat.mkv&gallery=0`);
  assert.equal(unversioned.headers.get("cache-control"), "private, no-store");
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

// ---- review/path-reservations-a: proof tests ----

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

test("a rename holds its subtitle sidecars, so a delete of one meanwhile is refused", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat.mkv");
  await put(root, "Films/Heat.en.srt");
  const reached = deferred();
  const release = deferred();
  const harness = await mount([library("lib_00000001", root)], [], () => [], { recoverHold: { reached: reached.resolve, release: release.promise } });
  t.after(async () => { release.resolve(); await harness.close(); await rm(root, { recursive: true, force: true }); });

  const rename = api(harness.base, "/api/library/rename", { method: "POST", body: { path: "Films/Heat.mkv", name: "Thief" } });
  await reached.promise;
  // The intent already names Heat.en.srt as a sidecar that will follow the video.
  const remove = await api(harness.base, "/api/library/item?path=Films%2FHeat.en.srt", { method: "DELETE" });
  release.resolve();
  await rename;
  assert.equal(remove.status, 409, "a delete of a sidecar the rename is about to carry");
  assert.deepEqual(harness.calls.deleted, []);
});

test("a subtitle removed while a rename is under way does not leave the video and its bindings apart", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat.mkv");
  await put(root, "Films/Heat.en.srt");
  const reached = deferred();
  const release = deferred();
  const harness = await mount([library("lib_00000001", root)], [], () => [], { recoverHold: { reached: reached.resolve, release: release.promise } });
  t.after(async () => { release.resolve(); await harness.close(); await rm(root, { recursive: true, force: true }); });

  const rename = api(harness.base, "/api/library/rename", { method: "POST", body: { path: "Films/Heat.mkv", name: "Thief" } });
  await reached.promise;
  // What the admitted DELETE /api/library/item?path=Films/Heat.en.srt does on disk.
  await unlink(path.join(root, "Films/Heat.en.srt"));
  release.resolve();
  const response = await rename;
  const videoMoved = await exists(path.join(root, "Films/Thief.mkv"));
  const bindingsMoved = harness.calls.relocated.some((call) => call.nextKey === "lib_00000001/Films/Thief.mkv");
  assert.equal(videoMoved, bindingsMoved, `video renamed=${videoMoved}, bindings relocated=${bindingsMoved}, status ${response.status} ${JSON.stringify(await response.json())}`);
});

test("a subtitle removed during a case-only rename does not keep the journal unresolved", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat.mkv");
  await put(root, "Films/Heat.en.srt");
  // Only a volume that folds case makes `HEAT.mkv` the same file; elsewhere this is an ordinary rename.
  if (!(await exists(path.join(root, "Films/HEAT.mkv")))) { t.skip("the volume is case-sensitive"); return; }
  const reached = deferred();
  const release = deferred();
  const harness = await mount([library("lib_00000001", root)], [], () => [], { recoverHold: { reached: reached.resolve, release: release.promise }, caseInsensitive: true });
  t.after(async () => { release.resolve(); await harness.close(); await rm(root, { recursive: true, force: true }); });

  const rename = api(harness.base, "/api/library/rename", { method: "POST", body: { path: "Films/Heat.mkv", name: "HEAT" } });
  await reached.promise;
  await unlink(path.join(root, "Films/Heat.en.srt"));
  release.resolve();
  const response = await rename;
  const body = await response.text();
  assert.equal(response.status, 200, body);
  assert.ok(harness.calls.relocated.some((call) => call.nextKey === "lib_00000001/Films/HEAT.mkv"), "the bindings followed the video");
  const again = await api(harness.base, "/api/library/rename", { method: "POST", body: { path: "Films/HEAT.mkv", name: "Heat" } });
  assert.equal(again.status, 200, `the journal is resolved: ${await again.text()}`);
});

test("a subtitle replaced by another file during a case-only rename is still a conflict", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat.mkv");
  await put(root, "Films/Heat.en.srt");
  if (!(await exists(path.join(root, "Films/HEAT.mkv")))) { t.skip("the volume is case-sensitive"); return; }
  const reached = deferred();
  const release = deferred();
  const harness = await mount([library("lib_00000001", root)], [], () => [], { recoverHold: { reached: reached.resolve, release: release.promise }, caseInsensitive: true });
  t.after(async () => { release.resolve(); await harness.close(); await rm(root, { recursive: true, force: true }); });

  const rename = api(harness.base, "/api/library/rename", { method: "POST", body: { path: "Films/Heat.mkv", name: "HEAT" } });
  await reached.promise;
  await unlink(path.join(root, "Films/Heat.en.srt"));
  await writeFile(path.join(root, "Films/Heat.en.srt"), "a different subtitle");
  release.resolve();
  const response = await rename;
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { messageKey?: string }).messageKey, "err.libraryRecoveryConflict");
});

test("a name held by a rename is held in its other Unicode normalisation too", async (t) => {
  const root = await makeRoot();
  const nfc = "Films/Amélie.mkv";
  const nfd = "Films/Amélie.mkv";
  await put(root, nfc);
  const reached = deferred();
  const release = deferred();
  const harness = await mount([library("lib_00000001", root)], [], () => [], { recoverHold: { reached: reached.resolve, release: release.promise }, caseInsensitive: process.platform === "darwin" });
  t.after(async () => { release.resolve(); await harness.close(); await rm(root, { recursive: true, force: true }); });

  const rename = api(harness.base, "/api/library/rename", { method: "POST", body: { path: nfc, name: "Thief" } });
  await reached.promise;
  const sameFile = await exists(path.join(root, nfd));
  const remove = await api(harness.base, `/api/library/item?path=${encodeURIComponent(nfd)}`, { method: "DELETE" });
  release.resolve();
  await rename;
  assert.equal(remove.status, 409, `the NFD spelling of the held NFC name was admitted (the NFD spelling opens the held file on this volume: ${sameFile})`);
});

test("a file held through a nested library is held through a parent whose root is spelled through a symlink", async (t) => {
  const work = await makeRoot();
  const real = path.join(work, "real");
  const alias = path.join(work, "alias");
  await mkdir(path.join(real, "Films"), { recursive: true });
  await symlink(real, alias, "dir");
  await put(real, "Films/Heat.mkv");
  const parent = library("lib_0000000a", alias, 0);
  const child = library("lib_0000000b", path.join(await realpath(real), "Films"), 1);
  const reached = deferred();
  const release = deferred();
  const harness = await mount([parent, child], [], () => [], { relocateHold: { reached: reached.resolve, release: release.promise } });
  t.after(async () => { release.resolve(); await harness.close(); await rm(work, { recursive: true, force: true }); });

  const rename = api(harness.base, "/api/library/rename", { method: "POST", body: { path: "lib_0000000b/Heat.mkv", name: "Thief" } });
  await reached.promise;
  // The video is already Thief.mkv on disk; its bindings are still being moved.
  const remove = await api(harness.base, `/api/library/item?path=${encodeURIComponent("lib_0000000a/Films/Thief.mkv")}`, { method: "DELETE" });
  release.resolve();
  assert.equal((await rename).status, 200);
  assert.equal(remove.status, 409, "the same file reached through the parent library was admitted");
});

test("a new folder cannot take the name a rename in flight is moving to", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat/Heat.mkv");
  const reached = deferred();
  const release = deferred();
  const harness = await mount([library("lib_00000001", root)], [], () => [], { recoverHold: { reached: reached.resolve, release: release.promise } });
  t.after(async () => { release.resolve(); await harness.close(); await rm(root, { recursive: true, force: true }); });

  const rename = api(harness.base, "/api/library/rename", { method: "POST", body: { path: "Films/Heat", name: "Thief" } });
  await reached.promise;
  const created = await api(harness.base, "/api/library/folder", { method: "POST", body: { path: "Films", name: "Thief" } });
  release.resolve();
  const renamed = await rename;
  // Once the stray folder is gone, the same rename should simply be possible again.
  await rm(path.join(root, "Films/Thief"), { recursive: true, force: true });
  const again = await api(harness.base, "/api/library/rename", { method: "POST", body: { path: "Films/Heat", name: "Thief" } });
  assert.equal(created.status, 409, `folder create admitted onto a held rename target; rename answered ${renamed.status} ${JSON.stringify(await renamed.json())}; a retry after removing the stray folder answered ${again.status} ${JSON.stringify(await again.json())}`);
});
