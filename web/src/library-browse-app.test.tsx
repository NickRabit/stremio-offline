import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import { setLocale } from "./i18n";
import type { BrowseItem, BrowseResult, Settings, UserViews } from "./types";
import { emptyViews } from "./views";

const libraryId = "lib_ab12cd34";
const settings: Settings = {
  concurrentDownloads: 1, parallelPerProvider: 1, downloadSegments: 2,
  uiLanguage: "en", audioLanguage: "en", subtitleLanguage: "en", downloadTitleLanguage: "ui",
  mergeByName: true, streamSort: "rule:balanced", trackProgress: true, showResumeRow: true,
  upNextAt: "end", skipSegmentsAuto: false,
  libraryAutoScan: true, libraryScanPauseOnDownload: false, secureMode: true, addonRefreshHours: 24,
  tileSize: "medium", catalogTileShape: "poster", libraryTileShape: "poster",
  favoritesTileShape: "poster", resumeTileShape: "poster", followingTileShape: "poster",
  homeTileShape: "wide", searchTileShape: "poster", startView: "library", libraryShelf: "resume",
  realDebridConfigured: false, tmdbConfigured: false,
};
const library = {
  id: libraryId, name: "Films", type: "mixed", root: "/downloads", enabled: true, order: 0,
  addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: false, autoScanMetadata: true,
  unreachable: false, readOnly: false, writable: true, defaultMovie: true, defaultSeries: true,
  titles: 1, files: 1, bytes: 1,
};

const folder = (name: string): BrowseItem => ({
  kind: "folder", path: `Films/${name}`, name, fileCount: 1, size: 1,
  match: "unmatched", favorite: false,
});
const page = (items: BrowseItem[], total = items.length, pending = false): BrowseResult =>
  ({ path: "", items, total, pending });
const named = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => folder(`${prefix} ${String(index + 1).padStart(2, "0")}`));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Gate {
  active: boolean;
  matches: (url: URL) => boolean;
  promise: Promise<void>;
}

let root: Root;
let host: HTMLDivElement;
let browseUrls: URL[];
let favoritesUrls: URL[];
let browseReply: (url: URL) => Response | Promise<Response>;
let favoritesReply: (url: URL) => Response | Promise<Response>;
let viewsReply: UserViews;
let gates: Map<number, Gate>;
let gateReleases: Array<() => void>;

const hold = (matches: (url: URL) => boolean) => {
  const id = gates.size + gateReleases.length + 1;
  let releaseGate!: () => void;
  const gate: Gate = {
    active: true,
    matches,
    promise: new Promise<void>((resolve) => { releaseGate = resolve; }),
  };
  const release = () => {
    if (!gate.active) return;
    gate.active = false;
    gates.delete(id);
    releaseGate();
  };
  gates.set(id, gate);
  gateReleases.push(release);
  return release;
};
const waitAtGate = async (url: URL) => {
  const waiting = [...gates.values()].filter((gate) => gate.active && gate.matches(url));
  await Promise.all(waiting.map((gate) => gate.promise));
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  sessionStorage.clear();
  localStorage.clear();
  vi.stubGlobal("matchMedia", () => ({
    matches: false, media: "", onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1000);
  Element.prototype.scrollTo = () => undefined;
  browseUrls = [];
  favoritesUrls = [];
  browseReply = () => json(page([folder("Films")]));
  favoritesReply = () => json({ items: [], total: 0, pending: false });
  viewsReply = emptyViews();
  gates = new Map();
  gateReleases = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://test");
    const path = url.pathname;
    if (path === "/api/status") return json({ status: "ok", version: "test", searchEverywhere: false });
    if (path === "/api/auth/me") return json({ username: "alice", role: "admin", language: "en" });
    if (path === "/api/addons" || path === "/api/catalogs" || path === "/api/searchable" || path === "/api/languages") return json([]);
    if (path === "/api/libraries") return json([library]);
    if (path === "/api/views") {
      await waitAtGate(url);
      return json(viewsReply);
    }
    if (path === "/api/settings") return json(settings);
    if (path === "/api/downloads") return json({ jobs: [], halt: null, deviceTransfers: [] });
    if (path === "/api/follows") return json({ follows: [] });
    if (path === "/api/follows/new-episodes") return json({ items: [] });
    if (path === "/api/search/state") return json({ saveHistory: false, liveSearch: false, defaultOrder: "source", recent: [] });
    if (path === "/api/search/preferences") return json({ liveSearch: false });
    if (path === "/api/source-profiles") return json({ profiles: [] });
    if (path === "/api/watchlist" || path === "/api/progress") return json([]);
    if (path === "/api/remote-libraries") return json({ libraries: [] });
    if (path === "/api/library/scan") return json({ status: "idle", total: 0, done: 0, matched: 0, skipped: 0, failed: 0 });
    if (path === "/api/library/suggestions" || path === "/api/library/ops" || path === "/api/library/ops/active") return json({ items: [], total: 0, jobs: [] });
    if (path === "/api/library/browse") {
      browseUrls.push(url);
      await waitAtGate(url);
      return browseReply(url);
    }
    if (path === "/api/favorites" || path === "/api/library/favorites") {
      favoritesUrls.push(url);
      await waitAtGate(url);
      return favoritesReply(url);
    }
    return json({}, 404);
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  for (const release of gateReleases) release();
  await flush();
  if (vi.isFakeTimers()) vi.useRealTimers();
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((done) => setTimeout(done, 0));
  });
};

const until = async (ready: () => boolean, message = "condition") => {
  for (let step = 0; step < 80 && !ready(); step += 1) await flush();
  expect(ready(), message).toBe(true);
};

const openLibrary = async () => {
  await act(async () => { root.render(<App/>); });
  await until(() => host.querySelector('button[aria-label="Library"]') !== null, "Library navigation");
  await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Library"]')!.click(); });
  await until(() => host.querySelector("main.view-library .browse-bar") !== null, "library browser");
};

const typeFilter = async (value: string) => {
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Filter the library"]');
  expect(input, "library filter").toBeTruthy();
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const labels = () => [...host.querySelectorAll(".browse-panel .browse-item .library-copy > strong")]
  .map((node) => node.textContent ?? "");
const browseLoading = () => host.querySelector(".browse-panel .loading");
const queried = (query: string) => (url: URL) => url.pathname === "/api/library/browse"
  && url.searchParams.get("query") === query;
const unfiltered = (url: URL) => url.pathname === "/api/library/browse"
  && url.searchParams.get("query") === null;
const browseWithLimit = (limit: string) => (url: URL) => url.pathname === "/api/library/browse"
  && url.searchParams.get("query") === null && url.searchParams.get("limit") === limit;

describe("library browsing", () => {
  it("drops a late answer for a filter that has already changed", async () => {
    const releaseFirst = hold(unfiltered);
    browseReply = (url) => json(url.searchParams.get("query") === "Filtered"
      ? page([folder("Filtered result")])
      : page([folder("Earlier result")]));

    await openLibrary();
    await until(() => browseUrls.length > 0, "held library listing");
    await typeFilter("Filtered");
    await until(() => labels().includes("Filtered result"), "filtered listing");
    expect(labels()).not.toContain("Earlier result");

    releaseFirst();
    await flush();
    await flush();

    expect(labels()).toEqual(["Filtered result"]);
  });

  it("keeps a superseded listing failure off the screen", async () => {
    const releaseFirst = hold(unfiltered);
    browseReply = (url) => url.searchParams.get("query") === "Filtered"
      ? json(page([folder("Filtered result")]))
      : json({ error: "old listing failed" }, 500);

    await openLibrary();
    await until(() => browseUrls.length > 0, "held library listing");
    await typeFilter("Filtered");
    await until(() => labels().includes("Filtered result"), "filtered listing");

    releaseFirst();
    await flush();
    await flush();

    expect(host.querySelector(".toast.error")).toBeNull();
    expect(labels()).toEqual(["Filtered result"]);
  });

  it("appends the next page after sixty items", async () => {
    const items = named("Entry", 61);
    const releaseLoadMore = hold((url) => url.pathname === "/api/library/browse"
      && url.searchParams.get("skip") === "60");
    browseReply = (url) => json(url.searchParams.get("skip") === "60"
      ? page([items[60]!], 61)
      : page(items.slice(0, 60), 61));

    await openLibrary();
    await until(() => labels().length === 60 && host.querySelector(".load-more button") !== null, "first page");

    await act(async () => { host.querySelector<HTMLButtonElement>(".browse-panel .load-more button")!.click(); });
    await until(() => browseUrls.some((url) => url.searchParams.get("skip") === "60"), "load more request");
    releaseLoadMore();
    await until(() => labels().length === 61, "second page");

    const loadMore = browseUrls.find((url) => url.searchParams.get("skip") === "60");
    expect(loadMore?.searchParams.get("skip")).toBe("60");
    expect(labels()).toEqual(items.map((item) => item.kind === "folder" ? item.name : ""));
  });

  it("uses the saved library sort for the first listing", async () => {
    viewsReply = {
      ...emptyViews(),
      libraries: {
        [libraryId]: { sort: "size", order: "desc", favoritesOnly: false, view: "grid" },
      },
    };
    const releaseViews = hold((url) => url.pathname === "/api/views");

    await openLibrary();
    releaseViews();
    await until(() => browseUrls.length > 0, "first library listing");

    expect(browseUrls[0]!.searchParams.get("sort")).toBe("size");
    expect(browseUrls[0]!.searchParams.get("order")).toBe("desc");
    expect(browseUrls.some((url) => url.searchParams.get("sort") === "name")).toBe(false);
  });

  it("keeps the busy indicator tied to the newest listing as older requests settle", async () => {
    const releaseFirst = hold(unfiltered);
    const releaseLatest = hold(queried("Second"));
    browseReply = (url) => {
      const query = url.searchParams.get("query");
      if (query === "First") return json(page([folder("First result")]));
      if (query === "Second") return json(page([folder("Second result")]));
      return json(page([folder("Earlier result")]));
    };

    await openLibrary();
    await until(() => browseUrls.length > 0, "held first listing");
    expect(browseLoading()).not.toBeNull();

    await typeFilter("First");
    await until(() => labels().includes("First result"), "first filtered listing");
    expect(browseLoading()).toBeNull();

    await typeFilter("Second");
    await until(() => browseUrls.some((url) => url.searchParams.has("query") && url.searchParams.get("query") === "Second"), "held newer listing");
    expect(browseLoading()).not.toBeNull();

    releaseFirst();
    await flush();
    expect(browseLoading()).not.toBeNull();

    releaseLatest();
    await until(() => labels().includes("Second result"), "newest filtered listing");
    expect(labels()).toEqual(["Second result"]);
    expect(browseLoading()).toBeNull();
  });

  it("refreshes pending artwork with the loaded count and drops a refresh after a filter changes", async () => {
    vi.useFakeTimers();
    let refreshAnswers = 0;
    const firstPage = named("Artwork", 60);
    const loadedPage = named("Artwork", 61);
    const refreshed = named("Refreshed", 61);
    browseReply = (url) => {
      const query = url.searchParams.get("query");
      if (query === "Filtered") return json(page([folder("Filtered result")]));
      if (url.searchParams.get("skip") === "60") return json(page([loadedPage[60]!], 61, true));
      if (url.searchParams.get("limit") === "61") {
        refreshAnswers += 1;
        return json(refreshAnswers === 1
          ? page(refreshed, 61, true)
          : page([folder("Stale refresh")], 61));
      }
      return json(page(firstPage, 61, true));
    };

    try {
      await openLibrary();
      await until(() => labels().length === 60 && host.querySelector(".load-more button") !== null, "pending first page");
      await act(async () => { host.querySelector<HTMLButtonElement>(".load-more button")!.click(); });
      await until(() => labels().length === 61, "loaded second page");

      const releaseFirstRefresh = hold(browseWithLimit("61"));
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      await until(() => browseUrls.some(browseWithLimit("61")), "artwork refresh");
      const refresh = browseUrls.find(browseWithLimit("61"))!;
      expect(refresh.searchParams.get("limit")).toBe("61");
      expect(refresh.searchParams.has("skip")).toBe(false);

      releaseFirstRefresh();
      await until(() => labels()[0] === "Refreshed 01" && labels().length === 61, "refreshed artwork page");

      const releaseStaleRefresh = hold(browseWithLimit("61"));
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      await until(() => browseUrls.filter(browseWithLimit("61")).length >= 2, "second artwork refresh");

      await typeFilter("Filtered");
      await until(() => labels().includes("Filtered result"), "listing after filter change");
      releaseStaleRefresh();
      await flush();
      await flush();

      expect(labels()).toEqual(["Filtered result"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the favourites path through its own endpoint instead of browsing the library", async () => {
    browseReply = () => json(page([{
      ...folder("Favourites"),
      path: ":favorites",
    }]));
    favoritesReply = () => json(page([folder("Favourite item")]));

    await openLibrary();
    await until(() => host.querySelector('[data-path=":favorites"] .library-open') !== null, "favourites path");
    const libraryRequests = browseUrls.length;

    await act(async () => { host.querySelector<HTMLButtonElement>('[data-path=":favorites"] .library-open')!.click(); });
    await until(() => favoritesUrls.length === 1 && labels().includes("Favourite item"), "favourites listing");

    expect(browseUrls).toHaveLength(libraryRequests);
    expect(favoritesUrls[0]!.pathname).toBe("/api/library/favorites");
  });

  it("shows rename by pattern in selection mode and posts a plan", async () => {
    await openLibrary();
    await until(() => host.querySelector(".browse-item") !== null, "library items");
    const selectMode = host.querySelector<HTMLButtonElement>('button[title="Select items"]');
    expect(selectMode).toBeTruthy();
    await act(async () => { selectMode!.click(); });
    await until(() => host.querySelector(".library-bulk-bar") !== null, "bulk toolbar");
    const rename = [...host.querySelectorAll(".library-bulk-bar button")]
      .find((button) => button.textContent?.includes("Rename by pattern"));
    expect(rename, "rename by pattern in the bulk toolbar").toBeTruthy();
    await until(() => host.querySelector(".browse-select") !== null, "selection checkbox");
    await act(async () => { host.querySelector<HTMLButtonElement>(".browse-select")!.click(); });
    expect((rename as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { (rename as HTMLButtonElement).click(); });
    await until(() => vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/api/library/rename-plan")),
      "rename-plan request");
    expect(host.querySelector(".rename-card")).toBeTruthy();
  });
});
