import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { messageKeyOf } from "../errors.js";
import { ExternalIdStore } from "../external-ids.js";
import { ImageProxy } from "../images.js";
import type { LibraryMetaRecord, TitleUnit } from "../library-match.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import type { LibraryRecord } from "../libraries.js";
import type { Store, UserPrefs } from "../store.js";
import type { AddonRecord, AddonRole, CatalogDefinition, MetaItem } from "../types.js";
import type { UserRecord } from "../users.js";
import { metadata, resetImdbTargets } from "../addons.js";
import { mediaResources } from "../media-resources.js";
import { outbound } from "../outbound.js";
import { setFetchTransport } from "../security.js";
import { clearTmdbCache, tmdbMeta } from "../tmdb.js";
import { clearTrailerCache } from "../trailers.js";
import { registerCatalogRoutes, type CatalogDeps } from "./catalog.js";

interface Harness {
  base: string;
  lookups: Array<{ type: string; id: string; language?: string; artwork?: boolean }>;
  signals: AbortSignal[];
  responseCloses(): number;
  close(): Promise<void>;
}

const alice = { id: "usr_00000002", username: "alice", role: "user" } as unknown as UserRecord;
const admin = { id: "usr_00000001", username: "ada", role: "admin" } as unknown as UserRecord;

const addon = (key: string, catalogs: CatalogDefinition[], options: { role?: AddonRole; enabled?: boolean; globalSearch?: boolean; allowedUsers?: string[]; resources?: string[] } = {}): AddonRecord => ({
  key,
  manifestUrl: `https://${key}.example/manifest.json`,
  role: options.role ?? "catalog",
  enabled: options.enabled ?? true,
  globalSearch: options.globalSearch ?? true,
  ...(options.allowedUsers ? { allowedUsers: options.allowedUsers } : {}),
  addedAt: "2024-01-01T00:00:00.000Z",
  manifest: { id: key, name: `Addon ${key}`, version: "1.0.0", ...(options.resources ? { resources: options.resources } : {}), catalogs },
  downloadSettings: { movie: { subfolder: "", layout: "structured" }, series: { subfolder: "", layout: "structured" } },
});

const cinemeta = (): AddonRecord => {
  const record = addon("cinemeta", [], { role: "both", resources: ["meta"] });
  record.manifest = { ...record.manifest, id: "com.linvo.cinemeta", name: "Cinemeta" };
  return record;
};

/** The routes take everything they need from the context, so the app here is a real express
 *  instance over fake collaborators that record what they were asked to do. */
const mount = async (records: AddonRecord[] = [], meta: MetaItem | null = null, options: {
  libraries?: LibraryRecord[];
  viewer?: UserRecord | null;
  addonOrder?: Record<string, string[]>;
  bound?: Record<string, LibraryMetaRecord>;
  access?: CatalogDeps["requireAccess"];
  localCopies?: CatalogDeps["localCopies"];
  units?: TitleUnit[];
  cachedMeta?: CatalogDeps["cachedMeta"];
  tmdbApiKey?: string;
  externalIds?: ExternalIdStore;
  imageProxy?: ImageProxy;
} = {}): Promise<Harness> => {
  const viewer = options.viewer === undefined ? admin : options.viewer;
  const lookups: Harness["lookups"] = [];
  const signals: AbortSignal[] = [];
  const store = {
    addons: () => records,
    libraries: () => options.libraries ?? [],
    // The caller's own addon priority, which every chooser list is ordered by.
    userData: (id: string) => ({ addonOrder: options.addonOrder?.[id] ?? [] }),
    settings: () => ({ tmdbApiKey: options.tmdbApiKey }),
  } as unknown as Store;
  const deps: CatalogDeps = {
    store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: () => viewer ?? undefined,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: options.access ?? (() => undefined),
    stopContentAccess: async () => undefined,
    tmdbProvider: () => undefined,
    cachedMeta: options.cachedMeta ?? (async (type, id, language, _viewer, opts) => {
      lookups.push({ type, id, language, ...(opts?.artwork ? { artwork: true } : {}) });
      if (opts?.signal) signals.push(opts.signal);
      return meta;
    }),
    prefsOf: () => ({ uiLanguage: "cs" }) as UserPrefs,
    libraryTarget: async (value) => value,
    ownerOf: () => ({ userId: "usr_00000001", sid: "session-1", expiresAt: Number.MAX_SAFE_INTEGER }),
    trackMedia: () => undefined,
    libraryKey: (value) => value,
    localCopies: options.localCopies ?? (async () => []),
    libraryUnits: async () => options.units ?? [],
    ownRecord: (relative, records) => (records[relative]?.id ? records[relative] : undefined),
    metaStore: { qualifiedMeta: () => options.bound ?? ({}) } as unknown as LibraryMetaStore,
    externalIds: options.externalIds ?? { ids: async () => ({}) } as unknown as ExternalIdStore,
    subtitleDelay: () => 0,
    mediaSources: {} as unknown as CatalogDeps["mediaSources"],
    ...(options.imageProxy ? { imageProxy: options.imageProxy } : {}),
  };
  const app = express();
  let responseCloses = 0;
  app.use((_req, res, next) => {
    res.once("close", () => { responseCloses += 1; });
    next();
  });
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
    signals,
    responseCloses: () => responseCloses,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

const api = (base: string, pathname: string, init?: RequestInit) => fetch(`${base}${pathname}`, init);

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

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

test("GET /api/search tells the browser not to store the answer", async (t) => {
  const records = [addon("alpha", [{ type: "movie", id: "top", extra: [{ name: "search" }] }])];
  const harness = await mount(records);
  t.after(harness.close);

  await withStubbedAddons(() => json({ metas: [{ id: "tt1", type: "movie", name: "Dune" }] }), async () => {
    const response = await api(harness.base, "/api/search?query=dune");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json() as { items: Array<{ id: string }> };
    assert.deepEqual(body.items.map((item) => item.id), ["tt1"]);
  });
});

test("GET /api/meta/:type/:id falls back to the caller's uiLanguage", async (t) => {
  const harness = await mount([], { id: "tt1", type: "movie", name: "Film" });
  t.after(harness.close);
  const response = await api(harness.base, "/api/meta/movie/tt1");
  assert.equal(response.status, 200);
  assert.deepEqual(harness.lookups, [{ type: "movie", id: "tt1", language: "cs", artwork: true }]);
});

test("GET /api/meta/:type/:id prefers the language named by the query", async (t) => {
  const harness = await mount([], { id: "tt1", type: "movie", name: "Film" });
  t.after(harness.close);
  const response = await api(harness.base, "/api/meta/movie/tt1?language=de");
  assert.equal(response.status, 200);
  assert.deepEqual(harness.lookups, [{ type: "movie", id: "tt1", language: "de", artwork: true }]);
});

test("GET /api/meta/:type/:id reads the artwork metadata", async (t) => {
  const harness = await mount([], { id: "tt1", type: "movie", name: "Film" });
  t.after(harness.close);
  const response = await api(harness.base, "/api/meta/movie/tt1");
  assert.equal(response.status, 200);
  assert.deepEqual(harness.lookups, [{ type: "movie", id: "tt1", language: "cs", artwork: true }], "the detail route asks for the wider artwork");
});

test("an explicit gallery request keeps metadata usable without a TMDB key", async (t) => {
  const harness = await mount([], { id: "tt1", type: "movie", name: "Film", background: "https://images.example/background.jpg" });
  t.after(harness.close);
  const response = await api(harness.base, "/api/meta/movie/tt1?gallery=1");
  assert.equal(response.status, 200);
  const meta = await response.json() as MetaItem;
  assert.equal(meta.name, "Film");
  assert.deepEqual(meta.images, []);
  assert.deepEqual(harness.lookups, [{ type: "movie", id: "tt1", language: "cs", artwork: true }]);
});

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

test("the two link routes share a query and one disconnecting client leaves the other alive", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "catalog-links-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entered = deferred();
  const answer = deferred<Response>();
  let queries = 0;
  let transport: AbortSignal | undefined;
  const externalIds = new ExternalIdStore(dir, async (_url, init) => {
    queries += 1;
    transport = init?.signal ?? undefined;
    entered.resolve();
    return answer.promise;
  });
  await externalIds.load();
  const original = externalIds.ids.bind(externalIds);
  const joined = deferred();
  let joins = 0;
  externalIds.ids = async (id, signal) => {
    const pending = original(id, signal);
    if (++joins === 2) joined.resolve();
    return pending;
  };

  const bound = { "lib_00000001/Films/Heat": { type: "movie", id: "tt1", name: "Heat" } };
  const harness = await mount([], null, {
    libraries: [library("lib_00000001")],
    bound,
    externalIds,
  });
  t.after(harness.close);
  const leaving = new AbortController();
  const first = api(harness.base, "/api/links/movie/tt1", { signal: leaving.signal })
    .catch((error: unknown) => error);
  await entered.promise;
  const second = api(harness.base, `/api/library/links?path=${encodeURIComponent("lib_00000001/Films/Heat")}`);
  await joined.promise;

  leaving.abort();
  const disconnected = await first;
  assert.ok(disconnected instanceof Error);
  assert.equal(disconnected.name, "AbortError");
  assert.equal(transport?.aborted, false, "the surviving route keeps the query alive");

  answer.resolve(new Response(JSON.stringify({ results: { bindings: [{ tmdbMovie: { value: "1" } }] } })));
  const surviving = await second;
  assert.equal(surviving.status, 200);
  assert.deepEqual(await surviving.json(), {
    links: [
      { site: "tmdb", url: "https://www.themoviedb.org/movie/1?language=cs-CZ" },
      { site: "imdb", url: "https://www.imdb.com/title/tt1/" },
    ],
  });
  assert.equal(queries, 1);
});

test("the two link routes cancel an abandoned body and a retry starts a fresh query", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "catalog-links-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const entered = deferred();
  let queries = 0;
  let transport: AbortSignal | undefined;
  const externalIds = new ExternalIdStore(dir, async (_url, init) => {
    queries += 1;
    transport = init?.signal ?? undefined;
    entered.resolve();
    return queries === 1
      ? new Response(body)
      : new Response(JSON.stringify({ results: { bindings: [] } }));
  });
  await externalIds.load();
  const original = externalIds.ids.bind(externalIds);
  const joined = deferred();
  let joins = 0;
  externalIds.ids = async (id, signal) => {
    const pending = original(id, signal);
    if (++joins === 2) joined.resolve();
    return pending;
  };

  const bound = { "lib_00000001/Films/Heat": { type: "movie", id: "tt1", name: "Heat" } };
  const harness = await mount([], null, {
    libraries: [library("lib_00000001")],
    bound,
    externalIds,
  });
  t.after(harness.close);
  const closes = harness.responseCloses();
  const first = new AbortController();
  const second = new AbortController();
  const direct = api(harness.base, "/api/links/movie/tt1", { signal: first.signal })
    .catch((error: unknown) => error);
  await entered.promise;
  const viaLibrary = api(
    harness.base,
    `/api/library/links?path=${encodeURIComponent("lib_00000001/Films/Heat")}`,
    { signal: second.signal },
  ).catch((error: unknown) => error);
  await joined.promise;
  await until(() => body.locked, "the shared body starts reading");

  first.abort();
  second.abort();
  const outcomes = await Promise.all([direct, viaLibrary]);
  for (const outcome of outcomes) {
    assert.ok(outcome instanceof Error);
    assert.equal(outcome.name, "AbortError");
  }
  await until(() => harness.responseCloses() >= closes + 2, "both routes see their clients leave");
  assert.equal(transport?.aborted, true);
  await until(() => cancelled, "the abandoned body is cancelled");
  assert.equal(externalIds.cachedIds("tt1"), undefined);
  await assert.rejects(readFile(path.join(dir, "external-ids.json"), "utf8"));

  const retry = await api(harness.base, "/api/links/movie/tt1");
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { links: [{ site: "imdb", url: "https://www.imdb.com/title/tt1/" }] });
  assert.equal(queries, 2, "the retry does not join the abandoned flight");
  assert.deepEqual(externalIds.cachedIds("tt1"), {});
});

/** What a play that started from the library needs: the title its file is bound to, so the
 *  addons can be asked about it. Anything the caller may not see is answered like an unbound
 *  file, which is what the player reads as "no sources". */
test("GET /api/library/title answers the title of a bound file for an ordinary account", async (t) => {
  const bound = { "lib_00000001/Films/Heat": { type: "movie", id: "tt1", name: "Heat" } };
  const harness = await mount([], null, { libraries: [library("lib_00000001", [alice.id])], viewer: alice, bound });
  t.after(harness.close);

  const response = await api(harness.base, `/api/library/title?path=${encodeURIComponent("lib_00000001/Films/Heat")}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { type: "movie", id: "tt1", name: "Heat" });
});

test("GET /api/library/title names the episode id of a bound series file", async (t) => {
  const bound = { "lib_00000001/Shows/Show": { type: "series", id: "tt5", name: "Show" } };
  const harness = await mount([], null, { libraries: [library("lib_00000001", [alice.id])], viewer: alice, bound });
  t.after(harness.close);

  const response = await api(harness.base, `/api/library/title?path=${encodeURIComponent("lib_00000001/Shows/Show/S01/Show.S01E02.mkv")}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { type: "series", id: "tt5", name: "Show", videoId: "tt5:1:2" });
});

test("GET /api/library/title answers an empty object for a file with no binding", async (t) => {
  const harness = await mount([], null, { libraries: [library("lib_00000001", [alice.id])], viewer: alice });
  t.after(harness.close);

  const response = await api(harness.base, `/api/library/title?path=${encodeURIComponent("lib_00000001/Films/Loose.mkv")}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {});
});

test("GET /api/library/title answers an empty object for a library the caller may not see", async (t) => {
  const bound = { "lib_00000001/Films/Heat": { type: "movie", id: "tt1", name: "Heat" } };
  const harness = await mount([], null, {
    libraries: [library("lib_00000001"), library("lib_00000002", [alice.id])],
    viewer: alice,
    bound,
  });
  t.after(harness.close);

  const response = await api(harness.base, `/api/library/title?path=${encodeURIComponent("lib_00000001/Films/Heat")}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {});
});

test("GET /api/library/title answers an empty object for an invalid path", async (t) => {
  const harness = await mount([], null, { libraries: [library("lib_00000001", [alice.id])], viewer: alice });
  t.after(harness.close);

  for (const path of ["", "lib_99999999/Films/Heat", "lib_00000001/../etc/passwd"]) {
    const response = await api(harness.base, `/api/library/title?path=${encodeURIComponent(path)}`);
    assert.equal(response.status, 200, path);
    assert.deepEqual(await response.json(), {}, path);
  }
});

const searchable = [{ type: "movie", id: "top", name: "Top", extra: [{ name: "search" }] }];
const grantedToAlice = (key: string, catalogs = searchable, options: Parameters<typeof addon>[2] = {}) =>
  addon(key, catalogs, { allowedUsers: [alice.id], ...options });

test("GET /api/catalogs and /api/searchable omit an addon the caller may not use", async (t) => {
  const records = [grantedToAlice("open"), addon("shut", searchable)];

  const administrator = await mount(records, null, { viewer: admin });
  t.after(administrator.close);
  const adminCatalogs = await (await api(administrator.base, "/api/catalogs")).json() as Array<{ addonKey: string }>;
  assert.deepEqual(adminCatalogs.map((item) => item.addonKey), ["open", "shut"], "an administrator sees every catalogue");

  const user = await mount(records, null, { viewer: alice });
  t.after(user.close);
  const userCatalogs = await (await api(user.base, "/api/catalogs")).json() as Array<{ addonKey: string }>;
  assert.deepEqual(userCatalogs.map((item) => item.addonKey), ["open"], "a disallowed addon's catalogue is gone");
  const userSearchable = await (await api(user.base, "/api/searchable")).json() as Array<{ addonKey: string }>;
  assert.deepEqual(userSearchable.map((item) => item.addonKey), ["open"], "and so is its search entry");
});

test("GET /api/catalog answers an addon the caller may not use as an unknown one", async (t) => {
  const harness = await mount([addon("shut", searchable)], null, { viewer: alice });
  t.after(harness.close);

  const refused = await api(harness.base, "/api/catalog?addon=shut&type=movie&id=top");
  const unknown = await api(harness.base, "/api/catalog?addon=nobody&type=movie&id=top");

  assert.equal(refused.status, unknown.status);
  assert.deepEqual(await refused.json(), await unknown.json(), "a refusal reads exactly like an unknown addon");
  assert.equal(refused.status, 400);
});

test("GET /api/catalog answers a switched-off addon as an unknown one", async (t) => {
  const harness = await mount([addon("off-addon", [{ type: "movie", id: "hidden" }], { enabled: false })]);
  t.after(harness.close);

  // The listing drops it, so nobody is offered it -- but an id somebody already has is a
  // direct request that never passes the listing, and switching an addon off has to mean
  // switching it off.
  const refused = await api(harness.base, "/api/catalog?addon=off-addon&type=movie&id=hidden");
  const unknown = await api(harness.base, "/api/catalog?addon=nobody&type=movie&id=hidden");
  assert.equal(refused.status, unknown.status);
  assert.deepEqual(await refused.json(), await unknown.json());
  assert.equal(refused.status, 400);
});

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** Serves the addon requests from a stub instead of the network. The test's own calls to the
 *  loopback server keep using the global fetch, because only `safeFetch` goes through the seam. */
async function withStubbedAddons(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  run: () => Promise<void>,
) {
  const originalFlag = process.env.ALLOW_PRIVATE_ADDONS;
  process.env.ALLOW_PRIVATE_ADDONS = "1";
  setFetchTransport(async (url, init) => handler(url.href, init));
  try { await run(); }
  finally {
    setFetchTransport();
    if (originalFlag === undefined) delete process.env.ALLOW_PRIVATE_ADDONS;
    else process.env.ALLOW_PRIVATE_ADDONS = originalFlag;
  }
}

const prompt = async <T>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not happen promptly`)), 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const until = async (condition: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`${label} was not reached`);
};

const heldAddon = () => {
  let signal: AbortSignal | undefined;
  let started!: () => void;
  let cancelled!: () => void;
  const readStarted = new Promise<void>((resolve) => { started = resolve; });
  const bodyCancelled = new Promise<void>((resolve) => { cancelled = resolve; });
  const handler = async (_url: string, init: RequestInit): Promise<Response> => {
    signal = init.signal as AbortSignal;
    return new Response(new ReadableStream<Uint8Array>({
      pull() {
        started();
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled();
      },
    }), { headers: { "content-type": "application/json" } });
  };
  return { handler, readStarted, bodyCancelled, signal: () => signal };
};

const heldJson = () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let started!: () => void;
  let cancelled!: () => void;
  let activate!: () => void;
  const activated = new Promise<void>((resolve) => { activate = resolve; });
  const readStarted = new Promise<void>((resolve) => { started = resolve; });
  const bodyCancelled = new Promise<void>((resolve) => { cancelled = resolve; });
  let wasCancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    async pull() {
      await activated;
      started();
      return new Promise<void>(() => undefined);
    },
    cancel() {
      wasCancelled = true;
      cancelled();
    },
  }), { headers: { "content-type": "application/json" } });
  return {
    response,
    readStarted,
    bodyCancelled,
    cancelled: () => wasCancelled,
    activate,
    release(body: unknown) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
      controller.close();
    },
  };
};

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

const heldImage = (body: Buffer = PNG) => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let started!: () => void;
  let cancelled!: () => void;
  const readStarted = new Promise<void>((resolve) => { started = resolve; });
  const bodyCancelled = new Promise<void>((resolve) => { cancelled = resolve; });
  let released = false;
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    pull() { return new Promise<void>(() => undefined); },
    cancel() { cancelled(); },
  });
  const getReader = stream.getReader.bind(stream);
  stream.getReader = ((...args: Parameters<typeof getReader>) => {
    started();
    return getReader(...args);
  }) as typeof stream.getReader;
  const response = new Response(stream, { headers: { "content-type": "image/png" } });
  return {
    response,
    readStarted,
    bodyCancelled,
    release() {
      if (released) return;
      released = true;
      controller.enqueue(body);
      controller.close();
    },
  };
};

const routeImages = async (
  t: { after(fn: () => unknown): unknown },
  responder: (url: string, init: RequestInit) => Promise<Response>,
) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-catalog-images-"));
  const proxy = new ImageProxy(directory, 1024 * 1024, 0, responder);
  await proxy.load();
  t.after(async () => {
    await proxy.flush();
    await rm(directory, { recursive: true, force: true });
  });
  return { proxy, directory };
};

const cachedMetadataLookup = (
  records: AddonRecord[],
  provider?: (type: string, id: string, signal?: AbortSignal) => Promise<MetaItem | null>,
) => {
  let cached: MetaItem | null | undefined;
  const lookup: CatalogDeps["cachedMeta"] = async (type, id, language, viewer, opts) => {
    if (opts?.signal?.aborted) return null;
    if (cached) return cached;
    const value = await metadata(
      viewer ? records.filter((record) => record.enabled && record.role !== "source") : records,
      type,
      id,
      language,
      provider,
      true,
      true,
      opts?.signal,
    ).catch(() => null);
    if (opts?.signal?.aborted) return null;
    if (value) cached = value;
    return value;
  };
  return { lookup, cached: () => cached };
};

const disconnectCases = [
  {
    name: "catalog",
    records: [addon("catalog-hold", [{ type: "movie", id: "top" }])],
    path: "/api/catalog?addon=catalog-hold&type=movie&id=top",
    host: "catalog-hold.example",
  },
  {
    name: "search",
    records: [addon("search-hold", [{ type: "movie", id: "top", extra: [{ name: "search" }] }])],
    path: "/api/search?query=dune",
    host: "search-hold.example",
  },
  {
    name: "streams",
    records: [addon("stream-hold", [], { role: "source", resources: ["stream"] })],
    path: "/api/streams/movie/tt1",
    host: "stream-hold.example",
  },
  {
    name: "subtitles",
    records: [addon("subtitle-hold", [], { role: "both", resources: ["subtitles"] })],
    path: "/api/subtitles/movie/tt1",
    host: "subtitle-hold.example",
  },
];

for (const scenario of disconnectCases) {
  test(`GET /api/${scenario.name} cancels its outbound body when the client disconnects`, async (t) => {
    const harness = await mount(scenario.records);
    t.after(harness.close);
    const held = heldAddon();

    await withStubbedAddons(held.handler, async () => {
      const request = http.get(`${harness.base}${scenario.path}`);
      request.on("error", () => undefined);
      t.after(() => request.destroy());
      await prompt(held.readStarted, "the outbound body read");
      const signal = held.signal()!;

      request.destroy();
      await prompt(new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      }), "the outbound signal abort");
      await prompt(held.bodyCancelled, "the outbound body cancel");

      assert.equal(signal.aborted, true);
    });

    assert.equal(outbound.diagnostics().find((entry) => entry.host === scenario.host)?.failures ?? 0, 0);
  });
}

test("two image clients share one download and one disconnect leaves the other alive", async (t) => {
  const host = "image-route-shared.example";
  const held = heldImage();
  let requests = 0;
  let upstream: AbortSignal | undefined;
  const { proxy } = await routeImages(t, (_url, init) => {
    requests += 1;
    upstream = init.signal as AbortSignal;
    return Promise.resolve(held.response);
  });
  const fetchImage = proxy.fetch.bind(proxy);
  let joins = 0;
  proxy.fetch = async (...args) => {
    joins += 1;
    return fetchImage(...args);
  };
  const harness = await mount([], null, { imageProxy: proxy });
  t.after(harness.close);
  const id = proxy.proxied(`https://${host}/poster.png`)!.split("/").pop()!;
  const route = `/api/image/${id}?surface=home`;

  const first = http.get(`${harness.base}${route}`);
  first.on("error", () => undefined);
  t.after(() => first.destroy());
  await prompt(held.readStarted, "the shared image body read");
  assert.equal(requests, 1);

  const second = prompt(api(harness.base, route), "the surviving image response");
  await until(() => joins === 2, "the second image waiter");
  const firstClosed = new Promise<void>((resolve) => first.once("close", resolve));
  first.destroy();
  await prompt(firstClosed, "the disconnected image request");
  await prompt(new Promise<void>((resolve) => setImmediate(resolve)), "the first image waiter to leave");
  assert.equal(upstream?.aborted, false, "one image client leaving does not abort the shared download");

  held.release();
  const response = await second;
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  assert.equal(response.headers.get("cache-control"), "private, max-age=86400");
  const etag = response.headers.get("etag");
  assert.ok(etag);
  assert.equal(requests, 1);

  const notModified = await fetch(`${harness.base}${route}`, { headers: { "if-none-match": etag! } });
  assert.equal(notModified.status, 304);
  assert.equal(await notModified.text(), "");
  assert.equal(outbound.diagnostics().find((entry) => entry.host === host)?.failures ?? 0, 0);
});

test("the last image client disconnect cancels its body and a retry caches afresh", async (t) => {
  const host = "image-route-cancel.example";
  const held = heldImage();
  let requests = 0;
  let upstream: AbortSignal | undefined;
  const { proxy, directory } = await routeImages(t, (_url, init) => {
    requests += 1;
    if (requests === 1) {
      upstream = init.signal as AbortSignal;
      return Promise.resolve(held.response);
    }
    return Promise.resolve(new Response(PNG, { headers: { "content-type": "image/png" } }));
  });
  const harness = await mount([], null, { imageProxy: proxy });
  t.after(harness.close);
  const id = proxy.proxied(`https://${host}/poster.png`)!.split("/").pop()!;
  const route = `/api/image/${id}`;

  const request = http.get(`${harness.base}${route}`);
  request.on("error", () => undefined);
  t.after(() => request.destroy());
  await prompt(held.readStarted, "the held image body read");
  const signal = upstream!;
  const closed = new Promise<void>((resolve) => request.once("close", resolve));
  request.destroy();
  await prompt(new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  }), "the image upstream abort");
  await prompt(held.bodyCancelled, "the image body cancellation");
  await prompt(closed, "the disconnected image request");

  assert.equal(await proxy.readCached(id), undefined);
  assert.equal(proxy.inMemory(id), false);
  assert.equal(proxy.takeFetched(id), false);
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith(`${id}.`)), []);
  await until(() => !outbound.diagnostics().some((entry) => entry.host === host && entry.active > 0), "the released image host slot");

  const retried = await prompt(api(harness.base, route), "the retried image response");
  assert.equal(retried.status, 200);
  assert.deepEqual(Buffer.from(await retried.arrayBuffer()), PNG);
  assert.equal(requests, 2, "the retry starts a fresh upstream request");
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith(`${id}.`)), [`${id}.png`]);
  assert.equal(outbound.diagnostics().find((entry) => entry.host === host)?.failures ?? 0, 0);
});

test("a no-gallery metadata disconnect cancels the addon body and does not cache or fall through", async (t) => {
  resetImdbTargets();
  const records = [
    addon("metadata-first", [], { role: "both", resources: ["meta"] }),
    addon("metadata-next", [], { role: "both", resources: ["meta"] }),
  ];
  const cached = cachedMetadataLookup(records);
  const harness = await mount(records, null, { cachedMeta: cached.lookup });
  t.after(harness.close);
  const held = heldJson();
  let requestStarted!: () => void;
  let transportSignal: AbortSignal | undefined;
  const requestStartedSignal = new Promise<void>((resolve) => { requestStarted = resolve; });
  let firstRequests = 0;
  let nextRequests = 0;

  await withStubbedAddons((url, init) => {
    const host = new URL(url).hostname;
    if (host === "metadata-first.example") {
      firstRequests += 1;
      if (firstRequests === 1) {
        transportSignal = init.signal as AbortSignal;
        requestStarted();
        return held.response;
      }
      return json({ meta: { id: "tt-meta", type: "movie", name: "Retried", description: "Answer", background: "https://img.example/background.jpg" } });
    }
    if (host === "metadata-next.example") nextRequests += 1;
    throw new Error(`Unexpected addon host ${host}`);
  }, async () => {
    const closes = harness.responseCloses();
    const request = http.get(`${harness.base}/api/meta/movie/tt-meta`);
    request.on("error", () => undefined);
    t.after(() => request.destroy());

    await prompt(requestStartedSignal, "the metadata request");
    held.activate();
    await prompt(held.readStarted, "the metadata body read");
    const signal = transportSignal!;
    request.destroy();
    await prompt(new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    }), "the metadata signal abort");
    await prompt(held.bodyCancelled, "the metadata body cancel");
    await until(() => harness.responseCloses() === closes + 1, "the disconnected metadata response");

    assert.equal(nextRequests, 0, "cancellation does not fall through to the next addon");
    assert.equal(cached.cached(), undefined, "a cancelled answer is not cached");

    const retried = await prompt(api(harness.base, "/api/meta/movie/tt-meta"), "the retried metadata response");
    assert.equal(retried.status, 200);
    assert.equal((await retried.json() as MetaItem).name, "Retried");
    assert.equal(firstRequests, 2);
    assert.equal(nextRequests, 0);

    const cachedResponse = await prompt(api(harness.base, "/api/meta/movie/tt-meta"), "the cached metadata response");
    assert.equal(cachedResponse.status, 200);
    assert.equal(firstRequests, 2, "the successful retry is served from cache next time");
  });

  assert.equal(outbound.diagnostics().find((entry) => entry.host === "metadata-first.example")?.failures ?? 0, 0);
});

test("a no-gallery TMDB find disconnect leaves no id cache entry and stops addon fallback", async (t) => {
  clearTmdbCache();
  t.after(clearTmdbCache);
  const records = [addon("tmdb-fallback", [], { role: "both", resources: ["meta"] })];
  const config = { apiKey: "test-key", language: "cs", artwork: true };
  let providerSignal: AbortSignal | undefined;
  const lookupSignals: Array<AbortSignal | undefined> = [];
  const cached = cachedMetadataLookup(records, (type, id, signal) => {
    providerSignal = signal;
    return tmdbMeta(type, id, config, undefined, signal);
  });
  const harness = await mount(records, null, {
    cachedMeta: (type, id, language, viewer, opts) => {
      lookupSignals.push(opts?.signal);
      return cached.lookup(type, id, language, viewer, opts);
    },
  });
  t.after(harness.close);
  const held = heldJson();
  let findRequests = 0;
  let detailRequests = 0;
  let fallbackRequests = 0;
  let transportSignal: AbortSignal | undefined;
  let findStarted!: () => void;
  const findStartedSignal = new Promise<void>((resolve) => { findStarted = resolve; });
  const findMovie = { movie_results: [{ id: 31410 }], tv_results: [] };
  const detail = {
    id: 31410,
    title: "Retried through TMDB",
    overview: "Answer",
    backdrop_path: "/backdrop.jpg",
  };

  await withStubbedAddons((url, init) => {
    const parsed = new URL(url);
    if (parsed.hostname === "tmdb-fallback.example") {
      fallbackRequests += 1;
      return json({ meta: { id: "tt0090257", type: "movie", name: "Fallback", description: "Fallback answer" } });
    }
    if (parsed.pathname.includes("/find/")) {
      findRequests += 1;
      if (findRequests === 1) {
        transportSignal = init.signal as AbortSignal;
        assert.equal(transportSignal.aborted, false);
        findStarted();
        return held.response;
      }
      return json(findMovie);
    }
    if (parsed.pathname.endsWith("/movie/31410")) {
      detailRequests += 1;
      return json(detail);
    }
    throw new Error(`Unexpected TMDB URL ${url}`);
  }, async () => {
    const closes = harness.responseCloses();
    const target = new URL(harness.base);
    const socket = net.connect(Number(target.port), target.hostname, () => {
      socket.write(`GET /api/meta/movie/tt0090257 HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("error", () => undefined);
    t.after(() => socket.destroy());

    await prompt(findStartedSignal, "the TMDB find request");
    held.activate();
    await prompt(held.readStarted, "the TMDB find body read");
    const lookupSignal = lookupSignals[0];
    assert.deepEqual(lookupSignals, [lookupSignal], "one metadata lookup owns this request");
    assert.ok(lookupSignal, "the metadata lookup received the route signal");
    assert.equal(providerSignal, lookupSignal);
    socket.destroy();
    await prompt(new Promise<void>((resolve) => {
      if (lookupSignal?.aborted) resolve();
      else lookupSignal?.addEventListener("abort", () => resolve(), { once: true });
    }), "the metadata lookup signal abort");
    await prompt(new Promise<void>((resolve) => {
      if (providerSignal?.aborted) resolve();
      else providerSignal?.addEventListener("abort", () => resolve(), { once: true });
    }), "the metadata provider signal abort");
    await prompt(new Promise<void>((resolve) => {
      if (transportSignal?.aborted) resolve();
      else transportSignal?.addEventListener("abort", () => resolve(), { once: true });
    }), "the TMDB outbound signal abort");
    await prompt(held.bodyCancelled, "the TMDB find body cancel");
    await until(() => harness.responseCloses() === closes + 1, "the disconnected TMDB response");
    assert.equal(fallbackRequests, 0);
    assert.equal(cached.cached(), undefined);

    const retried = await prompt(api(harness.base, "/api/meta/movie/tt0090257"), "the retried TMDB response");
    assert.equal(retried.status, 200);
    const retriedBody = await retried.json() as MetaItem;
    assert.equal(retriedBody.name, "Retried through TMDB");
    assert.ok(retriedBody.background);
    assert.equal(findRequests, 2, "the cancelled /find was not cached as a miss");
    assert.equal(detailRequests, 1);
    assert.equal(fallbackRequests, 1, "an ordinary successful lookup still fills from its addon");

    const cachedResponse = await prompt(api(harness.base, "/api/meta/movie/tt0090257"), "the cached TMDB response");
    assert.equal(cachedResponse.status, 200);
    assert.equal(findRequests, 2);
    assert.equal(detailRequests, 1, "the successful metadata answer is cached");
    assert.equal(fallbackRequests, 1);
  });

  assert.equal(outbound.diagnostics().find((entry) => entry.host === "api.themoviedb.org")?.failures ?? 0, 0);
});

test("GET /api/trailer cancels a held Cinemeta body, retries, and serves the retry from cache", async (t) => {
  clearTrailerCache();
  clearTmdbCache();
  t.after(() => {
    clearTrailerCache();
    clearTmdbCache();
  });
  const harness = await mount([cinemeta()], null, { tmdbApiKey: "test-key" });
  t.after(harness.close);
  const held = heldJson();
  let cinemetaRequests = 0;
  let tmdbRequests = 0;
  let transportSignal: AbortSignal | undefined;
  let requestStarted!: () => void;
  const requestStartedSignal = new Promise<void>((resolve) => { requestStarted = resolve; });

  await withStubbedAddons((url, init) => {
    const parsed = new URL(url);
    if (parsed.hostname === "cinemeta.example") {
      cinemetaRequests += 1;
      if (cinemetaRequests === 1) {
        transportSignal = init.signal as AbortSignal;
        requestStarted();
        return held.response;
      }
      return json({ meta: { trailers: [{ source: "hhhhhhhhhhh", type: "Trailer" }] } });
    }
    tmdbRequests += 1;
    throw new Error(`TMDB must not follow a cancelled Cinemeta lookup: ${url}`);
  }, async () => {
    const closes = harness.responseCloses();
    const request = http.get(`${harness.base}/api/trailer/movie/tt1`);
    request.on("error", () => undefined);
    t.after(() => request.destroy());

    await prompt(requestStartedSignal, "the Cinemeta trailer request");
    held.activate();
    await prompt(held.readStarted, "the Cinemeta trailer body read");
    request.destroy();
    await prompt(new Promise<void>((resolve) => {
      if (transportSignal?.aborted) resolve();
      else transportSignal?.addEventListener("abort", () => resolve(), { once: true });
    }), "the Cinemeta trailer signal abort");
    await prompt(held.bodyCancelled, "the Cinemeta trailer body cancel");
    await until(() => harness.responseCloses() === closes + 1, "the disconnected trailer response");

    assert.equal(tmdbRequests, 0);

    const retried = await prompt(api(harness.base, "/api/trailer/movie/tt1"), "the retried trailer response");
    assert.equal(retried.status, 200);
    assert.deepEqual(await retried.json(), { trailer: { youtubeId: "hhhhhhhhhhh", provider: "cinemeta" } });
    assert.equal(cinemetaRequests, 2, "the cancelled trailer was not cached");

    const cached = await prompt(api(harness.base, "/api/trailer/movie/tt1"), "the cached trailer response");
    assert.equal(cached.status, 200);
    assert.deepEqual(await cached.json(), { trailer: { youtubeId: "hhhhhhhhhhh", provider: "cinemeta" } });
    assert.equal(cinemetaRequests, 2, "the successful retry is served from the trailer cache");
    assert.equal(tmdbRequests, 0);
  });

  assert.equal(outbound.diagnostics().find((entry) => entry.host === "cinemeta.example")?.failures ?? 0, 0);
});

test("GET /api/library/trailer cancels a held TMDB find, retries, and serves the retry from cache", async (t) => {
  clearTrailerCache();
  clearTmdbCache();
  t.after(() => {
    clearTrailerCache();
    clearTmdbCache();
  });
  const path = "lib_00000001/Films/Heat";
  const bound = { [path]: { type: "movie", id: "tt0090257", name: "Heat" } };
  const harness = await mount([], null, {
    libraries: [library("lib_00000001")],
    bound,
    tmdbApiKey: "test-key",
  });
  t.after(harness.close);
  const held = heldJson();
  let findRequests = 0;
  let videoRequests = 0;
  let transportSignal: AbortSignal | undefined;
  let findStarted!: () => void;
  const findStartedSignal = new Promise<void>((resolve) => { findStarted = resolve; });

  await withStubbedAddons((url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname.includes("/find/")) {
      findRequests += 1;
      if (findRequests === 1) {
        transportSignal = init.signal as AbortSignal;
        findStarted();
        return held.response;
      }
      return json({ movie_results: [{ id: 31410 }], tv_results: [] });
    }
    if (parsed.pathname.endsWith("/movie/31410/videos")) {
      videoRequests += 1;
      return json({ results: [{ key: "iiiiiiiiiii", site: "YouTube", type: "Trailer" }] });
    }
    throw new Error(`Unexpected TMDB URL ${url}`);
  }, async () => {
    const closes = harness.responseCloses();
    const request = http.get(`${harness.base}/api/library/trailer?path=${encodeURIComponent(path)}`);
    request.on("error", () => undefined);
    t.after(() => request.destroy());

    await prompt(findStartedSignal, "the TMDB trailer find request");
    held.activate();
    await prompt(held.readStarted, "the TMDB trailer find body read");
    request.destroy();
    await prompt(new Promise<void>((resolve) => {
      if (transportSignal?.aborted) resolve();
      else transportSignal?.addEventListener("abort", () => resolve(), { once: true });
    }), "the TMDB trailer find signal abort");
    await prompt(held.bodyCancelled, "the TMDB trailer find body cancel");
    await until(() => harness.responseCloses() === closes + 1, "the disconnected library trailer response");

    assert.equal(videoRequests, 0);

    const retried = await prompt(api(harness.base, `/api/library/trailer?path=${encodeURIComponent(path)}`), "the retried library trailer");
    assert.equal(retried.status, 200);
    assert.deepEqual(await retried.json(), { trailer: { youtubeId: "iiiiiiiiiii", provider: "tmdb" } });
    assert.equal(findRequests, 2, "the cancelled find left no TMDB id-cache entry");
    assert.equal(videoRequests, 1);

    const cached = await prompt(api(harness.base, `/api/library/trailer?path=${encodeURIComponent(path)}`), "the cached library trailer");
    assert.equal(cached.status, 200);
    assert.deepEqual(await cached.json(), { trailer: { youtubeId: "iiiiiiiiiii", provider: "tmdb" } });
    assert.equal(findRequests, 2, "the trailer cache serves the retried answer");
    assert.equal(videoRequests, 1);
  });

  assert.equal(outbound.diagnostics().find((entry) => entry.host === "api.themoviedb.org")?.failures ?? 0, 0);
});

test("a gallery client disconnect does not cancel a shared gallery waiter", async (t) => {
  const harness = await mount([], { id: "tt0090257", type: "movie", name: "Gallery" }, { tmdbApiKey: "test-key" });
  t.after(harness.close);
  const held = heldJson();
  let findRequests = 0;
  let imageRequests = 0;
  let findStarted!: () => void;
  const findStartedSignal = new Promise<void>((resolve) => { findStarted = resolve; });

  await withStubbedAddons((url) => {
    const parsed = new URL(url);
    if (parsed.pathname.includes("/find/")) {
      findRequests += 1;
      findStarted();
      return held.response;
    }
    if (parsed.pathname.endsWith("/movie/31410/images")) {
      imageRequests += 1;
      return json({ posters: [{ file_path: "/poster.jpg", iso_639_1: "en" }], backdrops: [], logos: [] });
    }
    throw new Error(`Unexpected TMDB URL ${url}`);
  }, async () => {
    const first = http.get(`${harness.base}/api/meta/movie/tt0090257?gallery=1`);
    first.on("error", () => undefined);
    t.after(() => first.destroy());
    await prompt(findStartedSignal, "the shared gallery find request");
    held.activate();
    await prompt(held.readStarted, "the shared gallery body read");

    const second = api(harness.base, "/api/meta/movie/tt0090257?gallery=1");
    await until(() => harness.lookups.length === 2, "the second gallery waiter");
    assert.equal(harness.signals.length, 2, "each gallery request owns a disconnect signal");
    assert.notEqual(harness.signals[0], harness.signals[1]);
    const firstClosed = new Promise<void>((resolve) => first.once("close", resolve));
    first.destroy();
    await prompt(firstClosed, "the disconnected gallery request");
    await prompt(new Promise<void>((resolve) => {
      if (harness.signals[0]?.aborted) resolve();
      else harness.signals[0]?.addEventListener("abort", () => resolve(), { once: true });
    }), "the first gallery route signal abort");
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(harness.signals[1]?.aborted, false, "the remaining gallery route is still live");
    assert.equal(held.cancelled(), false, "one waiter leaving does not abort the shared gallery");
    held.release({ movie_results: [{ id: 31410 }], tv_results: [] });
    const response = await prompt(second, "the surviving gallery response");
    assert.equal(response.status, 200);
    const body = await response.json() as MetaItem & { images?: unknown[] };
    assert.equal(body.images?.length, 1);
    assert.equal(findRequests, 1);
    assert.equal(imageRequests, 1);
  });

  assert.equal(outbound.diagnostics().find((entry) => entry.host === "api.themoviedb.org")?.failures ?? 0, 0);
});

test("all gallery clients leaving during TMDB find cancel its body, cache nothing, and a retry succeeds", async (t) => {
  clearTmdbCache();
  t.after(clearTmdbCache);
  const harness = await mount([], { id: "tt5310001", type: "movie", name: "Gallery find retry" }, { tmdbApiKey: "test-key" });
  t.after(harness.close);
  const held = heldJson();
  let findRequests = 0;
  let imageRequests = 0;
  let transportSignal: AbortSignal | undefined;
  let findStarted!: () => void;
  const findStartedSignal = new Promise<void>((resolve) => { findStarted = resolve; });

  await withStubbedAddons((url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname.includes("/find/")) {
      findRequests += 1;
      if (findRequests === 1) {
        transportSignal = init.signal as AbortSignal;
        findStarted();
        return held.response;
      }
      return json({ movie_results: [{ id: 31410 }], tv_results: [] });
    }
    if (parsed.pathname.endsWith("/movie/31410/images")) {
      imageRequests += 1;
      return json({ posters: [{ file_path: "/retried.jpg", iso_639_1: "en" }], backdrops: [], logos: [] });
    }
    throw new Error(`Unexpected TMDB URL ${url}`);
  }, async () => {
    const closes = harness.responseCloses();
    const first = http.get(`${harness.base}/api/meta/movie/tt5310001?gallery=1`);
    first.on("error", () => undefined);
    t.after(() => first.destroy());
    await prompt(findStartedSignal, "the gallery find request");
    held.activate();
    await prompt(held.readStarted, "the gallery find body read");

    const second = http.get(`${harness.base}/api/meta/movie/tt5310001?gallery=1`);
    second.on("error", () => undefined);
    t.after(() => second.destroy());
    await until(() => harness.lookups.length === 2, "the second gallery waiter");
    assert.equal(harness.signals.length, 2);
    assert.notEqual(transportSignal, harness.signals[0]);
    assert.notEqual(transportSignal, harness.signals[1]);

    first.destroy();
    await prompt(new Promise<void>((resolve) => {
      if (harness.signals[0]?.aborted) resolve();
      else harness.signals[0]?.addEventListener("abort", () => resolve(), { once: true });
    }), "the first gallery route signal abort");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(transportSignal?.aborted, false, "the remaining gallery waiter keeps TMDB find alive");
    assert.equal(held.cancelled(), false);

    second.destroy();
    await prompt(new Promise<void>((resolve) => {
      if (harness.signals[1]?.aborted) resolve();
      else harness.signals[1]?.addEventListener("abort", () => resolve(), { once: true });
    }), "the last gallery route signal abort");
    await prompt(new Promise<void>((resolve) => {
      if (transportSignal?.aborted) resolve();
      else transportSignal?.addEventListener("abort", () => resolve(), { once: true });
    }), "the abandoned TMDB find signal abort");
    await prompt(held.bodyCancelled, "the abandoned TMDB find body cancel");
    await until(() => harness.responseCloses() >= closes + 2, "both disconnected gallery responses");

    const retried = await prompt(api(harness.base, "/api/meta/movie/tt5310001?gallery=1"), "the retried gallery response");
    assert.equal(retried.status, 200);
    const body = await retried.json() as MetaItem & { images?: unknown[] };
    assert.equal(body.images?.length, 1);
    assert.equal(findRequests, 2, "the cancelled find was not cached as a miss");
    assert.equal(imageRequests, 1);

    const cached = await prompt(api(harness.base, "/api/meta/movie/tt5310001?gallery=1"), "the cached gallery response");
    assert.equal(cached.status, 200);
    assert.equal((await cached.json() as MetaItem & { images?: unknown[] }).images?.length, 1);
    assert.equal(findRequests, 2, "the successful retry is cached");
    assert.equal(imageRequests, 1);
  });

  assert.equal(outbound.diagnostics().find((entry) => entry.host === "api.themoviedb.org")?.failures ?? 0, 0);
});

test("all gallery clients leaving during TMDB images cancel its body, cache nothing, and a retry succeeds", async (t) => {
  clearTmdbCache();
  t.after(clearTmdbCache);
  const harness = await mount([], { id: "tmdb:5310002", type: "movie", name: "Gallery images retry" }, { tmdbApiKey: "test-key" });
  t.after(harness.close);
  const held = heldJson();
  let imageRequests = 0;
  let transportSignal: AbortSignal | undefined;
  let imageStarted!: () => void;
  const imageStartedSignal = new Promise<void>((resolve) => { imageStarted = resolve; });

  await withStubbedAddons((url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/movie/5310002/images")) {
      imageRequests += 1;
      if (imageRequests === 1) {
        transportSignal = init.signal as AbortSignal;
        imageStarted();
        return held.response;
      }
      return json({ posters: [{ file_path: "/retried.jpg", iso_639_1: "en" }], backdrops: [], logos: [] });
    }
    throw new Error(`Unexpected TMDB URL ${url}`);
  }, async () => {
    const closes = harness.responseCloses();
    const first = http.get(`${harness.base}/api/meta/movie/tmdb%3A5310002?gallery=1`);
    first.on("error", () => undefined);
    t.after(() => first.destroy());
    await prompt(imageStartedSignal, "the gallery images request");
    held.activate();
    await prompt(held.readStarted, "the gallery images body read");

    const second = http.get(`${harness.base}/api/meta/movie/tmdb%3A5310002?gallery=1`);
    second.on("error", () => undefined);
    t.after(() => second.destroy());
    await until(() => harness.lookups.length === 2, "the second gallery waiter");
    assert.equal(harness.signals.length, 2);
    assert.notEqual(transportSignal, harness.signals[0]);
    assert.notEqual(transportSignal, harness.signals[1]);

    first.destroy();
    await prompt(new Promise<void>((resolve) => {
      if (harness.signals[0]?.aborted) resolve();
      else harness.signals[0]?.addEventListener("abort", () => resolve(), { once: true });
    }), "the first gallery route signal abort");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(transportSignal?.aborted, false, "the remaining gallery waiter keeps TMDB images alive");
    assert.equal(held.cancelled(), false);

    second.destroy();
    await prompt(new Promise<void>((resolve) => {
      if (harness.signals[1]?.aborted) resolve();
      else harness.signals[1]?.addEventListener("abort", () => resolve(), { once: true });
    }), "the last gallery route signal abort");
    await prompt(new Promise<void>((resolve) => {
      if (transportSignal?.aborted) resolve();
      else transportSignal?.addEventListener("abort", () => resolve(), { once: true });
    }), "the abandoned TMDB images signal abort");
    await prompt(held.bodyCancelled, "the abandoned TMDB images body cancel");
    await until(() => harness.responseCloses() >= closes + 2, "both disconnected gallery responses");

    const retried = await prompt(api(harness.base, "/api/meta/movie/tmdb%3A5310002?gallery=1"), "the retried gallery response");
    assert.equal(retried.status, 200);
    const body = await retried.json() as MetaItem & { images?: unknown[] };
    assert.equal(body.images?.length, 1);
    assert.equal(imageRequests, 2, "the cancelled images body was not cached as an empty gallery");

    const cached = await prompt(api(harness.base, "/api/meta/movie/tmdb%3A5310002?gallery=1"), "the cached gallery response");
    assert.equal(cached.status, 200);
    assert.equal((await cached.json() as MetaItem & { images?: unknown[] }).images?.length, 1);
    assert.equal(imageRequests, 2, "the successful retry is cached");
  });

  assert.equal(outbound.diagnostics().find((entry) => entry.host === "api.themoviedb.org")?.failures ?? 0, 0);
});

test("a disconnected subtitle target lookup is not cached and a later request retries", async (t) => {
  resetImdbTargets();
  const id = "mpa:route-cancel:needs-imdb";
  const prefixed = addon("subtitle-retry", [], { role: "both", resources: ["subtitles"] });
  prefixed.manifest.resources = [{ name: "subtitles", types: ["movie"], idPrefixes: ["tt"] }];
  const records = [
    addon("subtitle-meta-first", [], { role: "both", resources: ["meta"] }),
    addon("subtitle-meta-next", [], { role: "both", resources: ["meta"] }),
    prefixed,
  ];
  const harness = await mount(records);
  t.after(harness.close);
  const held = heldAddon();
  const calls: string[] = [];
  let firstMetadataRequests = 0;

  await withStubbedAddons((url, init) => {
    const host = new URL(url).hostname;
    calls.push(host);
    if (host === "subtitle-meta-first.example") {
      firstMetadataRequests += 1;
      if (firstMetadataRequests === 1) return held.handler(url, init);
      return json({ meta: { id, type: "movie", name: "Retried", imdb_id: "tt7654321" } });
    }
    if (host === "subtitle-meta-next.example") return json({ meta: { id, type: "movie", name: "Wrong target" } });
    if (host === "subtitle-retry.example") {
      return json({ subtitles: [{ url: "https://cdn.example/retried.srt", lang: "cs" }] });
    }
    throw new Error(`Unexpected addon host ${host}`);
  }, async () => {
    const closes = harness.responseCloses();
    const request = http.get(`${harness.base}/api/subtitles/movie/${encodeURIComponent(id)}`);
    request.on("error", () => undefined);
    t.after(() => request.destroy());

    await prompt(held.readStarted, "the target metadata body read");
    const signal = held.signal()!;
    request.destroy();
    await prompt(new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    }), "the target metadata signal abort");
    await prompt(held.bodyCancelled, "the target metadata body cancel");
    await until(() => harness.responseCloses() === closes + 1, "the disconnected response close");
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(calls.includes("subtitle-meta-next.example"), false, "a cancelled lookup does not try the next metadata addon");

    const response = await api(harness.base, `/api/subtitles/movie/${encodeURIComponent(id)}`);
    assert.equal(response.status, 200);
    const body = await response.json() as Array<{ addonName: string }>;
    assert.deepEqual(body.map((item) => item.addonName), ["Addon subtitle-retry"]);
    assert.equal(firstMetadataRequests, 2, "the healthy request retries the aborted target lookup");
    assert.equal(calls.includes("subtitle-meta-next.example"), false, "the healthy request finds the first target");

    const cached = await api(harness.base, `/api/subtitles/movie/${encodeURIComponent(id)}`);
    assert.equal(cached.status, 200);
    assert.equal(firstMetadataRequests, 2, "the successful target is cached for the next request");
  });

  assert.equal(outbound.diagnostics().find((entry) => entry.host === "subtitle-meta-first.example")?.failures ?? 0, 0);
});

test("a healthy addon request still answers and its ordinary response close does not abort", async (t) => {
  const records = [
    addon("catalog-ok", [{ type: "movie", id: "top" }]),
    addon("search-ok", [{ type: "movie", id: "top", extra: [{ name: "search" }] }]),
    addon("stream-ok", [], { role: "source", resources: ["stream"] }),
    addon("subtitle-ok", [], { role: "both", resources: ["subtitles"] }),
  ];
  const harness = await mount(records);
  t.after(harness.close);
  const signals = new Map<string, AbortSignal>();

  await withStubbedAddons((url, init) => {
    const parsed = new URL(url);
    signals.set(parsed.hostname, init.signal as AbortSignal);
    if (parsed.hostname === "catalog-ok.example") return json({ metas: [{ id: "tt1", type: "movie", name: "Catalogue" }] });
    if (parsed.hostname === "search-ok.example") return json({ metas: [{ id: "tt2", type: "movie", name: "Search" }] });
    if (parsed.hostname === "subtitle-ok.example") return json({ subtitles: [{ url: "https://cdn.example/subtitle.srt", lang: "cs" }] });
    return json({ streams: [{ url: "https://cdn.example/movie.mp4", name: "Healthy source" }] });
  }, async () => {
    const catalogResponse = await api(harness.base, "/api/catalog?addon=catalog-ok&type=movie&id=top");
    assert.equal(catalogResponse.status, 200);
    assert.deepEqual((await catalogResponse.json() as Array<{ name: string }>).map((item) => item.name), ["Catalogue"]);

    const searchResponse = await api(harness.base, "/api/search?query=dune");
    assert.equal(searchResponse.status, 200);
    assert.deepEqual((await searchResponse.json() as { items: Array<{ name: string }> }).items.map((item) => item.name), ["Search"]);

    const streamsResponse = await api(harness.base, "/api/streams/movie/tt1");
    assert.equal(streamsResponse.status, 200);
    const streams = await streamsResponse.json() as Array<{ addonKey: string; name: string }>;
    assert.deepEqual(streams.map((item) => [item.addonKey, item.name]), [["stream-ok", "Healthy source"]]);

    const subtitlesResponse = await api(harness.base, "/api/subtitles/movie/tt3");
    assert.equal(subtitlesResponse.status, 200);
    const subtitles = await subtitlesResponse.json() as Array<{ addonName: string }>;
    assert.deepEqual(subtitles.map((item) => item.addonName), ["Addon subtitle-ok"]);
  });

  await until(() => harness.responseCloses() === 4, "all four successful response closes");
  assert.deepEqual([...signals.keys()].sort(), ["catalog-ok.example", "search-ok.example", "stream-ok.example", "subtitle-ok.example"]);
  for (const signal of signals.values()) assert.equal(signal.aborted, false);
});

test("GET /api/streams/:type/:id returns no source from an addon the caller may not use", async (t) => {
  const records = [
    addon("open", [], { role: "source", allowedUsers: [alice.id], resources: ["stream"] }),
    addon("shut", [], { role: "source", resources: ["stream"] }),
  ];
  const user = await mount(records, null, { viewer: alice });
  t.after(user.close);
  const administrator = await mount(records, null, { viewer: admin });
  t.after(administrator.close);

  await withStubbedAddons((url) => json({ streams: [{ url: `https://cdn.example/${new URL(url).host}/movie.mp4`, name: new URL(url).host }] }), async () => {
    const refused = await (await api(user.base, "/api/streams/movie/tt1")).json() as Array<{ addonKey: string }>;
    assert.deepEqual(refused.map((item) => item.addonKey), ["open"], "the disallowed addon contributes nothing");

    const all = await (await api(administrator.base, "/api/streams/movie/tt1")).json() as Array<{ addonKey: string }>;
    assert.deepEqual(all.map((item) => item.addonKey).sort(), ["open", "shut"], "an administrator still reaches both");
  });
});

const localCopy = (overrides: Partial<Awaited<ReturnType<CatalogDeps["localCopies"]>>[number]> = {}) => ({
  key: "lib_00000001/Heat (1995)/Heat 1995 1080p.mkv",
  libraryId: "lib_00000001",
  libraryName: "Films",
  path: "Heat (1995)/Heat 1995 1080p.mkv",
  size: 1234,
  ...overrides,
});

test("GET /api/local-streams keeps a long dotted file name instead of redacting it", async (t) => {
  const harness = await mount([], null, {
    localCopies: async () => [localCopy({ key: "lib_00000001/Heat.1995.1080p/Heat.1995.1080p.BluRay.mkv", path: "Heat.1995.1080p/Heat.1995.1080p.BluRay.mkv" })],
  });
  t.after(harness.close);
  const body = await (await api(harness.base, "/api/local-streams/movie/tt0113277")).json() as Array<{ behaviorHints: { filename?: string } }>;
  assert.equal(body[0]!.behaviorHints.filename, "Heat.1995.1080p.BluRay.mkv");
});

test("GET /api/local-streams mints one library entry per copy", async (t) => {
  const asked: Array<{ type: string; id: string }> = [];
  const harness = await mount([], null, {
    localCopies: async (type, id) => { asked.push({ type, id }); return [localCopy()]; },
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/local-streams/movie/tt0113277");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(asked, [{ type: "movie", id: "tt0113277" }]);
  const body = await response.json() as Array<Record<string, unknown>>;
  assert.equal(body.length, 1);
  const entry = body[0]!;
  assert.equal(entry.kind, "library");
  assert.equal(entry.playable, true);
  assert.equal(entry.localPath, "Heat (1995)/Heat 1995 1080p.mkv");
  assert.equal(entry.libraryName, "Films");
  assert.equal((entry.behaviorHints as { videoSize?: number; filename?: string }).videoSize, 1234);
  assert.equal((entry.behaviorHints as { videoSize?: number; filename?: string }).filename, "Heat 1995 1080p.mkv");
  assert.equal(typeof entry.sourceId, "string");
  assert.ok(entry.sourceId);
});

test("the local listing re-checks every library it is about to name", async (t) => {
  const asked: Array<string | undefined> = [];
  const harness = await mount([], null, {
    localCopies: async () => [
      localCopy(),
      localCopy({ key: "lib_00000002/Ronin (1998)/Ronin.mkv", libraryId: "lib_00000002", libraryName: "More" }),
      localCopy({ key: "lib_00000001/Heat (1995)/Heat.1995.720p.mkv", size: 800 }),
    ],
    access: (_req, need) => { asked.push(need?.libraryId); },
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/local-streams/movie/tt0113277");
  assert.equal(response.status, 200);
  assert.deepEqual(asked, ["lib_00000001", "lib_00000002"], "each library once, whatever the copies say");
});

test("a library the caller may no longer open refuses the listing", async (t) => {
  const harness = await mount([], null, {
    localCopies: async () => [localCopy(), localCopy({ libraryId: "lib_00000002", key: "lib_00000002/Heat (1995)/Heat.1995.1080p.mkv" })],
    access: (_req, need) => {
      if (need?.libraryId === "lib_00000002") throw Object.assign(new Error("gone"), { status: 404 });
    },
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/local-streams/movie/tt0113277");
  assert.equal(response.status, 404, "the answer is refused, not handed over without the library");
  assert.ok(!Array.isArray(await response.json()));
});

test("GET /api/local-streams answers an empty listing when nothing is bound", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/local-streams/movie/tt0113277");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
});

test("GET /api/local-streams needs a session", async (t) => {
  const harness = await mount([], null, { viewer: null });
  t.after(harness.close);
  assert.equal((await api(harness.base, "/api/local-streams/movie/tt0113277")).status, 401);
});

test("a subtitle remembers which addon it came from", async (t) => {
  const records = [addon("subs", [], { role: "source", allowedUsers: [alice.id], resources: ["subtitles"] })];
  const harness = await mount(records, null, { viewer: alice });
  t.after(harness.close);

  await withStubbedAddons((url) => json({ subtitles: [{ url: `https://cdn.example/${new URL(url).host}/sub.srt`, lang: "cs" }] }), async () => {
    const listed = await (await api(harness.base, "/api/subtitles/movie/tt1")).json() as Array<{ subtitleId: string }>;
    assert.equal(listed.length, 1);
    // Without the key the record names no content at all, so the sweep that runs when an
    // addon is removed or taken away cannot recognise it, and the subtitle goes on being
    // served from an addon the account may no longer use.
    const resource = mediaResources.get(listed[0].subtitleId, "session-1", "subtitle");
    assert.equal(resource.stream.addonKey, "subs");
  });
});

test("the subtitle listing re-checks each addon it is about to name", async (t) => {
  // A grant withdrawn while the addon was still answering has to reach the listing, the way
  // it reaches the stream listing: otherwise the language, the addon's name and an issued id
  // are handed over for a source the account no longer has.
  const records = [addon("subs", [], { role: "source", allowedUsers: [alice.id], resources: ["subtitles"] })];
  const asked: Array<string | undefined> = [];
  const harness = await mount(records, null, {
    viewer: alice,
    access: (_req, need) => {
      asked.push(need?.addonKey);
      if (need?.addonKey === "subs") throw Object.assign(new Error("gone"), { status: 404 });
    },
  });
  t.after(harness.close);

  await withStubbedAddons((url) => json({ subtitles: [{ url: `https://cdn.example/${new URL(url).host}/sub.srt`, lang: "cs" }] }), async () => {
    const response = await api(harness.base, "/api/subtitles/movie/tt1");
    assert.equal(response.status, 404, "the listing is refused, not answered without the addon");
    assert.deepEqual(asked, ["subs"], "the re-check names the addon, so it reaches the grant at all");
  });
});

const subtitleOwner = { userId: "usr_00000001", sid: "session-1", expiresAt: Number.MAX_SAFE_INTEGER };
const externalSubtitle = (url: string) => mediaResources.add({ url, addonKey: "subs" }, subtitleOwner, "subtitle");

const heldMediaText = () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let started!: () => void;
  let cancelled!: () => void;
  let pulled = false;
  const readStarted = new Promise<void>((resolve) => { started = resolve; });
  const bodyCancelled = new Promise<void>((resolve) => { cancelled = resolve; });
  const response = new Response(new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    pull() {
      if (!pulled) {
        pulled = true;
        started();
      }
      return new Promise<void>(() => undefined);
    },
    cancel() { cancelled(); },
  }), { headers: { "content-type": "application/x-subrip" } });
  return {
    response,
    readStarted,
    bodyCancelled,
    release(text: string) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  };
};

test("an external subtitle holds its host slot through the body and preserves the VTT response headers", async (t) => {
  const host = "subtitle-held-body.example";
  const subtitleId = externalSubtitle(`https://${host}/subtitle.srt`);
  t.after(() => mediaResources.remove(subtitleId));
  const harness = await mount();
  t.after(harness.close);
  const held = heldMediaText();

  await withStubbedAddons(() => held.response, async () => {
    const pending = api(harness.base, `/api/subtitle/${subtitleId}`);
    await until(() => outbound.diagnostics().find((entry) => entry.host === host)?.active === 1, "the held subtitle slot");
    await prompt(held.readStarted, "the subtitle body read");

    held.release("1\n00:00:01,000 --> 00:00:02,000\nHello\n");
    const response = await prompt(pending, "the subtitle response");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("content-type") ?? "", /^text\/vtt/);
    const text = await response.text();
    assert.match(text, /^WEBVTT\n\n/);
    assert.match(text, /00:00:01\.000 --> 00:00:02\.000/);
    assert.equal(text.includes("00:00:01,000"), false);
  });

  await until(() => !outbound.diagnostics().some((entry) => entry.host === host), "the released host slot");
});

test("a client disconnect before subtitle headers is cancelled without failing the host", async (t) => {
  const host = "subtitle-before-headers.example";
  const subtitleId = externalSubtitle(`https://${host}/subtitle.srt`);
  t.after(() => mediaResources.remove(subtitleId));
  const harness = await mount();
  t.after(harness.close);
  let started!: () => void;
  let aborted!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  const signalAborted = new Promise<void>((resolve) => { aborted = resolve; });

  await withStubbedAddons((_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init.signal as AbortSignal;
    started();
    signal.addEventListener("abort", () => {
      aborted();
      reject(signal.reason);
    }, { once: true });
  }), async () => {
    const request = http.get(`${harness.base}/api/subtitle/${subtitleId}`);
    request.on("error", () => undefined);
    t.after(() => request.destroy());
    const closed = new Promise<void>((resolve) => request.once("close", resolve));
    await prompt(requestStarted, "the subtitle request");
    request.destroy();
    await prompt(signalAborted, "the subtitle request abort");
    await prompt(closed, "the disconnected subtitle request");
    await until(() => !outbound.diagnostics().some((entry) => entry.host === host), "the cancelled subtitle slot");
  });

  assert.equal(outbound.diagnostics().find((entry) => entry.host === host)?.failures ?? 0, 0);
});

test("a client disconnect while an external subtitle body is held cancels it without failing the host", async (t) => {
  const host = "subtitle-during-body.example";
  const subtitleId = externalSubtitle(`https://${host}/subtitle.srt`);
  t.after(() => mediaResources.remove(subtitleId));
  const harness = await mount();
  t.after(harness.close);
  const held = heldMediaText();

  await withStubbedAddons(() => held.response, async () => {
    const request = http.get(`${harness.base}/api/subtitle/${subtitleId}`);
    request.on("error", () => undefined);
    t.after(() => request.destroy());
    const closed = new Promise<void>((resolve) => request.once("close", resolve));
    await until(() => outbound.diagnostics().find((entry) => entry.host === host)?.active === 1, "the held subtitle slot");
    await prompt(held.readStarted, "the held subtitle body");
    request.destroy();
    await prompt(held.bodyCancelled, "the held subtitle body cancellation");
    await prompt(closed, "the disconnected subtitle request");
    await until(() => !outbound.diagnostics().some((entry) => entry.host === host), "the cancelled held slot");
  });

  assert.equal(outbound.diagnostics().find((entry) => entry.host === host)?.failures ?? 0, 0);
});

test("an oversized external subtitle is cancelled at the media text limit and accounted as a failure", async (t) => {
  const host = "subtitle-too-large.example";
  const subtitleId = externalSubtitle(`https://${host}/subtitle.srt`);
  t.after(() => mediaResources.remove(subtitleId));
  const harness = await mount();
  t.after(harness.close);
  let cancel!: () => void;
  const bodyCancelled = new Promise<void>((resolve) => { cancel = resolve; });

  await withStubbedAddons(() => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { cancel(); },
  }), { headers: { "content-type": "application/x-subrip" } }), async () => {
    const response = await prompt(api(harness.base, `/api/subtitle/${subtitleId}`), "the oversized subtitle response");
    assert.equal(response.status, 400);
    assert.equal((await response.text()).includes("WEBVTT"), false);
    await prompt(bodyCancelled, "the oversized subtitle body cancellation");
  });

  assert.equal(outbound.diagnostics().find((entry) => entry.host === host)?.failures, 1);
});

test("a truncated external subtitle body is accounted as a host failure", async (t) => {
  const host = "subtitle-truncated.example";
  const subtitleId = externalSubtitle(`https://${host}/subtitle.srt`);
  t.after(() => mediaResources.remove(subtitleId));
  const harness = await mount();
  t.after(harness.close);

  await withStubbedAddons(() => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("WEBVTT\n\n"));
      controller.error(new TypeError("terminated"));
    },
  })), async () => {
    const response = await prompt(api(harness.base, `/api/subtitle/${subtitleId}`), "the truncated subtitle response");
    assert.equal(response.status, 400);
    assert.equal((await response.text()).includes("WEBVTT"), false);
  });

  assert.equal(outbound.diagnostics().find((entry) => entry.host === host)?.failures, 1);
});

test("an external subtitle re-checks addon access after the held body", async (t) => {
  const host = "subtitle-revoked.example";
  const subtitleId = externalSubtitle(`https://${host}/subtitle.srt`);
  t.after(() => mediaResources.remove(subtitleId));
  let allowed = true;
  let accessChecks = 0;
  const harness = await mount([], null, {
    access: () => {
      accessChecks += 1;
      if (!allowed) throw Object.assign(new Error("revoked"), { status: 404 });
    },
  });
  t.after(harness.close);
  const held = heldMediaText();

  await withStubbedAddons(() => held.response, async () => {
    const pending = api(harness.base, `/api/subtitle/${subtitleId}`);
    await until(() => outbound.diagnostics().find((entry) => entry.host === host)?.active === 1, "the held subtitle slot");
    await prompt(held.readStarted, "the subtitle body before revocation");
    allowed = false;
    held.release("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nsecret subtitle\n");
    const response = await prompt(pending, "the revoked subtitle response");
    assert.equal(response.status, 404);
    assert.equal((await response.text()).includes("secret subtitle"), false);
  });

  assert.equal(accessChecks, 2);
});

test("an external subtitle re-checks its resource after the held body", async (t) => {
  const host = "subtitle-resource-revoked.example";
  const subtitleId = externalSubtitle(`https://${host}/subtitle.srt`);
  t.after(() => mediaResources.remove(subtitleId));
  const harness = await mount();
  t.after(harness.close);
  const held = heldMediaText();

  await withStubbedAddons(() => held.response, async () => {
    const pending = api(harness.base, `/api/subtitle/${subtitleId}`);
    await until(() => outbound.diagnostics().find((entry) => entry.host === host)?.active === 1, "the held subtitle slot");
    await prompt(held.readStarted, "the subtitle body before resource removal");
    mediaResources.remove(subtitleId);
    held.release("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nsecret subtitle\n");
    const response = await prompt(pending, "the removed subtitle response");
    assert.equal(response.status, 404);
    assert.equal((await response.text()).includes("secret subtitle"), false);
  });
});

test("the sources a person picks from follow the priority they set, not the instance's", async (t) => {
  const records = [
    addon("first", [], { role: "source", allowedUsers: [alice.id], resources: ["stream"] }),
    addon("second", [], { role: "source", allowedUsers: [alice.id], resources: ["stream"] }),
  ];
  // The instance lists `first` before `second`; Alice has said she wants the other way round.
  // Priority is the one setting an ordinary account owns, so a list that ignores it -- and
  // this is the list a source is actually chosen from -- makes that setting a lie.
  const hers = await mount(records, null, { viewer: alice, addonOrder: { [alice.id]: ["second", "first"] } });
  t.after(hers.close);
  const instance = await mount(records, null, { viewer: admin });
  t.after(instance.close);

  await withStubbedAddons((url) => json({ streams: [{ url: `https://cdn.example/${new URL(url).host}/movie.mp4` }] }), async () => {
    const mine = await (await api(hers.base, "/api/streams/movie/tt1")).json() as Array<{ addonKey: string }>;
    assert.deepEqual(mine.map((item) => item.addonKey), ["second", "first"]);

    // The administrator's arrows edit the instance order, so that is the one they read back.
    const theirs = await (await api(instance.base, "/api/streams/movie/tt1")).json() as Array<{ addonKey: string }>;
    assert.deepEqual(theirs.map((item) => item.addonKey), ["first", "second"]);
  });
});

test("an administrator's own stored order is not applied to what they are shown", async (t) => {
  const records = [
    addon("first", [], { role: "source", resources: ["stream"] }),
    addon("second", [], { role: "source", resources: ["stream"] }),
  ];
  // An order kept from before a promotion stays stored and is simply not applied: the arrows
  // an administrator sees edit the instance order, and reading back a personal overlay would
  // make those arrows appear to do something they do not.
  const harness = await mount(records, null, { viewer: admin, addonOrder: { [admin.id]: ["second", "first"] } });
  t.after(harness.close);

  await withStubbedAddons((url) => json({ streams: [{ url: `https://cdn.example/${new URL(url).host}/movie.mp4` }] }), async () => {
    const items = await (await api(harness.base, "/api/streams/movie/tt1")).json() as Array<{ addonKey: string }>;
    assert.deepEqual(items.map((item) => item.addonKey), ["first", "second"]);
  });
});
