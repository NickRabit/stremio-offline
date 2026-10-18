import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MediaResources, ResourceError } from "./media-resources.js";
import { MediaServerIndex } from "./media-server-index.js";
import { MediaServerManager, type MediaServerAuthority } from "./media-server-manager.js";
import { MediaServerPersonal, remoteTitleOf } from "./media-server-personal.js";
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
  detailOf: Record<string, ProviderItem> = {
    m1: movie("m1", "Alien"),
    s1: { id: "s1", name: "Show", type: "series", providerIds: {} },
    // Rows whose provider names a title the catalogue knows, and two episodes of one show.
    tm: { id: "tm", name: "Alien", type: "movie", providerIds: { imdb: "tt0078748" } },
    tm2: { id: "tm2", name: "Another film", type: "movie", providerIds: { tmdb: "348" } },
    ts: { id: "ts", name: "Show", type: "series", providerIds: { imdb: "tt0903747" } },
    te1: { id: "te1", name: "Show · One", type: "episode", seriesId: "ts", season: 1, episode: 1, providerIds: {} },
    te2: { id: "te2", name: "Show · Two", type: "episode", seriesId: "ts", season: 1, episode: 2, providerIds: {} },
  };
  ancestorsOf: Record<string, string[]> = {
    m1: ["remote-1"], s1: ["remote-1"], tm: ["remote-1"], tm2: ["remote-1"], ts: ["remote-1"],
    te1: ["remote-1", "ts"], te2: ["remote-1", "ts"],
  };
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
    reportPlayback: async () => { throw new MediaServerError("invalid-input", "unused"); },
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
  /** The same library attached over the other provider, so one rule can be read twice. */
  embyLibraryId: string;
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
  const embyConnection = await manager.createConnection(adminAuthority, {
    provider: "emby", name: "Home Emby", baseUrl: "http://emby.example", allowLan: false, allowLoopback: false,
    username: "reader", password: "reader-password",
  });
  const embyLibrary = await manager.attachLibrary(adminAuthority, embyConnection.id, { remoteId: "remote-1" });
  const personal = new MediaServerPersonal(store, manager);
  return {
    dir, store, manager, personal, server, libraryId: library.id, embyLibraryId: embyLibrary.id, connectionId: connection.id,
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

/** Forget the manager's own short metadata window, so the next read really goes upstream. */
const forgetMetadata = (h: Harness): void => {
  (h.manager as unknown as { metadata: Map<string, unknown> }).metadata.clear();
};

/** How many times the manager was asked for a row, which is what the show cache short-circuits. */
const countDetails = (h: Harness): (() => number) => {
  const real = h.manager.itemDetail.bind(h.manager);
  let reads = 0;
  (h.manager as unknown as { itemDetail: typeof real }).itemDetail = (...args) => { reads += 1; return real(...args); };
  return () => reads;
};

/** The stored record of one item, as the state holds it. */
const recordOf = (h: Harness, itemId: string, userId = ADA): Record<string, unknown> | undefined =>
  Object.values((h.store.userData(userId).remoteMedia ?? {}) as Record<string, Record<string, unknown>>)
    .find((row) => row.itemId === itemId);

const withHarness = async (run: (harness: Harness) => Promise<void>) => {
  const harness = await mount();
  try { await run(harness); } finally { await harness.close(); }
};

test("the title a provider row names reads like the catalogue's own identity", () => {
  assert.deepEqual(remoteTitleOf("movie", { imdb: "tt0078748", tmdb: "348" }), { type: "movie", id: "tt0078748" }, "an IMDb id wins");
  assert.deepEqual(remoteTitleOf("series", { tmdb: "1399" }), { type: "series", id: "tmdb:1399" }, "a numeric TMDb id becomes the tmdb form");
  assert.deepEqual(remoteTitleOf("movie", { imdb: "tt0078748".padEnd(80, "0") }), undefined, "an id beyond the stored bound is no title");
  assert.equal(remoteTitleOf("movie", { tvdb: "12345" }), undefined, "a TVDb id alone is not one");
  assert.equal(remoteTitleOf("movie", { imdb: "nope", tmdb: "12a" }), undefined);
  assert.equal(remoteTitleOf("series", {}), undefined);
});

/** The same rule over both providers the one code path serves. */
const providers = ["jellyfin", "emby"] as const;

test("a movie write stores the title its provider ids name", async () => {
  for (const provider of providers) {
    await withHarness(async (harness) => {
      const libraryId = provider === "jellyfin" ? harness.libraryId : harness.embyLibraryId;
      await harness.personal.patch(harness.admin, libraryId, "tm", { favorite: true });
      assert.deepEqual(recordOf(harness, "tm")?.title, { type: "movie", id: "tt0078748" }, provider);
      await harness.personal.patch(harness.admin, libraryId, "tm2", { favorite: true });
      assert.deepEqual(recordOf(harness, "tm2")?.title, { type: "movie", id: "tmdb:348" });
      // The card the lists draw carries the identity, so it merges with the same title's rows.
      const cards = await harness.personal.cards(harness.admin, { filter: "favorites" });
      assert.deepEqual(cards.items.find((card) => card.itemId === "tm")?.identity, { type: "movie", id: "tt0078748" }, provider);
    });
  }
});

test("an episode write stores its show's title, one parent read for the whole show", async () => {
  for (const provider of providers) {
    await withHarness(async (harness) => {
      const libraryId = provider === "jellyfin" ? harness.libraryId : harness.embyLibraryId;
      const reads = countDetails(harness);
      await harness.personal.patch(harness.admin, libraryId, "te1", { position: 10, duration: 100 });
      assert.deepEqual(recordOf(harness, "te1")?.title, { type: "series", id: "tt0903747" }, provider);
      const afterFirst = reads();
      assert.equal(afterFirst, 2, "the episode's own row and its show's");

      await harness.personal.patch(harness.admin, libraryId, "te2", { position: 10, duration: 100 });
      assert.deepEqual(recordOf(harness, "te2")?.title, { type: "series", id: "tt0903747" });
      assert.equal(reads(), afterFirst + 1, "the show was remembered, so only the second episode's own row was read");
    });
  }
});

test("a failing parent read keeps the previous title and the write still lands", async () => {
  await withHarness(async (harness) => {
    await harness.personal.patch(harness.admin, harness.libraryId, "te1", { position: 10, duration: 100 });
    assert.deepEqual(recordOf(harness, "te1")?.title, { type: "series", id: "tt0903747" });

    delete harness.server.detailOf.ts;
    forgetMetadata(harness);
    const patched = await harness.personal.patch(harness.admin, harness.libraryId, "te1", { position: 20, duration: 100 });

    assert.equal(patched.position, 20, "the position landed");
    assert.deepEqual(recordOf(harness, "te1")?.title, { type: "series", id: "tt0903747" }, "and the title it already had stayed");
  });
});

test("a malformed title is dropped, so it stands for nothing", async () => {
  await withHarness(async (harness) => {
    const state = await harness.personal.patch(harness.admin, harness.libraryId, "tm", { favorite: true });
    for (const junk of [{ type: "movie", id: "tvdb:1" }, { type: "channel", id: "tt123" }, { type: "movie" }, "tt123", null]) {
      await harness.store.update((data) => {
        const map = data.userData![ADA]!.remoteMedia as Record<string, Record<string, unknown>>;
        map[state.key]!.title = junk;
        map[state.key]!.favorite = false;
      });
      assert.equal((await harness.personal.read(harness.admin, harness.libraryId, "tm")).favorite, false, JSON.stringify(junk));
    }
  });
});

test("a remote star is the title's star, and the title's star reads on every record of it", async () => {
  for (const provider of providers) {
    await withHarness(async (harness) => {
      const libraryId = provider === "jellyfin" ? harness.libraryId : harness.embyLibraryId;
      await harness.personal.patch(harness.admin, libraryId, "te1", { favorite: true, position: 10, duration: 100 });
      const watchlist = harness.store.userData(ADA).watchlist as Record<string, { type: string; id: string; name: string }>;
      assert.deepEqual(Object.keys(watchlist), ["series:tt0903747"], provider);
      assert.deepEqual(
        { type: watchlist["series:tt0903747"]!.type, id: watchlist["series:tt0903747"]!.id, name: watchlist["series:tt0903747"]!.name },
        { type: "series", id: "tt0903747", name: "Show" },
        "the entry is the show's own, named by the parent row",
      );
      // The other episode of the same show is the same star, without a second entry.
      await harness.personal.patch(harness.admin, libraryId, "te2", { favorite: true, position: 10, duration: 100 });
      assert.deepEqual(Object.keys(harness.store.userData(ADA).watchlist!), ["series:tt0903747"]);
      assert.equal((await harness.personal.read(harness.admin, libraryId, "te2")).favorite, true);

      // Unstarring one version is unstarring the title: every record of it loses the flag.
      await harness.personal.patch(harness.admin, libraryId, "te1", { favorite: false });
      assert.deepEqual(Object.keys(harness.store.userData(ADA).watchlist!), []);
      assert.equal(recordOf(harness, "te2")?.favorite, false, "the other episode's own flag cleared with it");
      assert.equal((await harness.personal.read(harness.admin, libraryId, "te2")).favorite, false);
    });
  }
});

test("unstarring a remote title clears the library copies starred for it, and nothing else", async () => {
  await withHarness(async (harness) => {
    const titled = new MediaServerPersonal(harness.store, harness.manager, async () =>
      (path) => path === "lib_00000001/Show" ? "series:tt0903747" : path === "lib_00000001/Other" ? "movie:tt1" : undefined);
    await titled.patch(harness.admin, harness.libraryId, "te1", { favorite: true, position: 10, duration: 100 });
    await harness.store.update((state) => {
      const data = state.userData![ADA]! as { favorites?: string[] };
      data.favorites = ["lib_00000001/Show", "lib_00000001/Other", "lib_00000001/Loose.mkv"];
    });

    await titled.patch(harness.admin, harness.libraryId, "te1", { favorite: false });
    assert.deepEqual(harness.store.userData(ADA).favorites, ["lib_00000001/Other", "lib_00000001/Loose.mkv"]);
    assert.deepEqual(Object.keys(harness.store.userData(ADA).watchlist!), []);
  });
});

test("a record stored before titles were is given its title once, in the background", async () => {
  for (const provider of providers) {
    await withHarness(async (harness) => {
      const libraryId = provider === "jellyfin" ? harness.libraryId : harness.embyLibraryId;
      await harness.personal.patch(harness.admin, libraryId, "tm", { position: 60, duration: 600 });
      await harness.personal.patch(harness.admin, libraryId, "te1", { position: 60, duration: 600 });
      // As an older build stored them: no title on either record, and a star of its own on one.
      await harness.store.update((state) => {
        const map = state.userData![ADA]!.remoteMedia as Record<string, Record<string, unknown>>;
        for (const row of Object.values(map)) { delete row.title; if (row.itemId === "tm") row.favorite = true; }
      });
      const reads = countDetails(harness);

      const first = await harness.personal.cards(harness.admin, { filter: "resume" });
      assert.equal(first.items.some((card) => card.identity !== undefined), false, "the list is not held up by the read");
      await harness.personal.titleBackfill;
      assert.deepEqual(recordOf(harness, "tm")?.title, { type: "movie", id: "tt0078748" }, provider);
      assert.deepEqual(recordOf(harness, "te1")?.title, { type: "series", id: "tt0903747" }, "an episode stands for its show");
      assert.deepEqual(Object.keys(harness.store.userData(ADA).watchlist ?? {}), ["movie:tt0078748"], "the old star becomes the title's star");

      const second = await harness.personal.cards(harness.admin, { filter: "resume" });
      assert.deepEqual(second.items.map((card) => card.identity).filter(Boolean).length, 2, "the next list draws both titles");
      const after = reads();
      await harness.personal.cards(harness.admin, { filter: "resume" });
      assert.equal(reads(), after, "an item is asked about once");
    });
  }
});

test("a remote star given before stars were the title's becomes the title's star", async () => {
  await withHarness(async (harness) => {
    await harness.personal.patch(harness.admin, harness.libraryId, "tm", { favorite: true });
    // As an older build left it: the record starred and titled, the title not starred.
    await harness.store.update((state) => { (state.userData![ADA] as { watchlist?: unknown }).watchlist = {}; });

    await harness.personal.cards(harness.admin, { filter: "favorites" });
    await harness.personal.titleBackfill;
    assert.deepEqual(Object.keys(harness.store.userData(ADA).watchlist ?? {}), ["movie:tt0078748"]);
  });
});

test("a starred title is left out of the favourite cards before they are paged", async () => {
  await withHarness(async (harness) => {
    await harness.personal.patch(harness.admin, harness.libraryId, "tm", { favorite: true });
    await harness.personal.patch(harness.admin, harness.libraryId, "tm2", { favorite: true });

    const all = await harness.personal.cards(harness.admin, { filter: "favorites", limit: 1 });
    assert.equal(all.total, 2, "both stars are cards of their own until the title is drawn elsewhere");
    const filtered = await harness.personal.cards(harness.admin, { filter: "favorites", excludeTitles: new Set(["movie:tt0078748"]) });
    assert.deepEqual(filtered.items.map((card) => card.itemId), ["tm2"]);
    assert.equal(filtered.total, 1, "and the count is the filtered one");
  });
});

test("forgetting a title zeroes only the positions that stand for it", async () => {
  await withHarness(async (harness) => {
    await harness.personal.patch(harness.admin, harness.libraryId, "tm", { position: 30, duration: 100, favorite: true, watched: true });
    await harness.personal.patch(harness.admin, harness.libraryId, "te1", { position: 10, duration: 100 });
    await harness.personal.patch(harness.admin, harness.libraryId, "te2", { position: 20, duration: 100 });

    await harness.personal.forgetTitlePositions(ADA, new Set(["movie:tt0078748"]));
    assert.equal(recordOf(harness, "tm")?.position, 0, "the film's own position went");
    assert.equal(recordOf(harness, "tm")?.favorite, true, "its star stayed");
    assert.equal(recordOf(harness, "tm")?.watched, true, "and so did its watched flag");
    assert.equal(recordOf(harness, "te1")?.position, 10, "another title is untouched");

    await harness.personal.forgetTitlePositions(ADA, new Set(["series:tt0903747:1:2"]));
    assert.equal(recordOf(harness, "te2")?.position, 0, "the exact episode went");
    assert.equal(recordOf(harness, "te1")?.position, 10, "and the other episode of the show kept its place");
    // A title that is not stored at all, and an empty set, are both no-ops.
    await harness.personal.forgetTitlePositions(ADA, new Set(["movie:tt0000000"]));
    await harness.personal.forgetTitlePositions(ADA, new Set());
    assert.equal(recordOf(harness, "tm2"), undefined);
    assert.equal(recordOf(harness, "te1")?.position, 10);
  });
});

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

test("a card of a row with a Thumb carries the Thumb, the card of a row without one the Backdrop", async () => {
  await withHarness(async (harness) => {
    harness.server.detailOf.m1 = { ...movie("m1", "Alien"), thumbImageTag: "thumb-1" };
    await harness.personal.patch(harness.admin, harness.libraryId, "m1", { position: 12, duration: 100 });
    // A second row whose provider reports no Thumb keeps the Backdrop it always drew.
    harness.server.detailOf.m2 = { ...movie("m2", "Aliens"), backdropImageTag: "back-2" };
    harness.server.ancestorsOf.m2 = ["remote-1"];
    await harness.personal.patch(harness.admin, harness.libraryId, "m2", { position: 5, duration: 100 });

    const resume = await harness.personal.cards(harness.admin, { filter: "resume" });
    const byItem = new Map(resume.items.map((card) => [card.itemId, card]));
    assert.match(byItem.get("m1")!.wide!, /\/items\/m1\/artwork\/Thumb$/);
    assert.match(byItem.get("m2")!.wide!, /\/items\/m2\/artwork\/Backdrop$/);
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
