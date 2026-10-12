import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ForbiddenError } from "./roles.js";
import { ResourceError } from "./media-resources.js";
import { MediaServerIndex } from "./media-server-index.js";
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

interface Nudge { op: string; wait: Promise<void>; entered?: () => void }

interface FakePage { items: ProviderItem[]; total: number; cursor?: string }

class FakeServer {
  serverId = "server-1";
  accountId = "user-1";
  token = "token-value-1";
  policy: RemoteAccountPolicy = { disabled: false, mediaPlayback: true, allFolders: true, folderIds: [], hasAdditionalRestrictions: false };
  libraries: ProviderLibrary[] = [];
  items: Record<string, ProviderItem[]> = {};
  detailOf: Record<string, ProviderItem> = {};
  ancestorsOf: Record<string, string[]> = {};
  versionsOf: Record<string, ProviderVersion[]> = {};
  original: { status?: number; headers?: Record<string, string>; error?: MediaServerError } | undefined;
  originalCalls = 0;
  originalCancelled = 0;
  asset: { bytes: Uint8Array; contentType: string } | undefined;
  assetRequests: Array<Record<string, unknown>> = [];
  calls: string[] = [];
  errors: Record<string, MediaServerError> = {};
  nudge: Nudge | undefined;
  pageOverride: ((options: { cursor?: string; limit?: number }) => FakePage) | undefined;
  closed = 0;

  async run(operation: string): Promise<void> {
    this.calls.push(operation);
    const error = this.errors[operation];
    if (error) throw error;
    if (this.nudge?.op === operation) { this.nudge.entered?.(); await this.nudge.wait; }
  }
}

const clone = <T>(value: T): T => structuredClone(value);

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
    ...(options.cleanupIntervalMs === undefined ? {} : { cleanupIntervalMs: options.cleanupIntervalMs }),
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

const withHarness = async (run: (harness: Harness) => Promise<void>, options: { users?: UserRecord[]; key?: boolean } = {}) => {
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
    for (const operation of ["info", "user", "views", "items"]) {
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
      harness.index.invalidateConnection(connection.id);
    }
  });
});

test("a scan refuses a cursor cycle and a library that grows past the byte budget", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    seedLibrary(harness, "lib-1", []);
    const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" });

    const pages: Record<string, FakePage> = {
      start: { items: [movie("m1")], total: 3, cursor: "A" },
      A: { items: [movie("m2")], total: 3, cursor: "B" },
      B: { items: [movie("m3")], total: 3, cursor: "A" },
    };
    harness.server.pageOverride = (options) => pages[options.cursor ?? "start"]!;
    await assert.rejects(harness.manager.browseItems(harness.admin, library.id, {}), { code: "invalid-response" });

    harness.index.invalidateConnection(connection.id);
    harness.server.pageOverride = (options) => options.cursor === undefined
      ? { items: Array.from({ length: 20 }, (_, index) => movie(`m${index}`, "x".repeat(300_000))), total: 20 }
      : { items: [], total: 20 };
    await assert.rejects(harness.manager.browseItems(harness.admin, library.id, {}), { code: "response-too-large" });
    harness.server.pageOverride = undefined;
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
    harness.server.nudge = { op: "items", wait: held.wait, entered: entered.signal };
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

    harness.server.errors.items = new MediaServerError("forbidden", "nope", 403);
    harness.index.invalidateConnection(connection.id);
    await assert.rejects(harness.manager.browseItems(harness.admin, library.id, {}), { code: "forbidden" });
    assert.equal((await harness.manager.listConnections(harness.admin)).connections[0]!.status, "available", "a content 403 changes no status");

    delete harness.server.errors.items;
    harness.server.errors.user = new MediaServerError("authentication-required", "401", 401);
    await assert.rejects(harness.manager.browseItems(harness.admin, library.id, {}), { code: "authentication-required" });
    assert.equal((await harness.manager.listConnections(harness.admin)).connections[0]!.status, "reauthentication-required");
    delete harness.server.errors.user;

    // A 401 from a page, a detail or an ancestor call revokes the runtime too, not only the
    // preflight: the cached token is no longer usable for any operation.
    for (const operation of ["items", "detail", "ancestors"]) {
      harness.server.errors[operation] = new MediaServerError("authentication-required", "401", 401);
      const attempt = operation === "items"
        ? harness.manager.browseItems(harness.admin, library.id, {})
        : harness.manager.itemDetail(harness.admin, library.id, "m1");
      if (operation === "items") harness.index.invalidateConnection(connection.id);
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
    await assert.rejects(harness.manager.browseItems(harness.admin, library.id, {}), { code: "unavailable" });
    harness.server.policy.disabled = false;

    harness.server.policy.mediaPlayback = false;
    await assert.rejects(harness.manager.browseItems(harness.admin, library.id, {}), { code: "forbidden" });
    harness.server.policy.mediaPlayback = true;

    harness.server.policy.hasAdditionalRestrictions = true;
    await assert.rejects(harness.manager.browseItems(harness.admin, library.id, {}), { code: "unsupported-policy" });
    harness.server.policy.hasAdditionalRestrictions = false;

    harness.server.policy.allFolders = false;
    harness.server.policy.folderIds = ["another-library"];
    await assert.rejects(harness.manager.browseItems(harness.admin, library.id, {}), { code: "forbidden" });
    harness.server.policy.folderIds = ["lib-1"];
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

test("episodes group by a proven series id or season parent and omit unproven rows", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    const season = { id: "season-1", name: "Season 1", type: "season" as const, providerIds: {}, parentId: "series-1" };
    const series = { id: "series-1", name: "Show", type: "series" as const, providerIds: {} };
    harness.server.libraries = [{ id: "lib-1", name: "Shows", type: "series" }];
    harness.server.items["lib-1"] = [
      series,
      season,
      episode("e1", { seriesId: "series-1", parentId: "season-1", season: 1, episode: 1 }),
      episode("e2", { parentId: "season-1", season: 1, episode: 2 }),
      episode("e3", { seriesId: "another-series", parentId: "season-1" }),
    ];
    for (const item of [series, season]) harness.server.ancestorsOf[item.id] = ["lib-1"];
    harness.server.ancestorsOf["e1"] = ["lib-1"];
    harness.server.detailOf["series-1"] = series;
    harness.server.detailOf["season-1"] = season;
    const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" });

    const bySeason = await harness.manager.itemEpisodes(harness.admin, library.id, "season-1", {});
    assert.deepEqual(bySeason.items.map((item) => item.id), ["e1", "e2", "e3"], "a season groups by parent id");
    const bySeries = await harness.manager.itemEpisodes(harness.admin, library.id, "series-1", {});
    assert.deepEqual(bySeries.items.map((item) => item.id), ["e1"], "a series needs a proven SeriesId, never a guess");
    await assert.rejects(harness.manager.itemEpisodes(harness.admin, library.id, "unknown", {}), { code: "not-found" });
  });
});

test("the network lane is bounded and admin mutations never queue behind each other", async () => {
  await withHarness(async (harness) => {
    const connection = await connect(harness);
    const held = (() => { let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; }); return { wait, release }; })();
    harness.server.nudge = { op: "info", wait: held.wait };
    const running = [0, 1, 2, 3].map(() => harness.manager.discoverLibraries(harness.admin, connection.id));
    await assert.rejects(harness.manager.discoverLibraries(harness.admin, connection.id), { code: "busy" }, "a fifth network call is refused rather than queued");
    held.release();
    harness.server.nudge = undefined;
    await Promise.all(running);

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
  });
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
    const manager = new MediaServerManager(store, vault, { providerFactory: () => stubProvider(server), transportFactory: () => stubTransport(server) });
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
  for (const item of items) {
    harness.server.detailOf[item.id] = item;
    harness.server.ancestorsOf[item.id] = ["lib-1"];
  }
  const library = await harness.manager.attachLibrary(harness.admin, connection.id, { remoteId: "lib-1" });
  return { connection, library };
};

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
    assert.deepEqual(await harness.manager.matchingItems(harness.admin, library.id, "series", "tt1:1:4"), [], "a multi-episode range is not a single match");
    harness.server.detailOf["show"] = { id: "show", name: "Show", type: "series", providerIds: { imdb: "tt9" } };
    assert.deepEqual(await harness.manager.matchingItems(harness.admin, library.id, "series", "tt1:1:2"), [], "the series proof is re-read, never trusted from the snapshot");
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

test("an id this app cannot match is answered before the library is scanned", async () => {
  await withHarness(async (harness) => {
    const { library } = await seedMatchLibrary(harness, [
      { id: "m1", name: "Alien", type: "movie", providerIds: { imdb: "tt1" } },
    ]);
    const scans = () => harness.server.calls.filter((call) => call === "items").length;
    const before = scans();
    assert.deepEqual(await harness.manager.matchingItems(harness.admin, library.id, "movie", "NotAnId"), []);
    assert.deepEqual(await harness.manager.matchedVersions(harness.admin, library.id, "series", "tt1"), [], "a series id without an episode number names nothing");
    assert.equal(scans(), before, "no snapshot was built for an id that names nothing");
    assert.equal(harness.server.calls.includes("detail"), false, "and no item was read");
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

test("readArtwork reads bounded bytes for a fixed role and refuses other roles and items", async () => {
  await withHarness(async (harness) => {
    const { library } = await seedMatchLibrary(harness, [
      { id: "m1", name: "Alien", type: "movie", providerIds: {} },
      { id: "show", name: "Show", type: "series", providerIds: {} },
    ]);
    harness.server.asset = { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" };
    const asset = await harness.manager.readArtwork(harness.admin, library.id, "show", "Backdrop");
    assert.deepEqual([...asset.bytes], [1, 2, 3]);
    assert.equal(asset.contentType, "image/png");
    assert.deepEqual(harness.server.assetRequests.at(-1), { kind: "artwork", itemId: "show", imageType: "Backdrop" });
    await assert.rejects(harness.manager.readArtwork(harness.admin, library.id, "m1", "Logo"), { code: "invalid-input" });
    await assert.rejects(harness.manager.readArtwork(harness.admin, library.id, "missing", "Primary"), { code: "not-found" });
  });
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
