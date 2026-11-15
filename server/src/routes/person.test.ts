import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import { messageKeyOf } from "../errors.js";
import { ExternalIdStore } from "../external-ids.js";
import { ImageProxy } from "../images.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import { clearPersonCache } from "../person-filmography.js";
import { configureSecureMode } from "../secure.js";
import { setFetchTransport } from "../security.js";
import { defaultPrefs, type Store } from "../store.js";
import { clearTitleExtrasCache } from "../title-extras.js";
import { clearTmdbCache } from "../tmdb.js";
import type { UserRecord } from "../users.js";
import { registerCatalogRoutes, type CatalogDeps } from "./catalog.js";

interface Harness {
  base: string;
  dataDir: string;
  close(): Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const tarantino = JSON.parse(readFileSync(path.join(here, "..", "..", "test-fixtures", "tmdb-person", "quentin-tarantino-138.json"), "utf8"));
const alice = { id: "usr_00000002", username: "alice", role: "user" } as unknown as UserRecord;
const bob = { id: "usr_00000003", username: "bob", role: "user" } as unknown as UserRecord;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fresh = () => {
  clearPersonCache();
  clearTitleExtrasCache();
  clearTmdbCache();
};

async function mount(options: {
  viewer?: UserRecord;
  apiKey?: string;
  owned?: ReadonlySet<string>;
  imageProxy?: ImageProxy;
} = {}): Promise<Harness> {
  const viewer = options.viewer ?? alice;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "stremio-person-route-"));
  const prefs = { ...defaultPrefs(), uiLanguage: "cs" as const };
  const store = {
    addons: () => [],
    libraries: () => [],
    sourceProfiles: () => [],
    remoteLibraries: () => [],
    mediaConnections: () => [],
    users: () => [viewer],
    userData: () => ({ addonOrder: [] }),
    settings: () => ({ tmdbApiKey: options.apiKey }),
  } as unknown as Store;
  const deps: CatalogDeps = {
    store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: () => viewer,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
    tmdbProvider: () => undefined,
    cachedMeta: async () => null,
    prefsOf: () => prefs,
    libraryTarget: async (value) => value,
    ownerOf: () => ({ userId: viewer.id, sid: "session-1", expiresAt: Number.MAX_SAFE_INTEGER }),
    trackMedia: () => undefined,
    libraryKey: (value) => value,
    localCopies: async () => [],
    ownedTitles: () => options.owned ?? new Set(),
    localCopyFacts: async () => new Map(),
    libraryUnits: async () => [],
    ownRecord: () => undefined,
    metaStore: { qualifiedMeta: () => ({}) } as unknown as LibraryMetaStore,
    externalIds: { ids: async () => ({}) } as unknown as ExternalIdStore,
    subtitleDelay: () => 0,
    mediaSources: {} as unknown as CatalogDeps["mediaSources"],
    ...(options.imageProxy ? { imageProxy: options.imageProxy } : {}),
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
    dataDir,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function withStubbedTmdb(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
  run: () => Promise<void>,
) {
  setFetchTransport(async (url, init) => handler(url, init));
  try {
    await run();
  } finally {
    setFetchTransport();
  }
}

const personRequest = (harness: Harness, pathname: string) => fetch(`${harness.base}${pathname}`);

test("GET /api/person/:tmdbId returns the contract shape from one TMDB request", async (t) => {
  fresh();
  t.after(fresh);
  configureSecureMode(() => false);
  t.after(() => configureSecureMode(() => true));
  const harness = await mount({ apiKey: "route-key" });
  t.after(harness.close);
  const calls: string[] = [];

  await withStubbedTmdb((url) => {
    calls.push(url.href);
    return json(tarantino);
  }, async () => {
    const response = await personRequest(harness, "/api/person/138?language=en-US");
    assert.equal(response.status, 200);
    const body = await response.json() as {
      id: number;
      name: string;
      photo?: string;
      sections: Array<{ key: string; titles: Array<{ type: string; tmdbId: number; id: string; name: string; year?: string; poster?: string; jobs?: string[]; character?: string; inLibrary?: boolean }> }>;
    };
    assert.equal(body.id, 138);
    assert.equal(body.name, "Quentin Tarantino");
    assert.match(body.photo ?? "", /^https:\/\/image\.tmdb\.org\/t\/p\/w185\//);
    assert.deepEqual(body.sections.map((section) => section.key), ["crew", "acting"]);
    const pulp = body.sections.flatMap((section) => section.titles).find((title) => title.tmdbId === 680);
    assert.ok(pulp);
    assert.equal(pulp.type, "movie");
    assert.equal(pulp.id, "tmdb:680");
    assert.match(pulp.poster ?? "", /^https:\/\/image\.tmdb\.org\/t\/p\/w342\//);
  });

  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!);
  assert.equal(url.pathname, "/3/person/138");
  assert.equal(url.searchParams.get("append_to_response"), "combined_credits");
  assert.equal(calls.some((call) => call.includes("/external_ids")), false);
});

test("two viewers share the cached filmography but get their own library marks", async (t) => {
  fresh();
  t.after(fresh);
  const aliceHarness = await mount({ viewer: alice, apiKey: "route-key", owned: new Set(["movie:680"]) });
  const bobHarness = await mount({ viewer: bob, apiKey: "route-key" });
  t.after(aliceHarness.close);
  t.after(bobHarness.close);
  let requests = 0;

  await withStubbedTmdb(() => {
    requests += 1;
    return json(tarantino);
  }, async () => {
    const [aliceResponse, bobResponse] = await Promise.all([
      personRequest(aliceHarness, "/api/person/138"),
      personRequest(bobHarness, "/api/person/138"),
    ]);
    const aliceBody = await aliceResponse.json() as { sections: Array<{ titles: Array<{ tmdbId: number; inLibrary?: boolean }> }> };
    const bobBody = await bobResponse.json() as { sections: Array<{ titles: Array<{ tmdbId: number; inLibrary?: boolean }> }> };
    const pulp = (body: typeof aliceBody) => body.sections.flatMap((section) => section.titles).find((title) => title.tmdbId === 680);
    assert.equal(pulp(aliceBody)?.inLibrary, true);
    assert.equal("inLibrary" in pulp(bobBody)!, false);
  });
  assert.equal(requests, 1);
});

test("person failures distinguish unavailable, missing, failed and malformed requests", async (t) => {
  fresh();
  t.after(fresh);
  const noKey = await mount();
  const harness = await mount({ apiKey: "route-key" });
  t.after(noKey.close);
  t.after(harness.close);

  const unavailable = await personRequest(noKey, "/api/person/138");
  assert.equal(unavailable.status, 404);
  assert.equal((await unavailable.json() as { messageKey?: string }).messageKey, "err.personUnavailable");

  const malformed = await personRequest(harness, "/api/person/0");
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json() as { messageKey?: string }).messageKey, "err.invalidRequest");

  await withStubbedTmdb(() => json({}, 404), async () => {
    const missing = await personRequest(harness, "/api/person/404");
    assert.equal(missing.status, 404);
    assert.equal((await missing.json() as { messageKey?: string }).messageKey, "err.personUnavailable");
  });
  clearPersonCache();
  await withStubbedTmdb(() => json({}, 500), async () => {
    const failed = await personRequest(harness, "/api/person/500");
    assert.equal(failed.status, 502);
    assert.equal((await failed.json() as { messageKey?: string }).messageKey, "err.personLookupFailed");
  });
});

test("GET /api/person/title resolves IMDb, none and failure as different outcomes", async (t) => {
  fresh();
  t.after(fresh);
  const harness = await mount({ apiKey: "route-key" });
  t.after(harness.close);

  await withStubbedTmdb(() => json({ imdb_id: "tt0110912" }), async () => {
    const response = await personRequest(harness, "/api/person/title/movie/680");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: "tt0110912" });
  });

  await withStubbedTmdb(() => json({ imdb_id: null }), async () => {
    const response = await personRequest(harness, "/api/person/title/movie/501");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: "tmdb:501", imdb: "none" });
  });

  await withStubbedTmdb(() => json({}, 500), async () => {
    const response = await personRequest(harness, "/api/person/title/movie/502");
    assert.equal(response.status, 502);
    assert.equal((await response.json() as { messageKey?: string }).messageKey, "err.personLookupFailed");
  });

  const malformed = await personRequest(harness, "/api/person/title/book/680");
  assert.equal(malformed.status, 400);
});

test("secure mode proxies the portrait and every title poster", async (t) => {
  fresh();
  t.after(fresh);
  const imageDir = await mkdtemp(path.join(os.tmpdir(), "stremio-person-images-"));
  const imageProxy = new ImageProxy(imageDir, 1024 * 1024, 0);
  await imageProxy.load();
  configureSecureMode(() => true);
  t.after(async () => {
    configureSecureMode(() => true);
    await imageProxy.flush();
    await rm(imageDir, { recursive: true, force: true });
  });
  const harness = await mount({ apiKey: "route-key", imageProxy });
  t.after(harness.close);

  await withStubbedTmdb(() => json(tarantino), async () => {
    const response = await personRequest(harness, "/api/person/138");
    assert.equal(response.status, 200);
    const body = await response.json() as {
      photo?: string;
      sections: Array<{ titles: Array<{ poster?: string; background?: string }> }>;
    };
    assert.match(body.photo ?? "", /^\/api\/image\//);
    const posters = body.sections.flatMap((section) => section.titles).flatMap((title) => title.poster ? [title.poster] : []);
    assert.ok(posters.length > 0);
    assert.equal(posters.every((poster) => poster.startsWith("/api/image/")), true);
    const backgrounds = body.sections.flatMap((section) => section.titles).flatMap((title) => title.background ? [title.background] : []);
    assert.ok(backgrounds.length > 0);
    assert.equal(backgrounds.every((background) => background.startsWith("/api/image/")), true);
  });
});

test("person requests leave the data directory untouched", async (t) => {
  fresh();
  t.after(fresh);
  const harness = await mount({ apiKey: "route-key" });
  t.after(harness.close);
  const before = await readdir(harness.dataDir);

  await withStubbedTmdb(() => json(tarantino), async () => {
    assert.equal((await personRequest(harness, "/api/person/138")).status, 200);
  });

  assert.deepEqual(await readdir(harness.dataDir), before);
});
