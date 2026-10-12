import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MediaServerConfiguration } from "./media-server-store.js";
import { newConnectionId, newRemoteLibraryId } from "./media-server-types.js";
import { Store } from "./store.js";

interface Workspace {
  dataDir: string;
  downloadDir: string;
  store: Store;
  config: MediaServerConfiguration;
}

async function workspace(): Promise<Workspace> {
  const root = await mkdtemp(path.join(tmpdir(), "media-store-"));
  const dataDir = path.join(root, "data");
  const downloadDir = path.join(root, "downloads");
  const store = new Store(dataDir, downloadDir);
  await store.load();
  return { dataDir, downloadDir, store, config: new MediaServerConfiguration(store) };
}

async function run(run: (workspace: Workspace) => Promise<void>): Promise<void> {
  const created = await workspace();
  try { await run(created); }
  finally { await rm(path.dirname(created.dataDir), { recursive: true, force: true }); }
}

const connectionInput = (over: Record<string, unknown> = {}) => ({
  provider: "jellyfin" as const,
  name: "Living room",
  baseUrl: "https://media.example/prefix",
  allowLan: false,
  allowLoopback: false,
  serverId: "server-1",
  accountId: "user-1",
  enabled: true,
  ...over,
});

const libraryInput = (over: Record<string, unknown> = {}) => ({
  remoteId: "remote-lib-1",
  name: "Films",
  type: "movie" as const,
  enabled: true,
  order: 0,
  showOnHome: true,
  showInContinueWatching: true,
  ...over,
});

test("the clone accessors isolate persisted state from accidental mutation", async () => {
  await run(async ({ config, store }) => {
    const created = await config.addConnection(connectionInput());
    await config.attachLibrary(created.id, libraryInput());
    const connections = store.mediaConnections();
    connections[0].name = "changed";
    connections.push({ ...connections[0] });
    const libraries = store.remoteLibraries();
    libraries[0].allowedUsers.push("intruder");
    assert.equal(store.mediaConnections().length, 1);
    assert.equal(store.remoteLibraries()[0].allowedUsers.length, 0);
    assert.equal(store.mediaConnections()[0].name, "Living room");
  });
});

test("the filesystem library state is untouched by the media configuration", async () => {
  await run(async ({ config, store, dataDir, downloadDir }) => {
    const before = store.libraries();
    const created = await config.addConnection(connectionInput());
    await config.attachLibrary(created.id, libraryInput());
    await config.setEnabled(created.id, false);
    assert.deepEqual(store.libraries(), before);
    const reopened = new Store(dataDir, downloadDir);
    await reopened.load();
    assert.deepEqual(reopened.libraries(), before);
    assert.equal(reopened.mediaConnections()[0].enabled, false);
    assert.equal(reopened.remoteLibraries().length, 1);
  });
});

test("addConnection refuses unknown or injected keys and malformed input", async () => {
  await run(async ({ config }) => {
    for (const injected of ["secretRef", "token", "password", "root", "id", "generation", "addedAt"]) {
      await assert.rejects(config.addConnection(connectionInput({ [injected]: "x" }) as never), { code: "invalid-input" });
    }
    await assert.rejects(config.addConnection(connectionInput({ baseUrl: "http://user:pass@media.example" }) as never), { code: "invalid-input" });
    await assert.rejects(config.addConnection(connectionInput({ provider: "plex" }) as never), { code: "invalid-input" });
    await assert.rejects(config.addConnection(connectionInput({ name: "a".repeat(257) }) as never), { code: "invalid-input" });
  });
});

test("a verified account is refused even under a different name or address", async () => {
  await run(async ({ config, store }) => {
    await config.addConnection(connectionInput());
    await assert.rejects(config.addConnection(connectionInput({ name: "Other", baseUrl: "https://elsewhere.example" }) as never), { code: "invalid-input" });
    assert.equal(store.mediaConnections().length, 1);
    await config.addConnection(connectionInput({ serverId: "server-2", accountId: "user-2" }));
    assert.equal(store.mediaConnections().length, 2);
  });
});

test("two concurrent attaches of the same verified account leave exactly one", async () => {
  await run(async ({ config, store }) => {
    const results = await Promise.allSettled([config.addConnection(connectionInput()), config.addConnection(connectionInput())]);
    assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal((results.find((entry) => entry.status === "rejected") as PromiseRejectedResult).reason.code, "invalid-input");
    assert.equal(store.mediaConnections().length, 1);
  });
});

test("two concurrent attaches of the same remote library leave exactly one", async () => {
  await run(async ({ config, store }) => {
    const created = await config.addConnection(connectionInput());
    const results = await Promise.allSettled([config.attachLibrary(created.id, libraryInput()), config.attachLibrary(created.id, libraryInput())]);
    assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal((results.find((entry) => entry.status === "rejected") as PromiseRejectedResult).reason.code, "invalid-input");
    assert.equal(store.remoteLibraries().length, 1);
  });
});

test("attachLibrary requires an enabled verified connection and refuses a duplicate remote id", async () => {
  await run(async ({ config, store }) => {
    await assert.rejects(config.attachLibrary(newConnectionId(), libraryInput()), { code: "not-found" });
    const created = await config.addConnection(connectionInput());
    await config.setEnabled(created.id, false);
    await assert.rejects(config.attachLibrary(created.id, libraryInput()), { code: "invalid-input" });
    await config.setEnabled(created.id, true);
    await assert.rejects(config.attachLibrary(created.id, libraryInput({ allowedUsers: ["u1"] }) as never), { code: "invalid-input" });
    const library = await config.attachLibrary(created.id, libraryInput());
    assert.deepEqual(library.allowedUsers, [], "a newly attached library never carries grants, and grants cannot be injected");
    await assert.rejects(config.attachLibrary(created.id, libraryInput()), { code: "invalid-input" });
    assert.equal(store.remoteLibraries().length, 1);
  });
});

test("setEnabled bumps the generation only on a real change", async () => {
  await run(async ({ config }) => {
    const created = await config.addConnection(connectionInput());
    assert.equal(created.generation, 0);
    await config.setEnabled(created.id, true);
    assert.equal(config.exportConfiguration().connections.length, 1);
    await config.setEnabled(created.id, false);
    assert.equal((await config.addConnection(connectionInput({ accountId: "other", serverId: "other" }))).generation, 0);
    await assert.rejects(config.setEnabled(newConnectionId(), false), { code: "not-found" });
  });
});

test("removeConnection returns its secret reference and removes its libraries", async () => {
  await run(async ({ config, store }) => {
    const created = await config.addConnection(connectionInput());
    await config.attachLibrary(created.id, libraryInput());
    const ref = "msecret_" + "a".repeat(32);
    await config.setSecretReference(created.id, created.generation, ref, { get: async () => "token" });
    const result = await config.removeConnection(created.id);
    assert.deepEqual(result, { secretRefsToRemove: [ref] });
    assert.deepEqual(store.mediaConnections(), []);
    assert.deepEqual(store.remoteLibraries(), []);
    await assert.rejects(config.removeConnection(created.id), { code: "not-found" });
  });
});

test("setSecretReference refuses a stale generation and a change during the awaited decrypt", async () => {
  await run(async ({ config }) => {
    const created = await config.addConnection(connectionInput());
    const ref = "msecret_" + "b".repeat(32);
    await assert.rejects(config.setSecretReference(created.id, created.generation + 1, ref, { get: async () => "token" }), { code: "stale-generation" });
    await assert.rejects(config.setSecretReference(newConnectionId(), 0, ref, { get: async () => "token" }), { code: "not-found" });
    await assert.rejects(config.setSecretReference(created.id, created.generation, "not-a-ref", { get: async () => "token" }), { code: "invalid-input" });
    const revoked = await config.setSecretReference(created.id, created.generation, ref, {
      get: async () => {
        await config.setEnabled(created.id, false);
        return "token";
      },
    }).then(() => "resolved", (error) => (error as { code?: string }).code);
    assert.equal(revoked, "stale-generation");
  });
});

test("the export is metadata only and the restore mints fresh disabled handles", async () => {
  await run(async ({ config, store }) => {
    const created = await config.addConnection(connectionInput());
    await config.attachLibrary(created.id, libraryInput());
    await config.setSecretReference(created.id, created.generation, "msecret_" + "c".repeat(32), { get: async () => "t" });
    const exported = config.exportConfiguration();
    assert.equal(exported.version, 1);
    const exportedConnection = exported.connections[0];
    assert.deepEqual(Object.keys(exportedConnection).sort(), ["accountId", "allowLan", "allowLoopback", "baseUrl", "id", "name", "provider", "serverId"]);
    assert.deepEqual(Object.keys(exported.libraries[0]).sort(), ["connectionId", "id", "name", "order", "remoteId", "showInContinueWatching", "showOnHome", "type"]);
    const serialized = JSON.stringify(exported);
    assert.equal(serialized.includes("secretRef"), false);
    assert.equal(serialized.includes("msecret_"), false);

    const restored = await workspace();
    try {
      await restored.config.restoreConfiguration(exported);
      const [connection] = restored.store.mediaConnections();
      assert.notEqual(connection.id, created.id);
      assert.equal(connection.enabled, false);
      assert.equal(connection.generation, 0);
      assert.equal(connection.secretRef, undefined);
      const [library] = restored.store.remoteLibraries();
      assert.notEqual(library.id, exported.libraries[0].id);
      assert.equal(library.connectionId, connection.id);
      assert.equal(library.enabled, false);
      assert.deepEqual(library.allowedUsers, []);
      assert.equal(JSON.stringify(restored.store.remoteLibraries()).includes("secret"), false);
    } finally {
      await rm(path.dirname(restored.dataDir), { recursive: true, force: true });
    }
    await store.flush();
  });
});

test("restore refuses a duplicate account, a dangling library and extra fields atomically", async () => {
  await run(async ({ config, store }) => {
    const created = await config.addConnection(connectionInput());
    await config.attachLibrary(created.id, libraryInput());
    const exported = config.exportConfiguration();
    await assert.rejects(config.restoreConfiguration(exported), { code: "invalid-input" }, "the same verified account is already connected");
    assert.equal(store.mediaConnections().length, 1);

    const dangling = { version: 1, connections: [], libraries: [{ ...exported.libraries[0], connectionId: "mconn_" + "0".repeat(32) }] };
    await assert.rejects(config.restoreConfiguration(dangling), { code: "invalid-input" });
    const extra = { ...exported, extra: true };
    await assert.rejects(config.restoreConfiguration(extra), { code: "invalid-input" });
    const repeated = { version: 1, connections: exported.connections, libraries: [exported.libraries[0], exported.libraries[0]] };
    await assert.rejects(config.restoreConfiguration(repeated), { code: "invalid-input" });
    assert.equal(store.remoteLibraries().length, 1, "a refused batch leaves nothing behind");
  });
});

test("restore bounds the configuration before any write", async () => {
  await run(async ({ config, store }) => {
    const many = {
      version: 1,
      connections: Array.from({ length: 129 }, (_, index) => ({ id: newConnectionId(), provider: "jellyfin", name: `c${index}`, baseUrl: "https://m.example", allowLan: false, allowLoopback: false, serverId: `s${index}`, accountId: `a${index}` })),
      libraries: [],
    };
    await assert.rejects(config.restoreConfiguration(many), { code: "invalid-input" });
    assert.deepEqual(store.mediaConnections(), []);
  });
});

test("setSecretReference hands back only the previous reference the caller must delete", async () => {
  await run(async ({ config }) => {
    const created = await config.addConnection(connectionInput());
    const first = "msecret_" + "1".repeat(32);
    assert.deepEqual(await config.setSecretReference(created.id, created.generation, first, { get: async () => "t" }), { secretRefsToRemove: [] });
    const second = "msecret_" + "2".repeat(32);
    assert.deepEqual(await config.setSecretReference(created.id, created.generation + 1, second, { get: async () => "t" }), { secretRefsToRemove: [first] });
    assert.deepEqual(await config.setSecretReference(created.id, created.generation + 2, second, { get: async () => "t" }), { secretRefsToRemove: [] });
  });
});

test("two concurrent bindings at the same generation leave one winner and no lost reference", async () => {
  await run(async ({ config, store }) => {
    const created = await config.addConnection(connectionInput());
    const first = "msecret_" + "3".repeat(32);
    await config.setSecretReference(created.id, created.generation, first, { get: async () => "t" });
    const generation = store.mediaConnections()[0].generation;
    const a = "msecret_" + "4".repeat(32);
    const b = "msecret_" + "5".repeat(32);
    const results = await Promise.allSettled([
      config.setSecretReference(created.id, generation, a, { get: async () => "t" }),
      config.setSecretReference(created.id, generation, b, { get: async () => "t" }),
    ]);
    const fulfilled = results.filter((entry) => entry.status === "fulfilled") as PromiseFulfilledResult<{ secretRefsToRemove: string[] }>[];
    const rejected = results.filter((entry) => entry.status === "rejected") as PromiseRejectedResult[];
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, "stale-generation");
    assert.deepEqual(fulfilled[0].value, { secretRefsToRemove: [first] });
    const current = store.mediaConnections()[0].secretRef;
    assert.ok(current === a || current === b);
    assert.equal(fulfilled[0].value.secretRefsToRemove.includes(current as string), false, "the just-bound ref is never scheduled for deletion");
  });
});

test("verified identities are a JSON tuple, so a NUL byte cannot alias two accounts", async () => {
  await run(async ({ config, store }) => {
    await config.addConnection(connectionInput({ accountId: "a\u0000b", serverId: "c" }));
    await config.addConnection(connectionInput({ accountId: "a", serverId: "b\u0000c" }));
    assert.equal(store.mediaConnections().length, 2);
  });
});

test("order and generation must be safe non-negative integers", async () => {
  await run(async ({ config }) => {
    const created = await config.addConnection(connectionInput());
    await assert.rejects(config.attachLibrary(created.id, libraryInput({ order: 2 ** 53 }) as never), { code: "invalid-input" });
    await assert.rejects(config.setSecretReference(created.id, 2 ** 53, "msecret_" + "6".repeat(32), { get: async () => "t" }), { code: "invalid-input" });
  });
});

test("an unknown configuration field is refused without reflecting its name", async () => {
  await run(async ({ config }) => {
    const error = await config.addConnection(connectionInput({ "token=SECRET-KEY": "x" }) as never)
      .then(() => undefined, (value) => value as { code?: string; message?: string });
    assert.equal(error?.code, "invalid-input");
    assert.equal(error?.message?.includes("SECRET-KEY"), false);
  });
});

test("generation overflow refuses the complete mutation", async () => {
  await run(async ({ config, store }) => {
    const connection = await config.addConnection(connectionInput());
    await store.update((state) => { state.mediaConnections![0].generation = Number.MAX_SAFE_INTEGER; });
    await assert.rejects(config.setEnabled(connection.id, false), { code: "invalid-input" });
    const ref = `msecret_${"c".repeat(32)}`;
    await assert.rejects(config.setSecretReference(connection.id, Number.MAX_SAFE_INTEGER, ref, { get: async () => "token" }), { code: "invalid-input" });
    assert.equal(store.mediaConnections()[0].enabled, true);
    assert.equal(store.mediaConnections()[0].secretRef, undefined);
    assert.equal(store.mediaConnections()[0].generation, Number.MAX_SAFE_INTEGER);
  });
});
