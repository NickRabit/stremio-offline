import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import { setLocale, t } from "./i18n";
import type {
  Catalog,
  CatalogSearchSnapshot,
  Meta,
  SearchState,
  Settings,
  SearchableCatalog,
  UserViews,
} from "./types";
import { emptyViews } from "./views";

const catalogA: Catalog = { addonKey: "alpha", addonName: "Alpha", type: "movie", id: "top", name: "Top" };
const catalogB: Catalog = { addonKey: "beta", addonName: "Beta", type: "series", id: "popular", name: "Popular" };
const settings: Settings = {
  concurrentDownloads: 1, parallelPerProvider: 1, downloadSegments: 2,
  uiLanguage: "en", audioLanguage: "en", subtitleLanguage: "en", downloadTitleLanguage: "ui",
  mergeByName: true, streamSort: "rule:balanced", trackProgress: true, showResumeRow: true,
  upNextAt: "end", skipSegmentsAuto: false,
  libraryAutoScan: true, libraryScanPauseOnDownload: false, secureMode: true, addonRefreshHours: 24,
  tileSize: "medium", catalogTileShape: "poster", libraryTileShape: "poster",
  favoritesTileShape: "poster", resumeTileShape: "poster", followingTileShape: "poster",
  homeTileShape: "wide", searchTileShape: "poster", startView: "catalog", libraryShelf: "resume",
  realDebridConfigured: false, tmdbConfigured: false,
};

const title = (id: string, name: string, type = "movie"): Meta => ({ id, type, name });
const searchResult = (items: Meta[], overrides: Partial<{ cursor: string; hasMore: boolean; sources: number }> = {}) => ({
  items,
  cursor: "",
  hasMore: false,
  sources: 1,
  ...overrides,
});
const snapshot = (overrides: Partial<CatalogSearchSnapshot>): CatalogSearchSnapshot => ({
  revision: 1,
  state: "complete",
  items: [],
  sources: 1,
  pending: 0,
  failed: 0,
  hasMore: false,
  ...overrides,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface RecordedRequest {
  method: string;
  pathname: string;
  query: string;
  body: unknown;
  signal: AbortSignal | null;
  readonly aborted: boolean;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

type Reply = (request: RecordedRequest) => Response | Promise<Response>;

let root: Root;
let host: HTMLDivElement;
let mounted: boolean;
let requests: RecordedRequest[];
let pendingReleases: Array<() => void>;
let searchEverywhere: boolean;
let catalogs: Catalog[];
let searchable: SearchableCatalog[];
let searchState: SearchState;
let catalogReply: Reply;
let legacySearchReply: Reply;
let sessionStartReply: Reply;
let sessionPollReply: Reply;
let historyReply: Reply;
let storedViews: UserViews;

const deferred = <T,>(fallback: T): Deferred<T> => {
  let settled = false;
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  const settle = (done: (value: T) => void, value: T) => {
    if (settled) return;
    settled = true;
    done(value);
  };
  const fail = (reason?: unknown) => {
    if (settled) return;
    settled = true;
    reject(reason);
  };
  pendingReleases.push(() => settle(resolve, fallback));
  return { promise, resolve: (value) => settle(resolve, value), reject: fail };
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  sessionStorage.clear();
  localStorage.clear();
  requests = [];
  pendingReleases = [];
  searchEverywhere = false;
  catalogs = [catalogA, catalogB];
  searchable = [];
  searchState = { saveHistory: false, liveSearch: false, defaultOrder: "source", recent: [] };
  catalogReply = () => json([]);
  legacySearchReply = () => json(searchResult([]));
  sessionStartReply = () => json({}, 404);
  sessionPollReply = () => json({ changed: false, revision: 1 });
  historyReply = () => json({});
  storedViews = emptyViews();
  vi.stubGlobal("matchMedia", () => ({
    matches: false, media: "", onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollTo = () => undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://test");
    const method = init?.method ?? "GET";
    const signal = init?.signal ?? null;
    const body = init?.body === undefined ? null : JSON.parse(String(init.body));
    const request: RecordedRequest = {
      method,
      pathname: url.pathname,
      query: url.search,
      body,
      signal,
      get aborted() { return signal?.aborted === true; },
    };
    requests.push(request);

    if (url.pathname === "/api/status") {
      return json({ status: "ok", version: "test", searchEverywhere });
    }
    if (url.pathname === "/api/auth/me") {
      return json({ username: "alice", role: "admin", language: "en", canSwitch: true });
    }
    if (url.pathname === "/api/profiles") {
      return json({ profiles: [
        { id: "alice", username: "alice", unlock: "none", current: true },
        { id: "bob", username: "bob", unlock: "none", current: false },
      ] });
    }
    if (url.pathname === "/api/addons") return json([]);
    if (url.pathname === "/api/catalogs") return json(catalogs);
    if (url.pathname === "/api/searchable") return json(searchable);
    if (url.pathname === "/api/catalog") return catalogReply(request);
    if (url.pathname === "/api/search" && method === "GET") return legacySearchReply(request);
    if (url.pathname === "/api/search/catalog" && method === "POST") return sessionStartReply(request);
    if (/^\/api\/search\/catalog\/[^/]+\/poll$/.test(url.pathname) && method === "POST") {
      return sessionPollReply(request);
    }
    if (/^\/api\/search\/catalog\/[^/]+$/.test(url.pathname) && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/api/search/state") return json(searchState);
    if (url.pathname === "/api/search/preferences") return json({ liveSearch: false });
    if (url.pathname === "/api/search/history" && method === "POST") return historyReply(request);
    if (url.pathname === "/api/settings") return json(settings);
    if (url.pathname === "/api/libraries") return json([]);
    if (url.pathname === "/api/views" && method === "PATCH") {
      const patch = body as Partial<UserViews>;
      storedViews = {
        ...storedViews,
        ...patch,
        catalog: { ...storedViews.catalog, ...patch.catalog },
      };
      return json(storedViews);
    }
    if (url.pathname === "/api/views") return json(storedViews);
    if (url.pathname === "/api/languages") return json([]);
    if (url.pathname === "/api/downloads") return json({ jobs: [], halt: null, deviceTransfers: [] });
    if (url.pathname === "/api/follows") return json({ follows: [] });
    if (url.pathname === "/api/new-episodes") return json({ items: [] });
    if (url.pathname === "/api/source-profiles") return json({ profiles: [] });
    if (url.pathname === "/api/remote-libraries") return json({ libraries: [] });
    if (url.pathname === "/api/library/scan") {
      return json({ status: "idle", total: 0, done: 0, matched: 0, skipped: 0, failed: 0 });
    }
    if (url.pathname === "/api/library/suggestions") return json({ items: [], total: 0 });
    if (url.pathname === "/api/library/ops") return json({ jobs: [] });
    if (url.pathname === "/api/progress") return json([]);
    if (url.pathname === "/api/watchlist") return json([]);
    if (url.pathname === "/api/avatar/presets") return json({ presets: [] });
    return json({}, 404);
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  mounted = true;
});

afterEach(() => {
  if (mounted) act(() => root.unmount());
  mounted = false;
  host.remove();
  for (const release of pendingReleases) release();
  pendingReleases = [];
  vi.unstubAllGlobals();
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((done) => setTimeout(done, 0));
  });
};

const until = async (ready: () => boolean, label = "condition") => {
  for (let step = 0; step < 80 && !ready(); step += 1) await flush();
  expect(ready(), label).toBe(true);
};

const navButton = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("nav button")]
    .find((button) => button.getAttribute("aria-label") === label);

const clickNav = async (label: string) => {
  const button = navButton(label);
  expect(button, `navigation button ${label}`).toBeTruthy();
  await act(async () => { button!.click(); });
  await flush();
};

const openCatalog = async () => {
  await act(async () => { root.render(<App/>); });
  await until(() => navButton("Catalog") !== undefined, "Catalog navigation");
  if (!host.querySelector("main.view-catalog")) await clickNav("Catalog");
  await until(() => host.querySelector("main.view-catalog") !== null, "Catalog view");
  await until(() => requests.some((request) => request.pathname === "/api/catalogs"), "catalog list request");
  await flush();
};

const typeInto = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const searchInput = () => host.querySelector<HTMLInputElement>("main.view-catalog .searchbar input")!;

const submitSearch = async (query: string) => {
  const input = searchInput();
  expect(input).toBeTruthy();
  await typeInto(input, query);
  await act(async () => { input.form!.requestSubmit(); });
};

const clickButtonText = async (text: string, scope: ParentNode = host) => {
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find((node) => node.textContent?.trim() === text);
  expect(button, `button ${text}`).toBeTruthy();
  await act(async () => { button!.click(); });
};

const choosePickerOption = async (text: string) => {
  const option = [...host.querySelectorAll<HTMLButtonElement>(".picker-option")]
    .find((node) => node.textContent?.includes(text));
  expect(option, `picker option ${text}`).toBeTruthy();
  await act(async () => { option!.click(); });
  await flush();
};

const clickLabeledButton = async (label: string) => {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button, `button ${label}`).toBeTruthy();
  await act(async () => { button!.click(); });
  await flush();
};

const chooseCatalog = async (name: string) => {
  await act(async () => { host.querySelector<HTMLButtonElement>("button.catalog-trigger")!.click(); }); await flush();
  await choosePickerOption(name);
};

const chooseScope = async (name: string) => {
  await act(async () => { host.querySelector<HTMLButtonElement>("button.scope-trigger")!.click(); }); await flush();
  await choosePickerOption(name);
};

const gridNames = () =>
  [...host.querySelectorAll<HTMLElement>("main.view-catalog .poster-card strong")]
    .map((node) => node.textContent ?? "");

const matchingRequests = (pathname: string, method?: string) =>
  requests.filter((request) => request.pathname === pathname && (method === undefined || request.method === method));

const historyPosts = () => matchingRequests("/api/search/history", "POST");
const sessionDeletes = () => requests.filter((request) =>
  request.method === "DELETE" && /^\/api\/search\/catalog\/[^/]+$/.test(request.pathname));

describe("catalogue and search loading in App", () => {
  it("restores the last browsable catalog from account preferences", async () => {
    storedViews = {
      ...emptyViews(),
      catalog: {
        ...emptyViews().catalog,
        last: { addonKey: "beta", type: "series", id: "popular", genre: "" },
      },
    };

    await openCatalog();
    await until(() => matchingRequests("/api/catalog").some((request) =>
      new URLSearchParams(request.query).get("id") === "popular"), "restored catalogue request");
    expect(host.querySelector("button.catalog-trigger")?.textContent).toContain("Popular");
  });

  it("ignores a stored last catalog that the account cannot browse", async () => {
    storedViews = {
      ...emptyViews(),
      catalog: {
        ...emptyViews().catalog,
        last: { addonKey: "ghost", type: "movie", id: "missing", genre: "" },
      },
    };

    await openCatalog();
    await flush();
    expect(matchingRequests("/api/catalog").map((request) =>
      new URLSearchParams(request.query).get("id"))).toEqual(["top"]);
    expect(host.textContent).not.toContain("ghost");
  });

  it("stores a catalog choice once and does not rewrite identical preferences", async () => {
    await openCatalog();
    await chooseCatalog("Popular");
    await act(async () => { await new Promise((done) => setTimeout(done, 350)); });
    await until(() => matchingRequests("/api/views", "PATCH").length === 1, "catalog preference write");
    expect(matchingRequests("/api/views", "PATCH")[0]!.body).toMatchObject({
      catalog: {
        recent: [{ addonKey: "beta", type: "series", id: "popular" }],
        last: { addonKey: "beta", type: "series", id: "popular", genre: "" },
      },
    });

    await chooseCatalog("Popular");
    await act(async () => { await new Promise((done) => setTimeout(done, 350)); });
    expect(matchingRequests("/api/views", "PATCH")).toHaveLength(1);
  });

  it("merges a second catalogue page and stops paging when a page adds nothing", async () => {
    const first = deferred<Response>(json([]));
    const second = deferred<Response>(json([]));
    const third = deferred<Response>(json([]));
    catalogReply = (request) => {
      const skip = Number(new URLSearchParams(request.query).get("skip") ?? 0);
      return skip === 0 ? first.promise : skip === 1 ? second.promise : third.promise;
    };

    await openCatalog();
    await until(() => matchingRequests("/api/catalog").length === 1, "first catalogue page");
    first.resolve(json([title("a", "Alpha")]));
    await until(() => gridNames().join() === "Alpha", "first catalogue card");

    await clickButtonText("Load more", host.querySelector("main.view-catalog")!);
    await until(() => matchingRequests("/api/catalog").length === 2, "second catalogue page");
    second.resolve(json([title("b", "Beta")]));
    await until(() => gridNames().join() === "Alpha,Beta", "merged catalogue page");

    await clickButtonText("Load more", host.querySelector("main.view-catalog")!);
    await until(() => matchingRequests("/api/catalog").length === 3, "third catalogue page");
    third.resolve(json([title("b", "Beta")]));
    await until(() => !host.querySelector("main.view-catalog .load-more button"), "paging to end");

    expect(gridNames()).toEqual(["Alpha", "Beta"]);
    expect(matchingRequests("/api/catalog").map((request) =>
      new URLSearchParams(request.query).get("skip"))).toEqual([null, "1", "2"]);
  });

  it("ignores a late catalogue page after the viewer switches catalogues", async () => {
    const pageA = deferred<Response>(json([]));
    const pageB = deferred<Response>(json([]));
    catalogReply = (request) => new URLSearchParams(request.query).get("id") === "top" ? pageA.promise : pageB.promise;

    await openCatalog();
    await until(() => matchingRequests("/api/catalog").some((request) =>
      new URLSearchParams(request.query).get("id") === "top"), "catalogue A page");
    await chooseCatalog("Popular");
    await until(() => matchingRequests("/api/catalog").some((request) =>
      new URLSearchParams(request.query).get("id") === "popular"), "catalogue B page");

    pageB.resolve(json([title("b", "Beta title", "series")]));
    await until(() => gridNames().join() === "Beta title", "catalogue B card");
    pageA.resolve(json([title("a", "Late Alpha")]));
    await flush();

    expect(gridNames()).toEqual(["Beta title"]);
  });

  it("aborts a superseded search and ignores its late answer without reporting an abort", async () => {
    searchEverywhere = false;
    const first = deferred<Response>(json(searchResult([])));
    const second = deferred<Response>(json(searchResult([])));
    legacySearchReply = (request) => {
      const query = new URLSearchParams(request.query).get("query");
      return query === "First" ? first.promise : second.promise;
    };

    await openCatalog();
    await submitSearch("First");
    await until(() => matchingRequests("/api/search").length === 1, "first search request");
    await submitSearch("Second");
    await until(() => matchingRequests("/api/search").length === 2, "second search request");

    const [oldRequest, newRequest] = matchingRequests("/api/search");
    expect(oldRequest!.aborted).toBe(true);
    expect(newRequest!.aborted).toBe(false);
    first.resolve(json(searchResult([title("old", "Old result")])));
    second.resolve(json(searchResult([title("new", "New result")])));
    await until(() => gridNames().join() === "New result", "new search result");
    await flush();

    expect(gridNames()).toEqual(["New result"]);
    expect(host.querySelector(".toast.error")).toBeNull();
  });

  it("records a successful legacy search once and clears the grid on a later failure", async () => {
    searchEverywhere = false;
    searchState = { saveHistory: true, liveSearch: false, defaultOrder: "source", recent: [] };
    legacySearchReply = (request) => new URLSearchParams(request.query).get("query") === "Works"
      ? json(searchResult([title("works", "Working result")]))
      : json({ error: "Search broke" }, 500);

    await openCatalog();
    await until(() => matchingRequests("/api/search/state").length > 0, "search state request");
    await flush();
    await submitSearch("Works");
    await until(() => gridNames().join() === "Working result", "successful search result");
    await until(() => historyPosts().length === 1, "search history write");
    expect(historyPosts()[0]!.body).toEqual({ query: "Works" });

    await submitSearch("Fails");
    await until(() => host.querySelector(".toast.error")?.textContent?.includes("Search broke") === true, "search error");

    expect(gridNames()).toEqual([]);
    expect(historyPosts()).toHaveLength(1);
  });

  it("sends the session search shape and renders start and poll snapshots as they arrive", async () => {
    searchEverywhere = true;
    searchState = { saveHistory: true, liveSearch: false, defaultOrder: "source", recent: [] };
    searchable = [{
      addonKey: "alpha", addonName: "Alpha", globalSearch: false,
      type: "movie", id: "top", name: "Top",
    }];
    const start = deferred<Response>(json({}, 404));
    const poll = deferred<Response>(json({ changed: false, revision: 1 }));
    sessionStartReply = () => start.promise;
    sessionPollReply = () => poll.promise;

    await openCatalog();
    await until(() => host.querySelector("button.scope-trigger") !== null, "search scope button");
    await chooseScope("Top");
    await submitSearch("Needle");
    await until(() => matchingRequests("/api/search/catalog", "POST").length === 1, "session search start");

    expect(matchingRequests("/api/search/catalog", "POST")[0]!.body).toMatchObject({
      query: "Needle",
      type: "movie",
      scope: { addonKey: "alpha", catalogType: "movie", catalogId: "top" },
    });
    start.resolve(json({
      id: "session-one",
      snapshot: snapshot({ state: "partial", items: [title("one", "First snapshot")], pending: 1 }),
    }));
    await until(() => gridNames().join() === "First snapshot", "first session snapshot");
    await until(() => historyPosts().length === 1, "first-snapshot history write");
    expect(historyPosts()[0]!.body).toEqual({ query: "Needle" });

    await until(() => matchingRequests("/api/search/catalog/session-one/poll", "POST").length === 1, "session poll");
    expect(matchingRequests("/api/search/catalog/session-one/poll", "POST")[0]!.body).toEqual({ revision: 1 });
    poll.resolve(json({
      changed: true,
      snapshot: snapshot({
        revision: 2,
        items: [title("one", "First snapshot"), title("two", "Second snapshot")],
      }),
    }));
    await until(() => gridNames().join() === "First snapshot,Second snapshot", "second session snapshot");
    expect(historyPosts()).toHaveLength(1);
  });

  it("falls back to legacy search after a 404 start and does not retry the session for a new query", async () => {
    searchEverywhere = true;
    sessionStartReply = () => json({ error: "unsupported" }, 404);
    legacySearchReply = (request) => json(searchResult([
      title(new URLSearchParams(request.query).get("query") ?? "result", `${new URLSearchParams(request.query).get("query")} result`),
    ]));

    await openCatalog();
    await submitSearch("First");
    await until(() => gridNames().join() === "First result", "fallback result");
    await submitSearch("Second");
    await until(() => gridNames().join() === "Second result", "second legacy result");

    expect(matchingRequests("/api/search/catalog", "POST")).toHaveLength(1);
    expect(matchingRequests("/api/search").map((request) =>
      new URLSearchParams(request.query).get("query"))).toEqual(["First", "Second"]);
  });

  it("aborts and deletes an open session search when leaving the catalogue", async () => {
    searchEverywhere = true;
    const poll = deferred<Response>(json({ changed: false, revision: 1 }));
    sessionStartReply = () => json({
      id: "session-leave",
      snapshot: snapshot({ state: "partial", items: [title("one", "Open result")], pending: 1 }),
    });
    sessionPollReply = () => poll.promise;

    await openCatalog();
    await submitSearch("Open");
    await until(() => matchingRequests("/api/search/catalog/session-leave/poll", "POST").length === 1, "open session poll");
    await clickNav("Downloads");
    await until(() => sessionDeletes().some((request) =>
      request.pathname === "/api/search/catalog/session-leave"), "session delete");

    expect(matchingRequests("/api/search/catalog/session-leave/poll", "POST")[0]!.aborted).toBe(true);
    poll.reject(new DOMException("Aborted", "AbortError"));
    await flush();
    expect(host.querySelector(".toast.error")).toBeNull();
  });

  it("aborts and deletes an open session search when App unmounts", async () => {
    searchEverywhere = true;
    const poll = deferred<Response>(json({ changed: false, revision: 1 }));
    sessionStartReply = () => json({
      id: "session-unmount",
      snapshot: snapshot({ state: "partial", items: [title("one", "Open result")], pending: 1 }),
    });
    sessionPollReply = () => poll.promise;

    await openCatalog();
    await submitSearch("Open");
    await until(() => matchingRequests("/api/search/catalog/session-unmount/poll", "POST").length === 1, "open session poll");
    const openPoll = matchingRequests("/api/search/catalog/session-unmount/poll", "POST")[0]!;
    await act(async () => { root.unmount(); });
    mounted = false;
    await until(() => sessionDeletes().some((request) =>
      request.pathname === "/api/search/catalog/session-unmount"), "unmount session delete");

    expect(openPoll.aborted).toBe(true);
    poll.reject(new DOMException("Aborted", "AbortError"));
    await flush();
  });

  it("keeps old results only for query-only changes and clears them for type or catalogue changes", async () => {
    searchEverywhere = false;
    const initialCatalog = deferred<Response>(json([]));
    const afterCancel = deferred<Response>(json([]));
    const pageB = deferred<Response>(json([]));
    let catalogCalls = 0;
    catalogReply = () => {
      catalogCalls += 1;
      if (catalogCalls === 1) return initialCatalog.promise;
      if (catalogCalls === 2) return afterCancel.promise;
      return pageB.promise;
    };
    const secondSearch = deferred<Response>(json(searchResult([])));
    const filteredSearch = deferred<Response>(json(searchResult([])));
    legacySearchReply = (request) => {
      const query = new URLSearchParams(request.query).get("query");
      const type = new URLSearchParams(request.query).get("type");
      if (query === "First") return json(searchResult([title("first", "First result")]));
      if (type === "movie") return filteredSearch.promise;
      return secondSearch.promise;
    };

    await openCatalog();
    await until(() => catalogCalls === 1, "initial catalogue page");
    initialCatalog.resolve(json([title("catalog-a", "Catalogue A")]));
    await until(() => gridNames().join() === "Catalogue A", "catalogue A card");

    await submitSearch("First");
    await until(() => gridNames().join() === "First result", "first query result");
    await submitSearch("Second");
    await until(() => matchingRequests("/api/search").length === 2, "second search request");
    await flush();
    expect(gridNames()).toEqual(["First result"]);

    secondSearch.resolve(json(searchResult([title("second", "Second result")])));
    await until(() => gridNames().join() === "Second result", "second query result");

    const results = host.querySelector(".results-filter");
    expect(results).toBeTruthy();
    await clickButtonText(t("catalog.movies"), results!);
    await until(() => matchingRequests("/api/search").length === 3, "filtered search request");
    await flush();
    expect(gridNames()).toEqual([]);
    filteredSearch.resolve(json(searchResult([title("filtered", "Filtered result")])));
    await until(() => gridNames().join() === "Filtered result", "filtered result");

    await clickButtonText("Cancel", host.querySelector("main.view-catalog")!);
    await until(() => catalogCalls === 2, "catalogue reload after cancelling search");
    await flush();
    expect(gridNames()).toEqual([]);
    afterCancel.resolve(json([title("catalog-a", "Catalogue A again")]));
    await until(() => gridNames().join() === "Catalogue A again", "reloaded catalogue");

    await chooseCatalog("Popular");
    await until(() => catalogCalls === 3, "second catalogue request");
    await flush();
    expect(gridNames()).toEqual([]);
    pageB.resolve(json([title("catalog-b", "Catalogue B", "series")]));
    await until(() => gridNames().join() === "Catalogue B", "second catalogue result");
  });
});
