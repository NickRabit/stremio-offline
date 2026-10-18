import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { messageKeyOf } from "../errors.js";
import type { SearchSnapshot } from "../search-contracts.js";
import { SearchError } from "../search-contracts.js";
import type { SearchAuthority, SearchSessionManager } from "../search-session.js";
import { registerSearchEverywhereRoutes, searchEverywhereEnabled } from "./search-everywhere.js";

interface Harness {
  base: string;
  close(): Promise<void>;
}

const snapshot = (): SearchSnapshot => ({
  revision: 1,
  state: "partial",
  sources: [],
  clusters: [],
  unidentified: [],
  aliases: [],
  limitReached: false,
});

const mount = async (): Promise<Harness> => {
  const app = express();
  app.use(express.json());
  const authority: SearchAuthority = {
    userId: "usr_00000001",
    sid: "sid_00000000",
    isCurrent: () => true,
  };
  const manager = {
    start: async () => ({ id: "ss_abc", snapshot: snapshot() }),
    poll: async (_authority: SearchAuthority, id: string, revision: number, signal?: AbortSignal) => {
      if (id !== "ss_abc") throw new SearchError("search-not-found", 404);
      if (revision === 9) throw new SearchError("search-restart-required", 410);
      if (signal?.aborted) return { changed: false, revision };
      return { changed: false, revision };
    },
    pageAll: () => ({ revision: 2 }),
    retry: () => ({ revision: 3 }),
    members: () => ({ clusterKey: "c1", members: [], truncated: false }),
    delete: () => undefined,
  } as unknown as SearchSessionManager;
  registerSearchEverywhereRoutes(app, {
    manager,
    authorityOf: () => authority,
    liveSearchOf: () => true,
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : 500;
    res.status(status).json({ messageKey: messageKeyOf(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
};

const api = (base: string, path: string, init?: RequestInit): Promise<Response> =>
  fetch(`${base}${path}`, init);

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("every search route sets a private, no-store response", async () => {
  const harness = await mount();
  try {
    const responses = await Promise.all([
      api(harness.base, "/api/search/preferences"),
      api(harness.base, "/api/search/everywhere", json({
        query: "alien", kind: "all", sources: ["catalog"], slotId: "slot_12345678", generation: 1,
      })),
      api(harness.base, "/api/search/everywhere/ss_abc/poll", json({ revision: 1 })),
      api(harness.base, "/api/search/everywhere/ss_abc/page", { method: "POST" }),
      api(harness.base, "/api/search/everywhere/ss_abc/sources/s0/retry", { method: "POST" }),
      api(harness.base, "/api/search/everywhere/ss_abc/members/c1?from=0"),
      api(harness.base, "/api/search/everywhere/ss_abc", { method: "DELETE" }),
    ]);
    for (const response of responses) {
      assert.equal(response.headers.get("cache-control"), "private, no-store", response.url);
    }
    assert.equal(responses[0]!.status, 200);
    assert.deepEqual(await responses[0]!.json(), { liveSearch: true });
    assert.equal(responses[2]!.status, 200);
    assert.equal(responses[3]!.status, 202);
    assert.equal(responses[4]!.status, 202);
    assert.equal(responses[5]!.status, 200);
    assert.equal(responses[6]!.status, 204);
  } finally {
    await harness.close();
  }
});

test("the no-store header survives errors and malformed ids answer 404", async () => {
  const harness = await mount();
  try {
    const bad = "bad%21id";
    const responses = await Promise.all([
      api(harness.base, `/api/search/everywhere/${bad}/poll`, json({ revision: 0 })),
      api(harness.base, `/api/search/everywhere/${bad}/page`, { method: "POST" }),
      api(harness.base, `/api/search/everywhere/${bad}/sources/s0/retry`, { method: "POST" }),
      api(harness.base, `/api/search/everywhere/ss_abc/members/${bad}`),
      api(harness.base, `/api/search/everywhere/${bad}`, { method: "DELETE" }),
      api(harness.base, "/api/search/everywhere/ss_abc/sources/bad%21id/retry", { method: "POST" }),
      api(harness.base, "/api/search/everywhere", json({
        query: "alien", kind: "all", sources: ["catalog"], slotId: "slot_12345678", generation: 1, extra: true,
      })),
      api(harness.base, "/api/search/everywhere/ss_abc/members/c1?from=-1"),
    ]);
    for (const response of responses) {
      assert.equal(response.headers.get("cache-control"), "private, no-store", response.url);
    }
    for (const response of responses.slice(0, 6)) assert.equal(response.status, 404, response.url);
    assert.equal(responses[6]!.status, 400, "an unknown start field is refused");
    assert.equal(responses[7]!.status, 400, "a negative member offset is refused");
  } finally {
    await harness.close();
  }
});

test("closing a poll request aborts the manager wait", async () => {
  const app = express();
  app.use(express.json());
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  let aborted = false;
  const manager = {
    poll: async (_authority: SearchAuthority, _id: string, revision: number, signal?: AbortSignal) => {
      entered();
      return new Promise<{ changed: false; revision: number }>((resolve) => {
        const finish = () => {
          aborted = true;
          resolve({ changed: false, revision });
        };
        if (signal?.aborted) { finish(); return; }
        signal?.addEventListener("abort", finish, { once: true });
        setTimeout(() => resolve({ changed: false, revision }), 2_000).unref?.();
      });
    },
  } as unknown as SearchSessionManager;
  registerSearchEverywhereRoutes(app, {
    manager,
    authorityOf: () => ({ userId: "usr_00000001", sid: "sid_00000000", isCurrent: () => true }),
    liveSearchOf: () => true,
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const controller = new AbortController();
  const request = api(`http://127.0.0.1:${port}`, "/api/search/everywhere/ss_abc/poll", {
    ...json({ revision: 1 }),
    signal: controller.signal,
  }).catch(() => undefined);
  try {
    await waiting;
    controller.abort();
    const deadline = Date.now() + 2_000;
    while (!aborted && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(aborted, true);
    await request;
  } finally {
    server.close();
    server.closeAllConnections();
    await once(server, "close");
  }
});

test("the feature flag is true only for the character 1", (t) => {
  const previous = process.env.SEARCH_EVERYWHERE_ENABLED;
  t.after(() => {
    if (previous === undefined) delete process.env.SEARCH_EVERYWHERE_ENABLED;
    else process.env.SEARCH_EVERYWHERE_ENABLED = previous;
  });
  delete process.env.SEARCH_EVERYWHERE_ENABLED;
  assert.equal(searchEverywhereEnabled(), false);
  for (const value of ["0", "", "true", "yes", "on"] as const) {
    process.env.SEARCH_EVERYWHERE_ENABLED = value;
    assert.equal(searchEverywhereEnabled(), false, value);
  }
  process.env.SEARCH_EVERYWHERE_ENABLED = "1";
  assert.equal(searchEverywhereEnabled(), true);
});
