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
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://test");
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/status") return json({ status: "ok", version: "test", searchEverywhere: true });
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
      return json({ path: url.searchParams.get("path") ?? "", items: [], total: 0, pending: false });
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

describe("library search", () => {
  it("renders Search everywhere cards without filtering the browse listing", async () => {
    await act(async () => { root.render(<App/>); });
    await flush();
    const libraryButton = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Library");
    expect(libraryButton).toBeTruthy();
    await act(async () => { libraryButton!.click(); });
    await flush();

    const input = host.querySelector<HTMLInputElement>('input[aria-label="Filter the library"]');
    expect(input).toBeTruthy();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "hluboky");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { await new Promise((done) => setTimeout(done, 350)); });
    await flush();

    expect(host.querySelector("[data-search-card]")?.textContent).toContain("Hluboky soubor");
    expect(startBodies[0]).toEqual(expect.objectContaining({
      sources: ["local"],
      library: { libraryId, path: "" },
    }));
    expect(browseUrls.every((url) => !url.searchParams.get("query"))).toBe(true);
  });
});
