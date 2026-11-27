import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setLocale } from "./i18n";
import { en } from "./i18n/en";
import type { Catalog, Meta, Settings } from "./types";
import { emptyViews } from "./views";

const crash = vi.hoisted(() => ({ home: false, filters: false }));

vi.mock("./Home", () => ({
  Home: () => {
    if (crash.home) throw new Error("home crashed");
    return null;
  },
}));

vi.mock("./CatalogFilters", async () => {
  const actual = await vi.importActual<typeof import("./CatalogFilters")>("./CatalogFilters");
  return {
    ...actual,
    CatalogFilters: (props: Parameters<typeof actual.CatalogFilters>[0]) => {
      if (crash.filters) throw new Error("catalogue filters crashed");
      return actual.CatalogFilters(props);
    },
  };
});

vi.mock("./CatalogueTitleDetail", async () => {
  const actual = await vi.importActual<typeof import("./CatalogueTitleDetail")>("./CatalogueTitleDetail");
  return {
    ...actual,
    CatalogueTitleDetail: () => {
      throw new Error("detail crashed");
    },
  };
});

import { App } from "./App";

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

const catalogs: Catalog[] = [{
  addonKey: "alpha", addonName: "Alpha", type: "movie", id: "top", name: "Top",
  extra: [{ name: "genre", options: ["Action"] }],
}];
const film: Meta = { id: "tt1", type: "movie", name: "Heat" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let root: Root;
let host: HTMLDivElement;
let consoleError: ReturnType<typeof vi.spyOn>;
let statusBody: Record<string, unknown>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  sessionStorage.clear();
  localStorage.clear();
  crash.home = false;
  crash.filters = false;
  settings.startView = "catalog";
  statusBody = { status: "ok", version: "test", searchEverywhere: false };
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal("matchMedia", () => ({
    matches: false, media: "", onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollTo = () => undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://test");
    if (url.pathname === "/api/status") return json(statusBody);
    if (url.pathname === "/api/auth/me") return json({ username: "alice", role: "admin", language: "en", canSwitch: true });
    if (url.pathname === "/api/profiles") return json({ profiles: [{ id: "alice", username: "alice", unlock: "none", current: true }] });
    if (url.pathname === "/api/addons") return json([]);
    if (url.pathname === "/api/catalogs") return json(catalogs);
    if (url.pathname === "/api/searchable") return json([]);
    if (url.pathname === "/api/catalog") return json([film]);
    if (url.pathname === "/api/search/state") return json({ saveHistory: false, liveSearch: false, defaultOrder: "source", recent: [] });
    if (url.pathname === "/api/search/preferences") return json({ liveSearch: false });
    if (url.pathname === "/api/settings") return json(settings);
    if (url.pathname === "/api/libraries") return json([]);
    if (url.pathname === "/api/views") return json(emptyViews());
    if (url.pathname === "/api/languages") return json([]);
    if (url.pathname === "/api/downloads") return json({ jobs: [], halt: null, deviceTransfers: [] });
    if (url.pathname === "/api/follows") return json({ follows: [] });
    if (url.pathname === "/api/new-episodes") return json({ items: [] });
    if (url.pathname === "/api/source-profiles") return json({ profiles: [] });
    if (url.pathname === "/api/remote-libraries") return json({ libraries: [] });
    if (url.pathname === "/api/home") return json({ generatedAt: "", order: [], rows: {} });
    if (url.pathname === "/api/library/browse") return json({ path: "", items: [], total: 0, pending: false });
    if (url.pathname === "/api/library/scan") return json({ status: "idle", total: 0, done: 0, matched: 0, skipped: 0, failed: 0 });
    if (url.pathname === "/api/library/suggestions") return json({ items: [], total: 0 });
    if (url.pathname === "/api/library/ops") return json({ jobs: [] });
    if (url.pathname === "/api/progress") return json([]);
    if (url.pathname === "/api/watchlist") return json([]);
    if (url.pathname === "/api/avatar/presets") return json({ presets: [] });
    if (url.pathname.startsWith("/api/meta/")) return json(film);
    if (url.pathname.startsWith("/api/streams/") || url.pathname.startsWith("/api/stream-sources/") || url.pathname.startsWith("/api/subtitles/")) return json([]);
    return json({}, 404);
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  consoleError.mockRestore();
  vi.unstubAllGlobals();
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((done) => setTimeout(done, 0));
  });
};

const until = async (ready: () => boolean, label: string) => {
  for (let step = 0; step < 80 && !ready(); step += 1) await flush();
  expect(ready(), label).toBe(true);
};

const navButton = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("nav button")].find((button) => button.getAttribute("aria-label") === label);

describe("view boundaries in App", () => {
  it("keeps the sidebar when Home crashes and clears the message on another view", async () => {
    crash.home = true;
    settings.startView = "home";
    await act(async () => { root.render(<App/>); });
    await until(() => host.querySelector("main [role=alert]") !== null, "home alert");

    expect(host.querySelector("main [role=alert]")?.textContent).toContain(en["viewError.message"]);
    expect(navButton(en["nav.library"])).toBeTruthy();
    expect(host.querySelector("aside.sidebar")).not.toBeNull();

    await act(async () => { navButton(en["nav.library"])!.click(); });
    await until(() => host.querySelector("[role=alert]") === null, "alert cleared by the library view");
    expect(host.querySelector("aside.sidebar")).not.toBeNull();
  });

  // The catalogue is written inline in App, so its elements are built while App renders; the
  // boundary has to build them itself to catch an error thrown there.
  it("keeps the sidebar when an expression inside the inline catalogue throws", async () => {
    crash.filters = true;
    await act(async () => { root.render(<App/>); });
    await until(() => host.querySelector("main [role=alert]") !== null, "catalogue alert");

    expect(host.querySelector("main [role=alert]")?.textContent).toContain(en["viewError.message"]);
    expect(host.querySelector("aside.sidebar")).not.toBeNull();
  });

  it("keeps the detail back button when the title detail crashes", async () => {
    await act(async () => { root.render(<App/>); });
    await until(() => host.querySelector(".poster-card") !== null, "catalogue card");
    await act(async () => { host.querySelector<HTMLButtonElement>(".poster-card")!.click(); });
    await until(() => host.querySelector("button.detail-info") !== null, "open detail");
    await act(async () => { host.querySelector<HTMLButtonElement>("button.detail-info")!.click(); });
    await until(() => host.querySelector("section.browse-panel [role=alert]") !== null, "detail alert");

    const panel = host.querySelector("section.browse-panel");
    expect(panel?.querySelector("[role=alert]")?.textContent).toContain(en["viewError.message"]);
    expect(panel?.querySelector("button.library-back")?.getAttribute("aria-label")).toBe(en["mediaServer.back"]);
    expect(panel?.querySelector(".browse-scroll [role=alert]")).not.toBeNull();
  });
});

describe("header internet chip", () => {
  afterEach(() => { vi.useRealTimers(); });

  const waitForChip = async () => {
    for (let step = 0; step < 80; step += 1) {
      if (host.querySelector(".topbar .online")) return;
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
        else await new Promise((done) => setTimeout(done, 0));
      });
    }
    expect(host.querySelector(".topbar .online"), "header chip").not.toBeNull();
  };

  it("shows No internet when status reports offline", async () => {
    statusBody = { status: "ok", version: "test", searchEverywhere: false, internet: "offline" };
    await act(async () => { root.render(<App/>); });
    await waitForChip();
    const chip = host.querySelector(".topbar .online")!;
    expect(chip.classList.contains("offline")).toBe(true);
    expect(chip.textContent).toContain(en["app.serverNoInternet"]);
    expect(chip.getAttribute("title")).toBe(en["app.serverNoInternetHint"]);
    expect(chip.getAttribute("role")).toBe("status");
  });

  it("returns to Server online after a later poll", async () => {
    vi.useFakeTimers();
    statusBody = { status: "ok", version: "test", searchEverywhere: false, internet: "offline" };
    await act(async () => { root.render(<App/>); });
    await waitForChip();
    expect(host.querySelector(".topbar .online")!.textContent).toContain(en["app.serverNoInternet"]);
    statusBody = { status: "ok", version: "test", searchEverywhere: false, internet: "online" };
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(host.querySelector(".topbar .online")!.textContent).toContain(en["app.serverOnline"]);
    expect(host.querySelector(".topbar .online")!.classList.contains("offline")).toBe(false);
  });

  it("treats a missing internet field as online", async () => {
    await act(async () => { root.render(<App/>); });
    await waitForChip();
    const chip = host.querySelector(".topbar .online")!;
    expect(chip.classList.contains("offline")).toBe(false);
    expect(chip.textContent).toContain(en["app.serverOnline"]);
  });
});
