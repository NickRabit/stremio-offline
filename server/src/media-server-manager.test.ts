import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ForbiddenError } from "./roles.js";
import { ResourceError } from "./media-resources.js";
import { MediaServerIndex } from "./media-server-index.js";
import { remoteIdsMatch } from "./media-server-match.js";
import { MediaServerManager, type MediaServerAuthority } from "./media-server-manager.js";
import type { MediaServerProvider, ProviderItem, ProviderLibrary, ProviderVersion, RemoteAccountPolicy } from "./media-server-provider.js";
import { openRemoteContent, remoteSecretStamp, sealRemoteContent, type RemoteContentRef } from "./media-server-reference.js";
import { MediaServerSecrets } from "./media-server-secrets.js";
import type { MediaServerTransport } from "./media-server-security.js";
import { MediaServerError, remoteProgressKey } from "./media-server-types.js";
import { Store } from "./store.js";
import { emptyUserData, type UserRecord } from "./users.js";

const ADA = "usr_00000001";
const BOB = "usr_00000002";
const CAROL = "usr_00000003";

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
const carol = account({ id: CAROL, username: "carol" });

const movie = (id: string, name = `Movie ${id}`): ProviderItem => ({ id, name, type: "movie", providerIds: {} });
const episode = (id: string, over: Partial<ProviderItem>): ProviderItem => ({ id, name: `Episode ${id}`, type: "episode", providerIds: {}, ...over });
const folder = (id: string, over: Partial<ProviderItem> = {}): ProviderItem => ({ id, name: `Folder ${id}`, type: "folder", providerIds: {}, ...over });
const artMovie = (id: string): ProviderItem => ({ id, name: `Movie ${id}`, type: "movie", providerIds: {}, hasPrimaryImage: true });

interface Nudge { op: string; wait: Promise<void>; entered?: () => void }

interface FakePage { items: ProviderItem[]; total: number; cursor?: string }

class FakeServer {
  serverId = "server-1";
  accountId = "user-1";
  token = "token-value-1";
  policy: RemoteAccountPolicy = { disabled: false, mediaPlayback: true, allFolders: true, folderIds: [], hasAdditionalRestrictions: false };
  libraries: ProviderLibrary[] = [];
  items: Record<string, ProviderItem[]> = {};
  directories: Record<string, ProviderItem[]> = {};
  directoryCalls: Array<{ parentId: string; options: Record<string, unknown> }> = [];
  directoryOverride: ((parentId: string, options: { cursor?: string; limit?: number }) => FakePage) | undefined;
  detailOf: Record<string, ProviderItem> = {};
  ancestorsOf: Record<string, string[]> = {};
  versionsOf: Record<string, ProviderVersion[]> = {};
  original: { status?: number; headers?: Record<string, string>; error?: MediaServerError } | undefined;
  originalCalls = 0;
  originalCancelled = 0;
  asset: { bytes: Uint8Array; contentType: string } | undefined;
  assetRequests: Array<Record<string, unknown>> = [];
  artwork: { bytes: Uint8Array; contentType: string; status?: number; error?: MediaServerError } | undefined;
  artworkRequests: Array<Record<string, unknown>> = [];
  artworkCancelled = 0;
  /** The provider-id search surface: the flat catalogue a bounded match reads, and the calls. */
  catalogue: ProviderItem[] = [];
  matchCalls: Array<{ ids: unknown; type: string; nameHint?: string }> = [];
  findOverride: ((ids: unknown, type: string, nameHint?: string) => ProviderItem[]) | undefined;
  calls: string[] = [];
  /** The wall-clock time of each provider operation start, for the pacing assertions. */
  startTimes: number[] = [];
  errors: Record<string, MediaServerError> = {};
  nudge: Nudge | undefined;
  pageOverride: ((options: { cursor?: string; limit?: number }) => FakePage) | undefined;
  closed = 0;
  /** Provider operations live at once, and the high-water mark across a test. */
  activeOps = 0;
  maxActiveOps = 0;

  async run(operation: string): Promise<void> {
    this.calls.push(operation);
    this.startTimes.push(Date.now());
    this.activeOps += 1;
    if (this.activeOps > this.maxActiveOps) this.maxActiveOps = this.activeOps;
    try {
      const error = this.errors[operation];
      if (error) throw error;
      if (this.nudge?.op === operation) { this.nudge.entered?.(); await this.nudge.wait; }
    } finally {
      this.activeOps -= 1;
    }
  }
}

const clone = <T>(value: T): T => structuredClone(value);

const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

const stubProvider = (server: FakeServer): MediaServerProvider => ({
  verifyIdentity: async () => { await server.run("info"); return { serverId: server.serverId, version: "1.0.0" }; },
  authenticate: async (username, password) => {
    await server.run("login");
    if (typeof username !== "string" || !username || typeof password !== "string" || !password) throw new MediaServerError("invalid-input", "bad credentials");
    return { serverId: server.serverId, accountId: server.accountId, token: server.token };
  },
  currentAccount: async () => { await server.run("user"); return { accountId: server.accountId, policy: clone(server.policy) }; },
  listLibraries: async () => { await server.run("views"); return clone(server.libraries); },
  pageItems: async (_token, _account, libraryId, options) => {
    await server.run("items");
    if (server.pageOverride) return server.pageOverride(options ?? {});
    const all = server.items[libraryId] ?? [];
    const offset = options?.cursor ? Number(Buffer.from(options.cursor, "base64url").toString("utf8")) : 0;
    const limit = options?.limit ?? 100;
    const slice = all.slice(offset, offset + limit);
    const next = offset + slice.length < all.length ? Buffer.from(String(offset + slice.length), "utf8").toString("base64url") : undefined;
    return { items: clone(slice), total: all.length, ...(next === undefined ? {} : { cursor: next }) };
  },
  pageDirectory: async (_token, _account, parentId, options) => {
    await server.run("directory");
    server.directoryCalls.push({ parentId, options: options as unknown as Record<string, unknown> });
    if (server.directoryOverride) return server.directoryOverride(parentId, options);
    const base = server.directories[parentId] ?? server.items[parentId] ?? [];
    const needle = options?.search?.toLowerCase();
    const wanted = options?.type;
    const all = base.filter((item) =>
      (wanted === undefined || item.type === wanted)
      && (needle === undefined || needle.length === 0 || item.name.toLowerCase().includes(needle)));
    const offset = options?.cursor ? Number(Buffer.from(options.cursor, "base64url").toString("utf8")) : 0;
    const limit = options?.limit ?? 60;
    const slice = all.slice(offset, offset + limit);
    const next = offset + slice.length < all.length ? Buffer.from(String(offset + slice.length), "utf8").toString("base64url") : undefined;
    return { items: clone(slice), total: all.length, ...(next === undefined ? {} : { cursor: next }) };
  },
  findByProviderIds: async (_token, _account, _libraryId, ids, type, nameHint) => {
    await server.run("find");
    server.matchCalls.push({ ids: clone(ids), type, ...(nameHint === undefined ? {} : { nameHint }) });
    if (server.findOverride) return clone(server.findOverride(ids, type, nameHint));
    return clone(server.catalogue.filter((item) => item.type === type && remoteIdsMatch(ids, item.providerIds)));
  },
  detail: async (_token, _account, itemId) => {
    await server.run("detail");
    const item = server.detailOf[itemId];
    if (!item) throw new MediaServerError("not-found", "no such item");
    return clone(item);
  },
  ancestors: async (_token, _account, itemId) => { await server.run("ancestors"); return [...(server.ancestorsOf[itemId] ?? [])]; },
  versions: async (_token, _account, itemId) => { await server.run("versions"); return clone(server.versionsOf[itemId] ?? []); },
});

const stubTransport = (server: FakeServer): MediaServerTransport => ({
  requestJson: async () => { throw new Error("the stub provider does not use the transport"); },
  requestAsset: async (request) => {
    server.assetRequests.push(request as unknown as Record<string, unknown>);
    await server.run("asset");
    if (!server.asset) throw new Error("no asset response is configured");
    return { bytes: server.asset.bytes, contentType: server.asset.contentType };
  },
  requestArtwork: async (args) => {
    server.artworkRequests.push(args as unknown as Record<string, unknown>);
    await server.run("artwork");
    const spec = server.artwork;
    if (!spec) throw new Error("no artwork response is configured");
    if (spec.error) throw spec.error;
    return new Response(new ReadableStream<Uint8Array>({
      start: (controller) => { controller.enqueue(spec.bytes); controller.close(); },
      cancel: () => { server.artworkCancelled += 1; },
    }), { status: spec.status ?? 200, headers: { "content-type": spec.contentType } });
  },
  requestOriginal: async () => {
    server.originalCalls += 1;
    await server.run("original");
    const spec = server.original;
    if (!spec) throw new Error("no original response is configured");
    if (spec.error) throw spec.error;
    return new Response(new ReadableStream<Uint8Array>({ cancel: () => { server.originalCancelled += 1; } }), {
      status: spec.status ?? 200,
      ...(spec.headers ? { headers: spec.headers } : {}),
    });
  },
  close: async () => { server.closed += 1; },
});

interface Harness {
  dir: string;
  store: Store;
  vault: MediaServerSecrets;
  server: FakeServer;
  manager: MediaServerManager;
  index: MediaServerIndex;
  admin: MediaServerAuthority;
  bob: MediaServerAuthority;
  carol: MediaServerAuthority;
  /** Observes the state exactly as one write landed it. */
  onWrite(fn: (state: { mediaSecretCleanup?: string[] }) => void): void;
  /** How many writes the store has taken, so a pass that changes nothing can be told apart
   *  from one that rewrote the state. */
  writes(): number;
  revoke(): void;
  demoteOnNextWrite(): void;
  revokeBeforeNextWrite(): void;
  close(): Promise<void>;
}

const mount = async (options: {
  users?: UserRecord[];
  key?: boolean;
  remoteMedia?: Record<string, Record<string, unknown>>;
  connections?: unknown[];
  libraries?: unknown[];
  cleanupIntervalMs?: number;
  networkStartIntervalMs?: number;
  coalesceReads?: boolean;
  clock?: () => number;
} = {}): Promise<Harness> => {
  const dir = await mkdtemp(path.join(tmpdir(), "media-manager-"));
  const users = options.users ?? [admin, bob, carol];
  await writeFile(path.join(dir, "state.json"), JSON.stringify({
    schemaVersion: 3,
    addons: [],
    settings: {},
    defaultsInstalled: true,
    users,
    userData: Object.fromEntries(users.map((user) => [user.id, {
      ...emptyUserData(),
      ...(options.remoteMedia?.[user.id] === undefined ? {} : { remoteMedia: options.remoteMedia[user.id] }),
    }])),
    libraries: [],
    ...(options.connections === undefined ? {} : { mediaConnections: options.connections }),
    ...(options.libraries === undefined ? {} : { remoteLibraries: options.libraries }),
  }));
  const keyFile = path.join(dir, "secret.key");
  if (options.key !== false) await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
  const store = new Store(dir, dir);
  await store.load();
  const vault = new MediaServerSecrets(path.join(dir, "vault"), options.key === false ? undefined : keyFile);
  const server = new FakeServer();
  const index = new MediaServerIndex();
  const manager = new MediaServerManager(store, vault, {
    providerFactory: () => stubProvider(server),
    transportFactory: () => stubTransport(server),
    index,
    // The identical-live-session tests own the network lane, so none of the shared harness pays
    // the production 125ms start interval; a test proves the pacing with its own short interval.
    networkStartIntervalMs: options.networkStartIntervalMs ?? 0,
    ...(options.coalesceReads === undefined ? {} : { coalesceReads: options.coalesceReads }),
    ...(options.cleanupIntervalMs === undefined ? {} : { cleanupIntervalMs: options.cleanupIntervalMs }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  await manager.initialize();

  let revoked = false;
  const authority = (user: UserRecord): MediaServerAuthority => ({
    actor: { id: user.id, secret: user.secret },
    assertCurrent: () => { if (revoked) throw new ResourceError(401, "AUTH_REQUIRED"); },
  });

  // A demotion that lands just before the manager's own write, as a queued request would.
  const write = store.update.bind(store);
  let demote = false;
  let revokeOnWrite = false;
  let onWrite: ((state: { mediaSecretCleanup?: string[] }) => void) | undefined;
  let writes = 0;
  (store as unknown as { update(mutate: (state: { users?: UserRecord[] }) => void): Promise<void> }).update = (mutate) => {
    writes += 1;
    if (revokeOnWrite) { revokeOnWrite = false; revoked = true; }
    const observe = (state: { users?: UserRecord[]; mediaSecretCleanup?: string[] }) => { mutate(state); onWrite?.(state); };
    if (!demote) return write(observe);
    demote = false;
    void write((state) => { state.users = (state.users ?? []).map((user) => user.id === ADA ? { ...user, role: "user" } : user); });
    return write(observe);
  };

  return {
    dir, store, vault, server, manager, index,
    admin: authority(admin), bob: authority(bob), carol: authority(carol),
    onWrite: (fn) => { onWrite = fn; },
    writes: () => writes,
    revoke: () => { revoked = true; },
    demoteOnNextWrite: () => { demote = true; },
    revokeBeforeNextWrite: () => { revokeOnWrite = true; },
    close: async () => { await manager.close(); await rm(dir, { recursive: true, force: true }); },
  };
};

const withHarness = async (
  run: (harness: Harness) => Promise<void>,
  options: { users?: UserRecord[]; key?: boolean; networkStartIntervalMs?: number; coalesceReads?: boolean; clock?: () => number } = {},
) => {
  const harness = await mount(options);
  try { await run(harness); }
  finally { await harness.close(); }
};

const connect = (harness: Harness, over: Record<string, unknown> = {}) =>
  harness.manager.createConnection(harness.admin, {
    provider: "jellyfin", name: "Media", baseUrl: "http://media.example", allowLan: false, allowLoopback: false,
    username: "reader", password: "reader-password", ...over,
  });

const seedLibrary = (harness: Harness, id: string, items: ProviderItem[]) => {
  harness.server.libraries.push({ id, name: `Library ${id}`, type: "movie" });
  harness.server.items[id] = items;
  for (const item of items) harness.server.ancestorsOf[item.id] = [id];
};

/** How many operations wait in the manager's network queue (the bound this suite owns). */
const netQueueLength = (harness: Harness): number =>
  (harness.manager as unknown as { netWaiters: unknown[] }).netWaiters.length;

/** How many network slots are reserved right now, admitted operations plus handed-over ones. */
const netActive = (harness: Harness): number =>
  (harness.manager as unknown as { activeNetwork: number }).activeNetwork;

/** The live-session reads currently shared on one connection's runtime. */
const inflightReads = (harness: Harness, connectionId: string): Map<string, { controller: AbortController; subscribers: number }> =>
  (harness.manager as unknown as { runtimes: Map<string, { inflight: Map<string, { controller: AbortController; subscribers: number }> }> })
    .runtimes.get(connectionId)?.inflight ?? new Map();

/** How many operations wait for one connection's start pacing. */
const pacerQueueLength = (harness: Harness, connectionId: string): number =>
  (harness.manager as unknown as { runtimes: Map<string, { pacer: { waiters: unknown[] } }> })
    .runtimes.get(connectionId)?.pacer.waiters.length ?? 0;

/** How many callers currently share one connection's in-flight read. */
const subscribersOf = (harness: Harness, connectionId: string, key: string): number | undefined =>
  inflightReads(harness, connectionId).get(key)?.subscribers;

test("a connection is created enabled with a stored token and never returns the token", async () => {
  await withHarness(async (harness) => {
    const view = await connect(harness);
    assert.equal(view.enabled, true);
    assert.equal(view.status, "available");
    assert.equal(view.accountId, "user-1");
    assert.equal("token" in view, false);
    assert.equal(JSON.stringify(view).includes("token-value-1"), false);
    assert.equal((await harness.vault.references()).length, 1, "the token is in the vault, nowhere else");
    assert.deepEqual(harness.store.mediaConnections().map((connection) => connection.generation), [0]);
  });
});

test("createConnection validates every field before any network call", async () => {
  await withHarness(async (harness) => {
    const calls = harness.server.calls.length;
    for (const bad of [
      { provider: "plex" },
      { name: "" },
      { baseUrl: "ftp://media.example" },
      { allowLan: "false" },
      { username: "" },
      { password: "x".repeat(1025) },
      { root: "/data" },
      { serverId: "server-1" },
      { enabled: true },
      { token: "t" },
      { secretRef: "msecret_00000000000000000000000000000001" },
    ]) {
      await assert.rejects(connect(harness, bad), (error: MediaServerError) => {
        assert.equal(error.code, "invalid-input", JSON.stringify(bad));
        return true;
      });
    }
    assert.equal(harness.server.calls.length, calls, "no request left the process");
    assert.deepEqual(harness.store.mediaConnections(), []);
  });
});

test("a duplicate remote account is refused and the just-written secret is rolled back", async () => {
  await withHarness(async (harness) => {
    await connect(harness);
    await assert.rejects(connect(harness), (error: MediaServerError) => { assert.equal(error.code, "invalid-input"); return true; });
    assert.equal(harness.store.mediaConnections().length, 1);
    assert.equal((await harness.vault.references()).length, 1, "the refused attempt left no orphan file");
  });
});

test("a revoked session refuses every admin mutation at its queued write, leaving state untouched", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    seedLibrary(harness, "lib-1", [movie("m1")]);
    const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" });
    const before = harness.store.mediaConnections()[0]!.secretRef;
    const snapshot = () => JSON.stringify({ connections: harness.store.mediaConnections(), libraries: harness.store.remoteLibraries() });
    const baseline = snapshot();
    const refs = (await harness.vault.references()).length;

    // One entry per request-authorized write, each revoked on its own SID at the moment its
    // mutator runs -- no secret, role or disabled change is involved.
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ["patchConnection", () => harness.manager.patchConnection(harness.admin, connection.id, { enabled: false })],
      ["createConnection", () => connect(harness, { username: "second" })],
      ["reauthenticate", () => harness.manager.reauthenticate(harness.admin, connection.id, { username: "reader", password: "new" })],
      ["attachLibrary", () => harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" })],
      ["patchLibrary", () => harness.manager.patchLibrary(harness.admin, library.id, { allowedUsers: [BOB] })],
      ["deleteLibrary", () => harness.manager.deleteLibrary(harness.admin, library.id)],
      ["removeConnection", () => harness.manager.removeConnection(harness.admin, connection.id)],
      ["import", () => harness.manager.importConfiguration(harness.admin, { version: 1, connections: [], libraries: [] })],
    ];
    for (const [label, run] of attempts) {
      harness.revokeBeforeNextWrite();
      const outcome = await run().then(() => undefined, (error: unknown) => error);
      assert.ok(outcome instanceof ResourceError, `${label} must refuse a revoked session`);
      assert.equal(snapshot(), baseline, `${label} left the state untouched`);
      assert.equal((await harness.vault.references()).length, refs, `${label} left the vault untouched`);
      assert.equal(harness.store.mediaConnections()[0]!.secretRef, before, `${label} did not rotate the credential`);
    }
  });
});

test("shutting the manager down during a held login writes nothing and releases the login transport", async () => {
  await withHarness(async (harness) => {
    const held = (() => { let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; }); return { wait, release }; })();
    const entered = (() => { let signal!: () => void; const promise = new Promise<void>((resolve) => { signal = resolve; }); return { promise, signal }; })();
    harness.server.nudge = { op: "login", wait: held.wait, entered: entered.signal };
    harness.server.closed = 0;
    const creating = connect(harness, { username: "late" });
    await entered.promise;
    await harness.manager.close();
    held.release();
    await assert.rejects(creating, (error: MediaServerError) => {
      assert.ok(["closed", "cancelled"].includes(error.code), error.code);
      return true;
    });
    assert.deepEqual(harness.store.mediaConnections(), [], "nothing was installed after the shutdown");
    assert.deepEqual(await harness.vault.references(), [], "no credential was written");
    assert.ok(harness.server.closed >= 1, "the temporary login transport was closed");
  });
});

test("an abort during any preflight stage stops the read before it publishes", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    seedLibrary(harness, "lib-1", [movie("m1")]);
    const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" });
    const dropRuntime = () => { (harness.manager as unknown as { runtimes: Map<string, unknown> }).runtimes.delete(connection.id); };
    for (const operation of ["info", "user", "views", "directory"]) {
      // Each stage must be re-proved from scratch, so the cached session facts are dropped.
      dropRuntime();
      const held = (() => { let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; }); return { wait, release }; })();
      const entered = (() => { let signal!: () => void; const promise = new Promise<void>((resolve) => { signal = resolve; }); return { promise, signal }; })();
      harness.server.nudge = { op: operation, wait: held.wait, entered: entered.signal };
      const controller = new AbortController();
      const browsing = harness.manager.browseItems(harness.admin, library.id, {}, controller.signal).then(() => undefined, (error: unknown) => error);
      await entered.promise;
      controller.abort();
      held.release();
      harness.server.nudge = undefined;
      const outcome = await browsing;
      assert.ok(outcome instanceof MediaServerError, `${operation} must refuse an aborted request`);
      assert.equal(outcome.code, "cancelled", operation);
    }
  });
});

test("a one-page browse never follows a provider cursor and never scans a large library", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    seedLibrary(harness, "lib-1", []);
    const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" });

    // The provider advertises a next page; one browse request still reads exactly one page.
    harness.server.directoryOverride = (_parentId, options) => options.cursor === undefined
      ? { items: [movie("m1")], total: 3, cursor: "A" }
      : { items: [movie("m2")], total: 3 };
    const page = await harness.manager.browseItems(harness.admin, library.id, {});
    assert.deepEqual(page.items.map((item) => item.id), ["m1"]);
    assert.equal(page.total, 3);
    assert.ok(page.cursor, "a continuation cursor is offered, but the request never follows it");
    assert.equal(harness.server.calls.includes("items"), false, "the recursive items operation is never used");

    // A big library is never materialized: one bounded page comes back, not twenty rows.
    harness.server.directoryOverride = (_parentId, options) => ({
      items: Array.from({ length: 20 }, (_, index) => movie(`m${index}`, "x".repeat(300_000))).slice(0, options.limit ?? 60),
      total: 20,
    });
    const big = await harness.manager.browseItems(harness.admin, library.id, { limit: "3" });
    assert.equal(big.items.length, 3, "only the requested page is returned");
    harness.server.directoryOverride = undefined;
  });
});

test("a cached read is refused for an already-aborted request and when the abort lands mid-preflight", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    seedLibrary(harness, "lib-1", [movie("m1")]);
    const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" });
    await harness.manager.browseItems(harness.admin, library.id, {});

    // The snapshot is warm and within its TTL; an aborted request still gets nothing.
    await assert.rejects(harness.manager.browseItems(harness.admin, library.id, {}, AbortSignal.abort()), { code: "cancelled" });

    const controller = new AbortController();
    const held = (() => { let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; }); return { wait, release }; })();
    const entered = (() => { let signal!: () => void; const promise = new Promise<void>((resolve) => { signal = resolve; }); return { promise, signal }; })();
    harness.server.nudge = { op: "directory", wait: held.wait, entered: entered.signal };
    harness.index.invalidateConnection(connection.id);
    const browsing = harness.manager.browseItems(harness.admin, library.id, {}, controller.signal);
    await entered.promise;
    controller.abort();
    held.release();
    harness.server.nudge = undefined;
    await assert.rejects(browsing, { code: "cancelled" });
  });
});

test("an imported, disabled connection can bind its first credential and then be enabled with grants", async () => {
  await withHarness(async (harness) => {
    const body = {
      version: 1,
      connections: [{ id: "mconn_0000000000000000000000000000000a", provider: "jellyfin", name: "Imported", baseUrl: "http://media.example", allowLan: false, allowLoopback: false, serverId: "server-1", accountId: "user-1" }],
      libraries: [{ id: "rlib_0000000000000000000000000000000b", connectionId: "mconn_0000000000000000000000000000000a", remoteId: "lib-1", name: "Films", type: "movie", order: 0, showOnHome: true, showInContinueWatching: true }],
    };
    const restored = await harness.manager.importConfiguration(harness.admin, body);
    const connection = restored.connections[0]!;
    const library = restored.libraries[0]!;
    assert.equal(connection.enabled, false);
    assert.equal(connection.configured, false);
    assert.deepEqual(library.allowedUsers, []);
    assert.equal((await harness.vault.references()).length, 0);
    assert.deepEqual(await harness.manager.visibleLibraries(harness.bob), [], "an imported library is invisible until granted");

    // A different account is refused before anything is bound.
    harness.server.accountId = "user-9";
    await assert.rejects(harness.manager.reauthenticate(harness.admin, connection.id, { username: "reader", password: "pw" }), { code: "identity-changed" });
    assert.equal((await harness.vault.references()).length, 0, "no credential was written by the refused attempt");
    harness.server.accountId = "user-1";

    const bound = await harness.manager.reauthenticate(harness.admin, connection.id, { username: "reader", password: "pw" });
    assert.equal(bound.configured, true);
    assert.equal(bound.enabled, false, "binding a credential does not enable the connection");
    assert.equal(bound.generation, 1);
    assert.equal((await harness.vault.references()).length, 1);

    seedLibrary(harness, "lib-1", [movie("m1")]);
    await assert.rejects(harness.manager.browseItems(harness.bob, library.id, {}), { code: "not-found" });
    const enabled = await harness.manager.patchConnection(harness.admin, connection.id, { enabled: true });
    assert.equal(enabled.enabled, true);
    await harness.manager.patchLibrary(harness.admin, library.id, { enabled: true, allowedUsers: [BOB] });
    const page = await harness.manager.browseItems(harness.bob, library.id, {});
    assert.deepEqual(page.items.map((item) => item.id), ["m1"], "the restored, re-authenticated library is usable");
    assert.notEqual(harness.store.mediaConnections()[0]!.id, body.connections[0]!.id, "the export handle stayed a reference");
  });
});

test("grant and visibility changes bump the ordinary grantees' permission stamps", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    seedLibrary(harness, "lib-1", [movie("m1")]);
    const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" });
    const version = () => harness.store.users().find((user) => user.id === BOB)!.permissionsVersion;
    const start = version();
    assert.equal(start, 0);

    await harness.manager.patchLibrary(harness.admin, library.id, { order: 5 });
    assert.equal(version(), start, "a reorder is not a permission change");
    await harness.manager.patchLibrary(harness.admin, library.id, { allowedUsers: [BOB] });
    assert.equal(version(), start + 1, "granting a library is a permission change");
    await harness.manager.patchLibrary(harness.admin, library.id, { enabled: false });
    assert.equal(version(), start + 2, "hiding a library is a permission change");
    await harness.manager.patchConnection(harness.admin, connection.id, { enabled: false });
    assert.equal(version(), start + 3, "disabling the connection is a permission change");
    await harness.manager.patchConnection(harness.admin, connection.id, { name: "Renamed" });
    assert.equal(version(), start + 3, "a rename is not a permission change");
    await harness.manager.removeConnection(harness.admin, connection.id);
    assert.equal(version(), start + 4, "removing the connection is a permission change");

    const fresh = await connect(harness, { username: "again" });
    seedLibrary(harness, "lib-2", [movie("m2")]);
    await harness.manager.attachLibrary(harness.admin, fresh.id, { remoteId: "lib-2" });
    assert.equal(version(), start + 4, "an attachment grants nobody and bumps nobody");
  });
});

test("a demotion in flight refuses the write and rolls the fresh secret back", async () => {
  await withHarness(async (harness) => {
    harness.demoteOnNextWrite();
    await assert.rejects(connect(harness), ForbiddenError);
    assert.deepEqual(harness.store.mediaConnections(), []);
    assert.deepEqual(await harness.vault.references(), [], "the uncommitted token was removed");
  });
});

test("a revoked request guard stops the write and the discovery result", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    seedLibrary(harness, "lib-1", [movie("m1")]);
    await assert.rejects(harness.manager.discoverLibraries(harness.bob, connection.id), ForbiddenError, "a member is not an administrator");
    await assert.rejects(harness.manager.listConnections(harness.bob), ForbiddenError);
    harness.revoke();
    await assert.rejects(harness.manager.visibleLibraries(harness.bob), ResourceError, "a revoked session fails the captured request guard");
    await assert.rejects(harness.manager.discoverLibraries(harness.admin, connection.id), ResourceError);
  });
});

test("reauthentication replaces the secret, bumps the generation and queues the old reference", async () => {
  await withHarness(async (harness) => {
    const created = await connect(harness);
    const before = harness.store.mediaConnections()[0]!.secretRef;
    const updated = await harness.manager.reauthenticate(harness.admin, created.id, { username: "reader", password: "new-password" });
    assert.equal(updated.generation, 1);
    const after = harness.store.mediaConnections()[0]!.secretRef;
    assert.notEqual(after, before);
    assert.deepEqual(harness.store.mediaSecretCleanup(), [], "the drained queue is empty after a successful removal");
    const refs = await harness.vault.references();
    assert.deepEqual(refs, [after as string], "only the new reference remains");
  });
});

test("a changed identity during reauthentication is refused and keeps the old binding", async () => {
  await withHarness(async (harness) => {
    const created = await connect(harness);
    const before = harness.store.mediaConnections()[0]!.secretRef;
    harness.server.accountId = "someone-else";
    await assert.rejects(harness.manager.reauthenticate(harness.admin, created.id, { username: "reader", password: "new" }), { code: "identity-changed" });
    assert.equal(harness.store.mediaConnections()[0]!.secretRef, before);
    assert.deepEqual(await harness.vault.references(), [before as string], "no new secret was written");
    harness.server.accountId = "user-1";
  });
});

test("member reads are scoped by grant, actor and library, and 404 the same way", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    seedLibrary(harness, "lib-1", [movie("m1", "Alien"), movie("m2", "Aliens")]);
    seedLibrary(harness, "lib-2", [movie("m3", "Nope")]);
    const one = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" });
    const two = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-2" });
    await harness.manager.patchLibrary(harness.admin, one.id, { allowedUsers: [BOB] });

    const visible = await harness.manager.visibleLibraries(harness.bob);
    assert.deepEqual(visible.map((library) => library.id), [one.id]);
    assert.equal(JSON.stringify(visible).includes("allowedUsers"), false);
    assert.equal(JSON.stringify(visible).includes("server-1"), false);
    assert.equal(JSON.stringify(visible).includes("media.example"), false);

    await assert.rejects(harness.manager.browseItems(harness.bob, two.id, {}), { code: "not-found" }, "a library with no grant reads as missing");
    await assert.rejects(harness.manager.browseItems(harness.bob, "rlib_00000000000000000000000000000009", {}), { code: "not-found" });
    await assert.rejects(harness.manager.browseItems(harness.carol, one.id, {}), { code: "not-found" });

    const page = await harness.manager.browseItems(harness.bob, one.id, {});
    assert.deepEqual(page.items.map((item) => item.id), ["m1", "m2"]);
    assert.equal(page.total, 2);
    // The administrator sees both libraries, and neither is limited by a grant.
    const adminPage = await harness.manager.browseItems(harness.admin, two.id, {});
    assert.deepEqual(adminPage.items.map((item) => item.id), ["m3"]);
    assert.equal(harness.store.mediaConnections().length, 1);
    assert.deepEqual(harness.store.remoteLibraries().find((library) => library.id === two.id)?.allowedUsers, []);
  });
});

test("browse supports search, type and a bounded canonical cursor", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    seedLibrary(harness, "lib-1", [movie("m1", "Alien"), movie("m2", "Aliens"), { id: "s1", name: "Alien Nation", type: "series", providerIds: {} }]);
    const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" });

    const searched = await harness.manager.browseItems(harness.admin, library.id, { search: "alien" });
    assert.equal(searched.total, 3);
    const movies = await harness.manager.browseItems(harness.admin, library.id, { search: "alien", type: "movie" });
    assert.deepEqual(movies.items.map((item) => item.id), ["m1", "m2"]);
    assert.equal(movies.total, 2, "the total counts after the filter");

    const first = await harness.manager.browseItems(harness.admin, library.id, { limit: "1" });
    assert.deepEqual(first.items.map((item) => item.id), ["m1"]);
    assert.ok(first.cursor);
    const second = await harness.manager.browseItems(harness.admin, library.id, { limit: "1", cursor: first.cursor });
    assert.deepEqual(second.items.map((item) => item.id), ["m2"]);

    // A cursor is bound to its actor and its library.
    await harness.manager.patchLibrary(harness.admin, library.id, { allowedUsers: [BOB] });
    await assert.rejects(harness.manager.browseItems(harness.bob, library.id, { limit: "1", cursor: first.cursor }), { code: "stale-generation" });
    await assert.rejects(harness.manager.browseItems(harness.admin, library.id, { limit: "0" }), { code: "invalid-input" });
    await assert.rejects(harness.manager.browseItems(harness.admin, library.id, { limit: "201" }), { code: "invalid-input" });
    await assert.rejects(harness.manager.browseItems(harness.admin, library.id, { unknown: "1" }), { code: "invalid-input" });
    await assert.rejects(harness.manager.browseItems(harness.admin, library.id, { type: "book" }), { code: "invalid-input" });
  });
});

test("a grant removed while a scan is in flight publishes nothing", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    seedLibrary(harness, "lib-1", [movie("m1")]);
    const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" });
    await harness.manager.patchLibrary(harness.admin, library.id, { allowedUsers: [BOB] });
    const adminPage = await harness.manager.browseItems(harness.admin, library.id, {});
    assert.equal(adminPage.total, 1);

    const held = (() => { let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; }); return { wait, release }; })();
    harness.server.nudge = { op: "items", wait: held.wait };
    harness.index.invalidateConnection(connection.id);
    // The handler is attached before the write lands, so a refusal is never an unhandled rejection.
    const browsing = harness.manager.browseItems(harness.bob, library.id, {})
      .then(() => undefined, (error: unknown) => error);
    await harness.manager.patchLibrary(harness.admin, library.id, { allowedUsers: [] });
    held.release();
    const outcome = await browsing;
    assert.ok(outcome instanceof MediaServerError, "the revoked grant publishes nothing");
    assert.ok(["not-found", "stale-generation"].includes(outcome.code), outcome.code);
  });
});

test("permission is re-checked live: an upstream 401 marks reauthentication, 403 and 404 do not", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    seedLibrary(harness, "lib-1", [movie("m1")]);
    harness.server.detailOf["m1"] = movie("m1");
    const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" });
    await harness.manager.browseItems(harness.admin, library.id, {});

    harness.server.errors.directory = new MediaServerError("forbidden", "nope", 403);
    dropRuntime(harness, connection.id);
    await assert.rejects(harness.manager.browseItems(harness.admin, library.id, {}), { code: "forbidden" });
    assert.equal((await harness.manager.listConnections(harness.admin)).connections[0]!.status, "available", "a content 403 changes no status");

    delete harness.server.errors.directory;
    harness.server.errors.user = new MediaServerError("authentication-required", "401", 401);
    dropRuntime(harness, connection.id);
    await assert.rejects(harness.manager.browseItems(harness.admin, library.id, {}), { code: "authentication-required" });
    assert.equal((await harness.manager.listConnections(harness.admin)).connections[0]!.status, "reauthentication-required");
    delete harness.server.errors.user;

    // A 401 from a page, a detail or an ancestor call revokes the runtime too, not only the
    // preflight: the cached token is no longer usable for any operation.
    for (const operation of ["directory", "detail", "ancestors"]) {
      harness.server.errors[operation] = new MediaServerError("authentication-required", "401", 401);
      const attempt = operation === "directory"
        ? harness.manager.browseItems(harness.admin, library.id, {})
        : harness.manager.itemDetail(harness.admin, library.id, "m1");
      await assert.rejects(attempt, { code: "authentication-required" });
      assert.equal((await harness.manager.listConnections(harness.admin)).connections[0]!.status, "reauthentication-required", operation);
      delete harness.server.errors[operation];
    }
  });
});

test("account policy gates the read: disabled, no playback and unsupported restrictions fail closed", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    seedLibrary(harness, "lib-1", [movie("m1")]);
    const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" });

    harness.server.policy.disabled = true;
    dropRuntime(harness, connection.id);
    await assert.rejects(harness.manager.browseItems(harness.admin, library.id, {}), { code: "unavailable" });
    harness.server.policy.disabled = false;

    harness.server.policy.mediaPlayback = false;
    dropRuntime(harness, connection.id);
    await assert.rejects(harness.manager.browseItems(harness.admin, library.id, {}), { code: "forbidden" });
    harness.server.policy.mediaPlayback = true;

    harness.server.policy.hasAdditionalRestrictions = true;
    dropRuntime(harness, connection.id);
    await assert.rejects(harness.manager.browseItems(harness.admin, library.id, {}), { code: "unsupported-policy" });
    harness.server.policy.hasAdditionalRestrictions = false;

    harness.server.policy.allFolders = false;
    harness.server.policy.folderIds = ["another-library"];
    dropRuntime(harness, connection.id);
    await assert.rejects(harness.manager.browseItems(harness.admin, library.id, {}), { code: "forbidden" });
    harness.server.policy.folderIds = ["lib-1"];
    dropRuntime(harness, connection.id);
    const page = await harness.manager.browseItems(harness.admin, library.id, {});
    assert.equal(page.total, 1);
    harness.server.policy.allFolders = true;
    harness.server.policy.folderIds = [];
  });
});

test("a library missing from the current views reads as not found", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    seedLibrary(harness, "lib-1", [movie("m1")]);
    const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" });
    harness.server.libraries = [];
    dropRuntime(harness, connection.id);
    await assert.rejects(harness.manager.browseItems(harness.admin, library.id, {}), { code: "not-found" });
  });
});

test("detail requires proof of ancestry and refuses a guessed item", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    seedLibrary(harness, "lib-1", []);
    harness.server.detailOf["m1"] = movie("m1");
    harness.server.ancestorsOf["m1"] = ["lib-1"];
    harness.server.detailOf["other"] = movie("other");
    harness.server.ancestorsOf["other"] = ["lib-9"];
    const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" });

    const detail = await harness.manager.itemDetail(harness.admin, library.id, "m1");
    assert.equal(detail.item.id, "m1");
    assert.equal(detail.capabilities.downloadToDevice, false);
    await assert.rejects(harness.manager.itemDetail(harness.admin, library.id, "other"), { code: "not-found" });
    await assert.rejects(harness.manager.itemDetail(harness.admin, library.id, "../etc"), { code: "invalid-input" });
  });
});

test("itemEpisodes is one parent-scoped page of the proven parent's episodes", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    const season = { id: "season-1", name: "Season 1", type: "season" as const, providerIds: {}, parentId: "series-1" };
    const series = { id: "series-1", name: "Show", type: "series" as const, providerIds: {} };
    harness.server.libraries = [{ id: "lib-1", name: "Shows", type: "series" }];
    harness.server.items["lib-1"] = [series, season];
    harness.server.directories["season-1"] = [
      episode("e1", { seriesId: "series-1", parentId: "season-1", season: 1, episode: 1 }),
      episode("e2", { parentId: "season-1", season: 1, episode: 2 }),
    ];
    harness.server.directories["series-1"] = [episode("e1", { seriesId: "series-1", parentId: "season-1", season: 1, episode: 1 })];
    for (const item of [series, season]) harness.server.ancestorsOf[item.id] = ["lib-1"];
    harness.server.detailOf["series-1"] = series;
    harness.server.detailOf["season-1"] = season;
    const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" });

    const bySeason = await harness.manager.itemEpisodes(harness.admin, library.id, "season-1", {});
    assert.deepEqual(bySeason.items.map((item) => item.id), ["e1", "e2"], "a season lists its own episode page");
    const bySeries = await harness.manager.itemEpisodes(harness.admin, library.id, "series-1", {});
    assert.deepEqual(bySeries.items.map((item) => item.id), ["e1"], "a series lists its own episode page");
    await assert.rejects(harness.manager.itemEpisodes(harness.admin, library.id, "unknown", {}), { code: "not-found" });
  });
});

test("the network lane queues beyond four and admin mutations never queue behind each other", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    const held = deferred();
    let entered = 0;
    const four = deferred();
    harness.server.nudge = { op: "info", wait: held.promise, entered: () => { entered += 1; if (entered === 4) four.resolve(); } };
    const running = [0, 1, 2, 3].map(() => harness.manager.discoverLibraries(harness.admin, connection.id));
    const queued = harness.manager.discoverLibraries(harness.admin, connection.id);
    await four.promise;
    await until(() => netQueueLength(harness) === 1);
    let settled = false;
    void queued.then(() => { settled = true; }, () => { settled = true; });
    await tick();
    assert.equal(settled, false, "a fifth network call waits in the queue instead of being refused");
    assert.equal(harness.server.calls.filter((call) => call === "info").length, 4, "only four operations are live");
    assert.equal(netQueueLength(harness), 1, "the fifth call is the one waiting");
    held.resolve();
    harness.server.nudge = undefined;
    await Promise.all([...running, queued]);

    const login = (() => { let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; }); return { wait, release }; })();
    harness.server.nudge = { op: "login", wait: login.wait };
    harness.server.accountId = "user-9";
    const creating = connect(harness, { username: "second-reader" });
    const simultaneous = harness.manager.patchConnection(harness.admin, connection.id, { name: "Other" });
    login.release();
    harness.server.nudge = undefined;
    await assert.rejects(simultaneous, { code: "busy" }, "a second admin mutation is refused immediately");
    await creating;
    harness.server.accountId = "user-1";
  }, { coalesceReads: false });
});

test("a queued network request is removed and cancelled the moment its caller aborts", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    const held = deferred();
    let entered = 0;
    const four = deferred();
    harness.server.nudge = { op: "info", wait: held.promise, entered: () => { entered += 1; if (entered === 4) four.resolve(); } };
    const running = [0, 1, 2, 3].map(() => harness.manager.discoverLibraries(harness.admin, connection.id));
    await four.promise;
    const controller = new AbortController();
    const queued = harness.manager.discoverLibraries(harness.admin, connection.id, controller.signal);
    for (let spins = 0; spins < 1000 && netQueueLength(harness) < 1; spins += 1) await tick();
    assert.equal(netQueueLength(harness), 1, "the request reached the queue");
    controller.abort();
    await assert.rejects(queued, { code: "cancelled" });
    assert.equal(netQueueLength(harness), 0, "the aborted entry left the queue at once");
    held.resolve();
    harness.server.nudge = undefined;
    await Promise.all(running);
  }, { coalesceReads: false });
});

test("closing the manager rejects a queued network request", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    const held = deferred();
    let entered = 0;
    const four = deferred();
    harness.server.nudge = { op: "info", wait: held.promise, entered: () => { entered += 1; if (entered === 4) four.resolve(); } };
    const running = [0, 1, 2, 3].map(() => harness.manager.discoverLibraries(harness.admin, connection.id));
    await four.promise;
    const queued = harness.manager.discoverLibraries(harness.admin, connection.id);
    for (let spins = 0; spins < 1000 && netQueueLength(harness) < 1; spins += 1) await tick();
    assert.equal(netQueueLength(harness), 1, "the request reached the queue");
    const closing = harness.manager.close();
    await assert.rejects(queued, (error: MediaServerError) => {
      assert.ok(["closed", "cancelled"].includes(error.code), error.code);
      return true;
    });
    held.resolve();
    harness.server.nudge = undefined;
    await closing;
    await Promise.allSettled(running);
    assert.equal(netQueueLength(harness), 0, "no waiter is left behind after a close");
    assert.equal(netActive(harness), 0, "every reserved slot was released");
  }, { coalesceReads: false });
});

test("the pending queue refuses a request beyond its 128-waiter bound", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    const held = deferred();
    let entered = 0;
    const four = deferred();
    harness.server.nudge = { op: "info", wait: held.promise, entered: () => { entered += 1; if (entered === 4) four.resolve(); } };
    const running = [0, 1, 2, 3].map(() => harness.manager.discoverLibraries(harness.admin, connection.id));
    await four.promise;
    const waiting = Array.from({ length: 128 }, () => harness.manager.discoverLibraries(harness.admin, connection.id));
    for (let spins = 0; spins < 100000 && netQueueLength(harness) < 128; spins += 1) await tick();
    assert.equal(netQueueLength(harness), 128, "the queue fills to its bound");
    await assert.rejects(harness.manager.discoverLibraries(harness.admin, connection.id), { code: "busy" }, "one beyond the bound is refused");
    held.resolve();
    harness.server.nudge = undefined;
    await Promise.all([...running, ...waiting]);
  }, { coalesceReads: false });
});

test("removing a connection queues and drains its secret, never touching a live one", async () => {
  await withHarness(async (harness) => {
    const first = await connect(harness);
    harness.server.accountId = "user-2";
    const second = await connect(harness);
    harness.server.accountId = "user-1";
    await harness.manager.removeConnection(harness.admin, first.id);
    const live = harness.store.mediaConnections().map((connection) => connection.secretRef);
    assert.deepEqual(live, [harness.store.mediaConnections()[0]!.secretRef]);
    assert.deepEqual(harness.store.mediaSecretCleanup(), []);
    assert.deepEqual(await harness.vault.references(), [harness.store.mediaConnections()[0]!.secretRef as string]);
    assert.equal(second.enabled, true);
  });
});

const reconcile = async (state: unknown | undefined, run: (harness: { vault: MediaServerSecrets; manager: MediaServerManager; store: Store }) => Promise<void>) => {
  const root = await mkdtemp(path.join(tmpdir(), "media-reconcile-"));
  try {
    const keyFile = path.join(root, "secret.key");
    await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
    if (state !== undefined) {
      await mkdir(path.join(root, "data"), { recursive: true });
      await writeFile(path.join(root, "data", "state.json"), JSON.stringify(state));
    }
    const vault = new MediaServerSecrets(path.join(root, "vault"), keyFile);
    await vault.put({ connectionId: "mconn_00000000000000000000000000000001", provider: "jellyfin", serverId: "s", accountId: "a" }, "orphan");
    const store = new Store(path.join(root, "data"), root);
    await store.load();
    const server = new FakeServer();
    const manager = new MediaServerManager(store, vault, { providerFactory: () => stubProvider(server), transportFactory: () => stubTransport(server), networkStartIntervalMs: 0 });
    await manager.initialize();
    await run({ vault, manager, store });
    await manager.close();
  } finally { await rm(root, { recursive: true, force: true }); }
};

const legacyState = { schemaVersion: 3, addons: [], settings: {}, defaultsInstalled: true, libraries: [] };

test("startup reconciliation preserves the vault for a missing or legacy state", async () => {
  await reconcile(undefined, async ({ vault, store }) => {
    assert.equal((await vault.references()).length, 1, "a missing state preserves the vault");
    assert.equal(store.hasMediaServerState(), false);
  });
  await reconcile(legacyState, async ({ vault, store }) => {
    assert.equal(store.hasPersistedState(), true);
    assert.equal(store.hasMediaServerState(), false, "a state that never knew media-server fields proves nothing");
    assert.equal((await vault.references()).length, 1, "a legacy state does not authorize deleting a newer vault");
  });
});

test("startup reconciliation collects orphans only from a state that carried media-server fields", async () => {
  await reconcile({ ...legacyState, mediaConnections: [], remoteLibraries: [] }, async ({ vault, store }) => {
    assert.equal(store.hasMediaServerState(), true);
    assert.deepEqual(await vault.references(), [], "an explicit empty media state may collect a true orphan");
  });
});

test("a missing key boots, refuses credential writes and leaves the vault alone", async () => {
  await withHarness(async (harness) => {
    await assert.rejects(connect(harness), (error: MediaServerError) => { assert.equal(error.code, "secret-key-unavailable"); return true; });
    assert.deepEqual(harness.store.mediaConnections(), []);
    assert.deepEqual(harness.store.mediaSecretCleanup(), []);
    const view = await harness.manager.listConnections(harness.admin);
    assert.equal(view.keyConfigured, false);
    assert.deepEqual(view.connections, []);
  }, { key: false });
});

test("the queue refuses a mutation when it is full rather than dropping a reference", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    await harness.store.update((state) => {
      state.mediaSecretCleanup = Array.from({ length: 2048 }, (_, index) => `msecret_${index.toString(16).padStart(32, "0")}`);
    });
    // The drain cannot delete them all (they do not exist), so they stay queued.
    await assert.rejects(harness.manager.removeConnection(harness.admin, connection.id), { code: "busy" });
    assert.equal(harness.store.mediaConnections().length, 1, "the connection stays when its cleanup cannot be queued");
    assert.equal(harness.store.mediaSecretCleanup().length, 2048);
  });
});

test("export carries metadata only; import is additive, disabled and unguarded-by-grant", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    seedLibrary(harness, "lib-1", [movie("m1")]);
    const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" });
    await harness.manager.patchLibrary(harness.admin, library.id, { allowedUsers: [BOB] });
    const exported = harness.manager.exportConfiguration(harness.admin);
    const wire = JSON.stringify(exported);
    assert.equal(wire.includes("msecret_"), false);
    assert.equal(wire.includes("allowedUsers"), false);
    assert.equal(wire.includes("secretRef"), false);
    assert.equal(wire.includes("generation"), false);
    assert.equal(wire.includes(connection.id), true, "the export keeps the handle as a reference");

    const body = {
      version: 1,
      connections: [{ id: "mconn_0000000000000000000000000000000a", provider: "jellyfin", name: "Other", baseUrl: "http://other.example", allowLan: false, allowLoopback: false, serverId: "server-2", accountId: "user-2" }],
      libraries: [{ id: "rlib_0000000000000000000000000000000b", connectionId: "mconn_0000000000000000000000000000000a", remoteId: "lib-9", name: "Other films", type: "movie", order: 0, showOnHome: true, showInContinueWatching: true }],
    };
    const restored = await harness.manager.importConfiguration(harness.admin, body);
    assert.equal(restored.connections.length, 2);
    assert.equal(restored.libraries.length, 2);
    const imported = restored.connections.find((candidate) => candidate.accountId === "user-2")!;
    assert.notEqual(imported.id, body.connections[0]!.id, "a restored handle is fresh, the exported one is only a reference");
    assert.equal(imported.enabled, false);
    assert.equal(imported.status, "disabled");
    assert.deepEqual(restored.libraries.find((entry) => entry.connectionId === imported.id)?.allowedUsers, []);
  });
});

test("a non-administrator cannot reach any administration method", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    const attempts: Array<Promise<unknown>> = [
      harness.manager.createConnection(harness.bob, { provider: "jellyfin", name: "x", baseUrl: "http://media.example", allowLan: false, allowLoopback: false, username: "u", password: "p" }),
      harness.manager.patchConnection(harness.bob, connection.id, { name: "x" }),
      harness.manager.removeConnection(harness.bob, connection.id),
      harness.manager.reauthenticate(harness.bob, connection.id, { username: "u", password: "p" }),
      harness.manager.discoverLibraries(harness.bob, connection.id),
      harness.manager.attachLibrary(harness.bob, connection.id, { remoteId: "lib-1" }),
      harness.manager.deleteLibrary(harness.bob, "rlib_00000000000000000000000000000001"),
      harness.manager.importConfiguration(harness.bob, { version: 1, connections: [], libraries: [] }),
    ];
    for (const attempt of attempts) await assert.rejects(attempt, ForbiddenError);
    assert.throws(() => harness.manager.exportConfiguration(harness.bob), ForbiddenError);
    assert.equal(harness.store.mediaConnections().length, 1);
  });
});

test("deleteLibrary removes only the local attachment and forgets its snapshot", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    seedLibrary(harness, "lib-1", [movie("m1")]);
    const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" });
    await harness.manager.browseItems(harness.admin, library.id, {});
    await harness.manager.deleteLibrary(harness.admin, library.id);
    assert.deepEqual(harness.store.remoteLibraries(), []);
    assert.equal(harness.store.mediaConnections().length, 1, "the connection is untouched");
    const refs = await readdir(path.join(harness.dir, "vault"));
    assert.equal(refs.length, 1, "no remote call removed a credential");
  });
});

test("the connection runtime cache is reused for one generation and rebuilt after a change", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    seedLibrary(harness, "lib-1", [movie("m1")]);
    const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" });
    await harness.manager.browseItems(harness.admin, library.id, {});
    harness.server.closed = 0;
    await harness.manager.browseItems(harness.admin, library.id, {});
    assert.equal(harness.server.closed, 0, "the transport is reused within one generation and secret reference");
    await harness.manager.patchConnection(harness.admin, connection.id, { enabled: false });
    assert.ok(harness.server.closed > 0, "a generation change closes the cached transport");
    const view = await harness.manager.listConnections(harness.admin);
    assert.equal(view.connections[0]!.status, "disabled");
    assert.equal(view.connections[0]!.enabled, false);
  });
});

const until = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("the awaited condition was never reached");
};

const deferred = <T = void>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
};

/** Forget one connection's cached runtime so the next read re-proves the session facts. */
const dropRuntime = (harness: Harness, connectionId: string): void => {
  (harness.manager as unknown as { runtimes: Map<string, unknown> }).runtimes.delete(connectionId);
};

const seedPlayable = async (harness: Harness, itemId = "m1") => {
  const connection = await connect(harness);
  harness.server.libraries.push({ id: "lib-1", name: "Library lib-1", type: "movie" });
  const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" });
  harness.server.detailOf[itemId] = { id: itemId, name: "Movie", type: "movie", providerIds: {} };
  harness.server.ancestorsOf[itemId] = ["lib-1"];
  harness.server.versionsOf[itemId] = [{ id: "v1", name: "1080p", container: "mkv" }];
  return { connection, library };
};

const refFor = (harness: Harness, connectionId: string, libraryId: string, itemId: string, mediaSourceId: string): RemoteContentRef => {
  const connection = harness.store.mediaConnections().find((candidate) => candidate.id === connectionId)!;
  const sealed = sealRemoteContent({
    provider: connection.provider, serverId: connection.serverId, accountId: connection.accountId,
    itemId, connectionId: connection.id, libraryId, generation: connection.generation, mediaSourceId,
    owner: { userId: admin.id, sid: "admin-sid", expiresAt: Date.now() + 3_600_000, secretStamp: remoteSecretStamp(admin.secret) },
  });
  return openRemoteContent(sealed)!;
};

test("itemVersions returns ordinary file versions with the verified identity and no address", async () => {
  await withHarness(async (harness) => {
    const { connection, library } = await seedPlayable(harness);
    const result = await harness.manager.itemVersions(harness.admin, library.id, "m1");
    assert.equal(result.item.id, "m1");
    assert.deepEqual(result.versions.map((version) => version.id), ["v1"]);
    assert.equal(result.identity.provider, "jellyfin");
    assert.equal(result.identity.itemId, "m1");
    assert.equal(result.connectionId, connection.id);
    assert.equal(result.libraryId, library.id);
    assert.equal(result.generation, connection.generation);
    assert.equal(result.libraryName, "Library lib-1");
    assert.equal(JSON.stringify(result).includes("media-server:"), false);
  });
});

test("itemVersions rejects a non-playable item and an item from a sibling library", async () => {
  await withHarness(async (harness) => {
    const { library } = await seedPlayable(harness);
    harness.server.detailOf["series-1"] = { id: "series-1", name: "Show", type: "series", providerIds: {} };
    harness.server.ancestorsOf["series-1"] = ["lib-1"];
    await assert.rejects(harness.manager.itemVersions(harness.admin, library.id, "series-1"), { code: "invalid-input" });
    harness.server.detailOf["sibling"] = { id: "sibling", name: "Elsewhere", type: "movie", providerIds: {} };
    harness.server.ancestorsOf["sibling"] = ["lib-other"];
    await assert.rejects(harness.manager.itemVersions(harness.admin, library.id, "sibling"), { code: "not-found" });
  });
});

test("revalidateOriginal requires the named source version and the owning actor", async () => {
  await withHarness(async (harness) => {
    const { connection, library } = await seedPlayable(harness);
    const good = refFor(harness, connection.id, library.id, "m1", "v1");
    await harness.manager.revalidateOriginal(harness.admin, good);
    harness.server.versionsOf["m1"] = [{ id: "v2" }];
    await assert.rejects(harness.manager.revalidateOriginal(harness.admin, good), { code: "not-found" });
    const otherOwner = { ...good, owner: { ...good.owner, userId: bob.id } };
    await assert.rejects(harness.manager.revalidateOriginal(harness.admin, otherOwner), { status: 404 });
  });
});

test("openOriginal returns the original response only while everything is current", async () => {
  await withHarness(async (harness) => {
    const { connection, library } = await seedPlayable(harness);
    harness.server.original = { status: 206, headers: { "content-range": "bytes 0-1/2" } };
    const ref = refFor(harness, connection.id, library.id, "m1", "v1");
    const response = await harness.manager.openOriginal(harness.admin, ref, { method: "GET", range: "bytes=0-1" });
    assert.equal(response.status, 206);
    assert.equal(harness.server.originalCalls, 1);
  });
});

test("display-only library edits keep live sources and browse cursors usable", async () => {
  await withHarness(async (harness) => {
    const { connection, library } = await seedPlayable(harness);
    harness.server.items["lib-1"] = [movie("m1"), movie("m2")];
    harness.server.original = { status: 206 };
    const ref = refFor(harness, connection.id, library.id, "m1", "v1");
    const first = await harness.manager.browseItems(harness.admin, library.id, { limit: "1" });
    assert.ok(first.cursor);
    const generation = harness.store.mediaConnections()[0]!.generation;
    const closed = harness.server.closed;
    await harness.manager.patchLibrary(harness.admin, library.id, {
      name: "Renamed library", order: 8, showOnHome: false, showInContinueWatching: false,
    });
    assert.equal(harness.store.mediaConnections()[0]!.generation, generation);
    assert.equal(harness.server.closed, closed, "a display edit keeps the active transport alive");
    const second = await harness.manager.browseItems(harness.admin, library.id, { limit: "1", cursor: first.cursor });
    assert.deepEqual(second.items.map((item) => item.id), ["m2"]);
    const original = await harness.manager.openOriginal(harness.admin, ref, { method: "GET", range: "bytes=0-1" });
    assert.equal(original.status, 206);
    await original.body?.cancel();
  });
});

test("openOriginal cancels the body when the generation changes while headers are awaited", async () => {
  await withHarness(async (harness) => {
    const { connection, library } = await seedPlayable(harness);
    harness.server.original = { status: 200 };
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const gate = deferred();
    harness.server.nudge = { op: "original", wait: gate.promise, entered };
    const ref = refFor(harness, connection.id, library.id, "m1", "v1");
    const pending = harness.manager.openOriginal(harness.admin, ref, { method: "GET" });
    await reached;
    await harness.manager.patchConnection(harness.admin, connection.id, { enabled: false });
    gate.resolve();
    await assert.rejects(pending, (error: MediaServerError) => ["stale-generation", "not-found"].includes(error.code));
    assert.equal(harness.server.originalCancelled, 1, "the body was cancelled, not handed over");
  });
});

test("openOriginal refuses a revoked preflight without touching the transport", async () => {
  await withHarness(async (harness) => {
    const { connection, library } = await seedPlayable(harness);
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const gate = deferred();
    harness.server.nudge = { op: "versions", wait: gate.promise, entered };
    const ref = refFor(harness, connection.id, library.id, "m1", "v1");
    const pending = harness.manager.openOriginal(harness.admin, ref, { method: "GET" });
    await reached;
    await harness.manager.patchConnection(harness.admin, connection.id, { enabled: false });
    gate.resolve();
    await assert.rejects(pending, (error: MediaServerError) => ["stale-generation", "not-found"].includes(error.code));
    assert.equal(harness.server.originalCalls, 0, "no bytes were requested");
  });
});

test("a 401 from the original transport invalidates the connection and notifies the invalidator", async () => {
  await withHarness(async (harness) => {
    const { connection, library } = await seedPlayable(harness);
    const scopes: unknown[] = [];
    harness.manager.setContentInvalidator(async (scope) => { scopes.push(scope); });
    harness.server.original = { error: new MediaServerError("authentication-required", "reauthentication required") };
    const ref = refFor(harness, connection.id, library.id, "m1", "v1");
    await assert.rejects(harness.manager.openOriginal(harness.admin, ref, { method: "GET" }), { code: "authentication-required" });
    assert.deepEqual(scopes, [{ connectionId: connection.id }]);
    const view = await harness.manager.listConnections(harness.admin);
    assert.equal(view.connections[0]!.status, "reauthentication-required");
  });
});

test("the content invalidator is registered once and awaited for scoped writes", async () => {
  await withHarness(async (harness) => {
    const { connection, library } = await seedPlayable(harness);
    const scopes: unknown[] = [];
    harness.manager.setContentInvalidator(async (scope) => { scopes.push(scope); });
    assert.throws(() => harness.manager.setContentInvalidator(async () => undefined), /already registered/);
    await harness.manager.patchConnection(harness.admin, connection.id, { enabled: false });
    assert.deepEqual(scopes, [{ connectionId: connection.id }]);
    await harness.manager.patchConnection(harness.admin, connection.id, { name: "Renamed" });
    assert.equal(scopes.length, 1, "a rename does not stop playback");
    await harness.manager.patchLibrary(harness.admin, library.id, { allowedUsers: [bob.id] });
    assert.equal(scopes.length, 1, "adding a grant does not interrupt existing viewers");
    await harness.manager.patchLibrary(harness.admin, library.id, { allowedUsers: [] });
    assert.deepEqual(scopes.at(-1), { libraryId: library.id, userId: bob.id });
  });
});

test("a runtime installed by a concurrent read during a reauthentication is closed, not orphaned", async () => {
  await withHarness(async (harness) => {
    const { connection, library } = await seedPlayable(harness);
    const gate = deferred();
    const realRemove = harness.vault.remove.bind(harness.vault);
    let held = false;
    (harness.vault as unknown as { remove(ref: string): Promise<void> }).remove = async (ref: string) => {
      if (!held) { held = true; await gate.promise; }
      return realRemove(ref);
    };
    const reauth = harness.manager.reauthenticate(harness.admin, connection.id, { username: "reader", password: "reader-password" });
    await until(() => harness.store.mediaConnections()[0]?.generation === 1);
    // Calling this installs the new generation's runtime before it awaits the vault read.
    const read = harness.manager.discoverLibraries(harness.admin, connection.id);
    gate.resolve();
    await read;
    await reauth;
    // The old runtime was closed by the generation change, the concurrent one by the replacement.
    assert.equal(harness.server.closed, 2, "the runtime a concurrent read installed was closed");
    assert.equal((await harness.vault.references()).length, 1, "the secret vault was not disturbed");
  });
});

/** A library whose snapshot and detail reads agree, so a match can be proved and then moved. */
const seedMatchLibrary = async (harness: Harness, items: ProviderItem[]) => {
  const connection = await connect(harness);
  harness.server.libraries.push({ id: "lib-1", name: "Library lib-1", type: "mixed" });
  harness.server.items["lib-1"] = items;
  harness.server.catalogue = [...harness.server.catalogue, ...items];
  for (const item of items) {
    harness.server.detailOf[item.id] = item;
    harness.server.ancestorsOf[item.id] = ["lib-1"];
    if (item.seriesId !== undefined) {
      harness.server.directories[item.seriesId] ??= [];
      harness.server.directories[item.seriesId].push(item);
    }
  }
  const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" });
  return { connection, library };
};

/** The bytes one artwork response carries, so a streaming answer reads like an asset did. */
const imageBytes = async (response: Response): Promise<number[]> => [...new Uint8Array(await response.arrayBuffer())];

test("matchingItems proves each candidate and drops one whose metadata moved", async () => {
  await withHarness(async (harness) => {
    const { library } = await seedMatchLibrary(harness, [
      { id: "m1", name: "Alien", type: "movie", providerIds: { imdb: "tt1" } },
      { id: "m2", name: "Aliens", type: "movie", providerIds: { imdb: "tt2" } },
      { id: "m3", name: "Alien", type: "movie", providerIds: { imdb: "tt1", tmdb: "3" } },
    ]);
    assert.deepEqual((await harness.manager.matchingItems(harness.admin, library.id, "movie", "tt1")).map((item) => item.id), ["m1", "m3"], "an exact id matches every legitimate copy");
    assert.deepEqual(await harness.manager.matchingItems(harness.admin, library.id, "movie", "NotAnId"), [], "an unsupported id is an empty answer, not an error");
    assert.deepEqual(await harness.manager.matchingItems(harness.admin, library.id, "series", "tt1"), [], "a series id without an episode number names nothing");
    // The snapshot still carries tt1, but the fresh detail now disagrees: nothing matches.
    harness.server.detailOf["m1"] = { id: "m1", name: "Alien", type: "movie", providerIds: { imdb: "tt9" } };
    assert.deepEqual((await harness.manager.matchingItems(harness.admin, library.id, "movie", "tt1")).map((item) => item.id), ["m3"], "only the copy whose metadata still agrees survives");
  });
});

test("matchingItems resolves an episode only through a proven series parent and a single range", async () => {
  await withHarness(async (harness) => {
    const show: ProviderItem = { id: "show", name: "Show", type: "series", providerIds: { imdb: "tt1" } };
    const { library } = await seedMatchLibrary(harness, [
      show,
      { id: "e1", name: "E1", type: "episode", seriesId: "show", season: 1, episode: 2, providerIds: {} },
      { id: "multi", name: "Multi", type: "episode", seriesId: "show", season: 1, episode: 4, episodeEnd: 5, providerIds: {} },
    ]);
    assert.deepEqual((await harness.manager.matchingItems(harness.admin, library.id, "series", "tt1:1:2")).map((item) => item.id), ["e1"]);
    assert.deepEqual((await harness.manager.matchingItems(harness.admin, library.id, "series", "tt1:1:4")).map((item) => item.id), ["multi"], "an episode number inside a file's own double-episode range matches");
    assert.deepEqual((await harness.manager.matchingItems(harness.admin, library.id, "series", "tt1:1:5")).map((item) => item.id), ["multi"], "both numbers a double-episode file spans match");
    harness.server.detailOf["show"] = { id: "show", name: "Show", type: "series", providerIds: { imdb: "tt9" } };
    assert.deepEqual(await harness.manager.matchingItems(harness.admin, library.id, "series", "tt1:1:2"), [], "the series proof is re-read, never trusted from the match page");
  });
});

test("matchedVersions returns the verified versions and bounds the stream budget", async () => {
  await withHarness(async (harness) => {
    const { library } = await seedMatchLibrary(harness, [
      { id: "m1", name: "Alien", type: "movie", providerIds: { imdb: "tt1" } },
    ]);
    harness.server.versionsOf["m1"] = [{ id: "v1", name: "1080p" }, { id: "v2", name: "720p" }];
    const results = await harness.manager.matchedVersions(harness.admin, library.id, "movie", "tt1");
    assert.deepEqual(results.map((entry) => entry.item.id), ["m1"]);
    assert.deepEqual(results[0]!.versions.map((version) => version.id), ["v1", "v2"]);
    const many = Array.from({ length: 201 }, (_value, index) => ({ id: `v${index}` }));
    harness.server.versionsOf["m1"] = many;
    await assert.rejects(harness.manager.matchedVersions(harness.admin, library.id, "movie", "tt1"), { code: "response-too-large" });
  });
});

test("an id this app cannot match is answered before any upstream call", async () => {
  await withHarness(async (harness) => {
    const { library } = await seedMatchLibrary(harness, [
      { id: "m1", name: "Alien", type: "movie", providerIds: { imdb: "tt1" } },
    ]);
    const before = harness.server.calls.length;
    assert.deepEqual(await harness.manager.matchingItems(harness.admin, library.id, "movie", "NotAnId"), []);
    assert.deepEqual(await harness.manager.matchedVersions(harness.admin, library.id, "series", "tt1"), [], "a series id without an episode number names nothing");
    assert.equal(harness.server.calls.length, before, "an id that names nothing reads nothing upstream");
  });
});

test("matchedVersions returns an episode whose series still carries the matched id", async () => {
  await withHarness(async (harness) => {
    const { library } = await seedMatchLibrary(harness, [
      { id: "showA", name: "Show A", type: "series", providerIds: { imdb: "tt1" } },
      { id: "e1", name: "E1", type: "episode", seriesId: "showA", season: 1, episode: 2, providerIds: {} },
    ]);
    harness.server.versionsOf["e1"] = [{ id: "v1", name: "1080p" }];
    const results = await harness.manager.matchedVersions(harness.admin, library.id, "series", "tt1:1:2");
    assert.deepEqual(results.map((entry) => entry.item.id), ["e1"]);
    assert.deepEqual(results[0]!.versions.map((version) => version.id), ["v1"]);
  });
});

test("matchedVersions drops an episode that moved to another series while its versions were read", async () => {
  await withHarness(async (harness) => {
    const { library } = await seedMatchLibrary(harness, [
      { id: "showA", name: "Show A", type: "series", providerIds: { imdb: "tt1" } },
      { id: "showB", name: "Show B", type: "series", providerIds: { imdb: "tt2" } },
      { id: "e1", name: "E1", type: "episode", seriesId: "showA", season: 1, episode: 2, providerIds: {} },
    ]);
    // The provider moves the episode to a different series, keeping its numbering, after the
    // match proved the first parent: the second read of the episode no longer names it.
    const first = harness.server.detailOf["e1"]!;
    let reads = 0;
    Object.defineProperty(harness.server.detailOf, "e1", {
      configurable: true,
      get: () => (reads++ === 0 ? first : { ...first, seriesId: "showB" }),
    });
    harness.server.versionsOf["e1"] = [{ id: "v1", name: "1080p" }];
    assert.deepEqual(await harness.manager.matchedVersions(harness.admin, library.id, "series", "tt1:1:2"), [],
      "an episode that left the matched series mints nothing");
  });
});

test("matchedVersions drops an episode whose series ids moved while its versions were read", async () => {
  await withHarness(async (harness) => {
    const { library } = await seedMatchLibrary(harness, [
      { id: "showA", name: "Show A", type: "series", providerIds: { imdb: "tt1" } },
      { id: "e1", name: "E1", type: "episode", seriesId: "showA", season: 1, episode: 2, providerIds: {} },
    ]);
    // The parent proof is repeated after the versions read: a series whose ids moved in
    // between no longer names this catalogue id.
    Object.defineProperty(harness.server, "versionsOf", {
      configurable: true,
      get: () => {
        harness.server.detailOf["showA"] = { ...harness.server.detailOf["showA"]!, providerIds: { imdb: "tt9" } };
        return { e1: [{ id: "v1", name: "1080p" }] };
      },
    });
    assert.deepEqual(await harness.manager.matchedVersions(harness.admin, library.id, "series", "tt1:1:2"), []);
  });
});

test("verifyLibrary proves the live session and refuses a disabled connection", async () => {
  await withHarness(async (harness) => {
    const { connection, library } = await seedMatchLibrary(harness, [
      { id: "m1", name: "Alien", type: "movie", providerIds: {} },
    ]);
    await harness.manager.verifyLibrary(harness.admin, library.id);
    await harness.manager.patchConnection(harness.admin, connection.id, { enabled: false });
    await assert.rejects(harness.manager.verifyLibrary(harness.admin, library.id), { code: "not-found" });
  });
});

test("readArtwork streams bounded bytes for a fixed role and refuses other roles and items", async () => {
  await withHarness(async (harness) => {
    const { library } = await seedMatchLibrary(harness, [
      { id: "m1", name: "Alien", type: "movie", providerIds: {} },
      { id: "show", name: "Show", type: "series", providerIds: {} },
    ]);
    harness.server.artwork = { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" };
    const response = await harness.manager.readArtwork(harness.admin, library.id, "show", "Backdrop");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("cache-control"), "private, no-cache");
    assert.deepEqual(await imageBytes(response), [1, 2, 3]);
    assert.deepEqual(harness.server.artworkRequests.at(-1), { itemId: "show", imageType: "Backdrop" });
    await assert.rejects(harness.manager.readArtwork(harness.admin, library.id, "m1", "Logo"), { code: "invalid-input" });
    await assert.rejects(harness.manager.readArtwork(harness.admin, library.id, "missing", "Primary"), { code: "not-found" });
  });
});

test("an image burst never consumes the metadata lane, so it cannot delay a browse or the playback guard", async () => {
  await withHarness(async (harness) => {
    const library = await directoryLibrary(harness, "music");
    harness.server.directories["music"] = [artMovie("a1"), artMovie("a2"), artMovie("a3")];
    harness.server.artwork = { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" };
    await harness.manager.browseDirectory(harness.admin, library.id, {});
    const connection = harness.store.mediaConnections()[0]!;

    // Occupy every metadata network slot: an artwork read must not need one.
    const lane = harness.manager as unknown as { runtimes: Map<string, unknown>; net: (runtime: unknown, signal: AbortSignal, work: () => Promise<void>) => Promise<void> };
    const runtime = lane.runtimes.get(connection.id);
    const held = deferred();
    const signal = new AbortController().signal;
    let active = 0;
    const blockers = Array.from({ length: 4 }, () => lane.net(runtime, signal, async () => { active += 1; await held.promise; }));
    await until(() => active === 4);
    const before = harness.server.calls.length;
    const reads = ["a1", "a2", "a3"].map((id) => harness.manager.readArtwork(harness.admin, library.id, id, "Primary"));
    const responses = await Promise.all(reads);
    assert.ok(responses.every((response) => response.status === 200), "every image is served while the metadata lane is saturated");
    assert.equal(harness.server.calls.slice(before).filter((call) => call === "artwork").length, 3, "each image took the image lane");
    assert.equal(harness.server.calls.slice(before).filter((call) => call === "directory" || call === "detail" || call === "info").length, 0, "no metadata call was needed for a page's own ids");
    held.resolve();
    await Promise.all(blockers);
  });
});

test("session facts expire after thirty seconds and a 401 drops them at once", async () => {
  let now = 1_800_000_000_000;
  await withHarness(async (harness) => {
    const { connection, library } = await seedMatchLibrary(harness, [movie("m1", "Alien")]);
    harness.server.directories["lib-1"] = [movie("m1", "Alien")];
    await harness.manager.browseDirectory(harness.admin, library.id, {});
    assert.equal(harness.server.calls.filter((call) => call === "info").length, 1, "the first read proves the identity once");
    await harness.manager.browseDirectory(harness.admin, library.id, {});
    assert.equal(harness.server.calls.filter((call) => call === "info").length, 1, "a second read inside the window reuses the cached facts");
    now += 31_000;
    await harness.manager.browseDirectory(harness.admin, library.id, {});
    assert.equal(harness.server.calls.filter((call) => call === "info").length, 2, "past thirty seconds the facts are proved again");
    harness.server.errors = { info: new MediaServerError("authentication-required", "revoked") };
    now += 31_000;
    await assert.rejects(harness.manager.browseDirectory(harness.admin, library.id, {}), { code: "authentication-required" });
    assert.equal((await harness.manager.listConnections(harness.admin)).connections.find((entry) => entry.id === connection.id)?.status, "reauthentication-required", "a 401 marks the connection for a fresh sign-in");
  }, { clock: () => now });
});
test("a burst of distinct artwork reads shares one live session and still proves every item", async () => {
  await withHarness(async (harness) => {
    const items = ["a1", "a2", "a3", "a4"].map((id) => artMovie(id));
    const { connection, library } = await seedMatchLibrary(harness, items);
    harness.server.artwork = { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" };
    dropRuntime(harness, connection.id);
    const before = harness.server.calls.length;
    const burst = () => harness.server.calls.slice(before);
    const held = deferred();
    const entered = deferred();
    harness.server.nudge = { op: "info", wait: held.promise, entered: () => entered.resolve() };
    const running = items.map((item) => harness.manager.readArtwork(harness.admin, library.id, item.id, "Primary"));
    await entered.promise;
    await until(() => subscribersOf(harness, connection.id, "identity") === items.length);
    assert.equal(burst().filter((call) => call === "info").length, 1, "one identity read stands in for the whole burst");
    assert.equal(burst().filter((call) => call === "user").length, 0, "the account read waits behind the shared identity");
    held.resolve();
    harness.server.nudge = undefined;
    const responses = await Promise.all(running);
    assert.equal(responses.length, items.length, "every distinct artwork is served");
    assert.equal(inflightReads(harness, connection.id).size, 0, "no settled read is left behind");
    assert.equal(burst().filter((call) => call === "info").length, 1, "identity is proved once");
    assert.equal(burst().filter((call) => call === "user").length, 1, "the account is read once");
    assert.equal(burst().filter((call) => call === "views").length, 1, "the library list is read once");
    assert.equal(burst().filter((call) => call === "detail").length, items.length, "each artwork still proves its own item");
    assert.equal(burst().filter((call) => call === "artwork").length, items.length, "each artwork is fetched");
  });
});

test("one subscriber's abort never cancels another caller's shared read", async () => {
  await withHarness(async (harness) => {
    const items = ["a1", "a2"].map((id) => artMovie(id));
    const { connection, library } = await seedMatchLibrary(harness, items);
    harness.server.artwork = { bytes: new Uint8Array([7]), contentType: "image/png" };
    dropRuntime(harness, connection.id);
    const before = harness.server.calls.length;
    const held = deferred();
    const entered = deferred();
    harness.server.nudge = { op: "info", wait: held.promise, entered: () => entered.resolve() };
    const controller = new AbortController();
    const aborted = harness.manager.readArtwork(harness.admin, library.id, "a1", "Primary", controller.signal);
    const other = harness.manager.readArtwork(harness.admin, library.id, "a2", "Primary");
    await entered.promise;
    await until(() => subscribersOf(harness, connection.id, "identity") === items.length);
    assert.equal(subscribersOf(harness, connection.id, "identity"), 2, "both callers share the read");
    controller.abort();
    await assert.rejects(aborted, { code: "cancelled" });
    assert.equal(subscribersOf(harness, connection.id, "identity"), 1, "the other subscriber is untouched");
    held.resolve();
    harness.server.nudge = undefined;
    const response = await other;
    assert.equal(response.headers.get("content-type"), "image/png", "the remaining subscriber still completes");
    assert.equal(harness.server.calls.slice(before).filter((call) => call === "info").length, 1, "the shared read was never restarted");
  });
});

test("a revocation during a shared read refuses only the revoked caller", async () => {
  await withHarness(async (harness) => {
    const items = ["a1", "a2"].map((id) => artMovie(id));
    const { connection, library } = await seedMatchLibrary(harness, items);
    harness.server.artwork = { bytes: new Uint8Array([7]), contentType: "image/png" };
    dropRuntime(harness, connection.id);
    const held = deferred();
    const entered = deferred();
    harness.server.nudge = { op: "info", wait: held.promise, entered: () => entered.resolve() };
    let revoked = false;
    const doomed: MediaServerAuthority = {
      actor: { id: ADA, secret: admin.secret },
      assertCurrent: () => { if (revoked) throw new ResourceError(401, "AUTH_REQUIRED"); },
    };
    const failing = harness.manager.readArtwork(doomed, library.id, "a1", "Primary");
    const other = harness.manager.readArtwork(harness.admin, library.id, "a2", "Primary");
    await entered.promise;
    await until(() => subscribersOf(harness, connection.id, "identity") === items.length);
    revoked = true;
    held.resolve();
    harness.server.nudge = undefined;
    await assert.rejects(failing, ResourceError, "a revoked caller is refused after the shared await");
    const response = await other;
    assert.equal(response.headers.get("content-type"), "image/png", "the other caller still completes");
    assert.equal(harness.server.artworkRequests.length, 1, "the revoked caller fetched no artwork bytes");
  });
});

test("the last subscriber leaving cancels the shared read and a later call rereads", async () => {
  await withHarness(async (harness) => {
    const { connection, library } = await seedMatchLibrary(harness, [artMovie("a1")]);
    harness.server.artwork = { bytes: new Uint8Array([7]), contentType: "image/png" };
    dropRuntime(harness, connection.id);
    const before = harness.server.calls.length;
    const held = deferred();
    const entered = deferred();
    harness.server.nudge = { op: "info", wait: held.promise, entered: () => entered.resolve() };
    const first = new AbortController();
    const second = new AbortController();
    const a = harness.manager.readArtwork(harness.admin, library.id, "a1", "Primary", first.signal);
    const b = harness.manager.readArtwork(harness.admin, library.id, "a1", "Primary", second.signal);
    await entered.promise;
    await until(() => subscribersOf(harness, connection.id, "identity") === 2);
    const entry = inflightReads(harness, connection.id).get("identity");
    assert.equal(entry?.subscribers, 2);
    first.abort();
    second.abort();
    await assert.rejects(a, { code: "cancelled" });
    await assert.rejects(b, { code: "cancelled" });
    assert.equal(entry?.controller.signal.aborted, true, "the shared read was cancelled with the last subscriber");
    assert.equal(inflightReads(harness, connection.id).size, 0, "no settled entry is left behind");
    held.resolve();
    harness.server.nudge = undefined;
    const response = await harness.manager.readArtwork(harness.admin, library.id, "a1", "Primary");
    assert.equal((await imageBytes(response)).length, 1, "a later call re-proves and succeeds");
    assert.equal(harness.server.calls.slice(before).filter((call) => call === "info").length, 2, "the later call performed a fresh read");
  });
});

test("a failed shared read leaves no entry, so the next call re-proves and succeeds", async () => {
  await withHarness(async (harness) => {
    const { connection, library } = await seedMatchLibrary(harness, [artMovie("a1")]);
    harness.server.artwork = { bytes: new Uint8Array([7]), contentType: "image/png" };
    dropRuntime(harness, connection.id);
    harness.server.errors = { info: new MediaServerError("unavailable", "down") };
    await assert.rejects(harness.manager.readArtwork(harness.admin, library.id, "a1", "Primary"), { code: "unavailable" });
    assert.equal(inflightReads(harness, connection.id).size, 0, "the failed read is not cached");
    harness.server.errors = {};
    const response = await harness.manager.readArtwork(harness.admin, library.id, "a1", "Primary");
    assert.equal((await imageBytes(response)).length, 1);
  });
});

test("two connections never share a live-session read", async () => {
  await withHarness(async (harness) => {
    const first = await connect(harness);
    harness.server.accountId = "user-2";
    const second = await connect(harness, { username: "second-reader" });
    harness.server.accountId = "user-1";
    const held = deferred();
    let entered = 0;
    const both = deferred();
    harness.server.nudge = { op: "info", wait: held.promise, entered: () => { entered += 1; if (entered === 2) both.resolve(); } };
    const a = harness.manager.discoverLibraries(harness.admin, first.id);
    const b = harness.manager.discoverLibraries(harness.admin, second.id);
    await both.promise;
    assert.equal(harness.server.calls.filter((call) => call === "info").length, 2, "each connection proves its own identity");
    held.resolve();
    harness.server.nudge = undefined;
    await Promise.allSettled([a, b]);
  });
});

test("upstream starts on one connection are spaced by the configured interval", async () => {
  await withHarness(async (harness) => {
    const library = await directoryLibrary(harness, "music");
    harness.server.directories["music"] = [movie("m1")];
    harness.server.startTimes.length = 0;
    harness.server.calls.length = 0;
    await Promise.all(Array.from({ length: 8 }, () => harness.manager.browseDirectory(harness.admin, library.id, {})));
    const times = harness.server.startTimes;
    assert.ok(times.length >= 6, `enough operations were paced (${times.length})`);
    for (let index = 1; index < times.length; index += 1) {
      const gap = times[index]! - times[index - 1]!;
      assert.ok(gap >= 15, `start ${index} came ${gap}ms after the previous one`);
    }
  }, { networkStartIntervalMs: 30 });
});

test("an idle connection releases no catch-up burst", async () => {
  await withHarness(async (harness) => {
    const library = await directoryLibrary(harness, "music");
    harness.server.directories["music"] = [movie("m1")];
    await new Promise((resolve) => setTimeout(resolve, 120));
    harness.server.startTimes.length = 0;
    const running = Array.from({ length: 4 }, () => harness.manager.browseDirectory(harness.admin, library.id, {}));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(harness.server.startTimes.length <= 1, `no burst inside the first interval (${harness.server.startTimes.length} starts)`);
    await Promise.all(running);
    const times = harness.server.startTimes;
    for (let index = 1; index < times.length; index += 1) {
      assert.ok(times[index]! - times[index - 1]! >= 15, `start ${index} was not spaced`);
    }
  }, { networkStartIntervalMs: 40 });
});

test("a connection's pacing queue refuses a request beyond its 128-waiter bound", async () => {
  await withHarness(async (harness) => {
    // A login is not paced, so the connection is ready before the burst; every burst caller
    // reaches the pacer with its own live-session read because the reads are not shared here.
    const connection = await connect(harness);
    const controllers = Array.from({ length: 200 }, () => new AbortController());
    let refused = 0;
    const outcomes = controllers.map((controller) =>
      harness.manager.discoverLibraries(harness.admin, connection.id, controller.signal).then(() => "ok", (error: unknown) => {
        if (error instanceof MediaServerError && error.code === "busy") refused += 1;
        return error;
      }));
    let settled: PromiseSettledResult<unknown>[] = [];
    try {
      await until(() => pacerQueueLength(harness, connection.id) >= 128 && refused > 0);
      assert.equal(pacerQueueLength(harness, connection.id), 128, "the pacing queue fills to its bound");
    } finally {
      for (const controller of controllers) controller.abort();
      settled = await Promise.allSettled(outcomes);
    }
    assert.ok(
      settled.some((result) => result.status === "fulfilled" && result.value instanceof MediaServerError && result.value.code === "busy"),
      "the arrival beyond the bound is refused",
    );
  }, { networkStartIntervalMs: 100_000, coalesceReads: false });
});

test("readSubtitle proves the exact external index and refuses an original reference", async () => {
  await withHarness(async (harness) => {
    const { connection, library } = await seedMatchLibrary(harness, [
      { id: "m1", name: "Alien", type: "movie", providerIds: {} },
    ]);
    harness.server.versionsOf["m1"] = [{ id: "v1", name: "1080p", externalSubtitles: [{ index: 2, language: "eng" }] }];
    harness.server.asset = { bytes: new TextEncoder().encode("1\n00:00:01,000 --> 00:00:02,000\nHi\n"), contentType: "application/x-subrip" };
    const ref: RemoteContentRef = {
      provider: "jellyfin", serverId: "server-1", accountId: "user-1", itemId: "m1",
      connectionId: connection.id, libraryId: library.id, generation: connection.generation, mediaSourceId: "v1", subtitleIndex: 2,
      owner: { userId: ADA, sid: "sid-1", expiresAt: Date.now() + 60_000, secretStamp: remoteSecretStamp(admin.secret) },
    };
    const asset = await harness.manager.readSubtitle(harness.admin, ref);
    assert.equal(new TextDecoder().decode(asset.bytes).includes("-->"), true);
    assert.deepEqual(harness.server.assetRequests.at(-1), { kind: "subtitle", itemId: "m1", mediaSourceId: "v1", index: 2 });
    await assert.rejects(harness.manager.readSubtitle(harness.admin, { ...ref, subtitleIndex: 3 }), { code: "not-found" }, "an index the provider no longer lists is refused");
    await assert.rejects(harness.manager.readSubtitle(harness.admin, { ...ref, subtitleIndex: undefined }), { code: "not-found" }, "an original reference is not a subtitle");
    await assert.rejects(harness.manager.revalidateOriginal(harness.admin, ref), { code: "not-found" }, "a subtitle reference never revalidates as media");
    await assert.rejects(harness.manager.openOriginal(harness.admin, ref, { method: "GET" }), { code: "not-found" });
  });
});

/** One canonical stored history row, as the personal module would have written it. */
const historyRow = (itemId: string, remoteLibraryId: string): Record<string, unknown> => ({
  key: remoteProgressKey({ provider: "jellyfin", serverId: "server-1", accountId: "user-1", itemId }),
  provider: "jellyfin", serverId: "server-1", accountId: "user-1", itemId, remoteLibraryId,
  type: "movie", name: "Alien", position: 10, duration: 100, favorite: false, watched: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const seedHistory = (harness: Harness, userId: string, rows: Record<string, unknown>) =>
  harness.store.update((state) => {
    const data = state.userData?.[userId];
    if (data) data.remoteMedia = rows;
  });

const storedRow = (harness: Harness, userId: string, itemId: string, remoteLibraryId: string) =>
  (harness.store.userData(userId).remoteMedia ?? {})[historyRow(itemId, remoteLibraryId).key as string] as
    { orphanedAt?: string; position?: number } | undefined;

test("removing a connection keeps the stored history until it is asked to forget it", async () => {
  await withHarness(async (harness) => {
    const { connection } = await seedMatchLibrary(harness, [movie("m1")]);
    await seedHistory(harness, ADA, { [historyRow("m1", "lib-1").key as string]: historyRow("m1", "lib-1") });
    await harness.manager.removeConnection(harness.admin, connection.id);
    assert.equal(typeof storedRow(harness, ADA, "m1", "lib-1")?.orphanedAt, "string", "the row stays, invisibly, with the thirty days running");
    assert.equal(harness.store.mediaConnections().length, 0);
  });
  await withHarness(async (harness) => {
    const { connection } = await seedMatchLibrary(harness, [movie("m1")]);
    await seedHistory(harness, ADA, { [historyRow("m1", "lib-1").key as string]: historyRow("m1", "lib-1") });
    await harness.manager.removeConnection(harness.admin, connection.id, undefined, { forget: true });
    assert.equal(storedRow(harness, ADA, "m1", "lib-1"), undefined, "forget deletes it at once");
  });
});

test("a removal takes only its own upstream library and refuses an option it does not know", async () => {
  await withHarness(async (harness) => {
    const { connection } = await seedMatchLibrary(harness, [movie("m1")]);
    harness.server.libraries.push({ id: "lib-2", name: "Library lib-2", type: "movie" });
    const second = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-2" });
    const first = harness.store.remoteLibraries().find((library) => library.remoteId === "lib-1")!;
    await seedHistory(harness, ADA, {
      [historyRow("m1", "lib-1").key as string]: historyRow("m1", "lib-1"),
      [historyRow("m2", "lib-2").key as string]: historyRow("m2", "lib-2"),
    });
    await harness.manager.deleteLibrary(harness.admin, first.id);
    assert.equal(typeof storedRow(harness, ADA, "m1", "lib-1")?.orphanedAt, "string", "the removed library's rows start their countdown");
    assert.equal(storedRow(harness, ADA, "m2", "lib-2")?.orphanedAt, undefined, "a library still attached is untouched");
    await assert.rejects(harness.manager.deleteLibrary(harness.admin, second.id, undefined, { nope: true }), { code: "invalid-input" });
    await assert.rejects(harness.manager.deleteLibrary(harness.admin, second.id, undefined, { forget: "yes" }), { code: "invalid-input" });
    assert.equal(harness.store.remoteLibraries().length, 1, "a refused option changes nothing");
  });
});

test("reattaching the same verified library takes its history back", async () => {
  await withHarness(async (harness) => {
    const { connection } = await seedMatchLibrary(harness, [movie("m1")]);
    const library = harness.store.remoteLibraries()[0]!;
    await seedHistory(harness, ADA, { [historyRow("m1", "lib-1").key as string]: historyRow("m1", "lib-1") });
    await harness.manager.deleteLibrary(harness.admin, library.id);
    assert.equal(typeof storedRow(harness, ADA, "m1", "lib-1")?.orphanedAt, "string");
    await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" });
    const kept = storedRow(harness, ADA, "m1", "lib-1");
    assert.equal(kept?.orphanedAt, undefined, "the countdown is gone");
    assert.equal(kept?.position, 10, "and the row itself is untouched");
  });
});

test("a settings restore replaces the remote configuration in the same write as the settings", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    seedLibrary(harness, "lib-1", [movie("m1")]);
    const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" });
    await harness.manager.patchLibrary(harness.admin, library.id, { allowedUsers: [BOB] });
    const oldRef = harness.store.mediaConnections()[0]!.secretRef as string;
    const bumpedBefore = harness.store.users().find((user) => user.id === BOB)!.permissionsVersion;
    const exported = harness.manager.exportConfiguration(harness.admin);
    const revokedContent: string[] = [];
    harness.manager.setContentInvalidator(async (scope) => { if (scope.connectionId) revokedContent.push(scope.connectionId); });
    let ranMutator = 0;
    let replacementWrite: { connections: number; autoScan: boolean | undefined; queued: string[] } | undefined;
    harness.onWrite((state) => {
      const connections = ((state as { mediaConnections?: unknown[] }).mediaConnections ?? []).length;
      const refs = [...(state.mediaSecretCleanup ?? [])];
      if (connections === 1 && refs.includes(oldRef)) replacementWrite = { connections, autoScan: (state as { settings?: { libraryAutoScan?: boolean } }).settings?.libraryAutoScan, queued: refs };
    });
    await harness.manager.restoreSettingsConfiguration(harness.admin, exported, (state) => {
      ranMutator += 1;
      state.settings.libraryAutoScan = false;
    });
    assert.equal(ranMutator, 1, "the caller's settings mutator ran inside the one update");
    assert.equal(replacementWrite?.connections, 1, "the replacement landed in one write");
    assert.equal(replacementWrite?.autoScan, false, "together with the settings the same file carried");
    assert.equal(harness.store.settings().libraryAutoScan, false);
    const [restored] = harness.store.mediaConnections();
    assert.notEqual(restored!.id, connection.id, "a fresh local handle");
    assert.equal(restored!.enabled, false, "requiring a sign-in again");
    assert.equal(restored!.secretRef, undefined, "and never a credential");
    assert.deepEqual(harness.store.remoteLibraries()[0]!.allowedUsers, [], "grants never come out of a file");
    assert.equal(replacementWrite?.queued.includes(oldRef), true, "the replaced credential was queued durably for deletion");
    assert.equal(revokedContent.includes(connection.id), true, "what ran on the replaced connection was torn down");
    assert.equal(harness.store.users().find((user) => user.id === BOB)!.permissionsVersion, bumpedBefore + 1, "the account that lost its grant is told");
  });
});

test("a settings restore that is refused before its write changes nothing", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    seedLibrary(harness, "lib-1", [movie("m1")]);
    const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" });
    const exported = harness.manager.exportConfiguration(harness.admin);
    const snapshot = () => JSON.stringify({ connections: harness.store.mediaConnections(), libraries: harness.store.remoteLibraries() });
    const before = snapshot();
    const dangling = { version: 1, connections: [], libraries: [{ ...exported.libraries[0], connectionId: "mconn_" + "0".repeat(32) }] };
    await assert.rejects(harness.manager.restoreSettingsConfiguration(harness.admin, dangling, () => { throw new Error("must not run"); }), { code: "invalid-input" });
    assert.equal(snapshot(), before, "a configuration that does not stand on its own is refused before anything is written");
    harness.revokeBeforeNextWrite();
    await assert.rejects(harness.manager.restoreSettingsConfiguration(harness.admin, exported, () => undefined), ResourceError);
    assert.equal(snapshot(), before, "a revoked session writes nothing");
    assert.equal(harness.store.remoteLibraries()[0]!.id, library.id);
  });
});

test("startup and the periodic sweep expire orphaned history and mark a detached row once", async () => {
  const now = Date.parse("2026-06-01T00:00:00.000Z");
  const thirtyOneDaysAgo = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();
  const connection = {
    id: `mconn_${"1".repeat(32)}`, provider: "jellyfin", name: "Media", baseUrl: "http://media.example",
    allowLan: false, allowLoopback: false, serverId: "server-1", accountId: "user-1", enabled: true, generation: 0,
    addedAt: "2026-01-01T00:00:00.000Z",
  };
  const library = {
    id: `rlib_${"2".repeat(32)}`, connectionId: connection.id, remoteId: "lib-1", name: "Library lib-1", type: "movie",
    enabled: true, order: 0, allowedUsers: [], showOnHome: true, showInContinueWatching: true,
  };
  const rows = {
    [historyRow("expired", "lib-1").key as string]: { ...historyRow("expired", "lib-1"), orphanedAt: thirtyOneDaysAgo },
    [historyRow("legacy", "lib-gone").key as string]: historyRow("legacy", "lib-gone"),
    [historyRow("live", "lib-1").key as string]: historyRow("live", "lib-1"),
  };
  const harness = await mount({ users: [admin], remoteMedia: { [ADA]: rows }, connections: [connection], libraries: [library], cleanupIntervalMs: 20 });
  try {
    assert.deepEqual(Object.keys(harness.store.userData(ADA).remoteMedia ?? {}).sort(),
      [historyRow("legacy", "lib-gone").key, historyRow("live", "lib-1").key].sort(),
      "the expired row is gone and the legacy one survives its first marking");
    assert.equal(typeof storedRow(harness, ADA, "legacy", "lib-gone")?.orphanedAt, "string", "a detached row starts its countdown now");
    assert.equal(storedRow(harness, ADA, "live", "lib-1")?.orphanedAt, undefined, "an attached row is never marked");
    const writes = harness.writes();
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(harness.writes(), writes, "a sweep with nothing to do never rewrites the state");
  } finally {
    await harness.close();
  }
});

test("settings restore atomically recovers matching history and marks removed attachments", async () => {
  await withHarness(async (harness) => {
    await seedMatchLibrary(harness, [movie("m1")]);
    const exported = harness.manager.exportConfiguration(harness.admin);
    const recent = new Date(Date.now() - 60_000).toISOString();
    const expired = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const rows = [
      { ...historyRow("retained", "lib-1"), orphanedAt: recent },
      historyRow("detached", "lib-2"),
      { ...historyRow("expired", "lib-1"), orphanedAt: expired },
    ];
    await seedHistory(harness, ADA, Object.fromEntries(rows.map((row) => [row.key as string, row])));
    let observed = false;
    harness.onWrite(() => {
      if (harness.store.mediaConnections()[0]?.enabled !== false) return;
      observed = true;
      assert.equal(storedRow(harness, ADA, "retained", "lib-1")?.orphanedAt, undefined);
      assert.equal(typeof storedRow(harness, ADA, "detached", "lib-2")?.orphanedAt, "string");
      assert.equal(storedRow(harness, ADA, "expired", "lib-1"), undefined);
    });
    await harness.manager.restoreSettingsConfiguration(harness.admin, exported, () => undefined);
    assert.equal(observed, true);
  });
});

const directoryLibrary = async (harness: Harness, remoteId: string, type: "movie" | "series" | "mixed" = "mixed", move: Record<string, unknown> = {}) => {
  const connection = harness.store.mediaConnections()[0] ?? await connect(harness);
  harness.server.libraries.push({ id: remoteId, name: `Library ${remoteId}`, type });
  return harness.manager.attachLibrary(harness.admin, connection.id, { remoteId, ...move });
};

test("browseDirectory reads one provider page for the root and never touches the snapshot index", async () => {
  await withHarness(async (harness) => {
    const library = await directoryLibrary(harness, "music");
    harness.server.directories["music"] = [folder("f1"), movie("m1", "Alien"), movie("m2", "Aliens")];
    let snapshotCalls = 0;
    (harness.index as unknown as { resolve: () => Promise<never> }).resolve = async () => {
      snapshotCalls += 1;
      throw new Error("the native browse must not use the snapshot index");
    };

    const page = await harness.manager.browseDirectory(harness.admin, library.id, {});
    assert.equal(snapshotCalls, 0, "the native browse never asks for a snapshot");
    assert.deepEqual(page.items.map((item) => item.id), ["f1", "m1", "m2"]);
    assert.equal(page.items[0].type, "folder");
    assert.equal(page.items[0].poster, `/api/remote-libraries/${library.id}/items/f1/artwork/Primary`);
    assert.equal(page.total, 3);
    assert.equal(page.stale, false);
    assert.equal(page.cursor, undefined);
    assert.deepEqual(page.capabilities, { rename: false, move: false, delete: false, identify: false, writeArtwork: false, downloadToLibrary: false, downloadToDevice: false });
    assert.equal(harness.server.calls.includes("items"), false, "the recursive items operation is not used");
    assert.equal(harness.server.directoryCalls.at(-1)!.options.limit, 60, "the folder default page size");
    assert.equal(harness.server.directoryCalls.at(-1)!.options.mode, "folders", "a mixed library defaults to folders");
  });
});

test("browseDirectory pages a nested folder and binds the cursor to every axis", async () => {
  await withHarness(async (harness) => {
    const library = await directoryLibrary(harness, "music");
    harness.server.directories["music"] = [folder("seasonA")];
    harness.server.detailOf["seasonA"] = folder("seasonA", { parentId: "music" });
    harness.server.ancestorsOf["seasonA"] = ["music"];
    harness.server.directories["seasonA"] = [movie("m1"), movie("m2"), movie("m3")];

    const first = await harness.manager.browseDirectory(harness.admin, library.id, { parentId: "seasonA", limit: "2" });
    assert.deepEqual(first.items.map((item) => item.id), ["m1", "m2"]);
    assert.equal(first.total, 3);
    assert.ok(first.cursor);
    const second = await harness.manager.browseDirectory(harness.admin, library.id, { parentId: "seasonA", limit: "2", cursor: first.cursor });
    assert.deepEqual(second.items.map((item) => item.id), ["m3"]);
    assert.equal(second.cursor, undefined);

    const providerCursorBefore = harness.server.directoryCalls.length;
    for (const mismatch of [{ parentId: "music" }, { sort: "added" }, { search: "x" }, { mode: "titles" }, { type: "movie" }]) {
      await assert.rejects(
        harness.manager.browseDirectory(harness.admin, library.id, { parentId: "seasonA", limit: "2", cursor: first.cursor, ...mismatch }),
        { code: "stale-generation" },
        JSON.stringify(mismatch),
      );
    }
    assert.equal(harness.server.directoryCalls.length, providerCursorBefore, "a mismatched cursor is refused before any provider call");

    await harness.manager.patchLibrary(harness.admin, library.id, { allowedUsers: [BOB] });
    await assert.rejects(harness.manager.browseDirectory(harness.bob, library.id, { parentId: "seasonA", limit: "2", cursor: first.cursor }), { code: "stale-generation" });

    await assert.rejects(harness.manager.browseDirectory(harness.admin, library.id, { mode: "grid" }), { code: "invalid-input" });
    await assert.rejects(harness.manager.browseDirectory(harness.admin, library.id, { sort: "date" }), { code: "invalid-input" });
    await assert.rejects(harness.manager.browseDirectory(harness.admin, library.id, { type: "folder" }), { code: "invalid-input" });
    await assert.rejects(harness.manager.browseDirectory(harness.admin, library.id, { unknown: "1" }), { code: "invalid-input" });
  });
});

test("browseDirectory refuses a nested parent that is not inside the granted library or is not browsable", async () => {
  await withHarness(async (harness) => {
    const library = await directoryLibrary(harness, "music");
    harness.server.detailOf["outside"] = folder("outside");
    harness.server.ancestorsOf["outside"] = ["other-library"];
    await assert.rejects(harness.manager.browseDirectory(harness.admin, library.id, { parentId: "outside" }), { code: "not-found" });

    harness.server.detailOf["movie-parent"] = movie("movie-parent");
    harness.server.ancestorsOf["movie-parent"] = ["music"];
    await assert.rejects(harness.manager.browseDirectory(harness.admin, library.id, { parentId: "movie-parent" }), { code: "invalid-input" });
  });
});

test("a grant revoked while a browse is waiting is refused before the page is returned", async () => {
  await withHarness(async (harness) => {
    const library = await directoryLibrary(harness, "music");
    harness.server.directories["music"] = [movie("m1")];
    await harness.manager.patchLibrary(harness.admin, library.id, { allowedUsers: [BOB] });

    const held = (() => { let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; }); return { wait, release }; })();
    const entered = (() => { let signal!: () => void; const promise = new Promise<void>((resolve) => { signal = resolve; }); return { promise, signal }; })();
    harness.server.nudge = { op: "directory", wait: held.wait, entered: entered.signal };
    const browsing = harness.manager.browseDirectory(harness.bob, library.id, {});
    await entered.promise;
    await harness.manager.patchLibrary(harness.admin, library.id, { allowedUsers: [] });
    held.release();
    harness.server.nudge = undefined;
    await assert.rejects(browsing, { code: "not-found" });
  });
});

test("a folder is navigable and its artwork is served, but it is never playable", async () => {
  await withHarness(async (harness) => {
    const library = await directoryLibrary(harness, "music");
    harness.server.directories["music"] = [folder("f1")];
    harness.server.detailOf["f1"] = folder("f1");
    harness.server.ancestorsOf["f1"] = ["music"];
    harness.server.artwork = { bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xdb]), contentType: "image/jpeg" };

    const detail = await harness.manager.itemDetail(harness.admin, library.id, "f1");
    assert.equal(detail.item.type, "folder");
    const response = await harness.manager.readArtwork(harness.admin, library.id, "f1", "Primary");
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    await assert.rejects(harness.manager.itemVersions(harness.admin, library.id, "f1"), { code: "invalid-input" });
  });
});

test("previewDirectory prefers owned posters and bounds fallback to one child page", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    harness.server.libraries.push({ id: "music", name: "Music", type: "mixed", primaryImageTag: "root-tag" });
    const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "music" });

    const root = await harness.manager.previewDirectory(harness.admin, library.id);
    assert.deepEqual(root.posters, [`/api/remote-libraries/${library.id}/items/music/artwork/Primary?tag=root-tag`], "a library root's own view image, tagged");
    assert.equal(harness.server.directoryCalls.length, 0, "the root's own poster needs no child page");

    harness.server.detailOf["f1"] = { ...folder("f1"), hasPrimaryImage: true, primaryImageTag: "folder-tag" };
    harness.server.ancestorsOf["f1"] = ["music"];
    const folderPreview = await harness.manager.previewDirectory(harness.admin, library.id, "f1");
    assert.deepEqual(folderPreview.posters, [`/api/remote-libraries/${library.id}/items/f1/artwork/Primary?tag=folder-tag`]);
    assert.equal(harness.server.directoryCalls.length, 0, "a folder's own poster needs no child page");

    harness.server.detailOf["f2"] = { ...folder("f2"), hasPrimaryImage: false };
    harness.server.ancestorsOf["f2"] = ["music"];
    harness.server.directories["f2"] = [{ ...folder("child"), hasPrimaryImage: true, primaryImageTag: "child-tag" }, folder("empty")];
    assert.deepEqual((await harness.manager.previewDirectory(harness.admin, library.id, "f2")).posters,
      [`/api/remote-libraries/${library.id}/items/child/artwork/Primary?tag=child-tag`]);
    assert.equal(harness.server.directoryCalls.length, 1, "one child page, without traversing nested folders");
    harness.server.artwork = { bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xdb]), contentType: "image/jpeg" };
    const imagesBefore = harness.server.calls.filter((call) => call === "detail").length;
    const image = await harness.manager.readArtwork(harness.admin, library.id, "child", "Primary");
    await image.arrayBuffer();
    assert.equal(harness.server.calls.filter((call) => call === "detail").length, imagesBefore, "preview rows register image membership");

    harness.server.detailOf["s1"] = { id: "s1", name: "S1", type: "season", providerIds: {}, primaryImageTag: "season-tag" };
    harness.server.ancestorsOf["s1"] = ["music"];
    assert.deepEqual((await harness.manager.previewDirectory(harness.admin, library.id, "s1")).posters, [], "a season never shows a mosaic");

    const off = await directoryLibrary(harness, "music-2", "mixed", { mosaic: false });
    const before = harness.server.directoryCalls.length;
    assert.deepEqual(await harness.manager.previewDirectory(harness.admin, off.id), { posters: [] });
    assert.equal(harness.server.directoryCalls.length, before, "a library with the mosaic off makes no provider call");
  });
});

test("previewDirectory refuses an aborted or revoked request", async () => {
  await withHarness(async (harness) => {
    const library = await directoryLibrary(harness, "music");
    await assert.rejects(harness.manager.previewDirectory(harness.admin, library.id, "f1", AbortSignal.abort()), { code: "cancelled" });

    harness.server.detailOf["f1"] = { ...folder("f1"), hasPrimaryImage: true, primaryImageTag: "tag" };
    harness.server.ancestorsOf["f1"] = ["music"];
    await harness.manager.patchLibrary(harness.admin, library.id, { allowedUsers: [BOB] });
    const held = (() => { let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; }); return { wait, release }; })();
    const entered = (() => { let signal!: () => void; const promise = new Promise<void>((resolve) => { signal = resolve; }); return { promise, signal }; })();
    harness.server.nudge = { op: "detail", wait: held.wait, entered: entered.signal };
    const previewing = harness.manager.previewDirectory(harness.bob, library.id, "f1");
    await entered.promise;
    await harness.manager.patchLibrary(harness.admin, library.id, { allowedUsers: [] });
    held.release();
    harness.server.nudge = undefined;
    await assert.rejects(previewing, { code: "not-found" });
  });
});

test("a display-only settings change keeps the generation, the runtime and any live cursor", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    harness.server.libraries.push({ id: "music", name: "Music", type: "mixed" });
    harness.server.directories["music"] = [movie("m1"), movie("m2")];
    harness.server.versionsOf["m1"] = [{ id: "v1" }];
    harness.server.ancestorsOf["m1"] = ["music"];
    harness.server.detailOf["m1"] = movie("m1");
    const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "music" });

    const first = await harness.manager.browseDirectory(harness.admin, library.id, { limit: "1" });
    assert.ok(first.cursor);
    await harness.manager.itemVersions(harness.admin, library.id, "m1");
    const generation = harness.store.mediaConnections()[0]!.generation;
    const closedBefore = harness.server.closed;

    const patched = await harness.manager.patchLibrary(harness.admin, library.id, { mosaic: false, showInFavorites: false });
    assert.equal(patched.mosaic, false);
    assert.equal(patched.showInFavorites, false);
    assert.equal(harness.store.mediaConnections()[0]!.generation, generation, "a display-only change never bumps the generation");
    assert.equal(harness.server.closed, closedBefore, "no live transport was closed");

    const continued = await harness.manager.browseDirectory(harness.admin, library.id, { limit: "1", cursor: first.cursor });
    assert.deepEqual(continued.items.map((item) => item.id), ["m2"], "the pre-change cursor still pages");
    const versions = await harness.manager.itemVersions(harness.admin, library.id, "m1");
    assert.equal(versions.versions[0]!.id, "v1", "the live reference still revalidates");

    // A later mode switch is display-only too: it never bumps the generation or drops the runtime.
    const remoded = await harness.manager.patchLibrary(harness.admin, library.id, { browseMode: "titles" });
    assert.equal(remoded.browseMode, "titles");
    assert.equal(harness.store.mediaConnections()[0]!.generation, generation, "a mode change never bumps the generation");
    assert.equal(harness.server.closed, closedBefore, "still no transport was closed");
  });
});


test("a generation change drops the cached session facts so the next read re-proves them", async () => {
  await withHarness(async (harness) => {
    const { connection, library } = await seedMatchLibrary(harness, [movie("m1", "Alien")]);
    harness.server.directories["lib-1"] = [movie("m1", "Alien")];
    await harness.manager.browseDirectory(harness.admin, library.id, {});
    assert.equal(harness.server.calls.filter((call) => call === "info").length, 1, "the facts are proved once");
    await harness.manager.browseDirectory(harness.admin, library.id, {});
    assert.equal(harness.server.calls.filter((call) => call === "info").length, 1, "and reused inside the window");

    // Disabling and re-enabling the connection bumps the generation and drops its runtime.
    await harness.manager.patchConnection(harness.admin, connection.id, { enabled: false });
    await harness.manager.patchConnection(harness.admin, connection.id, { enabled: true });
    await harness.manager.browseDirectory(harness.admin, library.id, {});
    assert.equal(harness.server.calls.filter((call) => call === "info").length, 2, "a new generation re-proves the facts");
  });
});


test("a saturated global lane cannot release a catch-up burst to one server", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    const lane = harness.manager as unknown as {
      runtimes: Map<string, unknown>;
      net: (runtime: unknown, signal: AbortSignal, work: () => Promise<void>) => Promise<void>;
    };
    const runtime = lane.runtimes.get(connection.id);
    assert.ok(runtime);
    const held = deferred();
    const signal = new AbortController().signal;
    let active = 0;
    const blockers = Array.from({ length: 4 }, () => lane.net(runtime, signal, async () => { active++; await held.promise; }));
    await until(() => active === 4);
    const starts: number[] = [];
    const queued = Array.from({ length: 6 }, () => lane.net(runtime, signal, async () => { starts.push(Date.now()); }));
    await new Promise(resolve => setTimeout(resolve, 200));
    held.resolve();
    await Promise.all([...blockers, ...queued]);
    assert.equal(starts.length, 6);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i]! - starts[i - 1]! >= 20, "dispatches remain spaced after saturation");
  }, { networkStartIntervalMs: 25 });
});

test("a page's own ids are proved once, so listing them then reading their images needs no detail or ancestor call", async () => {
  await withHarness(async (harness) => {
    const library = await directoryLibrary(harness, "music");
    harness.server.directories["music"] = [
      { ...artMovie("a1"), primaryImageTag: "t1" },
      { ...artMovie("a2"), primaryImageTag: "t2" },
    ];
    harness.server.artwork = { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" };
    const page = await harness.manager.browseDirectory(harness.admin, library.id, {});
    assert.equal(page.items.length, 2);
    const before = harness.server.calls.length;
    const responses = await Promise.all(page.items.map((item) => harness.manager.readArtwork(harness.admin, library.id, item.id, "Primary")));
    assert.ok(responses.every((response) => response.status === 200));
    const after = harness.server.calls.slice(before);
    assert.equal(after.filter((call) => call === "detail").length, 0, "no per-image detail");
    assert.equal(after.filter((call) => call === "ancestors").length, 0, "no per-image ancestor chain");
    assert.equal(after.filter((call) => call === "artwork").length, 2, "each image was fetched once");
  });
});

test("an image response is cancelled when its grant disappears while headers are pending", async () => {
  await withHarness(async (harness) => {
    const library = await directoryLibrary(harness, "music");
    harness.server.directories["music"] = [artMovie("a1")];
    harness.server.artwork = { bytes: new Uint8Array([1]), contentType: "image/png" };
    await harness.manager.browseDirectory(harness.admin, library.id, {});
    const held = deferred();
    const entered = deferred();
    harness.server.nudge = { op: "artwork", wait: held.promise, entered: entered.resolve };
    const pending = harness.manager.readArtwork(harness.admin, library.id, "a1", "Primary");
    await entered.promise;
    await harness.manager.patchLibrary(harness.admin, library.id, { enabled: false });
    held.resolve();
    await assert.rejects(pending, { code: "not-found" });
    assert.equal(harness.server.artworkCancelled, 1);
  });
});

test("a matching If-None-Match is a local 304 with zero upstream work and a revoked grant is a 404", async () => {
  await withHarness(async (harness) => {
    const library = await directoryLibrary(harness, "music");
    harness.server.directories["music"] = [{ ...artMovie("a1"), primaryImageTag: "tag1" }];
    harness.server.artwork = { bytes: new Uint8Array([1]), contentType: "image/png" };
    await harness.manager.browseDirectory(harness.admin, library.id, {});
    const before = harness.server.calls.length;
    const response = await harness.manager.readArtwork(harness.admin, library.id, "a1", "Primary", undefined, { ifNoneMatch: `"tag1"` });
    assert.equal(response.status, 304);
    assert.equal(response.headers.get("etag"), `"tag1"`);
    assert.equal(harness.server.calls.length, before, "a 304 makes no upstream call");
    assert.equal(harness.server.artworkRequests.length, 0, "and no image bytes are fetched");

    await harness.manager.patchLibrary(harness.admin, library.id, { enabled: false });
    await assert.rejects(
      harness.manager.readArtwork(harness.admin, library.id, "a1", "Primary", undefined, { ifNoneMatch: `"tag1"` }),
      { code: "not-found" },
      "a revoked grant reads as missing even for a conditional request",
    );
  });
});

test("a membership proof never crosses actors or connections' generations", async () => {
  await withHarness(async (harness) => {
    const library = await directoryLibrary(harness, "music");
    harness.server.directories["music"] = [artMovie("a1")];
    harness.server.detailOf["a1"] = artMovie("a1");
    harness.server.ancestorsOf["a1"] = ["music"];
    harness.server.artwork = { bytes: new Uint8Array([1]), contentType: "image/png" };
    await harness.manager.browseDirectory(harness.admin, library.id, {});
    await harness.manager.patchLibrary(harness.admin, library.id, { allowedUsers: [BOB] });
    const before = harness.server.calls.length;
    const response = await harness.manager.readArtwork(harness.bob, library.id, "a1", "Primary");
    assert.equal(response.status, 200);
    assert.ok(harness.server.calls.slice(before).includes("detail"), "a second actor holds no proof of its own, so it proves membership afresh");
  });
});

test("a first nested page proves its parent once and a signed continuation proves nothing further", async () => {
  await withHarness(async (harness) => {
    const library = await directoryLibrary(harness, "music");
    harness.server.directories["music"] = [folder("seasonA")];
    harness.server.directories["seasonA"] = [movie("m1"), movie("m2"), movie("m3")];
    harness.server.detailOf["seasonA"] = folder("seasonA", { parentId: "music" });
    harness.server.ancestorsOf["seasonA"] = ["music"];
    const first = await harness.manager.browseDirectory(harness.admin, library.id, { parentId: "seasonA", limit: "2" });
    assert.deepEqual(first.items.map((item) => item.id), ["m1", "m2"]);
    assert.equal(harness.server.calls.filter((call) => call === "detail").length, 1, "the parent is proved once");
    assert.equal(harness.server.calls.filter((call) => call === "ancestors").length, 1);
    const second = await harness.manager.browseDirectory(harness.admin, library.id, { parentId: "seasonA", limit: "2", cursor: first.cursor });
    assert.deepEqual(second.items.map((item) => item.id), ["m3"]);
    assert.equal(harness.server.calls.filter((call) => call === "detail").length, 1, "a signed continuation proves no parent again");
    assert.equal(harness.server.calls.filter((call) => call === "ancestors").length, 1, "and reads no ancestor chain again");
  });
});

test("a tampered or foreign-parent cursor is refused before any provider call", async () => {
  await withHarness(async (harness) => {
    const library = await directoryLibrary(harness, "music");
    harness.server.directories["music"] = [folder("seasonA")];
    harness.server.directories["seasonA"] = [movie("m1"), movie("m2")];
    harness.server.detailOf["seasonA"] = folder("seasonA", { parentId: "music" });
    harness.server.ancestorsOf["seasonA"] = ["music"];
    const first = await harness.manager.browseDirectory(harness.admin, library.id, { parentId: "seasonA", limit: "1" });
    assert.ok(first.cursor);

    // A cursor with its payload rewritten no longer carries this process's signature.
    const raw = Buffer.from(first.cursor, "base64url").toString("utf8");
    const forged = Buffer.from(raw.replace("seasonA", "seasonB"), "utf8").toString("base64url");
    const directoryCalls = harness.server.directoryCalls.length;
    await assert.rejects(
      harness.manager.browseDirectory(harness.admin, library.id, { parentId: "seasonA", limit: "1", cursor: forged }),
      { code: "invalid-input" },
    );
    // A cursor bound to one parent is refused for another before the provider is reached.
    await assert.rejects(
      harness.manager.browseDirectory(harness.admin, library.id, { parentId: "seasonB", limit: "1", cursor: first.cursor }),
      { code: "stale-generation" },
    );
    assert.equal(harness.server.directoryCalls.length, directoryCalls, "neither cursor reached the provider");
  });
});

test("matching a large catalogue is one query with no scan, and an episode match is one bounded season page", async () => {
  await withHarness(async (harness) => {
    const catalogue: ProviderItem[] = Array.from({ length: 500 }, (_value, index) => ({
      id: `m${index}`, name: `Movie ${index}`, type: "movie", providerIds: { imdb: `tt${1000 + index}` },
    }));
    catalogue.push({ id: "alien", name: "Alien", type: "movie", providerIds: { imdb: "tt1" } });
    catalogue.push({ id: "show", name: "Show", type: "series", providerIds: { imdb: "tt5" } });
    for (let index = 1; index <= 200; index += 1) catalogue.push(episode(`e${index}`, { seriesId: "show", season: 1, episode: index }));
    const { library } = await seedMatchLibrary(harness, catalogue);

    const movieBefore = harness.server.calls.length;
    const matches = await harness.manager.matchingItems(harness.admin, library.id, "movie", "tt1");
    assert.deepEqual(matches.map((item) => item.id), ["alien"]);
    const movieCalls = harness.server.calls.slice(movieBefore);
    assert.equal(movieCalls.filter((call) => call === "find").length, 1, "one provider-id query");
    assert.equal(movieCalls.filter((call) => call === "items").length, 0, "no full scan");
    assert.equal(movieCalls.filter((call) => call === "directory").length, 0, "and no browse page for a movie");

    harness.server.versionsOf["e2"] = [{ id: "v1" }];
    const episodeBefore = harness.server.calls.length;
    const episodes = await harness.manager.matchedVersions(harness.admin, library.id, "series", "tt5:1:2", undefined, "Show");
    assert.deepEqual(episodes.map((entry) => entry.item.id), ["e2"]);
    const episodeCalls = harness.server.calls.slice(episodeBefore);
    assert.equal(episodeCalls.filter((call) => call === "find").length, 1, "one series candidate query");
    assert.equal(episodeCalls.filter((call) => call === "items").length, 0, "no scan for an episode");
    const seasonPages = harness.server.directoryCalls.filter((call) => call.parentId === "show");
    assert.equal(seasonPages.length, 1, "one parent-scoped season episode page");
    assert.equal(seasonPages[0]!.options.season, 1, "scoped to the requested season");
    assert.equal(seasonPages[0]!.options.limit, 200, "bounded to one page");
    assert.equal(harness.server.matchCalls.at(-1)?.nameHint, "Show", "the resolved series title is passed through");
  });
});


test("visible library roots use cached own posters without any upstream request", async () => {
  let now = 1_000;
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    harness.server.libraries.push({ id: "music", name: "Music", type: "mixed", primaryImageTag: "root-tag" });
    const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "music" });
    const before = harness.server.calls.length;
    const roots = await harness.manager.visibleLibraries(harness.admin);
    assert.equal(roots[0]?.poster, `/api/remote-libraries/${library.id}/items/music/artwork/Primary?tag=root-tag`);
    assert.equal(harness.server.calls.length, before);
    now += 30_001;
    assert.equal((await harness.manager.visibleLibraries(harness.admin))[0]?.poster, undefined);
    assert.equal(harness.server.calls.length, before, "an expired view never makes the local list fetch upstream");
  }, { clock: () => now });
});

test("signed continuations renew parent membership after five minutes", async () => {
  let now = 1_000;
  await withHarness(async (harness) => {
    const library = await directoryLibrary(harness, "music");
    harness.server.detailOf["parent"] = folder("parent");
    harness.server.ancestorsOf["parent"] = ["music"];
    harness.server.directories["parent"] = [movie("m1"), movie("m2"), movie("m3")];
    const first = await harness.manager.browseDirectory(harness.admin, library.id, { parentId: "parent", limit: "1" });
    now += 240_000;
    const second = await harness.manager.browseDirectory(harness.admin, library.id, { parentId: "parent", limit: "1", cursor: first.cursor });
    assert.equal(harness.server.calls.filter((call) => call === "ancestors").length, 1);
    now += 60_001;
    harness.server.ancestorsOf["parent"] = ["another-library"];
    const before = harness.server.directoryCalls.length;
    await assert.rejects(harness.manager.browseDirectory(harness.admin, library.id, { parentId: "parent", limit: "1", cursor: second.cursor }), { code: "not-found" });
    assert.equal(harness.server.directoryCalls.length, before, "expired membership is re-proved before continuing");
  }, { clock: () => now });
});
