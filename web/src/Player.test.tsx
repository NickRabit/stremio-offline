import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Player } from "./Player";
import { setLocale } from "./i18n";
import type { RemoteCapabilities, Stream } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const rights = (over: Partial<RemoteCapabilities> = {}): RemoteCapabilities => ({
  rename: false, move: false, delete: false, identify: false, writeArtwork: false,
  downloadToLibrary: false, downloadToDevice: false, ...over,
});
const session = () => ({
  id: "sess1", mode: "direct", url: "/api/stream/sess1", offset: 0, duration: 3600, hardware: false,
  acceleration: false, audioTracks: [], subtitleTracks: [], audioTrack: 0, subtitleTrack: null, quality: null,
});

/** A version a media server owns: its own provider, its own incoming context, its own rights. */
const remoteVersion = (over: Partial<Stream> = {}): Stream => ({
  sourceId: "src-ms1", kind: "remote", playable: true, name: "1080p", provider: "jellyfin",
  remoteItem: { libraryId: "rlib_a", itemId: "1", mediaSourceId: "ms1", progressKey: "k" }, ...over,
});
/** An addon answer: no provider, no capabilities, no remote context. */
const addonRow = (over: Partial<Stream> = {}): Stream =>
  ({ sourceId: "addon-1", kind: "remote", playable: true, name: "4K", addonKey: "torrentio", addonName: "Torrentio", ...over });
/** A file of the viewer's own library: already here, so it is never queued as a copy. */
const ownFile = (over: Partial<Stream> = {}): Stream =>
  ({ sourceId: "local-1", kind: "library", playable: true, localPath: "Films/One.mkv", libraryName: "Films", ...over });

let root: Root;
let host: HTMLDivElement;
let progressPosts: Array<Record<string, unknown>>;
let remotePosts: Array<Record<string, unknown>>;
/** The answer of the next `/api/progress` write, when the test holds it open. */
let heldWrite: Promise<Response> | null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  // The player measures its control bar and its viewport; jsdom ships neither.
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
  progressPosts = [];
  remotePosts = [];
  heldWrite = null;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;
    if (path === "/api/playback" && init?.method === "POST") return Promise.resolve(json(session()));
    if (/^\/api\/playback\/[^/]+$/.test(path) && init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
    if (/^\/api\/playback\/[^/]+\/ping$/.test(path)) return Promise.resolve(new Response(null, { status: 204 }));
    if (path === "/api/progress" && init?.method === "POST") {
      progressPosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return heldWrite ? heldWrite : Promise.resolve(new Response(null, { status: 204 }));
    }
    if (/^\/api\/remote-libraries\/[^/]+\/items\/[^/]+\/state$/.test(path) && init?.method === "PATCH") {
      remotePosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path.startsWith("/api/progress")) return Promise.resolve(json(null));
    return Promise.resolve(json(null));
  }));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { await new Promise((done) => setTimeout(done, 0)); });
const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click(); }); await flush(); };
/** The two save actions sit in the player's settings panel, so every assertion is made with it open. */
const openSettings = async () => {
  if (!host.querySelector("#player-settings")) await click(host.querySelector(".player-settings-toggle")!);
};
const actions = () => [...host.querySelectorAll<HTMLButtonElement>(".player-action")];
const action = (label: string) => actions().find((node) => node.textContent?.includes(label)) ?? null;

const props = (over: Partial<Parameters<typeof Player>[0]> = {}) => ({
  open: true, title: "One", stream: addonRow(), subtitles: [], subtitleLanguage: "en", audioLanguage: "en",
  onDownload: vi.fn(async () => true), onDeviceDownload: vi.fn(async () => true), onClose: vi.fn(), ...over,
});

const render = async (over: Partial<Parameters<typeof Player>[0]> = {}) => {
  const value = props(over);
  await act(async () => { root.render(<Player {...value}/>); });
  await flush();
  return value;
};
const rerender = async (over: Partial<Parameters<typeof Player>[0]>) => {
  const value = props(over);
  await act(async () => { root.render(<Player {...value}/>); });
  await flush();
  return value;
};

describe("Player save actions", () => {
  it("offers the library save for a media server's version only where the server proved the right", async () => {
    const proved = await render({ stream: remoteVersion({ capabilities: rights({ downloadToLibrary: true }) }) });
    await openSettings();
    expect(action("To library")).not.toBeNull();
    await click(action("To library")!);
    expect(proved.onDownload).toHaveBeenCalledTimes(1);
    // A refused version and one whose rights the server never sent are both denied, and neither
    // reaches the device: a copy another media server owns is never pulled down from the player.
    await rerender({ stream: remoteVersion({ capabilities: rights({ downloadToLibrary: false }) }) });
    await openSettings();
    expect(action("To library")).toBeNull();
    expect(action("To device")).toBeNull();
    await rerender({ stream: remoteVersion() });
    await openSettings();
    expect(action("To library")).toBeNull();
    expect(action("To device")).toBeNull();
  });

  it("keeps the policy around it: a local file is never queued as a copy, a generic answer is offered both", async () => {
    await render({ stream: ownFile() });
    await openSettings();
    expect(action("To library")).toBeNull();
    const device = action("To device");
    expect(device).not.toBeNull();
    await click(device!);
    await rerender({ stream: addonRow() });
    await openSettings();
    // An addon answer keeps the catalogue's own policy: offered unless it said otherwise.
    expect(action("To library")).not.toBeNull();
    expect(action("To device")).not.toBeNull();
    await rerender({ stream: addonRow({ capabilities: rights({ downloadToLibrary: false, downloadToDevice: false }) }) });
    await openSettings();
    expect(action("To library")).toBeNull();
    expect(action("To device")).toBeNull();
  });
});

describe("Player progress reporting", () => {
  it("names the played row only once its final write landed, never while it is still out", async () => {
    let release!: (response: Response) => void;
    heldWrite = new Promise<Response>((resolve) => { release = resolve; });
    const onProgressSaved = vi.fn();
    await render({ stream: addonRow(), progressKey: "movie:tt5000", onProgressSaved });
    const video = host.querySelector<HTMLVideoElement>(".player-overlay video")!;
    await act(async () => { video.currentTime = 120; video.dispatchEvent(new Event("timeupdate", { bubbles: true })); });
    // The overlay closes while the write is still out; the store is refreshed only after it lands.
    await rerender({ stream: addonRow(), progressKey: "movie:tt5000", onProgressSaved, open: false });
    expect(progressPosts).toEqual([expect.objectContaining({ key: "movie:tt5000", position: 120, duration: 3600 })]);
    expect(onProgressSaved).not.toHaveBeenCalled();
    await act(async () => { release(new Response(null, { status: 204 })); });
    await flush();
    expect(onProgressSaved).toHaveBeenCalledTimes(1);
    expect(onProgressSaved).toHaveBeenCalledWith("movie:tt5000");
  });

  it("names the media source itself for a remote version, so another version's store is never refreshed", async () => {
    const onProgressSaved = vi.fn();
    await render({ stream: remoteVersion(), onProgressSaved });
    const video = host.querySelector<HTMLVideoElement>(".player-overlay video")!;
    await act(async () => { video.currentTime = 400; video.dispatchEvent(new Event("timeupdate", { bubbles: true })); });
    await rerender({ stream: remoteVersion(), onProgressSaved, open: false });
    expect(remotePosts).toEqual([expect.objectContaining({ position: 400, duration: 3600, mediaSourceId: "ms1" })]);
    expect(onProgressSaved).toHaveBeenCalledWith("remote:rlib_a\u00001\u0000ms1");
  });
});
