import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LocalLibraryDetail, type LocalDetailItem } from "./LocalLibraryDetail";
import { setLocale } from "./i18n";
import { clearTitleEnrichment } from "./title-enrichment";
import type { IdentityPreview, Stream } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const file = (over: Partial<Extract<LocalDetailItem, { kind: "file" }>> = {}): LocalDetailItem =>
  ({ kind: "file", path: "Films/Heat.mkv", label: "Heat.mkv", season: null, episode: null, size: 2_000_000_000, modified: "2026-09-01", match: "unmatched", ...over });
const folder = (over: Partial<Extract<LocalDetailItem, { kind: "folder" }>> = {}): LocalDetailItem =>
  ({ kind: "folder", path: "Heat", name: "Heat", fileCount: 2, size: 4_000_000_000, match: "matched", titleType: "movie", ...over });
const identity = (over: Partial<IdentityPreview> = {}): IdentityPreview => ({
  path: "Films/Heat.mkv", key: "Films/Heat.mkv", kind: "movie", file: true, label: "Heat.mkv",
  // A row the server reports a binding for is one the matcher confirmed: it never sends `bound`
  // with another verdict, and the player refuses an identity a proposal only suggested.
  parsed: { title: "Heat", query: "Heat" }, match: over.bound ? "matched" : "unmatched", ...over,
});
const copy = (localPath: string, filename: string, bytes: number, libraryName = "Films"): Stream =>
  ({ sourceId: `lib:${localPath}`, kind: "library", playable: true, localPath, libraryName, behaviorHints: { filename, videoSize: bytes } });

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;
let source: Handler;
let identityHandler: Handler;
let copies: Handler;
let links: Handler;
let trailer: Handler;
let gallery: Handler;
let meta: Handler;
let progressOf: Handler;
let providers: Handler;
let addonStreams: Handler;
let remoteLibraries: Handler;
let remoteMatches: Handler;
let remoteState: Handler;
const calls = { source: [] as URL[], identity: [] as URL[], localStreams: [] as URL[], meta: [] as URL[], links: [] as URL[], trailer: [] as URL[], gallery: [] as URL[], progress: [] as URL[], providers: [] as URL[], addon: [] as URL[], libraries: [] as URL[], remote: [] as URL[], remoteState: [] as URL[], remoteWrites: [] as Record<string, unknown>[] };

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const progressKey = (url: URL) => decodeURIComponent(url.pathname.replace("/api/progress/", ""));
const savedEntry = (key: string, position: number, duration: number) => ({ key, position, duration, title: "Heat", updatedAt: "2026-09-01T00:00:00Z" });

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  clearTitleEnrichment();
  calls.source = []; calls.identity = []; calls.localStreams = []; calls.meta = []; calls.links = []; calls.trailer = []; calls.gallery = []; calls.progress = [];
  calls.providers = []; calls.addon = []; calls.libraries = []; calls.remote = []; calls.remoteState = []; calls.remoteWrites = [];
  source = () => json({ sourceId: "exact", kind: "library", playable: true, behaviorHints: { filename: "Heat.mkv" } });
  identityHandler = () => json(identity());
  copies = () => json([]);
  links = () => json({ links: [] });
  trailer = () => json({ trailer: null });
  gallery = () => json({ images: [] });
  meta = () => json({ id: "x", type: "movie", name: "X", background: "/catalogue-backdrop.jpg" });
  progressOf = () => json(null);
  providers = () => json([]);
  addonStreams = () => json([]);
  remoteLibraries = () => json({ libraries: [] });
  remoteMatches = () => json({ streams: [] });
  remoteState = () => json({ key: "k", position: 0, duration: 0, favorite: false, watched: false });
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;
    if (path.startsWith("/api/progress/")) { calls.progress.push(url); return Promise.resolve(progressOf(url, init)); }
    if (path === "/api/library/source") { calls.source.push(url); return Promise.resolve(source(url, init)); }
    if (path === "/api/library/identity") { calls.identity.push(url); return Promise.resolve(identityHandler(url, init)); }
    if (path === "/api/library/links") { calls.links.push(url); return Promise.resolve(links(url, init)); }
    if (path === "/api/library/trailer") { calls.trailer.push(url); return Promise.resolve(trailer(url, init)); }
    if (path === "/api/library/gallery") { calls.gallery.push(url); return Promise.resolve(gallery(url, init)); }
    if (path.startsWith("/api/meta/")) { calls.meta.push(url); return Promise.resolve(meta(url, init)); }
    if (/^\/api\/local-streams\/[^/]+\/[^/]+$/.test(path)) { calls.localStreams.push(url); return Promise.resolve(copies(url, init)); }
    if (path.startsWith("/api/stream-sources/")) { calls.providers.push(url); return Promise.resolve(providers(url, init)); }
    if (path.startsWith("/api/streams/")) { calls.addon.push(url); return Promise.resolve(addonStreams(url, init)); }
    if (path === "/api/remote-libraries") { calls.libraries.push(url); return Promise.resolve(remoteLibraries(url, init)); }
    if (/^\/api\/remote-libraries\/[^/]+\/items\/[^/]+\/state$/.test(path)) {
      calls.remoteState.push(url);
      if (init?.method === "PATCH" && typeof init.body === "string") calls.remoteWrites.push(JSON.parse(init.body) as Record<string, unknown>);
      return Promise.resolve(remoteState(url, init));
    }
    if (/^\/api\/remote-libraries\/[^/]+\/streams\/[^/]+\/[^/]+$/.test(path)) { calls.remote.push(url); return Promise.resolve(remoteMatches(url, init)); }
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
const render = async (item: LocalDetailItem, over: Partial<Parameters<typeof LocalLibraryDetail>[0]> = {}) => {
  const onPlay = vi.fn();
  const onToggleFavorite = vi.fn();
  const props = { item, favorite: false, onPlay, onToggleFavorite, onResetProgress: vi.fn(), uiLanguage: "en", secureMode: true, onTrailer: vi.fn(), ...over };
  await act(async () => { root.render(<LocalLibraryDetail {...props}/>); });
  await flush();
  return { onPlay, onToggleFavorite, props };
};
const click = async (element: Element | null) => { await act(async () => { (element as HTMLElement).click(); }); await flush(); };
const rows = () => [...document.querySelectorAll<HTMLButtonElement>(".library-source-card .remote-streams button")];
const openPicker = async () => click(host.querySelector(".split-button-toggle"));

describe("LocalLibraryDetail discovery", () => {
  it("plays the clicked file directly when nothing binds it, decorating it with its own path", async () => {
    const { onPlay } = await render(file());
    expect(calls.source).toHaveLength(1);
    expect(calls.identity).toHaveLength(1);
    expect(calls.localStreams).toHaveLength(0);
    expect(host.querySelector(".library-title-detail h2")!.textContent).toBe("Heat.mkv");
    expect([...host.querySelectorAll(".library-detail-hero .meta-line")].map((node) => node.textContent)).toContain("2.0 GB");
    await click(host.querySelector(".library-detail-play button.primary"));
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ localPath: "Films/Heat.mkv" }), undefined, null);
  });

  it("keeps the playable file when the identity lookup fails", async () => {
    identityHandler = () => json({ error: "boom" }, 500);
    await render(file());
    expect(host.querySelector(".remote-error")).toBeNull();
    expect(host.querySelector(".library-detail-play button.primary")!.hasAttribute("disabled")).toBe(false);
    expect(host.querySelector(".library-title-detail h2")!.textContent).toBe("Heat.mkv");
  });

  it("merges the copies of one title, drops the duplicate of the clicked file and defaults to the largest", async () => {
    identityHandler = () => json(identity({ bound: { type: "movie", id: "tt1", name: "Heat" } }));
    copies = () => json([
      copy("Films/Heat.mkv", "Heat.mkv", 2_000_000_000),
      copy("Other/Heat.1080p.mkv", "Heat.1080p.mkv", 6_000_000_000),
    ]);
    await render(file());
    expect(calls.localStreams[0]!.pathname).toBe("/api/local-streams/movie/tt1");
    await openPicker();
    expect(rows()).toHaveLength(2);
    expect(rows()[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(rows()[0]!.textContent).toContain("Heat.1080p.mkv");
  });

  it("asks for exactly one episode's copies, never the whole show", async () => {
    identityHandler = () => json(identity({ kind: "series", bound: { type: "series", id: "tt9", name: "Show" } }));
    copies = () => json([copy("Show/S01E02.mkv", "S01E02.mkv", 1_000_000_000, "Shows")]);
    await render(file({ path: "Show/S01E02.mkv", label: "S01E02.mkv", season: 1, episode: 2 }));
    expect(calls.localStreams[0]!.pathname).toBe("/api/local-streams/series/tt9%3A1%3A2");
  });

  it("reads a matched movie folder's versions without ever guessing a single file", async () => {
    identityHandler = () => json(identity({ file: false, kind: "movie", bound: { type: "movie", id: "tt1", name: "Heat" } }));
    copies = () => json([copy("Heat/Heat.mkv", "Heat.mkv", 2_000_000_000), copy("Heat/Heat.1080p.mkv", "Heat.1080p.mkv", 6_000_000_000)]);
    await render(folder());
    expect(calls.source).toHaveLength(0);
    expect(calls.localStreams).toHaveLength(1);
    await openPicker();
    expect(rows()).toHaveLength(2);
    expect(rows()[0]!.textContent).toContain("Heat.1080p.mkv");
  });

  it("shows no versions for a folder whose binding is not one movie", async () => {
    identityHandler = () => json(identity({ file: false, kind: "series", bound: { type: "series", id: "tt9", name: "Show" } }));
    await render(folder({ name: "Assorted" }));
    expect(calls.localStreams).toHaveLength(0);
    expect(host.querySelector(".library-title-detail")!.textContent).toContain("No playable version");
  });

  it("drops a late answer for a title the viewer has already left", async () => {
    const held = deferred<Response>();
    identityHandler = (url) => url.searchParams.get("path") === "A.mkv" ? held.promise : json(identity({ path: "B.mkv", bound: { type: "movie", id: "tt2", name: "B" } }));
    copies = () => json([copy("B/B.mkv", "B.mkv", 3_000_000_000)]);
    const { props } = await render(file({ path: "A.mkv", label: "A.mkv" }));
    await act(async () => { root.render(<LocalLibraryDetail {...props} item={file({ path: "B.mkv", label: "B.mkv" })}/>); });
    await flush();
    await act(async () => { held.resolve(json(identity({ path: "A.mkv", bound: { type: "movie", id: "tt1", name: "A" } }))); });
    await flush();
    expect(host.querySelector(".library-title-detail h2")!.textContent).toBe("B.mkv");
    expect(calls.localStreams.every((url) => !url.pathname.endsWith("tt1"))).toBe(true);
  });
});

describe("LocalLibraryDetail actions", () => {
  it("keeps file management reachable from a movie folder detail", async () => {
    const onOpenFolder = vi.fn();
    await render({ kind: "folder", path: "Movie", name: "Movie", fileCount: 2, size: 100 }, { onOpenFolder });
    const open = [...host.querySelectorAll<HTMLButtonElement>(".library-detail-actions button")].find(button => button.textContent?.includes("Open folder"));
    expect(open).toBeDefined();
    await click(open!);
    expect(onOpenFolder).toHaveBeenCalledOnce();
  });

  it("offers the device action for a movie folder's own copy, not only for a detail that is one file", async () => {
    // The folder stands for the title, and the row on screen is the file: that is the row the
    // device action takes, exactly as it does in a detail opened on the file itself.
    copies = () => json([copy("Films/Heat.mkv", "Heat.mkv", 2_000_000_000)]);
    identityHandler = () => json(identity({ file: false, kind: "movie", bound: { type: "movie", id: "tt1", name: "Heat" } }));
    const onDownloadToDevice = vi.fn();
    await render({ kind: "folder", path: "Films/Heat", name: "Heat", fileCount: 1, size: 2_000_000_000 }, { onDownloadToDevice });
    const device = [...host.querySelectorAll<HTMLButtonElement>(".library-detail-actions button")]
      .find((button) => button.getAttribute("aria-label") === "Save to this device");
    expect(device).toBeDefined();
    await click(device!);
    expect(onDownloadToDevice).toHaveBeenCalledWith(expect.objectContaining({ localPath: "Films/Heat.mkv" }));
  });

  it("toggles the clicked file's favorite and clears its saved position", async () => {
    progressOf = (url) => json(savedEntry(progressKey(url), 10, 100));
    const { onToggleFavorite, props } = await render(file(), { favorite: true, progress: { position: 10, duration: 100 } });
    await click(host.querySelector('.library-detail-chips button[aria-label="Remove from favorites"]'));
    expect(onToggleFavorite).toHaveBeenCalledWith(false);
    expect(props.onResetProgress).not.toHaveBeenCalled();
    await click(host.querySelector('.library-detail-progress button[aria-label="Forget progress"]'));
    expect(props.onResetProgress).toHaveBeenCalledWith("Films/Heat.mkv");
  });

  it("keeps the favorite control pressed and shows no position controls when nothing is saved", async () => {
    await render(file(), { favorite: true });
    const favorite = host.querySelector('.library-detail-chips button[aria-label="Remove from favorites"]');
    expect(favorite?.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector(".library-detail-progress")).toBeNull();
  });

  it("uses the existing preview for an unmatched file without requesting catalogue metadata", async () => {
    identityHandler = () => json(identity());
    await render(file({ poster: "/existing-preview.jpg" }));
    await flush();
    expect(host.querySelector<HTMLElement>(".library-title-detail")!.style.backgroundImage).toContain("/existing-preview.jpg");
    expect(calls.meta).toHaveLength(0);
  });

  it("asks the catalogue with the identity the source lookup already found, and never stretches the poster", async () => {
    identityHandler = () => json(identity({ bound: { type: "movie", id: "tt1", name: "Heat" } }));
    copies = () => json([copy("Films/Heat.mkv", "Heat.mkv", 2_000_000_000)]);
    const onGallery = vi.fn();
    await render(file({ poster: "/poster.jpg" }), { onGallery });
    expect(calls.identity).toHaveLength(1);
    await flush();
    expect(calls.meta.map((url) => url.pathname)).toEqual(["/api/meta/movie/tt1"]);
    // The file has no wide artwork, so the catalogue backdrop stands in; the poster stays in the
    // corner and is never stretched across the surface.
    const surface = host.querySelector<HTMLElement>(".library-title-detail")!;
    expect(surface.style.backgroundImage).toContain("/catalogue-backdrop.jpg");
    expect(surface.style.backgroundImage).not.toContain("/poster.jpg");
    expect(host.querySelector<HTMLElement>(".hero.library-detail-hero")!.style.backgroundImage).toBe("");
    expect(host.querySelector(".gallery-open img")?.getAttribute("src")).toBe("/poster.jpg");
  });
});

describe("LocalLibraryDetail gallery", () => {
  it("hands the file's own pictures and the catalogue's to the app, poster first", async () => {
    const onGallery = vi.fn();
    const stills = Array.from({ length: 20 }, (_, index) => `/still-${index}.jpg`);
    meta = () => json({ id: "x", type: "movie", name: "Heat", background: "/catalogue-backdrop.jpg", screenshots: stills });
    identityHandler = () => json(identity({ bound: { type: "movie", id: "tt1", name: "Heat" } }));
    await render(file({ poster: "/poster.jpg", wide: "/wide.jpg" }), { onGallery });
    const corner = host.querySelector(".gallery-open")!;
    expect(corner.querySelector("img")?.getAttribute("src")).toBe("/poster.jpg");
    // No saved pictures are read until the app opens the overlay, so the click only hands over the
    // metadata it already had: the file's poster and wide artwork, then the catalogue's.
    await click(corner);
    const [images] = onGallery.mock.calls[0]!;
    expect(images[0].url).toBe("/poster.jpg");
    expect(images[1].url).toBe("/wide.jpg");
    expect(images[2].url).toBe("/catalogue-backdrop.jpg");
    expect(images).toHaveLength(18);
    expect(new Set(images.map((image: { url: string }) => image.url)).size).toBe(18);
    expect(calls.gallery).toHaveLength(0);
  });

  it("falls back to the catalogue's backdrop when the file has no wide artwork", async () => {
    const onGallery = vi.fn();
    identityHandler = () => json(identity({ bound: { type: "movie", id: "tt1", name: "Heat" } }));
    await render(file({ wide: "/wide.jpg" }), { onGallery });
    await click(host.querySelector(".gallery-open"));
    const [images] = onGallery.mock.calls[0]!;
    expect(images.map((image: { url: string }) => image.url)).toContain("/wide.jpg");
    expect(images.map((image: { url: string }) => image.url)).toContain("/catalogue-backdrop.jpg");
  });
});

describe("LocalLibraryDetail saved position", () => {
  const twoVersions = () => [copy("Heat/Heat.mkv", "Heat.mkv", 2_000_000_000), copy("Heat/Heat.1080p.mkv", "Heat.1080p.mkv", 6_000_000_000)];
  const boundMovie = () => json(identity({ file: false, kind: "movie", bound: { type: "movie", id: "tt1", name: "Heat" } }));
  const savedText = () => host.querySelector(".library-detail-progress span")!.textContent;

  it("reads the selected version's own key and shows it without sweeping the versions", async () => {
    identityHandler = boundMovie;
    copies = () => json(twoVersions());
    progressOf = (url) => {
      const key = progressKey(url);
      return json(key.endsWith("Heat.1080p.mkv") ? savedEntry(key, 300, 3600) : savedEntry(key, 60, 3600));
    };
    await render(folder());
    await flush();
    expect(calls.progress.map(progressKey)).toEqual(["file:Heat/Heat.1080p.mkv"]);
    expect(savedText()).toBe("5:00 of 1:00:00");
    await openPicker();
    await click(rows()[1]!);
    await flush();
    expect(calls.progress.map(progressKey)).toEqual(["file:Heat/Heat.1080p.mkv", "file:Heat/Heat.mkv"]);
    expect(savedText()).toBe("1:00 of 1:00:00");
  });

  it("shows the clicked file's passed position until the authoritative read answers", async () => {
    const held = deferred<Response>();
    progressOf = () => held.promise;
    const props = { item: file(), favorite: false, onPlay: vi.fn(), onToggleFavorite: vi.fn(), onResetProgress: vi.fn(), uiLanguage: "en", secureMode: true, onTrailer: vi.fn(), progress: { position: 42, duration: 600 } };
    await act(async () => { root.render(<LocalLibraryDetail {...props}/>); });
    await flush();
    expect(savedText()).toBe("0:42 of 10:00");
    await act(async () => { held.resolve(json(savedEntry("file:Films/Heat.mkv", 90, 600))); });
    await flush();
    expect(savedText()).toBe("1:30 of 10:00");
  });

  it("drops a saved position that lands after the viewer left the file", async () => {
    const held = deferred<Response>();
    progressOf = (url) => progressKey(url).includes("A.mkv") ? held.promise : json(savedEntry(progressKey(url), 60, 600));
    const { props } = await render(file({ path: "A.mkv", label: "A.mkv" }));
    await act(async () => { root.render(<LocalLibraryDetail {...props} item={file({ path: "B.mkv", label: "B.mkv" })}/>); });
    await flush();
    expect(savedText()).toBe("1:00 of 10:00");
    await act(async () => { held.resolve(json(savedEntry("file:A.mkv", 9999, 600))); });
    await flush();
    expect(savedText()).toBe("1:00 of 10:00");
  });

  it("clears the selected file's key, never the clicked folder's path", async () => {
    identityHandler = boundMovie;
    copies = () => json(twoVersions());
    progressOf = (url) => json(savedEntry(progressKey(url), 120, 3600));
    const onResetProgress = vi.fn().mockResolvedValue(true);
    await render(folder(), { onResetProgress });
    await flush();
    await click(host.querySelector('.library-detail-progress button[aria-label="Forget progress"]'));
    expect(onResetProgress).toHaveBeenCalledWith("Heat/Heat.1080p.mkv");
    expect(onResetProgress).not.toHaveBeenCalledWith("Heat");
    expect(host.querySelector(".library-detail-progress")).toBeNull();
  });

  it("keeps the position when the clear fails and leaves the favorite alone", async () => {
    progressOf = (url) => json(savedEntry(progressKey(url), 120, 3600));
    const onResetProgress = vi.fn().mockResolvedValue(false);
    const { onToggleFavorite } = await render(file(), { progress: { position: 120, duration: 3600 }, onResetProgress });
    await flush();
    await click(host.querySelector('.library-detail-progress button[aria-label="Forget progress"]'));
    expect(host.querySelector(".library-detail-progress")).not.toBeNull();
    expect(onToggleFavorite).not.toHaveBeenCalled();
  });

  it("refreshes the same source after returning from playback", async () => {
    let position = 120;
    progressOf = (url) => json(savedEntry(progressKey(url), position, 3600));
    const { props } = await render(file());
    await flush();
    expect(savedText()).toBe("2:00 of 1:00:00");
    position = 240;
    await act(async () => root.render(<LocalLibraryDetail {...props} progressRevision={1}/>));
    await flush();
    expect(savedText()).toBe("4:00 of 1:00:00");
  });

  it("does not overwrite another selected version after a slow clear", async () => {
    identityHandler = boundMovie;
    copies = () => json(twoVersions());
    progressOf = (url) => json(savedEntry(progressKey(url), 120, 3600));
    const held = deferred<boolean>();
    await render(folder(), { onResetProgress: () => held.promise });
    await flush();
    await click(host.querySelector('.library-detail-progress button[aria-label="Forget progress"]'));
    await openPicker();
    await click(rows()[1]!);
    await flush();
    await act(async () => { held.resolve(true); });
    expect(savedText()).toBe("2:00 of 1:00:00");
  });

  it("starts over from the beginning without clearing the saved position", async () => {
    progressOf = (url) => json(savedEntry(progressKey(url), 120, 3600));
    const { onPlay, props } = await render(file(), { progress: { position: 120, duration: 3600 } });
    await flush();
    const startOver = host.querySelector<HTMLButtonElement>('.library-detail-actions button[aria-label="Play from the start"]');
    await click(startOver!);
    expect(onPlay.mock.calls.at(-1)![1]).toBe(true);
    expect(props.onResetProgress).not.toHaveBeenCalled();
  });
});

describe("LocalLibraryDetail extra sources", () => {
  const boundMovie = () => json(identity({ file: false, kind: "movie", bound: { type: "movie", id: "tt1", name: "Heat" } }));
  const addonRow = (sourceId: string, name: string): Stream =>
    ({ sourceId, kind: "remote", playable: true, name, addonKey: "torrentio", addonName: "Torrentio" });
  const otherCopy = (libraryId: string, itemId: string): Stream => ({
    sourceId: `src-${libraryId}`, kind: "remote", playable: true, name: "Other copy", provider: "jellyfin",
    remoteItem: { libraryId, itemId, mediaSourceId: "msX", progressKey: "k" },
    capabilities: { rename: false, move: false, delete: false, identify: false, writeArtwork: false, downloadToLibrary: true, downloadToDevice: false },
  });
  const remoteLibrary = (id: string, name: string) => ({
    id, connectionId: "c", remoteId: id, name, type: "mixed" as const, enabled: true, order: 0,
    showOnHome: false, showInContinueWatching: false, provider: "jellyfin" as const,
    capabilities: { rename: false, move: false, delete: false, identify: false, writeArtwork: false, downloadToLibrary: false, downloadToDevice: false },
  });
  const oneNative = () => json([copy("Heat/Heat.mkv", "Heat.mkv", 2_000_000_000)]);

  it("asks nothing until the chooser opens, then reads the addons and the other libraries at once", async () => {
    identityHandler = boundMovie;
    copies = oneNative;
    providers = () => json([{ key: "torrentio", name: "Torrentio" }]);
    addonStreams = () => json([addonRow("addon-1", "Torrentio 4K")]);
    remoteLibraries = () => json({ libraries: [remoteLibrary("rlib_b", "Second")] });
    remoteMatches = () => json({ streams: [otherCopy("rlib_b", "9")] });
    await render(folder());
    expect(calls.providers).toHaveLength(0);
    expect(calls.addon).toHaveLength(0);
    expect(calls.libraries).toHaveLength(0);
    expect(calls.remote).toHaveLength(0);
    await openPicker();
    expect(calls.providers.map((url) => url.pathname)).toEqual(["/api/stream-sources/movie/tt1"]);
    expect(calls.addon.map((url) => url.searchParams.get("addon"))).toEqual(["torrentio"]);
    expect(calls.libraries).toHaveLength(1);
    expect(calls.remote.map((url) => url.pathname)).toEqual(["/api/remote-libraries/rlib_b/streams/movie/tt1"]);
    expect(rows()).toHaveLength(3);
    // The library's own copies lead, then the other libraries, then the addon answers.
    expect(rows()[1]!.textContent).toContain("Other copy");
    expect(rows()[2]!.textContent).toContain("Torrentio 4K");
    // The viewer's own copies are the detail's own rows already: no second read of them.
    expect(calls.localStreams).toHaveLength(1);
  });

  it("keeps an unbound file's own source, with no chooser and no catalogue request", async () => {
    const { onPlay } = await render(file());
    expect(host.querySelector(".split-button-toggle")).toBeNull();
    await click(host.querySelector(".library-detail-play button.primary"));
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ localPath: "Films/Heat.mkv" }), undefined, null);
    expect(calls.providers).toHaveLength(0);
    expect(calls.addon).toHaveLength(0);
    expect(calls.remote).toHaveLength(0);
  });

  it("asks an episode about its parent series with its own numbering", async () => {
    identityHandler = () => json(identity({ path: "Show/S01E02.mkv", kind: "series", bound: { type: "series", id: "tt9", name: "Show" }, parsed: { title: "Show", query: "Show", season: 1, episode: 2 } }));
    copies = () => json([]);
    const { onPlay } = await render(file({ path: "Show/S01E02.mkv", label: "S01E02.mkv", season: 1, episode: 2 }));
    await openPicker();
    expect(calls.providers.map((url) => url.pathname)).toEqual(["/api/stream-sources/series/tt9%3A1%3A2"]);
    expect(calls.localStreams.map((url) => url.pathname)).toEqual(["/api/local-streams/series/tt9%3A1%3A2"]);
    // The detail already knows which episode the file holds, so the player is handed the identity
    // rather than resolving the file a second time.
    await click(host.querySelector(".library-detail-play button.primary"));
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ localPath: "Show/S01E02.mkv" }), undefined, { type: "series", id: "tt9:1:2" });
  });

  it("hands an addon row to the alternative playback with the title's own catalogue key", async () => {
    identityHandler = boundMovie;
    copies = oneNative;
    providers = () => json([{ key: "torrentio", name: "Torrentio" }]);
    addonStreams = () => json([addonRow("addon-1", "Torrentio 4K")]);
    const onPlayAlternative = vi.fn();
    const { onPlay } = await render(folder(), { onPlayAlternative });
    await openPicker();
    await click(rows().find((row) => row.textContent?.includes("Torrentio"))!);
    await flush();
    await click(host.querySelector(".library-detail-play button.primary"));
    expect(onPlay).not.toHaveBeenCalled();
    expect(onPlayAlternative).toHaveBeenCalledWith(expect.objectContaining({
      stream: expect.objectContaining({ sourceId: "addon-1" }),
      catalogue: { type: "movie", id: "tt1" },
      media: expect.objectContaining({ kind: "movie", id: "tt1", metaType: "movie" }),
      kind: "movie",
    }));
  });

  it("hands another library's copy on as that copy, with the title's own subject", async () => {
    identityHandler = boundMovie;
    copies = oneNative;
    remoteLibraries = () => json({ libraries: [remoteLibrary("rlib_b", "Second")] });
    remoteMatches = () => json({ streams: [otherCopy("rlib_b", "9")] });
    const onPlayAlternative = vi.fn();
    const onSaveAlternative = vi.fn();
    const { onPlay } = await render(folder(), { onPlayAlternative, onSaveAlternative });
    await openPicker();
    await click(rows().find((row) => row.textContent?.includes("Other copy"))!);
    await flush();
    await click(host.querySelector(".library-detail-play button.primary"));
    expect(onPlay).not.toHaveBeenCalled();
    expect(onPlayAlternative).toHaveBeenCalledWith(expect.objectContaining({
      stream: expect.objectContaining({ sourceId: "src-rlib_b", remoteItem: expect.objectContaining({ libraryId: "rlib_b", itemId: "9", mediaSourceId: "msX" }) }),
      media: expect.objectContaining({ kind: "movie", id: "tt1", metaType: "movie" }),
      kind: "movie",
    }));
    // The copy the viewer proved may be copied is offered the action, and it queues that exact copy.
    const save = () => [...host.querySelectorAll<HTMLButtonElement>(".library-detail-actions button")].find((button) => button.textContent?.includes("To library"))!;
    expect(save().disabled).toBe(false);
    await click(save());
    expect(onSaveAlternative).toHaveBeenCalledWith(expect.objectContaining({
      stream: expect.objectContaining({ sourceId: "src-rlib_b" }),
      media: expect.objectContaining({ kind: "movie", id: "tt1", metaType: "movie" }),
      kind: "movie",
    }));
  });

  it("offers nothing to queue for a copy the server never proved, and never for its own file", async () => {
    identityHandler = boundMovie;
    copies = oneNative;
    remoteLibraries = () => json({ libraries: [remoteLibrary("rlib_b", "Second")] });
    remoteMatches = () => json({ streams: [otherCopy("rlib_b", "9")] });
    // The server reports no native download right for this source: the action is not offered.
    const refused: Stream = { ...otherCopy("rlib_b", "9"), capabilities: { rename: false, move: false, delete: false, identify: false, writeArtwork: false, downloadToLibrary: false, downloadToDevice: false } };
    remoteMatches = () => json({ streams: [refused] });
    const onSaveAlternative = vi.fn();
    await render(folder(), { onSaveAlternative });
    const save = () => [...host.querySelectorAll<HTMLButtonElement>(".library-detail-actions button")].find((button) => button.textContent?.includes("To library"))!;
    expect(save().disabled).toBe(true);
    await openPicker();
    await click(rows().find((row) => row.textContent?.includes("Other copy"))!);
    await flush();
    expect(save().disabled).toBe(true);
    await click(save());
    expect(onSaveAlternative).not.toHaveBeenCalled();
  });

  it("offers a copy of an addon row, and never one of the library's own file", async () => {
    identityHandler = boundMovie;
    copies = oneNative;
    providers = () => json([{ key: "torrentio", name: "Torrentio" }]);
    addonStreams = () => json([addonRow("addon-1", "Torrentio 4K")]);
    const onSaveAlternative = vi.fn();
    await render(folder(), { onSaveAlternative });
    const save = () => [...host.querySelectorAll<HTMLButtonElement>(".library-detail-actions button")].find((button) => button.textContent?.includes("To library"))!;
    // The library's own file is never offered a copy of itself.
    expect(save().disabled).toBe(true);
    await openPicker();
    await click(rows().find((row) => row.textContent?.includes("Torrentio"))!);
    await flush();
    expect(save().disabled).toBe(false);
    await click(save());
    expect(onSaveAlternative).toHaveBeenCalledWith(expect.objectContaining({
      stream: expect.objectContaining({ sourceId: "addon-1" }),
      media: expect.objectContaining({ kind: "movie", id: "tt1" }),
    }));
  });

  it("reads, plays and clears another library's copy through that copy's own store", async () => {
    identityHandler = boundMovie;
    copies = oneNative;
    remoteLibraries = () => json({ libraries: [remoteLibrary("rlib_b", "Second")] });
    remoteMatches = () => json({ streams: [otherCopy("rlib_b", "9")] });
    // The store names the version its position belongs to; the copy on screen played that one.
    remoteState = (_url, init) => init?.method === "PATCH"
      ? json({ key: "k", position: 0, duration: 0, favorite: false, watched: false })
      : json({ key: "k", position: 600, duration: 3600, favorite: false, watched: false, mediaSourceId: "msX" });
    const onPlayAlternative = vi.fn();
    await render(folder(), { onPlayAlternative });
    // Only the detail's own row was read from the file store; selecting the copy adds no read of it.
    const ownReads = calls.progress.length;
    await openPicker();
    await click(rows().find((row) => row.textContent?.includes("Other copy"))!);
    await flush();
    expect(calls.remoteState.map((url) => url.pathname)).toEqual(["/api/remote-libraries/rlib_b/items/9/state"]);
    expect(host.querySelector(".library-detail-progress span")!.textContent).toBe("10:00 of 1:00:00");
    expect(calls.progress).toHaveLength(ownReads);
    await click(host.querySelector(".library-detail-play button.primary"));
    expect(onPlayAlternative).toHaveBeenCalledWith(expect.objectContaining({ stream: expect.objectContaining({ sourceId: "src-rlib_b" }) }));
    await click(host.querySelector(".library-detail-progress button")!);
    await flush();
    expect(calls.remoteWrites).toEqual([{ position: 0, duration: 0, mediaSourceId: "msX" }]);
    expect(host.querySelector(".library-detail-progress")).toBeNull();
  });
});
