import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import { setLocale } from "./i18n";
import type { Settings, Stream } from "./types";
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
const source = (path: string): Stream => ({
  sourceId: path.endsWith("Second.mkv") ? "source_second"
    : path.endsWith("B.mkv") ? "source_b"
      : path.endsWith("A.mkv") ? "source_a"
      : path.endsWith("Loose.mkv") ? "source_loose" : "source_first",
  kind: "library",
  playable: true,
  localPath: path,
  behaviorHints: { filename: path.split("/").pop() },
});
const playbackSession = {
  id: "playback_one", mode: "direct", url: "/api/media/playback_one", offset: 0, duration: 3600,
  hardware: false, acceleration: false, audioTracks: [], subtitleTracks: [], audioTrack: 0,
  subtitleTrack: null, quality: null,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let root: Root;
let host: HTMLDivElement;
let sourceBodies: Array<{ path: string }>;
let playbackBodies: Array<Record<string, unknown>>;
let progressBodies: Array<Record<string, unknown>>;
let shuffleDeletes: string[];
let shuffleStarts: Array<{ path: string }>;
let shuffleStartItem: { path?: string; title: string; season?: number };
let shuffleNextItems: Array<{ path?: string; title: string; season?: number }>;
let identities: Record<string, { type: "movie" | "series"; id: string }>;
let favoriteCalls: Array<{ path: string; favorite: boolean }>;
let subtitleCalls: URL[];
let rootBrowseItems: Array<Record<string, unknown>>;
let filmsBrowseItems: Array<Record<string, unknown>>;
let nextFileBySource: Record<string, { path: string; title: string } | null>;
let nextFileCalls: string[];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  sessionStorage.clear();
  localStorage.clear();
  sourceBodies = [];
  playbackBodies = [];
  progressBodies = [];
  shuffleDeletes = [];
  shuffleStarts = [];
  shuffleStartItem = { path: "Films/First.mkv", title: "First" };
  shuffleNextItems = [{ path: "Films/Second.mkv", title: "Second" }];
  identities = {};
  favoriteCalls = [];
  subtitleCalls = [];
  rootBrowseItems = [
    { kind: "folder", path: "Films", name: "Films", fileCount: 2, size: 2, match: "unmatched" },
    {
      kind: "file", path: "Loose.mkv", label: "Loose.mkv", season: null, episode: null,
      size: 1, modified: "2026-01-01T00:00:00.000Z", match: "unmatched", favorite: false,
    },
  ];
  filmsBrowseItems = [rootBrowseItems[1]!];
  nextFileBySource = {};
  nextFileCalls = [];
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
  Element.prototype.scrollTo = () => undefined;
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => undefined;
  HTMLMediaElement.prototype.load = () => undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://test");
    const path = url.pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/status") return json({ status: "ok", version: "test", searchEverywhere: false });
    if (path === "/api/auth/me") return json({ username: "alice", role: "user", language: "en" });
    if (path === "/api/addons" || path === "/api/catalogs" || path === "/api/searchable" || path === "/api/languages") return json([]);
    if (path === "/api/libraries") return json([library]);
    if (path === "/api/views") return json(emptyViews());
    if (path === "/api/settings") return json(settings);
    if (path === "/api/downloads") return json({ jobs: [], halt: null, deviceTransfers: [] });
    if (path === "/api/follows") return json({ follows: [] });
    if (path === "/api/follows/new-episodes") return json({ items: [] });
    if (path === "/api/search/state") return json({ saveHistory: false, liveSearch: false, defaultOrder: "source", recent: [] });
    if (path === "/api/search/preferences") return json({ liveSearch: false });
    if (path === "/api/source-profiles") return json({ profiles: [] });
    if (path === "/api/remote-libraries") return json({ libraries: [] });
    if (path === "/api/library/scan") return json({ status: "idle", total: 0, done: 0, matched: 0, skipped: 0, failed: 0 });
    if (path === "/api/library/suggestions") return json({ items: [], total: 0 });
    if (path === "/api/library/ops") return json({ jobs: [] });
    if (path === "/api/library/browse") {
      const browsePath = url.searchParams.get("path") ?? "";
      const items = browsePath === "Films" ? filmsBrowseItems : rootBrowseItems;
      return json({ path: browsePath, items, total: items.length, pending: false });
    }
    if (path === "/api/shuffle" && method === "POST") {
      shuffleStarts.push(JSON.parse(String(init?.body)) as { path: string });
      return json({
        id: "shuffle_one",
        item: shuffleStartItem,
        total: 2,
        hasNext: true,
        hasPrevious: false,
        upcoming: { title: "Second" },
      });
    }
    if (path === "/api/shuffle/shuffle_one/next" && method === "POST") {
      return json({
        item: shuffleNextItems.shift() ?? { path: "Films/Second.mkv", title: "Second" },
        hasNext: false,
        hasPrevious: true,
      });
    }
    if (path === "/api/shuffle/shuffle_one" && method === "DELETE") {
      shuffleDeletes.push(path);
      return new Response(null, { status: 204 });
    }
    if (path === "/api/library/source" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { path: string };
      sourceBodies.push(body);
      return json(source(body.path));
    }
    if (path.startsWith("/api/library/next/")) {
      const sourceId = decodeURIComponent(path.slice("/api/library/next/".length));
      nextFileCalls.push(sourceId);
      return json(nextFileBySource[sourceId] ?? null);
    }
    if (path === "/api/library/identity") {
      const wanted = url.searchParams.get("path") ?? "";
      const identity = identities[wanted];
      return json(identity
        ? { path: wanted, key: wanted, kind: identity.type, id: identity.id, file: true, label: wanted.split("/").pop(), parsed: { title: wanted, query: wanted }, match: "matched", bound: identity }
        : { path: wanted, key: wanted, kind: "movie", file: true, label: wanted.split("/").pop(), parsed: { title: wanted, query: wanted }, match: "unmatched" });
    }
    if (path === "/api/library/favorite" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { path: string; favorite: boolean };
      favoriteCalls.push(body);
      return json(body);
    }
    if (path.startsWith("/api/progress")) {
      if (method === "POST") progressBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (method === "POST" || method === "DELETE") return new Response(null, { status: 204 });
      return json(null);
    }
    if (path === "/api/playback" && method === "POST") {
      playbackBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json(playbackSession);
    }
    if (path.startsWith("/api/playback/")) return method === "DELETE" ? new Response(null, { status: 204 }) : json({});
    if (path.startsWith("/api/subtitles/")) {
      subtitleCalls.push(url);
      return json([{ id: "subtitle-bound", lang: "en", url: "/subtitle-bound.vtt" }]);
    }
    if (path.startsWith("/api/stream-sources/")) {
      if (path.includes("tt1")) return json([{ key: "alpha", name: "Alpha" }]);
      if (path.includes("tt2")) return json([{ key: "beta", name: "Beta" }]);
      return json([]);
    }
    if (path.startsWith("/api/streams/")) {
      if (path.includes("tt1")) return json([{
        sourceId: "bound-addon", kind: "remote", playable: true, name: "Bound addon",
        addonKey: "alpha", addonName: "Alpha",
      }]);
      if (path.includes("tt2")) return json([{
        sourceId: "next-addon", kind: "remote", playable: true, name: "Next addon",
        addonKey: "beta", addonName: "Beta",
      }]);
      return json([]);
    }
    if (path.startsWith("/api/local-streams/")) return json([]);
    if (path.startsWith("/api/meta/") || path.startsWith("/api/links/") || path.startsWith("/api/trailer/")) return json({});
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

const until = async (ready: () => boolean) => {
  for (let step = 0; step < 30 && !ready(); step += 1) await flush();
  expect(ready()).toBe(true);
};

const openLibrary = async () => {
  await act(async () => { root.render(<App/>); });
  await flush();
  const libraryButton = [...host.querySelectorAll<HTMLButtonElement>("nav button")]
    .find((button) => button.getAttribute("aria-label") === "Library");
  expect(libraryButton).toBeTruthy();
  await act(async () => { libraryButton!.click(); });
  await until(() => host.querySelector("[data-path='Films'] .browse-menu") !== null);
};

const startRandom = async () => {
  const menu = host.querySelector<HTMLButtonElement>("[data-path='Films'] .browse-menu")!;
  await act(async () => { menu.click(); });
  const play = [...host.querySelectorAll<HTMLButtonElement>(".browse-actions button")]
    .find((button) => button.textContent?.trim() === "Play random");
  expect(play).toBeTruthy();
  await act(async () => { play!.click(); });
  await until(() => sourceBodies.some((body) => body.path === "Films/First.mkv"));
};

describe("Play random", () => {
  it("starts from the folder menu and wires the next title through the player", async () => {
    await openLibrary();
    await startRandom();
    const next = await (async () => {
      await until(() => host.querySelector<HTMLButtonElement>(".next-episode")?.title === "Next episode: Second");
      return host.querySelector<HTMLButtonElement>(".next-episode")!;
    })();
    expect(next.title).toBe("Next episode: Second");

    await act(async () => { next.click(); });
    await until(() => sourceBodies.some((body) => body.path === "Films/Second.mkv"));
    await until(() => playbackBodies.some((body) => body.sourceId === "source_second"));
    expect(playbackBodies.find((body) => body.sourceId === "source_second")).toEqual(expect.objectContaining({ time: 0 }));
  });

  it("starts the folder on screen from the toolbar beside the sort controls", async () => {
    await openLibrary();
    const button = host.querySelector<HTMLButtonElement>(".browse-tools button[aria-label='Play random']");
    expect(button).toBeTruthy();
    expect(host.querySelector("#library-maintenance-actions")?.textContent).not.toContain("Play random");
    await act(async () => { button!.click(); });
    await until(() => sourceBodies.some((body) => body.path === "Films/First.mkv"));
    expect(shuffleStarts).toHaveLength(1);
    expect(shuffleStarts[0]!.path).not.toBe("Films");
  });

  it("ends and deletes the run when a normal file is opened", async () => {
    await openLibrary();
    await startRandom();

    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-path='Loose.mkv'] .library-open")!.click();
    });
    await until(() => host.querySelector<HTMLButtonElement>(".library-local-detail button.primary") !== null);
    await act(async () => { host.querySelector<HTMLButtonElement>(".library-local-detail button.primary")!.click(); });
    await until(() => shuffleDeletes.length > 0);
    expect(shuffleDeletes).toEqual(["/api/shuffle/shuffle_one"]);
  });

  it("keeps shuffle on every progress write while advancing from the outgoing item", async () => {
    await openLibrary();
    await startRandom();
    const video = await (async () => {
      await until(() => host.querySelector<HTMLVideoElement>(".player-overlay video") !== null);
      return host.querySelector<HTMLVideoElement>(".player-overlay video")!;
    })();
    Object.defineProperty(video, "duration", { configurable: true, value: 100 });
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 99 });
    await act(async () => {
      video.dispatchEvent(new Event("durationchange"));
      video.dispatchEvent(new Event("timeupdate"));
    });
    await flush();

    const next = await (async () => {
      await until(() => host.querySelector<HTMLButtonElement>(".next-episode") !== null);
      return host.querySelector<HTMLButtonElement>(".next-episode")!;
    })();
    await act(async () => { next.click(); });
    await until(() => sourceBodies.some((body) => body.path === "Films/Second.mkv"));
    await until(() => progressBodies.some((body) => body.path === "Films/First.mkv" && body.final === true));

    const outgoing = progressBodies.filter((body) => body.path === "Films/First.mkv");
    expect(outgoing.length).toBeGreaterThan(0);
    expect(outgoing.every((body) => body.shuffle === true)).toBe(true);
  });

  it("uses the shuffled file's own title groups and actions after a bound file and an unbound file", async () => {
    identities["Films/Bound.mkv"] = { type: "movie", id: "tt1" };
    shuffleStartItem = { path: "Films/Bound.mkv", title: "Bound" };
    shuffleNextItems = [{ path: "Films/Loose.mkv", title: "Loose" }];
    await openLibrary();

    const menu = host.querySelector<HTMLButtonElement>("[data-path='Films'] .browse-menu")!;
    await act(async () => { menu.click(); });
    const random = [...host.querySelectorAll<HTMLButtonElement>(".browse-actions button")]
      .find((button) => button.textContent?.trim() === "Play random")!;
    await act(async () => { random.click(); });
    await until(() => playbackBodies.some((body) => body.sourceId === "source_first"));
    expect(playbackBodies.find((body) => body.sourceId === "source_first")).toEqual(expect.objectContaining({ time: 0 }));
    await until(() => subtitleCalls.some((url) => url.pathname === "/api/subtitles/movie/tt1"));

    const openSources = async () => {
      await act(async () => { host.querySelector<HTMLButtonElement>(".player-sources-toggle")!.click(); });
      await flush();
      await flush();
    };
    const sourceRows = () => [...host.querySelectorAll<HTMLElement>("#player-sources .player-source-list button")]
      .map((row) => row.textContent ?? "");
    const openSettings = async () => {
      if (!host.querySelector("#player-settings")) {
        await act(async () => { host.querySelector<HTMLButtonElement>(".player-settings-toggle")!.click(); });
      }
    };
    await openSources();
    expect(sourceRows().some((row) => row.includes("Bound addon"))).toBe(true);

    await act(async () => { host.querySelector<HTMLButtonElement>(".player-star")!.click(); });
    await until(() => favoriteCalls.length === 1);
    expect(favoriteCalls[0]).toEqual({ path: "Films/Bound.mkv", favorite: true });

    await openSettings();
    const device = [...host.querySelectorAll<HTMLButtonElement>(".player-action")]
      .find((button) => button.textContent?.includes("To device"))!;
    await act(async () => { device.click(); });
    await flush();
    expect(sourceBodies.at(-1)).toEqual({ path: "Films/Bound.mkv" });
    expect(playbackBodies.length).toBe(1);

    await act(async () => { host.querySelector<HTMLButtonElement>(".next-episode")!.click(); });
    await until(() => playbackBodies.some((body) => body.sourceId === "source_loose"));
    expect(playbackBodies.find((body) => body.sourceId === "source_loose")).toEqual(expect.objectContaining({ time: 0 }));
    const subtitlesBeforeUnbound = subtitleCalls.length;
    await openSources();
    expect(sourceRows().some((row) => row.includes("Loose.mkv"))).toBe(true);
    expect(sourceRows().some((row) => row.includes("Bound addon"))).toBe(false);
    expect(subtitleCalls).toHaveLength(subtitlesBeforeUnbound);

    await act(async () => { host.querySelector<HTMLButtonElement>(".player-star")!.click(); });
    await until(() => favoriteCalls.length === 2);
    expect(favoriteCalls[1]).toEqual({ path: "Films/Loose.mkv", favorite: true });

    await openSettings();
    const looseDevice = [...host.querySelectorAll<HTMLButtonElement>(".player-action")]
      .find((button) => button.textContent?.includes("To device"))!;
    await act(async () => { looseDevice.click(); });
    await flush();
    expect(sourceBodies.at(-1)).toEqual({ path: "Films/Loose.mkv" });
  });

  it("moves every player action and source group to the next library file", async () => {
    const fileItem = (path: string, label: string) => ({
      kind: "file", path, label, season: 1, episode: path.endsWith("A.mkv") ? 1 : 2,
      size: 1, modified: "2026-01-01T00:00:00.000Z", match: "matched", favorite: true,
    });
    filmsBrowseItems = [fileItem("Films/A.mkv", "A"), fileItem("Films/B.mkv", "B")];
    identities["Films/A.mkv"] = { type: "movie", id: "tt1" };
    identities["Films/B.mkv"] = { type: "movie", id: "tt2" };
    nextFileBySource = { source_a: { path: "Films/B.mkv", title: "B" } };

    await openLibrary();
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-path='Films'] .library-open")!.click();
    });
    await until(() => host.querySelector("[data-path='Films/A.mkv'] .library-open") !== null);
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-path='Films/A.mkv'] .library-open")!.click();
    });
    await until(() => host.querySelector(".library-local-detail button.primary") !== null);
    await act(async () => { host.querySelector<HTMLButtonElement>(".library-local-detail button.primary")!.click(); });
    await until(() => playbackBodies.some((body) => body.sourceId === "source_a"));
    await until(() => subtitleCalls.some((url) => url.pathname === "/api/subtitles/movie/tt1"));

    const openSources = async () => {
      await act(async () => { host.querySelector<HTMLButtonElement>(".player-sources-toggle")!.click(); });
      await flush();
      await flush();
    };
    const openSettings = async () => {
      if (!host.querySelector("#player-settings")) {
        await act(async () => { host.querySelector<HTMLButtonElement>(".player-settings-toggle")!.click(); });
      }
    };
    const sourceRows = () => [...host.querySelectorAll<HTMLElement>("#player-sources .player-source-list button")]
      .map((row) => row.textContent ?? "");

    await openSources();
    expect(sourceRows().some((row) => row.includes("Bound addon"))).toBe(true);
    await act(async () => { host.querySelector<HTMLButtonElement>(".player-star")!.click(); });
    await until(() => favoriteCalls.length === 1);
    expect(favoriteCalls[0]).toEqual({ path: "Films/A.mkv", favorite: false });

    await openSettings();
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>(".player-action")]
        .find((button) => button.textContent?.includes("To device"))!.click();
    });
    await flush();
    expect(sourceBodies.at(-1)).toEqual({ path: "Films/A.mkv" });

    await act(async () => { host.querySelector<HTMLButtonElement>(".next-episode")!.click(); });
    await until(() => playbackBodies.some((body) => body.sourceId === "source_b"));
    await until(() => subtitleCalls.some((url) => url.pathname === "/api/subtitles/movie/tt2"));
    await openSources();
    expect(sourceRows().some((row) => row.includes("Next addon"))).toBe(true);
    expect(sourceRows().some((row) => row.includes("Bound addon"))).toBe(false);

    await act(async () => { host.querySelector<HTMLButtonElement>(".player-star")!.click(); });
    await until(() => favoriteCalls.length === 2);
    expect(favoriteCalls[1]).toEqual({ path: "Films/B.mkv", favorite: false });

    await openSettings();
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>(".player-action")]
        .find((button) => button.textContent?.includes("To device"))!.click();
    });
    await flush();
    expect(sourceBodies.at(-1)).toEqual({ path: "Films/B.mkv" });

    const video = host.querySelector<HTMLVideoElement>(".player-overlay video")!;
    await act(async () => {
      Object.defineProperty(video, "duration", { configurable: true, value: 100 });
      Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 20 });
      video.dispatchEvent(new Event("timeupdate", { bubbles: true }));
    });
    await act(async () => { host.querySelector<HTMLButtonElement>(".player-head button.icon-button")!.click(); });
    await until(() => progressBodies.some((body) => body.path === "Films/B.mkv" && body.final === true));
    expect(progressBodies.filter((body) => body.path === "Films/B.mkv" && body.final === true)[0]!.key)
      .toBe("file:Films/B.mkv");
  });
});
