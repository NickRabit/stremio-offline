import assert from "node:assert/strict";
import { test } from "node:test";
import type { MediaServerTransport } from "./media-server-security.js";
import { MediaServerError, type MediaServerKind } from "./media-server-types.js";
import { createMediaServerProvider, type MediaServerProvider } from "./media-server-provider.js";

interface Call {
  operation: string;
  args: Record<string, unknown>;
  token?: string;
}

function fixture(handler: (operation: string, args: Record<string, unknown>) => unknown, kind: MediaServerKind = "jellyfin"): { calls: Call[]; provider: MediaServerProvider } {
  const calls: Call[] = [];
  const transport = {
    requestJson: async (operation: string, args: Record<string, unknown>, token?: string) => {
      calls.push({ operation, args, token });
      const result = handler(operation, args);
      if (result instanceof Error) throw result;
      return result;
    },
    close: async () => undefined,
  } as unknown as MediaServerTransport;
  return { calls, provider: createMediaServerProvider(kind, transport) };
}

const policy = (over: Record<string, unknown> = {}) => ({
  IsDisabled: false,
  EnableMediaPlayback: true,
  EnableAllFolders: true,
  EnabledFolders: [],
  ...over,
});

test("verifyIdentity reads the public server id and version", async () => {
  const { provider } = fixture(() => ({ Id: "server-1", Version: "12.2.0" }));
  assert.deepEqual(await provider.verifyIdentity(), { serverId: "server-1", version: "12.2.0" });
  const missing = fixture(() => ({ Version: "12.2.0" }));
  await assert.rejects(missing.provider.verifyIdentity(), { code: "invalid-response" });
});

test("both provider kinds share the same metadata contract", async () => {
  const handler = (operation: string) => operation === "info"
    ? { Id: "server-1", Version: "4.9.3.0" }
    : { User: { Id: "user-1" }, AccessToken: "tok" };
  const jellyfin = fixture(handler, "jellyfin");
  const emby = fixture(handler, "emby");
  assert.deepEqual(await jellyfin.provider.authenticate("alice", "secret"), { serverId: "server-1", accountId: "user-1", token: "tok" });
  assert.deepEqual(await emby.provider.authenticate("alice", "secret"), { serverId: "server-1", accountId: "user-1", token: "tok" });
  assert.deepEqual(emby.calls.map((call) => call.operation), ["info", "login"]);
});

test("authenticate verifies identity first and refuses a mismatched server id", async () => {
  const { calls, provider } = fixture((operation) => operation === "info"
    ? { Id: "server-1", Version: "12.2.0" }
    : { User: { Id: "user-1", ServerId: "server-1" }, AccessToken: "tok" });
  assert.deepEqual(await provider.authenticate("alice", "secret"), { serverId: "server-1", accountId: "user-1", token: "tok" });
  assert.deepEqual(calls.map((call) => call.operation), ["info", "login"]);
  assert.equal(calls[1].token, undefined, "the login request carries no bearer token");

  const mismatch = fixture((operation) => operation === "info"
    ? { Id: "server-1", Version: "12.2.0" }
    : { User: { Id: "user-1", ServerId: "server-2" }, AccessToken: "tok" });
  await assert.rejects(mismatch.provider.authenticate("alice", "secret"), { code: "invalid-response" });

  const noToken = fixture((operation) => operation === "info" ? { Id: "server-1", Version: "1" } : { User: { Id: "user-1" } });
  await assert.rejects(noToken.provider.authenticate("alice", "secret"), { code: "invalid-response" });
});

test("currentAccount checks the exact id and the required policy facts", async () => {
  const { provider } = fixture(() => ({ Id: "user-1", Policy: policy() }));
  const account = await provider.currentAccount("tok", "user-1");
  assert.equal(account.accountId, "user-1");
  assert.deepEqual(account.policy, { disabled: false, mediaPlayback: true, allFolders: true, folderIds: [], hasAdditionalRestrictions: false });

  const other = fixture(() => ({ Id: "user-2", Policy: policy() }));
  await assert.rejects(other.provider.currentAccount("tok", "user-1"), { code: "invalid-response" });

  for (const missing of ["IsDisabled", "EnableMediaPlayback", "EnableAllFolders"]) {
    const broken = fixture(() => ({ Id: "user-1", Policy: policy({ [missing]: undefined }) }));
    await assert.rejects(broken.provider.currentAccount("tok", "user-1"), { code: "invalid-response" }, missing);
  }
  const badFolders = fixture(() => ({ Id: "user-1", Policy: policy({ EnabledFolders: "not-an-array" }) }));
  await assert.rejects(badFolders.provider.currentAccount("tok", "user-1"), { code: "invalid-response" });
});

test("currentAccount records known restrictions without ever claiming they are exhaustive", async () => {
  const restricted = async (over: Record<string, unknown>) => {
    const { provider } = fixture(() => ({ Id: "user-1", Policy: policy(over) }));
    return (await provider.currentAccount("tok", "user-1")).policy.hasAdditionalRestrictions;
  };
  assert.equal(await restricted({ ForceRemoteSourceTranscoding: true }), true);
  assert.equal(await restricted({ EnableRemoteAccess: false }), true);
  assert.equal(await restricted({ EnableAllDevices: false }), true);
  assert.equal(await restricted({ EnabledDevices: ["tv"] }), true);
  assert.equal(await restricted({ MaxParentalRating: 12 }), true);
  assert.equal(await restricted({ RemoteClientBitrateLimit: 5_000_000 }), true);
  assert.equal(await restricted({ BlockedTags: ["x"] }), true);
  assert.equal(await restricted({ EnabledAccessSchedules: [{ start: 1 }] }), true);
  assert.equal(await restricted({ EnabledDevices: [] }), false);
  assert.equal(await restricted({ RemoteClientBitrateLimit: 0 }), false);
  assert.equal(await restricted({ MaxParentalRating: null }), false);
});

test("listLibraries maps collection folders and drops everything else", async () => {
  const { provider } = fixture(() => ({
    Items: [
      { Type: "CollectionFolder", CollectionType: "movies", Id: "l1", Name: "Movies" },
      { Type: "CollectionFolder", CollectionType: null, Id: "l2", Name: "Mixed" },
      { Type: "CollectionFolder", CollectionType: "tvshows", Id: "l3", Name: "Shows" },
      { Type: "CollectionFolder", CollectionType: "music", Id: "l4", Name: "Music" },
      { Type: "Folder", CollectionType: null, Id: "l5", Name: "Plain folder" },
      { Type: "CollectionFolder", CollectionType: "musicvideos", Id: "l6", Name: "Music videos" },
    ],
  }));
  assert.deepEqual(await provider.listLibraries("tok", "user-1"), [
    { id: "l1", name: "Movies", type: "movie" },
    { id: "l2", name: "Mixed", type: "mixed" },
    { id: "l3", name: "Shows", type: "series" },
    { id: "l6", name: "Music videos", type: "mixed" },
  ]);

  const notArray = fixture(() => ({ Items: {} }));
  await assert.rejects(notArray.provider.listLibraries("tok", "user-1"), { code: "invalid-response" });
  const malformed = fixture(() => ({ Items: [{ Type: "CollectionFolder", CollectionType: "movies", Name: "No id" }] }));
  await assert.rejects(malformed.provider.listLibraries("tok", "user-1"), { code: "invalid-response" });
});

test("pageItems builds a bounded cursor and rejects mismatch, bad totals and oversized pages", async () => {
  let lastArgs: Record<string, unknown> = {};
  const total = 3;
  const { provider } = fixture((operation, args) => {
    lastArgs = args;
    return operation === "items"
      ? { Items: Array.from({ length: Math.min(Number(args.limit ?? 100), total - Number(args.startIndex ?? 0)) }, (_, index) => ({ Id: `i${index}`, Name: `N${index}`, Type: "Movie" })), TotalRecordCount: total }
      : {};
  });
  const first = await provider.pageItems("tok", "user-1", "lib-1", { limit: 2 });
  assert.equal(first.total, 3);
  assert.equal(first.items.length, 2);
  assert.equal(lastArgs.includeItemTypes, "Movie,Series,Season,Episode,MusicVideo");
  assert.equal(lastArgs.startIndex, 0);
  assert.ok(first.cursor);
  const second = await provider.pageItems("tok", "user-1", "lib-1", { limit: 2, cursor: first.cursor });
  assert.equal(second.items.length, 1);
  assert.equal(second.cursor, undefined, "a short final page has no continuation");

  const otherLibrary = Buffer.from(JSON.stringify({ o: 2, a: "user-1", l: "lib-2", s: "" }), "utf8").toString("base64url");
  await assert.rejects(provider.pageItems("tok", "user-1", "lib-1", { cursor: otherLibrary }), { code: "invalid-input" });
  const nonCanonical = Buffer.from(JSON.stringify({ a: "user-1", o: 0, l: "lib-1", s: "" }), "utf8").toString("base64url");
  await assert.rejects(provider.pageItems("tok", "user-1", "lib-1", { cursor: nonCanonical }), { code: "invalid-input" });
  await assert.rejects(provider.pageItems("tok", "user-1", "lib-1", { limit: 0 }), { code: "invalid-input" });
  await assert.rejects(provider.pageItems("tok", "user-1", "lib-1", { limit: 201 }), { code: "invalid-input" });

  const badTotal = fixture(() => ({ Items: [], TotalRecordCount: -1 }));
  await assert.rejects(badTotal.provider.pageItems("tok", "user-1", "lib-1"), { code: "invalid-response" });
  const oversized = fixture(() => ({ Items: [{ Id: "a", Name: "a", Type: "Movie" }, { Id: "b", Name: "b", Type: "Movie" }], TotalRecordCount: 9 }));
  await assert.rejects(oversized.provider.pageItems("tok", "user-1", "lib-1", { limit: 1 }), { code: "invalid-response" });
});

test("paging boundaries never emit an unusable cursor or silently truncate inconsistent totals", async () => {
  const cursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset, a: "user-1", l: "lib-1", s: "" })).toString("base64url");
  const item = { Id: "last", Name: "Last", Type: "Movie" };
  const { provider } = fixture(() => ({ Items: [item], TotalRecordCount: 1_000_000_000 }));
  const page = await provider.pageItems("tok", "user-1", "lib-1", { limit: 1, cursor: cursor(999_999_998) });
  assert.equal(page.cursor, cursor(999_999_999));
  const last = await provider.pageItems("tok", "user-1", "lib-1", { limit: 1, cursor: page.cursor });
  assert.equal(last.cursor, undefined);
  const end = fixture(() => ({ Items: [], TotalRecordCount: 1_000_000_000 }));
  assert.equal((await end.provider.pageItems("tok", "user-1", "lib-1", { cursor: cursor(1_000_000_000) })).cursor, undefined);
  await assert.rejects(provider.pageItems("tok", "user-1", "lib-1", { cursor: cursor(1_000_000_001) }), { code: "invalid-input" });
  for (const response of [
    { Items: [item], TotalRecordCount: 1_000_000_001 },
    { Items: [item], TotalRecordCount: 0 },
    { Items: [], TotalRecordCount: 1 },
  ]) {
    const bad = fixture(() => response);
    await assert.rejects(bad.provider.pageItems("tok", "user-1", "lib-1"), { code: "invalid-response" });
  }
});

test("provider ids are normalized leniently and one malformed entry never fails the page", async () => {
  const { provider } = fixture(() => ({
    Items: [
      { Id: "i", Name: "N", Type: "Movie", ProviderIds: { Imdb: "TT0133093", Tmdb: "603", Tvdb: "0", Bad: "x" } },
      { Id: "j", Name: "N", Type: "Movie", ProviderIds: { Imdb: "tt" + "1".repeat(600), Tmdb: "7" } },
    ],
    TotalRecordCount: 2,
  }));
  const page = await provider.pageItems("tok", "user-1", "lib-1");
  assert.deepEqual(page.items[0].providerIds, { imdb: "tt0133093", tmdb: "603" });
  assert.deepEqual(page.items[1].providerIds, { tmdb: "7" }, "an over-long provider id is dropped");
});

test("detail returns a projected item with no path or user data", async () => {
  const { provider } = fixture(() => ({
    Id: "item-1", Name: "Film", Type: "Movie", ParentId: "lib-1", RunTimeTicks: 1000,
    ProviderIds: { Imdb: "tt1", Tmdb: "2" }, Path: "/media/film.mkv", UserData: { Played: true }, TranscodingUrl: "http://x", DirectStreamUrl: "http://y",
  }));
  const detail = await provider.detail("tok", "user-1", "item-1");
  assert.deepEqual(detail, { id: "item-1", name: "Film", type: "movie", parentId: "lib-1", providerIds: { imdb: "tt1", tmdb: "2" }, durationTicks: 1000 });
  assert.equal("Path" in detail, false);
  assert.equal("UserData" in detail, false);
  assert.equal("TranscodingUrl" in detail, false);
});

test("episodes carry series ancestry and numbering", async () => {
  const { provider } = fixture(() => ({ Id: "ep-1", Name: "Pilot", Type: "Episode", SeriesId: "s1", ParentIndexNumber: 1, IndexNumber: 2 }));
  const detail = await provider.detail("tok", "user-1", "ep-1");
  assert.equal(detail.type, "episode");
  assert.equal(detail.seriesId, "s1");
  assert.equal(detail.season, 1);
  assert.equal(detail.episode, 2);
  const unknown = fixture(() => ({ Id: "x", Name: "y", Type: "Book" }));
  await assert.rejects(unknown.provider.detail("tok", "user-1", "x"), { code: "invalid-response" });
});

test("ancestors returns only item ids", async () => {
  const { provider } = fixture(() => [{ Id: "root" }, { Id: "season" }, { Id: "series" }]);
  assert.deepEqual(await provider.ancestors("tok", "user-1", "ep"), ["root", "season", "series"]);
  const malformed = fixture(() => [{ Name: "no id" }]);
  await assert.rejects(malformed.provider.ancestors("tok", "user-1", "ep"), { code: "invalid-response" });
});

test("versions keeps only usable file sources and never selects a remote URL", async () => {
  const { provider } = fixture(() => ({
    MediaSources: [
      { Id: "v1", Protocol: "File", Name: "1080p", Container: "mkv", Size: 100, RunTimeTicks: 9 },
      { Id: "v2", Protocol: "File", IsRemote: true },
      { Id: "v3", Protocol: "Hls" },
      { Id: "v4", Protocol: "File", RequiresOpening: true },
      { Id: "v5", Protocol: "File", LiveStreamId: "live" },
      { Id: "v6", Protocol: "File" },
      { Id: "v7", Protocol: "File", Container: "HLS" },
      { Id: "v8", Protocol: "File", Path: "/media/film.M3U8" },
      { Id: "v9", Protocol: "File", IsRemote: "true" },
      { Id: "v10", Protocol: "File", RequiresClosing: "false" },
      { Id: "v11", Protocol: "File", IsInfiniteStream: null },
      { Id: "v12", Protocol: "File", IsRemote: false, IsInfiniteStream: false, RequiresOpening: false, RequiresClosing: false },
    ],
  }));
  const versions = await provider.versions("tok", "user-1", "item-1");
  assert.deepEqual(versions, [
    { id: "v1", name: "1080p", container: "mkv", size: 100, durationTicks: 9 },
    { id: "v6" },
    { id: "v12" },
  ]);
  const badId = fixture(() => ({ MediaSources: [{ Protocol: "File" }] }));
  await assert.rejects(badId.provider.versions("tok", "user-1", "item-1"), { code: "invalid-response" });
});

test("ancestors accepts only a bounded bare array, never an invented wrapper", async () => {
  const bare = fixture(() => [{ Id: "root" }, { Id: "series" }]);
  assert.deepEqual(await bare.provider.ancestors("tok", "user-1", "ep"), ["root", "series"]);
  const wrapper = fixture(() => ({ Items: [{ Id: "root" }] }));
  await assert.rejects(wrapper.provider.ancestors("tok", "user-1", "ep"), { code: "invalid-response" });
  const tooMany = fixture(() => Array.from({ length: 129 }, (_, index) => ({ Id: `i${index}` })));
  await assert.rejects(tooMany.provider.ancestors("tok", "user-1", "ep"), { code: "invalid-response" });
});

test("a cursor survives maximum-length multi-byte account, library and search bindings", async () => {
  const accountId = "€".repeat(512);
  const libraryId = "ř".repeat(512);
  const search = "€".repeat(256);
  const { provider } = fixture((_operation, args) => {
    const start = Number(args.startIndex ?? 0);
    const limit = Number(args.limit ?? 100);
    const total = 3;
    const count = Math.min(limit, total - start);
    return { Items: Array.from({ length: count }, (_, index) => ({ Id: `i${start + index}`, Name: "N", Type: "Movie" })), TotalRecordCount: total };
  });
  const first = await provider.pageItems("tok", accountId, libraryId, { limit: 2, search });
  assert.ok(first.cursor, "a full page carries a cursor");
  assert.ok(first.cursor.length > 512, "the old 512 bound cannot hold the generated cursor");
  assert.ok(first.cursor.length <= 8192);
  const second = await provider.pageItems("tok", accountId, libraryId, { limit: 2, cursor: first.cursor, search });
  assert.equal(second.items.length, 1);
  assert.equal(second.cursor, undefined);
});

test("a cursor whose decoded binding is out of range is refused", async () => {
  const { provider } = fixture(() => ({ Items: [], TotalRecordCount: 0 }));
  const oversize = Buffer.from(JSON.stringify({ o: 0, a: "x".repeat(4096), l: "y", s: "" }), "utf8").toString("base64url");
  await assert.rejects(provider.pageItems("tok", "user-1", "lib-1", { cursor: oversize }), { code: "invalid-input" });
  const tooLong = "A".repeat(8193);
  await assert.rejects(provider.pageItems("tok", "user-1", "lib-1", { cursor: tooLong }), { code: "invalid-input" });
});

test("the item type lookup ignores inherited object members and the provider kind is validated", async () => {
  for (const type of ["toString", "__proto__", "constructor", "hasOwnProperty"]) {
    const { provider } = fixture(() => ({ Id: "x", Name: "y", Type: type }));
    await assert.rejects(provider.detail("tok", "user-1", "x"), { code: "invalid-response" }, type);
  }
  const transport = { requestJson: async () => ({}), close: async () => undefined } as never;
  assert.throws(() => createMediaServerProvider("plex" as never, transport), { code: "invalid-input" });
  for (const kind of ["jellyfin", "emby"] as const) {
    const { provider } = fixture(() => ({ Id: "i", Name: "n", Type: "Movie" }), kind);
    assert.equal((await provider.detail("tok", "user-1", "i")).type, "movie");
  }
});

test("detail refuses a response whose id is not the requested item", async () => {
  const { provider } = fixture(() => ({ Id: "other", Name: "x", Type: "Movie" }));
  await assert.rejects(provider.detail("tok", "user-1", "wanted"), { code: "invalid-response" });
});

test("currentAccount records the wider restriction fields and refuses malformed ones", async () => {
  const restricted = async (over: Record<string, unknown>) => {
    const { provider } = fixture(() => ({ Id: "user-1", Policy: policy(over) }));
    return (await provider.currentAccount("tok", "user-1")).policy.hasAdditionalRestrictions;
  };
  assert.equal(await restricted({ IncludeTags: ["kids"] }), true);
  assert.equal(await restricted({ ExcludedSubFolders: ["shared"] }), true);
  assert.equal(await restricted({ RestrictedFeatures: ["x"] }), true);
  assert.equal(await restricted({ MaxActiveSessions: 1 }), true);
  assert.equal(await restricted({ MaxActiveSessions: 0 }), false);

  const rejects = async (over: Record<string, unknown>) => {
    const { provider } = fixture(() => ({ Id: "user-1", Policy: policy(over) }));
    await assert.rejects(provider.currentAccount("tok", "user-1"), { code: "invalid-response" });
  };
  await rejects({ EnableRemoteAccess: "false" });
  await rejects({ ForceRemoteSourceTranscoding: 1 });
  await rejects({ IncludeTags: "kids" });
  await rejects({ ExcludedSubFolders: {} });
  await rejects({ RestrictedFeatures: [1] });
  await rejects({ MaxActiveSessions: -1 });
  await rejects({ RemoteClientBitrateLimit: "500" });
});

test("listLibraries and versions refuse an unbounded response array", async () => {
  const manyLibraries = fixture(() => ({
    Items: Array.from({ length: 1025 }, (_, index) => ({ Type: "CollectionFolder", CollectionType: "movies", Id: `l${index}`, Name: `L${index}` })),
  }));
  await assert.rejects(manyLibraries.provider.listLibraries("tok", "user-1"), { code: "invalid-response" });
  const manySources = fixture(() => ({ MediaSources: Array.from({ length: 201 }, (_, index) => ({ Id: `v${index}`, Protocol: "File" })) }));
  await assert.rejects(manySources.provider.versions("tok", "user-1", "item-1"), { code: "invalid-response" });
});
test("a typed transport error is propagated untouched, never softened", async () => {
  const { provider } = fixture((operation) => {
    if (operation === "user") return new MediaServerError("forbidden", "denied", 403);
    return {};
  });
  await assert.rejects(provider.currentAccount("tok", "user-1"), { code: "forbidden", status: 403 });
  const missing = fixture(() => new MediaServerError("not-found", "missing", 404));
  await assert.rejects(missing.provider.detail("tok", "user-1", "gone"), { code: "not-found", status: 404 });
});

test("versions read only external text subtitles with a bounded integer index", async () => {
  const { provider } = fixture(() => ({
    MediaSources: [{
      Id: "v1", Protocol: "File",
      MediaStreams: [
        { Type: "Subtitle", IsExternal: true, Index: 0, Codec: "subrip", Language: "eng", Title: "English", DeliveryUrl: "https://evil.example/srt" },
        { Type: "Subtitle", IsExternal: true, Index: 2, Codec: "srt", Language: "en" },
        { Type: "Subtitle", IsExternal: false, Index: 3, Codec: "subrip" },
        { Type: "Subtitle", IsExternal: true, Index: 4, Codec: "ass" },
        { Type: "Subtitle", IsExternal: true, Index: -1, Codec: "subrip" },
        { Type: "Subtitle", IsExternal: true, Index: 1.5, Codec: "subrip" },
        { Type: "Audio", IsExternal: true, Index: 6, Codec: "aac" },
        { Type: "Subtitle", IsExternal: true, Index: 0, Codec: "srt" },
        { Type: "Subtitle", IsExternal: true, Index: 1024, Codec: "srt" },
      ],
    }],
  }));
  const versions = await provider.versions("tok", "user-1", "item-1");
  assert.deepEqual(versions[0]!.externalSubtitles, [
    { index: 0, language: "eng", title: "English" },
    { index: 2, language: "en" },
  ], "only external text tracks with a valid unique index are kept, and no URL is read");
  assert.equal(JSON.stringify(versions).includes("/srt"), false, "no address from the stream reaches the version");
});

test("versions refuse a version that offers too many external subtitles", async () => {
  const { provider } = fixture(() => ({
    MediaSources: [{
      Id: "v1", Protocol: "File",
      MediaStreams: Array.from({ length: 65 }, (_value, index) => ({ Type: "Subtitle", IsExternal: true, Index: index, Codec: "subrip" })),
    }],
  }));
  await assert.rejects(provider.versions("tok", "user-1", "item-1"), { code: "invalid-response" });
});

test("an episode keeps its IndexNumberEnd as a range and refuses a malformed one", async () => {
  const { provider } = fixture(() => ({ Id: "e1", Name: "Ep", Type: "Episode", IndexNumber: 2, IndexNumberEnd: 3 }));
  assert.deepEqual(await provider.detail("tok", "user-1", "e1"), { id: "e1", name: "Ep", type: "episode", episode: 2, episodeEnd: 3, providerIds: {} });
  const malformed = fixture(() => ({ Id: "e1", Name: "Ep", Type: "Episode", IndexNumber: 2, IndexNumberEnd: "3" }));
  await assert.rejects(malformed.provider.detail("tok", "user-1", "e1"), { code: "invalid-response" });
});


test("music videos browse and open as standalone media without catalogue movie matches", async () => {
  const item = { Id: "clip-1", Name: "Clip", Type: "MusicVideo", ParentId: "music-library", RunTimeTicks: 1200000000, ProviderIds: { Imdb: "tt0133093" } };
  const { provider } = fixture((operation, args) => {
    if (operation === "items") {
      assert.ok(String(args.includeItemTypes).split(",").includes("MusicVideo"));
      return { Items: [item], TotalRecordCount: 1 };
    }
    return item;
  });
  const page = await provider.pageItems("tok", "user-1", "music-library");
  assert.equal(page.items[0].type, "movie");
  assert.equal(page.items[0].durationTicks, 1200000000);
  assert.deepEqual(page.items[0].providerIds, {}, "music video IDs must not match a catalogue movie");
  assert.deepEqual(await provider.detail("tok", "user-1", "clip-1"), page.items[0]);
});
