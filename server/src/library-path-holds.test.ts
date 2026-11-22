import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { messageKeyOf } from "./errors.js";
import { LibraryRenameRecovery } from "./library-rename-recovery.js";
import { LibraryOps, type LibraryOp } from "./library-ops.js";
import { libraryPath, placed, realTarget, resolveLibraryPath, type LibraryRecord } from "./libraries.js";
import { heldOverlap, PathReservations, placesOverlap, reservationPause } from "./path-reservations.js";
import { registerContentRoutes, type ContentDeps } from "./routes/content.js";
import type { Store, UserPrefs } from "./store.js";
import type { UserRecord } from "./users.js";

const resolvePlaced = async (libraries: LibraryRecord[], key: string) => {
  const resolved = await resolveLibraryPath(libraries, key);
  return resolved && placed(resolved);
};

const ADA = "usr_00000001";
const admin = { id: ADA, username: "ada", role: "admin", secret: "ada-secret" } as unknown as UserRecord;

const library = (id: string, root: string, extra: Partial<LibraryRecord> = {}): LibraryRecord => ({
  id, name: id, type: "mixed", root, enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: false, ...extra,
});

const gate = () => {
  let open!: () => void;
  let reached!: () => void;
  const release = new Promise<void>((resolve) => { open = resolve; });
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  return { release, entered, open, reached };
};

/** The direct routes, with the real reservation set and the real path resolver. */
const mount = async (root: string, hooks: {
  demoteOnBusy?: boolean;
  invalidate?: () => void;
  onRename?: () => Promise<void>;
  onTransfer?: () => Promise<void>;
  onDelete?: (relative: string) => Promise<void>;
} = {}) => {
  const pathReservations = new PathReservations();
  const libraries = [library("lib_00000001", root)];
  let users = [admin];
  const deleted: string[] = [];
  const deps = {
    artStamp: async () => "stamp",
    artworkBusy: () => false,
    store: { libraries: () => libraries, users: () => users } as unknown as Store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: () => admin,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
    attachBrowseMeta: async (item: { path: string }) => ({ item, backfill: false }),
    carveOutsOf: () => new Set<string>(),
    nestedHidden: () => false,
    dataOf: () => ({ favorites: [], watchlist: {} }),
    deleteLibraryItem: async (relative: string) => { deleted.push(relative); await hooks.onDelete?.(relative); },
    fileExists: async (file: string) => { try { await realpath(file); return true; } catch { return false; } },
    galleryOf: () => [],
    galleryArtwork: () => undefined,
    healthOf: (record: LibraryRecord) => ({ unreachable: false, readOnly: false, realRoot: record.root, caseInsensitive: false }),
    heldTreeOf: async () => undefined,
    invalidateLibrary: () => hooks.invalidate?.(),
    libraryEntries: async () => [],
    libraryKey: (value: string) => value,
    libraryPathBusy: async (keys: string[], options?: { ignoreReservations?: boolean }) => {
      if (hooks.demoteOnBusy) users = [{ ...admin, role: "user" } as unknown as UserRecord];
      const items = options?.ignoreReservations ? [] : pathReservations.keys();
      if (!items.length) return undefined;
      for (const key of keys) {
        const wanted = await resolvePlaced(libraries, key);
        if (!wanted) continue;
        for (const item of items) {
          const active = await resolvePlaced(libraries, item);
          if (active && heldOverlap(active, wanted, false)) return item;
        }
      }
      return undefined;
    },
    libraryPathsBusy: async (keys: string[]) => {
      const busy = new Set<string>();
      for (const key of keys) {
        const wanted = await resolvePlaced(libraries, key);
        if (!wanted) continue;
        for (const item of pathReservations.keys()) {
          const active = await resolvePlaced(libraries, item);
          if (active && heldOverlap(active, wanted, false)) {
            busy.add(key);
            break;
          }
        }
      }
      return busy;
    },
    pathReservations,
    libraryRootBrowse: async () => ({ path: "", items: [], total: 0, pending: false }),
    libraryUnits: async () => [],
    locateArtwork: async () => undefined,
    locateFileArtwork: async () => undefined,
    locateFolderArtwork: async () => undefined,
    locateFolderArtworkPair: async () => ({ poster: undefined, wide: undefined }),
    markBrowsed: () => undefined,
    markersOf: () => ({}),
    metaStore: { qualifiedMeta: () => ({}), qualifiedSuggestions: () => ({}) },
    prefsOf: () => ({} as UserPrefs),
    progressOf: () => ({}),
    relativeKeyIn: (libraryId: string, key: string) => (key.startsWith(`${libraryId}/`) ? key.slice(libraryId.length + 1) : undefined),
    renameLibraryItem: async () => { await hooks.onRename?.(); },
    scheduleFileArtwork: () => undefined,
    scheduleFolderArtwork: () => undefined,
    sweepArtwork: async () => undefined,
    thumbUrl: async () => undefined,
    transferLibraryItem: async (relative: string) => { await hooks.onTransfer?.(); return relative; },
    wirePath: (key: string) => key,
    withFavorites: (items: Array<{ path: string }>) => items.map((item) => ({ ...item, favorite: false })),
  } as unknown as ContentDeps;
  const app = express();
  app.use(express.json());
  registerContentRoutes(app, deps);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error), messageKey: messageKeyOf(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    pathReservations,
    deleted,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

const BUSY = JSON.stringify({ error: "The item is busy with another library operation.", messageKey: "err.pathBusy" });
const NOT_ALLOWED = JSON.stringify({ error: "This account may not do that.", messageKey: "err.notAllowed" });

const call = (base: string, pathname: string, init: { method?: string; body?: unknown } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

test("a symlink and its target are one file to every guard", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-alias-"));
  try {
    const realDir = path.join(root, "Real");
    await mkdir(realDir, { recursive: true });
    await writeFile(path.join(realDir, "Heat.mkv"), "video");
    await symlink(realDir, path.join(root, "Alias"), "dir");
    const libraries = [library("lib_00000001", root), library("lib_00000002", path.join(root, "Alias"))];
    const viaReal = await resolvePlaced(libraries, "lib_00000001/Real/Heat.mkv");
    const viaAlias = await resolvePlaced(libraries, "lib_00000002/Heat.mkv");
    assert.ok(viaReal && viaAlias);
    assert.equal(await realpath(viaReal.absolute), await realpath(viaAlias.absolute));
    assert.notEqual(viaReal.absolute, viaAlias.absolute);

    const reservations = new PathReservations();
    const release = reservations.reserve([viaReal]);
    assert.ok(release);
    const move: LibraryOp = { op: "delete", items: [viaAlias.key] };
    // Asked while only the real spelling is held. Reserving the alias first would make the
    // queue wait for a hold this test created, which says nothing about the real one.
    const queueWaits = reservationPause(reservations, move, [viaAlias]) === "queue";
    const alias = reservations.reserve([viaAlias]);
    alias?.();
    assert.deepEqual({
      overlap: placesOverlap(viaReal.place, viaAlias.place, true),
      aliasHeldToo: alias === undefined,
      queueWaits,
    }, {
      overlap: true,
      aliasHeldToo: true,
      queueWaits: true,
    });
    release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a rename journal holds the same file reached through a symlink", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-alias-journal-"));
  const dataDir = path.join(root, "data");
  try {
    const realDir = path.join(root, "Real");
    await mkdir(realDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(realDir, "Heat.mkv"), "video");
    await symlink(realDir, path.join(root, "Alias"), "dir");
    const realKey = "lib_00000001/Real/Heat.mkv";
    const aliasKey = "lib_00000002/Heat.mkv";
    const libraries = [
      library("lib_00000001", root, { readOnly: true }),
      library("lib_00000002", path.join(root, "Alias")),
    ];
    const viaReal = await resolvePlaced(libraries, realKey);
    const viaAlias = await resolvePlaced(libraries, aliasKey);
    assert.ok(viaReal && viaAlias);
    assert.equal(await realpath(viaReal.absolute), await realpath(viaAlias.absolute));
    const intent = {
      version: 1,
      kind: "rename",
      operationId: "alias-rename",
      actorUserId: ADA,
      itemKind: "file",
      caseOnly: false,
      phase: "moving",
      from: realKey,
      to: "lib_00000001/Real/Ronin.mkv",
      sourceIdentity: "a".repeat(64),
      publishedIdentity: null,
      sidecars: [],
      artwork: [],
    };
    const dir = path.join(dataDir, "library-rename-intents");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "rename-alias-rename.json"), JSON.stringify(intent));
    const recovery = new LibraryRenameRecovery({
      dataDir,
      libraries: () => libraries,
      users: () => [admin],
      carveOutsOf: () => new Set(),
      healthOf: (record) => ({ unreachable: false, readOnly: false, realRoot: record.root, caseInsensitive: false }),
      refreshHealth: async () => undefined,
      actions: { relocateLibraryPath: async () => undefined },
      metaStore: { flushLibrary: async () => undefined },
      artworks: { dirOf: () => path.join(dataDir, "artwork"), file: (key: string) => key, written: async () => undefined, flush: async () => undefined },
      store: { flush: async () => undefined },
      invalidateLibrary: () => undefined,
    });
    await recovery.load();
    assert.equal(recovery.hasUnreadableRecord(), false, "the fixture journal has to be readable");
    assert.equal(recovery.hasUnresolved(), true, "recovery leaves the read-only library's journal in place");
    assert.equal(recovery.conflicts([realKey]), true, "the journaled key itself is busy");
    assert.equal(await recovery.holdsPlaces([viaAlias]), true, `${aliasKey} is ${realKey} on disk`);
    assert.equal(await recovery.holdsPlaces([{ place: path.join(path.dirname(viaAlias.place), "Thief.mkv") }]), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("NFC and NFD spellings of one directory are one place on a normalising volume", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-norm-"));
  try {
    const nfc = "Caf\u00e9";
    const nfd = nfc.normalize("NFD");
    await mkdir(path.join(root, nfc), { recursive: true });
    await writeFile(path.join(root, nfc, "Heat.mkv"), "video");
    const nfcPath = path.join(root, nfc, "Heat.mkv");
    const nfdPath = path.join(root, nfd, "Heat.mkv");
    const [realNfc, realNfd] = await Promise.all([realpath(nfcPath).catch(() => undefined), realpath(nfdPath).catch(() => undefined)]);
    if (!realNfc || !realNfd || realNfc !== realNfd || nfcPath === nfdPath) return;
    const reservations = new PathReservations();
    const release = reservations.reserve([{ key: "nfc", absolute: nfcPath }]);
    assert.ok(release);
    assert.deepEqual({
      overlap: placesOverlap(nfcPath, nfdPath, true),
      aliasHeldToo: reservations.reserve([{ key: "nfd", absolute: nfdPath }]) === undefined,
    }, { overlap: true, aliasHeldToo: true });
    release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a re-root waits for a reservation on the folder it is writing into", () => {
  const reservations = new PathReservations();
  const destination = "/libraries/other/Incoming/Show";
  const release = reservations.reserve([{ key: "lib_00000002/Incoming/Show", absolute: destination }]);
  assert.ok(release);
  const operation = {
    op: "reroot", items: ["Show"], libraryId: "lib_00000001", from: "/libraries/old", to: "/libraries/other/Incoming",
  } as LibraryOp;
  assert.equal(reservationPause(reservations, operation, []), "queue");
  release();
});

test("a paused re-root names the directory it is moving into", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-reroot-busy-"));
  const queues: LibraryOps[] = [];
  try {
    const from = path.join(root, "old");
    const to = path.join(root, "other", "Incoming");
    await mkdir(from, { recursive: true });
    await mkdir(to, { recursive: true });
    await writeFile(path.join(to, "Show"), "already here");
    const libraries = [library("lib_00000001", from), library("lib_00000002", path.join(root, "other"))];
    const queue = new LibraryOps({
      file: path.join(root, "ops.json"),
      retryMs: 60_000,
      pause: () => "playback",
      execute: async () => ({}),
    });
    queues.push(queue);
    await queue.load();
    await queue.enqueue({ op: "reroot", items: ["Show"], libraryId: "lib_00000001", from, to });
    const roots = queue.activeRoots();
    const destination = await resolvePlaced(libraries, "lib_00000002/Incoming/Show");
    assert.ok(destination);
    const covered = (await Promise.all(roots.map((root) => realTarget(root))))
      .some((place) => placesOverlap(place, destination.place, true));
    assert.equal(covered, true, `re-root roots [${roots.join(", ")}] do not cover ${destination.place}`);
  } finally {
    for (const queue of queues) {
      queue.stop();
      await queue.flush();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Film is not Films, and a trailing separator is still the same directory", () => {
  assert.equal(placesOverlap("/media/Film", "/media/Films", true), false);
  assert.equal(placesOverlap("/media/Films", "/media/Films/Heat.mkv", true), true);
  const reservations = new PathReservations();
  const release = reservations.reserve([{ key: "dir", absolute: "/media/Films/" }]);
  assert.ok(release);
  assert.equal(reservations.reserve([{ key: "child", absolute: "/media/Films/Heat.mkv" }]), undefined);
  assert.ok(reservations.reserve([{ key: "longer", absolute: "/media/Films-extra/Heat.mkv" }]));
  release();
});

test("renaming a video holds its subtitle, so a delete of the subtitle waits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-sidecar-"));
  const hold = gate();
  const harness = await mount(root, { onRename: async () => { hold.reached(); await hold.release; } });
  try {
    await mkdir(path.join(root, "Films"), { recursive: true });
    await writeFile(path.join(root, "Films", "Heat.mkv"), "video");
    await writeFile(path.join(root, "Films", "Heat.en.srt"), "subtitle");
    const renaming = call(harness.base, "/api/library/rename", { method: "POST", body: { path: "Films/Heat.mkv", name: "Ronin" } });
    await hold.entered;
    const sidecar = path.join(root, "Films", "Heat.en.srt");
    const removed = await call(harness.base, `/api/library/item?path=${encodeURIComponent("Films/Heat.en.srt")}`, { method: "DELETE" });
    const text = await removed.text();
    const observed = {
      status: removed.status,
      body: text,
      deleted: [...harness.deleted],
      subtitleHeld: harness.pathReservations.overlaps([{ absolute: sidecar, place: await realpath(sidecar) }]),
    };
    hold.open();
    await renaming;
    assert.deepEqual(observed, { status: 409, body: BUSY, deleted: [], subtitleHeld: true });
  } finally {
    hold.open();
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a direct move holds the subtitle beside the video", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-move-sidecar-"));
  const hold = gate();
  const harness = await mount(root, { onTransfer: async () => { hold.reached(); await hold.release; } });
  try {
    await mkdir(path.join(root, "Films"), { recursive: true });
    await mkdir(path.join(root, "Archive"), { recursive: true });
    await writeFile(path.join(root, "Films", "Heat.mkv"), "video");
    await writeFile(path.join(root, "Films", "Heat.en.srt"), "subtitle");
    const moving = call(harness.base, "/api/library/move", { method: "POST", body: { path: "Films/Heat.mkv", folder: "Archive" } });
    await hold.entered;
    const removed = await call(harness.base, `/api/library/item?path=${encodeURIComponent("Films/Heat.en.srt")}`, { method: "DELETE" });
    const text = await removed.text();
    const observed = { status: removed.status, body: text, deleted: [...harness.deleted] };
    hold.open();
    await moving;
    assert.deepEqual(observed, { status: 409, body: BUSY, deleted: [] });
  } finally {
    hold.open();
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a move of a folder link waits while something works on a file reached through it", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-move-link-"));
  const hold = gate();
  let transfers = 0;
  // Only the first transfer waits: a second one let through answers at once instead of hanging.
  const harness = await mount(root, { onTransfer: async () => { transfers += 1; if (transfers === 1) { hold.reached(); await hold.release; } } });
  try {
    await mkdir(path.join(root, "Real"), { recursive: true });
    await mkdir(path.join(root, "Archive"), { recursive: true });
    await writeFile(path.join(root, "Real", "Heat.mkv"), "video");
    await symlink(path.join(root, "Real"), path.join(root, "Alias"), "dir");
    const moving = call(harness.base, "/api/library/move", { method: "POST", body: { path: "Alias/Heat.mkv", folder: "Archive" } });
    await hold.entered;
    const second = await call(harness.base, "/api/library/move", { method: "POST", body: { path: "Alias", folder: "Archive" } });
    const observed = { status: second.status, body: await second.text() };
    hold.open();
    await moving;
    assert.deepEqual(observed, { status: 409, body: BUSY });
  } finally {
    hold.open();
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("delete refuses once the account is demoted during the busy check", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-auth-delete-"));
  const harness = await mount(root, { demoteOnBusy: true });
  try {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "Heat.mkv"), "video");
    const response = await call(harness.base, `/api/library/item?path=${encodeURIComponent("Heat.mkv")}`, { method: "DELETE" });
    const text = await response.text();
    assert.deepEqual({ status: response.status, body: text, deleted: [...harness.deleted] }, { status: 403, body: NOT_ALLOWED, deleted: [] });
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("move refuses once the account is demoted during the busy check", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-auth-move-"));
  const harness = await mount(root, { demoteOnBusy: true });
  try {
    await mkdir(path.join(root, "Films"), { recursive: true });
    await mkdir(path.join(root, "Archive"), { recursive: true });
    await writeFile(path.join(root, "Films", "Heat.mkv"), "video");
    const response = await call(harness.base, "/api/library/move", {
      method: "POST", body: { path: "Films/Heat.mkv", folder: "Archive" },
    });
    const text = await response.text();
    assert.equal(response.status, 403, text);
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a rename refuses once the account is demoted during the opening busy check", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-auth-rename-"));
  let renamed = false;
  const harness = await mount(root, {
    demoteOnBusy: true,
    onRename: async () => { renamed = true; },
  });
  try {
    await mkdir(path.join(root, "Films"), { recursive: true });
    await writeFile(path.join(root, "Films", "Heat.mkv"), "video");
    const response = await call(harness.base, "/api/library/rename", { method: "POST", body: { path: "Films/Heat.mkv", name: "Ronin" } });
    const text = await response.text();
    assert.deepEqual({ status: response.status, renamed, held: harness.pathReservations.keys() }, { status: 403, renamed: false, held: [] });
    assert.match(text, /err\.notAllowed/);
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a rename that fails while dropping the library cache still releases its reservation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-leak-"));
  const harness = await mount(root, { invalidate: () => { throw new Error("cache invalidate failed"); } });
  try {
    await mkdir(path.join(root, "Films"), { recursive: true });
    await writeFile(path.join(root, "Films", "Heat.mkv"), "video");
    const first = await call(harness.base, "/api/library/rename", { method: "POST", body: { path: "Films/Heat.mkv", name: "Ronin" } });
    await first.text();
    const held = harness.pathReservations.keys();
    const target = await resolvePlaced([library("lib_00000001", root)], libraryPath("lib_00000001", "Films/Ronin.mkv"));
    assert.ok(target, "the name the rename reserved still resolves");
    const second = await call(harness.base, `/api/library/item?path=${encodeURIComponent("Films/Ronin.mkv")}`, { method: "DELETE" });
    await second.text();
    assert.deepEqual({
      held,
      second: second.status,
      queuePause: reservationPause(harness.pathReservations, { op: "delete", items: [target.key] }, [target]),
    }, {
      held: [],
      second: 204,
      queuePause: undefined,
    });
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});
