import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RemoteLibraryBrowser } from "./RemoteLibraryBrowser";
import { clearRemoteMosaicCache } from "./remote-mosaic";
import { setLocale } from "./i18n";
import { clearTitleEnrichment } from "./title-enrichment";
import { emptyViews } from "./views";
import type { Addon, LibraryView, RemoteCapabilities, RemoteItem, RemoteItemPage, RemoteLibrary, Stream } from "./types";

const capabilities: RemoteCapabilities = { rename: false, move: false, delete: false, identify: false, writeArtwork: false, downloadToLibrary: false, downloadToDevice: false };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const folder = (id: string, name: string, parentId?: string): RemoteItem =>
  ({ id, name, type: "folder", providerIds: {}, ...(parentId ? { parentId } : {}) });
const movie = (id: string, name: string): RemoteItem =>
  ({ id, name, type: "movie", providerIds: { imdb: `tt${id}` }, poster: `/poster/${id}.jpg` });
const page = (items: RemoteItem[], over: Partial<RemoteItemPage> = {}): RemoteItemPage =>
  ({ items, total: items.length, asOf: "2026-01-01T00:00:00Z", stale: false, capabilities, ...over });
const library = (over: Partial<RemoteLibrary> = {}): RemoteLibrary => ({
  id: "rlib_a", connectionId: "mconn_1", remoteId: "lib1", name: "Music videos", type: "mixed",
  enabled: true, order: 0, showOnHome: true, showInContinueWatching: true, provider: "jellyfin", capabilities, ...over,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;
let libraries: RemoteLibrary[];
let browse: Handler;
let preview: Handler;
let sources: Handler;
let item: Handler;
let state: Handler;
let downloadReply: Handler | undefined;
let addonProviders: Handler;
let addonStreams: Handler;
let addonSubtitles: Handler;
let addonProgress: Handler;
let localCopies: Handler;
let remoteLibraryStreams: Handler;
let forgetReply: Handler | undefined;
let playback: Handler;
const calls = { browse: [] as URL[], preview: [] as URL[], sources: [] as URL[], item: [] as URL[], state: [] as Array<{ method: string; body: unknown }>, stateUrls: [] as string[], title: [] as string[] };
const downloadCalls: Array<Record<string, unknown>> = [];
const deviceCalls: Array<Record<string, unknown>> = [];
const librarySourceCalls: Array<Record<string, unknown>> = [];
const playbackCalls: Array<Record<string, unknown>> = [];
const addonCalls = {
  sources: [] as URL[], streams: [] as URL[], subtitles: [] as URL[],
  local: [] as URL[], remote: [] as URL[],
  progress: [] as Array<{ method: string; path: string }>, subtitleSignals: [] as Array<AbortSignal | null | undefined>,
};

/** A controllable IntersectionObserver: tiles only ask for a preview once it fires. */
class FakeIntersectionObserver {
  static live: FakeIntersectionObserver[] = [];
  elements = new Set<Element>();
  root = null; rootMargin = ""; thresholds: number[] = [];
  constructor(private callback: IntersectionObserverCallback) { FakeIntersectionObserver.live.push(this); }
  observe(element: Element) { this.elements.add(element); }
  unobserve(element: Element) { this.elements.delete(element); }
  disconnect() { this.elements.clear(); }
  takeRecords(): IntersectionObserverEntry[] { return []; }
  fire() {
    const entries = [...this.elements].map((target) => ({ target, isIntersecting: true } as IntersectionObserverEntry));
    if (entries.length) this.callback(entries, this as unknown as IntersectionObserver);
  }
}

let root: Root;
let host: HTMLDivElement;

/** The arrow half of the save split: the one that asks where the copy should go, where the button
 *  beside it queues the row through the destination its own source projects. */
const saveElsewhere = () => host.querySelector<HTMLButtonElement>(".library-detail-actions .library-detail-save .split-button-toggle")!;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  clearTitleEnrichment();
  clearRemoteMosaicCache();
  FakeIntersectionObserver.live = [];
  calls.browse = []; calls.preview = []; calls.sources = []; calls.item = []; calls.state = []; calls.stateUrls = []; calls.title = [];
  downloadCalls.length = 0;
  deviceCalls.length = 0;
  librarySourceCalls.length = 0;
  playbackCalls.length = 0;
  addonCalls.sources = []; addonCalls.streams = []; addonCalls.subtitles = []; addonCalls.local = []; addonCalls.remote = []; addonCalls.progress = []; addonCalls.subtitleSignals = [];
  libraries = [library()];
  browse = () => json(page([]));
  preview = () => json({ posters: [] });
  sources = () => json({ streams: [] });
  item = () => json({ item: movie("m1", "One"), capabilities });
  downloadReply = undefined;
  addonProviders = () => json([]);
  addonStreams = () => json([]);
  addonSubtitles = () => json([]);
  addonProgress = () => json(null);
  localCopies = () => json([]);
  remoteLibraryStreams = () => json({ streams: [] });
  forgetReply = undefined;
  playback = () => json({
    id: "sess1", mode: "direct", url: "/api/stream/sess1", offset: 0, duration: 3600, hardware: false, acceleration: false,
    audioTracks: [], subtitleTracks: [], audioTrack: 0, subtitleTrack: null, quality: null,
  });
  state = (url, init) => {
    if (init?.method === "PATCH") return json({ key: "k", position: 0, duration: 0, favorite: true, watched: false });
    return json({ key: "k", position: 0, duration: 0, favorite: false, watched: false });
  };
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;
    if (path === "/api/remote-libraries") return Promise.resolve(json({ libraries }));
    if (path === "/api/downloads" && init?.method === "POST") {
      downloadCalls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Promise.resolve(downloadReply ? downloadReply(url, init) : json({ id: "job1", status: "queued" }, 201));
    }
    if (path === "/api/device-download" && init?.method === "POST") {
      deviceCalls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Promise.resolve(json({ url: "/api/device-download/ticket/1", filename: "film.mp4" }));
    }
    if (path === "/api/library/source" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { path: string };
      librarySourceCalls.push(body);
      return Promise.resolve(json({ sourceId: "exact", kind: "library", playable: true, localPath: body.path, behaviorHints: { filename: body.path.split("/").pop() } }));
    }
    if (path === "/api/playback" && init?.method === "POST") {
      playbackCalls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Promise.resolve(playback(url, init));
    }
    if (/^\/api\/playback\/[^/]+$/.test(path)) return Promise.resolve(new Response(null, { status: 204 }));
    if (path.startsWith("/api/stream-sources/")) { addonCalls.sources.push(url); return Promise.resolve(addonProviders(url, init)); }
    if (path.startsWith("/api/streams/")) { addonCalls.streams.push(url); return Promise.resolve(addonStreams(url, init)); }
    if (path.startsWith("/api/subtitles/")) { addonCalls.subtitles.push(url); addonCalls.subtitleSignals.push(init?.signal); return Promise.resolve(addonSubtitles(url, init)); }
    if (/^\/api\/local-streams\/[^/]+\/[^/]+$/.test(path)) { addonCalls.local.push(url); return Promise.resolve(localCopies(url, init)); }
    if (/^\/api\/remote-libraries\/[^/]+\/streams\/[^/]+\/[^/]+$/.test(path)) { addonCalls.remote.push(url); return Promise.resolve(remoteLibraryStreams(url, init)); }
    if (path.startsWith("/api/progress")) {
      addonCalls.progress.push({ method: init?.method ?? "GET", path });
      if (init?.method === "DELETE") return Promise.resolve(forgetReply ? forgetReply(url, init) : new Response(null, { status: 204 }));
      return Promise.resolve(addonProgress(url, init));
    }
    if (/^\/api\/remote-libraries\/[^/]+\/browse$/.test(path)) { calls.browse.push(url); return browse(url, init); }
    if (/^\/api\/remote-libraries\/[^/]+\/preview$/.test(path)) { calls.preview.push(url); return preview(url, init); }
    if (/^\/api\/remote-libraries\/[^/]+\/items\/[^/]+\/sources$/.test(path)) { calls.sources.push(url); return sources(url, init); }
    if (/^\/api\/remote-libraries\/[^/]+\/items\/[^/]+\/state$/.test(path)) {
      let body: unknown;
      if (typeof init?.body === "string") body = JSON.parse(init.body);
      calls.state.push({ method: init?.method ?? "GET", body });
      calls.stateUrls.push(path);
      return Promise.resolve(state(url, init));
    }
    if (/^\/api\/remote-libraries\/[^/]+\/items\/[^/]+$/.test(path)) { calls.item.push(url); return Promise.resolve(item(url, init)); }
    if (path.startsWith("/api/meta/") || path.startsWith("/api/links/") || path.startsWith("/api/trailer/")) {
      calls.title.push(path);
      if (path.startsWith("/api/links/")) return Promise.resolve(json({ links: [{ site: "imdb", url: "https://www.imdb.com/title/tt5000" }] }));
      if (path.startsWith("/api/trailer/")) return Promise.resolve(json({ trailer: null }));
      return Promise.resolve(json({ id: "tt5000", type: "movie", name: "One", background: "/catalogue-backdrop.jpg" }));
    }
    return Promise.resolve(json({}, 404));
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

const flush = () => act(async () => { await new Promise((done) => setTimeout(done, 0)); });
const tileButtons = () => [...host.querySelectorAll<HTMLButtonElement>(".browse-panel button.library-open")];
const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click(); }); await flush(); };
const byText = (selector: string, text: string) =>
  [...host.querySelectorAll<HTMLElement>(selector)].find((node) => node.textContent?.includes(text));

const render = async (over: Partial<Parameters<typeof RemoteLibraryBrowser>[0]> = {}) => {
  const onPersistPrefs = vi.fn();
  const onOpenChange = vi.fn();
  const props: Parameters<typeof RemoteLibraryBrowser>[0] = {
    audioLanguage: "en", subtitleLanguage: "en", onError: vi.fn(),
    libraryTileShape: "poster", onToggleLibraryShape: vi.fn(),
    views: emptyViews(), onPersistPrefs, onOpenChange,
    compact: false, onCompactChange: vi.fn(), onPersonalChange: vi.fn(),
    uiLanguage: "en", secureMode: true, onTrailer: vi.fn(),
    downloadLibraries: [],
    ...over,
  };
  await act(async () => { root.render(<RemoteLibraryBrowser {...props}/>); });
  await flush();
  return { props, onPersistPrefs, onOpenChange };
};

const openRootLibrary = async (which = 0) => {
  const { onOpenChange } = await render({});
  const button = host.querySelectorAll<HTMLButtonElement>(".remote-libraries button.library-open")[which]!;
  await click(button);
  return { onOpenChange };
};

describe("RemoteLibraryBrowser listing", () => {
  it("walks the provider hierarchy one page at a time and keeps breadcrumbs and Back", async () => {
    const f1 = folder("f1", "Concerts");
    const f2 = folder("f2", "2024", "f1");
    browse = (url) => {
      const parent = url.searchParams.get("parentId");
      if (!parent) return json(page([f1], { total: 2, cursor: "c1" }));
      if (parent === "f1") return json(page([f2], { total: 1 }));
      return json(page([]));
    };
    const { onOpenChange } = await openRootLibrary();
    expect(onOpenChange).toHaveBeenCalledWith(true);
    // Root listing: one folder, a cursor, and nothing beyond the first page was requested.
    expect(calls.browse).toHaveLength(1);
    expect(calls.browse[0]!.searchParams.get("mode")).toBe("folders");
    expect(calls.browse[0]!.searchParams.get("limit")).toBe("60");
    expect(calls.browse[0]!.searchParams.get("parentId")).toBeNull();
    expect(tileButtons()).toHaveLength(1);
    expect(host.querySelector(".load-more")).not.toBeNull();
    // Into the folder: the same provider page call, now one level down.
    await click(tileButtons()[0]!);
    expect(calls.browse).toHaveLength(2);
    expect(calls.browse[1]!.searchParams.get("parentId")).toBe("f1");
    expect(calls.browse[1]!.searchParams.get("mode")).toBe("folders");
    expect([...host.querySelectorAll(".crumbs button")].map((node) => node.textContent?.trim())).toEqual(["", "Library", "Music videos", "Concerts"]);
    // Back climbs one level from the listing the folder left behind, without a new provider read.
    await click(host.querySelector(".library-back")!);
    expect(calls.browse).toHaveLength(2);
    expect([...host.querySelectorAll(".crumbs button")].map((node) => node.textContent?.trim())).toEqual(["", "Library", "Music videos"]);
    expect(host.querySelector('.browse-item[data-remote-id="f1"]')).not.toBeNull();
    expect(host.querySelector<HTMLElement>('.browse-item[data-remote-id="f1"] .library-open')).toBe(document.activeElement);
    // From the root, Back leaves the browser entirely.
    await click(host.querySelector(".library-back")!);
    expect(host.querySelector(".remote-libraries")).not.toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it.each([false, true])("restores the paginated listing through its current breadcrumb (folder=%s)", async (nested) => {
    browse = (url) => {
      if (nested && !url.searchParams.get("parentId")) return json(page([folder("f1", "Concerts")]));
      return url.searchParams.get("cursor")
        ? json(page([movie("m2", "Two")]))
        : json(page([movie("m1", "One")], { cursor: "c1", total: 2 }));
    };
    item = () => json({ item: movie("m2", "Two"), capabilities });
    await openRootLibrary();
    if (nested) await click(tileButtons()[0]!);
    await click(host.querySelector(".load-more button")!);
    const reads = calls.browse.length;
    const pane = host.querySelector<HTMLDivElement>(".browse-scroll")!;
    pane.scrollTop = 760;
    await click(tileButtons()[1]!);
    pane.scrollTop = 0;
    await click(byText(".crumbs button", nested ? "Concerts" : "Music videos")!);
    expect(host.querySelector(".remote-detail")).toBeNull();
    expect(tileButtons()).toHaveLength(2);
    expect(calls.browse).toHaveLength(reads);
    expect(host.querySelector<HTMLDivElement>(".browse-scroll")!.scrollTop).toBe(760);
  });

  it("keeps series and episode offsets separate when returning through breadcrumbs", async () => {
    const show: RemoteItem = { id: "ser1", name: "Show", type: "series", providerIds: {} };
    const episode: RemoteItem = { id: "e1", name: "Pilot", type: "episode", providerIds: {} };
    browse = (url) => json(page(url.searchParams.get("type") === "episode" ? [episode] : [show]));
    item = (url) => json({ item: url.pathname.endsWith("/e1") ? episode : show, capabilities });
    await openRootLibrary();
    const pane = host.querySelector<HTMLDivElement>(".browse-scroll")!;
    pane.scrollTop = 760;
    await click(tileButtons()[0]!);
    pane.scrollTop = 340;
    await click(tileButtons()[0]!);
    pane.scrollTop = 0;
    await click(byText(".crumbs button", "Show")!);
    expect(pane.scrollTop).toBe(340);
    await click(byText(".crumbs button", "Music videos")!);
    expect(pane.scrollTop).toBe(760);
  });

  it("restores every loaded root row, cursor, offset and folder focus after a nested return", async () => {
    const f1 = folder("f1", "Concerts");
    const f2 = folder("f2", "2024");
    const film = movie("m2", "Two");
    browse = (url) => {
      const parent = url.searchParams.get("parentId");
      if (!parent) return url.searchParams.get("cursor") === "c1"
        ? json(page([film], { total: 2, cursor: "c2" }))
        : json(page([f1], { total: 2, cursor: "c1" }));
      return json(page(parent === "f1" ? [f2] : [film]));
    };
    item = () => json({ item: film, capabilities });
    await openRootLibrary();
    await click(host.querySelector(".load-more button")!);
    expect(tileButtons()).toHaveLength(2);
    const pane = host.querySelector<HTMLDivElement>(".browse-scroll")!;
    pane.scrollTop = 760;
    await click(tileButtons()[0]!);   // Concerts
    await click(tileButtons()[0]!);   // 2024
    const reads = calls.browse.length;
    await click(tileButtons()[0]!);   // Two opens its detail
    expect(host.querySelector(".library-title-detail")).not.toBeNull();
    await click(byText(".crumbs button", "Music videos")!);
    expect(host.querySelector(".library-title-detail")).toBeNull();
    expect(tileButtons()).toHaveLength(2);
    expect(host.querySelector(".load-more")).not.toBeNull();
    expect(pane.scrollTop).toBe(760);
    expect(host.querySelector<HTMLElement>('.browse-item[data-remote-id="f1"] .library-open')).toBe(document.activeElement);
    expect(calls.browse).toHaveLength(reads);
  });

  it("restores an intermediate folder listing the same way from its breadcrumb and from Back", async () => {
    const f1 = folder("f1", "Concerts");
    const f2 = folder("f2", "2024");
    const f3 = folder("f3", "Spring");
    browse = (url) => {
      const parent = url.searchParams.get("parentId");
      if (!parent) return json(page([f1]));
      if (parent === "f1") return json(page([f2]));
      if (parent === "f2") return json(page([f3]));
      return json(page([movie("m9", "Nine")]));
    };
    await openRootLibrary();
    await click(tileButtons()[0]!);   // Concerts
    await click(tileButtons()[0]!);   // 2024
    await click(tileButtons()[0]!);   // Spring
    const pane = host.querySelector<HTMLDivElement>(".browse-scroll")!;
    await click(host.querySelector(".library-back")!);
    expect(tileButtons()).toHaveLength(1);
    pane.scrollTop = 420;
    const reads = calls.browse.length;
    // The ancestor breadcrumb restores the listing of 2024 without a new read.
    await click(byText(".crumbs button", "2024")!);
    expect(calls.browse).toHaveLength(reads);
    expect(byText(".browse-panel .browse-item", "Spring")).not.toBeNull();
    expect(host.querySelector<HTMLElement>('.browse-item[data-remote-id="f3"] .library-open')).toBe(document.activeElement);
    expect(pane.scrollTop).toBe(420);
    // Back from the same child lands on that same cached listing.
    await click(tileButtons()[0]!);
    expect(calls.browse).toHaveLength(reads + 1);
    await click(host.querySelector(".library-back")!);
    expect(calls.browse).toHaveLength(reads + 1);
    expect(byText(".browse-panel .browse-item", "Spring")).not.toBeNull();
    expect(host.querySelector<HTMLElement>('.browse-item[data-remote-id="f3"] .library-open')).toBe(document.activeElement);
    expect(pane.scrollTop).toBe(420);
  });

  it("restores the ancestor's search text, sort and order", async () => {
    const f1 = folder("f1", "Concerts");
    browse = (url) => (url.searchParams.get("parentId") === "f1" ? json(page([movie("m9", "Nine")])) : json(page([f1])));
    const setSelect = async (select: HTMLSelectElement, value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await flush();
    };
    const setInput = async (input: HTMLInputElement, value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await flush();
    };
    await openRootLibrary();
    await setSelect(host.querySelector<HTMLSelectElement>(".browse-panel select")!, "size");
    await setInput(host.querySelector<HTMLInputElement>(".browse-panel .search-input input")!, "jazz");
    await act(async () => { await new Promise((done) => setTimeout(done, 350)); });
    expect(calls.browse.at(-1)!.searchParams.get("search")).toBe("jazz");
    expect(calls.browse.at(-1)!.searchParams.get("sort")).toBe("size");
    await click(tileButtons()[0]!);   // into Concerts
    await setSelect(host.querySelector<HTMLSelectElement>(".browse-panel select")!, "name");
    const reads = calls.browse.length;
    expect(host.querySelector<HTMLInputElement>(".browse-panel .search-input input")!.value).toBe("");
    await click(byText(".crumbs button", "Music videos")!);
    expect(host.querySelector<HTMLInputElement>(".browse-panel .search-input input")!.value).toBe("jazz");
    expect(host.querySelector<HTMLSelectElement>(".browse-panel select")!.value).toBe("size");
    expect(calls.browse).toHaveLength(reads);
  });

  it("drops the ancestor history when the sidebar returns to the libraries", async () => {
    const f1 = folder("f1", "Concerts");
    browse = (url) => (url.searchParams.get("parentId") === "f1" ? json(page([movie("m9", "Nine")])) : json(page([f1])));
    const { props } = await render();
    await click(host.querySelector(".remote-libraries .library-open")!);
    await click(tileButtons()[0]!);
    host.querySelector<HTMLDivElement>(".browse-scroll")!.scrollTop = 500;
    const reads = calls.browse.length;
    await act(async () => { root.render(<RemoteLibraryBrowser {...props} resetSignal={1}/>); });
    await flush();
    expect(host.querySelector(".remote-libraries")).not.toBeNull();
    // A fresh open reads the provider again; the folder it enters starts at the top.
    await click(host.querySelector(".remote-libraries .library-open")!);
    expect(calls.browse).toHaveLength(reads + 1);
    await click(tileButtons()[0]!);
    expect(calls.browse).toHaveLength(reads + 2);
    expect(host.querySelector<HTMLDivElement>(".browse-scroll")!.scrollTop).toBe(0);
  });

  it("keeps the restored ancestor when the child page it replaced lands late", async () => {
    const stale = deferred<Response>();
    browse = (url) => (url.searchParams.get("parentId") ? stale.promise : json(page([folder("f1", "Concerts")])));
    await openRootLibrary();
    await click(tileButtons()[0]!);          // the folder read is held open
    // The library's own crumb, not the section's: the section leaves the browser altogether.
    await click([...host.querySelectorAll<HTMLButtonElement>(".crumbs button")].find((node) => node.textContent?.includes("Music videos"))!);
    expect(calls.browse).toHaveLength(2);
    expect(host.querySelector('.browse-item[data-remote-id="f1"]')).not.toBeNull();
    await act(async () => { stale.resolve(json(page([movie("m9", "Stale")]))); });
    await flush();
    expect(host.textContent).not.toContain("Stale");
    expect(host.querySelector('.browse-item[data-remote-id="f1"]')).not.toBeNull();
    expect(tileButtons()).toHaveLength(1);
  });

  it("restarts a listing when a cursor turns out to be stale", async () => {
    let count = 0;
    browse = (url) => {
      count += 1;
      if (count === 1) return json(page([movie("m1", "One")], { total: 5, cursor: "c1" }));
      if (url.searchParams.get("cursor")) return json({ error: "The cursor is from another snapshot.", messageKey: "err.mediaServerStale" }, 409);
      return json(page([movie("m1", "One")], { total: 1 }));
    };
    await openRootLibrary();
    await click(host.querySelector(".load-more button")!);
    expect(calls.browse[1]!.searchParams.get("cursor")).toBe("c1");
    expect(calls.browse[2]!.searchParams.get("cursor")).toBeNull();
    expect(host.querySelector(".remote-error")).toBeNull();
    expect(host.querySelector(".load-more")).toBeNull();
  });

  it("appends pages without repeating an id", async () => {
    let count = 0;
    browse = (url) => {
      count += 1;
      if (count === 1) return json(page([movie("m1", "One")], { total: 3, cursor: "c1" }));
      if (url.searchParams.get("cursor") === "c1") return json(page([movie("m1", "One"), movie("m2", "Two")], { total: 3, cursor: "c2" }));
      return json(page([movie("m2", "Two"), movie("m3", "Three")], { total: 3 }));
    };
    await openRootLibrary();
    await click(host.querySelector(".load-more button")!);
    await click(host.querySelector(".load-more button")!);
    expect([...host.querySelectorAll(".browse-panel .library-copy strong")].map((node) => node.textContent)).toEqual(["One", "Two", "Three"]);
  });

  it("never plays a folder", async () => {
    browse = () => json(page([folder("f1", "Concerts")]));
    await openRootLibrary();
    const tile = host.querySelector(".browse-panel .browse-item.folder")!;
    expect(tile.querySelector(".library-action")!.textContent).toContain("Open folder");
    await click(tileButtons()[0]!);
    expect(calls.sources).toHaveLength(0);
    expect(calls.browse).toHaveLength(2);
    expect(host.querySelector(".player-overlay")).toBeNull();
  });

  it("keeps a failed listing usable with a retry", async () => {
    let count = 0;
    browse = () => { count += 1; return count === 1 ? json({ error: "boom" }, 500) : json(page([movie("m1", "One")])); };
    await openRootLibrary();
    expect(host.querySelector(".remote-error")).not.toBeNull();
    await click(byText(".remote-error button", "Try again")!);
    expect(host.textContent).toContain("One");
    expect(host.querySelector(".remote-error")).toBeNull();
  });

  it("browses a mixed library by folders and a movie library by titles", async () => {
    libraries = [library({ id: "rlib_mix", type: "mixed" }), library({ id: "rlib_mov", type: "movie", name: "Films" })];
    await openRootLibrary(0);
    expect(calls.browse[0]!.searchParams.get("mode")).toBe("folders");
    await click(host.querySelector(".library-back")!);
    await click(host.querySelectorAll(".remote-libraries button.library-open")[1]!);
    expect(calls.browse[1]!.searchParams.get("mode")).toBe("titles");
  });
});

describe("RemoteLibraryBrowser automatic pagination and navigation", () => {
  const sentinels = () => FakeIntersectionObserver.live
    .filter((observer) => [...observer.elements].some((element) => element.classList.contains("load-more")));

  it("requests the next page once as the sentinel comes into view", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    browse = (url) => url.searchParams.get("cursor") === "c1"
      ? json(page([movie("m2", "Two")], { total: 2 }))
      : json(page([movie("m1", "One")], { total: 2, cursor: "c1" }));
    await openRootLibrary();
    expect(calls.browse).toHaveLength(1);
    expect(sentinels()).toHaveLength(1);
    await act(async () => { sentinels().at(-1)!.fire(); });
    await flush();
    expect(calls.browse).toHaveLength(2);
    expect(calls.browse[1]!.searchParams.get("cursor")).toBe("c1");
    expect([...host.querySelectorAll(".browse-panel .library-copy strong")].map((node) => node.textContent)).toEqual(["One", "Two"]);
  });

  it("holds a repeated nudge to one in-flight page and appends it when it lands", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const held = deferred<Response>();
    browse = (url) => url.searchParams.get("cursor") === "c1"
      ? held.promise
      : json(page([movie("m1", "One")], { total: 2, cursor: "c1" }));
    await openRootLibrary();
    await act(async () => { sentinels().at(-1)!.fire(); sentinels().at(-1)!.fire(); });
    expect(calls.browse).toHaveLength(2);
    await act(async () => { held.resolve(json(page([movie("m2", "Two")], { total: 2 }))); });
    await flush();
    expect(calls.browse).toHaveLength(2);
    expect([...host.querySelectorAll(".browse-panel .library-copy strong")].map((node) => node.textContent)).toEqual(["One", "Two"]);
  });

  it("stops once the provider has no further page", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    browse = (url) => url.searchParams.get("cursor") === "c1"
      ? json(page([movie("m2", "Two")], { total: 2 }))
      : json(page([movie("m1", "One")], { total: 2, cursor: "c1" }));
    await openRootLibrary();
    await act(async () => { sentinels().at(-1)!.fire(); });
    await flush();
    expect(calls.browse).toHaveLength(2);
    expect(host.querySelector(".browse-panel .load-more")).toBeNull();
    expect(sentinels()).toHaveLength(0);
  });

  it("stops automatically after a failed page and leaves the manual retry", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    browse = (url) => url.searchParams.get("cursor") === "c1"
      ? json({ error: "boom" }, 500)
      : json(page([movie("m1", "One")], { total: 2, cursor: "c1" }));
    await openRootLibrary();
    await act(async () => { sentinels().at(-1)!.fire(); });
    await flush();
    expect(calls.browse).toHaveLength(2);
    expect(host.querySelector(".remote-error")).not.toBeNull();
    // A second nudge must not retry the failed cursor on its own.
    await act(async () => { sentinels().at(-1)?.fire(); });
    await flush();
    expect(calls.browse).toHaveLength(2);
    await click(host.querySelector(".load-more button")!);
    expect(calls.browse).toHaveLength(3);
  });

  it("drops a page that lands after the reader left the listing", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const held = deferred<Response>();
    browse = (url) => {
      if (url.searchParams.get("cursor") === "c1") return held.promise;
      if (url.searchParams.get("parentId") === "f1") return json(page([]));
      return json(page([folder("f1", "Concerts")], { total: 2, cursor: "c1" }));
    };
    await openRootLibrary();
    await act(async () => { sentinels().at(-1)!.fire(); });
    await click(tileButtons()[0]!);
    await act(async () => { held.resolve(json(page([movie("m9", "Stale")], { total: 2 }))); });
    await flush();
    expect(host.textContent).not.toContain("Stale");
    expect(calls.browse.at(-1)!.searchParams.get("parentId")).toBe("f1");
  });

  it.each([false, true])("retries a canceled page after returning from detail (episodes=%s)", async (episodeList) => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const held = deferred<Response>();
    const show: RemoteItem = { id: "ser1", name: "Show", type: "series", providerIds: {} };
    const first = episodeList
      ? { id: "e1", name: "Pilot", type: "episode" as const, season: 1, episode: 1, providerIds: {} }
      : movie("m1", "One");
    let nextRequests = 0;
    let canceledSignal: AbortSignal | null | undefined;
    browse = (url, init) => {
      if (episodeList && url.searchParams.get("type") !== "episode") return json(page([show]));
      if (url.searchParams.get("cursor") === "c1") {
        nextRequests += 1;
        if (nextRequests === 1) { canceledSignal = init?.signal; return held.promise; }
        return json(page([movie("m2", "Two")], { total: 2 }));
      }
      return json(page([first], { total: 2, cursor: "c1" }));
    };
    await openRootLibrary();
    if (episodeList) await click(tileButtons()[0]!);
    await act(async () => { sentinels().at(-1)!.fire(); });
    expect(nextRequests).toBe(1);
    await click(tileButtons()[0]!);
    expect(canceledSignal?.aborted).toBe(true);
    await click(byText(".crumbs button", episodeList ? "Show" : "Music videos")!);
    expect(host.querySelector<HTMLButtonElement>(".load-more button")!.disabled).toBe(false);
    await act(async () => { sentinels().at(-1)!.fire(); });
    await flush();
    expect(nextRequests).toBe(2);
    expect(host.textContent).toContain("Two");
    await act(async () => { held.resolve(json(page([movie("stale", "Stale")]))); });
    await flush();
    expect(host.textContent).not.toContain("Stale");
  });

  it("asks for the next page from the scroll handler when no observer fires", async () => {
    browse = (url) => url.searchParams.get("cursor") === "c1"
      ? json(page([movie("m2", "Two")], { total: 2 }))
      : json(page([movie("m1", "One")], { total: 2, cursor: "c1" }));
    await openRootLibrary();
    expect(calls.browse).toHaveLength(1);
    await act(async () => { host.querySelector(".browse-scroll")!.dispatchEvent(new Event("scroll")); });
    await flush();
    expect(calls.browse).toHaveLength(2);
    expect(calls.browse[1]!.searchParams.get("cursor")).toBe("c1");
  });

  it("shows the item and its series in the crumbs and walks back through them", async () => {
    const show: RemoteItem = { id: "ser1", name: "Show", type: "series", providerIds: {} };
    browse = (url) => url.searchParams.get("type") === "episode"
      ? json(page([{ id: "e1", name: "Pilot", type: "episode", season: 1, episode: 1, providerIds: {} }]))
      : json(page([show]));
    await openRootLibrary();
    await click(tileButtons()[0]!);
    expect([...host.querySelectorAll(".crumbs button")].map((node) => node.textContent?.trim())).toEqual(["", "Library", "Music videos", "Show"]);
    await click(tileButtons()[0]!);
    expect([...host.querySelectorAll(".crumbs button")].map((node) => node.textContent?.trim())).toEqual(["", "Library", "Music videos", "Show", "S1 E1 · Pilot"]);
    const current = host.querySelector<HTMLButtonElement>('.crumbs button[aria-current="page"]')!;
    expect(current.disabled).toBe(true);
    await click(byText(".crumbs button", "Show")!);
    expect([...host.querySelectorAll(".crumbs button")].map((node) => node.textContent?.trim())).toEqual(["", "Library", "Music videos", "Show"]);
  });

  it("hides the root block and reports no roots while a local folder owns the page", async () => {
    const onRootPresenceChange = vi.fn();
    await render({ hideRoots: true, onRootPresenceChange });
    expect(host.querySelector(".remote-libraries")).toBeNull();
    expect(onRootPresenceChange).toHaveBeenLastCalledWith(false);
  });

  it("still opens a targeted library while the roots are hidden", async () => {
    const show: RemoteItem = { id: "ser1", name: "Show", type: "series", providerIds: {} };
    item = () => json({ item: show, capabilities });
    browse = (url) => url.searchParams.get("type") === "episode" ? json(page([])) : json(page([]));
    sources = () => json({ streams: [] });
    await render({ hideRoots: true, initialTarget: { libraryId: "rlib_a", itemId: "ser1", nonce: 1 } });
    expect(host.querySelector(".remote-libraries")).toBeNull();
    expect(host.querySelector(".remote-browse-panel")).not.toBeNull();
    expect(host.querySelector(".remote-detail .hero h2")!.textContent).toBe("Show");
  });
});

describe("RemoteLibraryBrowser preferences and detail", () => {
  it("starts from the library's stored sort, order and layout and stores a change", async () => {
    const views = emptyViews();
    views.libraries["rlib_a"] = { sort: "size", order: "desc", favoritesOnly: false, view: "list" };
    browse = () => json(page([movie("m1", "One")]));
    const { onPersistPrefs } = await render({ views });
    await click(host.querySelector(".remote-libraries button.library-open")!);
    expect(calls.browse[0]!.searchParams.get("sort")).toBe("size");
    expect(calls.browse[0]!.searchParams.get("order")).toBe("desc");
    expect(host.querySelector(".browse-panel .browse-rows")).not.toBeNull();
    await click(host.querySelector('[title="Show as tiles"]')!);
    expect(onPersistPrefs).toHaveBeenCalledWith("rlib_a", { sort: "size", order: "desc", favoritesOnly: false, view: "grid" });
  });

  it("opens a film's detail with its versions and toggles its favourite", async () => {
    browse = () => json(page([movie("m1", "One")]));
    sources = () => json({ streams: [
      { sourceId: "s1", kind: "remote", playable: true, name: "1080p", provider: "jellyfin", behaviorHints: { videoSize: 2_000_000_000 } },
      { sourceId: "s2", kind: "remote", playable: true, name: "720p", provider: "jellyfin", behaviorHints: { videoSize: 800_000_000 } },
    ] });
    await openRootLibrary();
    await click(tileButtons()[0]!);
    expect(calls.sources).toHaveLength(1);
    await flush();
    // Two versions open a picker behind the arrow, not an always-visible list.
    expect(host.querySelector(".library-title-detail .remote-streams")).toBeNull();
    const favorite = host.querySelector<HTMLButtonElement>('.library-detail-chips button[aria-label="Add to favorites"]')!;
    expect(favorite.disabled).toBe(false);
    await click(favorite);
    expect(calls.state.at(-1)).toEqual({ method: "PATCH", body: { favorite: true } });
    await click(host.querySelector(".split-button-toggle")!);
    const rows = document.querySelectorAll(".library-source-card .remote-streams button");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(rows[0]!.textContent).toContain("1080p");
  });

  it("asks the catalogue nothing until a title's own detail is opened", async () => {
    const identified: RemoteItem = { ...movie("m1", "One"), providerIds: { imdb: "tt5000" } };
    browse = () => json(page([identified]));
    await openRootLibrary();
    expect(calls.title).toEqual([]);
    await click(tileButtons()[0]!);
    expect(calls.title).toContain("/api/meta/movie/tt5000");
    expect(calls.title).toContain("/api/links/movie/tt5000");
    expect(calls.title).toContain("/api/trailer/movie/tt5000");
  });

  it("asks an episode's links through its series, never the episode's own ids", async () => {
    const show: RemoteItem = { id: "ser1", name: "Show", type: "series", providerIds: { imdb: "tt7000" } };
    const episode: RemoteItem = { id: "e1", name: "Pilot", type: "episode", season: 1, episode: 1, providerIds: { imdb: "tt9999" } };
    browse = (url) => url.searchParams.get("type") === "episode" ? json(page([episode])) : json(page([show]));
    await openRootLibrary();
    await click(tileButtons()[0]!);
    await click(tileButtons()[0]!);
    await flush();
    expect(calls.title).toContain("/api/meta/series/tt7000");
    expect(calls.title.some((path) => path.includes("tt9999"))).toBe(false);
  });

  it("drops a library, folder or title and returns to the roots when the sidebar says so", async () => {
    browse = () => json(page([movie("m1", "One")]));
    const { props } = await render();
    await click(host.querySelector(".remote-libraries .library-open")!);
    await click(host.querySelector(".browse-panel .library-open")!);
    expect(host.querySelector(".library-title-detail")).not.toBeNull();
    await act(async () => { root.render(<RemoteLibraryBrowser {...props} resetSignal={1}/>); });
    await flush();
    expect(host.querySelector(".library-title-detail")).toBeNull();
    expect(host.querySelector(".remote-libraries")).not.toBeNull();
  });

  it("reads a series' episodes as one more lazy page and groups them by season", async () => {
    const show: RemoteItem = { id: "ser1", name: "Show", type: "series", providerIds: {} };
    browse = (url) => url.searchParams.get("type") === "episode"
      ? json(page([
        { id: "e1", name: "Pilot", type: "episode", season: 1, episode: 1, providerIds: {} },
        { id: "e2", name: "Second", type: "episode", season: 1, episode: 2, providerIds: {} },
      ]))
      : json(page([show]));
    await openRootLibrary();
    await click(tileButtons()[0]!);
    const episodes = calls.browse.find((url) => url.searchParams.get("type") === "episode")!;
    expect(episodes.searchParams.get("parentId")).toBe("ser1");
    expect(episodes.searchParams.get("mode")).toBe("titles");
    expect(episodes.searchParams.get("limit")).toBe("60");
    expect(host.querySelector(".remote-season")!.textContent).toBe("Season 1");
    expect(host.querySelectorAll(".browse-panel .browse-item")).toHaveLength(2);
  });

  it("wraps a series in the full-detail surface and opens its gallery", async () => {
    const onGallery = vi.fn();
    const show: RemoteItem = { id: "ser1", name: "Show", type: "series", providerIds: {}, poster: "/series-poster.jpg", wide: "/series-wide.jpg" };
    browse = (url) => json(page(url.searchParams.get("type") === "episode" ? [] : [show]));
    const { onOpenChange } = await render({ onGallery });
    await click(host.querySelectorAll<HTMLButtonElement>(".remote-libraries button.library-open")[0]!);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    await click(tileButtons()[0]!);
    const surface = host.querySelector<HTMLElement>(".remote-detail.library-title-detail.remote-series-detail")!;
    expect(surface).not.toBeNull();
    // The episodes and the hero share the one surface, and the hero carries no band of its own.
    expect(surface.querySelector(".hero.library-detail-hero")).not.toBeNull();
    expect(surface.querySelector<HTMLElement>(".hero.library-detail-hero")!.style.backgroundImage).toBe("");
    expect(surface.querySelector(".remote-episodes-head")).not.toBeNull();
    const corner = surface.querySelector<HTMLButtonElement>(".gallery-open")!;
    await click(corner);
    expect(onGallery).toHaveBeenCalled();
    expect(onGallery.mock.calls[0]![0][0].url).toBe("/series-poster.jpg");
  });

  it("opens the item a remote card from Home points at", async () => {
    item = () => json({ item: movie("m7", "Target"), capabilities });
    browse = () => json(page([]));
    sources = () => json({ streams: [] });
    await render({ initialTarget: { libraryId: "rlib_a", itemId: "m7", nonce: 1 } });
    expect(calls.sources).toHaveLength(1);
    expect(calls.sources[0]!.pathname).toBe("/api/remote-libraries/rlib_a/items/m7/sources");
    expect(host.querySelector(".remote-detail .hero h2")!.textContent).toBe("Target");
  });

  it("keeps full series metadata after returning from an episode without reloading its list", async () => {
    const show: RemoteItem = { id: "show", name: "Show", type: "series", providerIds: {} };
    const episode: RemoteItem = { id: "episode", name: "Pilot", type: "episode", season: 1, episode: 1, seriesId: "show", providerIds: {} };
    browse = (url) => json(page(url.searchParams.get("type") === "episode" ? [episode] : [show]));
    item = (url) => json({ item: url.pathname.endsWith("/show") ? { ...show, overview: "A complete series description." } : episode, capabilities });
    await openRootLibrary();
    await act(async () => tileButtons()[0]!.click());
    await flush();
    expect(host.querySelector(".library-detail-synopsis")!.textContent).toContain("complete series");
    await act(async () => tileButtons()[0]!.click());
    await flush();
    await act(async () => host.querySelector<HTMLButtonElement>(".library-back")!.click());
    await flush();
    expect(host.querySelector(".library-detail-synopsis")!.textContent).toContain("complete series");
    expect(calls.browse.filter(url => url.searchParams.get("type") === "episode")).toHaveLength(1);
  });

  it("keeps the title usable when detail metadata is malformed", async () => {
    browse = () => json(page([movie("m1", "One")]));
    item = () => json({});
    await openRootLibrary();
    await act(async () => { tileButtons()[0]!.click(); });
    await flush();
    expect(host.querySelector(".library-title-detail h2")!.textContent).toBe("One");
    expect(calls.sources).toHaveLength(1);
  });

  it("shows the year, the run time, the kind and the overview it was given", async () => {
    const film: RemoteItem = { ...movie("m1", "One"), year: 2021, durationTicks: 51_000_000_000, overview: "A quiet film.", genres: ["Drama"] };
    browse = () => json(page([film]));
    await openRootLibrary();
    const meta = host.querySelector(".browse-panel .browse-item .library-copy small")!;
    expect(meta.textContent).toBe("2021 · 1h 25m · Movies");
    expect(host.querySelector(".browse-panel .library-desc")!.textContent).toBe("A quiet film.");
    await click(tileButtons()[0]!);
    expect([...host.querySelectorAll(".remote-detail .meta-line")].map((node) => node.textContent)).toEqual(["2021 · 1h 25m · Drama"]);
    expect(host.querySelector(".remote-detail .library-detail-synopsis")!.textContent).toBe("A quiet film.");
  });

  it("reads a title's full record once as a grid row opens and keeps it across the merge", async () => {
    browse = () => json(page([movie("m1", "One")]));
    item = () => json({ item: { ...movie("m1", "One"), overview: "A full description.", genres: ["Drama"] }, capabilities });
    await openRootLibrary();
    await click(tileButtons()[0]!);
    await flush();
    // One read, never one per render: folding the facts in must not restart anything.
    expect(calls.item.filter((url) => url.pathname.endsWith("/items/m1"))).toHaveLength(1);
    expect(calls.sources).toHaveLength(1);
    expect(host.querySelector(".remote-detail .library-detail-synopsis")!.textContent).toBe("A full description.");
    expect([...host.querySelectorAll(".remote-detail .meta-line")].map((node) => node.textContent)).toEqual(["Drama"]);
  });

  it("drops a title's late record when the reader has already left it", async () => {
    const held = deferred<Response>();
    browse = () => json(page([movie("m1", "One")]));
    item = () => held.promise;
    await openRootLibrary();
    await click(tileButtons()[0]!);
    await click(host.querySelector(".library-back")!);
    await act(async () => { held.resolve(json({ item: { ...movie("m1", "One"), overview: "Late description." }, capabilities })); });
    await flush();
    expect(host.textContent).not.toContain("Late description.");
  });
});

describe("RemoteLibraryBrowser lazy mosaics", () => {
  const mosaic = (stamp: string) => `/api/remote-libraries/rlib_a/mosaic?v=${stamp}`;

  it("asks for a preview only once a tile is on screen, then draws the fan it named", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    preview = () => json({ posters: ["/a.jpg", "/b.jpg"], mosaic: mosaic("one") });
    await render();
    expect(calls.preview).toHaveLength(0);
    await act(async () => { FakeIntersectionObserver.live.at(-1)!.fire(); });
    await flush();
    expect(calls.preview).toHaveLength(1);
    expect(host.querySelector(".remote-libraries .browse-art img")?.getAttribute("src")).toBe(`${mosaic("one")}&shape=poster`);
  });

  it("issues no preview request when the library has mosaics off", async () => {
    libraries = [library({ mosaic: false })];
    await render();
    expect(calls.preview).toHaveLength(0);
    expect(host.querySelector(".remote-libraries .browse-art svg")).not.toBeNull();
  });

  it("keeps the library's own poster in the frame until the fan answers", async () => {
    libraries = [library({ poster: "/own-root.jpg" })];
    const pending = deferred<Response>();
    preview = () => pending.promise;
    await render();
    expect(host.querySelector(".remote-libraries .browse-art img")?.getAttribute("src")).toBe("/own-root.jpg");
    await act(async () => { pending.resolve(json({ posters: ["/a.jpg", "/b.jpg"], mosaic: mosaic("two") })); });
    await flush();
    expect(host.querySelector(".remote-libraries .browse-art img")?.getAttribute("src")).toBe(`${mosaic("two")}&shape=poster`);
  });

  it("paints the remembered fan again while the next answer is still out", async () => {
    preview = () => json({ posters: ["/a.jpg", "/b.jpg"], mosaic: mosaic("three") });
    await render();
    await flush();
    const pending = deferred<Response>();
    preview = () => pending.promise;
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await render();
    expect(host.querySelector(".remote-libraries .browse-art img")?.getAttribute("src")).toBe(`${mosaic("three")}&shape=poster`);
    await act(async () => { pending.resolve(json({ posters: ["/a.jpg", "/b.jpg"], mosaic: mosaic("three") })); });
    await flush();
    expect(host.querySelector(".remote-libraries .browse-art img")?.getAttribute("src")).toBe(`${mosaic("three")}&shape=poster`);
  });

  it("draws the children's fan for a root and leaves the library's own poster aside", async () => {
    libraries = [library({ poster: "/own-root.jpg" })];
    preview = () => json({ posters: ["/a.jpg", "/b.jpg"], mosaic: mosaic("root") });
    await render();
    await flush();
    expect(calls.preview.at(-1)!.searchParams.get("artwork")).toBe("children");
    expect(host.querySelector(".remote-libraries .browse-art img")?.getAttribute("src")).toBe(`${mosaic("root")}&shape=poster`);
  });

  it("keeps a library root's own poster when its mosaic is off and asks for nothing", async () => {
    libraries = [library({ mosaic: false, poster: "/own-root.jpg" })];
    await render();
    expect(calls.preview).toHaveLength(0);
    expect(host.querySelector(".remote-libraries .browse-art img")?.getAttribute("src")).toBe("/own-root.jpg");
  });

  it("draws the single picture a folder carries itself", async () => {
    libraries = [library({ poster: "/own-root.jpg" })];
    preview = () => json({ posters: [] });
    await render();
    await flush();
    expect(host.querySelector(".remote-libraries .browse-art img")?.getAttribute("src")).toBe("/own-root.jpg");
  });

  it("draws a folder's own poster in its own shape and asks for no fan", async () => {
    browse = () => json(page([{ ...folder("f1", "Show"), poster: "/folder.jpg" }]));
    await openRootLibrary();
    expect(calls.preview.filter((url) => url.searchParams.get("parentId") === "f1")).toHaveLength(0);
    expect([...host.querySelectorAll(".browse-panel .browse-art img")].some((img) => img.getAttribute("src") === "/folder.jpg")).toBe(true);
  });

  it("draws one fan address for a folder the server composed one for", async () => {
    browse = () => json(page([folder("f1", "Show")]));
    preview = (url) => url.searchParams.get("parentId") === "f1"
      ? json({ posters: ["/a.jpg", "/b.jpg", "/c.jpg"], mosaic: "/api/remote-libraries/rlib_a/mosaic?v=folder&parent=f1" })
      : json({ posters: [] });
    await openRootLibrary();
    const drawn = [...host.querySelectorAll(".browse-panel .browse-art img")].map((img) => img.getAttribute("src"));
    expect(drawn).toContain("/api/remote-libraries/rlib_a/mosaic?v=folder&parent=f1&shape=poster");
    expect(drawn.some((src) => src === "/a.jpg"), "no picture of the fan is fetched on its own").toBe(false);
  });

  it("asks a folder for its own poster-first preview, never the children mode", async () => {
    browse = () => json(page([folder("f1", "Show")]));
    await openRootLibrary();
    const asked = calls.preview.filter((url) => url.searchParams.get("parentId") === "f1");
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0]!.searchParams.get("artwork")).toBeNull();
  });

  it("never asks for a preview of a season tile", async () => {
    browse = (url) => url.searchParams.get("parentId") === "f1"
      ? json(page([{ id: "sea1", name: "Season 1", type: "season", providerIds: {} }]))
      : json(page([folder("f1", "Show")]));
    await openRootLibrary();
    await click(tileButtons()[0]!);
    expect(calls.preview.filter((url) => url.searchParams.get("parentId") === "sea1")).toHaveLength(0);
    expect(host.querySelector(".browse-panel .browse-item.folder")?.textContent).toContain("Season 1");
  });

  it("falls back to the ordinary icon when the preview fails and still opens the library", async () => {
    preview = () => json({ error: "no" }, 500);
    await render();
    expect(calls.preview.length).toBeGreaterThan(0);
    expect(host.querySelector(".remote-libraries .browse-art svg")).not.toBeNull();
    await click(host.querySelector(".remote-libraries button.library-open")!);
    expect(calls.browse).toHaveLength(1);
  });

  it("never reads more than two previews at once", async () => {
    libraries = [library({ id: "rlib_1" }), library({ id: "rlib_2" }), library({ id: "rlib_3" }), library({ id: "rlib_4" })];
    const pending = deferred<Response>();
    preview = () => pending.promise.then(() => json({ posters: [] }));
    await render();
    expect(calls.preview).toHaveLength(2);
    await act(async () => { pending.resolve(json({ posters: [] })); });
    await flush();
    expect(calls.preview).toHaveLength(4);
  });

  it("drops queued previews when their tiles are removed", async () => {
    libraries = [library({ id: "rlib_1" }), library({ id: "rlib_2" }), library({ id: "rlib_3" }), library({ id: "rlib_4" })];
    const pending = deferred<Response>();
    preview = () => pending.promise.then(() => json({ posters: [] }));
    await render();
    expect(calls.preview).toHaveLength(2);
    await click(host.querySelector("button.library-open")!);
    await act(async () => { pending.resolve(json({ posters: [] })); });
    await flush();
    expect(calls.preview).toHaveLength(2);
  });
});

describe("RemoteLibraryBrowser item menu", () => {
  const itemMenu = (index = 0) =>
    host.querySelectorAll<HTMLButtonElement>(".browse-panel .browse-item .browse-menu")[index]!;
  const actionLabels = () =>
    [...host.querySelectorAll<HTMLButtonElement>(".browse-actions button")].map((node) => node.textContent ?? "");

  it("opens an item's overflow without touching its sources and reads its state once", async () => {
    browse = () => json(page([movie("m1", "One")]));
    await openRootLibrary();
    expect(calls.state).toHaveLength(0);
    await click(itemMenu());
    expect(calls.sources).toHaveLength(0);
    expect(host.querySelector(".browse-actions")).not.toBeNull();
    expect(calls.state).toEqual([{ method: "GET", body: undefined }]);
    expect(calls.stateUrls).toEqual(["/api/remote-libraries/rlib_a/items/m1/state"]);
  });

  it("favorites the item it was opened on and badges the tile", async () => {
    browse = () => json(page([movie("m1", "One")]));
    const { props } = await render();
    await click(host.querySelector(".remote-libraries button.library-open")!);
    await click(itemMenu());
    await click(byText(".browse-actions button", "Add to favorites")!);
    expect(calls.state.at(-1)).toEqual({ method: "PATCH", body: { favorite: true } });
    expect(calls.stateUrls.at(-1)).toBe("/api/remote-libraries/rlib_a/items/m1/state");
    expect(props.onPersonalChange).toHaveBeenCalled();
    const tile = host.querySelector(".browse-panel .browse-item")!;
    expect(tile.querySelector(".fav-mark")).not.toBeNull();
  });

  it("offers favorite and open for a series but no watched toggle", async () => {
    const show: RemoteItem = { id: "ser1", name: "Show", type: "series", providerIds: {} };
    browse = (url) => url.searchParams.get("type") === "episode" ? json(page([])) : json(page([show]));
    await openRootLibrary();
    await click(itemMenu());
    const labels = actionLabels();
    expect(labels.some((text) => text.includes("Add to favorites"))).toBe(true);
    expect(labels.some((text) => text.includes("Open folder"))).toBe(true);
    expect(labels.some((text) => /watched/i.test(text))).toBe(false);
    expect(calls.sources).toHaveLength(0);
  });

  it("ignores a state read that lands after the reader moved to another item", async () => {
    const pending = deferred<Response>();
    browse = () => json(page([movie("m1", "One"), movie("m2", "Two")]));
    state = (url) => url.pathname.endsWith("/m1/state")
      ? pending.promise
      : json({ key: "k", position: 0, duration: 0, favorite: false, watched: false });
    await openRootLibrary();
    const tiles = () => [...host.querySelectorAll(".browse-panel .browse-item")];
    await click(itemMenu(0));
    await click(itemMenu(1));
    await act(async () => { pending.resolve(json({ key: "k", position: 0, duration: 0, favorite: true, watched: false })); });
    await flush();
    expect(tiles()[0]!.querySelector(".fav-mark")).toBeNull();
    expect(tiles()[1]!.querySelector(".fav-mark")).toBeNull();
  });

  it("dismisses the menu on Escape and puts focus back on its trigger", async () => {
    browse = () => json(page([movie("m1", "One")]));
    await openRootLibrary();
    const trigger = itemMenu();
    await click(trigger);
    expect(host.querySelector(".browse-actions")).not.toBeNull();
    await act(async () => { trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(host.querySelector(".browse-actions")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("dismisses the menu when something outside it is clicked", async () => {
    browse = () => json(page([movie("m1", "One")]));
    await openRootLibrary();
    await click(itemMenu());
    expect(host.querySelector(".browse-actions")).not.toBeNull();
    await click(host.querySelector(".browse-panel .browse-head")!);
    expect(host.querySelector(".browse-actions")).toBeNull();
  });
});

it("keeps a successful favorite badge when its menu closes while saving", async () => {
  browse = () => json(page([movie("m1", "One")]));
  const pending = deferred<Response>();
  state = (_url, init) => init?.method === "PATCH" ? pending.promise
    : json({ key: "k", position: 0, duration: 0, favorite: false, watched: false });
  const onPersonalChange = vi.fn();
  await render({ onPersonalChange });
  await click(host.querySelector(".remote-libraries .library-open")!);
  await click(host.querySelector(".browse-menu")!);
  await click(byText(".browse-actions button", "Add to favorites")!);
  await click(host.querySelector(".browse-head")!);
  expect(host.querySelector(".browse-actions")).toBeNull();
  await act(async () => { pending.resolve(json({ key: "k", position: 0, duration: 0, favorite: true, watched: false })); });
  await flush();
  expect(host.querySelector(".fav-mark")).not.toBeNull();
  expect(onPersonalChange).toHaveBeenCalledOnce();
});

it("keeps the favorite learned in detail on its tile after Back", async () => {
  browse = () => json(page([movie("m1", "One")]));
  state = () => json({ key: "k", position: 0, duration: 0, favorite: true, watched: false });
  await render();
  await click(host.querySelector(".remote-libraries .library-open")!);
  await click(host.querySelector(".browse-panel .library-open")!);
  expect(host.querySelector('.library-detail-chips button[aria-label="Remove from favorites"]')?.getAttribute("aria-pressed")).toBe("true");
  await click(host.querySelector(".library-back")!);
  expect(host.querySelector(".fav-mark")).not.toBeNull();
});

it("uses the high-resolution native preview when a remote item has no backdrop or catalogue identity", async () => {
  const preview = "/api/remote-libraries/rlib_a/items/clip/artwork/Primary?tag=preview-1";
  const clip: RemoteItem = { id: "clip", name: "Preview only", type: "movie", providerIds: {}, poster: preview };
  browse = () => json(page([clip]));
  item = () => json({ item: clip, capabilities });
  const onGallery = vi.fn();
  await render({ onGallery });
  await click(host.querySelector('.remote-libraries button.library-open')!);
  expect(host.querySelector('.browse-item img')?.getAttribute('src')).toBe(preview);
  await click(tileButtons()[0]!);
  await flush();
  const surface = host.querySelector<HTMLElement>('.library-title-detail')!;
  expect(surface.style.backgroundImage).toContain('size=detail');
  expect(surface.querySelector('.gallery-open img')?.getAttribute('src')).toBe(`${preview}&size=detail`);
  expect(calls.title).toHaveLength(0);
  await click(surface.querySelector('.gallery-open')!);
  expect(onGallery.mock.calls[0]?.[0]?.[0]?.url).toBe(`${preview}&size=detail`);
});

it("draws a remote backdrop at the listing width while the gallery keeps the wide address", async () => {
  const wide = "/api/remote-libraries/rlib_a/items/clip/artwork/Backdrop?tag=b1";
  const clip: RemoteItem = { id: "clip", name: "Wide and tall", type: "movie", providerIds: {}, poster: "/api/remote-libraries/rlib_a/items/clip/artwork/Primary?tag=p1", wide };
  browse = () => json(page([clip]));
  item = () => json({ item: clip, capabilities });
  const onGallery = vi.fn();
  await render({ onGallery, libraryTileShape: "wide" });
  await click(host.querySelector('.remote-libraries button.library-open')!);
  expect(host.querySelector('.browse-item img')?.getAttribute('src')).toBe(`${wide}&size=tile`);
  await click(tileButtons()[0]!);
  await flush();
  const surface = host.querySelector<HTMLElement>('.library-title-detail')!;
  await click(surface.querySelector('.gallery-open')!);
  const gallery = onGallery.mock.calls[0]?.[0] as Array<{ url: string }>;
  expect(gallery.map((image) => image.url)).toContain(wide);
  expect(gallery.some((image) => image.url.includes("size=tile"))).toBe(false);
});

describe("RemoteLibraryBrowser saved position", () => {
  const version = (name: string, mediaSourceId: string, bytes: number, itemId = "m1"): Stream => ({
    sourceId: mediaSourceId, kind: "remote", playable: true, name, provider: "jellyfin",
    remoteItem: { libraryId: "rlib_a", itemId, mediaSourceId, progressKey: "k" },
    behaviorHints: { videoSize: bytes },
  });
  const savedText = () => host.querySelector(".library-detail-progress span")!.textContent;
  const clearButton = () => host.querySelector<HTMLButtonElement>('.library-detail-progress button[aria-label="Forget progress"]');
  const stateGet = () => calls.state.filter((call) => call.method === "GET");

  it("shows the selected version's saved position and clears only it, keeping favorite and watched", async () => {
    browse = () => json(page([movie("m1", "One")]));
    sources = () => json({ streams: [version("1080p", "ms1", 2_000_000_000)] });
    state = (url, init) => init?.method === "PATCH"
      ? json({ key: "k", position: 0, duration: 0, favorite: true, watched: true, mediaSourceId: "ms1" })
      : json({ key: "k", position: 600, duration: 3600, favorite: true, watched: true, mediaSourceId: "ms1" });
    await openRootLibrary();
    await click(tileButtons()[0]!);
    await flush();
    expect(savedText()).toBe("10:00 of 1:00:00");
    // The position comes from the item's one state read; no version asks for a listing or a read of its own.
    expect(calls.sources).toHaveLength(1);
    expect(stateGet()).toHaveLength(1);
    await click(clearButton()!);
    expect(calls.state.at(-1)).toEqual({ method: "PATCH", body: { position: 0, duration: 0 } });
    expect(host.querySelector(".library-detail-progress")).toBeNull();
    expect(host.querySelector('.library-detail-chips button[aria-label="Remove from favorites"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector('.library-detail-actions button[aria-label="Mark unwatched"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it("does not show or clear another version's saved position", async () => {
    browse = () => json(page([movie("m1", "One")]));
    sources = () => json({ streams: [version("1080p", "ms1", 2_000_000_000)] });
    state = () => json({ key: "k", position: 600, duration: 3600, favorite: false, watched: false, mediaSourceId: "ms2" });
    await openRootLibrary();
    await click(tileButtons()[0]!);
    await flush();
    expect(host.querySelector(".library-detail-progress")).toBeNull();
    expect(clearButton()).toBeNull();
    expect(calls.sources).toHaveLength(1);
    expect(stateGet()).toHaveLength(1);
  });

  it("drops a clear that lands after the reader moved to another title", async () => {
    const held = deferred<Response>();
    browse = () => json(page([movie("m1", "One"), movie("m2", "Two")]));
    // Each title's version names the item it belongs to, the way the server hands it over.
    sources = (url) => json({ streams: [version("1080p", "ms1", 2_000_000_000, url.pathname.includes("/items/m2/") ? "m2" : "m1")] });
    state = (url, init) => {
      if (init?.method === "PATCH") return held.promise;
      return url.pathname.includes("/m1/")
        ? json({ key: "k1", position: 600, duration: 3600, favorite: true, watched: false, mediaSourceId: "ms1" })
        : json({ key: "k2", position: 0, duration: 0, favorite: false, watched: false, mediaSourceId: "ms1" });
    };
    await openRootLibrary();
    await click(tileButtons()[0]!);
    await flush();
    await click(clearButton()!);
    await click(host.querySelector<HTMLButtonElement>(".library-back")!);
    await click(tileButtons()[1]!);
    await flush();
    expect(host.querySelector(".library-title-detail h2")!.textContent).toBe("Two");
    await act(async () => { held.resolve(json({ key: "k1", position: 0, duration: 0, favorite: true, watched: false, mediaSourceId: "ms1" })); });
    await flush();
    expect(host.querySelector(".library-title-detail h2")!.textContent).toBe("Two");
    expect(host.querySelector(".library-detail-progress")).toBeNull();
    expect(host.querySelector('.library-detail-chips button[aria-label="Add to favorites"]')?.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("RemoteLibraryBrowser native copy", () => {
  const saveView = (over: Partial<LibraryView> = {}): LibraryView => ({
    id: "lib_1", name: "Films", type: "mixed", enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z",
    writeArtwork: false, autoScanMetadata: false, unreachable: false, readOnly: false, writable: true,
    defaultMovie: true, defaultSeries: true, titles: 0, files: 0, bytes: 0, ...over,
  });
  const copyable = (mediaSourceId: string, name: string, size: number): Stream => ({
    sourceId: `src-${mediaSourceId}`, kind: "remote", playable: true, name, provider: "jellyfin",
    remoteItem: { libraryId: "rlib_a", itemId: "m1", mediaSourceId, progressKey: "k" },
    capabilities: { rename: false, move: false, delete: false, identify: false, writeArtwork: false, downloadToLibrary: true, downloadToDevice: false },
    downloadTarget: { subfolder: "", layout: "structured", libraryId: "lib_1" },
    behaviorHints: { videoSize: size },
  });
  const actionLabels = () => [...host.querySelectorAll<HTMLButtonElement>(".browse-actions button")].map((node) => node.textContent ?? "");
  const card = () => document.querySelector<HTMLElement>(".save-target-card");
  const primary = () => document.querySelector<HTMLButtonElement>(".save-target-card footer button.primary")!;

  it("offers the copy on a movie's menu and reads the versions only when it is pressed", async () => {
    browse = () => json(page([movie("m1", "One")]));
    sources = () => json({ streams: [copyable("v1", "1080p", 1)] });
    await render({ downloadLibraries: [saveView()], onDownloadQueued: vi.fn() });
    await click(host.querySelector(".remote-libraries button.library-open")!);
    await click(host.querySelector(".browse-menu")!);
    expect(actionLabels().some((text) => text.includes("To library"))).toBe(true);
    expect(calls.sources).toHaveLength(0);
    await click(byText(".browse-actions button", "To library")!);
    expect(calls.sources).toHaveLength(1);
    expect(card()).not.toBeNull();
  });

  it("offers no copy for a series, a season or a folder", async () => {
    const show: RemoteItem = { id: "ser1", name: "Show", type: "series", providerIds: {} };
    browse = () => json(page([show]));
    await render({ downloadLibraries: [saveView()] });
    await click(host.querySelector(".remote-libraries button.library-open")!);
    await click(host.querySelector(".browse-menu")!);
    expect(actionLabels().some((text) => text.includes("To library"))).toBe(false);
  });

  it("uses the detail's own versions without another read and queues the exact source", async () => {
    browse = () => json(page([movie("m1", "One")]));
    sources = () => json({ streams: [copyable("v1", "720p", 1), copyable("v2", "1080p", 3_000_000_000)] });
    const onDownloadQueued = vi.fn();
    await render({ downloadLibraries: [saveView()], onDownloadQueued });
    await click(host.querySelector(".remote-libraries button.library-open")!);
    await click(tileButtons()[0]!);
    await flush();
    expect(calls.sources).toHaveLength(1);
    // The arrow asks for the native dialog, which is the one that lists the versions to copy.
    await click(saveElsewhere());
    expect(calls.sources).toHaveLength(1);
    await click(primary());
    expect(downloadCalls[0]!.sourceId).toBe("src-v2");
    expect(onDownloadQueued).toHaveBeenCalledTimes(1);
    expect(card()).toBeNull();
  });

  it("keeps the dialog open with the failure when the queue call is refused", async () => {
    browse = () => json(page([movie("m1", "One")]));
    sources = () => json({ streams: [copyable("v2", "1080p", 1)] });
    downloadReply = () => json({ error: "This source is already in the library." }, 409);
    await render({ downloadLibraries: [saveView()] });
    await click(host.querySelector(".remote-libraries button.library-open")!);
    await click(host.querySelector(".browse-menu")!);
    await click(byText(".browse-actions button", "To library")!);
    await click(primary());
    expect(card()).not.toBeNull();
    expect(card()!.textContent).toContain("This source is already in the library.");
  });
});

describe("RemoteLibraryBrowser addon sources", () => {
  /** The player measures its control bar; jsdom does not ship the observer. */
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
    }));
    Object.defineProperty(HTMLMediaElement.prototype, "textTracks", {
      configurable: true,
      get: () => ({ length: 0, addEventListener() {}, removeEventListener() {}, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }),
    });
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    HTMLMediaElement.prototype.pause = () => undefined;
    HTMLMediaElement.prototype.load = () => undefined;
  });

  const saveView = (over: Partial<LibraryView> = {}): LibraryView => ({
    id: "lib_1", name: "Films", type: "mixed", enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z",
    writeArtwork: false, autoScanMetadata: false, unreachable: false, readOnly: false, writable: true,
    defaultMovie: true, defaultSeries: true, titles: 0, files: 0, bytes: 0, ...over,
  });
  /** A supplementary row: a generic addon source with no native identity of any kind. */
  const addonRow = (sourceId: string, name: string): Stream => ({
    sourceId, kind: "remote", playable: true, name, title: "💾 4 GB", addonKey: "torrentio", addonName: "Torrentio",
  });
  const nativeVersion = (mediaSourceId: string, name: string, size: number): Stream => ({
    sourceId: `src-${mediaSourceId}`, kind: "remote", playable: true, name, provider: "jellyfin",
    remoteItem: { libraryId: "rlib_a", itemId: "1", mediaSourceId, progressKey: "k" },
    behaviorHints: { videoSize: size },
  });
  /** A copy the detail did not come from: another library's own item and version. */
  const foreignVersion = (libraryId: string, itemId: string, mediaSourceId: string, name: string, size: number): Stream => ({
    sourceId: `src-${libraryId}-${mediaSourceId}`, kind: "remote", playable: true, name, provider: "jellyfin",
    remoteItem: { libraryId, itemId, mediaSourceId, progressKey: "k" },
    behaviorHints: { videoSize: size },
  });
  const addonWithRule = (): Addon => ({
    key: "torrentio", role: "source", enabled: true, globalSearch: false, manifest: { id: "org.torrentio", name: "Torrentio", version: "1.0.0" },
    downloadSettings: {
      movie: { subfolder: "Films", layout: "structured", libraryId: "lib_1" },
      series: { subfolder: "Shows", layout: "structured", libraryId: "lib_1" },
    },
  });
  const identified = (id: string, name: string): RemoteItem => ({ ...movie(id, name), providerIds: { imdb: "tt5000" } });
  const playButton = () => host.querySelector<HTMLButtonElement>(".library-detail-play button.primary")!;
  const byTextIn = (root: ParentNode, selector: string, text: string) =>
    [...root.querySelectorAll<HTMLElement>(selector)].find((node) => node.textContent?.includes(text)) ?? null;
  const inDialog = (selector: string, text: string) => byTextIn(document, selector, text);

  /** Opens a movie's native detail with one version and the addon panel available. */
  const openDetail = async (over: Partial<Parameters<typeof RemoteLibraryBrowser>[0]> = {}, native: Stream[] = [nativeVersion("ms1", "1080p", 2_000_000_000)]) => {
    const onDownloadQueued = vi.fn();
    const onNotify = vi.fn();
    browse = () => json(page([identified("1", "One")]));
    sources = () => json({ streams: native });
    addonProviders = () => json([{ key: "torrentio", name: "Torrentio" }]);
    addonStreams = () => json([addonRow("addon-1", "Torrentio 4K")]);
    const rendered = await render({ addons: [addonWithRule()], downloadLibraries: [saveView()], onDownloadQueued, onNotify, ...over });
    await click(host.querySelector(".remote-libraries button.library-open")!);
    await click(tileButtons()[0]!);
    await flush();
    return { ...rendered, onDownloadQueued, onNotify };
  };
  const openPicker = async () => { await click(host.querySelector(".split-button-toggle")!); };
  const selectAddonRow = async () => {
    await click(inDialog(".library-source-card .remote-streams button", "Torrentio 4K")!);
    await flush();
  };
  const closePicker = async () => { await click(document.querySelector(".library-source-card .dialog-foot button")!); };
  const addonGetPaths = () => addonCalls.progress.filter((call) => call.method === "GET").map((call) => call.path);

  it("keeps the native version playable while a provider fails", async () => {
    await openDetail();
    addonStreams = () => json({ error: "Alpha is down" }, 502);
    await openPicker();
    expect(document.querySelector(".library-source-card")!.textContent).toContain("Alpha is down");
    await closePicker();
    await click(playButton());
    await flush();
    expect(playbackCalls[0]!.sourceId).toBe("src-ms1");
    expect(addonCalls.subtitles).toHaveLength(0);
  });

  it("reads every group the moment the chooser opens, and clears addon progress without a native patch", async () => {
    addonProgress = () => json({ key: "movie:tt5000", position: 600, duration: 3600, title: "One", updatedAt: "2026-01-01T00:00:00.000Z" });
    await openDetail();
    // A detail that is merely open asks nothing: no addon, no library, no viewer's own copies.
    expect(addonCalls.sources).toHaveLength(0);
    expect(addonCalls.streams).toHaveLength(0);
    expect(addonCalls.local).toHaveLength(0);
    expect(addonCalls.remote).toHaveLength(0);
    expect(addonCalls.subtitles).toHaveLength(0);
    // Opening the chooser is the single intent: every addon that offers the title and the
    // viewer's own copies of it are read at once, with no further press.
    await openPicker();
    expect(addonCalls.sources).toHaveLength(1);
    expect(addonCalls.sources[0]!.pathname).toBe("/api/stream-sources/movie/tt5000");
    expect(addonCalls.streams).toHaveLength(1);
    expect(addonCalls.streams[0]!.searchParams.get("addon")).toBe("torrentio");
    expect(addonCalls.local.map((url) => url.pathname)).toEqual(["/api/local-streams/movie/tt5000"]);
    await selectAddonRow();
    // The detail's own version reads the title's row as the item opens, and the addon row reads the
    // very same key: one position for every version of a title the catalogue can name.
    expect(addonGetPaths()).toEqual(["/api/progress/movie%3Att5000", "/api/progress/movie%3Att5000"]);
    expect(host.querySelector(".library-detail-progress")).not.toBeNull();
    await click(host.querySelector(".library-detail-progress button")!);
    expect(addonCalls.progress.at(-1)).toEqual({ method: "DELETE", path: "/api/progress/movie%3Att5000" });
    expect(host.querySelector(".library-detail-progress")).toBeNull();
    expect(calls.state.filter((call) => call.method === "PATCH")).toHaveLength(0);
  });

  it("asks an episode about its parent series with the season and episode appended", async () => {
    const show: RemoteItem = { id: "show", name: "Show", type: "series", providerIds: { imdb: "tt7000" } };
    const episode: RemoteItem = { id: "e1", name: "Pilot", type: "episode", season: 1, episode: 2, seriesId: "show", providerIds: { imdb: "tt9999" } };
    browse = (url) => json(page(url.searchParams.get("type") === "episode" ? [episode] : [show]));
    item = (url) => json({ item: url.pathname.endsWith("/show") ? show : episode, capabilities });
    sources = () => json({ streams: [] });
    addonProviders = () => json([{ key: "torrentio", name: "Torrentio" }]);
    addonStreams = () => json([addonRow("addon-1", "Torrentio 4K")]);
    await render({ addons: [addonWithRule()] });
    await click(host.querySelector(".remote-libraries button.library-open")!);
    await click(tileButtons()[0]!);
    await flush();
    await click(tileButtons()[0]!);
    await flush();
    await openPicker();
    expect(addonCalls.sources[0]!.pathname).toBe("/api/stream-sources/series/tt7000%3A1%3A2");
    expect(addonCalls.streams[0]!.pathname).toBe("/api/streams/series/tt7000%3A1%3A2");
    expect(addonCalls.streams.some((url) => url.pathname.includes("tt9999"))).toBe(false);
    await selectAddonRow();
    expect(addonGetPaths()).toEqual(["/api/progress/series%3Att7000%3A1%3A2"]);
  });

  it("queues the exact addon row into the addon's own rule and keeps a refusal in the dialog", async () => {
    const { onDownloadQueued } = await openDetail();
    await openPicker();
      await selectAddonRow();
    await click(saveElsewhere());
    const card = document.querySelector<HTMLElement>(".save-target-card")!;
    expect(card.textContent).toContain("Films › Films › One");
    downloadReply = () => json({ error: "This source is already in the library." }, 409);
    await click(document.querySelector(".save-target-card footer button.primary")!);
    expect(document.querySelector(".save-target-card")).not.toBeNull();
    expect(document.querySelector(".save-target-card")!.textContent).toContain("This source is already in the library.");
    expect(onDownloadQueued).not.toHaveBeenCalled();
    downloadReply = undefined;
    await click(document.querySelector(".save-target-card footer button.primary")!);
    expect(downloadCalls[0]!.sourceId).toBe("addon-1");
    expect(downloadCalls[0]!.media).toMatchObject({ kind: "movie", title: "One", id: "tt5000", metaType: "movie" });
    expect(onDownloadQueued).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".save-target-card")).toBeNull();
  });

  it("plays an addon row generically: real downloads and no native favorite or episode hand-off", async () => {
    const { onDownloadQueued, onNotify } = await openDetail();
    await openPicker();
      await selectAddonRow();
    await click(playButton());
    await flush();
    expect(playbackCalls).toHaveLength(1);
    expect(playbackCalls[0]!.sourceId).toBe("addon-1");
    const overlay = host.querySelector(".player-overlay")!;
    expect(overlay).not.toBeNull();
    expect(overlay.querySelector(".next-episode")).toBeNull();
    expect(overlay.querySelector(".previous-episode")).toBeNull();
    expect(overlay.querySelector(".player-star")).toBeNull();
    // The player's own save actions run the real flows rather than no-op callbacks.
    await click(host.querySelector(".player-settings-toggle")!);
    await click(byText(".player-action", "To library")!);
    // The player has one save button, and it saves: the destination is the row's own, resolved by
    // the server, the same way the main player's does.
    await flush();
    expect(downloadCalls[0]!.sourceId).toBe("addon-1");
    expect(onDownloadQueued).toHaveBeenCalledTimes(1);
    await click(byText(".player-action", "To device")!);
    await flush();
    expect(deviceCalls[0]!.sourceId).toBe("addon-1");
    expect(deviceCalls[0]!.media).toMatchObject({ id: "tt5000", metaType: "movie" });
    // A device save is not a queued library copy: it notifies instead of refreshing downloads.
    expect(onDownloadQueued).toHaveBeenCalledTimes(1);
    expect(onNotify).toHaveBeenCalledWith("film.mp4 is downloading through the server.");
  });

  it("keeps the native player's own episode hand-off for a native version", async () => {
    const show: RemoteItem = { id: "show", name: "Show", type: "series", providerIds: { imdb: "tt7000" } };
    const e1: RemoteItem = { id: "e1", name: "Pilot", type: "episode", season: 1, episode: 1, seriesId: "show", providerIds: {} };
    const e2: RemoteItem = { id: "e2", name: "Second", type: "episode", season: 1, episode: 2, seriesId: "show", providerIds: {} };
    browse = (url) => json(page(url.searchParams.get("type") === "episode" ? [e1, e2] : [show]));
    item = (url) => json({ item: url.pathname.endsWith("/show") ? show : url.pathname.endsWith("/e1") ? e1 : e2, capabilities });
    sources = () => json({ streams: [nativeVersion("ms1", "1080p", 2_000_000_000)] });
    await render({ addons: [] });
    await click(host.querySelector(".remote-libraries button.library-open")!);
    await click(tileButtons()[0]!);
    await flush();
    await click(tileButtons()[0]!);
    await flush();
    await click(playButton());
    await flush();
    const overlay = host.querySelector(".player-overlay")!;
    expect(overlay.querySelector(".next-episode")).not.toBeNull();
    expect(overlay.querySelector(".player-star")).not.toBeNull();
    expect(addonCalls.sources).toHaveLength(0);
  });

  it("reads addon subtitles only when addon playback starts and drops a stale answer", async () => {
    const held = deferred<Response>();
    addonSubtitles = () => held.promise;
    await openDetail();
    await openPicker();
      await selectAddonRow();
    expect(addonCalls.subtitles).toHaveLength(0);
    await click(playButton());
    await flush();
    expect(addonCalls.subtitles).toHaveLength(1);
    expect(addonCalls.subtitles[0]!.pathname).toBe("/api/subtitles/movie/tt5000");
    await click(host.querySelector(".player-head button.icon-button")!);
    expect(addonCalls.subtitleSignals.at(-1)!.aborted).toBe(true);
    await act(async () => { held.resolve(json([{ subtitleId: "sub1", lang: "en" }])); });
    await flush();
    expect(host.querySelector(".player-overlay")).toBeNull();
  });

  it("still offers an explicitly loaded addon when the native source read failed", async () => {
    browse = () => json(page([identified("1", "One")]));
    sources = () => json({ error: "provider down" }, 502);
    addonProviders = () => json([{ key: "torrentio", name: "Torrentio" }]);
    addonStreams = () => json([addonRow("addon-1", "Torrentio 4K")]);
    await render({ addons: [addonWithRule()], downloadLibraries: [saveView()] });
    await click(host.querySelector(".remote-libraries button.library-open")!);
    await click(tileButtons()[0]!);
    await flush();
    // The native error is shown and the addon side is still untouched.
    expect(host.textContent).toContain("provider down");
    expect(addonCalls.sources).toHaveLength(0);
    expect(addonCalls.streams).toHaveLength(0);
    await openPicker();
    expect(addonCalls.sources).toHaveLength(1);
    await selectAddonRow();
    expect(addonGetPaths()).toEqual(["/api/progress/movie%3Att5000"]);
    await click(playButton());
    await flush();
    expect(playbackCalls).toHaveLength(1);
    expect(playbackCalls[0]!.sourceId).toBe("addon-1");
    // The failed native read never gave the addon row any native provenance.
    expect(calls.state.filter((call) => call.method === "PATCH")).toHaveLength(0);
  });

  it("saves an episode under its parent series identity while the preview names the show season", async () => {
    const show: RemoteItem = { id: "show", name: "Show", type: "series", providerIds: { imdb: "tt7000" } };
    const episode: RemoteItem = { id: "e1", name: "Pilot", type: "episode", season: 1, episode: 2, seriesId: "show", providerIds: { imdb: "tt9999" } };
    browse = (url) => json(page(url.searchParams.get("type") === "episode" ? [episode] : [show]));
    item = (url) => json({ item: url.pathname.endsWith("/show") ? show : episode, capabilities });
    sources = () => json({ streams: [nativeVersion("ms1", "1080p", 2_000_000_000)] });
    addonProviders = () => json([{ key: "torrentio", name: "Torrentio" }]);
    addonStreams = () => json([addonRow("addon-1", "Torrentio 4K")]);
    await render({ addons: [addonWithRule()], downloadLibraries: [saveView()] });
    await click(host.querySelector(".remote-libraries button.library-open")!);
    await click(tileButtons()[0]!);
    await flush();
    await click(tileButtons()[0]!);
    await flush();
    await openPicker();
      await selectAddonRow();
    await click(saveElsewhere());
    const card = document.querySelector(".save-target-card")!;
    // The storage preview resolves the media subject: the show and its season, never the episode label.
    const preview = [...card.querySelectorAll<HTMLElement>("small")].map((node) => node.textContent ?? "").find((text) => text.includes("›")) ?? "";
    const segments = preview.split(" › ");
    expect(segments).toContain("Show");
    expect(segments).toContain("01 serie");
    expect(segments.some((segment) => segment.includes("Pilot"))).toBe(false);
    expect(card.querySelector("h2")!.textContent).toContain("Pilot");
    await click(document.querySelector(".save-target-card footer button.primary")!);
    expect(downloadCalls[0]!.sourceId).toBe("addon-1");
    expect(downloadCalls[0]!.media).toMatchObject({ kind: "episode", title: "Show", season: 1, episode: 2, episodeTitle: "Pilot", id: "tt7000", metaType: "series" });
  });

  for (const position of [20, 3500]) {
    it(`refreshes the detail only after the final generic progress write at ${position}s`, async () => {
      const finalWrite = deferred<Response>();
      let saved: unknown = { key: "movie:tt5000", position: 600, duration: 3600, title: "One", updatedAt: "2026-01-01T00:00:00.000Z" };
      let payload: Record<string, unknown> | null = null;
      addonProgress = (_url, init) => {
        if (init?.method === "POST") {
          payload = JSON.parse(String(init.body));
          return finalWrite.promise.then((response) => { saved = null; return response; });
        }
        return json(saved);
      };
      await openDetail();
      await openPicker();
          await selectAddonRow();
      await click(playButton());
      await flush();
      const video = host.querySelector<HTMLVideoElement>(".player-overlay video")!;
      await act(async () => { video.currentTime = position; video.dispatchEvent(new Event("timeupdate", { bubbles: true })); });
      const reads = addonGetPaths().length;
      await click(host.querySelector(".player-head button.icon-button")!);
      await flush();
      expect(payload).toMatchObject({ key: "movie:tt5000", position, duration: 3600 });
      expect(payload).not.toHaveProperty("addonKey");
      expect(addonGetPaths()).toHaveLength(reads);
      await act(async () => { finalWrite.resolve(new Response(null, { status: 204 })); });
      await flush();
      expect(addonGetPaths()).toHaveLength(reads + 1);
      expect(host.querySelector(".library-detail-progress")).toBeNull();
      expect(calls.state.filter(call => call.method === "PATCH")).toHaveLength(0);
    });
  }

  it("drops a late progress refresh once another title is on screen", async () => {
    const held = deferred<Response>();
    let holdRefresh = false;
    addonProgress = (_url, init) => init?.method === "POST" ? new Response(null, { status: 204 }) : holdRefresh ? held.promise : json(null);
    browse = () => json(page([identified("1", "One"), identified("2", "Two")]));
    sources = () => json({ streams: [nativeVersion("ms1", "1080p", 2_000_000_000)] });
    addonProviders = () => json([{ key: "torrentio", name: "Torrentio" }]);
    addonStreams = () => json([addonRow("addon-1", "Torrentio 4K")]);
    await render({ addons: [addonWithRule()] });
    await click(host.querySelector(".remote-libraries button.library-open")!);
    await click(tileButtons()[0]!);
    await flush();
    await openPicker();
      await selectAddonRow();
    await click(playButton());
    await flush();
    const video = host.querySelector<HTMLVideoElement>(".player-overlay video")!;
    await act(async () => { video.currentTime = 120; video.dispatchEvent(new Event("timeupdate", { bubbles: true })); });
    const reads = addonGetPaths().length;
    holdRefresh = true;
    await click(host.querySelector(".player-head button.icon-button")!);
    expect(addonGetPaths()).toHaveLength(reads + 1);
    holdRefresh = false;
    await flush();
    await click(host.querySelector(".library-back")!);
    await flush();
    await click(tileButtons()[1]!);
    await flush();
    await openPicker();
      await selectAddonRow();
    await flush();
    expect(host.querySelector(".library-detail-progress")).toBeNull();
    await act(async () => { held.resolve(json({ key: "movie:tt5000", position: 1200, duration: 3600, title: "One", updatedAt: "2026-01-01T00:00:00.000Z" })); });
    await flush();
    expect(host.querySelector(".library-detail-progress")).toBeNull();
  });

  it("does not let a late clear touch the next title's saved position", async () => {
    const held = deferred<Response>();
    let holdForget = false;
    addonProgress = () => json({ key: "movie:tt5000", position: 600, duration: 3600, title: "One", updatedAt: "2026-01-01T00:00:00.000Z" });
    forgetReply = () => holdForget ? held.promise : new Response(null, { status: 204 });
    browse = () => json(page([identified("1", "One"), identified("2", "Two")]));
    sources = () => json({ streams: [nativeVersion("ms1", "1080p", 2_000_000_000)] });
    addonProviders = () => json([{ key: "torrentio", name: "Torrentio" }]);
    addonStreams = () => json([addonRow("addon-1", "Torrentio 4K")]);
    await render({ addons: [addonWithRule()] });
    await click(host.querySelector(".remote-libraries button.library-open")!);
    await click(tileButtons()[0]!);
    await flush();
    await openPicker();
      await selectAddonRow();
    expect(host.querySelector(".library-detail-progress")).not.toBeNull();
    holdForget = true;
    await click(host.querySelector(".library-detail-progress button")!);
    holdForget = false;
    expect(addonCalls.progress.at(-1)).toEqual({ method: "DELETE", path: "/api/progress/movie%3Att5000" });
    await click(host.querySelector(".library-back")!);
    await flush();
    await click(tileButtons()[1]!);
    await flush();
    await openPicker();
      await selectAddonRow();
    await flush();
    expect(host.querySelector(".library-detail-progress")).not.toBeNull();
    // The first title's clear lands late; the second title keeps its own saved position.
    await act(async () => { held.resolve(new Response(null, { status: 204 })); });
    await flush();
    expect(host.querySelector(".library-detail-progress")).not.toBeNull();
  });

  it("asks the library the detail already came from nothing, and reads every other group once", async () => {
    libraries = [library(), library({ id: "rlib_b", name: "Second", order: 1 })];
    await openDetail();
    await openPicker();
    expect(calls.sources.map((url) => url.pathname)).toHaveLength(1);
    expect(addonCalls.remote.map((url) => url.pathname)).toEqual(["/api/remote-libraries/rlib_b/streams/movie/tt5000"]);
    expect(addonCalls.sources).toHaveLength(1);
    expect(addonCalls.streams).toHaveLength(1);
    expect(addonCalls.local.map((url) => url.pathname)).toEqual(["/api/local-streams/movie/tt5000"]);
    // Closing and reopening the chooser reuses every answer instead of asking again.
    await closePicker();
    await openPicker();
    expect(addonCalls.sources).toHaveLength(1);
    expect(addonCalls.streams).toHaveLength(1);
    expect(addonCalls.local).toHaveLength(1);
    expect(addonCalls.remote).toHaveLength(1);
  });

  it("holds at most two addon providers and two other libraries out at once", async () => {
    const held: Array<() => void> = [];
    let addonLive = 0, addonPeak = 0, remoteLive = 0, remotePeak = 0;
    libraries = [library(), library({ id: "rlib_b", name: "B", order: 1 }), library({ id: "rlib_c", name: "C", order: 2 }), library({ id: "rlib_d", name: "D", order: 3 })];
    await openDetail();
    addonProviders = () => json([{ key: "a", name: "Alpha" }, { key: "b", name: "Beta" }, { key: "c", name: "Gamma" }]);
    addonStreams = () => {
      addonLive += 1; addonPeak = Math.max(addonPeak, addonLive);
      return new Promise<Response>((done) => held.push(() => { addonLive -= 1; done(json([addonRow("addon-1", "Torrentio 4K")])); }));
    };
    remoteLibraryStreams = () => {
      remoteLive += 1; remotePeak = Math.max(remotePeak, remoteLive);
      return new Promise<Response>((done) => held.push(() => { remoteLive -= 1; done(json({ streams: [] })); }));
    };
    await openPicker();
    expect(addonPeak).toBeLessThanOrEqual(2);
    expect(remotePeak).toBeLessThanOrEqual(2);
    while (held.length) {
      const release = held.shift()!;
      await act(async () => { release(); });
      await flush();
    }
    expect(addonCalls.streams).toHaveLength(3);
    expect(addonCalls.remote).toHaveLength(3);
  });

  it("plays another library's copy under its own identity and never borrows this item's history", async () => {
    libraries = [library(), library({ id: "rlib_b", name: "Second", order: 1 })];
    remoteLibraryStreams = (url) => url.pathname.includes("rlib_b")
      ? json({ streams: [foreignVersion("rlib_b", "9", "msX", "Other copy", 8_000_000_000)] })
      : json({ streams: [] });
    state = (url, init) => {
      if (url.pathname.includes("/rlib_b/items/9/state")) {
        if (init?.method === "PATCH") return json({ key: "k", position: 0, duration: 0, favorite: false, watched: false });
        // The copy's own store names the copy's own media source.
        return json({ key: "k", position: 300, duration: 3600, favorite: false, watched: false, mediaSourceId: "msX" });
      }
      return init?.method === "PATCH"
        ? json({ key: "k", position: 0, duration: 0, favorite: true, watched: false })
        : json({ key: "k", position: 0, duration: 0, favorite: false, watched: false });
    };
    await openDetail();
    await openPicker();
    await click(inDialog(".library-source-card .remote-streams button", "Other copy")!);
    await flush();
    // The row shows the copy's own saved position, read from the copy's own store.
    expect(host.querySelector(".library-detail-progress")).not.toBeNull();
    expect(calls.stateUrls.at(-1)).toContain("/api/remote-libraries/rlib_b/items/9/state");
    expect(host.querySelector(".library-detail-progress")!.textContent).toContain("5:00");
    await click(playButton());
    await flush();
    expect(playbackCalls[0]!.sourceId).toBe("src-rlib_b-msX");
    const overlay = host.querySelector(".player-overlay")!;
    expect(overlay.querySelector(".player-star")).toBeNull();
    expect(overlay.querySelector(".next-episode")).toBeNull();
    expect(overlay.querySelector(".previous-episode")).toBeNull();
    // Resetting clears the copy's own position and never patches the original item's state.
    await click(host.querySelector(".player-head button.icon-button")!);
    await flush();
    await click(host.querySelector(".library-detail-progress button")!);
    await flush();
    expect(calls.stateUrls.at(-1)).toContain("/api/remote-libraries/rlib_b/items/9/state");
    const patches = calls.state.filter((call) => call.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toMatchObject({ position: 0, duration: 0, mediaSourceId: "msX" });
    expect(host.querySelector(".library-detail-progress")).toBeNull();
  });

  it("reads, plays and clears the viewer's own copy under its file key, never the catalogue's", async () => {
    const ownFile: Stream = {
      sourceId: "local-1", kind: "library", playable: true, localPath: "Films/One.mkv", libraryName: "Films",
      behaviorHints: { filename: "One.mkv", videoSize: 3_000_000_000 },
    };
    localCopies = () => json([ownFile]);
    let stored: unknown = { key: "file:Films/One.mkv", position: 600, duration: 3600, title: "One", updatedAt: "2026-01-01T00:00:00.000Z" };
    const writes: Array<Record<string, unknown>> = [];
    const finalWrite = deferred<Response>();
    let holdFinal = false;
    addonProgress = (_url, init) => {
      if (init?.method === "DELETE") { stored = null; return new Response(null, { status: 204 }); }
      if (init?.method === "POST") {
        writes.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (!holdFinal) return new Response(null, { status: 204 });
        return finalWrite.promise.then((response) => { stored = { key: "file:Films/One.mkv", position: 120, duration: 3600, title: "One", updatedAt: "2026-01-01T00:00:00.000Z" }; return response; });
      }
      return json(stored);
    };
    await openDetail();
    await openPicker();
    const requested = { sources: addonCalls.sources.length, streams: addonCalls.streams.length };
    await click(inDialog(".library-source-card .remote-streams button", "One.mkv")!);
    await flush();
    // The detail's own version reads the title's row, and the viewer's own copy of it is a file
    // that reads its own key: the file key is the one this selection added.
    expect(addonCalls.progress.filter((call) => call.method === "GET").map((call) => decodeURIComponent(call.path)))
      .toEqual(["/api/progress/movie:tt5000", "/api/progress/file:Films/One.mkv"]);
    expect(host.querySelector(".library-detail-progress")!.textContent).toContain("10:00");
    // A click on the same version's reset clears the file's own key, not the title's.
    await click(host.querySelector(".library-detail-progress button")!);
    await flush();
    expect(addonCalls.progress.filter((call) => call.method === "DELETE").map((call) => decodeURIComponent(call.path)))
      .toEqual(["/api/progress/file:Films/One.mkv"]);
    expect(host.querySelector(".library-detail-progress")).toBeNull();
    await click(playButton());
    await flush();
    expect(playbackCalls[0]!.sourceId).toBe("local-1");
    // Nothing about the file is asked of the catalogue, not even the subtitles of an addon answer.
    expect(addonCalls.sources).toHaveLength(requested.sources);
    expect(addonCalls.streams).toHaveLength(requested.streams);
    expect(addonCalls.subtitles).toHaveLength(0);
    const video = host.querySelector<HTMLVideoElement>(".player-overlay video")!;
    await act(async () => { video.currentTime = 120; video.dispatchEvent(new Event("timeupdate", { bubbles: true })); });
    const reads = addonCalls.progress.filter((call) => call.method === "GET").length;
    holdFinal = true;
    await click(host.querySelector(".player-head button.icon-button")!);
    await flush();
    // The final write names the file, and the panel reads its own store only once it landed.
    expect(writes.at(-1)).toMatchObject({ key: "file:Films/One.mkv", position: 120, duration: 3600 });
    expect(addonCalls.progress.filter((call) => call.method === "GET")).toHaveLength(reads);
    await act(async () => { finalWrite.resolve(new Response(null, { status: 204 })); });
    await flush();
    expect(addonCalls.progress.filter((call) => call.method === "GET")).toHaveLength(reads + 1);
    expect(host.querySelector(".library-detail-progress")!.textContent).toContain("2:00");
    expect(calls.state.filter((call) => call.method === "PATCH")).toHaveLength(0);
  });

  it("keeps two remote copies that reuse one media source apart, each under its own store", async () => {
    libraries = [library(), library({ id: "rlib_b", name: "Second", order: 1 }), library({ id: "rlib_c", name: "Third", order: 2 })];
    remoteLibraryStreams = (url) => url.pathname.includes("rlib_b")
      ? json({ streams: [foreignVersion("rlib_b", "9", "msX", "Copy B", 8_000_000_000)] })
      : json({ streams: [foreignVersion("rlib_c", "7", "msX", "Copy C", 4_000_000_000)] });
    state = (url, init) => {
      if (init?.method === "PATCH") return json({ key: "k", position: 0, duration: 0, favorite: false, watched: false });
      // Both copies report the same media source; only the item they belong to tells them apart.
      return url.pathname.includes("/rlib_c/")
        ? json({ key: "k", position: 0, duration: 0, favorite: false, watched: false, mediaSourceId: "msX" })
        : json({ key: "k", position: 600, duration: 3600, favorite: false, watched: false, mediaSourceId: "msX" });
    };
    await openDetail();
    await openPicker();
    await click(inDialog(".library-source-card .remote-streams button", "Copy B")!);
    await flush();
    expect(calls.stateUrls.at(-1)).toContain("/api/remote-libraries/rlib_b/items/9/state");
    expect(host.querySelector(".library-detail-progress")!.textContent).toContain("10:00");
    // The other copy shares the media source but none of the store: its own read answers for it.
    await openPicker();
    await click(inDialog(".library-source-card .remote-streams button", "Copy C")!);
    await flush();
    expect(calls.stateUrls.at(-1)).toContain("/api/remote-libraries/rlib_c/items/7/state");
    expect(host.querySelector(".library-detail-progress")).toBeNull();
  });

  it("never shows another media source's position for a copy of another library", async () => {
    libraries = [library(), library({ id: "rlib_b", name: "Second", order: 1 })];
    remoteLibraryStreams = () => json({ streams: [foreignVersion("rlib_b", "9", "msX", "Other copy", 8_000_000_000)] });
    // The copy's item holds a position that belongs to a different version of it.
    state = () => json({ key: "k", position: 600, duration: 3600, favorite: false, watched: false, mediaSourceId: "msOther" });
    await openDetail();
    await openPicker();
    await click(inDialog(".library-source-card .remote-streams button", "Other copy")!);
    await flush();
    expect(calls.stateUrls.at(-1)).toContain("/api/remote-libraries/rlib_b/items/9/state");
    expect(host.querySelector(".library-detail-progress")).toBeNull();
    // And playback starts it from the top rather than inheriting that position.
    await click(playButton());
    await flush();
    expect(playbackCalls[0]!.sourceId).toBe("src-rlib_b-msX");
    expect(playbackCalls[0]!.time).toBe(0);
  });

  it("shows the title's own position for the item's own version and for another version", async () => {
    libraries = [library(), library({ id: "rlib_b", name: "Second", order: 1 })];
    remoteLibraryStreams = () => json({ streams: [foreignVersion("rlib_b", "9", "msX", "Other copy", 8_000_000_000)] });
    addonProgress = () => json({ key: "movie:tt5000", position: 600, duration: 3600, title: "One", updatedAt: "2026-01-01T00:00:00.000Z" });
    await openDetail();
    // The item's own version reads the title's row, not the state of its own item, and resumes there.
    expect(host.querySelector(".library-detail-progress")!.textContent).toContain("10:00");
    await click(playButton());
    await flush();
    expect(playbackCalls[0]!.time).toBe(600);
    await click(host.querySelector(".player-head button.icon-button")!);
    await flush();
    // Another library's copy of the same film reads the very same row.
    await openPicker();
    await click(inDialog(".library-source-card .remote-streams button", "Other copy")!);
    await flush();
    expect(host.querySelector(".library-detail-progress")!.textContent).toContain("10:00");
    expect(new Set(addonGetPaths())).toEqual(new Set(["/api/progress/movie%3Att5000"]));
  });

  it("marks an identified item watched and forgets the title's position with it", async () => {
    await openDetail();
    await click(host.querySelector('.library-detail-actions button[aria-label="Mark watched"]')!);
    await flush();
    expect(calls.state.at(-1)).toEqual({ method: "PATCH", body: { watched: true } });
    expect(addonCalls.progress.at(-1)).toEqual({ method: "DELETE", path: "/api/progress/movie%3Att5000" });
  });

  it("refreshes the title's row after a copy of another library played, only once its write landed", async () => {
    libraries = [library(), library({ id: "rlib_b", name: "Second", order: 1 })];
    remoteLibraryStreams = () => json({ streams: [foreignVersion("rlib_b", "9", "msX", "Other copy", 8_000_000_000)] });
    const finalWrite = deferred<Response>();
    let hold = false;
    // The copy's own store holds the position kept there before the title did, and the title's row
    // is what its play writes.
    let stored: unknown = { key: "movie:tt5000", position: 600, duration: 3600, title: "One", updatedAt: "2026-01-01T00:00:00.000Z" };
    addonProgress = (_url, init) => {
      if (init?.method !== "POST") return json(stored);
      if (!hold) return new Response(null, { status: 204 });
      return finalWrite.promise.then((response) => {
        stored = { key: "movie:tt5000", position: 120, duration: 3600, title: "One", updatedAt: "2026-01-01T00:01:00.000Z" };
        return response;
      });
    };
    const titleGets = () => addonCalls.progress.filter((call) => call.method === "GET" && call.path === "/api/progress/movie%3Att5000").length;
    await openDetail();
    await openPicker();
    await click(inDialog(".library-source-card .remote-streams button", "Other copy")!);
    await flush();
    await click(playButton());
    await flush();
    const video = host.querySelector<HTMLVideoElement>(".player-overlay video")!;
    await act(async () => { video.currentTime = 120; video.dispatchEvent(new Event("timeupdate", { bubbles: true })); });
    const reads = titleGets();
    hold = true;
    await click(host.querySelector(".player-head button.icon-button")!);
    await flush();
    // The final write is out: the panel has not read the title's row again behind it.
    expect(addonCalls.progress.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(titleGets()).toBe(reads);
    await act(async () => { finalWrite.resolve(new Response(null, { status: 204 })); });
    await flush();
    // It lands, and only then does the panel read what was really written.
    expect(titleGets()).toBe(reads + 1);
    expect(host.querySelector(".library-detail-progress")!.textContent).toContain("2:00");
  });

  it("refreshes the title's row after the item's own version played, and leaves its remote state alone", async () => {
    const finalWrite = deferred<Response>();
    let hold = false;
    let stored: unknown = { key: "movie:tt5000", position: 600, duration: 3600, title: "One", updatedAt: "2026-01-01T00:00:00.000Z" };
    addonProgress = (_url, init) => {
      if (init?.method !== "POST") return json(stored);
      if (!hold) return new Response(null, { status: 204 });
      // The server forgets the position of a film watched to its end; the panel must follow it there.
      return finalWrite.promise.then((response) => {
        stored = null;
        return response;
      });
    };
    // The item's own state still carries what only the media server has: its favourite and watched.
    state = () => json({ key: "k", position: 600, duration: 3600, favorite: false, watched: false, mediaSourceId: "ms1" });
    const itemGets = () => calls.state.filter((call, index) => call.method === "GET" && calls.stateUrls[index]!.includes("/rlib_a/items/1/")).length;
    const titleGets = () => addonCalls.progress.filter((call) => call.method === "GET" && call.path === "/api/progress/movie%3Att5000").length;
    await openDetail();
    expect(host.querySelector(".library-detail-progress")!.textContent).toContain("10:00");
    await click(playButton());
    await flush();
    const video = host.querySelector<HTMLVideoElement>(".player-overlay video")!;
    await act(async () => { video.currentTime = 3540; video.dispatchEvent(new Event("timeupdate", { bubbles: true })); });
    const reads = titleGets();
    const stateReads = itemGets();
    hold = true;
    await click(host.querySelector(".player-head button.icon-button")!);
    await flush();
    expect(addonCalls.progress.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(titleGets()).toBe(reads);
    // The item's own state is not what holds the position any more.
    expect(itemGets()).toBe(stateReads);
    await act(async () => { finalWrite.resolve(new Response(null, { status: 204 })); });
    await flush();
    expect(titleGets()).toBe(reads + 1);
    expect(host.querySelector(".library-detail-progress")).toBeNull();
  });


  it("shows a failed source-addon discovery and retries only that lookup", async () => {
    await openDetail();
    addonProviders = () => json({ error: "The addon list is unavailable" }, 502);
    await openPicker();
    const card = document.querySelector<HTMLElement>(".library-source-card")!;
    // The lookup behind the whole class names itself, and nothing of the class was asked.
    expect(card.querySelector(".notice")!.textContent).toContain("Source addons");
    expect(card.querySelector(".notice")!.textContent).toContain("The addon list is unavailable");
    expect(addonCalls.streams).toHaveLength(0);
    expect(addonCalls.local).toHaveLength(1);
    addonProviders = () => json([{ key: "torrentio", name: "Torrentio" }]);
    await click(card.querySelector(".notice button")!);
    await flush();
    expect(addonCalls.sources).toHaveLength(2);
    expect(addonCalls.streams).toHaveLength(1);
    // The viewer's own copies answered before the retry and were not read again.
    expect(addonCalls.local).toHaveLength(1);
    expect(inDialog(".library-source-card .remote-streams button", "Torrentio 4K")).not.toBeNull();
  });

  it("saves another library's copy with the destination its own source projects", async () => {
    libraries = [library(), library({ id: "rlib_b", name: "Second", order: 1 })];
    const projected: Stream = {
      ...foreignVersion("rlib_b", "9", "msX", "Other copy", 8_000_000_000),
      capabilities: { ...capabilities, downloadToLibrary: true },
      downloadTarget: { subfolder: "Keep", layout: "structured", libraryId: "lib_1" },
    };
    remoteLibraryStreams = () => json({ streams: [projected] });
    const { onDownloadQueued } = await openDetail({ downloadLibraries: [saveView()] });
    await openPicker();
    await click(inDialog(".library-source-card .remote-streams button", "Other copy")!);
    await flush();
    await click(saveElsewhere());
    const card = document.querySelector<HTMLElement>(".save-target-card")!;
    // The automatic destination is this copy's own projection: not the addon's rule, not a default.
    const automatic = [...card.querySelectorAll<HTMLElement>("label")].find((label) => label.textContent?.includes("Keep"))!;
    expect(automatic.textContent).toContain("Films › Keep › One");
    await click(document.querySelector(".save-target-card footer button.primary")!);
    expect(downloadCalls[0]!.sourceId).toBe("src-rlib_b-msX");
    expect(downloadCalls[0]!.media).toMatchObject({ kind: "movie", title: "One", id: "tt5000", metaType: "movie" });
    expect(onDownloadQueued).toHaveBeenCalledTimes(1);
  });

  it("offers the copy action only where the server proved the right", async () => {
    libraries = [library(), library({ id: "rlib_b", name: "Second", order: 1 })];
    localCopies = () => json([{ sourceId: "local-1", kind: "library", playable: true, localPath: "Films/One.mkv", libraryName: "Films", behaviorHints: { filename: "One.mkv", videoSize: 3_000_000_000 } }]);
    remoteLibraryStreams = () => json({ streams: [foreignVersion("rlib_b", "9", "msX", "Plain copy", 8_000_000_000)] });
    const proofed: Stream = { ...nativeVersion("ms1", "1080p", 2_000_000_000), capabilities: { ...capabilities, downloadToLibrary: true } };
    await openDetail({ downloadLibraries: [saveView()] }, [proofed]);
    const save = () => byText(".library-detail-actions button", "To library")! as HTMLButtonElement;
    // The detail's own version keeps its native dialog: the server proved that copy may be made.
    expect(save().disabled).toBe(false);
    await openPicker();
    await click(inDialog(".library-source-card .remote-streams button", "Plain copy")!);
    await flush();
    // This copy reports no native download right, so the action is not offered for it.
    expect(save().disabled).toBe(true);
    await openPicker();
    await click(inDialog(".library-source-card .remote-streams button", "One.mkv")!);
    await flush();
    // The viewer's own file is already here: it is never queued as a copy of itself.
    expect(save().disabled).toBe(true);
  });

  const playerSave = async (label: string) => {
    await click(host.querySelector(".player-settings-toggle")!);
    await click(byText(".player-action", label)!);
  };

  it("saves the copy that is playing through the destination that copy projects", async () => {
    libraries = [library(), library({ id: "rlib_b", name: "Second", order: 1 })];
    const projected: Stream = {
      ...foreignVersion("rlib_b", "9", "msX", "Other copy", 8_000_000_000),
      capabilities: { ...capabilities, downloadToLibrary: true },
      downloadTarget: { subfolder: "Keep", layout: "structured", libraryId: "lib_1" },
    };
    remoteLibraryStreams = () => json({ streams: [projected] });
    const { onDownloadQueued } = await openDetail({ downloadLibraries: [saveView()] });
    await openPicker();
    await click(inDialog(".library-source-card .remote-streams button", "Other copy")!);
    await flush();
    await click(playButton());
    await flush();
    // The player offers the round's own right, and the row it saves is the row that is playing.
    await playerSave("To library");
    // The destination is the one the copy itself projected; the player's one button saves through it
    // rather than opening a dialog the round's own right does not need.
    await flush();
    expect(downloadCalls[0]!.sourceId).toBe("src-rlib_b-msX");
    expect(downloadCalls[0]!.media).toMatchObject({ kind: "movie", title: "One", id: "tt5000", metaType: "movie" });
    expect(onDownloadQueued).toHaveBeenCalledTimes(1);
  });

  it("saves this detail's own version from the player through the destination the row projects", async () => {
    const proofed: Stream = {
      ...nativeVersion("ms1", "1080p", 2_000_000_000),
      capabilities: { ...capabilities, downloadToLibrary: true },
      downloadTarget: { subfolder: "", layout: "structured", libraryId: "lib_1" },
    };
    const { onDownloadQueued } = await openDetail({ downloadLibraries: [saveView()] }, [proofed]);
    await click(playButton());
    await flush();
    await playerSave("To library");
    // A version of this library's own carries the destination its library projected: the player's
    // single button queues it there, and reads no further versions to do it.
    await flush();
    expect(calls.sources).toHaveLength(1);
    expect(downloadCalls[0]!.sourceId).toBe("src-ms1");
    expect(downloadCalls[0]!.media).toMatchObject({ kind: "movie", title: "One", id: "tt5000", metaType: "movie" });
    expect(onDownloadQueued).toHaveBeenCalledTimes(1);
  });

  it("pulls a file of the viewer's own library down to the device from the player, by its path", async () => {
    localCopies = () => json([{ sourceId: "local-1", kind: "library", playable: true, localPath: "Films/One.mkv", libraryName: "Films", behaviorHints: { filename: "One.mkv", videoSize: 3_000_000_000 } }]);
    const { onNotify } = await openDetail();
    await openPicker();
    await click(inDialog(".library-source-card .remote-streams button", "One.mkv")!);
    await flush();
    await click(playButton());
    await flush();
    await click(host.querySelector(".player-settings-toggle")!);
    // A file that is already here is never queued as a copy of itself, but it does reach the
    // device: the server resolves the file from its own path again.
    expect(byText(".player-action", "To library")).toBeUndefined();
    await click(byText(".player-action", "To device")!);
    expect(librarySourceCalls).toEqual([{ path: "Films/One.mkv" }]);
    expect(deviceCalls[0]!.sourceId).toBe("exact");
    expect(onNotify).toHaveBeenCalledWith("film.mp4 is downloading through the server.");
  });

  it("tags a copy from another library with its own provider, not the one the detail came from", async () => {
    libraries = [library({ provider: "emby" }), library({ id: "rlib_b", name: "Second", order: 1, provider: "jellyfin" })];
    const mine: Stream = { ...nativeVersion("ms1", "1080p", 2_000_000_000), provider: "emby", libraryName: "My library" };
    const other: Stream = { ...foreignVersion("rlib_b", "9", "msX", "Another copy", 8_000_000_000), libraryName: "Second" };
    remoteLibraryStreams = () => json({ streams: [other] });
    await openDetail({}, [mine]);
    await openPicker();
    const rows = () => [...document.querySelectorAll<HTMLElement>(".library-source-card .remote-streams button")];
    // An Emby detail offering a Jellyfin copy: each row wears the provider it really comes from.
    // The addon answer beside them keeps its own transport tag and its own name as the caption.
    expect(rows().map((row) => row.querySelector("i")!.textContent)).toEqual(["Emby", "Jellyfin", "HTTP"]);
    expect(rows().map((row) => row.querySelector("small")!.textContent)).toEqual(["Emby · My library", "Jellyfin · Second", "Torrentio"]);
  });
});
