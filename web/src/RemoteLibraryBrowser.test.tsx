import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RemoteLibraryBrowser } from "./RemoteLibraryBrowser";
import { clearRemoteMosaicCache } from "./remote-mosaic";
import { setLocale } from "./i18n";
import { clearTitleEnrichment } from "./title-enrichment";
import { emptyViews } from "./views";
import type { LibraryView, RemoteCapabilities, RemoteItem, RemoteItemPage, RemoteLibrary, Stream } from "./types";

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
const calls = { browse: [] as URL[], preview: [] as URL[], sources: [] as URL[], item: [] as URL[], state: [] as Array<{ method: string; body: unknown }>, stateUrls: [] as string[], title: [] as string[] };
const downloadCalls: Array<Record<string, unknown>> = [];

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

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  clearTitleEnrichment();
  clearRemoteMosaicCache();
  FakeIntersectionObserver.live = [];
  calls.browse = []; calls.preview = []; calls.sources = []; calls.item = []; calls.state = []; calls.stateUrls = []; calls.title = [];
  downloadCalls.length = 0;
  libraries = [library()];
  browse = () => json(page([]));
  preview = () => json({ posters: [] });
  sources = () => json({ streams: [] });
  item = () => json({ item: movie("m1", "One"), capabilities });
  downloadReply = undefined;
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
    expect([...host.querySelectorAll(".crumbs button")].map((node) => node.textContent?.trim())).toEqual(["", "Music videos", "Concerts"]);
    // Back climbs one level from the listing the folder left behind, without a new provider read.
    await click(host.querySelector(".library-back")!);
    expect(calls.browse).toHaveLength(2);
    expect([...host.querySelectorAll(".crumbs button")].map((node) => node.textContent?.trim())).toEqual(["", "Music videos"]);
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
    await click(host.querySelector(".crumbs button:not(.library-back)")!); // back to the cached root
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
    expect([...host.querySelectorAll(".crumbs button")].map((node) => node.textContent?.trim())).toEqual(["", "Music videos", "Show"]);
    await click(tileButtons()[0]!);
    expect([...host.querySelectorAll(".crumbs button")].map((node) => node.textContent?.trim())).toEqual(["", "Music videos", "Show", "S1 E1 · Pilot"]);
    const current = host.querySelector<HTMLButtonElement>('.crumbs button[aria-current="page"]')!;
    expect(current.disabled).toBe(true);
    await click(byText(".crumbs button", "Show")!);
    expect([...host.querySelectorAll(".crumbs button")].map((node) => node.textContent?.trim())).toEqual(["", "Music videos", "Show"]);
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
    const favorite = host.querySelector<HTMLButtonElement>('.library-detail-actions button[aria-label="Add to favorites"]')!;
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
  it("asks for a preview only once a tile is on screen", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    preview = () => json({ posters: ["/a.jpg", "/b.jpg"] });
    await render();
    expect(calls.preview).toHaveLength(0);
    await act(async () => { FakeIntersectionObserver.live.at(-1)!.fire(); });
    await flush();
    expect(calls.preview).toHaveLength(1);
    expect(host.querySelector(".remote-libraries .library-preview-collage")).not.toBeNull();
  });

  it("issues no preview request when the library has mosaics off", async () => {
    libraries = [library({ mosaic: false })];
    await render();
    expect(calls.preview).toHaveLength(0);
    expect(host.querySelector(".remote-libraries .browse-art svg")).not.toBeNull();
  });

  it("keeps the library's own poster in the frame while the child collage loads, then covers it", async () => {
    libraries = [library({ poster: "/own-root.jpg" })];
    const pending = deferred<Response>();
    preview = () => pending.promise;
    await render();
    expect(host.querySelector(".remote-libraries .browse-art img")?.getAttribute("src")).toBe("/own-root.jpg");
    expect(host.querySelector(".remote-libraries .library-preview-collage")).toBeNull();
    await act(async () => { pending.resolve(json({ posters: ["/a.jpg", "/b.jpg"] })); });
    await flush();
    expect([...host.querySelectorAll(".remote-libraries .browse-art img")].map((img) => img.getAttribute("src"))).toEqual(["/a.jpg", "/a.jpg", "/b.jpg"]);
  });

  it("paints the last mosaic again while the next preview is still out", async () => {
    preview = () => json({ posters: ["/a.jpg", "/b.jpg"] });
    await render();
    const pending = deferred<Response>();
    preview = () => pending.promise;
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await render();
    expect([...host.querySelectorAll(".remote-libraries .browse-art img")].map((img) => img.getAttribute("src"))).toEqual(["/a.jpg", "/a.jpg", "/b.jpg"]);
    expect(host.querySelector(".remote-libraries .library-preview-collage.is-pending")).toBeNull();
    await act(async () => { pending.resolve(json({ posters: ["/a.jpg", "/b.jpg"] })); });
    await flush();
    expect(host.querySelector(".remote-libraries .library-preview-collage.is-pending")).toBeNull();
  });

  it("draws the children's collage for a root and leaves the library's own poster aside", async () => {
    libraries = [library({ poster: "/own-root.jpg" })];
    preview = () => json({ posters: ["/a.jpg", "/b.jpg"] });
    await render();
    await flush();
    expect(calls.preview.at(-1)!.searchParams.get("artwork")).toBe("children");
    expect(host.querySelector(".remote-libraries .library-preview-collage.is-pending")).not.toBeNull();
    expect([...host.querySelectorAll(".remote-libraries .browse-art img")].every((img) => img.getAttribute("src") !== "/own-root.jpg")).toBe(true);
  });

  it("keeps a library root's own poster when its mosaic is off and asks for nothing", async () => {
    libraries = [library({ mosaic: false, poster: "/own-root.jpg" })];
    await render();
    expect(calls.preview).toHaveLength(0);
    expect(host.querySelector(".remote-libraries .browse-art img")?.getAttribute("src")).toBe("/own-root.jpg");
  });

  it("falls back to the library's own poster when the child preview comes back empty", async () => {
    libraries = [library({ poster: "/own-root.jpg" })];
    preview = () => json({ posters: [] });
    await render();
    await flush();
    expect(host.querySelector(".remote-libraries .browse-art img")?.getAttribute("src")).toBe("/own-root.jpg");
  });

  it("draws a folder's own poster and asks for no preview of that folder", async () => {
    browse = () => json(page([{ ...folder("f1", "Show"), poster: "/folder.jpg" }]));
    await openRootLibrary();
    expect(calls.preview.filter((url) => url.searchParams.get("parentId") === "f1")).toHaveLength(0);
    expect([...host.querySelectorAll(".browse-panel .browse-art img")].some((img) => img.getAttribute("src") === "/folder.jpg")).toBe(true);
  });

  it("keeps a folder mosaic in place when one of its posters fails", async () => {
    browse = () => json(page([folder("f1", "Show")]));
    preview = (url) => url.searchParams.get("parentId") === "f1"
      ? json({ posters: ["/a.jpg", "/b.jpg", "/c.jpg"] })
      : json({ posters: [] });
    await openRootLibrary();
    const collage = host.querySelector(".browse-panel .library-preview-collage");
    expect(collage?.querySelectorAll("img")).toHaveLength(3);
    await act(async () => { collage!.querySelector("img")!.dispatchEvent(new Event("error")); });
    const images = host.querySelectorAll(".browse-panel .library-preview-collage img");
    expect(images).toHaveLength(3);
    expect(images[0]?.classList.contains("broken")).toBe(true);
    expect(host.querySelector(".browse-panel .browse-art > img")?.getAttribute("src")).toBe("/a.jpg");
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
  expect(host.querySelector('.library-detail-actions button[aria-label="Remove from favorites"]')?.getAttribute("aria-pressed")).toBe("true");
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
  const version = (name: string, mediaSourceId: string, bytes: number): Stream => ({
    sourceId: mediaSourceId, kind: "remote", playable: true, name, provider: "jellyfin",
    remoteItem: { libraryId: "rlib_a", itemId: "m1", mediaSourceId, progressKey: "k" },
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
    expect(host.querySelector('.library-detail-actions button[aria-label="Remove from favorites"]')?.getAttribute("aria-pressed")).toBe("true");
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
    sources = () => json({ streams: [version("1080p", "ms1", 2_000_000_000)] });
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
    expect(host.querySelector('.library-detail-actions button[aria-label="Add to favorites"]')?.getAttribute("aria-pressed")).toBe("false");
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
    await click(byText(".library-detail-actions button", "To library")!);
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
