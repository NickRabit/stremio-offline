import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import { setLocale } from "./i18n";
import { clearTitleExtras } from "./title-extras";
import type { Meta, SearchSnapshot, Settings } from "./types";
import { emptyViews } from "./views";

const settings: Settings = {
  concurrentDownloads: 1, parallelPerProvider: 1, downloadSegments: 2,
  uiLanguage: "en", audioLanguage: "en", subtitleLanguage: "en", downloadTitleLanguage: "ui",
  mergeByName: true, streamSort: "rule:balanced", trackProgress: true, showResumeRow: true,
  libraryAutoScan: true, libraryScanPauseOnDownload: false, secureMode: true, addonRefreshHours: 24,
  tileSize: "medium", catalogTileShape: "poster", libraryTileShape: "poster",
  favoritesTileShape: "poster", resumeTileShape: "poster", followingTileShape: "poster",
  homeTileShape: "wide", searchTileShape: "poster", startView: "catalog", libraryShelf: "resume",
  realDebridConfigured: false, tmdbConfigured: false,
};

const heat: Meta = {
  id: "tt1", type: "movie", name: "Heat", poster: "/heat.jpg", description: "A quiet film.",
  releaseInfo: "1995", genres: ["Crime"], imdbRating: "8.6",
};
const town: Meta = { id: "tt2", type: "movie", name: "The Town", description: "Another film." };
const show: Meta = {
  id: "tt9", type: "series", name: "The Show", description: "A long show.", releaseInfo: "2011", genres: ["Drama"],
  videos: [
    { id: "tt9:1:1", season: 1, episode: 1, title: "Pilot" },
    { id: "tt9:1:2", season: 1, episode: 2, title: "Second" },
  ],
};
const plain: Meta = { id: "tt4", type: "movie", name: "Plain", description: "Nothing else like it." };
const otherFilm: Meta = { id: "tt6", type: "movie", name: "Other Film", description: "A remote cousin." };
const extrasFor = (id: string) => id === "tt1" ? {
  people: [{ name: "Michael Mann", role: "director" }, { name: "Ada Lovelace", role: "cast", character: "Ada", photo: "/ada.jpg" }],
  related: [{ type: "movie", id: "tt2", name: "The Town", year: "2010", poster: "/town.jpg" }],
  ageRating: "R",
  originalTitle: "Heat",
  source: "tmdb",
} : id === "tt9" ? {
  people: [{ name: "Show Runner", role: "director" }, { name: "Ada Lovelace", role: "cast", character: "Ada" }],
  related: [{ type: "movie", id: "tt4", name: "Plain", year: "2012" }],
  source: "tmdb",
} : id === "tt5000" ? {
  people: [{ name: "Director One", role: "director" }],
  related: [{ type: "movie", id: "tt6", name: "Other Film", poster: "/other.jpg" }],
  ageRating: "PG",
  source: "addon",
} : { people: [], related: [], source: "addon" };

const heatFile = {
  kind: "file" as const, path: "Films/Heat.mkv", label: "Heat.mkv", season: null, episode: null,
  size: 2000, modified: "2026-01-01T00:00:00Z", match: "matched" as const, titleType: "movie" as const, catalogName: "Heat",
};
const remoteCapabilities = { rename: false, move: false, delete: false, identify: false, writeArtwork: false, downloadToLibrary: false, downloadToDevice: false };
const jellyLibrary = {
  id: "rlib_a", connectionId: "mconn_1", remoteId: "lib1", name: "Films", type: "mixed" as const,
  enabled: true, order: 0, showOnHome: true, showInContinueWatching: true, provider: "jellyfin" as const, capabilities: remoteCapabilities,
};
const jelly = { id: "mov1", name: "Jelly Movie", type: "movie" as const, providerIds: { imdb: "tt5000" }, poster: "/jelly.jpg", year: 1999 };
const downloadJob = (status: "downloading" | "completed") => ({
  id: "job1", title: "Heat", status, target: "library", received: 10, speed: 1,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", pending: false, order: 0,
});

const snapshot = (): SearchSnapshot => ({
  revision: 1,
  state: "complete",
  sources: [],
  clusters: [],
  unidentified: [],
  aliases: [],
  limitReached: false,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let root: Root;
let host: HTMLDivElement;
let searchEverywhere = true;
let startBodies: Array<Record<string, unknown>>;
let searchQueries: string[];
let catalogItems: Meta[];
let libraryItems: Array<typeof heatFile>;
let remoteLibraries: Array<typeof jellyLibrary>;
let downloadMode: "idle" | "downloading" | "completed" | "unauthorized";
let extrasCalls: string[];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  clearTitleExtras();
  sessionStorage.clear();
  localStorage.clear();
  searchEverywhere = true;
  startBodies = [];
  searchQueries = [];
  catalogItems = [heat];
  libraryItems = [];
  remoteLibraries = [];
  downloadMode = "idle";
  extrasCalls = [];
  vi.stubGlobal("matchMedia", () => ({
    matches: false, media: "", onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
  vi.stubGlobal("scrollTo", vi.fn());
  Element.prototype.scrollTo = () => undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://test");
    const path = url.pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/status") return json({ status: "ok", version: "test", searchEverywhere });
    if (path === "/api/auth/me") return json({ username: "alice", role: "admin", language: "en" });
    if (path === "/api/auth/login" && method === "POST") return json({ username: "bob", role: "admin", language: "en" });
    if (path === "/api/addons" || path === "/api/searchable" || path === "/api/languages") return json([]);
    if (path === "/api/catalogs") return json([{ addonKey: "cinemeta", addonName: "Cinemeta", type: "movie", id: "top", name: "Top" }]);
    if (path === "/api/catalog") return json(catalogItems);
    if (path === "/api/libraries") return json([]);
    if (path === "/api/views") return json(emptyViews());
    if (path === "/api/settings") return json(settings);
    if (path === "/api/downloads") {
      if (downloadMode === "unauthorized") return json({ error: "signed out" }, 401);
      if (downloadMode === "idle") return json({ jobs: [], halt: null, deviceTransfers: [] });
      return json({ jobs: [downloadJob(downloadMode)], halt: null, deviceTransfers: [] });
    }
    if (path === "/api/follows") return json({ follows: [] });
    if (path === "/api/follows/new-episodes") return json({ items: [] });
    if (path === "/api/search/state") return json({ saveHistory: false, liveSearch: false, defaultOrder: "source", recent: [] });
    if (path === "/api/search/preferences") return json({ liveSearch: false });
    if (path === "/api/source-profiles") return json({ profiles: [] });
    if (path === "/api/watchlist" || path === "/api/progress") return json([]);
    if (path === "/api/remote-libraries") return json({ libraries: remoteLibraries });
    if (/^\/api\/remote-libraries\/[^/]+\/browse$/.test(path)) {
      return json({ items: [jelly], total: 1, asOf: "2026-01-01T00:00:00Z", stale: false, capabilities: remoteCapabilities });
    }
    if (/^\/api\/remote-libraries\/[^/]+\/preview$/.test(path)) return json({ posters: [] });
    if (/^\/api\/remote-libraries\/[^/]+\/items\/[^/]+\/sources$/.test(path)) return json({ streams: [] });
    if (/^\/api\/remote-libraries\/[^/]+\/items\/[^/]+\/state$/.test(path)) {
      return json({ key: "k", position: 0, duration: 0, favorite: false, watched: false });
    }
    if (/^\/api\/remote-libraries\/[^/]+\/items\/[^/]+$/.test(path)) return json({ item: jelly, capabilities: remoteCapabilities });
    if (path === "/api/library/browse") return json({ path: "", items: libraryItems, total: libraryItems.length, pending: false });
    if (path === "/api/library/identity") return json({
      path: "Films/Heat.mkv", key: "Films/Heat.mkv", kind: "movie", file: true, label: "Heat.mkv",
      parsed: { title: "Heat", query: "Heat" }, match: "matched", bound: { type: "movie", id: "tt1", name: "Heat" },
    });
    if (path === "/api/library/source" && method === "POST") {
      return json({ sourceId: "exact", kind: "library", playable: true, behaviorHints: { filename: "Heat.mkv" } });
    }
    if (path === "/api/library/suggestions") return json({ items: [], total: 0 });
    if (path === "/api/library/ops") return json({ jobs: [] });
    if (path === "/api/library/links") return json({ links: [] });
    if (path === "/api/library/trailer") return json({ trailer: null });
    if (path === "/api/library/gallery") return json({ images: [] });
    if (path === "/api/library/scan") return json({ status: "idle", total: 0, done: 0, matched: 0, skipped: 0, failed: 0 });
    if (path.endsWith("/extras")) {
      extrasCalls.push(path);
      const id = decodeURIComponent(path.split("/")[4] ?? "");
      return json(extrasFor(id));
    }
    if (path.startsWith("/api/meta/")) {
      if (path.includes("/tt2")) return json(town);
      if (path.includes("/tt9")) return json(show);
      if (path.includes("/tt4")) return json(plain);
      if (path.includes("/tt6")) return json(otherFilm);
      if (path.includes("/tt5000")) return json({ id: "tt5000", type: "movie", name: "Jelly Movie", description: "On the server." });
      return json(heat);
    }
    if (path.startsWith("/api/links/")) return json({ links: [] });
    if (path.startsWith("/api/trailer/")) return json({ trailer: null });
    if (path.startsWith("/api/follows/by-meta/")) return json({ follow: null });
    if (path.startsWith("/api/stream-sources/") || path.startsWith("/api/streams/") || path.startsWith("/api/subtitles/") || path.startsWith("/api/local-streams/")) return json([]);
    if (path === "/api/search" && method === "GET") {
      searchQueries.push(url.searchParams.get("query") ?? "");
      return json({ items: [], cursor: "", hasMore: false, sources: 0 });
    }
    if (path === "/api/search/everywhere" && method === "POST") {
      startBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({ id: "search_one", snapshot: snapshot() });
    }
    if (path === "/api/search/everywhere/search_one/poll") return json({ changed: false, revision: 1 });
    if (path.startsWith("/api/search/everywhere/")) return json({});
    return json({});
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

const until = async (ready: () => boolean) => {
  for (let step = 0; step < 30 && !ready(); step += 1) await flush();
  expect(ready()).toBe(true);
};

const openCatalog = async () => {
  await act(async () => { root.render(<App/>); });
  await until(() => host.querySelector(".poster-card") !== null);
};

const detailTitle = () => host.querySelector(".view-title-detail .library-title-detail h2")?.textContent ?? "";
const catalogueSection = () => host.querySelector("main > section.browse-panel");
const clickNav = async (label: string) => {
  const button = [...host.querySelectorAll<HTMLButtonElement>("nav button")].find((node) => node.getAttribute("aria-label") === label);
  expect(button).toBeTruthy();
  await act(async () => { button!.click(); });
  await flush();
};
const typeInto = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("title detail from the catalogue", () => {
  it("submits the query openSearch is given and ignores a click passed as the argument", async () => {
    await openCatalog();
    await act(async () => { host.querySelector<HTMLButtonElement>(".topbar-search")!.click(); });
    await flush();
    expect(startBodies).toEqual([]);
    expect(host.querySelector("[data-search-input]")).not.toBeNull();
  });

  it("returns to the title a similar title was opened from, then searches a person", async () => {
    await openCatalog();
    await act(async () => { host.querySelector<HTMLButtonElement>(".poster-card")!.click(); });
    await until(() => host.querySelector(".detail-panel .age-badge")?.textContent === "R");
    const description = host.querySelector(".detail-panel .catalog-description")!;
    expect(description.textContent).toContain("A quiet film.");
    expect(description.className).toBe("catalog-description");
    await act(async () => { host.querySelector<HTMLButtonElement>(".detail-info")!.click(); });
    await until(() => host.querySelector(".view-title-detail .person") !== null);
    expect(detailTitle()).toBe("Heat");

    const scroller = host.querySelector(".view-title-detail .browse-scroll")!;
    let top = 0;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (value: number) => { top = Number(value); },
    });
    top = 320;
    await act(async () => { host.querySelector<HTMLButtonElement>(".view-title-detail .related")!.click(); });
    await until(() => detailTitle() === "The Town");
    expect(top).toBe(0);
    expect(catalogueSection()?.querySelector(".title-extras")).toBeNull();
    expect(catalogueSection()?.querySelector("[role='alert']")).toBeNull();

    await act(async () => { host.querySelector<HTMLButtonElement>(".view-title-detail .library-back")!.click(); });
    await until(() => detailTitle() === "Heat");
    expect(top).toBe(320);

    await act(async () => { host.querySelector<HTMLButtonElement>(".view-title-detail .person")!.click(); });
    await until(() => host.querySelector<HTMLInputElement>("[data-search-input]") !== null);
    expect(startBodies.map((body) => body.query)).toEqual(["Ada Lovelace"]);
    expect(host.querySelector<HTMLInputElement>("[data-search-input]")!.value).toBe("Ada Lovelace");
    expect(host.querySelector(".view-title-detail")).toBeNull();
  });

  it("runs the catalogue search when search everywhere is off", async () => {
    searchEverywhere = false;
    await openCatalog();
    expect(host.querySelector(".topbar-search")).toBeNull();
    await act(async () => { host.querySelector<HTMLButtonElement>(".poster-card")!.click(); });
    await until(() => host.querySelector(".detail-panel .age-badge") !== null);
    await act(async () => { host.querySelector<HTMLButtonElement>(".detail-info")!.click(); });
    await until(() => host.querySelector(".view-title-detail .person") !== null);
    await act(async () => { host.querySelector<HTMLButtonElement>(".view-title-detail .person")!.click(); });
    await until(() => host.querySelector(".panel-head h3")?.textContent === "Search: Ada Lovelace");
    expect(host.querySelector<HTMLInputElement>(".searchbar input")!.value).toBe("Ada Lovelace");
    expect(searchQueries).toContain("Ada Lovelace");
    expect(startBodies).toEqual([]);
    expect(host.querySelector(".view-title-detail")).toBeNull();
  });

  it("restores the chosen episode and the scroll of the title a similar title was opened from", async () => {
    catalogItems = [show];
    await openCatalog();
    await act(async () => { host.querySelector<HTMLButtonElement>(".poster-card")!.click(); });
    await until(() => host.querySelectorAll(".detail-panel .episode-list button").length === 2);
    await act(async () => { host.querySelector<HTMLButtonElement>(".detail-info")!.click(); });
    await until(() => host.querySelectorAll(".view-title-detail .catalogue-episodes .episode-list button").length === 2);
    const episodes = [...host.querySelectorAll<HTMLButtonElement>(".view-title-detail .catalogue-episodes .episode-list button")];
    await act(async () => { episodes[1]!.click(); });
    await until(() => host.querySelector(".view-title-detail .episode-current")?.textContent?.includes("Second") ?? false);
    await flush();

    const scroller = host.querySelector(".view-title-detail .browse-scroll")!;
    let top = 0;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (value: number) => { top = Number(value); },
    });
    top = 180;
    await act(async () => { host.querySelector<HTMLButtonElement>(".view-title-detail .related")!.click(); });
    await until(() => detailTitle() === "Plain");
    expect(catalogueSection()?.querySelector(".title-extras")).toBeNull();
    expect(catalogueSection()?.querySelector("[role='alert']")).toBeNull();

    await act(async () => { catalogueSection()!.querySelector<HTMLButtonElement>(".library-back")!.click(); });
    await until(() => detailTitle() === "The Show");
    expect(top).toBe(180);
    expect(host.querySelector(".view-title-detail .episode-current")?.textContent).toContain("Second");
  });

  it("returns from a similar title to the local file it was opened from", async () => {
    libraryItems = [heatFile];
    await openCatalog();
    await clickNav("Library");
    await until(() => host.querySelector("[data-path='Films/Heat.mkv'] .library-open") !== null);
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-path='Films/Heat.mkv'] .library-open")!.click(); });
    await until(() => host.querySelector(".library-local-detail .related") !== null);
    await act(async () => { host.querySelector<HTMLButtonElement>(".library-local-detail .related")!.click(); });
    await until(() => detailTitle() === "The Town");
    expect(host.querySelector(".library-page")?.hasAttribute("hidden")).toBe(true);
    expect(catalogueSection()?.querySelector(".title-extras")).toBeNull();
    expect(catalogueSection()?.querySelector("[role='alert']")).toBeNull();
    await act(async () => { catalogueSection()!.querySelector<HTMLButtonElement>(".library-back")!.click(); });
    await until(() => host.querySelector(".library-local-detail h2")?.textContent === "Heat");
    expect(catalogueSection()).toBeNull();
    expect(host.querySelector(".library-page")?.hasAttribute("hidden")).toBe(false);
  });

  it("returns from a similar title to the remote movie it was opened from", async () => {
    remoteLibraries = [jellyLibrary];
    await openCatalog();
    await clickNav("Library");
    await until(() => host.querySelector(".remote-libraries .library-open") !== null);
    await act(async () => { host.querySelector<HTMLButtonElement>(".remote-libraries .library-open")!.click(); });
    await until(() => host.querySelector("[data-remote-id='mov1'] .library-open") !== null);
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-remote-id='mov1'] .library-open")!.click(); });
    await until(() => host.querySelector(".remote-detail .related") !== null);
    await act(async () => { host.querySelector<HTMLButtonElement>(".remote-detail .related")!.click(); });
    await until(() => detailTitle() === "Other Film");
    expect(host.querySelector(".library-page")?.hasAttribute("hidden")).toBe(true);
    expect(catalogueSection()?.querySelector(".title-extras")).toBeNull();
    await act(async () => { catalogueSection()!.querySelector<HTMLButtonElement>(".library-back")!.click(); });
    await until(() => catalogueSection() === null && host.querySelector(".remote-detail h2")?.textContent === "Jelly Movie");
    expect(host.querySelector(".library-page")?.hasAttribute("hidden")).toBe(false);
  });

  it("asks for extras again after a download lands in a library", async () => {
    downloadMode = "downloading";
    await openCatalog();
    await until(() => host.querySelector("button[aria-label='Downloads'] b")?.textContent === "1");
    await act(async () => { host.querySelector<HTMLButtonElement>(".poster-card")!.click(); });
    await until(() => host.querySelector(".detail-panel .age-badge")?.textContent === "R");
    await act(async () => { host.querySelector<HTMLButtonElement>(".detail-info")!.click(); });
    await until(() => host.querySelector(".view-title-detail .person") !== null);
    const before = extrasCalls.filter((path) => path.includes("/tt1/")).length;
    expect(before).toBeGreaterThan(0);
    downloadMode = "completed";
    await clickNav("Library");
    await until(() => host.querySelector(".toast")?.textContent?.includes("Heat is in the library.") ?? false);
    await clickNav("Catalog");
    await until(() => host.querySelector(".detail-info") !== null);
    await act(async () => { host.querySelector<HTMLButtonElement>(".detail-info")!.click(); });
    await until(() => host.querySelector(".view-title-detail .person") !== null);
    expect(extrasCalls.filter((path) => path.includes("/tt1/")).length).toBe(before + 1);
  });

  it("asks for extras again after the signed-in account changes", async () => {
    await openCatalog();
    await act(async () => { host.querySelector<HTMLButtonElement>(".poster-card")!.click(); });
    await until(() => host.querySelector(".detail-panel .age-badge")?.textContent === "R");
    await act(async () => { host.querySelector<HTMLButtonElement>(".detail-info")!.click(); });
    await until(() => host.querySelector(".view-title-detail .person") !== null);
    const before = extrasCalls.filter((path) => path.includes("/tt1/")).length;
    expect(before).toBeGreaterThan(0);
    downloadMode = "unauthorized";
    await clickNav("Library");
    await until(() => host.querySelector(".login-card") !== null);
    downloadMode = "idle";
    await typeInto(host.querySelector<HTMLInputElement>("input[autocomplete='username']")!, "bob");
    await typeInto(host.querySelector<HTMLInputElement>("input[type='password']")!, "secret");
    await act(async () => { host.querySelector<HTMLFormElement>(".login-card")!.requestSubmit(); });
    await until(() => host.querySelector("header strong")?.textContent === "bob");
    await clickNav("Catalog");
    await until(() => host.querySelector(".detail-info") !== null);
    await act(async () => { host.querySelector<HTMLButtonElement>(".detail-info")!.click(); });
    await until(() => host.querySelector(".view-title-detail .person") !== null);
    expect(extrasCalls.filter((path) => path.includes("/tt1/")).length).toBe(before + 1);
  });
});
