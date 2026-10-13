import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MediaResources, ResourceError } from "./media-resources.js";
import { MediaServerIndex } from "./media-server-index.js";
import { MediaServerManager, type MediaServerAuthority } from "./media-server-manager.js";
import type { MediaServerProvider, ProviderItem, ProviderLibrary, ProviderVersion, RemoteAccountPolicy } from "./media-server-provider.js";
import { openRemoteContent } from "./media-server-reference.js";
import { MediaServerSecrets } from "./media-server-secrets.js";
import { MediaServerSources } from "./media-server-sources.js";
import type { MediaServerTransport } from "./media-server-security.js";
import { MediaServerError } from "./media-server-types.js";
import { Store } from "./store.js";
import { emptyUserData, type UserRecord } from "./users.js";

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
  assetResult: { bytes: Uint8Array; contentType: string } | undefined;
  assetRequests: Array<Record<string, unknown>> = [];

  async run(): Promise<void> { /* no scheduling seams in this harness */ }
}

const clone = <T>(value: T): T => structuredClone(value);

const stubProvider = (server: FakeServer): MediaServerProvider => ({
  verifyIdentity: async () => { await server.run(); return { serverId: server.serverId, version: "1.0.0" }; },
  authenticate: async () => { await server.run(); return { serverId: server.serverId, accountId: server.accountId, token: server.token }; },
  currentAccount: async () => { await server.run(); return { accountId: server.accountId, policy: clone(server.policy) }; },
  listLibraries: async () => { await server.run(); return clone(server.libraries); },
  pageItems: async (_token, _account, libraryId) => { await server.run(); return { items: clone(server.items[libraryId] ?? []), total: (server.items[libraryId] ?? []).length }; },
  pageDirectory: async (_token, _account, parentId) => { await server.run(); return { items: clone(server.directories[parentId] ?? []), total: (server.directories[parentId] ?? []).length }; },
  detail: async (_token, _account, itemId) => {
    await server.run();
    const item = server.detailOf[itemId];
    if (!item) throw new MediaServerError("not-found", "no such item");
    return clone(item);
  },
  ancestors: async (_token, _account, itemId) => { await server.run(); return [...(server.ancestorsOf[itemId] ?? [])]; },
  versions: async (_token, _account, itemId) => { await server.run(); return clone(server.versionsOf[itemId] ?? []); },
});

const stubTransport = (server: FakeServer): MediaServerTransport => ({
  requestJson: async () => { throw new Error("the stub provider does not use the transport"); },
  requestAsset: async (request) => {
    server.assetRequests.push(request as unknown as Record<string, unknown>);
    await server.run();
    if (!server.assetResult) throw new Error("no asset response is configured");
    return { bytes: server.assetResult.bytes, contentType: server.assetResult.contentType };
  },
  requestOriginal: async () => {
    server.originalCalls += 1;
    return new Response(new ReadableStream<Uint8Array>({ cancel: () => undefined }), { status: 200, headers: { "content-range": "bytes 0-0/1" } });
  },
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
  connectionId: string;
  libraryId: string;
  owner: { userId: string; sid: string; expiresAt: number };
  close(): Promise<void>;
}

const mount = async (): Promise<Harness> => {
  const dir = await mkdtemp(path.join(tmpdir(), "media-sources-"));
  const users = [admin, bob];
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
  const manager = new MediaServerManager(store, vault, {
    providerFactory: () => stubProvider(server),
    transportFactory: () => stubTransport(server),
    index: new MediaServerIndex(),
    networkStartIntervalMs: 0,
  });
  await manager.initialize();

  let revoked = false;
  const authority = (user: UserRecord): MediaServerAuthority => ({
    actor: { id: user.id, secret: user.secret },
    assertCurrent: () => { if (revoked) throw new ResourceError(401, "AUTH_REQUIRED"); },
  });
  const adminAuthority = authority(admin);
  const bobAuthority = authority(bob);

  const connection = await manager.createConnection(adminAuthority, {
    provider: "jellyfin", name: "Home", baseUrl: "http://media.example", allowLan: false, allowLoopback: false,
    username: "reader", password: "reader-password",
  });
  const library = await manager.attachLibrary(adminAuthority, connection.id, { remoteId: "remote-1" });
  server.detailOf["item-1"] = { id: "item-1", name: "Movie One", type: "movie", providerIds: {} };
  server.ancestorsOf["item-1"] = ["remote-1"];
  server.versionsOf["item-1"] = [{ id: "v1", name: "1080p", container: "mkv" }, { id: "v2", name: "720p" }];

  const resources = new MediaResources();
  const sources = new MediaServerSources(store, manager, resources);
  return {
    store, manager, sources, resources, server, adminAuthority, bobAuthority,
    connectionId: connection.id, libraryId: library.id,
    owner: { userId: admin.id, sid: "admin-sid", expiresAt: Date.now() + 3_600_000 },
    close: async () => { await manager.close(); await rm(dir, { recursive: true, force: true }); },
  };
};

const withHarness = async (run: (harness: Harness) => Promise<void>) => {
  const harness = await mount();
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

const openedRef = (harness: Harness, sourceId: string) => openRemoteContent(streamOf(harness, sourceId).url);

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
    assert.deepEqual(await harness.sources.matched(harness.adminAuthority, harness.owner, harness.libraryId, "movie", "tt9"), []);
  });
});
