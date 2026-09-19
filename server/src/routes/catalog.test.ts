import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { messageKeyOf } from "../errors.js";
import type { ExternalIdStore } from "../external-ids.js";
import type { LibraryMetaRecord } from "../library-match.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import type { LibraryRecord } from "../libraries.js";
import type { Store, UserPrefs } from "../store.js";
import type { AddonRecord, AddonRole, CatalogDefinition, MetaItem } from "../types.js";
import type { UserRecord } from "../users.js";
import { registerCatalogRoutes, type CatalogDeps } from "./catalog.js";

interface Harness {
  base: string;
  lookups: Array<{ type: string; id: string; language?: string }>;
  close(): Promise<void>;
}

const addon = (key: string, catalogs: CatalogDefinition[], options: { role?: AddonRole; enabled?: boolean; globalSearch?: boolean } = {}): AddonRecord => ({
  key,
  manifestUrl: `https://${key}.example/manifest.json`,
  role: options.role ?? "catalog",
  enabled: options.enabled ?? true,
  globalSearch: options.globalSearch ?? true,
  addedAt: "2024-01-01T00:00:00.000Z",
  manifest: { id: key, name: `Addon ${key}`, version: "1.0.0", catalogs },
  downloadSettings: { movie: { subfolder: "", layout: "structured" }, series: { subfolder: "", layout: "structured" } },
});

/** The routes take everything they need from the context, so the app here is a real express
 *  instance over fake collaborators that record what they were asked to do. */
const mount = async (records: AddonRecord[] = [], meta: MetaItem | null = null, options: {
  libraries?: LibraryRecord[];
  viewer?: UserRecord;
  bound?: Record<string, LibraryMetaRecord>;
} = {}): Promise<Harness> => {
  const lookups: Harness["lookups"] = [];
  const store = {
    addons: () => records,
    libraries: () => options.libraries ?? [],
    settings: () => ({ tmdbApiKey: undefined }),
  } as unknown as Store;
  const deps: CatalogDeps = {
    store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: () => options.viewer,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    tmdbProvider: () => undefined,
    cachedMeta: async (type, id, language) => { lookups.push({ type, id, language }); return meta; },
    prefsOf: () => ({ uiLanguage: "cs" }) as UserPrefs,
    libraryTarget: async (value) => value,
    ownerOf: () => ({ sid: "session-1", expiresAt: Number.MAX_SAFE_INTEGER }),
    trackMedia: () => undefined,
    libraryKey: (value) => value,
    metaStore: { qualifiedMeta: () => options.bound ?? ({}) } as unknown as LibraryMetaStore,
    externalIds: { ids: async () => ({}) } as unknown as ExternalIdStore,
    subtitleDelay: () => 0,
  };
  const app = express();
  app.use(express.json());
  registerCatalogRoutes(app, deps);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error), messageKey: messageKeyOf(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    lookups,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

const api = (base: string, pathname: string) => fetch(`${base}${pathname}`);

test("GET /api/catalogs lists only enabled addons whose role is not source", async (t) => {
  const harness = await mount([
    addon("catalog-addon", [{ type: "movie", id: "top", name: "Top" }]),
    addon("both-addon", [{ type: "series", id: "shows" }], { role: "both" }),
    addon("off-addon", [{ type: "movie", id: "hidden" }], { enabled: false }),
    addon("source-addon", [{ type: "movie", id: "sources" }], { role: "source" }),
  ]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/catalogs");
  assert.equal(response.status, 200);
  const body = await response.json() as Array<Record<string, unknown>>;
  assert.deepEqual(body, [
    { type: "movie", id: "top", name: "Top", addonKey: "catalog-addon", addonName: "Addon catalog-addon" },
    { type: "series", id: "shows", addonKey: "both-addon", addonName: "Addon both-addon" },
  ]);
});

test("GET /api/searchable reports globalSearch per addon", async (t) => {
  const searchable = [{ type: "movie", id: "search", extra: [{ name: "search" }] }];
  const harness = await mount([
    addon("searching", searchable),
    addon("quiet", [{ type: "movie", id: "search", extra: [{ name: "search" }] }], { globalSearch: false }),
  ]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/searchable");
  assert.equal(response.status, 200);
  const body = await response.json() as Array<{ addonKey: string; globalSearch: boolean; type: string; id: string; name: string }>;
  assert.deepEqual(body.map(({ addonKey, globalSearch }) => ({ addonKey, globalSearch })), [
    { addonKey: "searching", globalSearch: true },
    { addonKey: "quiet", globalSearch: false },
  ]);
  assert.deepEqual(body.map((item) => [item.type, item.id, item.name]), [["movie", "search", "search"], ["movie", "search", "search"]]);
});

test("GET /api/meta/:type/:id falls back to the caller's uiLanguage", async (t) => {
  const harness = await mount([], { id: "tt1", type: "movie", name: "Film" });
  t.after(harness.close);
  const response = await api(harness.base, "/api/meta/movie/tt1");
  assert.equal(response.status, 200);
  assert.deepEqual(harness.lookups, [{ type: "movie", id: "tt1", language: "cs" }]);
});

test("GET /api/meta/:type/:id prefers the language named by the query", async (t) => {
  const harness = await mount([], { id: "tt1", type: "movie", name: "Film" });
  t.after(harness.close);
  const response = await api(harness.base, "/api/meta/movie/tt1?language=de");
  assert.equal(response.status, 200);
  assert.deepEqual(harness.lookups, [{ type: "movie", id: "tt1", language: "de" }]);
});

const alice = { id: "usr_00000002", username: "alice", role: "user" } as unknown as UserRecord;
const admin = { id: "usr_00000001", username: "ada", role: "admin" } as unknown as UserRecord;
const library = (id: string, visibleTo?: string[]): LibraryRecord => ({
  id, name: id, type: "mixed", root: `/media/${id}`, enabled: true, order: 0, addedAt: "", writeArtwork: false,
  ...(visibleTo ? { visibleTo } : {}),
});

test("a path in a library the caller may not see reads exactly like one with no binding", async (t) => {
  const bound = { "lib_00000001/Films/Heat": { type: "movie", id: "tt1", name: "Heat" } };
  const harness = await mount([], null, { libraries: [library("lib_00000001"), library("lib_00000002", [alice.id])], viewer: alice, bound });
  t.after(harness.close);

  const refused = await api(harness.base, `/api/library/links?path=${encodeURIComponent("lib_00000001/Films/Heat")}`);
  assert.equal(refused.status, 200);
  assert.deepEqual(await refused.json(), { links: [] }, "an invisible path is answered like an unbound one");

  const trailer = await api(harness.base, `/api/library/trailer?path=${encodeURIComponent("lib_00000001/Films/Heat")}`);
  assert.equal(trailer.status, 200);
  assert.deepEqual(await trailer.json(), { trailer: null });
});

test("a granted path still answers with its links", async (t) => {
  const bound = { "lib_00000002/Films/Heat": { type: "movie", id: "tt1", name: "Heat" } };
  const harness = await mount([], null, { libraries: [library("lib_00000002", [alice.id])], viewer: alice, bound });
  t.after(harness.close);

  const response = await api(harness.base, `/api/library/links?path=${encodeURIComponent("lib_00000002/Films/Heat")}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { links: [{ site: "imdb", url: "https://www.imdb.com/title/tt1/" }] });
});

test("an administrator still reads a binding in a library nobody was granted", async (t) => {
  const bound = { "lib_00000001/Films/Heat": { type: "movie", id: "tt1", name: "Heat" } };
  const harness = await mount([], null, { libraries: [library("lib_00000001")], viewer: admin, bound });
  t.after(harness.close);

  const response = await api(harness.base, `/api/library/links?path=${encodeURIComponent("lib_00000001/Films/Heat")}`);
  assert.deepEqual(await response.json(), { links: [{ site: "imdb", url: "https://www.imdb.com/title/tt1/" }] });
});
