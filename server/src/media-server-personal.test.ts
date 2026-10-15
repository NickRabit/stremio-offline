import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MediaResources, ResourceError } from "./media-resources.js";
import { MediaServerIndex } from "./media-server-index.js";
import { MediaServerManager, type MediaServerAuthority } from "./media-server-manager.js";
import { MediaServerPersonal } from "./media-server-personal.js";
import type { MediaServerProvider, ProviderItem, RemoteAccountPolicy } from "./media-server-provider.js";
import { MediaServerSecrets } from "./media-server-secrets.js";
import type { MediaServerTransport } from "./media-server-security.js";
import { MediaServerError } from "./media-server-types.js";
import { Store } from "./store.js";
import { emptyUserData, type UserRecord } from "./users.js";

const ADA = "usr_00000001";
const BOB = "usr_00000002";

const account = (over: Partial<UserRecord> & Pick<UserRecord, "id" | "username">): UserRecord => ({
  passwordHash: "scrypt$aa$bb", secret: `secret-${over.id}`, role: "user",
  createdAt: "2026-01-01T00:00:00.000Z", permissions: { downloadToLibrary: true, downloadToDevice: true },
  permissionsVersion: 0, ...over,
});
const admin = account({ id: ADA, username: "ada", role: "admin" });
const bob = account({ id: BOB, username: "bob" });

const movie = (id: string, name = `Movie ${id}`): ProviderItem => ({ id, name, type: "movie", providerIds: {} });

class FakeServer {
  serverId = "server-1";
  accountId = "account-1";
  policy: RemoteAccountPolicy = { disabled: false, mediaPlayback: true, allFolders: true, folderIds: [], hasAdditionalRestrictions: false };
  libraries = [{ id: "remote-1", name: "Films", type: "movie" as const }];
  detailOf: Record<string, ProviderItem> = { m1: movie("m1", "Alien"), s1: { id: "s1", name: "Show", type: "series", providerIds: {} } };
  ancestorsOf: Record<string, string[]> = { m1: ["remote-1"], s1: ["remote-1"] };
  versionsOf: Record<string, Array<{ id: string; name?: string }>> = { m1: [{ id: "v1", name: "1080p" }, { id: "v2", name: "720p" }] };
  /** Every provider operation that ran, for the assertions about the shared window. */
  calls: string[] = [];
}

const provider = (server: FakeServer): MediaServerProvider => {
  const run = async (operation: string) => { server.calls.push(operation); };
  return {
    verifyIdentity: async () => { await run("info"); return { serverId: server.serverId, version: "1" }; },
    authenticate: async () => { await run("login"); return { serverId: server.serverId, accountId: server.accountId, token: "token-1" }; },
    currentAccount: async () => { await run("user"); return { accountId: server.accountId, policy: structuredClone(server.policy) }; },
    listLibraries: async () => { await run("views"); return structuredClone(server.libraries); },
    pageItems: async () => { throw new MediaServerError("not-found", "unused"); },
    pageDirectory: async () => { throw new MediaServerError("not-found", "unused"); },
    findByProviderIds: async () => { throw new MediaServerError("not-found", "unused"); },
    detail: async (_t, _a, itemId) => { await run("detail"); const item = server.detailOf[itemId]; if (!item) throw new MediaServerError("not-found", "missing"); return structuredClone(item); },
    ancestors: async (_t, _a, itemId) => { await run("ancestors"); return [...(server.ancestorsOf[itemId] ?? [])]; },
    versions: async (_t, _a, itemId) => { await run("versions"); return structuredClone(server.versionsOf[itemId] ?? []); },
  };
};
const transport: MediaServerTransport = {
  requestJson: async () => { throw new Error("unused"); },
  requestAsset: async () => { throw new Error("unused asset transport"); },
  requestArtwork: async () => { throw new Error("unused artwork transport"); },
  requestOriginal: async () => { throw new Error("unused"); },
  close: async () => undefined,
};

interface Harness {
  dir: string;
  store: Store;
  manager: MediaServerManager;
  personal: MediaServerPersonal;
  server: FakeServer;
  libraryId: string;
  connectionId: string;
  admin: MediaServerAuthority;
  bob: MediaServerAuthority;
  loseAccess(): void;
  injectBeforeUpdate(mutate: (state: Mutable) => void): void;
  reload(): Promise<Store>;
  close(): Promise<void>;
}

interface Mutable {
  users?: UserRecord[];
  userData?: Record<string, { prefs?: Record<string, unknown>; remoteMedia?: Record<string, unknown> }>;
  mediaConnections?: Array<{ id: string; enabled: boolean; generation: number }>;
  remoteLibraries?: Array<{ id: string; allowedUsers: string[] }>;
}

const mount = async (): Promise<Harness> => {
  const dir = await mkdtemp(path.join(tmpdir(), "media-personal-"));
  const users = [admin, bob];
  await writeFile(path.join(dir, "state.json"), JSON.stringify({
    schemaVersion: 3, addons: [], settings: {}, defaultsInstalled: true, users,
    userData: Object.fromEntries(users.map((user) => [user.id, emptyUserData()])), libraries: [],
  }));
  const keyFile = path.join(dir, "secret.key");
  await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
  const store = new Store(dir, dir);
  await store.load();
  const server = new FakeServer();
  const manager = new MediaServerManager(store, new MediaServerSecrets(path.join(dir, "vault"), keyFile), {
    providerFactory: () => provider(server), transportFactory: () => transport, index: new MediaServerIndex(),
    networkStartIntervalMs: 0,
  });
  await manager.initialize();
  let revoked = false;
  const authority = (user: UserRecord): MediaServerAuthority => ({
    actor: { id: user.id, secret: user.secret },
    assertCurrent: () => { if (revoked) throw new ResourceError(401, "AUTH_REQUIRED"); },
  });
  const adminAuthority = authority(admin);
  const connection = await manager.createConnection(adminAuthority, {
    provider: "jellyfin", name: "Home", baseUrl: "http://media.example", allowLan: false, allowLoopback: false,
    username: "reader", password: "reader-password",
  });
  const library = await manager.attachLibrary(adminAuthority, connection.id, { remoteId: "remote-1" });
  const personal = new MediaServerPersonal(store, manager);
  return {
    dir, store, manager, personal, server, libraryId: library.id, connectionId: connection.id,
    admin: adminAuthority, bob: authority(bob),
    loseAccess: () => { revoked = true; },
    injectBeforeUpdate: (mutate) => {
      const real = store.update.bind(store);
      (store as unknown as { update(fn: (state: unknown) => void): Promise<void> }).update = (fn) => real((state) => { mutate(state as unknown as Mutable); fn(state); });
    },
    reload: async () => { const fresh = new Store(dir, dir); await fresh.load(); return fresh; },
    close: async () => { await manager.close(); await rm(dir, { recursive: true, force: true }); },
  };
};

/** Forget one connection's cached session facts so the next confirmation re-reads the policy. */
const forgetSession = (h: Harness): void => {
  (h.manager as unknown as { runtimes: Map<string, unknown> }).runtimes.delete(h.connectionId);
};

/** How many times one provider operation has run, for the assertions about the shared window. */
const providerCalls = (h: Harness, operation: string): number =>
  h.server.calls.filter((call) => call === operation).length;

const withHarness = async (run: (harness: Harness) => Promise<void>) => {
  const harness = await mount();
  try { await run(harness); } finally { await harness.close(); }
};

test("an unseen remote item reads as the default row with its derived key", async () => {
  await withHarness(async (harness) => {
    const state = await harness.personal.read(harness.admin, harness.libraryId, "m1");
    assert.match(state.key, /^remote:[0-9a-f]{64}$/);
    assert.deepEqual({ position: state.position, duration: state.duration, favorite: state.favorite, watched: state.watched }, { position: 0, duration: 0, favorite: false, watched: false });
  });
});

test("favourite and watched persist; a picked version must be a current ordinary file", async () => {
  await withHarness(async (harness) => {
    const patched = await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 12, duration: 100, favorite: true, watched: false, mediaSourceId: "v1" });
    assert.equal(patched.position, 12);
    assert.equal(patched.favorite, true);
    assert.equal(patched.mediaSourceId, "v1");
    const again = await harness.personal.read(harness.admin, harness.libraryId, "m1");
    assert.deepEqual(again, patched);
    await assert.rejects(harness.personal.patch(harness.admin, harness.libraryId, "m1", { mediaSourceId: "v9" }), { code: "not-found" });
  });
});

test("repeated local progress over one item costs the provider nothing inside the shared window", async () => {
  await withHarness(async (harness) => {
    const first = await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 10, duration: 100, mediaSourceId: "v1" });
    assert.equal(first.position, 10);
    const read = { detail: providerCalls(harness, "detail"), versions: providerCalls(harness, "versions") };
    assert.equal(read.detail, 1, "the write's own preflight reads the row once");
    assert.equal(read.versions, 1, "and the picked version once");

    const second = await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 20, duration: 100, mediaSourceId: "v1" });
    assert.equal(second.position, 20, "the second save still lands");
    assert.equal(providerCalls(harness, "detail"), read.detail, "the row comes from the shared window");
    assert.equal(providerCalls(harness, "versions"), read.versions, "and so does the version list");
    assert.equal((await harness.personal.read(harness.admin, harness.libraryId, "m1")).position, 20, "the account's own state is read locally");
    assert.equal(providerCalls(harness, "detail"), read.detail);
    assert.equal(JSON.stringify(harness.store.userData(ADA).remoteMedia).includes('"position":20'), true, "and the write landed in the state");
  });
});

test("the patch body is exact and bounded", async () => {
  await withHarness(async (harness) => {
    for (const body of [{}, { position: -1 }, { position: 31_536_001 }, { duration: Number.NaN }, { favorite: "yes" }, { watched: 1 }, { key: "remote:x" }, { name: "x" }, { position: "5" }]) {
      await assert.rejects(harness.personal.patch(harness.admin, harness.libraryId, "m1", body), { code: "invalid-input" }, JSON.stringify(body));
    }
    await assert.rejects(harness.personal.patch(harness.admin, harness.libraryId, "m1", { mediaSourceId: "x".repeat(513) }), { code: "invalid-input" });
  });
});

test("a series carries toggles but never progress", async () => {
  await withHarness(async (harness) => {
    const state = await harness.personal.patch(harness.admin, harness.libraryId, "s1", { favorite: true });
    assert.equal(state.favorite, true);
    assert.equal(state.position, 0);
    await assert.rejects(harness.personal.patch(harness.admin, harness.libraryId, "s1", { position: 5 }), { code: "invalid-input" });
    await assert.rejects(harness.personal.patch(harness.admin, harness.libraryId, "s1", { mediaSourceId: "v1" }), { code: "invalid-input" });
  });
});

test("with tracking off a position is ignored while a toggle still lands", async () => {
  await withHarness(async (harness) => {
    await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 42, duration: 100 });
    await harness.store.update((state) => {
      const data = state.userData![ADA]!;
      data.prefs = { ...data.prefs, trackProgress: false };
    });
    const patched = await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 99, favorite: true });
    assert.equal(patched.position, 42, "the position is left as it was");
    assert.equal(patched.favorite, true, "the explicit toggle still lands");
  });
});

test("one account's state is never read through another's", async () => {
  await withHarness(async (harness) => {
    await assert.rejects(harness.personal.read(harness.bob, harness.libraryId, "m1"), { code: "not-found" }, "an ungranted account is refused");
    await harness.manager.patchLibrary(harness.admin, harness.libraryId, { allowedUsers: [BOB] });
    await harness.personal.patch(harness.admin, harness.libraryId, "m1", { favorite: true, position: 10 });
    const theirs = await harness.personal.read(harness.bob, harness.libraryId, "m1");
    assert.equal(theirs.favorite, false);
    assert.equal(theirs.position, 0);
    assert.equal((await harness.personal.read(harness.admin, harness.libraryId, "m1")).favorite, true);
  });
});

test("the map persists across a reload and never carries a URL or a seal", async () => {
  await withHarness(async (harness) => {
    const patched = await harness.personal.patch(harness.admin, harness.libraryId, "m1", { favorite: true });
    const persisted = JSON.stringify(harness.store.userData(ADA).remoteMedia);
    assert.equal(persisted.includes("media-server:"), false);
    assert.equal(persisted.includes("http"), false);
    const fresh = await harness.reload();
    const reread = new MediaServerPersonal(fresh, harness.manager);
    assert.equal((await reread.read(harness.admin, harness.libraryId, "m1")).favorite, true);
    void patched;
  });
});

test("a non-local library handle is refused", async () => {
  await withHarness(async (harness) => {
    await assert.rejects(harness.personal.read(harness.admin, `rlib_${"a".repeat(32)}`, "m1"), { code: "not-found" });
  });
});

test("history survives the same verified account being reattached under a new local handle", async () => {
  await withHarness(async (harness) => {
    await harness.personal.patch(harness.admin, harness.libraryId, "m1", { favorite: true, position: 33 });
    await harness.manager.deleteLibrary(harness.admin, harness.libraryId);
    const reattached = await harness.manager.attachLibrary(harness.admin, harness.connectionId, { remoteId: "remote-1" });
    assert.notEqual(reattached.id, harness.libraryId, "a new local handle");
    const state = await harness.personal.read(harness.admin, reattached.id, "m1");
    assert.equal(state.favorite, true);
    assert.equal(state.position, 33);
  });
});

test("a queued withdrawal of the session, the secret or the grant refuses the write", async () => {
  await withHarness(async (harness) => {
    // The session is withdrawn while the request is queued, after its preflight resolved.
    harness.injectBeforeUpdate(() => harness.loseAccess());
    await assert.rejects(harness.personal.patch(harness.admin, harness.libraryId, "m1", { favorite: true }), { status: 401 }, "a withdrawn session");
  });
});

test("a secret rotation or generation change landing before the write refuses it", async () => {
  await withHarness(async (harness) => {
    harness.injectBeforeUpdate((state) => {
      const user = state.users?.find((candidate) => candidate.id === ADA);
      if (user) user.secret = "rotated";
    });
    await assert.rejects(harness.personal.patch(harness.admin, harness.libraryId, "m1", { favorite: true }), { status: 401 }, "the secret changed");
  });
  await withHarness(async (harness) => {
    harness.injectBeforeUpdate((state) => {
      const connection = state.mediaConnections?.find((candidate) => candidate.id === harness.connectionId);
      if (connection) connection.generation += 1;
    });
    await assert.rejects(harness.personal.patch(harness.admin, harness.libraryId, "m1", { favorite: true }), { code: "not-found" }, "the connection generation moved");
  });
});

test("a revoked grant refuses the write of the account that lost it", async () => {
  await withHarness(async (harness) => {
    await harness.manager.patchLibrary(harness.admin, harness.libraryId, { allowedUsers: [BOB] });
    harness.injectBeforeUpdate((state) => {
      const library = state.remoteLibraries?.find((candidate) => candidate.id === harness.libraryId);
      if (library) library.allowedUsers = [];
    });
    await assert.rejects(harness.personal.patch(harness.bob, harness.libraryId, "m1", { favorite: true }), { code: "not-found" });
  });
});

test("the tracking preference is read from the state the write lands on", async () => {
  await withHarness(async (harness) => {
    await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 42, duration: 100 });
    harness.injectBeforeUpdate((state) => {
      const data = state.userData?.[ADA];
      if (data) data.prefs = { ...(data.prefs ?? {}), trackProgress: false };
    });
    const patched = await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 99, mediaSourceId: "v2", favorite: true });
    assert.equal(patched.position, 42, "a position queued behind the change is dropped");
    assert.equal(patched.mediaSourceId, undefined, "and so is the version tied to the position");
    assert.equal(patched.favorite, true, "an explicit toggle still lands");
  });
});

test("switching the chosen version resets a stale position", async () => {
  await withHarness(async (harness) => {
    await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 30, duration: 100, mediaSourceId: "v1" });
    const switched = await harness.personal.patch(harness.admin, harness.libraryId, "m1", { mediaSourceId: "v2" });
    assert.equal(switched.mediaSourceId, "v2");
    assert.equal(switched.position, 0, "the old position does not survive a version change");
    const resumed = await harness.personal.patch(harness.admin, harness.libraryId, "m1", { mediaSourceId: "v2", position: 12 });
    assert.equal(resumed.position, 12);
  });
});

test("the authorized list hides records for a library the account can no longer reach", async () => {
  await withHarness(async (harness) => {
    await harness.manager.patchLibrary(harness.admin, harness.libraryId, { allowedUsers: [BOB] });
    await harness.personal.patch(harness.bob, harness.libraryId, "m1", { favorite: true });
    assert.equal((await harness.personal.list(harness.bob)).length, 1);
    await harness.manager.patchLibrary(harness.admin, harness.libraryId, { allowedUsers: [] });
    assert.deepEqual(await harness.personal.list(harness.bob), []);
  });
});

const seedPlayable = (harness: Harness, id: string, over: Partial<ProviderItem> = {}) => {
  harness.server.detailOf[id] = { id, name: `Movie ${id}`, type: "movie", providerIds: {}, ...over };
  harness.server.ancestorsOf[id] = ["remote-1"];
  harness.server.versionsOf[id] = [{ id: "v1", name: "1080p" }];
};

test("cards project resume rows and hide unstarted, finished and watched ones", async () => {
  await withHarness(async (harness) => {
    seedPlayable(harness, "m2");
    seedPlayable(harness, "m3");
    seedPlayable(harness, "m4");
    await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 12, duration: 100 });
    await harness.personal.patch(harness.admin, harness.libraryId, "m2", { position: 0, duration: 100 });
    await harness.personal.patch(harness.admin, harness.libraryId, "m3", { position: 95, duration: 100 });
    await harness.personal.patch(harness.admin, harness.libraryId, "m4", { position: 40, duration: 100, watched: true });
    await harness.personal.patch(harness.admin, harness.libraryId, "s1", { favorite: true });
    const resume = await harness.personal.cards(harness.admin, { filter: "resume" });
    assert.deepEqual(resume.items.map((card) => card.itemId), ["m1"]);
    assert.equal(resume.items[0]!.kind, "remote");
    assert.match(resume.items[0]!.poster!, /\/items\/m1\/artwork\/Primary$/);
    assert.equal(JSON.stringify(resume).includes("media-server:"), false);
    const favorites = await harness.personal.cards(harness.admin, { filter: "favorites" });
    assert.deepEqual(favorites.items.map((card) => card.itemId), ["s1"]);
  });
});

test("a role the provider reports absent is remembered and keeps the card URL off", async () => {
  await withHarness(async (harness) => {
    harness.server.detailOf.m1 = { ...movie("m1", "Alien"), hasPrimaryImage: false, hasBackdropImage: false };
    await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 12, duration: 100 });

    const resume = await harness.personal.cards(harness.admin, { filter: "resume" });
    assert.deepEqual(resume.items.map((card) => card.itemId), ["m1"]);
    assert.equal("poster" in resume.items[0]!, false, "the absent poster has no URL");
    assert.equal("wide" in resume.items[0]!, false, "the absent backdrop has no URL");

    const stored = harness.store.userData(ADA).remoteMedia as Record<string, { primaryAbsent?: boolean; backdropAbsent?: boolean }>;
    const row = stored[Object.keys(stored)[0]!]!;
    assert.equal(row.primaryAbsent, true);
    assert.equal(row.backdropAbsent, true);

    // A round trip through validRecord has to keep the flags, or the next read strips them.
    const fresh = await harness.reload();
    const reread = new MediaServerPersonal(fresh, harness.manager);
    const again = await reread.cards(harness.admin, { filter: "resume" });
    assert.equal("poster" in again.items[0]!, false, "the flag survives a reload");
    assert.equal("wide" in again.items[0]!, false);
  });
});

test("a row written before the absence flags still emits both untagged URLs", async () => {
  await withHarness(async (harness) => {
    await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 12, duration: 100 });
    const stored = harness.store.userData(ADA).remoteMedia as Record<string, Record<string, unknown>>;
    const key = Object.keys(stored)[0]!;
    await harness.store.update((state) => {
      const row = (state.userData![ADA]!.remoteMedia as Record<string, Record<string, unknown>>)[key]!;
      delete row.primaryAbsent;
      delete row.backdropAbsent;
      row.primaryImageTag = "planted";
    });

    const resume = await harness.personal.cards(harness.admin, { filter: "resume" });
    assert.equal(resume.items.length, 1);
    assert.match(resume.items[0]!.poster!, /\/items\/m1\/artwork\/Primary$/);
    assert.match(resume.items[0]!.wide!, /\/items\/m1\/artwork\/Backdrop$/);
    assert.equal(resume.items[0]!.poster!.includes("tag="), false, "a planted tag never reaches the card");
  });
});

test("cards mark a library partial when it cannot be confirmed and project nothing for it", async () => {
  await withHarness(async (harness) => {
    await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 12, duration: 100 });
    harness.server.policy = { ...harness.server.policy, mediaPlayback: false };
    forgetSession(harness);
    const partial = await harness.personal.cards(harness.admin, { filter: "resume" });
    assert.deepEqual(partial.items, [], "an unconfirmed library projects no stored labels");
    assert.equal(partial.partial, true);
    harness.server.policy = { ...harness.server.policy, mediaPlayback: true };
    forgetSession(harness);
    const confirmed = await harness.personal.cards(harness.admin, { filter: "resume" });
    assert.deepEqual(confirmed.items.map((card) => card.itemId), ["m1"]);
    assert.equal(confirmed.partial, undefined);
  });
});

test("cards never project a malformed persisted row and never read another account's", async () => {
  await withHarness(async (harness) => {
    await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 12, duration: 100 });
    const stored = harness.store.userData(ADA).remoteMedia as Record<string, { key: string }>;
    const key = Object.keys(stored)[0]!;
    await harness.store.update((state) => {
      (state.userData![ADA]!.remoteMedia as Record<string, { key: string }>)[key]!.key = `remote:${"0".repeat(64)}`;
    });
    assert.deepEqual((await harness.personal.cards(harness.admin, { filter: "resume" })).items, [], "a row whose stored key disagrees is not projected");
    await harness.manager.patchLibrary(harness.admin, harness.libraryId, { allowedUsers: [BOB] });
    assert.deepEqual((await harness.personal.cards(harness.bob, { filter: "resume" })).items, [], "another account's rows are never read");
  });
});

test("assertCardsCurrent refuses a card projection once the connection moves", async () => {
  await withHarness(async (harness) => {
    await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 12, duration: 100 });
    const cards = await harness.personal.cards(harness.admin, { filter: "resume" });
    harness.personal.assertCardsCurrent(harness.admin, cards);
    await harness.manager.patchConnection(harness.admin, harness.connectionId, { enabled: false });
    assert.throws(() => harness.personal.assertCardsCurrent(harness.admin, cards), { status: 404 });
    assert.throws(() => harness.personal.assertCardsCurrent(harness.admin, { items: [], total: 0 }), { status: 404 }, "an unproved object is refused");
  });
});

/** A second attached library holding one resume row, so a projection spans two groups. */
const addLibraryWithRow = async (harness: Harness, remoteId: string, itemId: string, position = 20) => {
  harness.server.libraries.push({ id: remoteId, name: `Library ${remoteId}`, type: "movie" });
  harness.server.detailOf[itemId] = movie(itemId);
  harness.server.ancestorsOf[itemId] = [remoteId];
  harness.server.versionsOf[itemId] = [{ id: "v1", name: "1080p" }];
  const library = await harness.manager.attachLibrary(harness.admin, harness.connectionId, { remoteId });
  await harness.personal.patch(harness.admin, library.id, itemId, { position, duration: 100 });
  return library;
};

test("a card projection is refused for an authority other than the one it was built for", async () => {
  await withHarness(async (harness) => {
    await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 12, duration: 100 });
    const cards = await harness.personal.cards(harness.admin, { filter: "resume" });
    harness.personal.assertCardsCurrent(harness.admin, cards);
    assert.throws(() => harness.personal.assertCardsCurrent(harness.bob, cards), { status: 404 }, "another account cannot re-prove somebody else's cards");
  });
});

test("assertCardsCurrent refuses a projection whose captured identity or switch moved", async () => {
  await withHarness(async (harness) => {
    await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 12, duration: 100 });
    const cards = await harness.personal.cards(harness.admin, { filter: "resume" });
    harness.personal.assertCardsCurrent(harness.admin, cards);
    await harness.store.update((state) => {
      const connection = state.mediaConnections?.find((candidate) => candidate.id === harness.connectionId);
      if (connection) connection.serverId = "server-2";
    });
    assert.throws(() => harness.personal.assertCardsCurrent(harness.admin, cards), { status: 404 }, "a changed remote identity is refused");
  });
  await withHarness(async (harness) => {
    await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 12, duration: 100 });
    const cards = await harness.personal.cards(harness.admin, { filter: "resume" });
    await harness.store.update((state) => {
      const library = state.remoteLibraries?.find((candidate) => candidate.id === harness.libraryId);
      if (library) library.remoteId = "remote-9";
    });
    assert.throws(() => harness.personal.assertCardsCurrent(harness.admin, cards), { status: 404 }, "a changed upstream library is refused");
  });
  await withHarness(async (harness) => {
    await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 12, duration: 100 });
    const cards = await harness.personal.cards(harness.admin, { filter: "resume" });
    await harness.manager.patchLibrary(harness.admin, harness.libraryId, { showInContinueWatching: false });
    assert.throws(() => harness.personal.assertCardsCurrent(harness.admin, cards), { status: 404 }, "the switch that put the library in this projection was turned off");
  });
});

test("a Home switch turned off while the library was confirmed refuses the projection", async () => {
  await withHarness(async (harness) => {
    await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 12, duration: 100 });
    const real = harness.manager.verifyLibrary.bind(harness.manager);
    harness.manager.verifyLibrary = (async (authority, libraryId, signal) => {
      await real(authority, libraryId, signal);
      await harness.store.update((state) => {
        const library = state.remoteLibraries?.find((candidate) => candidate.id === harness.libraryId);
        if (library) library.showInContinueWatching = false;
      });
    }) as typeof harness.manager.verifyLibrary;
    await assert.rejects(harness.personal.cards(harness.admin, { filter: "resume" }), { status: 404 },
      "cards are re-proved against the switches as they stand when the answer is built");
  });
});

test("a confirmation that ignores its abort still loses the deadline race", async () => {
  await withHarness(async (harness) => {
    await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 12, duration: 100 });
    let release!: () => void;
    const hang = new Promise<void>((resolve) => { release = resolve; });
    harness.manager.verifyLibrary = (async () => { await hang; }) as typeof harness.manager.verifyLibrary;
    const started = Date.now();
    const cards = await harness.personal.cards(harness.admin, { filter: "resume", onHome: true });
    assert.equal(cards.partial, true, "the unconfirmed library makes the answer partial");
    assert.deepEqual(cards.items, [], "and projects nothing for it");
    assert.ok(Date.now() - started < 5_000, "the answer never waits for work that ignores the abort");
    release();
  });
});

test("a confirmations own signal is aborted when the budget is spent", async () => {
  await withHarness(async (harness) => {
    await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 12, duration: 100 });
    let seen: AbortSignal | undefined;
    harness.manager.verifyLibrary = (async (_authority, _libraryId, signal?: AbortSignal) => {
      seen = signal;
      await new Promise<void>((resolve) => { signal?.addEventListener("abort", () => resolve(), { once: true }); });
      throw new MediaServerError("cancelled", "The media-server request was cancelled.");
    }) as typeof harness.manager.verifyLibrary;
    const cards = await harness.personal.cards(harness.admin, { filter: "resume", onHome: true });
    assert.equal(seen?.aborted, true, "the work is told its deadline is spent");
    assert.equal(cards.partial, true);
  });
});

test("the whole budget bounds how many confirmations start and never scans past it", async () => {
  await withHarness(async (harness) => {
    await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 12, duration: 100 });
    await addLibraryWithRow(harness, "remote-2", "m2");
    await addLibraryWithRow(harness, "remote-3", "m3");
    let started = 0;
    harness.manager.verifyLibrary = (async () => {
      started += 1;
      await new Promise<void>(() => undefined);
    }) as typeof harness.manager.verifyLibrary;
    const cards = await harness.personal.cards(harness.admin, { filter: "resume", onHome: true });
    assert.equal(started, 2, "no more than two confirmations run at once");
    assert.equal(cards.partial, true);
    assert.deepEqual(cards.items, []);
  });
});

test("one shared deadline prevents extra confirmations when the wall clock lags", async (context) => {
  await withHarness(async (harness) => {
    await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 12, duration: 100 });
    await addLibraryWithRow(harness, "remote-2", "m2");
    await addLibraryWithRow(harness, "remote-3", "m3");
    let started = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    harness.manager.verifyLibrary = (async () => { started += 1; await held; }) as typeof harness.manager.verifyLibrary;
    const epoch = Date.now();
    let reads = 0;
    const clock = context.mock.method(Date, "now", () => epoch + (reads++ === 0 ? 0 : 250));
    try {
      const cards = await harness.personal.cards(harness.admin, { filter: "resume", onHome: true });
      assert.equal(started, 2, "an expired confirmation cannot restart work before the shared budget aborts");
      assert.equal(cards.partial, true);
      assert.deepEqual(cards.items, []);
    } finally {
      clock.mock.restore();
      release();
    }
  });
});

test("a spent budget keeps the sibling that was confirmed", async () => {
  await withHarness(async (harness) => {
    await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 12, duration: 100 });
    const second = await addLibraryWithRow(harness, "remote-2", "m2");
    const real = harness.manager.verifyLibrary.bind(harness.manager);
    harness.manager.verifyLibrary = (async (authority, libraryId, signal) => {
      if (libraryId === second.id) return real(authority, libraryId, signal);
      await new Promise<void>(() => undefined);
    }) as typeof harness.manager.verifyLibrary;
    const cards = await harness.personal.cards(harness.admin, { filter: "resume", onHome: true });
    assert.deepEqual(cards.items.map((card) => card.itemId), ["m2"], "the library that answered is still projected");
    assert.equal(cards.partial, true, "and the one that ran out of time is marked partial");
    harness.personal.assertCardsCurrent(harness.admin, cards);
  });
});

test("cancelling the caller stops the queue and aborts the confirmations in flight", async () => {
  await withHarness(async (harness) => {
    await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 12, duration: 100 });
    await addLibraryWithRow(harness, "remote-2", "m2");
    let inFlight = 0;
    let aborted = 0;
    harness.manager.verifyLibrary = (async (_authority, _libraryId, signal?: AbortSignal) => {
      inFlight += 1;
      await new Promise<void>((resolve) => { signal?.addEventListener("abort", () => { aborted += 1; resolve(); }, { once: true }); });
    }) as typeof harness.manager.verifyLibrary;
    const caller = new AbortController();
    const running = harness.personal.cards(harness.admin, { filter: "resume" }, caller.signal);
    while (inFlight < 2) await new Promise((resolve) => setImmediate(resolve));
    caller.abort();
    await assert.rejects(running, { status: 401 }, "a cancelled caller is answered as signed out");
    assert.equal(aborted, 2, "both confirmations in flight were signalled");
  });
});

test("the favourites opt-out hides the destination without deleting the stored row and never touches resume", async () => {
  await withHarness(async (harness) => {
    await harness.manager.patchLibrary(harness.admin, harness.libraryId, { allowedUsers: [BOB] });
    await harness.personal.patch(harness.bob, harness.libraryId, "m1", { position: 30, duration: 100, favorite: true });
    assert.equal((await harness.personal.cards(harness.bob, { filter: "favorites" })).items.length, 1);

    await harness.manager.patchLibrary(harness.admin, harness.libraryId, { showInFavorites: false });
    assert.equal((await harness.personal.cards(harness.bob, { filter: "favorites" })).items.length, 0, "the favourites destination is off");
    const stored = harness.store.userData(BOB).remoteMedia as Record<string, unknown>;
    assert.equal(Object.keys(stored).length, 1, "the stored favourite row is kept, not deleted");
    assert.equal((await harness.personal.cards(harness.bob, { filter: "resume" })).items.length, 1, "resume is never governed by the favourites switch");

    await harness.manager.patchLibrary(harness.admin, harness.libraryId, { showInFavorites: true });
    assert.equal((await harness.personal.cards(harness.bob, { filter: "favorites" })).items.length, 1, "re-enabling brings the row back");
  });
});


test("folder personal-state writes are refused instead of returning a row that cannot be read", async () => {
  await withHarness(async (harness) => {
    harness.server.detailOf.f1 = { id: "f1", name: "Folder", type: "folder", providerIds: {} };
    harness.server.ancestorsOf.f1 = ["remote-1"];
    await assert.rejects(harness.personal.patch(harness.admin, harness.libraryId, "f1", { favorite: true }), { code: "invalid-input" });
  });
});
