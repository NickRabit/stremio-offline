import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RemoteLibraryBrowser } from "./RemoteLibraryBrowser";
import { setLocale } from "./i18n";
import { emptyViews } from "./views";
import type { RemoteCapabilities, RemoteItem, RemoteItemPage, RemoteLibrary } from "./types";

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
const calls = { browse: [] as URL[], preview: [] as URL[], sources: [] as URL[], state: [] as Array<{ method: string; body: unknown }>, stateUrls: [] as string[] };

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
  FakeIntersectionObserver.live = [];
  calls.browse = []; calls.preview = []; calls.sources = []; calls.state = []; calls.stateUrls = [];
  libraries = [library()];
  browse = () => json(page([]));
  preview = () => json({ posters: [] });
  sources = () => json({ streams: [] });
  item = () => json({ item: movie("m1", "One"), capabilities });
  state = (url, init) => {
    if (init?.method === "PATCH") return json({ key: "k", position: 0, duration: 0, favorite: true, watched: false });
    return json({ key: "k", position: 0, duration: 0, favorite: false, watched: false });
  };
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;
    if (path === "/api/remote-libraries") return Promise.resolve(json({ libraries }));
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
    if (/^\/api\/remote-libraries\/[^/]+\/items\/[^/]+$/.test(path)) return Promise.resolve(item(url, init));
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
    // Back climbs one level, not straight out of the library.
    await click(host.querySelector(".library-back")!);
    expect(calls.browse).toHaveLength(3);
    expect(calls.browse[2]!.searchParams.get("parentId")).toBeNull();
    expect([...host.querySelectorAll(".crumbs button")].map((node) => node.textContent?.trim())).toEqual(["", "Music videos"]);
    // From the root, Back leaves the browser entirely.
    await click(host.querySelector(".library-back")!);
    expect(host.querySelector(".remote-libraries")).not.toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("ignores a late page from a listing the reader already left", async () => {
    const stale = deferred<Response>();
    const fresh = deferred<Response>();
    let count = 0;
    browse = () => (++count === 1 ? json(page([folder("f1", "Concerts")])) : (count === 2 ? stale.promise : fresh.promise));
    await openRootLibrary();
    await click(tileButtons()[0]!);          // browse #2, held open
    await click(host.querySelector(".crumbs button:not(.library-back)")!); // browse #3, back to the root
    expect(calls.browse).toHaveLength(3);
    await act(async () => { stale.resolve(json(page([movie("m9", "Stale")]))); });
    await flush();
    expect(host.textContent).not.toContain("Stale");
    await act(async () => { fresh.resolve(json(page([movie("m1", "Fresh")]))); });
    await flush();
    expect(host.textContent).toContain("Fresh");
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
    sources = () => json({ streams: [{ sourceId: "s1", kind: "remote", playable: true, name: "1080p", provider: "jellyfin" }] });
    await openRootLibrary();
    await click(tileButtons()[0]!);
    expect(calls.sources).toHaveLength(1);
    await flush();
    expect(host.querySelector(".remote-streams")!.textContent).toContain("1080p");
    const favorite = host.querySelectorAll<HTMLButtonElement>(".remote-detail-actions button")[0]!;
    expect(favorite.disabled).toBe(false);
    await click(favorite);
    expect(calls.state.at(-1)).toEqual({ method: "PATCH", body: { favorite: true } });
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

  it("opens the item a remote card from Home points at", async () => {
    item = () => json({ item: movie("m7", "Target"), capabilities });
    browse = () => json(page([]));
    sources = () => json({ streams: [] });
    await render({ initialTarget: { libraryId: "rlib_a", itemId: "m7", nonce: 1 } });
    expect(calls.sources).toHaveLength(1);
    expect(calls.sources[0]!.pathname).toBe("/api/remote-libraries/rlib_a/items/m7/sources");
    expect(host.querySelector(".remote-subhead")!.textContent).toContain("Target");
  });

  it("shows the year, the run time, the kind and the overview it was given", async () => {
    const film: RemoteItem = { ...movie("m1", "One"), year: 2021, durationTicks: 51_000_000_000, overview: "A quiet film.", genres: ["Drama"] };
    browse = () => json(page([film]));
    await openRootLibrary();
    const meta = host.querySelector(".browse-panel .browse-item .library-copy small")!;
    expect(meta.textContent).toBe("2021 · 1h 25m · Movies");
    expect(host.querySelector(".browse-panel .library-desc")!.textContent).toBe("A quiet film.");
    await click(tileButtons()[0]!);
    expect([...host.querySelectorAll(".remote-detail .meta-line")].map((node) => node.textContent)).toEqual(["2021 · 1h 25m", "Drama"]);
    expect(host.querySelector(".remote-detail .identify-hint")!.textContent).toBe("A quiet film.");
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
  expect(host.querySelector(".remote-detail-actions button")?.getAttribute("aria-pressed")).toBe("true");
  await click(host.querySelector(".library-back")!);
  expect(host.querySelector(".fav-mark")).not.toBeNull();
});
