import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { messageKeyOf } from "../errors.js";
import { isPathWithin } from "../library.js";
import { libraryPath, parseLibraryPath, type LibraryRecord } from "../libraries.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import type { MediaServerManager, MediaServerShufflePool } from "../media-server-manager.js";
import { roleMiddleware } from "../roles.js";
import type { Store } from "../store.js";
import type { UserRecord } from "../users.js";
import { registerShuffleRoutes, type ShuffleDeps } from "./shuffle.js";

const ALICE = "usr_00000001";
const BOB = "usr_00000002";
const LIBRARY_ID = "lib_00000001";

const library = (): LibraryRecord => ({
  id: LIBRARY_ID,
  name: "Films",
  type: "mixed",
  root: "/library",
  enabled: true,
  order: 0,
  addedAt: "2026-01-01T00:00:00.000Z",
  writeArtwork: false,
  visibleTo: [ALICE, BOB],
});

interface Harness {
  base: string;
  libraries: LibraryRecord[];
  available: Set<string>;
  files: Set<string>;
  carveOuts: Set<string>;
  remotePool: MediaServerShufflePool;
  remoteCurrent: boolean;
  state: {
    folderChecks: string[]; missingFolders: Set<string>;
    remoteEarly: MediaServerShufflePool["items"]; remoteLate: MediaServerShufflePool["items"]; remoteRest?: Promise<void>;
  };
  close(): Promise<void>;
}

const mount = async (): Promise<Harness> => {
  const libraries = [library()];
  const available = new Set<string>();
  const files = new Set<string>();
  const carveOuts = new Set<string>();
  const state: {
    remotePool: MediaServerShufflePool; remoteCurrent: boolean; folderChecks: string[]; missingFolders: Set<string>;
    remoteEarly: MediaServerShufflePool["items"]; remoteLate: MediaServerShufflePool["items"]; remoteRest?: Promise<void>;
  } = {
    remoteEarly: [],
    remoteLate: [],
    remotePool: { items: [], capped: false },
    remoteCurrent: true,
    folderChecks: [],
    missingFolders: new Set(),
  };
  const userOf = (req?: express.Request): UserRecord | undefined => {
    const id = req?.header("x-user");
    if (id !== ALICE && id !== BOB) return undefined;
    return {
      id, username: id, passwordHash: "", secret: "secret", role: "user",
      createdAt: "", permissions: { downloadToLibrary: false, downloadToDevice: false }, permissionsVersion: 0,
    };
  };
  const deps: ShuffleDeps = {
    store: { libraries: () => libraries } as unknown as Store,
    needsSetup: () => false,
    currentSession: (req) => {
      const user = userOf(req);
      return user ? { userId: user.id, sid: req.header("x-sid") ?? "sid_alice", expiresAt: Date.now() + 60_000 } : undefined;
    },
    currentUser: userOf,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
    authorityOf: () => ({ actor: { id: ALICE, secret: "secret" }, assertCurrent: () => undefined }),
    mediaServers: {
      shufflePool: async (_authority: unknown, _library: unknown, _parent: unknown, _signal: unknown,
        progressive?: { more: (items: MediaServerShufflePool["items"]) => void; wanted: () => boolean }) => {
        // Pages that arrive while the run is being built, then pages that arrive after it.
        if (progressive && state.remoteEarly.length) progressive.more(state.remoteEarly);
        const rest = progressive && state.remoteLate.length
          ? new Promise<void>((resolve) => setTimeout(() => { if (progressive.wanted()) progressive.more(state.remoteLate); resolve(); }, 20))
          : undefined;
        state.remoteRest = rest;
        return { ...state.remotePool, total: state.remotePool.items.length + state.remoteEarly.length + state.remoteLate.length, ...(rest ? { rest } : {}) };
      },
      shuffleStillCurrent: () => state.remoteCurrent,
    } as unknown as MediaServerManager,
    metaStore: { qualifiedMeta: () => ({}), episodes: () => ({}) } as unknown as LibraryMetaStore,
    localFiles: async (_libraryId, relativePrefix) =>
      [...files].filter((relative) => relativePrefix === "" || isPathWithin(relative, relativePrefix)),
    folderAvailable: async (key) => {
      state.folderChecks.push(key);
      return parseLibraryPath(key) !== undefined && !state.missingFolders.has(key);
    },
    libraryKey: (value) => parseLibraryPath(value) ? value : libraryPath(LIBRARY_ID, value),
    wirePath: (key) => {
      const parsed = parseLibraryPath(key);
      return parsed?.libraryId === LIBRARY_ID ? parsed.relative : key;
    },
    fileAvailable: async (key) => available.has(key),
    isCarvedOut: (key) => {
      const parsed = parseLibraryPath(key);
      return Boolean(parsed && [...carveOuts].some((folder) => isPathWithin(parsed.relative, folder)));
    },
  };
  const app = express();
  app.use(express.json());
  app.use("/api", roleMiddleware({
    isOpen: () => false,
    isInternal: () => false,
    roleOf: (req) => userOf(req)?.role,
  }));
  registerShuffleRoutes(app, deps);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 400;
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
    libraries,
    available,
    files,
    carveOuts,
    state,
    get remotePool() { return state.remotePool; },
    set remotePool(value) { state.remotePool = value; },
    get remoteCurrent() { return state.remoteCurrent; },
    set remoteCurrent(value) { state.remoteCurrent = value; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

const api = (base: string, pathname: string, init: { method?: string; body?: unknown; user?: string; sid?: string } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      "x-user": init.user ?? ALICE,
      "x-sid": init.sid ?? "sid_alice",
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

type Item = { path: string; title: string };
type Step = { item: Item | null; exhausted?: true };

const seed = (harness: Harness, files: string[]) => {
  for (const relative of files) {
    harness.files.add(relative);
    harness.available.add(libraryPath(LIBRARY_ID, relative));
  }
};

test("start in a nested folder includes only that folder and its subfolders", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  seed(harness, [
    "yyy/xxx/at-parent.mkv",
    "yyy/xxx/zzz/first.mkv",
    "yyy/xxx/zzz/sub/second.mkv",
  ]);

  const started = await api(harness.base, "/api/shuffle", { method: "POST", body: { path: "yyy/xxx/zzz" } });
  assert.equal(started.status, 200);
  const first = await started.json() as { id: string; item: Item };
  const paths = [first.item.path];
  for (;;) {
    const next = await api(harness.base, `/api/shuffle/${first.id}/next`, { method: "POST" });
    const step = await next.json() as Step;
    if (!step.item) break;
    paths.push(step.item.path);
  }
  assert.deepEqual(paths.sort(), ["yyy/xxx/zzz/first.mkv", "yyy/xxx/zzz/sub/second.mkv"]);
});

test("another account or sign-in session cannot use the shuffle", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  seed(harness, ["Film.mkv"]);
  const started = await api(harness.base, "/api/shuffle", { method: "POST", body: { path: "" } });
  const { id } = await started.json() as { id: string };

  assert.equal((await api(harness.base, `/api/shuffle/${id}/next`, { method: "POST", user: BOB })).status, 404);
  assert.equal((await api(harness.base, `/api/shuffle/${id}/next`, { method: "POST", sid: "sid_other" })).status, 404);
});

test("a revoked library ends the run instead of issuing another item", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  seed(harness, ["One.mkv", "Two.mkv"]);
  const started = await api(harness.base, "/api/shuffle", { method: "POST", body: { path: "" } });
  const { id } = await started.json() as { id: string };
  harness.libraries[0]!.enabled = false;

  const next = await api(harness.base, `/api/shuffle/${id}/next`, { method: "POST" });
  assert.equal(next.status, 200);
  assert.deepEqual(await next.json(), { item: null, exhausted: true });
});

test("a deleted file is skipped and does not count as played", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  seed(harness, ["One.mkv"]);
  const started = await api(harness.base, "/api/shuffle", { method: "POST", body: { path: "" } });
  const { id } = await started.json() as { id: string };
  harness.available.clear();

  const next = await api(harness.base, `/api/shuffle/${id}/next`, { method: "POST" });
  assert.deepEqual(await next.json(), { item: null, exhausted: true });
});

test("a file found by the walk is playable before the seen sweep records it", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  seed(harness, ["Hand-copied.mkv"]);
  const started = await api(harness.base, "/api/shuffle", { method: "POST", body: { path: "" } });
  assert.equal(started.status, 200);
  assert.equal((await started.json() as { item: Item }).item.path, "Hand-copied.mkv");
});

test("a nested library carve-out is never shuffled through its parent", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  seed(harness, ["Visible.mkv", "Nested/Secret.mkv"]);
  harness.carveOuts.add("Nested");

  const started = await api(harness.base, "/api/shuffle", { method: "POST", body: { path: "" } });
  const first = await started.json() as { id: string; item: Item };
  const paths = [first.item.path];
  for (;;) {
    const next = await api(harness.base, `/api/shuffle/${first.id}/next`, { method: "POST" });
    const step = await next.json() as Step;
    if (!step.item) break;
    paths.push(step.item.path);
  }
  assert.deepEqual(paths, ["Visible.mkv"]);
});

test("an ordinary user may start a random run", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  seed(harness, ["One.mkv"]);
  const started = await api(harness.base, "/api/shuffle", { method: "POST", body: { path: "" } });
  assert.equal(started.status, 200);
});

test("a remote run answers remote items and ends when its connection changes", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  harness.remotePool = {
    capped: true,
    items: [
      { libraryId: "rlib_00000000000000000000000000000001", itemId: "movie-1", title: "One", generation: 4 },
      { libraryId: "rlib_00000000000000000000000000000001", itemId: "episode-1", title: "Show · S1E1 Pilot", season: 1, episode: 1, generation: 4 },
    ],
  };
  const started = await api(harness.base, "/api/shuffle", {
    method: "POST",
    body: { remote: { libraryId: "rlib_00000000000000000000000000000001", parentId: "folder-1" } },
  });
  assert.equal(started.status, 200);
  const first = await started.json() as { id: string; item: { path?: string; remote?: { libraryId: string; itemId: string } }; capped?: true };
  assert.equal(first.capped, true);
  assert.equal(first.item.path, undefined);
  assert.deepEqual(first.item.remote, { libraryId: "rlib_00000000000000000000000000000001", itemId: first.item.remote?.itemId });

  harness.remoteCurrent = false;
  const next = await api(harness.base, `/api/shuffle/${first.id}/next`, { method: "POST" });
  assert.deepEqual(await next.json(), { item: null, exhausted: true });
});

test("a local start checks the folder with one look instead of describing the whole tree", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  seed(harness, ["Shows/A/S01E01.mkv", "Shows/A/S01E02.mkv"]);

  const started = await api(harness.base, "/api/shuffle", { method: "POST", body: { path: "Shows" } });
  assert.equal(started.status, 200);
  assert.deepEqual(harness.state.folderChecks, [libraryPath(LIBRARY_ID, "Shows")]);

  harness.state.missingFolders.add(libraryPath(LIBRARY_ID, "Gone"));
  const missing = await api(harness.base, "/api/shuffle", { method: "POST", body: { path: "Gone" } });
  assert.equal(missing.status, 404);
});

test("a remote run starts on the first page and takes the rest of the pool as it arrives", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const item = (id: string) => ({ libraryId: "rlib_00000000000000000000000000000001", itemId: id, title: id, generation: 4 });
  harness.remotePool = { capped: false, items: [item("first-1"), item("first-2")] };
  harness.state.remoteEarly = [item("early-1")];
  harness.state.remoteLate = [item("late-1"), item("late-2")];

  const started = await api(harness.base, "/api/shuffle", {
    method: "POST",
    body: { remote: { libraryId: "rlib_00000000000000000000000000000001" } },
  });
  assert.equal(started.status, 200);
  const first = await started.json() as { id: string; total: number; item: { remote: { itemId: string } } };
  assert.equal(first.total, 5);
  await harness.state.remoteRest;
  const seen = [first.item.remote.itemId];
  for (;;) {
    const next = await api(harness.base, `/api/shuffle/${first.id}/next`, { method: "POST" });
    const step = await next.json() as { item: { remote: { itemId: string } } | null };
    if (!step.item) break;
    seen.push(step.item.remote.itemId);
  }
  assert.deepEqual([...seen].sort(), ["early-1", "first-1", "first-2", "late-1", "late-2"]);
});
