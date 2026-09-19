import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import type { DownloadQueue } from "../downloads.js";
import { messageKeyOf } from "../errors.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import { defaultInstanceSettings, defaultPrefs, type State, type Store, type UserPrefs } from "../store.js";
import { emptyUserData, type Role, type UserData, type UserRecord } from "../users.js";
import { registerSettingsRoutes, type SettingsDeps } from "./settings.js";

const ADA = "usr_00000001";
const BOB = "usr_00000002";
const CAROL = "usr_00000003";
const STREAM_SORTS = new Set(["recommended", "size-desc", "size-asc", "addon"]);

interface Harness {
  base: string;
  state: State;
  close(): Promise<void>;
}

/** The routes read the instance half and one person's half out of the same state object, so
 *  the harness keeps a real one and remembers which caller a request speaks for. */
const mount = async (): Promise<Harness> => {
  const state = {
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

  const deps: SettingsDeps = {
    store: {
      settings: () => state.settings,
      addons: () => state.addons,
      libraries: () => state.libraries,
      update: async (mutate: (state: State) => void) => { mutate(state); },
    } as unknown as Store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: (req) => ({ id: userIdOf(req), ...callers[userIdOf(req)] }) as UserRecord,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserAccess: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
    STREAM_SORTS,
    accountIdOf: (req) => (req ? userIdOf(req) : ADA),
    invalidateLibrary: () => undefined,
    metaCache: new Map(),
    metaStore: {
      flush: async () => undefined,
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
  return {
    base: `http://127.0.0.1:${port}`,
    state,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
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

test("PATCH /api/settings sends an instance key to the instance and a personal key to the caller", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const response = await api(harness.base, "/api/settings", {
    method: "PATCH",
    user: "bob",
    body: { concurrentDownloads: 5, libraryTileSize: "large" },
  });

  assert.equal(response.status, 200);
  assert.equal(harness.state.settings.concurrentDownloads, 5);
  assert.equal("libraryTileSize" in harness.state.settings, false, "a personal key never reaches the instance half");
  assert.equal(harness.state.userData?.[BOB]?.prefs.libraryTileSize, "large");
  assert.equal(harness.state.userData?.[ADA]?.prefs.libraryTileSize, "medium", "the other person keeps their value");
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.concurrentDownloads, 5);
  assert.equal(body.libraryTileSize, "large");
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
        uiLanguage: "cs", audioLanguage: "cs", streamSort: "addon", libraryTileSize: "large",
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
  assert.equal(prefs.libraryTileSize, "large");
  const body = await response.json() as { remapped: number; settings: Record<string, unknown> };
  assert.equal(body.remapped, 0);
  assert.equal(body.settings.uiLanguage, "cs");
});

test("PATCH /api/settings lets an ordinary user change only their own preferences", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const response = await api(harness.base, "/api/settings", {
    method: "PATCH",
    user: "carol",
    body: { libraryTileSize: "large", uiLanguage: "cs" },
  });

  assert.equal(response.status, 200);
  assert.equal(harness.state.userData?.[CAROL]?.prefs.libraryTileSize, "large");
  assert.equal(harness.state.userData?.[CAROL]?.prefs.uiLanguage, "cs");
  assert.equal(harness.state.userData?.[ADA]?.prefs.libraryTileSize, "medium", "the other people keep theirs");
  assert.equal("libraryTileSize" in harness.state.settings, false, "a personal key never reaches the instance half");
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
    body: { libraryTileSize: "large", concurrentDownloads: 5 },
  });

  assert.equal(response.status, 403);
  const body = await response.json() as { messageKey?: string };
  assert.equal(body.messageKey, "err.notAllowed");
  assert.deepEqual(harness.state.settings, settingsBefore, "the instance key is not written");
  assert.equal(harness.state.userData?.[CAROL]?.prefs.libraryTileSize, prefsBefore.libraryTileSize, "the personal key is not applied either");
});
