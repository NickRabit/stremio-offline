import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { messageKeyOf } from "../errors.js";
import { relativeWithin, type LibraryRecord } from "../libraries.js";
import type { LibraryEntry } from "../library.js";
import type { Store, UserPrefs } from "../store.js";
import { emptyUserData } from "../users.js";
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

const library = (id: string, root: string, order = 0): LibraryRecord => ({
  id, name: `Library ${id}`, type: "mixed", root, enabled: true, order,
  addedAt: "2024-01-01T00:00:00.000Z", writeArtwork: false,
});

const put = async (root: string, relative: string) => {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), "video");
};

const exists = async (file: string) => Boolean(await stat(file).catch(() => undefined));

const makeRoot = () => mkdtemp(path.join(tmpdir(), "stremio-content-"));

/** The routes take everything they need from the context, so the app here is a real express
 *  instance over fake collaborators that record what they were asked to do. The filesystem
 *  is real: the resolver, the browse walk and the name checks are module singletons. */
const mount = async (libraries: LibraryRecord[], entries: LibraryEntry[] = []): Promise<Harness> => {
  const calls: Calls = { browsed: [], rootBrowses: 0, deleted: [], transfers: [], relocated: [], thumbAsked: [], entriesAsked: 0, artworkAsked: [] };
  const rootBrowse = { path: "", items: libraries.map((record) => ({ kind: "library", libraryId: record.id, name: record.name })), total: libraries.length, pending: false };
  const deps: ContentDeps = {
    store: { libraries: () => libraries } as unknown as Store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: () => undefined,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    attachBrowseMeta: (item) => ({ item, backfill: false }),
    carveOutsOf: () => new Set(),
    dataOf: () => emptyUserData(),
    deleteLibraryItem: async (relative) => { calls.deleted.push(relative); },
    fileExists: async (file) => exists(file),
    invalidateLibrary: () => undefined,
    libraryEntries: async () => { calls.entriesAsked += 1; return entries; },
    libraryKey: (value) => value,
    libraryRootBrowse: async () => { calls.rootBrowses += 1; return rootBrowse; },
    locateArtwork: async (entry) => { calls.artworkAsked.push(entry.key); return undefined; },
    locateFileArtwork: async (key) => { calls.thumbAsked.push(key); return undefined; },
    locateFolderArtwork: async (key) => { calls.thumbAsked.push(key); return undefined; },
    locateFolderArtworkPair: async () => ({ poster: undefined, wide: undefined }),
    markBrowsed: (record) => { calls.browsed.push(record.id); },
    prefsOf: () => instancePrefs,
    progressOf: () => ({}),
    relativeKeyIn: (libraryId, key) => (key.startsWith(`${libraryId}/`) ? key.slice(libraryId.length + 1) : undefined),
    relocateLibraryPath: async (key, nextKey) => { calls.relocated.push({ key, nextKey }); },
    scheduleFileArtwork: () => undefined,
    scheduleFolderArtwork: () => undefined,
    singleLibrary: () => libraries[0]!,
    sweepArtwork: async () => undefined,
    thumbUrl: async () => undefined,
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

const api = (base: string, pathname: string, init: { method?: string; body?: unknown } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
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

test("GET /api/library/browse marks the library it read as browsed", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat.mkv");
  const harness = await mount([library("lib_00000001", root)]);
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, "/api/library/browse?path=Films");

  assert.equal(response.status, 200);
  assert.deepEqual(harness.calls.browsed, ["lib_00000001"]);
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
test("POST /api/library/rename keeps a name that would leave the library inside the folder", async (t) => {
  const root = await makeRoot();
  await put(root, "Films/Heat.mkv");
  const harness = await mount([library("lib_00000001", root)]);
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, "/api/library/rename", { method: "POST", body: { path: "Films/Heat.mkv", name: "../../Thief" } });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { path: "Films/video.mkv" });
  assert.equal(await exists(path.join(root, "Films/video.mkv")), true);
  assert.equal(await exists(path.join(root, "Thief.mkv")), false);
  assert.deepEqual(harness.calls.relocated, [{ key: "lib_00000001/Films/Heat.mkv", nextKey: "lib_00000001/Films/video.mkv" }]);
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
  assert.deepEqual(harness.calls.thumbAsked, ["Films/Missing.mkv"]);
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
