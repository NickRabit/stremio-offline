import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MediaResources, ResourceError } from "./media-resources.js";
import type { LibraryRecord } from "./libraries.js";
import { MediaServerIndex } from "./media-server-index.js";
import { isRemoteDownloadReference, type RemoteDownloadReference } from "./media-server-download.js";
import { MediaServerManager, type MediaServerAuthority } from "./media-server-manager.js";
import { remoteIdsMatch } from "./media-server-match.js";
import type { MediaServerProvider, ProviderItem, ProviderLibrary, ProviderVersion, RemoteAccountPolicy } from "./media-server-provider.js";
import { openRemoteContent } from "./media-server-reference.js";
import { MediaServerSecrets } from "./media-server-secrets.js";
import { MediaServerSources } from "./media-server-sources.js";
import type { MediaServerTransport } from "./media-server-security.js";
import { MediaServerError } from "./media-server-types.js";
import { Store } from "./store.js";
import type { AddonDownloadSettings, DownloadTargetSettings } from "./types.js";
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
const carol = account({ id: CAROL, username: "carol", permissions: { downloadToLibrary: false, downloadToDevice: true } });

class FakeServer {
  serverId = "server-1";
  accountId = "account-1";
  token = "token-value-1";
  policy: RemoteAccountPolicy = { disabled: false, mediaPlayback: true, allFolders: true, folderIds: [], hasAdditionalRestrictions: false };
  libraries: ProviderLibrary[] = [{ id: "remote-1", name: "Movies", type: "movie" }];
  detailOf: Record<string, ProviderItem> = {};
  ancestorsOf: Record<string, string[]> = {};
  versionsOf: Record<string, ProviderVersion[]> = {};
  items: Record<string, ProviderItem[]> = {};
  directories: Record<string, ProviderItem[]> = {};
  originalCalls = 0;
  originalCancels = 0;
  /** Runs inside the original request, before its response is handed back, so a test can change
   *  the records while the manager is awaiting the transport. */
  onOriginal?: () => Promise<void>;
  onVersions?: () => Promise<void>;
  assetResult: { bytes: Uint8Array; contentType: string } | undefined;
  assetRequests: Array<Record<string, unknown>> = [];

  async run(): Promise<void> { /* no scheduling seams in this harness */ }
}

const clone = <T>(value: T): T => structuredClone(value);

const stubProvider = (server: FakeServer): MediaServerProvider => ({
  verifyIdentity: async () => { await server.run(); return { serverId: server.serverId, version: "1.0.0" }; },
  authenticate: async () => { await server.run(); return { serverId: server.serverId, accountId: server.accountId, token: server.token }; },
  logout: async () => { await server.run(); },
  currentAccount: async () => { await server.run(); return { accountId: server.accountId, policy: clone(server.policy) }; },
  listLibraries: async () => { await server.run(); return clone(server.libraries); },
  pageItems: async (_token, _account, libraryId) => { await server.run(); return { items: clone(server.items[libraryId] ?? []), total: (server.items[libraryId] ?? []).length }; },
  pageDirectory: async (_token, _account, parentId) => { await server.run(); return { items: clone(server.directories[parentId] ?? []), total: (server.directories[parentId] ?? []).length }; },
  findByProviderIds: async (_token, _account, libraryId, ids, type) => {
    await server.run();
    return clone((server.items[libraryId] ?? []).filter((item) => item.type === type && remoteIdsMatch(ids, item.providerIds)));
  },
  detail: async (_token, _account, itemId) => {
    await server.run();
    const item = server.detailOf[itemId];
    if (!item) throw new MediaServerError("not-found", "no such item");
    return clone(item);
  },
  ancestors: async (_token, _account, itemId) => { await server.run(); return [...(server.ancestorsOf[itemId] ?? [])]; },
  versions: async (_token, _account, itemId) => {
    await server.run();
    await server.onVersions?.();
    return clone(server.versionsOf[itemId] ?? []);
  },
  playbackInfo: async (_token, _account, itemId) => {
    await server.run();
    return {
      mediaSources: (server.versionsOf[itemId] ?? []).map((version) => ({
        id: version.id,
        ...(version.bitrate === undefined ? {} : { bitrate: version.bitrate }),
        supportsDirectPlay: true,
        supportsDirectStream: false,
        supportsTranscoding: false,
      })),
    };
  },
  reportPlayback: async () => { throw new Error("the stub provider does not report playback"); },
});

const stubTransport = (server: FakeServer): MediaServerTransport => ({
  requestJson: async () => { throw new Error("the stub provider does not use the transport"); },
  requestAsset: async (request) => {
    server.assetRequests.push(request as unknown as Record<string, unknown>);
    await server.run();
    if (!server.assetResult) throw new Error("no asset response is configured");
    return { bytes: server.assetResult.bytes, contentType: server.assetResult.contentType };
  },
  requestArtwork: async () => { throw new Error("no artwork lane is used in this harness"); },
  requestOriginal: async () => {
    server.originalCalls += 1;
    await server.onOriginal?.();
    return new Response(new ReadableStream<Uint8Array>({ cancel: () => { server.originalCancels += 1; } }), { status: 200, headers: { "content-range": "bytes 0-0/1" } });
  },
  noteRateLimit: () => undefined,
  close: async () => undefined,
});

interface Harness {
  store: Store;
  manager: MediaServerManager;
  sources: MediaServerSources;
  resources: MediaResources;
  server: FakeServer;
  adminAuthority: MediaServerAuthority;
  bobAuthority: MediaServerAuthority;
  carolAuthority: MediaServerAuthority;
  connectionId: string;
  libraryId: string;
  owner: { userId: string; sid: string; expiresAt: number };
  bobOwner: { userId: string; sid: string; expiresAt: number };
  carolOwner: { userId: string; sid: string; expiresAt: number };
  close(): Promise<void>;
}

const mount = async (options: { contentDownloading?: boolean; clock?: () => number } = {}): Promise<Harness> => {
  const dir = await mkdtemp(path.join(tmpdir(), "media-sources-"));
  const users = [admin, bob, carol];
  await writeFile(path.join(dir, "state.json"), JSON.stringify({
    schemaVersion: 3, addons: [], settings: {}, defaultsInstalled: true, users,
    userData: Object.fromEntries(users.map((user) => [user.id, emptyUserData()])), libraries: [],
  }));
  const keyFile = path.join(dir, "secret.key");
  await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
  const store = new Store(dir, dir);
  await store.load();
  const vault = new MediaServerSecrets(path.join(dir, "vault"), keyFile);
  const server = new FakeServer();
  // The fact is set before the connection is made, because the runtime caches the account policy
  // for a short window; a test that wants the permission must grant it before the first proof.
  if (options.contentDownloading !== undefined) {
    server.policy = { ...server.policy, contentDownloading: options.contentDownloading };
  }
  const manager = new MediaServerManager(store, vault, {
    providerFactory: () => stubProvider(server),
    transportFactory: () => stubTransport(server),
    index: new MediaServerIndex(),
    networkStartIntervalMs: 0,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  await manager.initialize();

  let revoked = false;
  const authority = (user: UserRecord): MediaServerAuthority => ({
    actor: { id: user.id, secret: user.secret },
    assertCurrent: () => { if (revoked) throw new ResourceError(401, "AUTH_REQUIRED"); },
  });
  const adminAuthority = authority(admin);
  const bobAuthority = authority(bob);
  const carolAuthority = authority(carol);

  const connection = await manager.createConnection(adminAuthority, {
    provider: "jellyfin", name: "Home", baseUrl: "http://media.example", allowLan: false, allowLoopback: false,
    username: "reader", password: "reader-password",
  });
  const attached = await manager.attachLibrary(adminAuthority, connection.id, { remoteId: "remote-1" });
  // The ordinary accounts hold the grant they exercise: an administrator sees the library
  // regardless, which keeps every existing read on the same record.
  const library = await manager.patchLibrary(adminAuthority, attached.id, { allowedUsers: [BOB, CAROL] });
  server.detailOf["item-1"] = { id: "item-1", name: "Movie One", type: "movie", providerIds: {} };
  server.ancestorsOf["item-1"] = ["remote-1"];
  server.versionsOf["item-1"] = [{ id: "v1", name: "1080p", container: "mkv", size: 200_000 }, { id: "v2", name: "720p" }];

  const resources = new MediaResources();
  const sources = new MediaServerSources(store, manager, resources);
  return {
    store, manager, sources, resources, server, adminAuthority, bobAuthority,
    connectionId: connection.id, libraryId: library.id,
    owner: { userId: admin.id, sid: "admin-sid", expiresAt: Date.now() + 3_600_000 },
    bobOwner: { userId: bob.id, sid: "bob-sid", expiresAt: Date.now() + 3_600_000 },
    carolAuthority,
    carolOwner: { userId: carol.id, sid: "carol-sid", expiresAt: Date.now() + 3_600_000 },
    close: async () => { await manager.close(); await rm(dir, { recursive: true, force: true }); },
  };
};

const withHarness = async (run: (harness: Harness) => Promise<void>, options: { contentDownloading?: boolean; clock?: () => number } = {}) => {
  const harness = await mount(options);
  try { await run(harness); }
  finally { await harness.close(); }
};

const streamOf = (harness: Harness, sourceId: string) => harness.resources.get(sourceId, harness.owner.sid, "source").stream;

test("list mints verified public sources without leaking the internal address", async () => {
  await withHarness(async (harness) => {
    const listed = await harness.sources.list(harness.adminAuthority, harness.owner, harness.libraryId, "item-1");
    assert.deepEqual(listed.map((item) => item.name), ["1080p", "720p"], "provider version order is kept");
    const first = listed[0]!;
    assert.equal(first.kind, "remote");
    assert.equal(first.playable, true);
    assert.equal(first.provider, "jellyfin");
    assert.equal(first.libraryId, harness.libraryId);
    assert.equal(first.libraryName, "Movies");
    assert.equal(first.behaviorHints?.videoSize, 200_000);
    assert.equal(listed[1]!.behaviorHints?.videoSize, undefined);
    assert.equal(first.capabilities?.downloadToLibrary, false);
    assert.equal(first.capabilities?.downloadToDevice, false);
    assert.ok(first.remoteItem);
    assert.equal(first.remoteItem!.itemId, "item-1");
    assert.equal(first.remoteItem!.mediaSourceId, "v1");
    assert.equal(first.remoteItem!.libraryId, harness.libraryId);
    assert.match(first.remoteItem!.progressKey, /^remote:[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(listed).includes("media-server:"), false);
    assert.equal(openedRef(harness, first.sourceId)?.libraryId, harness.libraryId);
  });
});

test("a listed version carries its known audio and subtitle languages", async () => {
  await withHarness(async (harness) => {
    harness.server.versionsOf["item-1"] = [{
      id: "v1",
      name: "Remote Rules Fixture S01E01",
      audioLanguages: ["cze", "und", "eng", "cs", undefined],
      embeddedSubtitleLanguages: ["und", "cze"],
      externalSubtitles: [{ index: 2, language: "cze" }],
    }];

    const [listed] = await harness.sources.list(harness.adminAuthority, harness.owner, harness.libraryId, "item-1");
    assert.deepEqual(listed!.audioLanguages, ["cs", "en"]);
    assert.deepEqual(listed!.subtitleLanguages, ["cs"]);
    assert.equal(listed!.audioLanguagesGuessed, undefined);
  });
});

test("a listed version with untagged audio marks its name-based language as guessed", async () => {
  await withHarness(async (harness) => {
    harness.server.versionsOf["item-1"] = [{
      id: "v1",
      name: "Remote Rules Fixture S01E01 CZ",
      audioLanguages: ["und", undefined],
    }];

    const [listed] = await harness.sources.list(harness.adminAuthority, harness.owner, harness.libraryId, "item-1");
    assert.deepEqual(listed!.audioLanguages, ["cs"]);
    assert.equal(listed!.audioLanguagesGuessed, true);
    assert.equal(listed!.subtitleLanguages, undefined);
  });
});

const openedRef = (harness: Harness, sourceId: string) => openRemoteContent(streamOf(harness, sourceId).url);

test("a granted native account projects the copy and device capabilities on an original", async () => {
  await withHarness(async (harness) => {
    const listed = await harness.sources.list(harness.adminAuthority, harness.owner, harness.libraryId, "item-1");
    assert.equal(listed.length, 2, "both versions are listed");
    for (const source of listed) {
      assert.deepEqual(source.capabilities, {
        rename: false, move: false, delete: false, identify: false, writeArtwork: false,
        downloadToLibrary: true, downloadToDevice: true,
      }, "the media server's own flag and the account's own rights project both downloads");
    }
    assert.equal(harness.server.originalCalls, 0, "the projection costs no extra provider read");
  }, { contentDownloading: true });
});

/** One local library as the store keeps it; the projection reads these records and nothing else. */
const localLibrary = (
  id: string,
  type: "movie" | "series" | "mixed",
  over: Record<string, unknown> = {},
): LibraryRecord => ({
  id, name: id, type, root: `/downloads/${id}`, enabled: true, order: 0,
  addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: false, ...over,
});

/** The state a projection test starts from: local libraries on disk and settings that name one. */
const seedLocal = async (harness: Harness, libraries: LibraryRecord[], settings: Record<string, string> = {}) => {
  await harness.store.update((state) => {
    state.libraries = libraries;
    state.settings = { ...state.settings, ...settings };
  });
};

const configureCopy = async (harness: Harness, downloadLibraryId: string) => {
  await harness.store.update((state) => {
    state.remoteLibraries = (state.remoteLibraries ?? []).map((library) =>
      library.id === harness.libraryId ? { ...library, downloadLibraryId } : library);
  });
};

/** Store the two per-kind storage rules on the attached library, as the editor saves them. */
const configureRules = async (harness: Harness, movie: Partial<DownloadTargetSettings>, series: Partial<DownloadTargetSettings>) => {
  const rules: AddonDownloadSettings = {
    movie: { subfolder: "", layout: "structured", ...movie },
    series: { subfolder: "", layout: "structured", ...series },
  };
  await harness.store.update((state) => {
    state.remoteLibraries = (state.remoteLibraries ?? []).map((library) =>
      library.id === harness.libraryId ? { ...library, downloadSettings: rules } : library);
  });
};

test("a stored rule projects its whole target, layout and subfolder, and costs no provider read", async () => {
  await withHarness(async (harness) => {
    const films = localLibrary("lib_a1b2c3d4", "movie");
    await seedLocal(harness, [films]);
    await configureRules(harness, { subfolder: "Filmy/2024", layout: "flat", libraryId: films.id }, { libraryId: films.id });

    const before = harness.server.originalCalls;
    const listed = await harness.sources.list(harness.adminAuthority, harness.owner, harness.libraryId, "item-1");
    for (const source of listed) {
      assert.deepEqual(source.downloadTarget, { subfolder: "Filmy/2024", layout: "flat", libraryId: films.id });
      assert.equal(source.downloadLibraryId, films.id, "the library handle stays on the source for older clients");
    }
    assert.equal(harness.server.originalCalls, before, "the rule projection adds no provider read");
  }, { contentDownloading: true });
});

test("a mixed library's rule follows the item's own kind", async () => {
  let now = 3_000_000;
  await withHarness(async (harness) => {
    const films = localLibrary("lib_a1b2c3d4", "movie", { visibleTo: [BOB] });
    const shows = localLibrary("lib_b2c3d4e5", "series", { visibleTo: [BOB] });
    await seedLocal(harness, [films, shows]);
    await harness.store.update((state) => {
      state.remoteLibraries = (state.remoteLibraries ?? []).map((entry) => entry.id === harness.libraryId
        ? { ...entry, type: "mixed", downloadSettings: { movie: { subfolder: "Filmy", layout: "flat", libraryId: films.id }, series: { subfolder: "Serialy", layout: "structured", libraryId: shows.id } } }
        : entry);
    });

    // item-1 is a movie, so the movie slot is projected.
    const listed = await harness.sources.list(harness.bobAuthority, harness.bobOwner, harness.libraryId, "item-1");
    for (const source of listed) assert.deepEqual(source.downloadTarget, { subfolder: "Filmy", layout: "flat", libraryId: films.id });

    // The same library's rule for an episode follows the series slot.
    now += 30_000;
    harness.server.detailOf["item-1"] = { id: "item-1", name: "Episode One", type: "episode", providerIds: {} };
    const episodes = await harness.sources.list(harness.bobAuthority, harness.bobOwner, harness.libraryId, "item-1");
    for (const source of episodes) assert.deepEqual(source.downloadTarget, { subfolder: "Serialy", layout: "structured", libraryId: shows.id });
  }, { contentDownloading: true, clock: () => now });
});

test("a stored rule whose library the acting account cannot see is never projected", async () => {
  await withHarness(async (harness) => {
    const hidden = localLibrary("lib_d4e5f6a7", "movie", { visibleTo: [] });
    const mine = localLibrary("lib_e5f6a7b8", "movie", { visibleTo: [BOB] });
    await seedLocal(harness, [hidden, mine]);
    await configureRules(harness, { subfolder: "Filmy", layout: "flat", libraryId: hidden.id }, { libraryId: hidden.id });

    const listed = await harness.sources.list(harness.bobAuthority, harness.bobOwner, harness.libraryId, "item-1");
    for (const source of listed) {
      assert.equal(source.capabilities?.downloadToLibrary, true, "bob may copy");
      assert.equal(source.downloadTarget, undefined, "a destination he cannot see is never exposed");
    }

    await configureRules(harness, { subfolder: "Filmy", layout: "flat", libraryId: mine.id }, { libraryId: mine.id });
    const visible = await harness.sources.list(harness.bobAuthority, harness.bobOwner, harness.libraryId, "item-1");
    for (const source of visible) assert.deepEqual(source.downloadTarget, { subfolder: "Filmy", layout: "flat", libraryId: mine.id });
  }, { contentDownloading: true });
});

test("a native original carries the copy destination the server resolved for it", async () => {
  await withHarness(async (harness) => {
    const films = localLibrary("lib_a1b2c3d4", "movie");
    const other = localLibrary("lib_b2c3d4e5", "movie");
    await seedLocal(harness, [other, films], { defaultMovieLibrary: other.id });
    await configureCopy(harness, films.id);

    const listed = await harness.sources.list(harness.adminAuthority, harness.owner, harness.libraryId, "item-1");
    for (const source of listed) assert.equal(source.downloadLibraryId, films.id, "the configured destination rides along");
  }, { contentDownloading: true });
});

test("without a configured destination the kind's own default is projected", async () => {
  await withHarness(async (harness) => {
    const films = localLibrary("lib_a1b2c3d4", "movie");
    await seedLocal(harness, [films], { defaultMovieLibrary: films.id });

    const listed = await harness.sources.list(harness.adminAuthority, harness.owner, harness.libraryId, "item-1");
    for (const source of listed) assert.equal(source.downloadLibraryId, films.id);
  }, { contentDownloading: true });
});

for (const [label, over] of [
  ["read-only", { readOnly: true }],
  ["switched off", { enabled: false }],
  ["away", { unreachable: true }],
] as const) {
  test(`a configured destination that is ${label} is not projected, and is never swapped`, async () => {
    await withHarness(async (harness) => {
      const stored = localLibrary(`lib_${"a".repeat(8)}`, "movie", over);
      const fallback = localLibrary("lib_b2c3d4e5", "movie");
      await seedLocal(harness, [stored, fallback]);
      await configureCopy(harness, stored.id);

      const listed = await harness.sources.list(harness.adminAuthority, harness.owner, harness.libraryId, "item-1");
      for (const source of listed) {
        assert.equal(source.downloadLibraryId, undefined, `an unusable stored destination is never replaced by ${fallback.id}`);
        assert.equal(source.capabilities?.downloadToLibrary, true, "a bad default never takes the capability away");
      }
    }, { contentDownloading: true });
  });
}

test("a destination of the wrong kind is not projected", async () => {
  await withHarness(async (harness) => {
    const shows = localLibrary("lib_c3d4e5f6", "series");
    await seedLocal(harness, [shows]);
    await configureCopy(harness, shows.id);

    const listed = await harness.sources.list(harness.adminAuthority, harness.owner, harness.libraryId, "item-1");
    for (const source of listed) assert.equal(source.downloadLibraryId, undefined, "a movie remote never points at a series library");
  }, { contentDownloading: true });
});

test("a destination the acting account cannot see is not projected for it", async () => {
  await withHarness(async (harness) => {
    const hidden = localLibrary("lib_d4e5f6a7", "movie", { visibleTo: [] });
    const mine = localLibrary("lib_e5f6a7b8", "movie", { visibleTo: [BOB] });
    await seedLocal(harness, [hidden, mine]);
    await configureCopy(harness, hidden.id);

    const listed = await harness.sources.list(harness.bobAuthority, harness.bobOwner, harness.libraryId, "item-1");
    for (const source of listed) {
      assert.equal(source.capabilities?.downloadToLibrary, true, "bob may copy");
      assert.equal(source.downloadLibraryId, undefined, "a destination he cannot see is never exposed, even with the right");
    }

    await configureCopy(harness, mine.id);
    const visible = await harness.sources.list(harness.bobAuthority, harness.bobOwner, harness.libraryId, "item-1");
    for (const source of visible) assert.equal(source.downloadLibraryId, mine.id, "a destination he can see is exposed");
  }, { contentDownloading: true });
});

test("a missing or false native flag never projects the copy capability", async () => {
  for (const contentDownloading of [false, undefined]) {
    await withHarness(async (harness) => {
      const listed = await harness.sources.list(harness.adminAuthority, harness.owner, harness.libraryId, "item-1");
      for (const source of listed) assert.equal(source.capabilities?.downloadToLibrary, false, "an absent fact is not a permission");
    }, contentDownloading === undefined ? {} : { contentDownloading });
  }
});

test("an account without the local-copy right never gets the capability", async () => {
  await withHarness(async (harness) => {
    const listed = await harness.sources.list(harness.carolAuthority, harness.carolOwner, harness.libraryId, "item-1");
    assert.equal(listed.length, 2, "the grant names carol, so the versions are listed");
    for (const source of listed) assert.equal(source.capabilities?.downloadToLibrary, false, "the account's own right is required too");
  }, { contentDownloading: true });
});

test("a version's container decides the copy's file name, never the display label", async () => {
  await withHarness(async (harness) => {
    harness.server.versionsOf["item-1"] = [
      { id: "v1", name: "Version1", container: "mkv" },
      { id: "v2", name: "Version2.mp4", container: "mkv" },
      { id: "v3", name: "Version3", container: "../../etc/passwd" },
      { id: "v4", name: "Version4" },
      { id: "v5", name: "Version5.mkv", container: "mkv" },
    ];
    const listed = await harness.sources.list(harness.adminAuthority, harness.owner, harness.libraryId, "item-1");
    assert.deepEqual(listed.map((item) => item.behaviorHints?.filename),
      ["Version1.mkv", "Version2.mkv", "Version3", "Version4", "Version5.mkv"],
      "an accepted container sets the extension, an unsafe one never does, and nothing is doubled");
    assert.deepEqual(listed.map((item) => item.name),
      ["Version1", "Version2.mp4", "Version3", "Version4", "Version5.mkv"],
      "the display label stays the provider's own");
    assert.equal(JSON.stringify(listed).includes("passwd"), false, "an arbitrary container never reaches a name");
    assert.equal(JSON.stringify(listed).includes("media-server:"), false, "no sealed address is exposed");
  });
});

test("list refuses an owner that is not the acting account", async () => {
  await withHarness(async (harness) => {
    const other = { ...harness.owner, userId: BOB };
    await assert.rejects(harness.sources.list(harness.adminAuthority, other, harness.libraryId, "item-1"), { status: 404 });
  });
});

test("assertCurrent binds the sealed source to the exact owner session", async () => {
  await withHarness(async (harness) => {
    const [first] = await harness.sources.list(harness.adminAuthority, harness.owner, harness.libraryId, "item-1");
    const stream = streamOf(harness, first!.sourceId);
    harness.sources.assertCurrent(stream, harness.owner);
    assert.throws(() => harness.sources.assertCurrent(stream, { ...harness.owner, sid: "other" }), { status: 404 });
    assert.throws(() => harness.sources.assertCurrent(stream, { ...harness.owner, userId: BOB }), { status: 404 });
    assert.throws(() => harness.sources.assertCurrent({ ...stream, url: `${stream.url}x` }, harness.owner), { status: 404 });
    assert.throws(() => harness.sources.assertCurrent({ url: "media-server:garbage" }, harness.owner), { status: 404 });
    harness.sources.assertCurrent({ url: "https://example.test/a.mp4" }, harness.owner);
  });
});

test("authorize and open re-prove the source and refuse once the connection is disabled", async () => {
  await withHarness(async (harness) => {
    const [first] = await harness.sources.list(harness.adminAuthority, harness.owner, harness.libraryId, "item-1");
    const stream = streamOf(harness, first!.sourceId);
    await harness.sources.authorize(stream, harness.owner);
    const response = await harness.sources.open(stream, harness.owner, { method: "GET", range: "bytes=0-0" });
    assert.equal(response.status, 200);
    assert.equal(harness.server.originalCalls, 1);
    await harness.manager.patchConnection(harness.adminAuthority, harness.connectionId, { enabled: false });
    assert.throws(() => harness.sources.assertCurrent(stream, harness.owner), { status: 404 });
    await assert.rejects(harness.sources.authorize(stream, harness.owner), { status: 404 });
    await assert.rejects(harness.sources.open(stream, harness.owner, { method: "GET" }), { status: 404 });
    assert.equal(harness.server.originalCalls, 1, "no bytes were requested after the connection was disabled");
  });
});

test("a generic stream cannot invent remote provenance", async () => {
  await withHarness(async (harness) => {
    const forged = {
      url: "https://example.test/movie.mp4",
      provider: "emby", libraryId: "rlib_00000000000000000000000000000001",
      capabilities: { rename: true, move: true, delete: true, identify: true, writeArtwork: true, downloadToLibrary: true, downloadToDevice: true },
      remoteItem: { libraryId: "rlib_x", itemId: "x", mediaSourceId: "x", progressKey: "remote:x" },
    } as never;
    const [listed] = harness.resources.listing([forged], harness.owner);
    assert.equal(listed!.provider, undefined);
    assert.equal(listed!.libraryId, undefined);
    assert.equal(listed!.remoteItem, undefined);
    assert.equal(listed!.capabilities, undefined);
  });
});

test("list mints sealed external subtitles that only the owner scope admits", async () => {
  await withHarness(async (harness) => {
    harness.server.versionsOf["item-1"] = [
      { id: "v1", name: "1080p", externalSubtitles: [{ index: 2, language: "eng", title: "English" }] },
      { id: "v2", name: "720p" },
    ];
    harness.server.assetResult = { bytes: new TextEncoder().encode("1\n00:00:01,000 --> 00:00:02,000\nHi\n"), contentType: "application/x-subrip" };
    const listed = await harness.sources.list(harness.adminAuthority, harness.owner, harness.libraryId, "item-1");
    assert.deepEqual(listed.map((item) => item.subtitles.length), [1, 0]);
    const subtitle = listed[0]!.subtitles[0]!;
    assert.equal(subtitle.lang, "eng");
    assert.equal(subtitle.title, "English");
    assert.equal(JSON.stringify(subtitle).includes("media-server:"), false, "the sealed address never leaves the server");
    const subtitleStream = harness.resources.get(subtitle.subtitleId, harness.owner.sid, "subtitle").stream;
    assert.equal(openRemoteContent(subtitleStream.url)?.subtitleIndex, 2);
    assert.equal((await harness.sources.readSubtitle(subtitleStream, harness.owner)).contentType, "application/x-subrip");
    assert.deepEqual(harness.server.assetRequests.at(-1), { kind: "subtitle", itemId: "item-1", mediaSourceId: "v1", index: 2 });
    // An original is never admitted as a subtitle, and a subtitle never as media.
    const mediaStream = streamOf(harness, listed[0]!.sourceId);
    assert.throws(() => harness.resources.add(mediaStream, harness.owner, "subtitle"), { status: 404 });
    assert.throws(() => harness.resources.add(subtitleStream, harness.owner, "media"), { status: 404 });
    assert.throws(() => harness.resources.add(subtitleStream, harness.owner, "source"), { status: 404 });
    // A generic stream cannot smuggle a sealed address in as a subtitle.
    const [generic] = harness.resources.listing([{ url: "https://example.test/a.mp4", subtitles: [{ url: "media-server:garbage" }] }], harness.owner);
    assert.deepEqual(generic!.subtitles, []);
  });
});

test("readSubtitle refuses a media reference and drops once the provider index changes", async () => {
  await withHarness(async (harness) => {
    harness.server.versionsOf["item-1"] = [{ id: "v1", name: "1080p", externalSubtitles: [{ index: 2 }] }];
    harness.server.assetResult = { bytes: new TextEncoder().encode("1\n00:00:01,000 --> 00:00:02,000\nHi\n"), contentType: "application/x-subrip" };
    const [listed] = await harness.sources.list(harness.adminAuthority, harness.owner, harness.libraryId, "item-1");
    const subtitleStream = harness.resources.get(listed!.subtitles[0]!.subtitleId, harness.owner.sid, "subtitle").stream;
    await assert.rejects(harness.sources.readSubtitle(streamOf(harness, listed!.sourceId), harness.owner), { status: 404 }, "an original is not a subtitle");
    harness.server.versionsOf["item-1"] = [{ id: "v1", name: "1080p", externalSubtitles: [{ index: 5 }] }];
    await assert.rejects(harness.sources.readSubtitle(subtitleStream, harness.owner), { code: "not-found" }, "the exact index has to still be listed");
  });
});

test("matched mints only the verified versions behind an exact id", async () => {
  await withHarness(async (harness) => {
    harness.server.items["remote-1"] = [{ id: "item-1", name: "Movie One", type: "movie", providerIds: { imdb: "tt1" } }];
    harness.server.detailOf["item-1"] = { id: "item-1", name: "Movie One", type: "movie", providerIds: { imdb: "tt1" } };
    harness.server.versionsOf["item-1"] = [{ id: "v1", name: "1080p" }];
    const listed = await harness.sources.matched(harness.adminAuthority, harness.owner, harness.libraryId, "movie", "tt1");
    assert.deepEqual(listed.map((item) => item.name), ["1080p"]);
    const addonSpecific = await harness.sources.matched(harness.adminAuthority, harness.owner, harness.libraryId, "movie", "mpa:webshare-index:tt1");
    assert.deepEqual(addonSpecific.map((item) => item.name), ["1080p"]);
    assert.deepEqual(await harness.sources.matched(harness.adminAuthority, harness.owner, harness.libraryId, "movie", "tt9"), []);
  });
});

const downloadRefOf = async (harness: Harness, sourceId: string) =>
  harness.sources.downloadReference(streamOf(harness, sourceId), harness.owner);

const downloadReferenceOf = (harness: Harness): RemoteDownloadReference => ({
  schemaVersion: 1, ownerUserId: ADA, connectionId: harness.connectionId, libraryId: harness.libraryId,
  generation: harness.store.mediaConnections()[0]!.generation, provider: "jellyfin", serverId: "server-1",
  accountId: "account-1", itemId: "item-1", mediaSourceId: "v1",
});

test("downloadCandidates returns canonical owner references and sanitized streams without URLs", async () => {
  await withHarness(async (harness) => {
    harness.server.items["remote-1"] = [{ id: "item-1", name: "Movie One", type: "movie", providerIds: { imdb: "tt1" } }];
    harness.server.detailOf["item-1"] = { id: "item-1", name: "Movie One", type: "movie", providerIds: { imdb: "tt1" } };
    harness.server.versionsOf["item-1"] = [
      { id: "v1", name: "Movie.1080p", container: "mkv", size: 200_000 },
      { id: "v2", name: "Movie.720p", container: "mp4", size: 100_000 },
    ];

    const candidates = await harness.sources.downloadCandidates({
      ownerUserId: ADA,
      libraryId: harness.libraryId,
      type: "movie",
      catalogId: "tt1",
    });

    assert.deepEqual(candidates.map((candidate) => candidate.reference), [
      downloadReferenceOf(harness),
      { ...downloadReferenceOf(harness), mediaSourceId: "v2" },
    ]);
    assert.deepEqual(candidates.map((candidate) => candidate.stream), [
      {
        name: "Movie.1080p",
        behaviorHints: { filename: "Movie.1080p.mkv", videoSize: 200_000 },
      },
      {
        name: "Movie.720p",
        behaviorHints: { filename: "Movie.720p.mp4", videoSize: 100_000 },
      },
    ]);
    assert.ok(candidates.every((candidate) => !("url" in candidate.stream)));
    assert.doesNotMatch(JSON.stringify(candidates), /https?:|token|secret|expiresAt|sid|media-server:/i);
    assert.equal(harness.server.originalCalls, 0, "discovery never opens original bytes");
  }, { contentDownloading: true });
});

test("downloadCandidates answers nothing without a current owner or copy right", async () => {
  await withHarness(async (harness) => {
    harness.server.items["remote-1"] = [{ id: "item-1", name: "Movie One", type: "movie", providerIds: { imdb: "tt1" } }];
    harness.server.detailOf["item-1"] = { id: "item-1", name: "Movie One", type: "movie", providerIds: { imdb: "tt1" } };
    harness.server.versionsOf["item-1"] = [{ id: "v1", name: "1080p" }];
    const input = {
      ownerUserId: BOB,
      libraryId: harness.libraryId,
      type: "movie" as const,
      catalogId: "tt1",
    };

    await harness.store.update((state) => {
      state.users = state.users?.map((user) => user.id === BOB ? { ...user, disabled: true } : user);
    });
    assert.deepEqual(await harness.sources.downloadCandidates(input), []);

    await harness.store.update((state) => {
      state.users = state.users?.map((user) => user.id === BOB
        ? {
            ...user,
            disabled: false,
            permissions: { ...user.permissions, downloadToLibrary: false },
          }
        : user);
    });
    assert.deepEqual(await harness.sources.downloadCandidates(input), []);
  }, { contentDownloading: true });
});

test("downloadCandidates refuses a changed owner secret or invisible library", async () => {
  await withHarness(async (harness) => {
    harness.server.items["remote-1"] = [{ id: "item-1", name: "Movie One", type: "movie", providerIds: { imdb: "tt1" } }];
    harness.server.detailOf["item-1"] = { id: "item-1", name: "Movie One", type: "movie", providerIds: { imdb: "tt1" } };
    harness.server.versionsOf["item-1"] = [{ id: "v1", name: "1080p" }];
    harness.server.onVersions = async () => {
      harness.server.onVersions = undefined;
      await harness.store.update((state) => {
        state.users = state.users?.map((user) => user.id === BOB ? { ...user, secret: "changed" } : user);
      });
    };
    assert.deepEqual(await harness.sources.downloadCandidates({
      ownerUserId: BOB,
      libraryId: harness.libraryId,
      type: "movie",
      catalogId: "tt1",
    }), []);

    await harness.store.update((state) => {
      state.remoteLibraries = state.remoteLibraries?.map((library) =>
        library.id === harness.libraryId ? { ...library, allowedUsers: [] } : library);
    });
    assert.deepEqual(await harness.sources.downloadCandidates({
      ownerUserId: BOB,
      libraryId: harness.libraryId,
      type: "movie",
      catalogId: "tt1",
    }), []);
  }, { contentDownloading: true });
});

test("downloadCandidates drops a result the provider does not allow copying", async () => {
  await withHarness(async (harness) => {
    harness.server.items["remote-1"] = [{ id: "item-1", name: "Movie One", type: "movie", providerIds: { imdb: "tt1" } }];
    harness.server.detailOf["item-1"] = { id: "item-1", name: "Movie One", type: "movie", providerIds: { imdb: "tt1" } };
    harness.server.versionsOf["item-1"] = [{ id: "v1", name: "1080p" }];
    assert.deepEqual(await harness.sources.downloadCandidates({
      ownerUserId: ADA,
      libraryId: harness.libraryId,
      type: "movie",
      catalogId: "tt1",
    }), []);
  }, { contentDownloading: false });
});

test("downloadReference captures a durable, session-free handle for the exact version", async () => {
  await withHarness(async (harness) => {
    const [first] = await harness.sources.list(harness.adminAuthority, harness.owner, harness.libraryId, "item-1");
    const reference = await downloadRefOf(harness, first!.sourceId);
    assert.equal(isRemoteDownloadReference(reference), true);
    assert.deepEqual(reference, {
      schemaVersion: 1, ownerUserId: harness.owner.userId, connectionId: harness.connectionId,
      libraryId: harness.libraryId, generation: harness.store.mediaConnections()[0]!.generation, provider: "jellyfin", serverId: "server-1",
      accountId: "account-1", itemId: "item-1", mediaSourceId: "v1",
    });
    const json = JSON.stringify(reference);
    assert.equal(/sid|token|secret|expiresAt|media-server:|http/.test(json), false, "no session, credential or address is kept");
    assert.equal(harness.server.originalCalls, 0, "the reference is proved without reading bytes");
  }, { contentDownloading: true });
});

test("downloadReference refuses a subtitle, a foreign owner and a generic stream", async () => {
  await withHarness(async (harness) => {
    harness.server.versionsOf["item-1"] = [{ id: "v1", name: "1080p", externalSubtitles: [{ index: 2 }] }];
    harness.server.assetResult = { bytes: new TextEncoder().encode("WEBVTT\n"), contentType: "text/vtt" };
    const listed = await harness.sources.list(harness.adminAuthority, harness.owner, harness.libraryId, "item-1");
    const subtitleStream = harness.resources.get(listed[0]!.subtitles[0]!.subtitleId, harness.owner.sid, "subtitle").stream;
    await assert.rejects(harness.sources.downloadReference(subtitleStream, harness.owner), { status: 404 }, "a subtitle is never an original copy");
    await assert.rejects(harness.sources.downloadReference({ url: "https://example.test/a.mp4" }, harness.owner), { status: 404 }, "a generic stream has no remote provenance");
    await assert.rejects(harness.sources.downloadReference(streamOf(harness, listed[0]!.sourceId), { ...harness.owner, userId: BOB }), { status: 404 }, "another account cannot capture the handle");
  });
});

test("openDownloadOriginal streams the proved original and refuses a foreign owner", async () => {
  await withHarness(async (harness) => {
    const [first] = await harness.sources.list(harness.adminAuthority, harness.owner, harness.libraryId, "item-1");
    const reference = await downloadRefOf(harness, first!.sourceId);
    const response = await harness.manager.openDownloadOriginal(harness.adminAuthority, reference, { method: "GET" });
    assert.equal(response.status, 200);
    assert.equal(harness.server.originalCalls, 1);
    await assert.rejects(harness.manager.openDownloadOriginal(harness.bobAuthority, reference, { method: "GET" }), { status: 404 }, "the actor must be the owner");
    await assert.rejects(harness.manager.revalidateDownloadOriginal(harness.bobAuthority, reference), { status: 404 });
    assert.equal(harness.server.originalCalls, 1, "a refused actor reads no bytes");
    assert.equal(isRemoteDownloadReference({ ...reference, sid: "sid-a" }), false, "a reference carrying a session field is refused");
  }, { contentDownloading: true });
});

test("a connection that changes while the original is opening cancels the body", async () => {
  await withHarness(async (harness) => {
    const [first] = await harness.sources.list(harness.adminAuthority, harness.owner, harness.libraryId, "item-1");
    const reference = await downloadRefOf(harness, first!.sourceId);
    harness.server.onOriginal = async () => {
      await harness.manager.patchConnection(harness.adminAuthority, harness.connectionId, { enabled: false });
    };
    await assert.rejects(harness.manager.openDownloadOriginal(harness.adminAuthority, reference, { method: "GET" }), { code: "not-found" });
    assert.equal(harness.server.originalCancels, 1, "the already-opened body was cancelled rather than handed over");
  }, { contentDownloading: true });
});

test("revalidateDownloadOriginal refuses once the named version is gone", async () => {
  await withHarness(async (harness) => {
    const [first] = await harness.sources.list(harness.adminAuthority, harness.owner, harness.libraryId, "item-1");
    const reference = await downloadRefOf(harness, first!.sourceId);
    await harness.manager.revalidateDownloadOriginal(harness.adminAuthority, reference);
    harness.server.versionsOf["item-1"] = [{ id: "v9", name: "other" }];
    await assert.rejects(harness.manager.revalidateDownloadOriginal(harness.adminAuthority, reference), { code: "not-found" });
    harness.server.versionsOf["item-1"] = [{ id: "v1", name: "1080p", container: "mkv", size: 200_000 }];
    await assert.rejects(harness.manager.revalidateDownloadOriginal(harness.adminAuthority, { ...reference, itemId: "missing" }), { code: "not-found" });
  }, { contentDownloading: true });
});

test("a native download denial refuses admission and open yet leaves playback usable", async () => {
  // The field is false in one case and absent in the other: both deny a copy, and neither
  // changes ordinary playback. Only an explicit true would admit one.
  for (const contentDownloading of [false, undefined]) {
    await withHarness(async (harness) => {
      const [first] = await harness.sources.list(harness.adminAuthority, harness.owner, harness.libraryId, "item-1");
      const stream = streamOf(harness, first!.sourceId);
      await assert.rejects(harness.sources.downloadReference(stream, harness.owner), { code: "forbidden" }, "admission needs an explicit true");
      const before = harness.server.originalCalls;
      const reference = downloadReferenceOf(harness);
      await assert.rejects(harness.manager.openDownloadOriginal(harness.adminAuthority, reference, { method: "GET" }), { code: "forbidden" });
      await assert.rejects(harness.manager.revalidateDownloadOriginal(harness.adminAuthority, reference), { code: "forbidden" });
      assert.equal(harness.server.originalCalls, before, "a native denial reads no bytes");
      // The same sealed source still plays: a missing download right never touches playback.
      const played = await harness.sources.open(stream, harness.owner, { method: "GET" });
      assert.equal(played.status, 200);
      await played.body?.cancel().catch(() => undefined);
    }, contentDownloading === undefined ? {} : { contentDownloading });
  }
});

test("a mixed library's automatic kind fallback is also projected", async () => {
  await withHarness(async (harness) => {
    const films = localLibrary("lib_a1b2c3d4", "movie");
    await seedLocal(harness, [films]);
    await harness.store.update((state) => {
      state.remoteLibraries = state.remoteLibraries?.map((entry) => entry.id === harness.libraryId ? { ...entry, type: "mixed" } : entry);
    });
    const listed = await harness.sources.list(harness.adminAuthority, harness.owner, harness.libraryId, "item-1");
    for (const source of listed) assert.equal(source.downloadLibraryId, films.id);
  }, { contentDownloading: true });
});

test("a listed source seals the verified item's own kind, on originals and subtitles alike", async () => {
  let now = 3_000_000;
  await withHarness(async (harness) => {
    harness.server.versionsOf["item-1"] = [{ id: "v1", name: "1080p", externalSubtitles: [{ index: 2 }] }];
    const before = harness.server.originalCalls;

    const movies = await harness.sources.list(harness.adminAuthority, harness.owner, harness.libraryId, "item-1");
    for (const source of movies) assert.equal(openedRef(harness, source.sourceId)?.copyKind, "movie", "a movie seals the movie kind");
    const subtitleStream = harness.resources.get(movies[0]!.subtitles[0]!.subtitleId, harness.owner.sid, "subtitle").stream;
    assert.equal(openRemoteContent(subtitleStream.url)?.copyKind, "movie", "a subtitle carries the original's kind");
    assert.equal(openRemoteContent(subtitleStream.url)?.subtitleIndex, 2, "and keeps its own index");
    assert.equal(JSON.stringify(movies).includes("copyKind"), false, "no public stream exposes the sealed kind");
    assert.equal(JSON.stringify(movies).includes("media-server:"), false, "and no sealed address leaks");

    now += 30_000;
    harness.server.detailOf["item-1"] = { id: "item-1", name: "Episode One", type: "episode", providerIds: {} };
    const episodes = await harness.sources.list(harness.adminAuthority, harness.owner, harness.libraryId, "item-1");
    assert.ok(episodes.length > 0);
    for (const source of episodes) assert.equal(openedRef(harness, source.sourceId)?.copyKind, "series", "an episode seals the series kind");

    assert.equal(harness.server.originalCalls, before, "sealing the kind costs no provider read");
  }, { clock: () => now });
});
