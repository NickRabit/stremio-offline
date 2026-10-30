import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import { setLocale } from "./i18n";
import { emptyViews } from "./views";
import type { SearchSnapshot, Settings } from "./types";

const libraryId = "lib_ab12cd34";
const settings: Settings = {
  concurrentDownloads: 1, parallelPerProvider: 1, downloadSegments: 2,
  uiLanguage: "en", audioLanguage: "en", subtitleLanguage: "en", downloadTitleLanguage: "ui",
  mergeByName: true, streamSort: "rule:balanced", trackProgress: true, showResumeRow: true,
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
const snapshot = (): SearchSnapshot => ({
  revision: 1,
  state: "complete",
  sources: [{
    id: "s0", sourceClass: "local", label: "Films", state: "exhausted",
    loaded: 1, hasMore: false, continuation: "supported", retryable: false,
  }],
  clusters: [{
    key: "deep", kind: "file", title: "Hluboky soubor", sourceLabels: ["Films"],
    hasLocal: true, hasRemote: false, memberCount: 1, primaryMemberKey: "deep-member",
    memberKeys: ["deep-member"], rank: 1, score: 1,
  }],
  unidentified: [],
  aliases: [],
  limitReached: false,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let root: Root;
let host: HTMLDivElement;
let browseUrls: URL[];
let startBodies: Array<Record<string, unknown>>;
let searchEverywhere = true;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  sessionStorage.clear();
  localStorage.clear();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    media: "",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  vi.stubGlobal("scrollTo", vi.fn());
  browseUrls = [];
  startBodies = [];
  searchEverywhere = true;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://test");
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/status") return json({ status: "ok", version: "test", searchEverywhere });
    if (url.pathname === "/api/auth/me") return json({ username: "alice", role: "admin", language: "en" });
    if (url.pathname === "/api/addons" || url.pathname === "/api/catalogs" || url.pathname === "/api/searchable") return json([]);
    if (url.pathname === "/api/libraries") return json([library]);
    if (url.pathname === "/api/views") return json(emptyViews());
    if (url.pathname === "/api/settings") return json(settings);
    if (url.pathname === "/api/languages") return json([]);
    if (url.pathname === "/api/downloads") return json({ jobs: [], halt: null, deviceTransfers: [] });
    if (url.pathname === "/api/follows" || url.pathname === "/api/new-episodes") return json([]);
    if (url.pathname === "/api/search/state") return json({ saveHistory: false, liveSearch: false, defaultOrder: "source", recent: [] });
    if (url.pathname === "/api/search/preferences") return json({ liveSearch: false });
    if (url.pathname === "/api/library/scan") return json({ status: "idle", total: 0, done: 0, matched: 0, skipped: 0, failed: 0 });
    if (url.pathname === "/api/remote-libraries") return json({ libraries: [] });
    if (url.pathname === "/api/library/browse") {
      browseUrls.push(url);
      const path = url.searchParams.get("path") ?? "";
      const items = path === "" ? [{ kind: "folder", path: "Filmy", name: "Filmy", fileCount: 1, size: 1 }] : [];
      return json({ path, items, total: items.length, pending: false });
    }
    if (url.pathname === "/api/search/everywhere" && method === "POST") {
      startBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({ id: "search_one", snapshot: snapshot() });
    }
    if (url.pathname === "/api/search/everywhere/search_one/poll") return json({ changed: false, revision: 1 });
    if (url.pathname.startsWith("/api/search/everywhere/search_one")) return json({});
    return json({}, 404);
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((done) => setTimeout(done, 0));
  });
};

const openLibrary = async () => {
  await act(async () => { root.render(<App/>); });
  await flush();
  const libraryButton = [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Library");
  expect(libraryButton).toBeTruthy();
  await act(async () => { libraryButton!.click(); });
  await flush();
};

const hledat = () => [...host.querySelectorAll<HTMLButtonElement>(".browse-tools button")]
  .find((button) => button.textContent?.trim() === "Search");

describe("library search", () => {
  it("opens Search from a folder and returns to that folder", async () => {
    await openLibrary();
    expect(host.querySelector('input[aria-label="Filter the library"]')).toBeNull();
    expect(hledat()).toBeTruthy();

    const folder = host.querySelector<HTMLElement>('[data-path="Filmy"] .library-open, [data-path="Filmy"] button');
    expect(folder).toBeTruthy();
    await act(async () => { folder!.click(); });
    await flush();

    await act(async () => { hledat()!.click(); });
    await flush();

    expect(host.querySelector(".search-everywhere")).toBeTruthy();
    const libraries = [...host.querySelectorAll<HTMLButtonElement>(".search-filters button")]
      .find((button) => button.textContent?.trim() === "Libraries");
    expect(libraries?.getAttribute("aria-pressed")).toBe("true");
    const chip = [...host.querySelectorAll<HTMLButtonElement>(".search-filters button")]
      .find((button) => button.getAttribute("aria-label") === "Search all libraries");
    expect(chip?.textContent).toContain("Films");
    expect(chip?.textContent).toContain("Filmy");

    const back = host.querySelector<HTMLButtonElement>(".search-return");
    expect(back?.textContent).toContain("Back to the library");
    await act(async () => { back!.click(); });
    await flush();

    expect(host.querySelector(".search-everywhere")).toBeNull();
    expect([...host.querySelectorAll(".crumbs button")].some((button) => button.textContent?.includes("Filmy"))).toBe(true);
    expect(host.querySelector('input[aria-label="Filter the library"]')).toBeNull();
  });

  it("lets the top bar's Search start on every source after a Library preset", async () => {
    await openLibrary();
    await act(async () => { hledat()!.click(); });
    await flush();
    const pressed = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(".search-filters button")]
      .find((button) => button.textContent?.trim() === label)?.getAttribute("aria-pressed");
    expect(pressed("Libraries")).toBe("true");

    const topbar = host.querySelector<HTMLButtonElement>(".topbar-search");
    expect(topbar).toBeTruthy();
    await act(async () => { topbar!.click(); });
    await flush();

    expect(pressed("All")).toBe("true");
    expect(pressed("Libraries")).toBe("false");
    expect(host.querySelector(".search-return")).toBeNull();
  });

  it("keeps the filter field when search everywhere is off", async () => {
    searchEverywhere = false;
    await openLibrary();
    expect(host.querySelector('input[aria-label="Filter the library"]')).toBeTruthy();
    expect(hledat()).toBeUndefined();
  });

  it("opens Search from the library itself without filtering the browse listing", async () => {
    await openLibrary();
    expect(host.querySelector('input[aria-label="Filter the library"]')).toBeNull();
    await act(async () => { hledat()!.click(); });
    await flush();

    expect(host.querySelector(".search-everywhere")).toBeTruthy();
    const libraries = [...host.querySelectorAll<HTMLButtonElement>(".search-filters button")]
      .find((button) => button.textContent?.trim() === "Libraries");
    expect(libraries?.getAttribute("aria-pressed")).toBe("true");
    const chip = [...host.querySelectorAll<HTMLButtonElement>(".search-filters button")]
      .find((button) => button.getAttribute("aria-label") === "Search all libraries");
    expect(chip?.textContent).toContain("Films");
    expect(startBodies).toEqual([]);
    expect(browseUrls.every((url) => !url.searchParams.get("query"))).toBe(true);
  });
});
