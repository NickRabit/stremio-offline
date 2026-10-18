import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddonRecord, CatalogDefinition } from "./types.js";
import type { LibraryEntry } from "./library.js";
import type { LibraryRecord } from "./libraries.js";
import type { MediaServerAuthority } from "./media-server-manager.js";
import { MediaServerError, type PublicRemoteItem, type PublicRemoteLibrary } from "./media-server-types.js";
import { setFetchTransport } from "./security.js";
import type { UserRecord } from "./users.js";
import type { SearchStartRequest } from "./search-contracts.js";
import type { LocalSearchIndex, LocalSearchIndexState } from "./search-local-index.js";
import type { SearchAuthority, SearchSource } from "./search-session.js";
import { SourceFailure } from "./search-session.js";
import { discoverSources, type DiscoverDeps } from "./search-sources.js";

const USER_ID = "usr_00000001";
const user = {
  id: USER_ID,
  username: "alice",
  secret: "secret",
  role: "user",
  permissions: {},
  permissionsVersion: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
} as unknown as UserRecord;

const authority = (): SearchAuthority => ({
  userId: USER_ID,
  sid: "sid_00000000",
  isCurrent: () => true,
});

const request = (over: Partial<SearchStartRequest> = {}): SearchStartRequest => ({
  query: "alien",
  kind: "all",
  sources: ["catalog"],
  slotId: "slot_12345678",
  generation: 1,
  ...over,
});

const catalog = (id: string, type = "movie", skip = true): CatalogDefinition => ({
  id,
  type,
  name: `${id} catalog`,
  extra: [{ name: "search" }, ...(skip ? [{ name: "skip" }] : [])],
});

const addon = (
  key: string,
  catalogs: CatalogDefinition[] = [catalog("movies")],
  over: Partial<AddonRecord> = {},
): AddonRecord => ({
  key,
  manifestUrl: `https://${key}.example/manifest.json`,
  role: "catalog",
  enabled: true,
  globalSearch: true,
  allowedUsers: [USER_ID],
  addedAt: "2026-01-01T00:00:00.000Z",
  manifest: { id: key, name: key.toUpperCase(), version: "1", catalogs },
  downloadSettings: {
    movie: { subfolder: "", layout: "structured" },
    series: { subfolder: "", layout: "structured" },
  },
  ...over,
});

const localLibrary = (id: string, name: string): LibraryRecord => ({
  id,
  name,
  type: "mixed",
  root: `/tmp/${id}`,
  enabled: true,
  order: 0,
  addedAt: "2026-01-01T00:00:00.000Z",
  writeArtwork: false,
  visibleTo: [USER_ID],
});

const remoteLibrary = (id: string, connectionId: string): PublicRemoteLibrary => ({
  id,
  connectionId,
  remoteId: `remote-${id}`,
  name: `Remote ${id}`,
  type: "mixed",
  enabled: true,
  order: 0,
  showOnHome: true,
  showInContinueWatching: true,
  browseMode: "folders",
  mosaic: true,
  showInFavorites: true,
  showInSearch: true,
  capabilities: {
    rename: false,
    move: false,
    delete: false,
    identify: false,
    writeArtwork: false,
    downloadToLibrary: false,
    downloadToDevice: false,
  },
  provider: "jellyfin",
});

const remoteAuthority: MediaServerAuthority = {
  actor: { id: USER_ID, secret: "secret" },
  assertCurrent: () => undefined,
};

const indexState = (over: Partial<LocalSearchIndexState> = {}): LocalSearchIndexState => ({
  generation: 1,
  ready: true,
  stale: false,
  building: false,
  failed: false,
  ...over,
});

const fakeIndex = (options: {
  state?: () => LocalSearchIndexState;
  search?: (libraryId: string, query: string, kind: string) => Promise<{ generation: number; entries: LibraryEntry[] }>;
  listeners?: Set<() => void>;
} = {}): LocalSearchIndex => {
  const listeners = options.listeners ?? new Set<() => void>();
  return {
    state: options.state ?? (() => indexState()),
    search: async (libraryId: string, query: string, kind: string) =>
      options.search === undefined
        ? { generation: 1, entries: [] }
        : options.search(libraryId, query, kind),
    onReady: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    markDirty: () => undefined,
    start: () => undefined,
    close: () => undefined,
  } as unknown as LocalSearchIndex;
};

const deps = (over: Partial<DiscoverDeps> & { index?: LocalSearchIndex } = {}): DiscoverDeps => ({
  user: (id) => (id === USER_ID ? user : undefined),
  addons: () => [],
  addonOrder: () => undefined,
  libraries: () => [],
  localIndex: over.index ?? fakeIndex(),
  remote: {
    visibleLibraries: async () => [],
    searchLibrary: async () => ({ items: [] }),
    canSearchLibrary: () => true,
    libraryGeneration: () => 0,
    ...(over.remote ?? {}),
  },
  mediaAuthority: () => remoteAuthority,
  rewriteMeta: (meta) => ({
    ...meta,
    ...(typeof meta.poster === "string" ? { poster: `/proxy?url=${encodeURIComponent(meta.poster)}` } : {}),
    ...(typeof meta.background === "string" ? { background: `/proxy?url=${encodeURIComponent(meta.background)}` } : {}),
  }),
  ...over,
});

const catalogSource = async (over: {
  addons?: AddonRecord[];
  request?: Partial<SearchStartRequest>;
  index?: LocalSearchIndex;
} = {}): Promise<SearchSource> => {
  const sources = await discoverSources(
    deps({ addons: () => over.addons ?? [], index: over.index }),
    authority(),
    request(over.request),
    "ss_test",
  );
  assert.ok(sources[0], "a catalog source was discovered");
  return sources[0]!;
};

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const signal = (): AbortSignal => new AbortController().signal;

const allowPrivateAddons = (t: { after(fn: () => void): void }): void => {
  const previous = process.env.ALLOW_PRIVATE_ADDONS;
  process.env.ALLOW_PRIVATE_ADDONS = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.ALLOW_PRIVATE_ADDONS;
    else process.env.ALLOW_PRIVATE_ADDONS = previous;
  });
};

test("catalog rows map strong ids, opaque ids, years and rewritten artwork", async (t) => {
  allowPrivateAddons(t);
  const seen: URL[] = [];
  setFetchTransport(async (input) => {
    const url = new URL(String(input));
    seen.push(url);
    return jsonResponse({
      metas: [
        { id: "tt1", type: "movie", name: "Alien", year: 1979, description: "A crew", poster: "https://img/alien.jpg", background: "https://img/wide.jpg" },
        { id: "tmdb:2", type: "series", name: "Show", releaseInfo: "2015–2016" },
        { id: "custom", type: "movie", name: "Custom" },
        { id: "skipped", type: "channel", name: "Not a title" },
      ],
    });
  });
  t.after(() => setFetchTransport());

  const source = await catalogSource({ addons: [addon("alpha")] });
  const page = await source.next(undefined, signal());
  assert.equal(source.id, "s0");
  assert.equal(source.label, "ALPHA · movies catalog");
  assert.equal(source.poolKey, "alpha.example");
  assert.equal(source.continuation, "supported");
  assert.equal(page.cursor, 4, "the raw offset advances by every returned row");
  assert.equal(page.exhausted, false);
  assert.match(decodeURIComponent(seen[0]!.pathname), /search=alien/);
  assert.deepEqual(page.records.map((record) => record.kind), ["movie", "series", "movie"]);
  assert.deepEqual(page.records[0]!.ids, { imdb: "tt1" });
  assert.equal(page.records[0]!.year, 1979);
  assert.equal(page.records[0]!.poster, "/proxy?url=https%3A%2F%2Fimg%2Falien.jpg");
  assert.equal(page.records[1]!.year, 2015, "releaseInfo supplies the year");
  assert.equal(page.records[2]!.opaque, "addon:alpha:movie:custom");
  assert.deepEqual(page.records[0]!.locator, {
    kind: "catalog", addonKey: "alpha", type: "movie", id: "tt1", catalogId: "movies",
  });
});

test("a file-search catalog row is a file, one per addon whatever catalogue type listed it", async (t) => {
  allowPrivateAddons(t);
  setFetchTransport(async () => jsonResponse({
    metas: [{ id: "webshare:abc", type: "series", name: "Peppa.Pig.s01e07.SD.TV.avi" }, { id: "tt5", type: "movie", name: "Film.2020.mkv" }],
  }));
  t.after(() => setFetchTransport());

  const page = await (await catalogSource({ addons: [addon("alpha")] })).next(undefined, signal());
  assert.deepEqual(page.records.map((record) => [record.kind, record.itemKey, record.opaque]), [
    ["file", "file:webshare:abc", "addon:alpha:file:webshare:abc"],
    ["file", "file:tt5", "addon:alpha:file:tt5"],
  ]);
  assert.equal(page.records[1]!.ids, undefined, "a file name never lends its row a title id");
  assert.equal(page.records[0]!.locator.kind === "catalog" && page.records[0]!.locator.type, "series");
});

test("catalog paging keeps the raw skip and an unsupported continuation ends after one page", async (t) => {
  allowPrivateAddons(t);
  const skips: string[] = [];
  setFetchTransport(async (input) => {
    const url = new URL(String(input));
    skips.push(/skip=(\d+)/.exec(decodeURIComponent(url.pathname))?.[1] ?? "0");
    return jsonResponse(skips.length === 1
      ? { metas: [{ id: "tt1", type: "movie", name: "Alien" }, { id: "tt2", type: "movie", name: "Aliens" }] }
      : { metas: [] });
  });
  t.after(() => setFetchTransport());
  const source = await catalogSource({ addons: [addon("alpha")] });
  const first = await source.next(undefined, signal());
  assert.equal(first.cursor, 2);
  const second = await source.next(2, signal());
  assert.deepEqual(skips, ["0", "2"]);
  assert.equal(second.cursor, 2);
  assert.equal(second.exhausted, true);

  setFetchTransport(async () => jsonResponse({
    metas: [{ id: "tt1", type: "movie", name: "Alien" }, { id: "tt2", type: "movie", name: "Aliens" }],
  }));
  const noSkip = await catalogSource({
    addons: [addon("alpha", [catalog("movies", "movie", false)])],
  });
  assert.equal(noSkip.continuation, "unsupported");
  const page = await noSkip.next(undefined, signal());
  assert.equal(page.cursor, 2);
  assert.equal(page.exhausted, true);
});

test("catalog failures map to fixed source failures", async (t) => {
  allowPrivateAddons(t);
  const cases: Array<{ key: string; response: () => Response | Promise<Response>; code: string }> = [
    { key: "httpfail", response: () => jsonResponse({}), code: "http-503" },
    { key: "badjson", response: () => new Response("{", { status: 200, headers: { "content-type": "application/json" } }), code: "invalid-json" },
    { key: "networkfail", response: () => { throw new Error("ECONNREFUSED"); }, code: "network" },
  ];
  const original = cases[0]!.response;
  cases[0]!.response = () => new Response(JSON.stringify({}), { status: 503, headers: { "content-type": "application/json" } });
  setFetchTransport(async () => {
    const entry = cases.shift();
    return entry === undefined ? original() : entry.response();
  });
  t.after(() => setFetchTransport());
  for (const item of [
    { key: "httpfail", code: "http-503" },
    { key: "badjson", code: "invalid-json" },
    { key: "networkfail", code: "network" },
  ]) {
    const source = await catalogSource({ addons: [addon(item.key)] });
    await assert.rejects(source.next(undefined, signal()), (error: unknown) =>
      error instanceof SourceFailure && error.code === item.code,
    item.key);
  }

  const cancelled = new AbortController();
  cancelled.abort();
  setFetchTransport(async () => jsonResponse({ metas: [] }));
  const aborted = await catalogSource({ addons: [addon("aborted")] });
  await assert.rejects(aborted.next(undefined, cancelled.signal), (error: unknown) =>
    error instanceof SourceFailure && error.code === "cancelled",
  );
});

test("globalSearch false, disabled and ungranted addons are never catalog targets", async () => {
  const addons = [
    addon("normal"),
    addon("no-global", [catalog("movies")], { globalSearch: false }),
    addon("disabled", [catalog("movies")], { enabled: false }),
    addon("ungranted", [catalog("movies")], { allowedUsers: [] }),
  ];
  const sources = await discoverSources(deps({ addons: () => addons }), authority(), request(), "ss_test");
  assert.deepEqual(sources.map((source) => source.label), ["NORMAL · movies catalog"]);
});

test("a catalog source stops being allowed when its addon is disabled, hidden or moved", async () => {
  const record = addon("alpha");
  const sources = await discoverSources(deps({ addons: () => [record] }), authority(), request(), "ss_test");
  const source = sources[0]!;
  assert.equal(source.stillAllowed(), true);

  record.globalSearch = false;
  assert.equal(source.stillAllowed(), false, "a catalogue taken out of global search disappears");
  record.globalSearch = true;
  record.enabled = false;
  assert.equal(source.stillAllowed(), false, "a disabled addon disappears");
  record.enabled = true;
  record.manifestUrl = "https://moved.example/manifest.json";
  assert.equal(source.stillAllowed(), false, "a different manifest breaks the discovery binding");
  record.manifestUrl = "https://alpha.example/manifest.json";
  record.allowedUsers = [];
  assert.equal(source.stillAllowed(), false, "a revoked grant disappears");
});

const libraryEntry = (
  key: string,
  title: string,
  over: Partial<LibraryEntry> = {},
): LibraryEntry => ({
  key,
  kind: "movie",
  title,
  files: [{
    path: (() => {
      const relative = key.split("/").slice(1).join("/");
      return relative.endsWith(".mkv") ? relative : `${relative}/media.mkv`;
    })(),
    label: title,
    season: null,
    episode: null,
    size: 1,
    modified: "",
  }],
  size: 1,
  modified: "2026-01-01T00:00:00.000Z",
  ...over,
});

test("local rows map identified titles and unnamed files or folders", async () => {
  const entries = [
    libraryEntry("lib_00000001/Alien", "Alien", {
      poster: "library-poster",
      meta: { type: "movie", id: "tt1", name: "Alien", year: "1979", poster: "meta-poster" },
    }),
    libraryEntry("lib_00000001/Loose.mkv", "Loose"),
    libraryEntry("lib_00000001/Collection", "Collection", {
      kind: "collection",
      files: [
        { path: "Collection/a.mkv", label: "a", season: null, episode: null, size: 1, modified: "" },
        { path: "Collection/b.mkv", label: "b", season: null, episode: null, size: 1, modified: "" },
      ],
    }),
  ];
  const index = fakeIndex({ search: async () => ({ generation: 1, entries }) });
  const sources = await discoverSources(
    deps({ libraries: () => [localLibrary("lib_00000001", "Films")], index }),
    authority(),
    request({ sources: ["local"] }),
    "ss_test",
  );
  assert.equal(sources.length, 1);
  const page = await sources[0]!.next(undefined, signal());
  assert.equal(sources[0]!.label, "Films");
  assert.equal(sources[0]!.poolKey, "local");
  assert.deepEqual(page.records.map((record) => record.kind), ["movie", "file", "folder"]);
  assert.equal(page.records[0]!.year, 1979);
  assert.deepEqual(page.records[0]!.ids, { imdb: "tt1" });
  assert.equal(page.records[0]!.poster, "/proxy?url=library-poster", "the library picture wins over metadata");
  assert.deepEqual(page.records[0]!.locator, {
    kind: "local", key: "lib_00000001/Alien", libraryId: "lib_00000001", itemKind: "file",
  });
  assert.equal(page.records[1]!.locator.kind === "local" && page.records[1]!.locator.itemKind, "file");
  assert.equal(page.records[2]!.locator.kind === "local" && page.records[2]!.locator.itemKind, "folder");
});

test("a local source reports indexing until the index is ready", async () => {
  const index = fakeIndex({ state: () => indexState({ ready: false, generation: 0 }) });
  const sources = await discoverSources(
    deps({ libraries: () => [localLibrary("lib_00000001", "Films")], index }),
    authority(),
    request({ sources: ["local"] }),
    "ss_test",
  );
  assert.deepEqual(await sources[0]!.next(undefined, signal()), {
    records: [],
    exhausted: false,
    indexing: true,
  });
});

test("a new local generation restarts from the first row", async () => {
  let state = indexState({ generation: 1 });
  const rows = new Map<number, LibraryEntry[]>([
    [1, [libraryEntry("lib_00000001/A", "A"), libraryEntry("lib_00000001/B", "B")]],
    [2, [libraryEntry("lib_00000001/C", "C")]],
  ]);
  const index = fakeIndex({
    state: () => state,
    search: async () => ({ generation: state.generation, entries: rows.get(state.generation) ?? [] }),
  });
  const sources = await discoverSources(
    deps({ libraries: () => [localLibrary("lib_00000001", "Films")], index }),
    authority(),
    request({ sources: ["local"] }),
    "ss_test",
  );
  const source = sources[0]!;
  const first = await source.next(undefined, signal());
  assert.deepEqual(first.cursor, { generation: 1, offset: 2 });
  state = indexState({ generation: 2 });
  const restarted = await source.next({ generation: 1, offset: 1 }, signal());
  assert.deepEqual(restarted.records.map((record) => record.title), ["C"]);
  assert.deepEqual(restarted.cursor, { generation: 2, offset: 1 });
});

const remoteItem = (over: Partial<PublicRemoteItem> & Pick<PublicRemoteItem, "id" | "name" | "type">): PublicRemoteItem => ({
  providerIds: {},
  ...over,
} as PublicRemoteItem);

test("remote rows map titles, episode ranges, the cursor and the library provider", async () => {
  const library = remoteLibrary("rlib_00000001", "conn_00000001");
  let seen: { libraryId: string; query: { search: string; kind: string; cursor?: string } } | undefined;
  const searchLibrary: DiscoverDeps["remote"]["searchLibrary"] = async (_authority, libraryId, query) => {
    seen = { libraryId: String(libraryId), query };
    return {
      cursor: "provider-next",
      items: [
        remoteItem({ id: "m1", name: "Alien", type: "movie", year: 1979, providerIds: { imdb: "tt1" }, poster: "/poster/m1" }),
        remoteItem({ id: "s1", name: "Show", type: "series", providerIds: { tmdb: "2" } }),
        remoteItem({
          id: "e1", name: "Pilot", type: "episode", seriesId: "s1",
          season: 1, episode: 2, episodeEnd: 3, overview: "An episode",
        }),
        remoteItem({ id: "f1", name: "Folder", type: "folder" }),
      ],
    };
  };
  const sources = await discoverSources(
    deps({
      remote: {
        visibleLibraries: async () => [library],
        searchLibrary,
        canSearchLibrary: () => true,
        libraryGeneration: () => 7,
      },
    }),
    authority(),
    request({ sources: ["remote"] }),
    "ss_test",
  );
  const source = sources[0]!;
  assert.equal(source.poolKey, "conn_00000001");
  const page = await source.next("cursor-1", signal());
  assert.deepEqual(seen, { libraryId: "rlib_00000001", query: { search: "alien", kind: "all", cursor: "cursor-1" } });
  assert.equal(page.cursor, "provider-next");
  assert.equal(page.exhausted, false);
  assert.deepEqual(page.records.map((record) => record.kind), ["movie", "series", "episode"]);
  assert.deepEqual(page.records[0]!.ids, { imdb: "tt1" });
  assert.equal(page.records[0]!.poster, "/poster/m1");
  assert.equal(page.records[2]!.parentRef, "s1");
  assert.equal(page.records[2]!.season, 1);
  assert.equal(page.records[2]!.episode, 2);
  assert.equal(page.records[2]!.episodeEnd, 3);
  assert.deepEqual(page.records[0]!.locator, {
    kind: "remote", libraryId: "rlib_00000001", itemId: "m1", itemType: "movie", provider: "jellyfin",
  });

  assert.equal(source.stillAllowed(), true);
});

test("a remote source disappears when its grant or generation is revoked", async () => {
  const library = remoteLibrary("rlib_00000001", "conn_00000001");
  let allowed = true;
  const sources = await discoverSources(
    deps({
      remote: {
        visibleLibraries: async () => [library],
        searchLibrary: async () => ({ items: [] }),
        canSearchLibrary: () => allowed,
        libraryGeneration: () => 3,
      },
    }),
    authority(),
    request({ sources: ["remote"] }),
    "ss_test",
  );
  assert.equal(sources[0]!.stillAllowed(), true);
  allowed = false;
  assert.equal(sources[0]!.stillAllowed(), false);
});

test("a remote failure is unavailable when the library or generation is gone", async () => {
  const library = remoteLibrary("rlib_00000001", "conn_00000001");
  let allowed = true;
  const sources = await discoverSources(
    deps({
      remote: {
        visibleLibraries: async () => [library],
        searchLibrary: async () => { throw new MediaServerError("invalid-response", "bad page"); },
        canSearchLibrary: () => allowed,
        libraryGeneration: () => 3,
      },
    }),
    authority(),
    request({ sources: ["remote"] }),
    "ss_test",
  );
  await assert.rejects(sources[0]!.next(undefined, signal()), (error: unknown) =>
    error instanceof SourceFailure && error.code === "network",
  );
  allowed = false;
  await assert.rejects(sources[0]!.next(undefined, signal()), (error: unknown) =>
    error instanceof SourceFailure && error.code === "unavailable",
  );
});

test("discovery orders local, remote then catalog and numbers the sources", async () => {
  const sources = await discoverSources(
    deps({
      libraries: () => [localLibrary("lib_00000001", "Films")],
      addons: () => [addon("alpha")],
      remote: {
        visibleLibraries: async () => [remoteLibrary("rlib_00000001", "conn_00000001")],
        searchLibrary: async () => ({ items: [] }),
        canSearchLibrary: () => true,
        libraryGeneration: () => 1,
      },
    }),
    authority(),
    request({ sources: ["catalog", "remote", "local"] }),
    "ss_test",
  );
  assert.deepEqual(sources.map((source) => source.sourceClass), ["local", "remote", "catalog"]);
  assert.deepEqual(sources.map((source) => source.id), ["s0", "s1", "s2"]);
});

test("discovery only contacts the source classes the request names", async () => {
  let remoteCalls = 0;
  const sources = await discoverSources(
    deps({
      libraries: () => [localLibrary("lib_00000001", "Films")],
      addons: () => [addon("alpha")],
      remote: {
        visibleLibraries: async () => { remoteCalls += 1; return []; },
        searchLibrary: async () => ({ items: [] }),
        canSearchLibrary: () => true,
        libraryGeneration: () => 1,
      },
    }),
    authority(),
    request({ sources: ["local"] }),
    "ss_test",
  );
  assert.equal(remoteCalls, 0);
  assert.deepEqual(sources.map((source) => source.sourceClass), ["local"]);
});

test("a library switched out of search is never a source, and switching it off drops a running one", async () => {
  let libraries = [localLibrary("lib_00000001", "Films"), { ...localLibrary("lib_00000002", "Private"), showInSearch: false }];
  const sources = await discoverSources(
    deps({
      libraries: () => libraries,
      remote: {
        visibleLibraries: async () => [remoteLibrary("rlib_00000001", "conn_00000001"), { ...remoteLibrary("rlib_00000002", "conn_00000001"), showInSearch: false }],
        searchLibrary: async () => ({ items: [] }),
        canSearchLibrary: () => true,
        libraryGeneration: () => 1,
      },
    }),
    authority(),
    request({ sources: ["local", "remote"] }),
    "ss_test",
  );
  assert.deepEqual(sources.map((source) => source.label), ["Films", "Remote rlib_00000001"]);
  assert.equal(sources[0]!.stillAllowed(), true);
  libraries = [{ ...localLibrary("lib_00000001", "Films"), showInSearch: false }];
  assert.equal(sources[0]!.stillAllowed(), false);
});
