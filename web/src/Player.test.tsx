import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Player } from "./Player";
import type { PlayerSources } from "./Player";
import { setLocale } from "./i18n";
import type { LibrarySourceGroup } from "./library-sources";
import type { RemoteCapabilities, Stream } from "./types";

const hlsMock = vi.hoisted(() => {
  type Listener = (event: string, data: unknown) => void;
  class FakeHls {
    static Events = { MANIFEST_PARSED: "manifestParsed", ERROR: "error", FRAG_BUFFERED: "fragBuffered", DESTROYING: "destroying" };
    static ErrorTypes = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError" };
    static isSupported = () => true;
    listeners = new Map<string, Listener[]>();
    startLoadCalls = 0;
    recoverMediaErrorCalls = 0;
    destroyed = false;
    on(event: string, listener: Listener) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    }
    loadSource() {}
    attachMedia() {}
    startLoad() { this.startLoadCalls += 1; }
    recoverMediaError() { this.recoverMediaErrorCalls += 1; }
    destroy() { this.destroyed = true; }
    emit(event: string, data: unknown) {
      for (const listener of this.listeners.get(event) ?? []) listener(event, data);
    }
  }
  const instances: FakeHls[] = [];
  const Hls = class extends FakeHls {
    constructor() {
      super();
      instances.push(this);
    }
  };
  const mock = {
    FakeHls: Hls,
    instances,
    enabled: false,
    reset() { instances.length = 0; mock.enabled = false; },
  };
  return mock;
});

vi.mock("./hls-loader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hls-loader")>();
  const fake = hlsMock.FakeHls as unknown as typeof import("hls.js").default;
  return {
    ...actual,
    hlsIfLoaded: () => hlsMock.enabled ? fake : actual.hlsIfLoaded(),
    loadHls: async () => hlsMock.enabled ? fake : actual.loadHls(),
  };
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const rights = (over: Partial<RemoteCapabilities> = {}): RemoteCapabilities => ({
  rename: false, move: false, delete: false, identify: false, writeArtwork: false,
  downloadToLibrary: false, downloadToDevice: false, ...over,
});
/** What the next `/api/playback` start answers beyond the defaults. */
let sessionShape: Record<string, unknown> = {};
const session = () => ({
  id: "sess1", mode: "direct", url: "/api/stream/sess1", offset: 0, duration: 3600, hardware: false,
  acceleration: false, audioTracks: [], subtitleTracks: [], audioTrack: 0, subtitleTrack: null, quality: null,
  ...sessionShape,
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
let playbackReports: Array<Record<string, unknown>>;
let playbackStatusRequests: string[];
let playbackStatusAnswer: unknown;
let seekRequests: Array<{ path: string; time: number }>;
let seekGone: boolean;
let pingRequests: string[];
let pingBodies: unknown[];
let pingStatus: number;
let pingBody: unknown;
/** Every segment lookup sent for the playback on screen. */
let introRequests: string[];
/** What the next segment lookup answers. */
let introAnswer: unknown;
/** Every generic key the player read, and what each one holds. */
let progressReads: string[];
let progressAnswers: Record<string, unknown>;
/** Every media-server state route the player touched, and what its own item holds. */
let remoteReads: string[];
let remoteAnswers: Record<string, unknown>;
/** Every playback session started, so the position it resumed from can be read back. */
let playbackPosts: Array<Record<string, unknown>>;
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
  // jsdom ships no `HTMLTrackElement.track`, and the player mirrors the element's own track.
  Object.defineProperty(HTMLTrackElement.prototype, "track", {
    configurable: true,
    get: () => ({ mode: "disabled", activeCues: null, addEventListener() {}, removeEventListener() {} }),
  });
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => undefined;
  HTMLMediaElement.prototype.load = () => undefined;
  progressPosts = [];
  remotePosts = [];
  playbackReports = [];
  playbackStatusRequests = [];
  playbackStatusAnswer = { generation: 1, conversion: "running" };
  seekRequests = [];
  seekGone = false;
  pingRequests = [];
  pingBodies = [];
  pingStatus = 204;
  pingBody = null;
  introRequests = [];
  introAnswer = {};
  progressReads = [];
  progressAnswers = {};
  remoteReads = [];
  remoteAnswers = {};
  playbackPosts = [];
  heldWrite = null;
  sessionShape = {};
  hlsMock.reset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;
    if (path === "/api/playback" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      playbackPosts.push(body);
      return Promise.resolve(json(session()));
    }
    if (/^\/api\/playback\/[^/]+$/.test(path) && init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
    if (/^\/api\/playback\/[^/]+\/ping$/.test(path)) {
      pingRequests.push(path);
      pingBodies.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown);
      return Promise.resolve(pingStatus === 204 ? new Response(null, { status: 204 }) : json(pingBody, pingStatus));
    }
    if (/^\/api\/playback\/[^/]+\/status$/.test(path)) {
      playbackStatusRequests.push(path.slice("/api/playback/".length, -"/status".length));
      return Promise.resolve(json(playbackStatusAnswer));
    }
    if (/^\/api\/playback\/[^/]+\/seek$/.test(path) && init?.method === "POST") {
      const time = Number((JSON.parse(String(init.body)) as { time?: number }).time);
      seekRequests.push({ path, time });
      if (seekGone) return Promise.resolve(json({ error: "gone", code: "RESOURCE_NOT_FOUND", messageKey: "err.playbackSessionGone" }, 404));
      return Promise.resolve(json({ ...session(), offset: time }));
    }
    if (/^\/api\/progress\/[^/]+$/.test(path)) {
      const key = decodeURIComponent(path.slice("/api/progress/".length));
      progressReads.push(key);
      return Promise.resolve(json(progressAnswers[key] ?? null));
    }
    if (path === "/api/progress" && init?.method === "POST") {
      progressPosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return heldWrite ? heldWrite : Promise.resolve(new Response(null, { status: 204 }));
    }
    if (/^\/api\/remote-libraries\/[^/]+\/items\/[^/]+\/state$/.test(path)) {
      remoteReads.push(path);
      if (init?.method === "PATCH") {
        remotePosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(json(remoteAnswers[path] ?? null));
    }
    if (/^\/api\/remote-libraries\/[^/]+\/items\/[^/]+\/playing$/.test(path) && init?.method === "POST") {
      playbackReports.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path === "/api/intro-segments") {
      introRequests.push(`${path}${url.search}`);
      return Promise.resolve(json(introAnswer));
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

describe("Player source switching", () => {
  const sourceButton = () => host.querySelector<HTMLButtonElement>(".player-sources-toggle");
  const sourceRows = () => [...host.querySelectorAll<HTMLButtonElement>("#player-sources button")].filter((node) => node.getAttribute("aria-pressed") !== null);
  /** One group of the title, as `useLibrarySources` hands it to the player: an addon's answer. */
  const addonGroup = (key: string, name: string, streams: Stream[]): LibrarySourceGroup =>
    ({ key: `addon:${key}`, kind: "addon", name, status: "loaded", streams, error: "" });
  /** What a host hands the player: the row it leads with and the actions over the list. */
  const sourcesOf = (lead: Stream, groups: LibrarySourceGroup[] = [], over: Partial<PlayerSources> = {}): PlayerSources =>
    ({ lead: [lead], leadLabel: "Local files", groups, onOpen: vi.fn(), onSwitch: vi.fn(async () => undefined), ...over });

  it("offers no Sources control for a title whose sources were never handed over", async () => {
    await render();
    expect(sourceButton()).toBeNull();
    expect(host.querySelector("#player-sources")).toBeNull();
  });

  it("narrows the list with the detail's own source menu, the playing row still first", async () => {
    const playing = ownFile({ sourceId: "local-1" });
    const torrentio = addonRow({ sourceId: "addon-1", name: "4K" });
    const other = addonRow({ sourceId: "addon-2", name: "1080p", addonKey: "cinema", addonName: "Cinema" });
    await render({ stream: playing, sources: sourcesOf(playing, [addonGroup("torrentio", "Torrentio", [torrentio]), addonGroup("cinema", "Cinema", [other])]) });
    await click(sourceButton()!);
    const selects = host.querySelectorAll<HTMLSelectElement>("#player-sources select");
    expect(selects.length).toBeGreaterThanOrEqual(2);
    expect(sourceRows()).toHaveLength(3);
    expect(sourceRows()[0]!.getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(selects[0], "addon:cinema");
      selects[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(sourceRows()).toHaveLength(1);
    expect(sourceRows()[0]!.textContent).toContain("1080p");
  });

  it("reads the list on open, marks the playing row and hands another one over with the time", async () => {
    const playing = addonRow({ sourceId: "addon-1", name: "4K", behaviorHints: { videoSize: 8_000_000_000 } });
    const other = addonRow({ sourceId: "addon-2", name: "1080p" });
    const onOpen = vi.fn();
    const onSwitch = vi.fn(async () => undefined);
    await render({ stream: playing, sources: sourcesOf(playing, [addonGroup("cinema", "Cinema", [other])], { onOpen, onSwitch }) });
    // Nothing is asked for while the title is merely playing: the panel is the one intent.
    expect(onOpen).not.toHaveBeenCalled();
    await click(sourceButton()!);
    expect(onOpen).toHaveBeenCalledTimes(1);
    // The player's list is the detail's own row template: the transport badge, the label and the
    // size the source reported, the playing row first.
    expect(sourceRows()).toHaveLength(2);
    expect(sourceRows()[0]!.querySelector("i")!.textContent).toBe("HTTP");
    expect(sourceRows()[0]!.textContent).toContain("4K");
    expect(sourceRows()[0]!.textContent).toContain("8.0 GB");
    expect(sourceRows()[1]!.textContent).toContain("1080p");
    expect(sourceRows()[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(sourceRows()[1]!.getAttribute("aria-pressed")).toBe("false");
    // The row already on screen is not a switch, whatever the click says.
    await click(sourceRows()[0]!);
    expect(onSwitch).not.toHaveBeenCalled();
    expect(host.querySelector("#player-sources")).not.toBeNull();
    const video = host.querySelector<HTMLVideoElement>(".player-overlay video")!;
    await act(async () => { video.currentTime = 620; video.dispatchEvent(new Event("timeupdate", { bubbles: true })); });
    await click(sourceRows()[1]!);
    // The position the row was chosen at travels with it, so the new source starts there.
    expect(onSwitch).toHaveBeenCalledWith(other, 620);
    expect(host.querySelector("#player-sources")).toBeNull();

    // Another source on screen reopens on the row that now plays, and the host reads nothing
    // again for it: the groups arrive as props.
    await click(sourceButton()!);
    await rerender({ stream: other, sources: sourcesOf(other, [addonGroup("cinema", "Cinema", [other])], { onOpen, onSwitch }) });
    await click(sourceButton()!);
    expect(sourceRows()[0]!.textContent).toContain("1080p");
    expect(sourceRows()[0]!.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the list open with the failure and leaves the playing row alone when the switch is refused", async () => {
    const playing = addonRow({ sourceId: "addon-1", name: "4K" });
    const other = addonRow({ sourceId: "addon-2", name: "1080p" });
    const onSwitch = vi.fn(async () => { throw new Error("that source is gone"); });
    await render({ stream: playing, sources: sourcesOf(playing, [addonGroup("cinema", "Cinema", [other])], { onSwitch }) });
    await click(sourceButton()!);
    await click(sourceRows()[1]!);
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(host.querySelector("#player-sources")).not.toBeNull();
    expect(host.querySelector("#player-sources .notice")!.textContent).toContain("that source is gone");
    expect(sourceRows()[0]!.getAttribute("aria-pressed")).toBe("true");
  });

  /** The server answers an id it dropped the way it does once a listing is 30 minutes old. */
  const expire = (dropped: Set<string>) => {
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/playback" && init?.method === "POST" && dropped.has((JSON.parse(String(init.body)) as { sourceId: string }).sourceId)) {
        playbackPosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Promise.resolve(json({ error: "Media resource expired or unavailable. Select the source again.", code: "RESOURCE_EXPIRED" }, 410));
      }
      return base(input, init);
    }));
  };

  it("reads an expired row's group again and switches to the same row under its new id, once", async () => {
    const playing = addonRow({ sourceId: "addon-1", name: "4K" });
    const other = addonRow({ sourceId: "addon-2", name: "1080p", stableKey: "cinema-1080p" });
    const fresh = addonRow({ sourceId: "addon-2b", name: "1080p", stableKey: "cinema-1080p" });
    expire(new Set(["addon-2", "addon-2b"]));
    const group = addonGroup("cinema", "Cinema", [other]);
    const refind = vi.fn(async () => fresh);
    const onSwitch = vi.fn(async () => undefined);
    const sources = sourcesOf(playing, [group], { onSwitch, panel: { groups: [group], retry: vi.fn(), refind } });
    await render({ stream: playing, sources });
    await click(sourceButton()!);
    await click(sourceRows()[1]!);
    expect(onSwitch).toHaveBeenLastCalledWith(other, 0);

    // The host hands the chosen row over; the server has already dropped its id.
    await rerender({ stream: other, startAtSeconds: 0, sources });
    await flush();
    expect(refind).toHaveBeenCalledWith(other);
    expect(onSwitch).toHaveBeenLastCalledWith(fresh, 0);
    expect(host.querySelector(".player-error, [role=alert]")).toBeNull();

    // The new id is refused too: nothing is read a second time, and the failure is shown.
    await rerender({ stream: fresh, startAtSeconds: 0, sources });
    await flush();
    expect(refind).toHaveBeenCalledTimes(1);
    expect(onSwitch).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("Select the source again");
  });

  it("shows the refusal when the expired row's group no longer lists it", async () => {
    const playing = addonRow({ sourceId: "addon-1", name: "4K" });
    const other = addonRow({ sourceId: "addon-2", name: "1080p" });
    expire(new Set(["addon-2"]));
    const group = addonGroup("cinema", "Cinema", [other]);
    const refind = vi.fn(async () => null);
    const onSwitch = vi.fn(async () => undefined);
    const sources = sourcesOf(playing, [group], { onSwitch, panel: { groups: [group], retry: vi.fn(), refind } });
    await render({ stream: playing, sources });
    await click(sourceButton()!);
    await click(sourceRows()[1]!);
    await rerender({ stream: other, startAtSeconds: 0, sources });
    await flush();
    expect(refind).toHaveBeenCalledTimes(1);
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Select the source again");
  });

  it("re-reads stale groups each time the Sources panel opens", async () => {
    const playing = addonRow({ sourceId: "addon-1", name: "4K" });
    const renew = vi.fn();
    const group = addonGroup("cinema", "Cinema", [addonRow({ sourceId: "addon-2" })]);
    await render({ stream: playing, sources: sourcesOf(playing, [group], { panel: { groups: [group], retry: vi.fn(), renew } }) });
    await click(sourceButton()!);
    expect(renew).toHaveBeenCalledTimes(1);
    await click(sourceButton()!);
    await click(sourceButton()!);
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it("keeps the lead row alone for a play nothing names, and asks no group for it", async () => {
    const loose = ownFile({ sourceId: "local-9", localPath: "Films/Loose.mkv", behaviorHints: { filename: "Loose.mkv" } });
    const onOpen = vi.fn();
    await render({ stream: loose, sources: sourcesOf(loose, [], { onOpen }) });
    await click(sourceButton()!);
    expect(onOpen).toHaveBeenCalledTimes(1);
    // The control is there, and the only row it holds is the file on screen, already marked.
    expect(sourceRows()).toHaveLength(1);
    expect(sourceRows()[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(sourceRows()[0]!.textContent).toContain("Loose.mkv");
  });

  it("shows a failed group with its own retry, asking that group again", async () => {
    const playing = addonRow({ sourceId: "addon-1", name: "4K" });
    const retry = vi.fn();
    const failed: LibrarySourceGroup = { key: "addon:cinema", kind: "addon", name: "Cinema", status: "error", streams: [], error: "Cinema is down" };
    await render({ stream: playing, sources: sourcesOf(playing, [failed], { panel: { groups: [failed], retry } }) });
    await click(sourceButton()!);
    const notice = host.querySelector<HTMLElement>("#player-sources .notice")!;
    expect(notice.textContent).toContain("Cinema is down");
    await click(notice.querySelector("button")!);
    expect(retry).toHaveBeenCalledWith("addon:cinema");
  });
});

describe("Player track preferences across a switch", () => {
  const subtitleSelect = () => host.querySelector<HTMLSelectElement>('select[aria-label="Subtitles"]');
  const choose = async (value: string) => {
    await act(async () => {
      const select = subtitleSelect()!;
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
  };

  it("keeps subtitles off across a switch whose own list carries the account's language", async () => {
    const playing = addonRow({ sourceId: "addon-1", subtitles: [{ subtitleId: "a1", lang: "en" }] });
    const other = addonRow({ sourceId: "addon-2", subtitles: [] });
    await render({ stream: playing, subtitles: [], subtitleLanguage: "en" });
    await openSettings();
    expect(subtitleSelect()!.value).toBe("addon:0");
    await choose("off");
    // The viewer said no; the other source's own list is not a reason to say yes.
    await rerender({ stream: other, subtitles: [{ subtitleId: "b1", lang: "en" }], subtitleLanguage: "en" });
    await openSettings();
    expect(subtitleSelect()!.value).toBe("off");
    expect(playbackPosts[1]!.subtitleLanguage).toBe(null);
  });

  it("picks the chosen language out of the switched-to source's own list", async () => {
    const playing = addonRow({ sourceId: "addon-1", subtitles: [{ subtitleId: "a1", lang: "cs" }] });
    const other = addonRow({ sourceId: "addon-2", subtitles: [] });
    await render({ stream: playing, subtitles: [], subtitleLanguage: "en" });
    await openSettings();
    await choose("addon:0");
    await rerender({ stream: other, subtitles: [{ subtitleId: "b1", lang: "en" }, { subtitleId: "b2", lang: "cs" }], subtitleLanguage: "en" });
    await openSettings();
    expect(subtitleSelect()!.value).toBe("addon:1");
  });
});

describe("Player progress reporting", () => {
  it("reports a remote original's start, pause and close to the media server", async () => {
    await render({ stream: remoteVersion() });
    expect(playbackReports).toEqual([expect.objectContaining({ mediaSourceId: "ms1", paused: true, event: "start" })]);
    const playId = playbackReports[0]!.playId;
    expect(playId).toMatch(/^[0-9a-f]{32}$/);
    const video = host.querySelector<HTMLVideoElement>(".player-overlay video")!;
    await act(async () => { video.dispatchEvent(new Event("play", { bubbles: true })); });
    await flush();
    await act(async () => { video.dispatchEvent(new Event("pause", { bubbles: true })); });
    await flush();
    expect(playbackReports.at(-1)).toEqual(expect.objectContaining({ mediaSourceId: "ms1", paused: true, event: "progress", playId }));
    await rerender({ stream: remoteVersion(), open: false });
    expect(playbackReports.at(-1)).toEqual(expect.objectContaining({ mediaSourceId: "ms1", event: "stop", playId }));
  });

  it("gives a reopened remote play a new id and stops the old play with the old id", async () => {
    await render({ stream: remoteVersion() });
    const oldPlayId = playbackReports[0]!.playId;
    await rerender({ stream: remoteVersion(), open: false });
    const oldStop = playbackReports.at(-1)!;
    expect(oldStop).toEqual(expect.objectContaining({ event: "stop", playId: oldPlayId }));

    await rerender({ stream: remoteVersion(), open: true });
    const reopened = [...playbackReports].reverse().find((entry) => entry.event === "start")!;
    expect(reopened.playId).toMatch(/^[0-9a-f]{32}$/);
    expect(reopened.playId).not.toBe(oldPlayId);
  });

  it("sends no media-server playback reports without a remote item", async () => {
    await render({ stream: addonRow(), progressKey: "movie:tt5000" });
    expect(playbackReports).toEqual([]);
    await rerender({ stream: addonRow(), progressKey: "movie:tt5000", open: false });
    expect(playbackReports).toEqual([]);
  });

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

  it("plays and reports a remote version under the title's key it was handed", async () => {
    const onProgressSaved = vi.fn();
    progressAnswers["movie:tt5000"] = { key: "movie:tt5000", position: 300, duration: 3600, title: "One", updatedAt: "2026-01-01T00:00:00.000Z" };
    await render({ stream: remoteVersion(), progressKey: "movie:tt5000", onProgressSaved });
    // The title's own row is what the version resumes from; its own store is not consulted.
    expect(progressReads).toEqual(["movie:tt5000"]);
    expect(remoteReads).toEqual([]);
    expect(playbackPosts[0]!.time).toBe(300);

    const video = host.querySelector<HTMLVideoElement>(".player-overlay video")!;
    await act(async () => { video.currentTime = 400; video.dispatchEvent(new Event("timeupdate", { bubbles: true })); });
    await rerender({ stream: remoteVersion(), progressKey: "movie:tt5000", onProgressSaved, open: false });
    expect(progressPosts).toEqual([expect.objectContaining({
      key: "movie:tt5000", position: 400, duration: 3600,
      remote: { libraryId: "rlib_a", itemId: "1", mediaSourceId: "ms1" },
    })]);
    // The position is written to the title, not to the version's own store.
    expect(remotePosts).toEqual([]);
    expect(onProgressSaved).toHaveBeenCalledWith("movie:tt5000");
  });

  it("keeps the media-source guard off a title's row and on the version's own", async () => {
    // The title's row names no media source at all: it is the film's position, so it is resumed.
    progressAnswers["movie:tt5000"] = { key: "movie:tt5000", position: 300, duration: 3600, title: "One", updatedAt: "2026-01-01T00:00:00.000Z" };
    await render({ stream: remoteVersion(), progressKey: "movie:tt5000" });
    expect(playbackPosts[0]!.time).toBe(300);

    // Nothing under the title's key yet: the version's own row stands in, as it did before the title
    // held the position, and only while it names the very media source about to play.
    delete progressAnswers["movie:tt5000"];
    const statePath = "/api/remote-libraries/rlib_a/items/1/state";
    remoteAnswers[statePath] = { key: "k", position: 300, duration: 3600, favorite: false, watched: false, mediaSourceId: "ms1" };
    await render({ stream: remoteVersion({ sourceId: "src-ms1b" }), progressKey: "movie:tt5000" });
    expect(remoteReads).toContain(statePath);
    expect(playbackPosts[1]!.time).toBe(300);

    remoteAnswers[statePath] = { key: "k", position: 900, duration: 3600, favorite: false, watched: false, mediaSourceId: "msOther" };
    await render({ stream: remoteVersion({ sourceId: "src-ms1c" }), progressKey: "movie:tt5000" });
    // Another version's own position is not this one's.
    expect(playbackPosts[2]!.time).toBe(0);
  });

  it("stores the position with the source on screen, the one a switch moved to included", async () => {
    const file = ownFile({ stableKey: `f:${"3".repeat(24)}` });
    const other = addonRow({ sourceId: "addon-2", name: "4K", stableKey: `a:${"2".repeat(24)}` });
    await render({ stream: file, progressKey: "movie:tt5000" });
    const video = host.querySelector<HTMLVideoElement>(".player-overlay video")!;
    await act(async () => { video.currentTime = 120; video.dispatchEvent(new Event("timeupdate", { bubbles: true })); });
    // The source changes while the key does not: the write that lands next names the row that is
    // really playing, and no longer the file it was switched away from.
    await rerender({ stream: other, progressKey: "movie:tt5000" });
    // The switched-to source runs its own session; what is written next is where it got to.
    await act(async () => { video.currentTime = 120; video.dispatchEvent(new Event("timeupdate", { bubbles: true })); });
    await rerender({ stream: other, progressKey: "movie:tt5000", open: false });
    expect(progressPosts).toEqual([
      expect.objectContaining({ key: "movie:tt5000", position: 120, stableKey: file.stableKey, path: file.localPath }),
      expect.objectContaining({ key: "movie:tt5000", position: 120, duration: 3600, stableKey: other.stableKey }),
    ]);
    expect(progressPosts[1]).not.toHaveProperty("path");
  });

  it("names the file a library row plays from, beside the source's own handle", async () => {
    const file = ownFile({ stableKey: `f:${"3".repeat(24)}` });
    await render({ stream: file, progressKey: "movie:tt5000" });
    const video = host.querySelector<HTMLVideoElement>(".player-overlay video")!;
    await act(async () => { video.currentTime = 120; video.dispatchEvent(new Event("timeupdate", { bubbles: true })); });
    await rerender({ stream: file, progressKey: "movie:tt5000", open: false });
    expect(progressPosts).toEqual([expect.objectContaining({ stableKey: file.stableKey, path: "Films/One.mkv" })]);
  });
});

describe("Player stall advice", () => {
  /** Three `waiting` events at one position of the current stream, as Chrome raises them. */
  const stallAt = async (seconds: number) => {
    const video = host.querySelector("video")!;
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => seconds, set: () => undefined });
    for (let i = 0; i < 3; i += 1) await act(async () => { video.dispatchEvent(new Event("waiting")); });
    await flush();
  };
  const hint = () => [...host.querySelectorAll(".player-hint button")].find((node) => node.textContent?.startsWith("Drop to")) ?? null;
  // jsdom plays no HLS; a browser that plays it natively takes the playlist as the video's source.
  beforeEach(() => {
    const native = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = (type: string) => /mpegurl/i.test(type) ? "maybe" : "";
    return () => { HTMLMediaElement.prototype.canPlayType = native; };
  });

  it("does not offer a lower quality for hiccups inside a conversion's first two segments", async () => {
    sessionShape = { mode: "transcode", url: "/api/playback/sess1/1/master.m3u8", acceleration: true };
    await render();
    await stallAt(1.9);
    expect(hint()).toBeNull();
  });

  /** One stall at `seconds` that either resumes before the grace is over or never does. */
  const earlyStall = async (seconds: number, resumes: boolean) => {
    const video = host.querySelector("video")!;
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => seconds, set: () => undefined });
    await act(async () => { video.dispatchEvent(new Event("waiting")); });
    if (resumes) await act(async () => { vi.advanceTimersByTime(800); video.dispatchEvent(new Event("playing")); });
    await act(async () => { vi.advanceTimersByTime(2_500); });
  };

  it("counts an early stall that does not resume, so a link that cannot deliver is still advised", async () => {
    sessionShape = { mode: "transcode", url: "/api/playback/sess1/1/master.m3u8", acceleration: true };
    await render();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      for (let i = 0; i < 3; i += 1) await earlyStall(1.9, false);
      expect(hint()).not.toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("does not count early stalls that resume within the grace", async () => {
    sessionShape = { mode: "transcode", url: "/api/playback/sess1/1/master.m3u8", acceleration: true };
    await render();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      for (let i = 0; i < 3; i += 1) await earlyStall(1.9, true);
      expect(hint()).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("drops an early stall still in its grace when the viewer seeks away", async () => {
    sessionShape = { mode: "transcode", url: "/api/playback/sess1/1/master.m3u8", acceleration: true };
    await render();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      for (let i = 0; i < 3; i += 1) {
        const video = host.querySelector("video")!;
        Object.defineProperty(video, "currentTime", { configurable: true, get: () => 1.9, set: () => undefined });
        // Converted well ahead, so the seek lands inside it and needs no restart.
        Object.defineProperty(video, "seekable", { configurable: true, get: () => ({ length: 1, start: () => 0, end: () => 120 }) });
        await act(async () => { video.dispatchEvent(new Event("waiting")); });
        await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
        await act(async () => { vi.advanceTimersByTime(2_500); });
      }
      expect(host.querySelector(".player-error")).toBeNull();
      expect(hint()).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("still offers it when a conversion keeps stalling later on", async () => {
    sessionShape = { mode: "transcode", url: "/api/playback/sess1/1/master.m3u8", acceleration: true };
    await render();
    await stallAt(12);
    expect(hint()).not.toBeNull();
  });
});

describe("Player refused direct stream", () => {
  let escalations: string[];
  /** The server forgot the session, as after a restart. */
  let escalateGone: boolean;
  beforeEach(() => {
    escalations = [];
    escalateGone = false;
    // Safari plays the escalated HLS natively.
    const native = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = (type: string) => /mpegurl/i.test(type) ? "maybe" : "";
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (/^\/api\/playback\/[^/]+\/escalate$/.test(path)) {
        escalations.push(path);
        if (escalateGone) return Promise.resolve(json({ error: "gone", code: "RESOURCE_NOT_FOUND" }, 404));
        return Promise.resolve(json({ ...session(), mode: "transcode", url: "/api/playback/sess1/2/master.m3u8" }));
      }
      return base(input, init);
    }));
    return () => { HTMLMediaElement.prototype.canPlayType = native; };
  });
  /** Safari's answer to HEVC under hev1: code 4 with no message. */
  const refuse = async (code = 4) => {
    const video = host.querySelector("video")!;
    Object.defineProperty(video, "error", { configurable: true, get: () => ({ code, message: "" }) });
    await act(async () => { video.dispatchEvent(new Event("error")); });
    await flush();
  };

  it("asks for a conversion once instead of giving up, and gives up when that is refused too", async () => {
    await render();
    await refuse();
    expect(escalations).toEqual(["/api/playback/sess1/escalate"]);
    expect(host.querySelector(".player-error")).toBeNull();
    await refuse();
    expect(escalations).toHaveLength(1);
    expect(host.querySelector(".player-error")?.textContent).toBe("The browser could not play this stream.");
  });

  it("gives up at once on a direct stream that already played", async () => {
    await render();
    await act(async () => { host.querySelector("video")!.dispatchEvent(new Event("playing")); });
    await refuse();
    expect(escalations).toEqual([]);
    expect(host.querySelector(".player-error")?.textContent).toBe("The browser could not play this stream.");
  });

  it("gives up instead of starting the refused stream again when the server forgot the session", async () => {
    escalateGone = true;
    await render();
    await refuse();
    expect(escalations).toHaveLength(1);
    expect(playbackPosts).toHaveLength(1);
    expect(host.querySelector(".player-error")?.textContent).toBe("The browser could not play this stream.");
  });
});

describe("Player lost playback session", () => {
  const gone = { error: "The playback session is gone.", code: "RESOURCE_NOT_FOUND", messageKey: "err.playbackSessionGone" };
  const flushAll = async () => { for (let i = 0; i < 4; i += 1) await flush(); };
  const at = async (seconds: number) => {
    const video = host.querySelector<HTMLVideoElement>("video")!;
    await act(async () => {
      video.currentTime = seconds;
      video.dispatchEvent(new Event("timeupdate", { bubbles: true }));
    });
    return video;
  };
  const fatalHlsError = async () => {
    const hls = hlsMock.instances.at(-1)!;
    await act(async () => {
      hls.emit("error", { fatal: true, type: "networkError", details: "manifestLoadError", response: { code: 404 } });
    });
    await flushAll();
  };

  beforeEach(() => {
    hlsMock.enabled = true;
    sessionShape = { mode: "remux", url: "/api/playback/sess1/master.m3u8", playlist: true };
    pingStatus = 404;
    pingBody = gone;
    seekGone = true;
  });

  it("restarts once when hls.js finds the server closed the session", async () => {
    await render();
    await at(42);

    await fatalHlsError();

    expect(playbackPosts).toHaveLength(2);
    expect(playbackPosts[1]!.time).toBeCloseTo(42, 1);
    expect(host.querySelector(".player-error")).toBeNull();
    expect(hlsMock.instances.at(-1)!.destroyed).toBe(false);

    await fatalHlsError();
    expect(playbackPosts).toHaveLength(2);
    expect(host.querySelector(".player-error")?.textContent).toBe("Playback failed: manifestLoadError (networkError)");
  });

  it("asks at the first segment 404 hls.js is still retrying, without waiting for it to give up", async () => {
    await render();
    await at(42);

    const hls = hlsMock.instances.at(-1)!;
    await act(async () => {
      hls.emit("error", { fatal: false, type: "networkError", details: "fragLoadError", response: { code: 404 } });
    });
    await flushAll();

    expect(playbackPosts).toHaveLength(2);
    expect(playbackPosts[1]!.time).toBeCloseTo(42, 1);
    expect(host.querySelector(".player-error")).toBeNull();
  });

  it("leaves a segment 404 of a live session to hls.js", async () => {
    pingStatus = 204;
    seekGone = false;
    await render();

    const hls = hlsMock.instances.at(-1)!;
    await act(async () => {
      hls.emit("error", { fatal: false, type: "networkError", details: "fragLoadError", response: { code: 404 } });
    });
    await flushAll();

    expect(playbackPosts).toHaveLength(1);
    expect(hls.startLoadCalls).toBe(0);
    expect(host.querySelector(".player-error")).toBeNull();
  });

  it("tells the server which position a short catch-up wait is waiting for", async () => {
    pingStatus = 204;
    seekGone = false;
    await render();
    const video = await at(5);
    Object.defineProperty(video, "seekable", {
      configurable: true,
      get: () => ({ length: 1, start: () => 0, end: () => 10 }),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        await Promise.resolve();
      });
      expect(pingRequests).toEqual(["/api/playback/sess1/ping"]);
      expect(pingBodies).toEqual([{ waitingFor: 15 }]);
      await act(async () => { vi.advanceTimersByTime(8_000); await Promise.resolve(); });
    } finally {
      vi.useRealTimers();
    }
  });

  it("still handles an ordinary fatal network error", async () => {
    await render();
    await at(42);
    const hls = hlsMock.instances.at(-1)!;
    for (let i = 0; i < 3; i += 1) {
      await act(async () => { hls.emit("error", { fatal: true, type: "networkError", details: "fragLoadTimeOut" }); });
      await flushAll();
    }
    expect(hls.startLoadCalls).toBe(2);
    expect(playbackPosts).toHaveLength(1);
    expect(host.querySelector(".player-error")?.textContent ?? "").toContain("fragLoadTimeOut");
  });

  it("still recovers a fatal media error", async () => {
    await render();
    await at(42);
    const hls = hlsMock.instances.at(-1)!;
    await act(async () => { hls.emit("error", { fatal: true, type: "mediaError", details: "bufferAppendError" }); });
    await flushAll();
    expect(hls.recoverMediaErrorCalls).toBe(1);
  });

  it("carries the chosen audio track, subtitle track and quality into the new session", async () => {
    sessionShape = { ...sessionShape, audioTracks: [{ index: 0, language: "cze" }, { index: 1, language: "eng" }], audioTrack: 1, quality: 720,
      subtitleTracks: [{ index: 0, language: "cze" }, { index: 1, language: "eng" }], subtitleTrack: 1 };
    await render();
    await at(42);

    await fatalHlsError();

    expect(playbackPosts).toHaveLength(2);
    expect(playbackPosts[1]).toMatchObject({ audioTrack: 1, quality: 720, subtitleTrack: 1 });
  });

  it("keeps hls.js retries and then fails when the session is still alive", async () => {
    pingStatus = 204;
    seekGone = false;
    await render();

    for (let i = 0; i < 3; i += 1) await fatalHlsError();

    expect(hlsMock.instances[0]!.startLoadCalls).toBe(2);
    expect(playbackPosts).toHaveLength(1);
    expect(host.querySelector(".player-error")?.textContent).toBe("Playback failed: manifestLoadError (networkError)");
  });

  it("recovers direct play once at the position, then uses the ordinary refusal", async () => {
    hlsMock.enabled = false;
    sessionShape = {};
    await render();
    const video = await at(42);
    await act(async () => { video.dispatchEvent(new Event("playing")); });
    Object.defineProperty(video, "error", { configurable: true, get: () => ({ code: 4, message: "" }) });

    await act(async () => { video.dispatchEvent(new Event("error")); });
    await flushAll();
    await act(async () => { video.dispatchEvent(new Event("loadedmetadata")); });

    expect(playbackPosts).toHaveLength(2);
    expect(playbackPosts[1]!.time).toBeCloseTo(42, 1);
    expect(video.currentTime).toBeCloseTo(42, 1);
    expect(host.querySelector(".player-error")).toBeNull();

    await act(async () => { video.dispatchEvent(new Event("error")); });
    await flushAll();
    expect(playbackPosts).toHaveLength(2);
    expect(host.querySelector(".player-error")?.textContent).toBe("The browser could not play this stream.");
  });

  it("keeps a viewer's pause across recovery from the ping loop", async () => {
    hlsMock.enabled = false;
    sessionShape = {};
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await render();
      const video = await at(42);
      await act(async () => { video.dispatchEvent(new Event("playing")); });
      Object.defineProperty(video, "paused", { configurable: true, get: () => false });
      await click(host.querySelector(".play-toggle")!);
      const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockClear();

      await act(async () => { vi.advanceTimersByTime(30_000); });
      await flushAll();

      expect(playbackPosts).toHaveLength(2);
      expect(playbackPosts[1]!.time).toBeCloseTo(42, 1);
      expect(play).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pings at once when the player becomes visible", async () => {
    hlsMock.enabled = false;
    sessionShape = {};
    pingStatus = 204;
    await render();

    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await flush();

    expect(pingRequests).toEqual(["/api/playback/sess1/ping"]);
  });
});

describe("Player chapters, segments and next episode", () => {
  const videoAt = async (seconds: number) => {
    const video = host.querySelector<HTMLVideoElement>("video")!;
    await act(async () => {
      video.currentTime = seconds;
      video.dispatchEvent(new Event("timeupdate", { bubbles: true }));
    });
    await flush();
    return video;
  };

  const startPlaying = async () => {
    await act(async () => { host.querySelector("video")!.dispatchEvent(new Event("play")); });
    await flush();
  };

  it("shows the playing badges", async () => {
    sessionShape = {
      playing: { resolution: 2160, hdr: "dolbyVision", audioCodec: "eac3", audioChannels: 6 },
    };
    await render();
    expect([...host.querySelectorAll(".player-badges i")].map((node) => node.textContent))
      .toEqual(["4K", "Dolby Vision", "E-AC-3 5.1"]);
  });

  it("marks chapters, names the current one and seeks from the chapter list", async () => {
    sessionShape = {
      chapters: [
        { start: 0, end: 600, title: "Opening" },
        { start: 600, end: 1800 },
        { start: 1800, end: 3600, title: "Finale" },
      ],
    };
    await render();
    expect(host.querySelectorAll(".timeline-chapter")).toHaveLength(2);
    const video = await videoAt(700);
    expect(host.querySelector(".player-chapter")?.textContent).toBe("Chapter 2");
    await openSettings();
    const chapters = [...host.querySelectorAll<HTMLButtonElement>(".player-chapters button")];
    expect(chapters).toHaveLength(3);
    const finale = chapters.find((button) => button.textContent?.includes("Finale"))!;
    await click(finale);
    expect(video.currentTime).toBe(1800);
  });

  it("hides chapter UI when the session has fewer than two chapters", async () => {
    sessionShape = { chapters: [{ start: 0, end: 3600, title: "Only" }] };
    await render();
    await videoAt(700);
    expect(host.querySelector(".timeline-chapter")).toBeNull();
    expect(host.querySelector(".player-chapter")).toBeNull();
    await openSettings();
    expect(host.querySelector(".player-chapters")).toBeNull();
  });

  it("asks for segments once for an IMDb stream and never for a file key", async () => {
    introAnswer = { intro: { start: 5, end: 60 } };
    await render({ progressKey: "series:tt0903747:1:2" });
    expect(introRequests).toEqual(["/api/intro-segments?imdb=tt0903747&season=1&episode=2"]);
    await videoAt(10);
    expect(introRequests).toHaveLength(1);
    await rerender({ stream: addonRow(), progressKey: "file:Films/a.mkv" });
    await videoAt(10);
    expect(introRequests).toHaveLength(1);
  });

  it("asks for a library file's segments under the title it is bound to", async () => {
    introAnswer = { intro: { start: 0, end: 30 } };
    await render({ progressKey: "file:Series/South Park/S20E01.mkv", catalogueKey: "series:tt0121955:20:1" });
    expect(introRequests).toEqual(["/api/intro-segments?imdb=tt0121955&season=20&episode=1"]);
    await videoAt(10);
    expect(host.querySelector(".player-skip")?.textContent).toBe("Skip intro");
  });

  it("marks the intro and the credits on the timeline", async () => {
    introAnswer = { intro: { start: 0, end: 360 }, outro: { start: 3240, end: 3600 } };
    await render({ progressKey: "series:tt0096697:1:8" });
    await videoAt(10);
    const marks = [...host.querySelectorAll<HTMLElement>(".timeline-segment")];
    expect(marks.map((mark) => [mark.dataset.kind, mark.style.left, mark.style.width]))
      .toEqual([["intro", "0%", "10%"], ["outro", "90%", "10%"]]);
  });

  it("ignores credits timed on another cut that fall mid-film", async () => {
    introAnswer = { outro: { start: 1800, end: 1900 } };
    await render({ progressKey: "movie:tt0172495" });
    await videoAt(1810);
    expect(host.querySelector(".timeline-segment")).toBeNull();
    expect(host.querySelector(".player-skip")).toBeNull();
  });

  it("offers a skip button that seeks past the intro", async () => {
    introAnswer = { intro: { start: 5, end: 60 } };
    await render({ progressKey: "movie:tt0903747" });
    const video = await videoAt(10);
    const skip = host.querySelector<HTMLButtonElement>(".player-skip");
    expect(skip?.textContent).toBe("Skip intro");
    await click(skip!);
    expect(video.currentTime).toBe(60);
  });

  it("auto-skips an intro once when playback enters it", async () => {
    introAnswer = { intro: { start: 5, end: 60 } };
    await render({ progressKey: "movie:tt0903747", skipSegmentsAuto: true });
    await startPlaying();
    await videoAt(4);
    const video = await videoAt(6);
    expect(video.currentTime).toBe(60);
    await act(async () => {
      video.currentTime = 30;
      video.dispatchEvent(new Event("seeking"));
      video.dispatchEvent(new Event("timeupdate", { bubbles: true }));
    });
    await flush();
    expect(video.currentTime).toBe(30);
  });

  it("offers the next episode at the configured point and respects dismissal", async () => {
    await render({
      onNext: vi.fn(async () => true),
      autoNext: true,
      upNextAt: "sec60",
    });
    await startPlaying();
    await videoAt(3539);
    expect(host.querySelector(".player-up-next")).toBeNull();
    await videoAt(3541);
    let card = host.querySelector<HTMLElement>(".player-up-next");
    expect(card).not.toBeNull();
    await click(card!.querySelectorAll("button")[1]!);
    expect(host.querySelector(".player-up-next")).toBeNull();
    await videoAt(3550);
    expect(host.querySelector(".player-up-next")).toBeNull();
    await videoAt(3500);
    await videoAt(3545);
    card = host.querySelector<HTMLElement>(".player-up-next");
    expect(card).not.toBeNull();
  });

  const endVideo = async () => { await act(async () => {
    host.querySelector("video")!.dispatchEvent(new Event("ended"));
  }); await flush(); };

  it("closes at the end of a film even when another file sits beside it", async () => {
    const value = await render({ onNext: vi.fn(async () => true), autoNext: false });
    await startPlaying();
    await endVideo();
    expect(value.onClose).toHaveBeenCalledTimes(1);
    expect(value.onNext).not.toHaveBeenCalled();
  });

  it("closes at the end when nothing follows", async () => {
    const value = await render({});
    await startPlaying();
    await endVideo();
    expect(value.onClose).toHaveBeenCalledTimes(1);
  });

  it("offers the next episode at the end instead of closing", async () => {
    const value = await render({ onNext: vi.fn(async () => true), autoNext: true, upNextAt: "end" });
    await startPlaying();
    await endVideo();
    expect(host.querySelector(".player-up-next")).not.toBeNull();
    expect(value.onClose).not.toHaveBeenCalled();
  });

  it("keeps the end setting for onEnded only", async () => {
    await render({ onNext: vi.fn(async () => true), autoNext: true, upNextAt: "end" });
    await startPlaying();
    await videoAt(3599);
    expect(host.querySelector(".player-up-next")).toBeNull();
  });

  it("restarts a converted stream that ended short instead of closing or offering the next episode", async () => {
    sessionShape = { mode: "remux", url: "/api/playback/sess1/1/master.m3u8", playlist: true };
    playbackStatusAnswer = { generation: 1, conversion: "short", reached: 1800 };
    const native = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = (type: string) => /mpegurl/i.test(type) ? "maybe" : "";
    try {
      const value = await render({ onNext: vi.fn(async () => true), autoNext: true, upNextAt: "end" });
      await startPlaying();
      await videoAt(1800);
      await endVideo();

      expect(playbackStatusRequests).toEqual(["sess1"]);
      expect(seekRequests).toHaveLength(1);
      expect(seekRequests[0]!.time).toBeCloseTo(1800, 1);
      expect(value.onClose).not.toHaveBeenCalled();
      expect(value.onNext).not.toHaveBeenCalled();
      expect(host.querySelector(".player-up-next")).toBeNull();
      expect(progressPosts.some(({ final }) => final === true)).toBe(false);
    } finally {
      HTMLMediaElement.prototype.canPlayType = native;
    }
  });

  it("keeps the ordinary end behaviour for a complete conversion", async () => {
    sessionShape = { mode: "remux", url: "/api/playback/sess1/1/master.m3u8", playlist: true };
    playbackStatusAnswer = { generation: 1, conversion: "complete" };
    const native = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = (type: string) => /mpegurl/i.test(type) ? "maybe" : "";
    try {
      const value = await render({ onNext: vi.fn(async () => true), autoNext: true, upNextAt: "end" });
      await startPlaying();
      await endVideo();

      expect(playbackStatusRequests).toEqual(["sess1"]);
      expect(host.querySelector(".player-up-next")).not.toBeNull();
      expect(value.onClose).not.toHaveBeenCalled();
    } finally {
      HTMLMediaElement.prototype.canPlayType = native;
    }
  });

  it("gives up after the third short-end restart", async () => {
    sessionShape = { mode: "remux", url: "/api/playback/sess1/1/master.m3u8", playlist: true };
    playbackStatusAnswer = { generation: 1, conversion: "short", reached: 1800 };
    const native = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = (type: string) => /mpegurl/i.test(type) ? "maybe" : "";
    try {
      await render({ onNext: vi.fn(async () => true), autoNext: true, upNextAt: "end" });
      await startPlaying();
      await videoAt(1800);
      for (let attempt = 0; attempt < 4; attempt += 1) await endVideo();

      expect(playbackStatusRequests).toHaveLength(4);
      expect(seekRequests).toHaveLength(3);
      expect(host.querySelector(".player-error")?.textContent).toBe("The source stopped sending the film before its end.");
      expect(host.querySelector(".player-up-next")).toBeNull();
    } finally {
      HTMLMediaElement.prototype.canPlayType = native;
    }
  });

  it("allows another restart after playback made progress following the last short end", async () => {
    sessionShape = { mode: "remux", url: "/api/playback/sess1/1/master.m3u8", playlist: true };
    playbackStatusAnswer = { generation: 1, conversion: "short", reached: 1800 };
    const native = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = (type: string) => /mpegurl/i.test(type) ? "maybe" : "";
    try {
      await render({ onNext: vi.fn(async () => true), autoNext: true, upNextAt: "end" });
      await startPlaying();
      await videoAt(1800);
      for (let attempt = 0; attempt < 3; attempt += 1) await endVideo();
      await videoAt(61);
      await endVideo();

      expect(playbackStatusRequests).toHaveLength(4);
      expect(seekRequests).toHaveLength(4);
      expect(host.querySelector(".player-error")).toBeNull();
    } finally {
      HTMLMediaElement.prototype.canPlayType = native;
    }
  });

  it("restarts a conversion the server reported as failed", async () => {
    sessionShape = { mode: "remux", url: "/api/playback/sess1/1/master.m3u8", playlist: true };
    playbackStatusAnswer = { generation: 1, conversion: "failed", reached: 1800 };
    const native = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = (type: string) => /mpegurl/i.test(type) ? "maybe" : "";
    try {
      await render({ onNext: vi.fn(async () => true), autoNext: true, upNextAt: "end" });
      await startPlaying();
      await videoAt(1800);
      await endVideo();

      expect(seekRequests).toHaveLength(1);
      expect(seekRequests[0]!.time).toBeCloseTo(1800, 1);
      expect(host.querySelector(".player-error")).toBeNull();
    } finally {
      HTMLMediaElement.prototype.canPlayType = native;
    }
  });

  it("does not ask for a conversion status during direct play", async () => {
    const value = await render({});
    await startPlaying();
    await endVideo();

    expect(playbackStatusRequests).toEqual([]);
    expect(value.onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Player final source identity", () => {
  const videoAt = (position: number) => act(async () => {
    const video = host.querySelector("video")!;
    video.currentTime = position;
    video.dispatchEvent(new Event("timeupdate", { bubbles: true }));
  });
  const original = addonRow({ sourceId: "hd", stableKey: `a:${"a".repeat(24)}` });
  const replacement = addonRow({ sourceId: "4k", stableKey: `a:${"b".repeat(24)}` });

  it.each([original, null])("saves the playing source when closing reveals another stream: %s", async (behind) => {
    await render({ stream: replacement, progressKey: "movie:tt0172495" });
    await videoAt(120);
    await rerender({ stream: behind, open: false, progressKey: "movie:tt0172495" });
    expect(progressPosts).toEqual([expect.objectContaining({
      key: "movie:tt0172495", position: 120, stableKey: replacement.stableKey, final: true,
    })]);
  });

  it("keeps each source's final position paired with its own identity across a switch", async () => {
    await render({ stream: original, progressKey: "movie:tt0172495" });
    await videoAt(120);
    await rerender({ stream: replacement, progressKey: "movie:tt0172495" });
    await videoAt(130);
    await rerender({ stream: null, open: false, progressKey: "movie:tt0172495" });
    expect(progressPosts.map(({ position, stableKey }) => ({ position, stableKey }))).toEqual([
      { position: 120, stableKey: original.stableKey },
      { position: 130, stableKey: replacement.stableKey },
    ]);
  });
});
