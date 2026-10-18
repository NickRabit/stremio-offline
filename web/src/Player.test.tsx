import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Player } from "./Player";
import type { PlayerSources } from "./Player";
import { setLocale } from "./i18n";
import type { LibrarySourceGroup } from "./library-sources";
import type { RemoteCapabilities, Stream } from "./types";

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
  progressReads = [];
  progressAnswers = {};
  remoteReads = [];
  remoteAnswers = {};
  playbackPosts = [];
  heldWrite = null;
  sessionShape = {};
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;
    if (path === "/api/playback" && init?.method === "POST") {
      playbackPosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Promise.resolve(json(session()));
    }
    if (/^\/api\/playback\/[^/]+$/.test(path) && init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
    if (/^\/api\/playback\/[^/]+\/ping$/.test(path)) return Promise.resolve(new Response(null, { status: 204 }));
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
    expect(progressPosts).toEqual([expect.objectContaining({ key: "movie:tt5000", position: 120, duration: 3600, stableKey: other.stableKey })]);
    expect(progressPosts[0]).not.toHaveProperty("path");
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
