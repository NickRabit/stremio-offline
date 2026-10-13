import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LocalLibraryDetail, type LocalDetailItem } from "./LocalLibraryDetail";
import { setLocale } from "./i18n";
import type { IdentityPreview, Stream } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const file = (over: Partial<Extract<LocalDetailItem, { kind: "file" }>> = {}): LocalDetailItem =>
  ({ kind: "file", path: "Films/Heat.mkv", label: "Heat.mkv", season: null, episode: null, size: 2_000_000_000, modified: "2026-09-01", match: "unmatched", ...over });
const folder = (over: Partial<Extract<LocalDetailItem, { kind: "folder" }>> = {}): LocalDetailItem =>
  ({ kind: "folder", path: "Heat", name: "Heat", fileCount: 2, size: 4_000_000_000, match: "matched", titleType: "movie", ...over });
const identity = (over: Partial<IdentityPreview> = {}): IdentityPreview => ({
  path: "Films/Heat.mkv", key: "Films/Heat.mkv", kind: "movie", file: true, label: "Heat.mkv",
  parsed: { title: "Heat", query: "Heat" }, match: "unmatched", ...over,
});
const copy = (localPath: string, filename: string, bytes: number, libraryName = "Films"): Stream =>
  ({ sourceId: `lib:${localPath}`, kind: "library", playable: true, localPath, libraryName, behaviorHints: { filename, videoSize: bytes } });

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;
let source: Handler;
let identityHandler: Handler;
let copies: Handler;
const calls = { source: [] as URL[], identity: [] as URL[], localStreams: [] as URL[] };

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  calls.source = []; calls.identity = []; calls.localStreams = [];
  source = () => json({ sourceId: "exact", kind: "library", playable: true, behaviorHints: { filename: "Heat.mkv" } });
  identityHandler = () => json(identity());
  copies = () => json([]);
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;
    if (path === "/api/library/source") { calls.source.push(url); return Promise.resolve(source(url, init)); }
    if (path === "/api/library/identity") { calls.identity.push(url); return Promise.resolve(identityHandler(url, init)); }
    if (/^\/api\/local-streams\/[^/]+\/[^/]+$/.test(path)) { calls.localStreams.push(url); return Promise.resolve(copies(url, init)); }
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
  const props = { item, favorite: false, onPlay, onToggleFavorite, onResetProgress: vi.fn(), ...over };
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
    expect(host.querySelector(".library-detail-source")!.textContent).toContain("Heat.mkv");
    expect(host.querySelector(".library-detail-source")!.textContent).toContain("2.0 GB");
    await click(host.querySelector(".library-detail-play button.primary"));
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ localPath: "Films/Heat.mkv" }));
  });

  it("keeps the playable file when the identity lookup fails", async () => {
    identityHandler = () => json({ error: "boom" }, 500);
    await render(file());
    expect(host.querySelector(".remote-error")).toBeNull();
    expect(host.querySelector(".library-detail-play button.primary")!.hasAttribute("disabled")).toBe(false);
    expect(host.querySelector(".library-detail-source")!.textContent).toContain("Heat.mkv");
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
    expect(host.querySelector(".library-detail-source")!.textContent).toContain("Heat.1080p.mkv");
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

  it("toggles the clicked library item's favorite and resets its position", async () => {
    const { onToggleFavorite, props } = await render(file(), { favorite: true, progress: { position: 10, duration: 100 } });
    await click(host.querySelector(".library-detail-actions button"));
    expect(onToggleFavorite).toHaveBeenCalledWith(false);
    await click(host.querySelectorAll(".library-detail-actions button")[1]);
    expect(props.onResetProgress).toHaveBeenCalled();
  });
});
