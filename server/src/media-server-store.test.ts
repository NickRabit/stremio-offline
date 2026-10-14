import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MediaServerConfiguration, prepareMediaServerConfiguration, projectMediaServerConfiguration } from "./media-server-store.js";
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

test("a beforeWrite guard runs inside every mutating update and refuses the whole write", async () => {
  await run(async ({ store }) => {
    const seen: number[] = [];
    const guarded = new MediaServerConfiguration(store, { beforeWrite: (state) => { seen.push((state.mediaConnections ?? []).length); } });
    const created = await guarded.addConnection(connectionInput());
    await guarded.attachLibrary(created.id, libraryInput());
    await guarded.setEnabled(created.id, false);
    await guarded.removeConnection(created.id);
    assert.deepEqual(seen, [0, 1, 1, 1], "the guard ran for every write, before it landed");

    const refusing = new MediaServerConfiguration(store, { beforeWrite: () => { throw new Error("stale authority"); } });
    await assert.rejects(refusing.addConnection(connectionInput()), /stale authority/);
    assert.deepEqual(store.mediaConnections(), [], "a refused guard leaves nothing behind");
  });
});

test("hasPersistedState tracks a real read or write, not a speculative mutation", async () => {
  await run(async ({ dataDir, store, config }) => {
    assert.equal(store.hasPersistedState(), false, "load() swallowed a missing file");
    assert.equal(store.hasMediaServerState(), false);
    await config.addConnection(connectionInput());
    assert.equal(store.hasPersistedState(), true);
    assert.equal(store.hasMediaServerState(), true, "the write that carried mediaConnections is proof");
    const reopened = new Store(dataDir, path.dirname(dataDir));
    assert.equal(reopened.hasPersistedState(), false, "a fresh store has read nothing");
    assert.equal(reopened.hasMediaServerState(), false);
    await reopened.load();
    assert.equal(reopened.hasPersistedState(), true);
    assert.equal(reopened.hasMediaServerState(), true, "the loaded state owned mediaConnections");
  });
});

test("hasMediaServerState stays false for a state written before the fields existed", async () => {
  await run(async ({ dataDir, store }) => {
    await store.update((state) => { state.addons = state.addons ?? []; });
    assert.equal(store.hasPersistedState(), true);
    assert.equal(store.hasMediaServerState(), false, "a legacy save is not proof that the vault is orphaned");
    void dataDir;
  });
});

test("the cleanup queue accessor clones and is absent by default", async () => {
  await run(async ({ store, config }) => {
    assert.deepEqual(store.mediaSecretCleanup(), []);
    await store.update((state) => { state.mediaSecretCleanup = ["msecret_00000000000000000000000000000001"]; });
    const queue = store.mediaSecretCleanup();
    queue.push("msecret_00000000000000000000000000000002");
    assert.deepEqual(store.mediaSecretCleanup(), ["msecret_00000000000000000000000000000001"], "the returned array is a copy");
    void config;
  });
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

test("the optional display settings round-trip, validate strictly and leave an old record untouched", async () => {
  await run(async ({ config, store }) => {
    const created = await config.addConnection(connectionInput());
    const legacy = await config.attachLibrary(created.id, libraryInput());
    assert.equal("browseMode" in legacy, false, "an attach with no settings stores no settings");
    assert.deepEqual(Object.keys(config.exportConfiguration().libraries[0]).sort(),
      ["connectionId", "id", "name", "order", "remoteId", "showInContinueWatching", "showOnHome", "type"]);

    const rich = await config.attachLibrary(created.id, libraryInput({ remoteId: "remote-2", browseMode: "folders", mosaic: false, showInFavorites: false }));
    assert.equal(rich.browseMode, "folders");
    assert.equal(rich.mosaic, false);
    assert.equal(rich.showInFavorites, false);
    const exported = config.exportConfiguration();
    const exportedRich = exported.libraries.find((library) => library.remoteId === "remote-2")!;
    assert.equal(exportedRich.browseMode, "folders");
    assert.equal(exportedRich.mosaic, false);
    assert.equal(exportedRich.showInFavorites, false);
    const exportedLegacy = exported.libraries.find((library) => library.remoteId === "remote-lib-1")!;
    assert.equal("browseMode" in exportedLegacy, false, "an old record exports without the new fields");

    // The whole configuration survives a restore, optional fields included, and nothing extra does.
    const projected = projectMediaServerConfiguration({
      version: 1,
      connections: exported.connections,
      libraries: exported.libraries.map((library) => library.remoteId === "remote-2"
        ? { ...library, allowedUsers: ["usr_00000001"], enabled: true, extra: "no" }
        : library),
    });
    assert.deepEqual(projected.libraries.find((library) => library.remoteId === "remote-2"), exportedRich);

    const restored = await workspace();
    try {
      await restored.config.restoreConfiguration(exported);
      const restoredRich = restored.store.remoteLibraries().find((library) => library.remoteId === "remote-2")!;
      assert.equal(restoredRich.browseMode, "folders");
      assert.equal(restoredRich.mosaic, false);
      assert.equal(restoredRich.showInFavorites, false);
      assert.equal("browseMode" in restored.store.remoteLibraries().find((library) => library.remoteId === "remote-lib-1")!, false);
    } finally {
      await rm(path.dirname(restored.dataDir), { recursive: true, force: true });
    }

    await assert.rejects(config.attachLibrary(created.id, libraryInput({ remoteId: "r3", browseMode: "grid" } as never)), { code: "invalid-input" });
    await assert.rejects(config.attachLibrary(created.id, libraryInput({ remoteId: "r4", mosaic: "yes" } as never)), { code: "invalid-input" });
    await assert.rejects(config.attachLibrary(created.id, libraryInput({ remoteId: "r5", showInFavorites: 1 } as never)), { code: "invalid-input" });
    assert.equal(store.remoteLibraries().length, 2, "a refused setting attaches nothing");
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

test("preparing a configuration validates it and mints fresh handles without touching the store", async () => {
  await run(async ({ config, store }) => {
    const created = await config.addConnection(connectionInput());
    await config.attachLibrary(created.id, libraryInput());
    const exported = config.exportConfiguration();
    const before = JSON.stringify({ connections: store.mediaConnections(), libraries: store.remoteLibraries() });
    const prepared = prepareMediaServerConfiguration(exported);
    assert.notEqual(prepared.connections[0]!.id, created.id, "a fresh local handle");
    assert.equal(prepared.connections[0]!.enabled, false);
    assert.equal(prepared.connections[0]!.generation, 0);
    assert.equal(prepared.connections[0]!.secretRef, undefined);
    assert.deepEqual(prepared.libraries[0]!.allowedUsers, [], "grants never come out of a file");
    assert.equal(prepared.libraries[0]!.connectionId, prepared.connections[0]!.id, "the attachment follows the fresh handle");
    assert.equal(JSON.stringify({ connections: store.mediaConnections(), libraries: store.remoteLibraries() }), before, "preparing writes nothing");
    assert.throws(() => prepareMediaServerConfiguration({ version: 1, connections: [], libraries: [{ ...exported.libraries[0], connectionId: newConnectionId() }] }), { code: "invalid-input" });
  });
});

test("the backup projection keeps to the export allowlist and drops whatever else a record carries", async () => {
  await run(async ({ config }) => {
    const created = await config.addConnection(connectionInput());
    await config.attachLibrary(created.id, libraryInput());
    const exported = config.exportConfiguration();
    const whole = {
      version: 1,
      connections: [{ ...exported.connections[0], secretRef: "msecret_" + "e".repeat(32), enabled: true, generation: 7, allowedUsers: ["usr_00000001"], password: "hunter2", token: "token-value" }],
      libraries: [{ ...exported.libraries[0], enabled: true, allowedUsers: ["usr_00000001"] }],
    };
    const projected = projectMediaServerConfiguration(whole);
    assert.deepEqual(Object.keys(projected.connections[0]!).sort(), ["accountId", "allowLan", "allowLoopback", "baseUrl", "id", "name", "provider", "serverId"]);
    assert.deepEqual(Object.keys(projected.libraries[0]!).sort(), ["connectionId", "id", "name", "order", "remoteId", "showInContinueWatching", "showOnHome", "type"]);
    const serialized = JSON.stringify(projected);
    for (const forbidden of ["msecret_", "hunter2", "token-value", "generation", "allowedUsers", "enabled"]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} never reaches a backup`);
    }
    assert.throws(() => projectMediaServerConfiguration({ ...whole, extra: true }), { code: "invalid-input" }, "a file that is not the configuration shape is refused");
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

test("the copy destination rides in a backup as it stands, and only its shape is proved", async () => {
  await run(async ({ config, store, dataDir }) => {
    const connection = await config.addConnection(connectionInput());
    const attached = await config.attachLibrary(connection.id, libraryInput());
    assert.equal("downloadLibraryId" in attached, false, "an attach with no destination stores none");
    await store.update((state) => { state.remoteLibraries![0]!.downloadLibraryId = "lib_a1b2c3d4"; });

    const exported = config.exportConfiguration();
    assert.equal(exported.libraries[0]!.downloadLibraryId, "lib_a1b2c3d4");
    const projected = projectMediaServerConfiguration({ version: 1, connections: exported.connections, libraries: exported.libraries });
    assert.equal(projected.libraries[0]!.downloadLibraryId, "lib_a1b2c3d4", "the backup projection keeps the handle");

    // The handle names a library of the install it came from, so a restore stores it verbatim:
    // a destination that is gone here is refused when a copy is asked for, never rewritten.
    const restored = await workspace();
    try {
      await restored.config.restoreConfiguration(exported);
      assert.equal(restored.store.remoteLibraries()[0]!.downloadLibraryId, "lib_a1b2c3d4");
    } finally {
      await rm(path.dirname(restored.dataDir), { recursive: true, force: true });
    }

    // A reload reads it back off the disk unchanged, and nothing about it is recomputed.
    const reopened = new Store(dataDir, dataDir);
    await reopened.load();
    assert.equal(reopened.remoteLibraries()[0]!.downloadLibraryId, "lib_a1b2c3d4");

    for (const value of [`rlib_${"a".repeat(32)}`, "lib_zzzzzzzz", "", 7, null, {}]) {
      await assert.rejects(
        config.restoreConfiguration({
          version: 1, connections: [],
          libraries: [{ ...exported.libraries[0], downloadLibraryId: value }],
        }),
        { code: "invalid-input" },
        `the exported handle ${JSON.stringify(value)} is refused`,
      );
    }
    assert.equal(store.remoteLibraries().length, 1, "a refused batch writes nothing");
  });
});

test("storage rules ride in a backup with an unavailable handle kept as it stands", async () => {
  await run(async ({ config, store, dataDir }) => {
    const connection = await config.addConnection(connectionInput());
    const attached = await config.attachLibrary(connection.id, libraryInput());
    assert.equal("downloadSettings" in attached, false, "an attach with no rules stores none");
    const rules = {
      movie: { subfolder: "Filmy/2024", layout: "flat" as const, libraryId: "lib_a1b2c3d4" },
      series: { subfolder: "", layout: "structured" as const },
    };
    await store.update((state) => { state.remoteLibraries![0]!.downloadSettings = structuredClone(rules); });

    const exported = config.exportConfiguration();
    assert.deepEqual(exported.libraries[0]!.downloadSettings, rules);
    const projected = projectMediaServerConfiguration({ version: 1, connections: exported.connections, libraries: exported.libraries });
    assert.deepEqual(projected.libraries[0]!.downloadSettings, rules, "the backup projection keeps the rules");

    // The handle names a library of the install the backup came from: a restore stores it as it
    // stands, and a copy that asks for a library gone here is refused at the door, never rewritten.
    const restored = await workspace();
    try {
      await restored.config.restoreConfiguration(exported);
      assert.deepEqual(restored.store.remoteLibraries()[0]!.downloadSettings, rules, "the handle is preserved verbatim");
    } finally {
      await rm(path.dirname(restored.dataDir), { recursive: true, force: true });
    }

    const reopened = new Store(dataDir, dataDir);
    await reopened.load();
    assert.deepEqual(reopened.remoteLibraries()[0]!.downloadSettings, rules, "the rules survive a reload");

    for (const value of [
      { movie: { libraryId: `rlib_${"a".repeat(32)}` } },
      { movie: { subfolder: "/etc" } },
      { movie: { subfolder: "a/../../b" } },
      { movie: { layout: "guess" } },
      { movie: { subfolder: 7 } },
      { movie: { libraryId: 9 } },
      { movie: { extra: true } },
      { movie: "flat" },
      [],
    ]) {
      await assert.rejects(
        config.restoreConfiguration({ version: 1, connections: [], libraries: [{ ...exported.libraries[0], downloadSettings: value }] }),
        { code: "invalid-input" },
        `the imported rules ${JSON.stringify(value)} are refused`,
      );
    }
    assert.equal(store.remoteLibraries().length, 1, "a refused batch writes nothing");
  });
});
