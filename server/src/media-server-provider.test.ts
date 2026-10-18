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

test("currentAccount records the native download permission only when the server reports it", async () => {
  const facts = async (over: Record<string, unknown>, kind: MediaServerKind) => {
    const { provider } = fixture(() => ({ Id: "user-1", Policy: policy(over) }), kind);
    return (await provider.currentAccount("tok", "user-1")).policy;
  };
  for (const kind of ["jellyfin", "emby"] as const) {
    assert.equal((await facts({ EnableContentDownloading: true }, kind)).contentDownloading, true, "an explicit true is kept");
    assert.equal((await facts({ EnableContentDownloading: false }, kind)).contentDownloading, false, "an explicit false is kept");
    assert.equal("contentDownloading" in (await facts({}, kind)), false, "a missing field keeps the fact unproven");
    assert.equal("contentDownloading" in (await facts({ EnableContentDownloading: null }, kind)), false, "a null field is missing, like the other policy facts");
    for (const malformed of ["yes", 1, []]) {
      const { provider } = fixture(() => ({ Id: "user-1", Policy: policy({ EnableContentDownloading: malformed }) }), kind);
      await assert.rejects(provider.currentAccount("tok", "user-1"), { code: "invalid-response" }, `malformed ${JSON.stringify(malformed)} is refused`);
    }
  }
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
  assert.equal(await restricted({ BlockedTags: ["x"] }), true);
  assert.equal(await restricted({ EnabledAccessSchedules: [{ start: 1 }] }), true);
  assert.equal(await restricted({ EnabledDevices: [] }), false);
  assert.equal(await restricted({ MaxParentalRating: null }), false);
});

test("currentAccount reads quota limits separately from restrictions", async () => {
  const facts = async (over: Record<string, unknown>) => {
    const { provider } = fixture(() => ({ Id: "user-1", Policy: policy(over) }));
    return (await provider.currentAccount("tok", "user-1")).policy;
  };
  assert.deepEqual(await facts({ RemoteClientBitrateLimit: 50_000_000, MaxActiveSessions: 10 }), {
    disabled: false,
    mediaPlayback: true,
    allFolders: true,
    folderIds: [],
    hasAdditionalRestrictions: false,
    bitrateLimit: 50_000_000,
    streamLimit: 10,
  });
  assert.equal((await facts({ RemoteClientBitrateLimit: 5_000_000 })).hasAdditionalRestrictions, false);
  assert.equal((await facts({ MaxActiveSessions: 1 })).hasAdditionalRestrictions, false);
  assert.equal((await facts({ SimultaneousStreamLimit: 1 })).hasAdditionalRestrictions, false);
  assert.equal((await facts({ MaxActiveSessions: 7, SimultaneousStreamLimit: 3 })).streamLimit, 3);
  assert.equal((await facts({ MaxActiveSessions: 0, SimultaneousStreamLimit: 4 })).streamLimit, 4);

  for (const unlimited of [
    { RemoteClientBitrateLimit: 0, MaxActiveSessions: 0, SimultaneousStreamLimit: 0 },
    { RemoteClientBitrateLimit: null, MaxActiveSessions: null, SimultaneousStreamLimit: null },
    {},
  ]) {
    const result = await facts(unlimited);
    assert.equal("bitrateLimit" in result, false);
    assert.equal("streamLimit" in result, false);
  }
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

test("reportPlayback maps each report kind to its fixed transport operation", async () => {
  const { calls, provider } = fixture(() => null);
  const base = { mediaSourceId: "source-1", playSessionId: "a".repeat(32), positionTicks: 123_456 };
  await provider.reportPlayback("tok", "item-1", { ...base, kind: "playing", isPaused: false });
  await provider.reportPlayback("tok", "item-1", { ...base, kind: "progress", isPaused: true, eventName: "Pause" });
  await provider.reportPlayback("tok", "item-1", { ...base, kind: "stopped", isPaused: true, eventName: "Unpause" });

  assert.deepEqual(calls.map((call) => call.operation), ["playing", "playingProgress", "playingStopped"]);
  assert.deepEqual(calls[0]!.args, {
    itemId: "item-1", mediaSourceId: "source-1", playSessionId: "a".repeat(32), positionTicks: 123_456, isPaused: false,
  });
  assert.deepEqual(calls[1]!.args, {
    itemId: "item-1", mediaSourceId: "source-1", playSessionId: "a".repeat(32), positionTicks: 123_456, isPaused: true, eventName: "Pause",
  });
  assert.deepEqual(calls[2]!.args, {
    itemId: "item-1", mediaSourceId: "source-1", playSessionId: "a".repeat(32), positionTicks: 123_456,
  });
  assert.ok(calls.every((call) => call.token === "tok"));
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
  await rejects({ MaxActiveSessions: 1.5 });
  await rejects({ SimultaneousStreamLimit: "2" });
  await rejects({ RemoteClientBitrateLimit: "500" });
});

test("versions reads a positive safe integer bitrate and ignores malformed values", async () => {
  const { provider } = fixture(() => ({
    MediaSources: [
      { Id: "valid", Protocol: "File", Bitrate: 8_000_000 },
      { Id: "zero", Protocol: "File", Bitrate: 0 },
      { Id: "negative", Protocol: "File", Bitrate: -1 },
      { Id: "string", Protocol: "File", Bitrate: "8000000" },
      { Id: "float", Protocol: "File", Bitrate: 1.5 },
    ],
  }));
  const versions = await provider.versions("tok", "user-1", "item-1");
  assert.equal(versions[0]!.bitrate, 8_000_000);
  for (const version of versions.slice(1)) assert.equal("bitrate" in version, false, version.id);
});

test("versions restore the file name Emby cut down to a stump after the folder name", async () => {
  const { provider } = fixture(() => ({
    MediaSources: [
      { Id: "emby", Protocol: "File", Name: ".2009.720p.DVDSCR.x264.AC3", Path: "/volume1/video/Filmy/Avatar/Avatar.2009.720p.DVDSCR.x264.AC3.mkv" },
      { Id: "windows", Protocol: "File", Name: " - 1080p", Path: "D:\\Filmy\\Avatar\\Avatar - 1080p.mkv" },
      { Id: "kept", Protocol: "File", Name: "Avatar.2009.720p", Path: "/media/Avatar/Avatar.2009.720p.mkv" },
      { Id: "foreign", Protocol: "File", Name: ".unrelated", Path: "/media/Avatar/Avatar.2009.mkv" },
      { Id: "no-path", Protocol: "File", Name: ".2009" },
    ],
  }));
  const names = (await provider.versions("tok", "user-1", "item-1")).map((version) => version.name);
  assert.deepEqual(names, ["Avatar.2009.720p.DVDSCR.x264.AC3", "Avatar - 1080p", "Avatar.2009.720p", ".unrelated", ".2009"]);
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

test("pageDirectory pins Recursive and the type set to the mode and admits a Folder row", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const { provider } = fixture((_operation, args) => {
    seen.push(args);
    return {
      Items: [
        { Id: "folder-1", Name: "Season 1", Type: "Folder", ParentId: "library-1" },
        { Id: "m1", Name: "Alien", Type: "Movie", ProviderIds: { Imdb: "tt0078748" } },
      ],
      TotalRecordCount: 2,
    };
  });
  const folders = await provider.pageDirectory("tok", "user-1", "library-1", { mode: "folders" });
  assert.equal(seen[0].recursive, false, "folders mode is not recursive");
  assert.ok(String(seen[0].includeItemTypes).split(",").includes("Folder"), "folders mode admits Folder");
  assert.equal(seen[0].sortBy, "SortName");
  assert.equal(seen[0].sortOrder, "Ascending");
  assert.equal(folders.items[0].type, "folder", "a Folder row normalizes to the folder type");
  assert.equal(folders.items[1].type, "movie");

  await provider.pageDirectory("tok", "user-1", "series-1", { mode: "titles", type: "episode", limit: 5, sort: "added", order: "desc" });
  assert.equal(seen[1].recursive, true, "titles mode is recursive");
  assert.equal(seen[1].includeItemTypes, "Episode", "an explicit type narrows the listing");
  assert.ok(!String(seen[1].includeItemTypes).includes("Folder"), "titles mode excludes Folder");
  assert.equal(seen[1].sortBy, "DateCreated");
  assert.equal(seen[1].sortOrder, "Descending");
  assert.equal(seen[1].limit, 5);
});

test("pageDirectory records only a real Primary image tag and rejects a foreign cursor or option", async () => {
  const { provider } = fixture(() => ({
    Items: [
      { Id: "m1", Name: "With art", Type: "Movie", ProviderIds: {}, ImageTags: { Primary: "abc" } },
      { Id: "m2", Name: "No art", Type: "Movie", ProviderIds: {} },
      { Id: "s1", Name: "Show", Type: "Series", ProviderIds: {}, ImageTags: { Primary: "" } },
    ],
    TotalRecordCount: 10,
  }));
  const page = await provider.pageDirectory("tok", "user-1", "library-1", { mode: "titles", limit: 3 });
  assert.equal(page.items[0].hasPrimaryImage, true);
  assert.equal(page.items[1].hasPrimaryImage, undefined, "a row with no tag carries no flag");
  assert.equal(page.items[2].hasPrimaryImage, false, "an empty tag proves the image is absent");
  assert.ok(page.cursor, "a short page offers a continuation");

  await assert.rejects(provider.pageDirectory("tok", "user-1", "library-1", { mode: "grid" as never }), { code: "invalid-input" });
  await assert.rejects(provider.pageDirectory("tok", "user-1", "library-1", { mode: "titles", type: "folder" as never }), { code: "invalid-input" });
  await assert.rejects(provider.pageDirectory("tok", "user-1", "library-1", { mode: "titles", sort: "date" as never }), { code: "invalid-input" });
  await assert.rejects(provider.pageDirectory("tok", "user-1", "library-1", { mode: "titles", order: "up" as never }), { code: "invalid-input" });
  await assert.rejects(provider.pageDirectory("tok", "user-1", "library-1", { mode: "titles", limit: 0 }), { code: "invalid-input" });
  await assert.rejects(provider.pageDirectory("tok", "user-1", "library-1", { mode: "titles", cursor: page.cursor!.slice(0, -1) + (page.cursor!.endsWith("A") ? "B" : "A") }), { code: "invalid-input" });
  await assert.rejects(provider.pageDirectory("tok", "user-1", "other-library", { mode: "titles", limit: 3, cursor: page.cursor }), { code: "invalid-input" }, "a cursor from another parent is refused");
  await assert.rejects(provider.pageDirectory("tok", "user-1", "library-1", { mode: "folders", limit: 3, cursor: page.cursor }), { code: "invalid-input" }, "a cursor from another mode is refused");
});

test("backdrop presence is read from BackdropImageTags, then ImageTags.Backdrop, and stays unknown without metadata", async () => {
  const { provider } = fixture(() => ({
    Items: [
      { Id: "m1", Name: "Backdrops", Type: "Movie", ProviderIds: {}, BackdropImageTags: ["abc"] },
      { Id: "m2", Name: "No backdrops", Type: "Movie", ProviderIds: {}, BackdropImageTags: [] },
      { Id: "m3", Name: "Legacy backdrop", Type: "Movie", ProviderIds: {}, ImageTags: { Backdrop: "legacy" } },
      { Id: "m4", Name: "Primary only", Type: "Movie", ProviderIds: {}, ImageTags: { Primary: "p1" } },
      { Id: "m5", Name: "Unknown", Type: "Movie", ProviderIds: {} },
      { Id: "m6", Name: "Blank tag", Type: "Movie", ProviderIds: {}, BackdropImageTags: [""] },
      { Id: "m7", Name: "Wrong shape", Type: "Movie", ProviderIds: {}, BackdropImageTags: [3] },
    ],
    TotalRecordCount: 7,
  }));
  const page = await provider.pageDirectory("tok", "user-1", "library-1", { mode: "titles", limit: 7 });
  assert.equal(page.items[0].hasBackdropImage, true, "a non-empty BackdropImageTags entry proves presence");
  assert.equal(page.items[1].hasBackdropImage, false, "an empty BackdropImageTags proves absence");
  assert.equal(page.items[2].hasBackdropImage, true, "ImageTags.Backdrop is a legacy presence signal");
  assert.equal(page.items[3].hasBackdropImage, false, "ImageTags without Backdrop proves absence");
  assert.equal(page.items[4].hasBackdropImage, undefined, "no image metadata leaves the backdrop unknown");
  assert.equal(page.items[5].hasBackdropImage, false, "a blank tag proves absence");
  assert.equal(page.items[6].hasBackdropImage, false, "a non-string entry proves absence");
});

test("a Thumb tag is read from ImageTags with the same alphabet a Primary tag is held to", async () => {
  const { provider } = fixture(() => ({
    Items: [
      { Id: "m1", Name: "Still", Type: "Movie", ProviderIds: {}, ImageTags: { Primary: "p1", Thumb: "th.1~x" } },
      { Id: "m2", Name: "Blank thumb", Type: "Movie", ProviderIds: {}, ImageTags: { Primary: "p2", Thumb: "" } },
      { Id: "m3", Name: "Foreign thumb", Type: "Movie", ProviderIds: {}, ImageTags: { Thumb: "bad tag!" } },
      { Id: "m4", Name: "No tags", Type: "Movie", ProviderIds: {} },
    ],
    TotalRecordCount: 4,
  }));
  const page = await provider.pageDirectory("tok", "user-1", "library-1", { mode: "titles", limit: 4 });
  assert.equal(page.items[0].thumbImageTag, "th.1~x");
  assert.equal(page.items[0].hasThumbImage, true);
  assert.equal(page.items[1].thumbImageTag, undefined, "a blank thumb is never captured");
  assert.equal(page.items[1].hasThumbImage, false, "a blank thumb proves the image is absent");
  assert.equal(page.items[2].thumbImageTag, undefined, "a tag outside the alphabet is never captured");
  assert.equal(page.items[2].hasThumbImage, false);
  assert.equal(page.items[3].hasThumbImage, undefined, "no image metadata leaves the thumb unknown");
  assert.equal(page.items[0].primaryImageTag, "p1", "the Primary tag is still read beside it");
});


test("native movie filters retain music videos and folders, and episode pages use numeric order", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const { provider } = fixture((_operation, args) => { calls.push(args); return { Items: [], TotalRecordCount: 0 }; });
  await provider.pageDirectory("tok", "account", "library", { mode: "titles", type: "movie" });
  assert.equal(calls[0].includeItemTypes, "Movie,MusicVideo");
  await provider.pageDirectory("tok", "account", "library", { mode: "folders", type: "movie" });
  assert.equal(calls[1].includeItemTypes, "Folder,Movie,MusicVideo");
  await provider.pageDirectory("tok", "account", "series", { mode: "titles", type: "episode", limit: 1 });
  assert.equal(calls[2].sortBy, "ParentIndexNumber,IndexNumber,SortName", "numeric episode order must apply before pagination");
});

test("provider metadata is bounded, optional, and does not project paths or raw URLs", async () => {
  for (const kind of ["jellyfin", "emby"] as const) {
    const { provider } = fixture(() => ({ Id: "m", Name: "Movie", Type: "Movie", Overview: "A story", ProductionYear: 2024, Genres: ["Drama", "Drama", "Comedy", null, "x".repeat(129)], Size: 1234, RunTimeTicks: 1200000000, DateCreated: "2026-10-13T00:00:00Z", Path: "/private/movie.mkv", RemoteTrailers: [{ Url: "https://upstream.invalid" }] }), kind);
    const item = await provider.detail("token", "user", "m");
    assert.deepEqual(item, { id: "m", name: "Movie", type: "movie", providerIds: {}, overview: "A story", year: 2024, genres: ["Drama", "Comedy"], size: 1234, durationTicks: 1200000000, addedAt: "2026-10-13T00:00:00.000Z" });
    const bad = fixture(() => ({ Id: "m", Name: "Movie", Type: "Movie", Overview: "x".repeat(4097), ProductionYear: 99999, Genres: "Drama", Size: -1, DateCreated: "invalid" }), kind);
    assert.deepEqual(await bad.provider.detail("token", "user", "m"), { id: "m", name: "Movie", type: "movie", providerIds: {} });
  }
});

test("listLibraries records a view's own primary image tag and drops a foreign one", async () => {
  const { provider } = fixture(() => ({
    Items: [
      { Type: "CollectionFolder", CollectionType: "movies", Id: "l1", Name: "Movies", ImageTags: { Primary: "abc" } },
      { Type: "CollectionFolder", CollectionType: "tvshows", Id: "l2", Name: "Shows", ImageTags: { Primary: "" } },
      { Type: "CollectionFolder", CollectionType: "movies", Id: "l3", Name: "Plain" },
      { Type: "CollectionFolder", CollectionType: "movies", Id: "l4", Name: "Foreign", ImageTags: { Primary: "bad tag!" } },
    ],
  }));
  assert.deepEqual(await provider.listLibraries("tok", "user-1"), [
    { id: "l1", name: "Movies", type: "movie", primaryImageTag: "abc" },
    { id: "l2", name: "Shows", type: "series" },
    { id: "l3", name: "Plain", type: "movie" },
    { id: "l4", name: "Foreign", type: "movie" },
  ]);
});

test("pageDirectory records a bounded child count and the exact image tags", async () => {
  const { provider } = fixture(() => ({
    Items: [
      { Id: "s1", Name: "Show", Type: "Series", ProviderIds: {}, ChildCount: 12, ImageTags: { Primary: "p1", Backdrop: "b1" } },
      { Id: "s2", Name: "Bad count", Type: "Series", ProviderIds: {}, ChildCount: -3 },
      { Id: "s3", Name: "Backdrops", Type: "Series", ProviderIds: {}, BackdropImageTags: ["bk1"] },
      { Id: "s4", Name: "Foreign", Type: "Series", ProviderIds: {}, ImageTags: { Primary: "bad tag!" } },
    ],
    TotalRecordCount: 4,
  }));
  const page = await provider.pageDirectory("tok", "user-1", "library-1", { mode: "titles", limit: 4 });
  assert.equal(page.items[0].childCount, 12);
  assert.equal(page.items[0].primaryImageTag, "p1");
  assert.equal(page.items[0].backdropImageTag, "b1");
  assert.equal(page.items[1].childCount, undefined, "a negative count is dropped");
  assert.equal(page.items[2].backdropImageTag, "bk1");
  assert.equal(page.items[3].primaryImageTag, undefined, "a tag outside the URL-safe alphabet is never captured");
  assert.equal(page.items[3].hasPrimaryImage, false);
});

test("pageDirectory sends EnableTotalRecordCount only on the first page and keeps the stored total", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const { provider } = fixture((_operation, args) => {
    seen.push(args);
    return args.enableTotalRecordCount === false
      ? { Items: [{ Id: "e1", Name: "E1", Type: "Episode" }] }
      : { Items: [{ Id: "e1", Name: "E1", Type: "Episode" }], TotalRecordCount: 5 };
  });
  const first = await provider.pageDirectory("tok", "user-1", "series-1", { mode: "titles", type: "episode", limit: 1, season: 2 });
  assert.equal(seen[0].enableTotalRecordCount, true);
  assert.equal(seen[0].parentIndexNumber, 2, "the season becomes a bounded ParentIndexNumber");
  assert.equal(first.total, 5);
  assert.ok(first.cursor);
  const second = await provider.pageDirectory("tok", "user-1", "series-1", { mode: "titles", type: "episode", limit: 1, season: 2, cursor: first.cursor });
  assert.equal(seen[1].enableTotalRecordCount, false, "a continuation never asks for another count");
  assert.equal(second.total, 5, "the continuation keeps the initial total when upstream omits it");
  assert.ok(second.cursor);
});

test("pageDirectory bounds the season and binds it into the cursor", async () => {
  const { provider } = fixture(() => ({ Items: [{ Id: "e", Name: "E", Type: "Episode" }], TotalRecordCount: 4 }));
  for (const season of [-1, 1.5, 10_001, "2"]) {
    await assert.rejects(provider.pageDirectory("tok", "u", "series-1", { mode: "titles", season: season as never }), { code: "invalid-input" }, String(season));
  }
  const page = await provider.pageDirectory("tok", "u", "series-1", { mode: "titles", type: "episode", limit: 1, season: 3 });
  assert.ok(page.cursor);
  await assert.rejects(
    provider.pageDirectory("tok", "u", "series-1", { mode: "titles", type: "episode", limit: 1, season: 4, cursor: page.cursor }),
    { code: "invalid-input" },
    "a cursor from another season is refused",
  );
});

test("findByProviderIds issues one exact Emby query and re-checks every id locally", async () => {
  const { calls, provider } = fixture(() => ({
    Items: [
      { Id: "m1", Name: "Alien", Type: "Movie", ProviderIds: { Imdb: "tt0078748" } },
      { Id: "m2", Name: "Other", Type: "Movie", ProviderIds: { Imdb: "tt9999999" } },
    ],
  }), "emby");
  const found = await provider.findByProviderIds("tok", "user-1", "lib-1", { imdb: "tt0078748" }, "movie");
  assert.deepEqual(found.map((item) => item.id), ["m1"], "a row carrying a different id is filtered locally");
  assert.equal(calls.length, 1, "exactly one list query, no scan");
  assert.equal(calls[0].operation, "match");
  assert.deepEqual(calls[0].args, {
    userId: "user-1", parentId: "lib-1", provider: "emby", providerName: "imdb", providerId: "tt0078748",
    includeItemTypes: "Movie", limit: 200,
  });
});

test("findByProviderIds narrows Jellyfin by title and verifies the exact id in one query", async () => {
  const { calls, provider } = fixture(() => ({
    Items: [
      { Id: "want", Name: "Alien", Type: "Movie", ProviderIds: { Tmdb: "603" } },
      { Id: "same-name", Name: "Alien", Type: "Movie", ProviderIds: { Tmdb: "999" } },
      { Id: "wrong", Name: "Alien Resurrection", Type: "Movie", ProviderIds: {} },
    ],
  }), "jellyfin");
  const found = await provider.findByProviderIds("tok", "user-1", "lib-1", { tmdb: "603" }, "movie", "Alien");
  assert.deepEqual(found.map((item) => item.id), ["want"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, "match");
  assert.equal(calls[0].args.searchTerm, "Alien");
  assert.equal(calls[0].args.providerName, "tmdb");
  assert.equal(calls[0].args.includeItemTypes, "Movie");
});

test("findByProviderIds without a title makes one bounded Has-id page and never claims exhaustiveness", async () => {
  const { calls, provider } = fixture(() => ({
    Items: [{ Id: "m1", Name: "Alien", Type: "Movie", ProviderIds: { Imdb: "tt0078748" } }],
  }), "jellyfin");
  const found = await provider.findByProviderIds("tok", "user-1", "lib-1", { imdb: "tt0078748" }, "movie");
  assert.deepEqual(found.map((item) => item.id), ["m1"]);
  assert.equal(calls.length, 1);
  assert.equal("searchTerm" in calls[0].args, false, "no title is sent when the caller has none");
  assert.equal(calls[0].args.limit, 200, "the page stays bounded");
});

test("findByProviderIds prefers a usable id, queries nothing without one and refuses an oversized page", async () => {
  const { calls, provider } = fixture(() => ({ Items: [] }), "emby");
  await provider.findByProviderIds("tok", "u", "lib", { imdb: "not-an-id", tmdb: "603" }, "movie");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.providerName, "tmdb", "the first usable id names the filter");
  await provider.findByProviderIds("tok", "u", "lib", { imdb: "tt", tmdb: "0" }, "movie");
  assert.equal(calls.length, 1, "no usable id means no query at all");
  await assert.rejects(provider.findByProviderIds("tok", "u", "lib", { imdb: "tt1" }, "episode" as never), { code: "invalid-input" });
  const oversized = fixture(() => ({ Items: Array.from({ length: 201 }, (_, index) => ({ Id: `m${index}`, Name: "n", Type: "Movie", ProviderIds: { Imdb: "tt1" } })) }), "emby");
  await assert.rejects(oversized.provider.findByProviderIds("tok", "u", "lib", { imdb: "tt1" }, "movie"), { code: "invalid-response" });
});

for (const kind of ["jellyfin", "emby"] as const) {
  test(`${kind} derives an absent container from the original file extension without exposing its path`, async () => {
    const { provider } = fixture(() => ({ MediaSources: [
      { Id: "file", Protocol: "File", Name: "720p", Path: "/private/media/Original.MKV" },
      { Id: "unknown", Protocol: "File", Name: "Unknown", Path: "/private/media/Original.unknown" },
      { Id: "reported", Protocol: "File", Container: "mp4", Path: "/private/media/Original.mkv" },
      { Id: "formats", Protocol: "File", Container: "mov,mp4,m4a,3gp,3g2,mj2", Path: "/private/media/Original.mp4" },
    ] }), kind);
    const versions = await provider.versions("tok", "user-1", "item-1");
    assert.equal(versions[0]?.container, "mkv");
    assert.equal(versions[1]?.container, undefined);
    assert.equal(versions[2]?.container, "mp4");
    assert.equal(versions[3]?.container, "mp4");
    assert.equal(JSON.stringify(versions).includes("/private/media"), false);
  });
}
