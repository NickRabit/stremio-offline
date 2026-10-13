import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { messageKeyOf } from "../errors.js";
import { MediaResources, ResourceError } from "../media-resources.js";
import { MediaServerManager } from "../media-server-manager.js";
import { MediaServerPersonal } from "../media-server-personal.js";
import type { MediaServerProvider, ProviderItem, RemoteAccountPolicy } from "../media-server-provider.js";
import { MediaServerSources } from "../media-server-sources.js";
import { MediaServerSecrets } from "../media-server-secrets.js";
import type { MediaServerTransport } from "../media-server-security.js";
import { MediaServerError, remoteProgressKey } from "../media-server-types.js";
import { roleMiddleware } from "../roles.js";
import { restrictedMiddleware } from "../restricted.js";
import { Store } from "../store.js";
import { emptyUserData, type UserRecord } from "../users.js";
import type { RouteContext } from "./context.js";
import { registerMediaServerRoutes } from "./media-servers.js";

const ADA = "usr_00000001";
const BOB = "usr_00000002";

const account = (over: Partial<UserRecord> & Pick<UserRecord, "id" | "username">): UserRecord => ({
  passwordHash: "scrypt$aa$bb",
  secret: `secret-${over.id}`,
  role: "user",
  createdAt: "2026-01-01T00:00:00.000Z",
  permissions: { downloadToLibrary: true, downloadToDevice: true },
  permissionsVersion: 0,
  ...over,
});

const admin = account({ id: ADA, username: "ada", role: "admin" });
const bob = account({ id: BOB, username: "bob" });

const movie = (id: string, name = `Movie ${id}`): ProviderItem => ({ id, name, type: "movie", providerIds: {} });

class FakeServer {
  serverId = "server-1";
  accountId = "user-1";
  policy: RemoteAccountPolicy = { disabled: false, mediaPlayback: true, allFolders: true, folderIds: [], hasAdditionalRestrictions: false };
  libraries = [{ id: "lib-1", name: "Films", type: "movie" as const }];
  items: Record<string, ProviderItem[]> = { "lib-1": [movie("m1", "Alien")] };
  directories: Record<string, ProviderItem[]> = {};
  directoryCalls: Array<{ parentId: string; options: Record<string, unknown> }> = [];
  detailOf: Record<string, ProviderItem> = { m1: movie("m1", "Alien") };
  ancestorsOf: Record<string, string[]> = { m1: ["lib-1"] };
  versionsOf: Record<string, Array<{ id: string; name?: string; container?: string }>> = { m1: [{ id: "v1", name: "1080p" }] };
  errors: Record<string, MediaServerError> = {};
  nudge: { op: string; wait: Promise<void>; entered?: () => void } | undefined;

  async run(operation: string): Promise<void> {
    const error = this.errors[operation];
    if (error) throw error;
    if (this.nudge?.op === operation) { this.nudge.entered?.(); await this.nudge.wait; }
  }
}

const provider = (server: FakeServer): MediaServerProvider => ({
  verifyIdentity: async () => { await server.run("info"); return { serverId: server.serverId, version: "1" }; },
  authenticate: async () => { await server.run("login"); return { serverId: server.serverId, accountId: server.accountId, token: "token-1" }; },
  currentAccount: async () => { await server.run("user"); return { accountId: server.accountId, policy: structuredClone(server.policy) }; },
  listLibraries: async () => { await server.run("views"); return structuredClone(server.libraries); },
  pageItems: async (_token, _account, libraryId) => { await server.run("items"); return { items: structuredClone(server.items[libraryId] ?? []), total: (server.items[libraryId] ?? []).length }; },
  pageDirectory: async (_token, _account, parentId, options) => {
    await server.run("directory");
    server.directoryCalls.push({ parentId, options: options as unknown as Record<string, unknown> });
    return { items: structuredClone(server.directories[parentId] ?? []), total: (server.directories[parentId] ?? []).length };
  },
  detail: async (_token, _account, itemId) => { await server.run("detail"); const item = server.detailOf[itemId]; if (!item) throw new MediaServerError("not-found", "missing"); return structuredClone(item); },
  ancestors: async (_token, _account, itemId) => { await server.run("ancestors"); return [...(server.ancestorsOf[itemId] ?? [])]; },
  versions: async (_token, _account, itemId) => { await server.run("versions"); return structuredClone(server.versionsOf[itemId] ?? []); },
});

const transport: MediaServerTransport = {
  requestJson: async () => { throw new Error("unused"); },
  requestAsset: async () => { throw new Error("unused asset transport"); },
  requestOriginal: async () => { throw new Error("unused"); },
  close: async () => undefined,
};

interface Harness {
  base: string;
  store: Store;
  server: FakeServer;
  manager: MediaServerManager;
  connectionId: string;
  libraryId: string;
  loseAccess(): void;
  close(): Promise<void>;
}

const mount = async (): Promise<Harness> => {
  const dir = await mkdtemp(path.join(tmpdir(), "routes-media-servers-"));
  const users = [admin, bob];
  await writeFile(path.join(dir, "state.json"), JSON.stringify({
    schemaVersion: 3, addons: [], settings: {}, defaultsInstalled: true,
    users, userData: Object.fromEntries(users.map((user) => [user.id, emptyUserData()])), libraries: [],
  }));
  const keyFile = path.join(dir, "secret.key");
  await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
  const store = new Store(dir, dir);
  await store.load();
  const server = new FakeServer();
  const manager = new MediaServerManager(store, new MediaServerSecrets(path.join(dir, "vault"), keyFile), {
    providerFactory: () => provider(server),
    transportFactory: () => transport,
    networkStartIntervalMs: 0,
  });
  await manager.initialize();

  let lost = false;
  const currentUser = (req: express.Request) => {
    const id = req.header("x-user") ?? ADA;
    return store.users().find((user) => user.id === id);
  };
  const ctx: RouteContext = {
    store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => { if (lost) throw new ResourceError(404, "RESOURCE_NOT_FOUND"); },
    stopContentAccess: async () => undefined,
  };

  const app = express();
  app.use((req, res, next) => {
    const trimmed = req.path.length > 1 && req.path.endsWith("/") ? req.path.slice(0, -1) : req.path;
    if (req.method !== "POST" || trimmed.toLowerCase() !== "/api/media-servers/import") return next();
    return express.json({ limit: "9mb" })(req, res, next);
  });
  app.use(express.json({ limit: "256kb" }));
  app.use("/api", roleMiddleware({ isOpen: () => false, isInternal: () => false, roleOf: (req) => currentUser(req)?.role }));
  app.use("/api", restrictedMiddleware({ isOpen: () => false, isInternal: () => false }));
  const resources = new MediaResources();
  const mediaSources = new MediaServerSources(store, manager, resources);
  const remotePersonal = new MediaServerPersonal(store, manager);
  const ownerOf = (req: express.Request) => ({ userId: currentUser(req)?.id ?? ADA, sid: "routes-sid", expiresAt: Date.now() + 3_600_000 });
  registerMediaServerRoutes(app, { ...ctx, mediaServers: manager, mediaSources, remotePersonal, ownerOf });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof retryAfterMs === "number" && retryAfterMs > 0) res.setHeader("retry-after", String(Math.max(1, Math.round(retryAfterMs / 1000))));
    res.status(status).json({ error: error instanceof Error ? error.message : String(error), messageKey: messageKeyOf(error) });
  });
  const listener = app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const connection = await manager.createConnection(authority(admin), {
    provider: "jellyfin", name: "Media", baseUrl: "http://media.example", allowLan: false, allowLoopback: false, username: "reader", password: "pw",
  });
  const library = await manager.attachLibrary(authority(admin), connection.id, { remoteId: "lib-1" });
  await manager.patchLibrary(authority(admin), library.id, { allowedUsers: [BOB] });

  return {
    base, store, server, manager, connectionId: connection.id, libraryId: library.id,
    loseAccess: () => { lost = true; },
    close: async () => {
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      await manager.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
};

/** A direct manager call outside a request, mirroring what the route builds from a session. */
const authority = (user: UserRecord) => ({ actor: { id: user.id, secret: user.secret }, assertCurrent: () => undefined });

test("the response boundary rechecks a session revoked after the manager resolves", async () => {
  await withHarness(async (harness) => {
    const list = harness.manager.visibleLibraries.bind(harness.manager);
    harness.manager.visibleLibraries = async (...args) => {
      const result = await list(...args);
      harness.loseAccess();
      return result;
    };
    assert.equal((await api(harness.base, "/api/remote-libraries", { user: BOB })).status, 404);
  });
});

test("an administrator demoted after an inventory resolves receives no inventory", async () => {
  await withHarness(async (harness) => {
    const list = harness.manager.listConnections.bind(harness.manager);
    harness.manager.listConnections = async (...args) => {
      const result = await list(...args);
      await harness.store.update((state) => { state.users!.find((user) => user.id === ADA)!.role = "user"; });
      return result;
    };
    assert.equal((await api(harness.base, "/api/media-servers")).status, 403);
  });
});

test("a cached response is refused if its connection is disabled before JSON is sent", async () => {
  await withHarness(async (harness) => {
    const browse = harness.manager.browseItems.bind(harness.manager);
    harness.manager.browseItems = async (...args) => {
      const result = await browse(...args);
      await harness.manager.patchConnection(authority(admin), harness.connectionId, { enabled: false });
      return result;
    };
    assert.equal((await api(harness.base, `/api/remote-libraries/${harness.libraryId}/items`)).status, 404);
  });
});

test("GET rejects an empty JSON body before upstream work", async () => {
  await withHarness(async (harness) => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${harness.base}/api/media-servers/${harness.connectionId}/libraries`, {
        method: "GET", headers: { "content-type": "application/json", "content-length": "2" },
      }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      request.on("error", reject);
      request.end("{}");
    });
    assert.equal(status, 400);
  });
});

const api = (base: string, pathname: string, init: { method?: string; body?: unknown; user?: string } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...(init.user ? { "x-user": init.user } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

const withHarness = async (run: (harness: Harness) => Promise<void>) => {
  const harness = await mount();
  try { await run(harness); }
  finally { await harness.close(); }
};

test("a granted member can list and browse, and the list never carries grants or addresses", async () => {
  await withHarness(async (harness) => {
    const list = await api(harness.base, "/api/remote-libraries", { user: BOB });
    assert.equal(list.status, 200);
    const body = await list.json() as { libraries: Array<Record<string, unknown>> };
    assert.deepEqual(body.libraries.map((library) => library.id), [harness.libraryId]);
    const wire = JSON.stringify(body);
    for (const secret of ["allowedUsers", "secretRef", "media.example", "server-1", "user-1", "token"]) {
      assert.equal(wire.includes(secret), false, `${secret} must not travel`);
    }

    const browse = await api(harness.base, `/api/remote-libraries/${harness.libraryId}/items?limit=10`, { user: BOB });
    assert.equal(browse.status, 200);
    const page = await browse.json() as { items: ProviderItem[]; total: number; stale: boolean; capabilities: Record<string, boolean> };
    assert.deepEqual(page.items.map((item) => item.id), ["m1"]);
    assert.equal(page.total, 1);
    assert.equal(page.stale, false);
    assert.equal(page.capabilities.downloadToDevice, false);

    const detail = await api(harness.base, `/api/remote-libraries/${harness.libraryId}/items/m1`, { user: BOB });
    assert.equal(detail.status, 200);
    assert.equal(((await detail.json()) as { item: ProviderItem }).item.id, "m1");
  });
});

test("a granted member browses and previews natively, and only GET reaches those paths", async () => {
  await withHarness(async (harness) => {
    harness.server.directories["lib-1"] = [movie("m1", "Alien")];
    const browse = await api(harness.base, `/api/remote-libraries/${harness.libraryId}/browse?mode=folders`, { user: BOB });
    assert.equal(browse.status, 200);
    const page = await browse.json() as { items: ProviderItem[]; total: number; stale: boolean };
    assert.deepEqual(page.items.map((item) => item.id), ["m1"]);
    assert.equal(page.total, 1);
    assert.equal(page.stale, false);

    const preview = await api(harness.base, `/api/remote-libraries/${harness.libraryId}/preview`, { user: BOB });
    assert.equal(preview.status, 200);
    assert.deepEqual(await preview.json(), { posters: [`/api/remote-libraries/${harness.libraryId}/items/m1/artwork/Primary`] });

    // A write at the same path is not on the member allow-list: the role gate refuses it.
    assert.equal((await api(harness.base, `/api/remote-libraries/${harness.libraryId}/browse`, { method: "POST", user: BOB, body: {} })).status, 403);
    assert.equal((await api(harness.base, `/api/remote-libraries/${harness.libraryId}/preview`, { method: "PATCH", user: BOB, body: {} })).status, 403);

    assert.equal((await api(harness.base, `/api/remote-libraries/${harness.libraryId}/browse?mode=grid`, { user: BOB })).status, 400);
    assert.equal((await api(harness.base, `/api/remote-libraries/${harness.libraryId}/preview?nope=1`, { user: BOB })).status, 400);
    assert.equal((await api(harness.base, `/api/remote-libraries/${harness.libraryId}/browse`, { user: BOB })).status, 200);
  });
});

test("administration is administrator-only and the member list refuses an ungranted account", async () => {
  await withHarness(async (harness) => {
    assert.equal((await api(harness.base, "/api/media-servers", { user: BOB })).status, 403);
    assert.equal((await api(harness.base, "/api/media-servers", { method: "POST", user: BOB, body: {} })).status, 403);
    assert.equal((await api(harness.base, `/api/media-servers/${harness.connectionId}`, { method: "DELETE", user: BOB })).status, 403);
    assert.equal((await api(harness.base, `/api/remote-libraries/${harness.libraryId}`, { method: "PATCH", user: BOB, body: { name: "x" } })).status, 403);

    const adminList = await api(harness.base, "/api/media-servers");
    assert.equal(adminList.status, 200);
    const adminBody = await adminList.json() as { connections: Array<{ id: string; status: string; baseUrl: string }>; keyConfigured: boolean };
    assert.equal(adminBody.keyConfigured, true);
    assert.equal(adminBody.connections[0]!.status, "unavailable", "a grant edit invalidated the derived status");
    assert.equal(adminBody.connections[0]!.baseUrl, "http://media.example");
    const discovery = await api(harness.base, `/api/media-servers/${harness.connectionId}/libraries`);
    assert.equal(discovery.status, 200);
    const refreshed = await (await api(harness.base, "/api/media-servers")).json() as { connections: Array<{ status: string }> };
    assert.equal(refreshed.connections[0]!.status, "available", "a live verified operation restores the status");

    await harness.manager.patchLibrary(authority(admin), harness.libraryId, { allowedUsers: [] });
    assert.equal((await api(harness.base, "/api/remote-libraries", { user: BOB })).status, 200);
    const empty = await (await api(harness.base, "/api/remote-libraries", { user: BOB })).json() as { libraries: unknown[] };
    assert.deepEqual(empty.libraries, []);
    assert.equal((await api(harness.base, `/api/remote-libraries/${harness.libraryId}/items`, { user: BOB })).status, 404, "the same 404 as a missing library");
    assert.equal((await api(harness.base, `/api/remote-libraries/rlib_00000000000000000000000000000009/items`, { user: BOB })).status, 404);
    assert.equal((await api(harness.base, `/api/remote-libraries/${harness.libraryId}/items/m1`, { user: BOB })).status, 404);
  });
});

test("malformed query and body are refused before any network call", async () => {
  await withHarness(async (harness) => {
    for (const query of ["?limit=0", "?limit=201", "?limit=abc", "?unknown=1", "?type=book", `?cursor=${"x".repeat(9000)}`]) {
      const response = await api(harness.base, `/api/remote-libraries/${harness.libraryId}/items${query}`);
      assert.equal(response.status, 400, query);
      assert.equal((await response.json() as { messageKey?: string }).messageKey, "err.invalidRequest", query);
    }
    const badBody = await api(harness.base, `/api/remote-libraries/${harness.libraryId}`, { method: "PATCH", body: { root: "/data" } });
    assert.equal(badBody.status, 400);
    assert.equal((await badBody.json() as { messageKey?: string }).messageKey, "err.invalidRequest");
  });
});

test("a GET with an unknown query key is refused before any network call", async () => {
  await withHarness(async (harness) => {
    const cases: Array<[string, RequestInit]> = [
      ["/api/media-servers?x=1", {}],
      ["/api/media-servers/export?x=1", {}],
      [`/api/media-servers/${harness.connectionId}/libraries?x=1`, {}],
      [`/api/remote-libraries?x=1`, { headers: { "x-user": BOB } }],
      [`/api/remote-libraries/${harness.libraryId}/items/m1?x=1`, { headers: { "x-user": BOB } }],
    ];
    for (const [path, init] of cases) {
      const response = await fetch(`${harness.base}${path}`, init as RequestInit);
      assert.equal(response.status, 400, path);
      assert.equal(((await response.json()) as { messageKey?: string }).messageKey, "err.invalidRequest", path);
    }
    assert.equal((await api(harness.base, "/api/media-servers/export")).status, 200, "a clean GET still works");
  });
});

test("the admin and member routes keep their guards under the casing and slash Express routes on", async () => {
  await withHarness(async (harness) => {
    assert.equal((await api(harness.base, "/api/Media-Servers/")).status, 200);
    assert.equal((await api(harness.base, "/api/remote-libraries/", { user: BOB })).status, 403, "a member still cannot reach an admin path by casing");
    assert.equal((await api(harness.base, "/api/media-servers-extra")).status, 404, "a near miss is not a route");
  });
});

test("restricted mode denies the admin media-server reads whatever the casing or slash", async (t) => {
  const previous = process.env.RESTRICTED_MODE;
  process.env.RESTRICTED_MODE = "1";
  t.after(() => { if (previous === undefined) delete process.env.RESTRICTED_MODE; else process.env.RESTRICTED_MODE = previous; });
  await withHarness(async (harness) => {
    for (const path of ["/api/media-servers", "/api/Media-Servers/", "/api/media-servers/export", "/api/MEDIA-SERVERS/EXPORT/", `/api/media-servers/${harness.connectionId}/libraries/`]) {
      const response = await api(harness.base, path);
      assert.equal(response.status, 403, path);
      assert.equal(((await response.json()) as { messageKey?: string }).messageKey, "err.restricted", path);
    }
    assert.equal((await api(harness.base, "/api/media-servers-extra")).status, 404, "the deny rule did not widen to a prefix");
    assert.equal((await api(harness.base, "/api/remote-libraries", { user: BOB })).status, 200, "member metadata stays readable");
    assert.equal((await api(harness.base, `/api/remote-libraries/${harness.libraryId}/items`, { user: BOB })).status, 200);
  });
});

test("every internal failure maps to a fixed status and key, and its internal text never escapes", async () => {
  await withHarness(async (harness) => {
    const sentinel = "SENTINEL-INTERNAL-DETAIL";
    const cases: Array<[MediaServerError, number, string]> = [
      [new MediaServerError("invalid-input", sentinel), 400, "err.invalidRequest"],
      [new MediaServerError("not-found", sentinel), 404, "err.libraryNotFound"],
      [new MediaServerError("forbidden", sentinel), 404, "err.libraryNotFound"],
      [new MediaServerError("busy", sentinel), 429, "err.mediaServerBusy"],
      [new MediaServerError("rate-limited", sentinel, 429, 5_000), 429, "err.mediaServerBusy"],
      [new MediaServerError("timeout", sentinel), 502, "err.mediaServerUnavailable"],
      [new MediaServerError("unavailable", sentinel), 502, "err.mediaServerUnavailable"],
      [new MediaServerError("invalid-response", sentinel), 502, "err.mediaServerUnavailable"],
      [new MediaServerError("response-too-large", sentinel), 502, "err.mediaServerUnavailable"],
      [new MediaServerError("unsafe-address", sentinel), 502, "err.mediaServerUnavailable"],
      [new MediaServerError("closed", sentinel), 503, "err.mediaServerUnavailable"],
      [new MediaServerError("cancelled", sentinel), 503, "err.mediaServerUnavailable"],
      [new MediaServerError("authentication-required", sentinel, 401), 502, "err.mediaServerLogin"],
      [new MediaServerError("secret-key-unavailable", sentinel), 503, "err.mediaServerKey"],
      [new MediaServerError("secret-unavailable", sentinel), 503, "err.mediaServerKey"],
      [new MediaServerError("stale-generation", sentinel), 409, "err.mediaServerStale"],
      [new MediaServerError("identity-changed", sentinel), 409, "err.mediaServerIdentity"],
      [new MediaServerError("unsupported-policy", sentinel), 403, "err.mediaServerRestricted"],
      // An unknown code falls through to the safe default rather than leaking a raw status.
      [new MediaServerError("mystery" as MediaServerError["code"], sentinel), 502, "err.mediaServerUnavailable"],
    ];
    for (const [error, status, key] of cases) {
      harness.server.errors.detail = error;
      const response = await api(harness.base, `/api/remote-libraries/${harness.libraryId}/items/m1`);
      assert.equal(response.status, status, `${error.code} status`);
      const body = await response.text();
      assert.equal((JSON.parse(body) as { messageKey?: string }).messageKey, key, `${error.code} key`);
      assert.equal(body.includes(sentinel), false, `${error.code} must not forward the internal text`);
      assert.equal(body.includes("token"), false, "no token leaks through an error");
    }
    delete harness.server.errors.detail;
  });
});

test("a rate-limited failure carries a bounded Retry-After", async () => {
  await withHarness(async (harness) => {
    harness.server.errors.detail = new MediaServerError("rate-limited", "slow", 429, 120_000);
    const response = await api(harness.base, `/api/remote-libraries/${harness.libraryId}/items/m1`);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "120");
    for (const bogus of [Number.POSITIVE_INFINITY, Number.NaN, -1]) {
      harness.server.errors.detail = new MediaServerError("busy", "busy", 429, bogus);
      const odd = await api(harness.base, `/api/remote-libraries/${harness.libraryId}/items/m1`);
      assert.equal(odd.status, 429);
      assert.equal(odd.headers.get("retry-after"), null, `a non-finite wait of ${bogus} sets no header`);
    }
  });
});

test("an upstream 401 is not misrepresented as a local session 401", async () => {
  await withHarness(async (harness) => {
    harness.server.errors.user = new MediaServerError("authentication-required", "unauthenticated", 401);
    const response = await api(harness.base, `/api/remote-libraries/${harness.libraryId}/items`);
    assert.equal(response.status, 502);
    assert.equal((await response.json() as { messageKey?: string }).messageKey, "err.mediaServerLogin");
  });
});

test("a session revoked mid-flight stops the answer after the awaited work", async () => {
  await withHarness(async (harness) => {
    const held = (() => { let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; }); return { wait, release }; })();
    const entered = (() => { let signal!: () => void; const promise = new Promise<void>((resolve) => { signal = resolve; }); return { promise, signal }; })();
    harness.server.nudge = { op: "items", wait: held.wait, entered: entered.signal };
    const browsing = api(harness.base, `/api/remote-libraries/${harness.libraryId}/items`);
    await entered.promise;
    harness.loseAccess();
    held.release();
    const response = await browsing;
    assert.equal(response.status, 404, "the late refusal answers the request rather than publishing");
  });
});

test("the dedicated import parser accepts a body larger than the ordinary limit", async () => {
  await withHarness(async (harness) => {
    const oversized = JSON.stringify({ version: 1, connections: [], libraries: [], pad: "x".repeat(300_000) });
    assert.ok(oversized.length > 256 * 1024);
    const response = await fetch(`${harness.base}/api/media-servers/import`, { method: "POST", headers: { "content-type": "application/json" }, body: oversized });
    assert.notEqual(response.status, 413, "the body was parsed, not refused by the small parser");
    assert.equal((await response.json() as { messageKey?: string }).messageKey, "err.invalidRequest");

    // Only the exact import path gets the larger ceiling; a path that merely starts with it
    // keeps the ordinary limit.
    const nearMiss = await fetch(`${harness.base}/api/media-servers/import/extra`, { method: "POST", headers: { "content-type": "application/json" }, body: oversized });
    assert.equal(nearMiss.status, 413, "a near-miss route does not inherit the larger parser");
  });
});

test("import requires an administrator and restores nothing until the body is valid", async () => {
  await withHarness(async (harness) => {
    const denied = await api(harness.base, "/api/media-servers/import", { method: "POST", user: BOB, body: { version: 1, connections: [], libraries: [] } });
    assert.equal(denied.status, 403);
    const exported = await (await api(harness.base, "/api/media-servers/export")).json();
    assert.equal(JSON.stringify(exported).includes("msecret_"), false);
    const imported = await api(harness.base, "/api/media-servers/import", { method: "POST", body: exported });
    assert.equal(imported.status, 400, "a duplicate account is refused whole");
  });
});

test("the admin library inventory lists every attachment with its provider", async () => {
  await withHarness(async (harness) => {
    const response = await api(harness.base, "/api/media-servers/libraries");
    assert.equal(response.status, 200);
    const body = await response.json() as { libraries: Array<{ id: string; provider?: string; allowedUsers: string[] }> };
    assert.equal(body.libraries.length, 1);
    assert.equal(body.libraries[0]!.id, harness.libraryId);
    assert.equal(body.libraries[0]!.provider, "jellyfin");
    assert.deepEqual(body.libraries[0]!.allowedUsers, [BOB]);
    assert.equal((await api(harness.base, "/api/media-servers/libraries", { user: BOB })).status, 403, "a member is refused");
  });
});

test("a granted member lists verified sources and their own item state without an address", async () => {
  await withHarness(async (harness) => {
    const sources = await api(harness.base, `/api/remote-libraries/${harness.libraryId}/items/m1/sources`, { user: BOB });
    assert.equal(sources.status, 200);
    const body = await sources.json() as { streams: Array<{ kind: string; provider?: string; libraryName?: string; remoteItem?: { itemId: string } }> };
    assert.equal(body.streams.length, 1);
    assert.equal(body.streams[0]!.kind, "remote");
    assert.equal(body.streams[0]!.provider, "jellyfin");
    assert.equal(body.streams[0]!.libraryName, "Films");
    assert.equal(body.streams[0]!.remoteItem?.itemId, "m1");
    assert.equal(JSON.stringify(body).includes("media-server:"), false);

    const state = await api(harness.base, `/api/remote-libraries/${harness.libraryId}/items/m1/state`, { user: BOB });
    assert.equal(state.status, 200);
    const row = await state.json() as { key: string; favorite: boolean };
    assert.match(row.key, /^remote:[0-9a-f]{64}$/);
    assert.equal(row.favorite, false);

    const patched = await api(harness.base, `/api/remote-libraries/${harness.libraryId}/items/m1/state`, { method: "PATCH", user: BOB, body: { favorite: true, position: 5 } });
    assert.equal(patched.status, 200);
    assert.equal((await patched.json() as { favorite: boolean }).favorite, true);
    const reread = await (await api(harness.base, `/api/remote-libraries/${harness.libraryId}/items/m1/state`, { user: BOB })).json() as { favorite: boolean; position: number };
    assert.equal(reread.favorite, true);
    assert.equal(reread.position, 5);

    assert.equal((await api(harness.base, `/api/remote-libraries/${harness.libraryId}/items/m1/state`, { method: "PATCH", user: BOB, body: { name: "x" } })).status, 400);
    harness.server.detailOf.s1 = { id: "s1", name: "Series", type: "series", providerIds: {} };
    harness.server.ancestorsOf.s1 = ["lib-1"];
    assert.equal((await api(harness.base, `/api/remote-libraries/${harness.libraryId}/items/s1/state`, { method: "PATCH", user: BOB, body: { position: 3 } })).status, 400);
  });
});

/** One canonical stored history row for the administrator. */
const seedHistory = (harness: Harness) => {
  const key = remoteProgressKey({ provider: "jellyfin", serverId: "server-1", accountId: "user-1", itemId: "m1" });
  return harness.store.update((state) => {
    const data = state.userData![ADA]!;
    data.remoteMedia = {
      [key]: {
        key, provider: "jellyfin", serverId: "server-1", accountId: "user-1", itemId: "m1", remoteLibraryId: "lib-1",
        type: "movie", name: "Alien", position: 5, duration: 100, favorite: false, watched: false,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
  }).then(() => key);
};

test("a removal query is one exact flag and a body is refused before anything changes", async () => {
  await withHarness(async (harness) => {
    const key = await seedHistory(harness);
    for (const query of ["?forget[]=true", "?forget=yes", "?forget=1", "?forget=true&other=1", "?FORGET=true"]) {
      const refused = await api(harness.base, `/api/remote-libraries/${harness.libraryId}${query}`, { method: "DELETE" });
      assert.equal(refused.status, 400, query);
      assert.equal((await refused.json() as { messageKey?: string }).messageKey, "err.invalidRequest", query);
    }
    assert.equal((await api(harness.base, `/api/remote-libraries/${harness.libraryId}`, { method: "DELETE", body: {} })).status, 400, "a removal carries no body");
    assert.equal((await api(harness.base, `/api/media-servers/${harness.connectionId}`, { method: "DELETE", body: { forget: true } })).status, 400);
    assert.equal(harness.store.remoteLibraries().length, 1, "a refused removal left everything in place");
    assert.equal(harness.store.mediaConnections().length, 1);
    assert.equal((harness.store.userData(ADA).remoteMedia as Record<string, unknown>)[key] !== undefined, true, "and touched no history");
  });
});

test("a removal keeps the history unless the exact flag forgets it", async () => {
  await withHarness(async (harness) => {
    const key = await seedHistory(harness);
    assert.equal((await api(harness.base, `/api/remote-libraries/${harness.libraryId}?forget=false`, { method: "DELETE" })).status, 204);
    const kept = (harness.store.userData(ADA).remoteMedia as Record<string, { orphanedAt?: string }>)[key]!;
    assert.equal(typeof kept.orphanedAt, "string", "the row survives its library with the thirty days running");
  });
  await withHarness(async (harness) => {
    const key = await seedHistory(harness);
    assert.equal((await api(harness.base, `/api/media-servers/${harness.connectionId}?forget=true`, { method: "DELETE" })).status, 204);
    assert.equal((harness.store.userData(ADA).remoteMedia as Record<string, unknown>)[key], undefined, "forget removes it at once");
    assert.deepEqual(harness.store.remoteLibraries(), [], "together with the connection's libraries");
  });
});
