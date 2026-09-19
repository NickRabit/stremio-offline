import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { messageKeyOf } from "../errors.js";
import { defaultDownloadSettings } from "../naming.js";
import { publicAddon } from "../security.js";
import type { Store } from "../store.js";
import type { AddonRecord, AddonRole } from "../types.js";
import { registerAddonsRoutes, type AddonsDeps } from "./addons.js";

interface Harness {
  base: string;
  viewed: AddonRecord[];
  stored: () => AddonRecord[];
  close(): Promise<void>;
}

const addon = (key: string, role: AddonRole = "both"): AddonRecord => ({
  key,
  manifestUrl: `https://${key}.example/manifest.json`,
  role,
  enabled: true,
  globalSearch: true,
  addedAt: "2024-01-01T00:00:00.000Z",
  manifest: { id: key, name: `Addon ${key}`, version: "1.0.0" },
  downloadSettings: defaultDownloadSettings(),
});

/** The routes take everything they need from the context, so the app here is a real express
 *  instance over fake collaborators that record what they were asked to do. */
const mount = async (records: AddonRecord[] = [addon("alpha")]): Promise<Harness> => {
  const state = { addons: records };
  const viewed: AddonRecord[] = [];
  const store = {
    addons: () => state.addons,
    libraries: () => [],
    update: async (mutate: (value: typeof state) => void) => { mutate(state); },
  } as unknown as Store;
  const deps: AddonsDeps = {
    store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: () => undefined,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    storeRefreshed: async () => undefined,
    publicAddonView: (record) => {
      viewed.push(record);
      const view = { ...publicAddon(record), viewed: true };
      return view;
    },
  };
  const app = express();
  app.use(express.json());
  registerAddonsRoutes(app, deps);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error), messageKey: messageKeyOf(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    viewed,
    stored: () => state.addons,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

const api = (base: string, pathname: string, init: { method?: string; body?: unknown } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

const keysOf = (harness: Harness) => harness.stored().map((record) => record.key);

test("GET /api/addons passes every record through publicAddonView", async (t) => {
  const harness = await mount([addon("alpha"), addon("beta")]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/addons");
  assert.equal(response.status, 200);
  const body = await response.json() as Array<{ key: string; viewed?: boolean }>;
  assert.deepEqual(body.map((item) => item.key), ["alpha", "beta"]);
  assert.deepEqual(body.map((item) => item.viewed), [true, true]);
  assert.deepEqual(harness.viewed.map((record) => record.key), ["alpha", "beta"]);
});

test("DELETE /api/addons/:key removes only the named key", async (t) => {
  const harness = await mount([addon("alpha"), addon("beta"), addon("gamma")]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/addons/beta", { method: "DELETE" });
  assert.equal(response.status, 204);
  assert.deepEqual(keysOf(harness), ["alpha", "gamma"]);
});

test("GET /api/addons/:key/export refuses an unknown key", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/addons/nobody/export");
  assert.equal(response.status, 400);
  assert.equal(await response.json().then((body) => (body as { messageKey?: string }).messageKey), "err.addonNotFound");
});

test("GET /api/addons/:key/export hands out the token-bearing address of a known key", async (t) => {
  const record = addon("alpha");
  record.manifestUrl = "https://alpha.example/manifest.json?token=secret";
  const harness = await mount([record]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/addons/alpha/export");
  assert.equal(response.status, 200);
  const body = await response.json() as { manifestUrl?: string; manifest?: { id?: string } };
  assert.equal(body.manifestUrl, "https://alpha.example/manifest.json?token=secret");
  assert.equal(body.manifest?.id, "alpha");
});

test("POST /api/addons/:key/move moves by one in each direction", async (t) => {
  const harness = await mount([addon("alpha"), addon("beta"), addon("gamma")]);
  t.after(harness.close);
  assert.equal((await api(harness.base, "/api/addons/beta/move", { method: "POST", body: { direction: -1 } })).status, 204);
  assert.deepEqual(keysOf(harness), ["beta", "alpha", "gamma"]);
  assert.equal((await api(harness.base, "/api/addons/beta/move", { method: "POST", body: { direction: 1 } })).status, 204);
  assert.deepEqual(keysOf(harness), ["alpha", "beta", "gamma"]);
});

test("POST /api/addons/:key/move is a no-op at either end of the list", async (t) => {
  const harness = await mount([addon("alpha"), addon("beta"), addon("gamma")]);
  t.after(harness.close);
  assert.equal((await api(harness.base, "/api/addons/alpha/move", { method: "POST", body: { direction: -1 } })).status, 204);
  assert.deepEqual(keysOf(harness), ["alpha", "beta", "gamma"]);
  assert.equal((await api(harness.base, "/api/addons/gamma/move", { method: "POST", body: { direction: 1 } })).status, 204);
  assert.deepEqual(keysOf(harness), ["alpha", "beta", "gamma"]);
});
