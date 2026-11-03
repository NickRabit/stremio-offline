import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { messageKeyOf } from "../errors.js";
import { libraryPath, parseLibraryPath, type LibraryRecord } from "../libraries.js";
import { LibrarySeenStore } from "../library-seen.js";
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
  seen: LibrarySeenStore;
  remotePool: MediaServerShufflePool;
  remoteCurrent: boolean;
  close(): Promise<void>;
}

const mount = async (): Promise<Harness> => {
  const seenDir = await mkdtemp(path.join(tmpdir(), "shuffle-seen-"));
  const seen = new LibrarySeenStore(seenDir);
  await seen.load();
  const libraries = [library()];
  const available = new Set<string>();
  const state: { remotePool: MediaServerShufflePool; remoteCurrent: boolean } = {
    remotePool: { items: [], capped: false },
    remoteCurrent: true,
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
      shufflePool: async () => state.remotePool,
      shuffleStillCurrent: () => state.remoteCurrent,
    } as unknown as MediaServerManager,
    seen,
    metaStore: { qualifiedMeta: () => ({}), episodes: () => ({}) } as unknown as LibraryMetaStore,
    describeLibraryPath: async (key) => {
      const parsed = parseLibraryPath(key);
      return parsed ? {
        kind: "folder", path: parsed.relative,
        name: parsed.relative.slice(parsed.relative.lastIndexOf("/") + 1),
        fileCount: 0, size: 0, modified: "2026-01-01T00:00:00.000Z",
      } : undefined;
    },
    libraryKey: (value) => parseLibraryPath(value) ? value : libraryPath(LIBRARY_ID, value),
    wirePath: (key) => {
      const parsed = parseLibraryPath(key);
      return parsed?.libraryId === LIBRARY_ID ? parsed.relative : key;
    },
    fileAvailable: async (key) => available.has(key),
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
    seen,
    get remotePool() { return state.remotePool; },
    set remotePool(value) { state.remotePool = value; },
    get remoteCurrent() { return state.remoteCurrent; },
    set remoteCurrent(value) { state.remoteCurrent = value; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(seenDir, { recursive: true, force: true });
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
  harness.seen.observe(LIBRARY_ID, files.map((relative) => ({
    relative, size: 1, modified: "2026-01-01T00:00:00.000Z",
  })), new Date("2026-01-02T00:00:00.000Z"));
  for (const relative of files) harness.available.add(libraryPath(LIBRARY_ID, relative));
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
