import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { messageKeyOf } from "../errors.js";
import type { IntroQuery } from "../intro-segments.js";
import type { Store } from "../store.js";
import { registerIntroSegmentRoutes, type IntroSegmentDeps } from "./intro-segments.js";

const mount = async (options: { secureMode?: boolean } = {}) => {
  const queries: IntroQuery[] = [];
  const app = express();
  const deps: IntroSegmentDeps = {
    store: {
      settings: () => ({ secureMode: options.secureMode ?? false }),
    } as unknown as Store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: () => undefined,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
    introSegments: {
      get: async (query) => {
        queries.push(query);
        return { intro: { start: 10, end: 40 } };
      },
    },
  };
  registerIntroSegmentRoutes(app, deps);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error), messageKey: messageKeyOf(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    queries,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

const get = (base: string, query: string) => fetch(`${base}/api/intro-segments?${query}`);

test("GET /api/intro-segments rejects a malformed IMDb id or an incomplete episode", async (t) => {
  const route = await mount();
  t.after(route.close);

  for (const query of [
    "imdb=not-an-imdb-id",
    "imdb=tt0903747&season=1",
    "imdb=tt0903747&episode=1",
    "imdb=tt0903747&season=-1&episode=1",
    "imdb=tt0903747&season=1.5&episode=1",
  ]) {
    const response = await get(route.base, query);
    assert.equal(response.status, 400, query);
    assert.equal((await response.json() as { messageKey?: string }).messageKey, "err.invalidRequest");
  }
  assert.deepEqual(route.queries, []);
});

test("secure mode answers empty without asking IntroDB", async (t) => {
  const route = await mount({ secureMode: true });
  t.after(route.close);

  const response = await get(route.base, "imdb=tt0903747&season=1&episode=1");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {});
  assert.deepEqual(route.queries, []);
});

test("GET /api/intro-segments passes a film lookup without episode fields", async (t) => {
  const route = await mount();
  t.after(route.close);

  const response = await get(route.base, "imdb=tt0903747");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { intro: { start: 10, end: 40 } });
  assert.deepEqual(route.queries, [{ imdbId: "tt0903747" }]);
});

test("GET /api/intro-segments passes an episode lookup with numeric fields", async (t) => {
  const route = await mount();
  t.after(route.close);

  const response = await get(route.base, "imdb=tt0903747&season=1&episode=2");

  assert.equal(response.status, 200);
  assert.deepEqual(route.queries, [{ imdbId: "tt0903747", season: 1, episode: 2 }]);
});
