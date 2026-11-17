import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import { setLocale } from "./i18n";
import { clearTitleExtras } from "./title-extras";
import type { Meta, Settings, Stream } from "./types";
import { emptyViews } from "./views";

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
const localRow = (title: string, filename: string): Stream => ({
  sourceId: `local-${title}`, kind: "library", playable: true,
  localPath: `Films/${filename}`, libraryName: "Films", behaviorHints: { filename },
});
const addonRow = (title: string, addon: string): Stream => ({
  sourceId: `${title}-${addon}`, kind: "remote", playable: true,
  name: `${title} ${addon}`, addonKey: addon, addonName: addon[0]!.toUpperCase() + addon.slice(1),
});
const seriesRow = (episode: number, addon: string): Stream => ({
  sourceId: `${addon}-episode-${episode}`, kind: "remote", playable: true,
  name: `${addon === "alpha" ? "Alpha" : "Beta"} episode ${episode}`,
  addonKey: addon, addonName: addon === "alpha" ? "Alpha" : "Beta",
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const keyOf = (url: URL) => `${url.pathname}${url.search}`;
const requestKey = (pathAndQuery: string) => {
  const url = new URL(pathAndQuery, "http://test");
  return keyOf(url);
};

let root: Root;
let host: HTMLDivElement;
let catalogItems: Meta[];
let streamSourcesReply: (url: URL) => Response | Promise<Response>;
let localStreamsReply: (url: URL) => Response | Promise<Response>;
let addonStreamReply: (url: URL) => Response | Promise<Response>;
let streamCalls: URL[];
let addonCalls: URL[];
let playbackStarts: Array<Record<string, unknown>>;
let requestCounts: Map<string, number>;
let gates: Map<string, Promise<void>>;
let gateReleases: Array<() => void>;

const hold = (pathAndQuery: string) => {
  const key = requestKey(pathAndQuery);
  let releaseGate!: () => void;
  let active = true;
  const promise = new Promise<void>((resolve) => { releaseGate = resolve; });
  const release = () => {
    if (!active) return;
    active = false;
    gates.delete(key);
    releaseGate();
  };
  gates.set(key, promise);
  gateReleases.push(release);
  return release;
};
const waitAtGate = async (url: URL) => {
  const gate = gates.get(keyOf(url));
  if (gate) await gate;
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  clearTitleExtras();
  sessionStorage.clear();
  localStorage.clear();
  catalogItems = [heat];
  streamSourcesReply = () => json([{ key: "alpha", name: "Alpha" }]);
  localStreamsReply = () => json([]);
  addonStreamReply = (url) => {
    const segments = url.pathname.split("/");
    const title = decodeURIComponent(segments[4] ?? "title");
    return json([addonRow(title, url.searchParams.get("addon") ?? "alpha")]);
  };
  streamCalls = [];
  addonCalls = [];
  playbackStarts = [];
  requestCounts = new Map();
  gates = new Map();
  gateReleases = [];
  vi.stubGlobal("matchMedia", () => ({
    matches: false, media: "", onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLMediaElement.prototype, "textTracks", {
    configurable: true,
    get: () => ({ length: 0, addEventListener() {}, removeEventListener() {}, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }),
  });
  Object.defineProperty(HTMLTrackElement.prototype, "track", {
    configurable: true,
    get: () => ({ mode: "disabled", activeCues: null, addEventListener() {}, removeEventListener() {} }),
  });
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => undefined;
  HTMLMediaElement.prototype.load = () => undefined;
  Element.prototype.scrollTo = () => undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://test");
    const path = url.pathname;
    const method = init?.method ?? "GET";
    requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);
    if (path === "/api/status") return json({ status: "ok", version: "test", searchEverywhere: true, restricted: false });
    if (path === "/api/auth/me") return json({ username: "alice", role: "admin", language: "en" });
    if (path === "/api/addons") return json([
      { key: "alpha", role: "source", enabled: true, globalSearch: false, manifest: { id: "alpha", name: "Alpha", version: "1.0.0" } },
      { key: "beta", role: "source", enabled: true, globalSearch: false, manifest: { id: "beta", name: "Beta", version: "1.0.0" } },
    ]);
    if (path === "/api/searchable" || path === "/api/languages") return json([]);
    if (path === "/api/catalogs") return json([{ addonKey: "cinemeta", addonName: "Cinemeta", type: "movie", id: "top", name: "Top" }]);
    if (path === "/api/home") return json({ generatedAt: "", order: [], rows: {} });
    if (path === "/api/catalog") return json(catalogItems);
    if (path === "/api/libraries") return json([]);
    if (path === "/api/media-servers") return json({ connections: [], keyConfigured: false });
    if (path === "/api/views") return json(emptyViews());
    if (path === "/api/settings") return json(settings);
    if (path === "/api/downloads") return json({ jobs: [], halt: null, deviceTransfers: [] });
    if (path === "/api/playback" && method === "POST") {
      playbackStarts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({
        id: `play-${playbackStarts.length}`, mode: "direct", url: `/api/stream/play-${playbackStarts.length}`,
        offset: 0, duration: 600, hardware: false, acceleration: false,
        audioTracks: [], subtitleTracks: [], audioTrack: 0, subtitleTrack: null, quality: null,
      });
    }
    if (path === "/api/inspect" && method === "POST") {
      return json({ audioTracks: [], subtitleTracks: [], container: "mkv" });
    }
    if (/^\/api\/playback\/[^/]+$/.test(path) && method === "DELETE") return new Response(null, { status: 204 });
    if (path === "/api/follows") return json({ follows: [] });
    if (path === "/api/follows/new-episodes") return json({ items: [] });
    if (path === "/api/search/state") return json({ saveHistory: false, liveSearch: false, defaultOrder: "source", recent: [] });
    if (path === "/api/search/preferences") return json({ liveSearch: false });
    if (path === "/api/source-profiles") return json({ profiles: [] });
    if (path === "/api/watchlist") return json([]);
    if (path === "/api/progress") return json([]);
    if (path === "/api/remote-libraries") return json({ libraries: [] });
    if (path.startsWith("/api/meta/")) {
      if (path.includes("/tt2")) return json(town);
      if (path.includes("/tt9")) return json(show);
      return json(heat);
    }
    if (path.startsWith("/api/links/")) return json({ links: [] });
    if (path.startsWith("/api/trailer/")) return json({ trailer: null });
    if (path.startsWith("/api/follows/by-meta/")) return json({ follow: null });
    if (path.startsWith("/api/stream-sources/")) {
      await waitAtGate(url);
      return streamSourcesReply(url);
    }
    if (path.startsWith("/api/streams/")) {
      streamCalls.push(url);
      addonCalls.push(url);
      await waitAtGate(url);
      return addonStreamReply(url);
    }
    if (path.startsWith("/api/subtitles/")) return json([]);
    if (path.startsWith("/api/local-streams/")) {
      await waitAtGate(url);
      return localStreamsReply(url);
    }
    if (path.endsWith("/extras")) return json({ people: [], related: [], source: "addon" });
    return json({});
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  for (const release of gateReleases) release();
  await flush();
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

const until = async (ready: () => boolean, message = "condition") => {
  for (let step = 0; step < 40 && !ready(); step += 1) await flush();
  expect(ready(), message).toBe(true);
};

const openCatalog = async () => {
  await act(async () => { root.render(<App/>); });
  await until(() => host.querySelector(".poster-card") !== null, "catalogue cards");
};
const clickCard = async (name: string) => {
  const card = [...host.querySelectorAll<HTMLButtonElement>(".poster-card")]
    .find((node) => node.textContent?.includes(name));
  expect(card, `poster for ${name}`).toBeTruthy();
  await act(async () => { card!.click(); });
};
const sourceRows = () => [...host.querySelectorAll<HTMLButtonElement>(".detail-panel .stream-list button")];
const sourceText = () => sourceRows().map((row) => row.textContent ?? "").join("\n");
const titlePlay = () => host.querySelector<HTMLButtonElement>(".detail-panel .actions button.primary");
const playEpisode = async (episode: number) => {
  await clickCard("The Show");
  await until(() => host.querySelectorAll(".detail-panel .episode-list button").length === 2, "show episodes");
  await act(async () => {
    host.querySelectorAll<HTMLButtonElement>(".detail-panel .episode-list button")[episode - 1]!.click();
  });
  await until(() => titlePlay() !== null && !titlePlay()!.disabled, `episode ${episode} play button`);
  await act(async () => { titlePlay()!.click(); });
  await until(() => playbackStarts.length === 1, `episode ${episode} playback`);
  await until(() => host.querySelector(".next-episode") !== null, "next-episode control");
};

describe("selected title sources", () => {
  it("keeps local copies when an addon lookup fails", async () => {
    streamSourcesReply = () => json({ error: "unavailable" }, 500);
    localStreamsReply = (url) => json(url.pathname.endsWith("/tt1")
      ? [localRow("Heat", "Heat.Local.mkv")]
      : []);

    await openCatalog();
    await clickCard("Heat");
    await until(() => sourceText().includes("Heat.Local.mkv"), "Heat local row");
    expect(sourceRows().map((row) => row.textContent ?? "")).toEqual([
      expect.stringContaining("Heat.Local.mkv"),
    ]);
  });

  it("drops a late local answer for the previously selected title", async () => {
    catalogItems = [heat, town];
    localStreamsReply = (url) => json(url.pathname.endsWith("/tt1")
      ? [localRow("Heat", "Heat.Local.mkv")]
      : []);
    const releaseLocal = hold("/api/local-streams/movie/tt1");

    await openCatalog();
    await clickCard("Heat");
    await until(() => (requestCounts.get("/api/local-streams/movie/tt1") ?? 0) === 1, "held Heat local lookup");
    await clickCard("The Town");
    await until(() => sourceText().includes("tt2 alpha"), "The Town addon row");
    releaseLocal();
    await flush();

    expect(sourceText()).not.toContain("Heat.Local.mkv");
  });

  it("drops a late addon row for the previously selected title", async () => {
    catalogItems = [heat, town];
    const releaseHeatAddon = hold("/api/streams/movie/tt1?addon=alpha");

    await openCatalog();
    await clickCard("Heat");
    await until(() => (requestCounts.get("/api/streams/movie/tt1") ?? 0) === 1, "held Heat addon lookup");
    await clickCard("The Town");
    await until(() => sourceText().includes("tt2 alpha"), "The Town addon row");
    releaseHeatAddon();
    await flush();

    expect(sourceText()).toContain("tt2 alpha");
    expect(sourceText()).not.toContain("tt1 alpha");
  });

  it("shows addon rows as each addon answers", async () => {
    streamSourcesReply = () => json([{ key: "alpha", name: "Alpha" }, { key: "beta", name: "Beta" }]);
    const releaseBeta = hold("/api/streams/movie/tt1?addon=beta");

    await openCatalog();
    await clickCard("Heat");
    await until(() => sourceText().includes("tt1 alpha"), "Alpha row while Beta is held");
    expect(sourceText()).not.toContain("tt1 beta");

    releaseBeta();
    await until(() => sourceText().includes("tt1 beta"), "Beta row after release");
    expect(sourceText()).toContain("tt1 alpha");
    expect(sourceText()).toContain("tt1 beta");
  });

  it("leaves no loading state or rows behind when the detail closes", async () => {
    catalogItems = [heat, town];
    const releaseHeatAddon = hold("/api/streams/movie/tt1?addon=alpha");

    await openCatalog();
    await clickCard("Heat");
    await until(() => (requestCounts.get("/api/streams/movie/tt1") ?? 0) === 1, "held Heat addon lookup");
    const close = host.querySelector<HTMLButtonElement>(".detail-panel .mobile-detail-head > button");
    expect(close, "detail close control").toBeTruthy();
    await act(async () => { close!.click(); });
    await until(() => host.querySelector(".detail-panel .mobile-detail-head") === null, "closed detail");
    releaseHeatAddon();
    await clickCard("The Town");
    await until(() => sourceText().includes("tt2 alpha"), "The Town addon row");

    const grid = host.querySelector(".poster-grid");
    expect(grid?.classList.contains("stale")).toBe(false);
    expect(grid?.getAttribute("aria-busy")).toBeNull();
    expect(sourceText()).not.toContain("tt1 alpha");
  });

  it("keeps a source failure that answers after the detail closed off the screen", async () => {
    const releaseHeatSources = hold("/api/stream-sources/movie/tt1");
    streamSourcesReply = () => json({ error: "addons down" }, 500);

    await openCatalog();
    await clickCard("Heat");
    await until(() => (requestCounts.get("/api/stream-sources/movie/tt1") ?? 0) === 1, "held Heat source lookup");
    const close = host.querySelector<HTMLButtonElement>(".detail-panel .mobile-detail-head > button");
    expect(close, "detail close control").toBeTruthy();
    await act(async () => { close!.click(); });
    await until(() => host.querySelector(".detail-panel .mobile-detail-head") === null, "closed detail");
    releaseHeatSources();
    await flush();
    await flush();

    expect(host.querySelector(".toast.error")).toBeNull();
  });

  it("uses the prefetched sources when moving to the next episode", async () => {
    catalogItems = [show];
    addonStreamReply = (url) => {
      const id = decodeURIComponent(url.pathname.slice("/api/streams/series/".length));
      return json([seriesRow(id.endsWith(":2") ? 2 : 1, url.searchParams.get("addon") ?? "alpha")]);
    };

    await openCatalog();
    await playEpisode(1);
    expect(playbackStarts[0]).toEqual(expect.objectContaining({ sourceId: "alpha-episode-1" }));
    await until(
      () => (requestCounts.get("/api/stream-sources/series/tt9%3A1%3A2") ?? 0) === 1,
      "episode 2 prefetch",
    );

    await act(async () => { host.querySelector<HTMLButtonElement>(".next-episode")!.click(); });
    await until(() => playbackStarts.length === 2, "episode 2 playback");
    expect(playbackStarts[1]).toEqual(expect.objectContaining({ sourceId: "alpha-episode-2" }));
    expect(requestCounts.get("/api/stream-sources/series/tt9%3A1%3A2")).toBe(1);
  });

  it("keeps the next episode on the addon that was playing", async () => {
    catalogItems = [show];
    streamSourcesReply = (url) => {
      const id = decodeURIComponent(url.pathname.slice("/api/stream-sources/series/".length));
      return json(id.endsWith(":2")
        ? [{ key: "alpha", name: "Alpha" }, { key: "beta", name: "Beta" }]
        : [{ key: "alpha", name: "Alpha" }]);
    };
    addonStreamReply = (url) => {
      const id = decodeURIComponent(url.pathname.slice("/api/streams/series/".length));
      const episode = id.endsWith(":2") ? 2 : 1;
      const addon = url.searchParams.get("addon") ?? "alpha";
      if (episode === 2 && addon === "alpha") {
        const previous = addonCalls.filter((call) => call.pathname.endsWith("tt9%3A1%3A2")
          && call.searchParams.get("addon") === "alpha").length - 1;
        return json(previous === 0 ? [] : [seriesRow(2, "alpha")]);
      }
      return json([seriesRow(episode, addon)]);
    };

    await openCatalog();
    await playEpisode(1);
    expect(playbackStarts[0]).toEqual(expect.objectContaining({ sourceId: "alpha-episode-1" }));
    await until(
      () => addonCalls.some((url) => url.pathname.endsWith("tt9%3A1%3A2") && url.searchParams.get("addon") === "alpha"),
      "episode 2 first addon listing",
    );

    await act(async () => { host.querySelector<HTMLButtonElement>(".next-episode")!.click(); });
    await until(() => playbackStarts.length === 2, "episode 2 playback");
    const alphaEpisodeTwo = addonCalls.filter((url) => url.pathname.endsWith("tt9%3A1%3A2")
      && url.searchParams.get("addon") === "alpha");
    expect(alphaEpisodeTwo).toHaveLength(2);
    expect(playbackStarts[1]).toEqual(expect.objectContaining({ sourceId: "alpha-episode-2" }));
  });
});
