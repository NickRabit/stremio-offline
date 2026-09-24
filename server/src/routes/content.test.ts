import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { messageKeyOf } from "../errors.js";
import { libraryPath, parseLibraryPath, relativeWithin, resolveLibraryPath, visibleLibraries, type LibraryRecord } from "../libraries.js";
import type { LibraryMetaRecord, LibrarySuggestion } from "../library-match.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import { isPathWithin, type LibraryEntry } from "../library.js";
import type { Store, UserPrefs } from "../store.js";
import { emptyUserData, type UserRecord } from "../users.js";
import { registerContentRoutes, type ContentDeps } from "./content.js";

const instancePrefs: UserPrefs = {
  uiLanguage: "en", audioLanguage: "en", subtitleLanguage: "en", downloadTitleLanguage: "ui",
  mergeByName: false, streamSort: "recommended", trackProgress: true, showResumeRow: true,
  catalogTileSize: "medium", libraryTileSize: "medium", catalogTileShape: "poster", libraryTileShape: "poster",
};

interface Calls {
  browsed: string[];
  rootBrowses: number;
  deleted: string[];
  transfers: Array<{ relative: string; folder: string; copy: boolean | undefined; confirmTypeMismatch: boolean | undefined }>;
  relocated: Array<{ key: string; nextKey: string }>;
  thumbAsked: string[];
  entriesAsked: number;
  artworkAsked: string[];
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
  units?: import("../library-match.js").TitleUnit[];
  /** A fake catalogue picture per key, so a test can see where a mosaic reads its posters. */
  artwork?: (key: string) => string | undefined;
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
  const calls: Calls = { browsed: [], rootBrowses: 0, deleted: [], transfers: [], relocated: [], thumbAsked: [], entriesAsked: 0, artworkAsked: [] };
  const deps: ContentDeps = {
    store: { libraries: () => libraries, users: () => [admin, ordinary] } as unknown as Store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: (req) => (req.header("x-user") === BOB ? ordinary : admin),
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
    attachBrowseMeta: (item) => ({ item, backfill: false }),
    carveOutsOf: () => new Set(),
    dataOf: () => ({ ...emptyUserData(), favorites: state.favorites ?? [] }),
    deleteLibraryItem: async (relative) => { calls.deleted.push(relative); },
    fileExists: async (file) => exists(file),
    galleryOf: () => [],
    galleryArtwork: () => undefined,
    healthOf: (record) => ({ unreachable: false, readOnly: false, realRoot: record.root, caseInsensitive: false }),
    invalidateLibrary: () => undefined,
    libraryEntries: async () => { calls.entriesAsked += 1; return entries; },
    libraryKey: (value) => {
      const parsed = parseLibraryPath(value);
      if (parsed) return libraryPath(parsed.libraryId, parsed.relative);
      return libraries.length === 1 ? libraryPath(libraries[0]!.id, value) : value;
    },
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
    libraryRootBrowse: async (viewer) => {
      calls.rootBrowses += 1;
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
    progressOf: () => ({}),
    relativeKeyIn: (libraryId, key) => (key.startsWith(`${libraryId}/`) ? key.slice(libraryId.length + 1) : undefined),
    relocateLibraryPath: async (key, nextKey) => { calls.relocated.push({ key, nextKey }); },
    scheduleFileArtwork: () => undefined,
    scheduleFolderArtwork: () => undefined,
    sweepArtwork: async () => undefined,
    thumbUrl: async (param, value, art) => (art ? `${param}:${value}` : undefined),
    transferLibraryItem: async (relative, folder, copy, _progress, confirmTypeMismatch) => {
      calls.transfers.push({ relative, folder, copy, confirmTypeMismatch });
      return `library/${relative}`;
    },
    wirePath: (key) => (libraries.length === 1 ? relativeWithin(libraries[0]!.id, key) : key),
    withFavorites: (items) => items.map((item) => ({ ...item, favorite: false })),
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
    items: Array<{ path: string; kind: string; posters?: string[]; poster?: string }>; pending: boolean;
  };
  const collection = body.items.find((item) => item.path === "Collection")!;
  assert.equal(collection.kind, "folder");
  assert.deepEqual(collection.posters, ["path:Collection/Heat (1995).mkv", "path:Collection/Ronin (1998).mkv"],
    "one catalogue picture per distinct film, deduplicated by identity");
  assert.equal(collection.poster, undefined, "the collection shows the mosaic instead of a folder frame");
  const solo = body.items.find((item) => item.path === "Solo")!;
  assert.equal(solo.posters, undefined, "a folder holding one film keeps its own poster");
  assert.equal(solo.poster, "dir:Solo");
  assert.equal(body.pending, false, "a mosaic is not a missing poster and does not keep the page asking");
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
  assert.deepEqual(harness.calls.artworkAsked, ["lib_00000001/Films"], "the key is looked up among the library entries");
});
