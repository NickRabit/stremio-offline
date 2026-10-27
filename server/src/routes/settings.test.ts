import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import type { DownloadQueue } from "../downloads.js";
import { messageKeyOf } from "../errors.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import type { MediaServerAuthority, MediaServerManager } from "../media-server-manager.js";
import { prepareMediaServerConfiguration } from "../media-server-store.js";
import { assertStillAdmin, ForbiddenError } from "../roles.js";
import { defaultInstanceSettings, defaultPrefs, type State, type Store, type UserPrefs } from "../store.js";
import type { AddonRecord } from "../types.js";
import { emptyUserData, type Role, type UserData, type UserRecord } from "../users.js";
import { homeCatalogRowId, homeFeedSelectionKey } from "../home.js";
import { registerSettingsRoutes, type SettingsDeps } from "./settings.js";

const ADA = "usr_00000001";
const BOB = "usr_00000002";
const CAROL = "usr_00000003";
const STREAM_SORTS = new Set(["recommended", "size-desc", "size-asc", "addon"]);

interface Harness {
  base: string;
  state: State;
  onStopContent?: (opts: { userId?: string; libraryId?: string; addonKey?: string }) => void;
  onFlush?: () => Promise<void>;
  /** How many writes are waiting for `releaseWrites`, so a test can interleave two of them. */
  pendingWrites(): number;
  /** How many writes the route made in total, so a test can prove they landed together. */
  writes(): number;
  holdWrites(): void;
  releaseWrites(): void;
  close(): Promise<void>;
}

/** The routes read the instance half and one person's half out of the same state object, so
 *  the harness keeps a real one and remembers which caller a request speaks for. */
const mount = async (): Promise<Harness> => {
  const state = {
    // `users` lives in the state, not only behind a stub: a mutator reads the state, and the
    // write-time role check is one of the things that does.
    users: [
      { id: ADA, username: "ada", role: "admin", secret: "ada-secret", passwordHash: "", createdAt: "", permissions: { downloadToLibrary: true, downloadToDevice: true }, permissionsVersion: 0 },
      { id: BOB, username: "bob", role: "admin", secret: "bob-secret", passwordHash: "", createdAt: "", permissions: { downloadToLibrary: true, downloadToDevice: true }, permissionsVersion: 0 },
      { id: CAROL, username: "carol", role: "user", secret: "carol-secret", passwordHash: "", createdAt: "", permissions: { downloadToLibrary: false, downloadToDevice: true }, permissionsVersion: 0 },
    ] as UserRecord[],
    addons: [],
    libraries: [],
    settings: { ...defaultInstanceSettings(), realDebridToken: "rd-token", tmdbApiKey: "tmdb-key" },
    defaultsInstalled: true,
    userData: {
      [ADA]: { ...emptyUserData(), prefs: { ...defaultPrefs(), uiLanguage: "en" } },
      [BOB]: { ...emptyUserData(), prefs: { ...defaultPrefs(), uiLanguage: "cs", mergeByName: false } },
      [CAROL]: { ...emptyUserData(), prefs: { ...defaultPrefs(), uiLanguage: "en" } },
    },
  } as State;
  const callers: Record<string, { username: string; role: Role }> = {
    [ADA]: { username: "ada", role: "admin" },
    [BOB]: { username: "bob", role: "admin" },
    [CAROL]: { username: "carol", role: "user" },
  };
  const userIdOf = (req: express.Request) =>
    req.header("x-user") === "bob" ? BOB : req.header("x-user") === "carol" ? CAROL : ADA;
  const prefsOf = (req?: express.Request): UserPrefs =>
    req ? { ...defaultPrefs(), ...state.userData?.[userIdOf(req)]?.prefs as Partial<UserPrefs> } : defaultPrefs();

  // Declared before the routes so a test can hook the sweep after mounting.
  const harness = { state } as Harness;
  // A write can be held, so a request that awaits before its write can be interleaved.
  let held: Array<() => void> = [];
  let holding = false;
  let writes = 0;
  const exportedConnection = { id: `mconn_${"1".repeat(32)}`, provider: "jellyfin" as const, name: "Home", baseUrl: "http://media.example", allowLan: false, allowLoopback: false, serverId: "server-1", accountId: "account-1" };
  const exportedLibrary = { id: `rlib_${"2".repeat(32)}`, connectionId: exportedConnection.id, remoteId: "remote-1", name: "Films", type: "movie" as const, order: 0, showOnHome: true, showInContinueWatching: true };
  // The media-server half of the settings surface, reduced to what these routes ask of it: a
  // metadata-only export an administrator alone may read, and a replacement that lands in the
  // same single write as the settings mutator it is handed.
  const mediaServers = {
    exportConfiguration: (authority: MediaServerAuthority) => {
      assertStillAdmin(state.users ?? [], authority.actor);
      if (authority.actor.id !== ADA) throw new ForbiddenError();
      return { version: 1 as const, connections: [exportedConnection], libraries: [exportedLibrary] };
    },
    restoreSettingsConfiguration: async (
      authority: MediaServerAuthority,
      metadata: unknown,
      mutate: (value: State) => void,
    ) => {
      if (authority.actor.id !== ADA) throw new ForbiddenError();
      const prepared = prepareMediaServerConfiguration(metadata);
      await deps.store.update((value) => {
        mutate(value);
        value.mediaConnections = prepared.connections;
        value.remoteLibraries = prepared.libraries;
      });
    },
  } as unknown as MediaServerManager;
  const deps: SettingsDeps = {
    store: {
      settings: () => state.settings,
      addons: () => state.addons,
      users: () => state.users,
      libraries: () => state.libraries,
      update: async (mutate: (value: State) => void) => {
        writes += 1;
        if (holding) {
          await new Promise<void>((resolve, reject) => {
            held.push(() => { try { mutate(state); resolve(); } catch (error) { reject(error); } });
          });
          return;
        }
        mutate(state);
      },
    } as unknown as Store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: (req) => (state.users ?? []).find((user) => user.id === userIdOf(req)) as UserRecord,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async (opts) => { harness.onStopContent?.(opts); },
    STREAM_SORTS,
    accountIdOf: (req) => (req ? userIdOf(req) : ADA),
    invalidateLibrary: () => undefined,
    mediaServers,
    metaCache: new Map(),
    metaStore: {
      flush: async () => harness.onFlush?.(),
      updateAll: async (mutate: (file: { meta: Record<string, unknown> }) => void) => { mutate({ meta: {} }); },
    } as unknown as LibraryMetaStore,
    mutateData: (current: State, id: string, mutate: (data: UserData) => void) => {
      const data = current.userData?.[id] ?? emptyUserData();
      mutate(data);
      current.userData = { ...(current.userData ?? {}), [id]: data };
    },
    prefsOf,
    queue: { changed: () => undefined } as unknown as DownloadQueue,
    streamCache: new Map(),
  };
  const app = express();
  app.use(express.json());
  registerSettingsRoutes(app, deps);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error), messageKey: messageKeyOf(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  harness.base = `http://127.0.0.1:${port}`;
  harness.pendingWrites = () => held.length;
  harness.writes = () => writes;
  harness.holdWrites = () => { holding = true; };
  harness.releaseWrites = () => { const waiting = held; held = []; for (const run of waiting) run(); };
  harness.close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return harness;
};

const api = (base: string, pathname: string, init: { method?: string; body?: unknown; user?: "ada" | "bob" | "carol" } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.user ? { "x-user": init.user } : {}),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

test("GET /api/settings answers the instance half and the caller's own preferences", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const ada = await (await api(harness.base, "/api/settings", { user: "ada" })).json() as Record<string, unknown>;
  const bob = await (await api(harness.base, "/api/settings", { user: "bob" })).json() as Record<string, unknown>;

  assert.equal(ada.concurrentDownloads, harness.state.settings.concurrentDownloads, "the instance half is there");
  assert.equal(ada.uiLanguage, "en");
  assert.equal(bob.uiLanguage, "cs", "each caller reads their own preferences");
  assert.equal(ada.mergeByName, true);
  assert.equal(bob.mergeByName, false);
});

test("GET /api/settings answers the configured booleans and never the stored secrets", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const body = await (await api(harness.base, "/api/settings")).json() as Record<string, unknown>;

  assert.equal("realDebridToken" in body, false);
  assert.equal("tmdbApiKey" in body, false);
  assert.equal(body.realDebridConfigured, true);
  assert.equal(body.tmdbConfigured, true);
});

test("GET /api/settings tells an ordinary account nothing about the instance it cannot act on", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const carol = await (await api(harness.base, "/api/settings", { user: "carol" })).json() as Record<string, unknown>;

  for (const key of ["concurrentDownloads", "parallelPerProvider", "downloadSegments", "libraryAutoScan",
    "libraryScanPauseOnDownload", "logLevel", "addonRefreshHours", "defaultMovieLibrary", "defaultSeriesLibrary",
    "tmdbConfigured", "realDebridToken", "tmdbApiKey"]) {
    assert.equal(key in carol, false, `${key} is the operator's business`);
  }
  // Kept on purpose: without the one the interface offers torrent sources it cannot save,
  // and without the other it frames a trailer the instance meant to send to a new tab.
  assert.equal(carol.realDebridConfigured, true);
  assert.equal(carol.secureMode, harness.state.settings.secureMode);
  assert.equal(carol.uiLanguage, "en", "its own half arrives whole");
  assert.equal(carol.tileSize, "medium");
  assert.equal(carol.homeTileShape, "wide", "the Home tile shape defaults to wide");
  assert.equal(carol.startView, "home", "the start page defaults to Home");

  const ada = await (await api(harness.base, "/api/settings", { user: "ada" })).json() as Record<string, unknown>;
  assert.equal(ada.concurrentDownloads, harness.state.settings.concurrentDownloads, "an administrator still reads it all");
  assert.equal(ada.addonRefreshHours, harness.state.settings.addonRefreshHours);
  assert.equal(ada.tmdbConfigured, true);
});

test("PATCH /api/settings answers an ordinary account with the same narrowed view", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const response = await api(harness.base, "/api/settings", { method: "PATCH", user: "carol", body: { tileSize: "large" } });

  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.tileSize, "large");
  assert.equal("concurrentDownloads" in body, false);
  assert.equal("tmdbConfigured" in body, false);
});

test("PATCH /api/settings stores each library page shape separately", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/settings", {
    method: "PATCH", user: "carol", body: { favoritesTileShape: "wide" },
  });
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.favoritesTileShape, "wide");
  assert.equal(body.resumeTileShape, "poster");
  assert.equal(body.followingTileShape, "poster");
  assert.equal(harness.state.userData?.[CAROL]?.prefs.favoritesTileShape, "wide");
  assert.equal(harness.state.userData?.[CAROL]?.prefs.resumeTileShape, "poster");
});

test("PATCH /api/settings sends an instance key to the instance and a personal key to the caller", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const response = await api(harness.base, "/api/settings", {
    method: "PATCH",
    user: "bob",
    body: { concurrentDownloads: 5, tileSize: "large", homeTileShape: "poster", startView: "library" },
  });

  assert.equal(response.status, 200);
  assert.equal(harness.state.settings.concurrentDownloads, 5);
  assert.equal("tileSize" in harness.state.settings, false, "a personal key never reaches the instance half");
  assert.equal(harness.state.userData?.[BOB]?.prefs.tileSize, "large");
  assert.equal(harness.state.userData?.[BOB]?.prefs.homeTileShape, "poster");
  assert.equal(harness.state.userData?.[BOB]?.prefs.startView, "library");
  assert.equal(harness.state.userData?.[ADA]?.prefs.tileSize, "medium", "the other person keeps their value");
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.concurrentDownloads, 5);
  assert.equal(body.tileSize, "large");
  assert.equal(body.homeTileShape, "poster");
  assert.equal(body.startView, "library");
});

test("PATCH /api/settings keeps a known start page and coerces an unknown one to Home", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const catalog = await api(harness.base, "/api/settings", { method: "PATCH", user: "carol", body: { startView: "catalog" } });
  assert.equal(catalog.status, 200);
  assert.equal(harness.state.userData?.[CAROL]?.prefs.startView, "catalog");
  assert.equal((await catalog.json() as Record<string, unknown>).startView, "catalog");

  const response = await api(harness.base, "/api/settings", { method: "PATCH", user: "carol", body: { startView: "shelf" } });

  assert.equal(response.status, 200);
  assert.equal(harness.state.userData?.[CAROL]?.prefs.startView, "home");
  assert.equal((await response.json() as Record<string, unknown>).startView, "home");
});

test("PATCH /api/settings round trips the library shelf and coerces a value it does not know", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const set = await api(harness.base, "/api/settings", { method: "PATCH", user: "carol", body: { libraryShelf: "episodes" } });
  assert.equal(set.status, 200);
  assert.equal(harness.state.userData?.[CAROL]?.prefs.libraryShelf, "episodes");
  assert.equal((await set.json() as Record<string, unknown>).libraryShelf, "episodes");

  const junk = await api(harness.base, "/api/settings", { method: "PATCH", user: "carol", body: { libraryShelf: "nope" } });
  assert.equal(junk.status, 200);
  assert.equal(harness.state.userData?.[CAROL]?.prefs.libraryShelf, "resume");
  assert.equal((await junk.json() as Record<string, unknown>).libraryShelf, "resume");
});

test("PATCH /api/settings drops an unknown streamSort and clamps concurrentDownloads", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  await api(harness.base, "/api/settings", { method: "PATCH", user: "bob", body: { streamSort: "bogus", concurrentDownloads: 99 } });
  assert.equal(harness.state.userData?.[BOB]?.prefs.streamSort, "recommended");
  assert.equal(harness.state.settings.concurrentDownloads, 8);

  await api(harness.base, "/api/settings", { method: "PATCH", user: "bob", body: { streamSort: "size-asc", concurrentDownloads: 0 } });
  assert.equal(harness.state.userData?.[BOB]?.prefs.streamSort, "size-asc");
  assert.equal(harness.state.settings.concurrentDownloads, 1);
});

test("POST /api/settings/import puts each key of a flat backup back on the side it belongs to", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const response = await api(harness.base, "/api/settings/import", {
    method: "POST",
    user: "ada",
    body: {
      format: "stremio-offline-settings",
      version: 2,
      exportedAt: new Date().toISOString(),
      settings: {
        concurrentDownloads: 3, secureMode: false, realDebridToken: "restored-token", tmdbApiKey: "",
        uiLanguage: "cs", audioLanguage: "cs", streamSort: "addon", tileSize: "large",
      },
      addons: [],
      libraries: [],
    },
  });

  assert.equal(response.status, 200);
  assert.equal(harness.state.settings.concurrentDownloads, 3);
  assert.equal(harness.state.settings.secureMode, false);
  assert.equal(harness.state.settings.realDebridToken, "restored-token");
  assert.equal("uiLanguage" in harness.state.settings, false, "a personal key never lands on the instance half");
  assert.equal("streamSort" in harness.state.settings, false);
  const prefs = harness.state.userData?.[ADA]?.prefs as Partial<UserPrefs>;
  assert.equal(prefs.uiLanguage, "cs");
  assert.equal(prefs.audioLanguage, "cs");
  assert.equal(prefs.streamSort, "addon");
  assert.equal(prefs.tileSize, "large");
  const body = await response.json() as { remapped: number; settings: Record<string, unknown> };
  assert.equal(body.remapped, 0);
  assert.equal(body.settings.uiLanguage, "cs");
});

test("an import keeps the grants and the keys of the addons this instance already has", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  // `loadAddon` fetches the manifest for real, so the backup points at one this test serves.
  const originalFlag = process.env.ALLOW_PRIVATE_ADDONS;
  process.env.ALLOW_PRIVATE_ADDONS = "1";
  t.after(() => { if (originalFlag === undefined) delete process.env.ALLOW_PRIVATE_ADDONS; else process.env.ALLOW_PRIVATE_ADDONS = originalFlag; });
  const manifests = createServer((req, res) => {
    const id = req.url === "/beta/manifest.json" ? "beta" : "alpha";
    res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ id, name: `Addon ${id}`, version: "1.0.0", resources: ["stream"], types: ["movie"], catalogs: [] }));
  });
  manifests.listen(0, "127.0.0.1");
  await once(manifests, "listening");
  t.after(() => new Promise<void>((resolve) => manifests.close(() => resolve())));
  const origin = `http://127.0.0.1:${(manifests.address() as AddressInfo).port}`;
  const alphaUrl = `${origin}/alpha/manifest.json`;
  const betaUrl = `${origin}/beta/manifest.json`;

  const kept = {
    key: "alpha-key", manifestUrl: alphaUrl, role: "both", enabled: true, globalSearch: true,
    addedAt: "2026-01-01T00:00:00.000Z", allowedUsers: [CAROL],
    manifest: { id: "alpha", name: "Addon alpha", version: "1.0.0", resources: ["stream"] },
    downloadSettings: { movie: { subfolder: "", layout: "flat" }, series: { subfolder: "", layout: "flat" } },
  };
  const dropped = { ...kept, key: "beta-key", manifestUrl: betaUrl, manifest: { id: "beta", name: "Addon beta", version: "1.0.0" } };
  harness.state.addons = [kept, dropped] as State["addons"];
  const stopped: Array<{ addonKey?: string }> = [];
  harness.onStopContent = (opts) => { stopped.push(opts); };

  const response = await api(harness.base, "/api/settings/import", {
    method: "POST",
    user: "ada",
    body: {
      format: "stremio-offline-settings", version: 2, exportedAt: new Date().toISOString(),
      settings: { concurrentDownloads: 3 },
      addons: [{ manifestUrl: alphaUrl, role: "both", enabled: true, globalSearch: true, addedAt: "2026-01-01T00:00:00.000Z" }],
      libraries: [],
    },
  });
  assert.equal(response.status, 200);

  // A backup carries the instance's configuration, not its accounts: the ids in a grant list
  // belong to this install. Reloading the record must not quietly take every addon away from
  // every ordinary account -- including when the backup being imported is this instance's own.
  const [restored] = harness.state.addons;
  assert.equal(harness.state.addons.length, 1);
  assert.deepEqual(restored?.allowedUsers, [CAROL], "the import took the addon away from everyone it was granted to");
  assert.equal(restored?.key, "alpha-key", "the key a grant and a personal order both point at was replaced");
  // The addon the backup does not carry is gone for everybody, which no counter records.
  assert.deepEqual(stopped, [{ addonKey: "beta-key" }]);
});

test("an import sweeps a preserved addon key when its effective identity changes", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const originalFlag = process.env.ALLOW_PRIVATE_ADDONS;
  process.env.ALLOW_PRIVATE_ADDONS = "1";
  t.after(() => { if (originalFlag === undefined) delete process.env.ALLOW_PRIVATE_ADDONS; else process.env.ALLOW_PRIVATE_ADDONS = originalFlag; });
  const manifests = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        id: "alpha",
        name: "Addon alpha",
        version: "2.0.0",
        resources: ["subtitles"],
        types: ["movie"],
        catalogs: [],
      }));
  });
  manifests.listen(0, "127.0.0.1");
  await once(manifests, "listening");
  t.after(() => new Promise<void>((resolve) => manifests.close(() => resolve())));
  const alphaUrl = `http://127.0.0.1:${(manifests.address() as AddressInfo).port}/alpha/manifest.json`;

  harness.state.addons = [{
    key: "alpha-key",
    manifestUrl: alphaUrl,
    role: "both",
    enabled: true,
    globalSearch: true,
    addedAt: "2026-01-01T00:00:00.000Z",
    allowedUsers: [CAROL],
    manifest: { id: "alpha", name: "Addon alpha", version: "1.0.0", resources: ["stream"] },
    downloadSettings: { movie: { subfolder: "", layout: "flat" }, series: { subfolder: "", layout: "flat" } },
  }] as State["addons"];
  const stopped: Array<{ addonKey?: string }> = [];
  harness.onStopContent = (opts) => { stopped.push(opts); };
  const importBackup = () => api(harness.base, "/api/settings/import", {
    method: "POST",
    user: "ada",
    body: {
      format: "stremio-offline-settings",
      version: 2,
      exportedAt: new Date().toISOString(),
      settings: { concurrentDownloads: 3 },
      addons: [{
        manifestUrl: alphaUrl,
        role: "both",
        enabled: true,
        globalSearch: true,
        addedAt: "2026-01-01T00:00:00.000Z",
      }],
      libraries: [],
    },
  });

  assert.equal((await importBackup()).status, 200);
  assert.equal(harness.state.addons[0]?.key, "alpha-key");
  assert.deepEqual(harness.state.addons[0]?.allowedUsers, [CAROL]);
  assert.deepEqual(stopped, [{ addonKey: "alpha-key" }]);

  stopped.length = 0;
  assert.equal((await importBackup()).status, 200);
  assert.deepEqual(stopped, [], "an unchanged identity pauses nothing");
});

test("an import carries the grant list the state holds when the write lands", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const originalFlag = process.env.ALLOW_PRIVATE_ADDONS;
  process.env.ALLOW_PRIVATE_ADDONS = "1";
  t.after(() => { if (originalFlag === undefined) delete process.env.ALLOW_PRIVATE_ADDONS; else process.env.ALLOW_PRIVATE_ADDONS = originalFlag; });
  const manifests = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ id: "alpha", name: "Addon alpha", version: "1.0.0", resources: ["stream"], types: ["movie"], catalogs: [] }));
  });
  manifests.listen(0, "127.0.0.1");
  await once(manifests, "listening");
  t.after(() => new Promise<void>((resolve) => manifests.close(() => resolve())));
  const alphaUrl = `http://127.0.0.1:${(manifests.address() as AddressInfo).port}/alpha/manifest.json`;

  const kept = {
    key: "alpha-key", manifestUrl: alphaUrl, role: "both" as const, enabled: true, globalSearch: true,
    addedAt: "2026-01-01T00:00:00.000Z", allowedUsers: [CAROL],
    manifest: { id: "alpha", name: "Addon alpha", version: "1.0.0" },
    downloadSettings: { movie: { subfolder: "", layout: "flat" as const }, series: { subfolder: "", layout: "flat" as const } },
  };
  harness.state.addons = [kept] as State["addons"];
  harness.holdWrites();

  const importing = api(harness.base, "/api/settings/import", {
    method: "POST",
    user: "ada",
    body: {
      format: "stremio-offline-settings", version: 2, exportedAt: new Date().toISOString(),
      settings: { concurrentDownloads: 3 },
      addons: [{ manifestUrl: alphaUrl, role: "both", enabled: true, globalSearch: true, addedAt: "2026-01-01T00:00:00.000Z" }],
      libraries: [],
    },
  });
  while (harness.pendingWrites() < 1) await new Promise((resolve) => setImmediate(resolve));
  // A grant edit lands while the manifest is being fetched and the import's write waits.
  harness.state.addons = [{ ...harness.state.addons[0]!, allowedUsers: [CAROL, BOB] }];
  harness.releaseWrites();

  assert.equal((await importing).status, 200);
  assert.deepEqual(harness.state.addons[0]!.allowedUsers, [CAROL, BOB], "the import wrote a grant list it read before the manifest was fetched");
});

test("PATCH /api/settings lets an ordinary user change only their own preferences", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const response = await api(harness.base, "/api/settings", {
    method: "PATCH",
    user: "carol",
    body: { tileSize: "large", uiLanguage: "cs" },
  });

  assert.equal(response.status, 200);
  assert.equal(harness.state.userData?.[CAROL]?.prefs.tileSize, "large");
  assert.equal(harness.state.userData?.[CAROL]?.prefs.uiLanguage, "cs");
  assert.equal(harness.state.userData?.[ADA]?.prefs.tileSize, "medium", "the other people keep theirs");
  assert.equal("tileSize" in harness.state.settings, false, "a personal key never reaches the instance half");
});

test("PATCH /api/settings refuses an ordinary user an instance key and writes nothing", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const settingsBefore = { ...harness.state.settings };
  const prefsBefore = { ...harness.state.userData?.[CAROL]?.prefs } as Partial<UserPrefs>;

  const response = await api(harness.base, "/api/settings", {
    method: "PATCH",
    user: "carol",
    body: { concurrentDownloads: 5 },
  });

  assert.equal(response.status, 403);
  const body = await response.json() as { messageKey?: string };
  assert.equal(body.messageKey, "err.notAllowed");
  assert.deepEqual(harness.state.settings, settingsBefore, "the instance half is untouched");
  assert.deepEqual(harness.state.userData?.[CAROL]?.prefs, prefsBefore);
});

test("PATCH /api/settings refuses a body that mixes the halves as a whole", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const settingsBefore = { ...harness.state.settings };
  const prefsBefore = { ...harness.state.userData?.[CAROL]?.prefs } as Partial<UserPrefs>;

  const response = await api(harness.base, "/api/settings", {
    method: "PATCH",
    user: "carol",
    body: { tileSize: "large", concurrentDownloads: 5 },
  });

  assert.equal(response.status, 403);
  const body = await response.json() as { messageKey?: string };
  assert.equal(body.messageKey, "err.notAllowed");
  assert.deepEqual(harness.state.settings, settingsBefore, "the instance key is not written");
  assert.equal(harness.state.userData?.[CAROL]?.prefs.tileSize, prefsBefore.tileSize, "the personal key is not applied either");
});

test("PATCH /api/settings refuses a malformed Home layout with 400 and writes nothing", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const before = { ...harness.state.userData?.[CAROL]?.prefs } as Partial<UserPrefs>;

  const bodies = ["nope", {}, { order: "resume" }, { order: [1], hidden: [], feeds: [] }, { order: [], hidden: [], feeds: ["x", 2] }];
  for (const homeLayout of bodies) {
    const response = await api(harness.base, "/api/settings", { method: "PATCH", user: "carol", body: { homeLayout } });
    assert.equal(response.status, 400, `refused for ${JSON.stringify(homeLayout)}`);
    assert.equal((await response.json() as { messageKey?: string }).messageKey, "err.homeLayoutShape");
  }
  assert.deepEqual(harness.state.userData?.[CAROL]?.prefs, before);
});

const backupFile = (over: Record<string, unknown> = {}) => ({
  format: "stremio-offline-settings", version: 3, exportedAt: "2026-01-01T00:00:00.000Z",
  settings: { concurrentDownloads: 3 }, addons: [], libraries: [],
  mediaServers: {
    version: 1,
    connections: [{ id: `mconn_${"1".repeat(32)}`, provider: "jellyfin", name: "Home", baseUrl: "https://media.example", allowLan: false, allowLoopback: false, serverId: "server-1", accountId: "account-1" }],
    libraries: [{ id: `rlib_${"2".repeat(32)}`, connectionId: `mconn_${"1".repeat(32)}`, remoteId: "remote-1", name: "Films", type: "movie", order: 0, showOnHome: true, showInContinueWatching: true }],
  },
  ...over,
});

test("GET /api/settings/export is the administrator's file and carries metadata only", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  assert.equal((await api(harness.base, "/api/settings/export", { user: "carol" })).status, 403);
  const response = await api(harness.base, "/api/settings/export", { user: "ada" });
  assert.equal(response.status, 200);
  const body = await response.json() as { version: number; mediaServers: { connections: Array<Record<string, unknown>>; libraries: Array<Record<string, unknown>> } };
  assert.equal(body.version, 3);
  assert.equal(body.mediaServers.connections.length, 1);
  assert.equal(body.mediaServers.libraries.length, 1);
  assert.equal(JSON.stringify(body.mediaServers).includes("secretRef"), false, "no credential reaches the file");
});

test("POST /api/settings/import replaces the remote configuration in the same write", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  harness.state.mediaConnections = [{
    id: `mconn_${"9".repeat(32)}`, provider: "jellyfin", name: "Old", baseUrl: "https://old.example",
    allowLan: false, allowLoopback: false, serverId: "server-9", accountId: "account-9", enabled: true, generation: 2,
    secretRef: `msecret_${"8".repeat(32)}`, addedAt: "2026-01-01T00:00:00.000Z",
  }];

  const writes = harness.writes();
  const response = await api(harness.base, "/api/settings/import", { method: "POST", user: "ada", body: backupFile() });
  assert.equal(response.status, 200);
  assert.equal(harness.writes() - writes, 1, "the settings and the remote configuration landed in one write");
  assert.equal(harness.state.settings.concurrentDownloads, 3);
  const [restored] = harness.state.mediaConnections ?? [];
  assert.equal(restored!.serverId, "server-1");
  assert.equal(restored!.enabled, false, "a restored connection asks for a sign-in");
  assert.equal(restored!.secretRef, undefined, "and never carries a credential");
  const [restoredLibrary] = harness.state.remoteLibraries ?? [];
  assert.equal(restoredLibrary!.connectionId, restored!.id);
  assert.deepEqual(restoredLibrary!.allowedUsers, [], "and never carries a grant");
});

test("a version 1 or 2 import leaves the remote configuration exactly as it is", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const connection = {
    id: `mconn_${"9".repeat(32)}`, provider: "jellyfin" as const, name: "Old", baseUrl: "https://old.example",
    allowLan: false, allowLoopback: false, serverId: "server-9", accountId: "account-9", enabled: true, generation: 2,
    secretRef: `msecret_${"8".repeat(32)}`, addedAt: "2026-01-01T00:00:00.000Z",
  };
  harness.state.mediaConnections = [connection];
  for (const version of [1, 2]) {
    const response = await api(harness.base, "/api/settings/import", {
      method: "POST", user: "ada",
      body: { format: "stremio-offline-settings", version, settings: { concurrentDownloads: 4 }, addons: [], libraries: [] },
    });
    assert.equal(response.status, 200, `version ${version}`);
    assert.deepEqual(harness.state.mediaConnections, [connection], `version ${version} left the remote configuration alone`);
  }
});

test("an import whose media-server half does not stand on its own is refused before anything is written", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const connection = {
    id: `mconn_${"9".repeat(32)}`, provider: "jellyfin" as const, name: "Old", baseUrl: "https://old.example",
    allowLan: false, allowLoopback: false, serverId: "server-9", accountId: "account-9", enabled: true, generation: 0,
    addedAt: "2026-01-01T00:00:00.000Z",
  };
  harness.state.mediaConnections = [connection];
  const before = harness.state.settings.concurrentDownloads;
  for (const mediaServers of [
    undefined,
    { version: 2, connections: [], libraries: [] },
    { version: 1, connections: [], libraries: [{ id: `rlib_${"2".repeat(32)}`, connectionId: `mconn_${"1".repeat(32)}`, remoteId: "r", name: "Films", type: "movie", order: 0, showOnHome: true, showInContinueWatching: true }] },
  ]) {
    const writes = harness.writes();
    const response = await api(harness.base, "/api/settings/import", { method: "POST", user: "ada", body: backupFile({ mediaServers }) });
    assert.equal(response.status, 400, JSON.stringify(mediaServers));
    assert.equal(harness.writes(), writes, "a file that does not stand on its own writes nothing");
  }
  assert.equal(harness.state.settings.concurrentDownloads, before);
  assert.deepEqual(harness.state.mediaConnections, [connection]);
});

test("PATCH /api/settings stores a Home layout and drops a feed the caller may not use", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  harness.state.addons.push(
    { key: "mine", manifestUrl: "https://mine/manifest.json", role: "catalog", enabled: true, globalSearch: true, showOnHome: true, addedAt: "", allowedUsers: [CAROL], manifest: { id: "mine", name: "Mine", version: "1", catalogs: [{ type: "movie", id: "top" }] } } as unknown as AddonRecord,
    { key: "theirs", manifestUrl: "https://theirs/manifest.json", role: "catalog", enabled: false, globalSearch: true, showOnHome: true, addedAt: "", allowedUsers: [CAROL], manifest: { id: "theirs", name: "Theirs", version: "1", catalogs: [{ type: "movie", id: "top" }] } } as unknown as AddonRecord,
  );
  const mine = homeFeedSelectionKey("mine", "movie", "top");
  const disabled = homeFeedSelectionKey("theirs", "movie", "top");

  const response = await api(harness.base, "/api/settings", {
    method: "PATCH", user: "carol",
    body: { homeLayout: { order: ["resume"], hidden: ["recent"], feeds: [mine, disabled, "junk"] } },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(harness.state.userData?.[CAROL]?.prefs.homeLayout, { order: ["resume"], hidden: ["recent"], feeds: [mine] },
    "a disabled addon's feed and a malformed key are dropped");
});

test("PATCH /api/settings clears the Home layout with null", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  harness.state.userData![CAROL]!.prefs.homeLayout = { order: ["resume"], hidden: [], feeds: [] };

  const response = await api(harness.base, "/api/settings", { method: "PATCH", user: "carol", body: { homeLayout: null } });

  assert.equal(response.status, 200);
  assert.equal("homeLayout" in (harness.state.userData?.[CAROL]?.prefs ?? {}), false);
});

test("PATCH /api/settings keeps only the row ids the account can arrange, deduplicated", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  harness.state.addons.push(
    { key: "mine", manifestUrl: "https://mine/manifest.json", role: "catalog", enabled: true, globalSearch: true, showOnHome: true, addedAt: "", allowedUsers: [CAROL], manifest: { id: "mine", name: "Mine", version: "1", catalogs: [{ type: "movie", id: "top" }] } } as unknown as AddonRecord,
  );
  const mine = homeCatalogRowId("mine", "movie", "top");

  const response = await api(harness.base, "/api/settings", {
    method: "PATCH", user: "carol",
    body: { homeLayout: { order: ["resume", "resume", "confirm", mine, "catalog:junk:nope:x"], hidden: ["recent", "recent", "nonsense"], feeds: [] } },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(harness.state.userData?.[CAROL]?.prefs.homeLayout,
    { order: ["resume", mine], hidden: ["recent"], feeds: [] },
    "duplicates collapse and a row the account cannot arrange is dropped");
});

test("PATCH /api/settings refuses a Home layout beyond the caps and writes nothing", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const before = { ...harness.state.userData?.[CAROL]?.prefs } as Partial<UserPrefs>;

  const rows = Array.from({ length: 201 }, (_, index) => `row-${index}`);
  const feeds = Array.from({ length: 51 }, (_, index) => homeFeedSelectionKey("addon", "movie", `id-${index}`));
  const bodies = [
    { order: rows, hidden: [], feeds: [] },
    { order: [], hidden: rows, feeds: [] },
    { order: [], hidden: [], feeds },
  ];
  for (const homeLayout of bodies) {
    const response = await api(harness.base, "/api/settings", { method: "PATCH", user: "carol", body: { homeLayout } });
    assert.equal(response.status, 400, `refused for ${JSON.stringify(homeLayout).slice(0, 40)}`);
    assert.equal((await response.json() as { messageKey?: string }).messageKey, "err.homeLayoutShape");
  }
  assert.deepEqual(harness.state.userData?.[CAROL]?.prefs, before);
});

test("settings export rechecks the captured administrator after flushing metadata", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  harness.onFlush = async () => { harness.state.users!.find((user) => user.id === ADA)!.secret = "rotated"; };
  const response = await api(harness.base, "/api/settings/export", { user: "ada" });
  assert.equal(response.status, 403);
  assert.equal((await response.text()).includes("media.example"), false);
});
