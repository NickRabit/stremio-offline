import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NativeLibrarySaveDialog } from "./NativeLibrarySaveDialog";
import { setLocale } from "./i18n";
import type { LibraryView, RemoteItem, Stream } from "./types";

const capabilities = (downloadToLibrary: boolean) =>
  ({ rename: false, move: false, delete: false, identify: false, writeArtwork: false, downloadToLibrary, downloadToDevice: false } as const);

const library = (over: Partial<LibraryView> = {}): LibraryView => ({
  id: "lib_1", name: "Films", type: "mixed", enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z",
  writeArtwork: false, autoScanMetadata: false, unreachable: false, readOnly: false, writable: true,
  defaultMovie: true, defaultSeries: true, titles: 0, files: 0, bytes: 0, ...over,
});

const movie = (over: Partial<RemoteItem> = {}): RemoteItem =>
  ({ id: "m1", name: "Heat", type: "movie", providerIds: { imdb: "tt0113277" }, year: 1995, ...over });
const episode = (over: Partial<RemoteItem> = {}): RemoteItem =>
  ({ id: "e1", name: "Pilot", type: "episode", seriesId: "s1", season: 1, episode: 2, providerIds: {}, ...over });
const series = (over: Partial<RemoteItem> = {}): RemoteItem =>
  ({ id: "s1", name: "The Show", type: "series", providerIds: { imdb: "tt5000" }, ...over });

const stream = (id: string, name: string, size: number, downloadToLibrary = true, downloadLibraryId?: string): Stream => ({
  sourceId: `source-${id}`, kind: "remote", playable: true, name, provider: "jellyfin",
  remoteItem: { libraryId: "rlib_a", itemId: "m1", mediaSourceId: id, progressKey: `p-${id}` },
  capabilities: capabilities(downloadToLibrary), behaviorHints: { videoSize: size },
  ...(downloadLibraryId ? { downloadLibraryId } : {}),
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let sourceCalls: string[];
let itemCalls: string[];
let downloadCalls: Array<Record<string, unknown>>;
let sourcesReply: () => Response | Promise<Response>;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  sourceCalls = []; itemCalls = []; downloadCalls = [];
  sourcesReply = () => json({ streams: [stream("v1", "720p", 800_000_000), stream("v2", "1080p", 3_000_000_000)] });
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;
    if (path === "/api/downloads" && init?.method === "POST") {
      downloadCalls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Promise.resolve(json({ id: "job1", status: "queued" }, 201));
    }
    if (/^\/api\/remote-libraries\/[^/]+\/items\/[^/]+\/sources$/.test(path)) { sourceCalls.push(path); return Promise.resolve(sourcesReply()); }
    if (/^\/api\/remote-libraries\/[^/]+\/items\/[^/]+$/.test(path)) {
      itemCalls.push(path);
      const id = path.split("/").pop();
      return Promise.resolve(json({ item: id === "s1" ? series() : movie({ id: id! }), capabilities: capabilities(true) }));
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
const card = () => document.querySelector<HTMLElement>(".save-target-card");
const primary = () => document.querySelector<HTMLButtonElement>(".save-target-card footer button.primary")!;
const chooser = () => document.querySelector<HTMLSelectElement>(".native-source-choice select");
const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click(); }); await flush(); };

const render = async (over: Partial<Parameters<typeof NativeLibrarySaveDialog>[0]> = {}) => {
  const onClose = vi.fn();
  const onQueued = vi.fn();
  const props: Parameters<typeof NativeLibrarySaveDialog>[0] = {
    library: { id: "rlib_a", provider: "jellyfin", name: "Movies" }, item: movie(), libraries: [library()],
    onClose, onQueued, ...over,
  };
  await act(async () => { root.render(<NativeLibrarySaveDialog {...props}/>); });
  await flush();
  return { onClose, onQueued, props };
};

describe("NativeLibrarySaveDialog", () => {
  it("reads the versions once on open and queues the chosen smaller one", async () => {
    const { onQueued } = await render();
    expect(sourceCalls).toHaveLength(1);
    expect(chooser()).not.toBeNull();
    const options = [...chooser()!.options];
    expect(options).toHaveLength(2);
    await act(async () => {
      chooser()!.value = "v1";
      chooser()!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(primary());
    expect(downloadCalls).toHaveLength(1);
    expect(downloadCalls[0]!.sourceId).toBe("source-v1");
    expect(onQueued).toHaveBeenCalledTimes(1);
  });

  it("uses the versions the caller already holds without reading them again", async () => {
    await render({ knownSources: [stream("v2", "1080p", 3_000_000_000)] });
    expect(sourceCalls).toHaveLength(0);
    expect(chooser()).toBeNull();
    await click(primary());
    expect(downloadCalls[0]!.sourceId).toBe("source-v2");
  });

  it("keeps the picture off a protected remote proxy path and sends only exact catalogue art", async () => {
    await render({ knownSources: [stream("v2", "1080p", 1)], item: movie({ poster: "/api/remote-libraries/rlib_a/items/m1/artwork/Primary?tag=abc" }) });
    await click(primary());
    const media = downloadCalls[0]!.media as Record<string, unknown>;
    expect(media.poster).toBeUndefined();
    expect(JSON.stringify(downloadCalls[0])).not.toContain("/artwork/");
  });

  it("sends the exact destination the viewer picked", async () => {
    await render({ libraries: [library()] });
    const custom = [...card()!.querySelectorAll<HTMLElement>(".bulk-strategy label")].find((label) => label.textContent?.includes("Somewhere else"))!;
    await click(custom);
    await click(primary());
    expect(downloadCalls[0]!.target).toEqual({ libraryId: "lib_1", subfolder: "", layout: "structured" });
  });

  it("preselects the automatic option to the destination the server projected for the source", async () => {
    const films = library({ id: "lib_1", name: "Films" });
    const other = library({ id: "lib_2", name: "Elsewhere", defaultMovie: false, defaultSeries: false });
    await render({ libraries: [other, films], knownSources: [stream("v2", "1080p", 1, true, "lib_1")] });
    expect(card()!.textContent).toContain("Films");
    expect(card()!.textContent).not.toContain("Elsewhere");
    // The automatic option still names no target: the server resolves and admits it again.
    await click(primary());
    expect(downloadCalls).toHaveLength(1);
    expect("target" in downloadCalls[0]!).toBe(false);
  });

  it("lets a manual destination override the projected one", async () => {
    const films = library({ id: "lib_1", name: "Films" });
    const other = library({ id: "lib_2", name: "Elsewhere", defaultMovie: false, defaultSeries: false });
    await render({ libraries: [films, other], knownSources: [stream("v2", "1080p", 1, true, "lib_1")] });
    const custom = [...card()!.querySelectorAll<HTMLElement>(".bulk-strategy label")].find((label) => label.textContent?.includes("Somewhere else"))!;
    await click(custom);
    await click([...card()!.querySelectorAll<HTMLElement>(".move-libraries button")].find((button) => button.textContent === "Elsewhere")!);
    await click(primary());
    expect(downloadCalls[0]!.target).toEqual({ libraryId: "lib_2", subfolder: "", layout: "structured" });
  });

  it("never invents a target when the projected destination is one it cannot offer", async () => {
    await render({ libraries: [library({ id: "lib_1", name: "Films" })], knownSources: [stream("v2", "1080p", 1, true, "lib_gone")] });
    await click(primary());
    expect(downloadCalls).toHaveLength(1);
    expect("target" in downloadCalls[0]!).toBe(false);
  });

  it("falls back to the remote library's own configured destination when a source carries none", async () => {
    await render({
      library: { id: "rlib_a", provider: "jellyfin", name: "Movies", downloadLibraryId: "lib_2" },
      libraries: [library({ id: "lib_1", name: "Films" }), library({ id: "lib_2", name: "Elsewhere", defaultMovie: false, defaultSeries: false })],
      knownSources: [stream("v2", "1080p", 1)],
    });
    expect(card()!.textContent).toContain("Elsewhere");
  });

  it("reports a denied native permission and holds the submit back", async () => {
    await render({ knownSources: [stream("v2", "1080p", 1, false)] });
    expect(card()!.textContent).toContain("Downloads are disabled for this server account.");
    expect(primary().disabled).toBe(true);
  });

  it("reports when no library can be written to and holds the submit back", async () => {
    await render({ libraries: [library({ readOnly: true, writable: false })], knownSources: [stream("v2", "1080p", 1)] });
    expect(card()!.textContent).toContain("No library you can write to takes this kind of title.");
    expect(primary().disabled).toBe(true);
  });

  it("treats a disabled, read-only, unreachable or wrong-kind library as no destination", async () => {
    for (const broken of [
      library({ enabled: false, writable: false }),
      library({ readOnly: true, writable: false }),
      library({ unreachable: true, writable: false }),
      library({ type: "series" }),
    ]) {
      await render({ libraries: [broken], knownSources: [stream("v2", "1080p", 1)] });
      expect(card()!.textContent).toContain("No library you can write to takes this kind of title.");
      expect(primary().disabled).toBe(true);
    }
  });

  it("reads the parent series of an episode and titles the copy with it", async () => {
    await render({ item: episode(), knownSources: [stream("v2", "1080p", 1)] });
    expect(itemCalls.some((path) => path.endsWith("/s1"))).toBe(true);
    await click(primary());
    const media = downloadCalls[0]!.media as Record<string, unknown>;
    expect(media).toMatchObject({ kind: "episode", title: "The Show", season: 1, episode: 2, episodeTitle: "Pilot", id: "tt5000", metaType: "series" });
  });

  it("never lists or reads a title for an unnumbered episode clip", async () => {
    await render({ item: episode({ seriesId: undefined, season: undefined, episode: undefined }), knownSources: [stream("v2", "1080p", 1)] });
    expect(itemCalls).toHaveLength(0);
    await click(primary());
    const media = downloadCalls[0]!.media as Record<string, unknown>;
    expect(media.id).toBeUndefined();
    expect(media.title).toBe("Pilot");
  });

  it("keeps the dialog and its choice when the queue call fails", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/downloads" && init?.method === "POST") return Promise.resolve(json({ error: "This source is already in the library." }, 409));
      return Promise.resolve(json({ streams: [stream("v2", "1080p", 1)] }));
    }));
    const { onQueued } = await render({ knownSources: [stream("v2", "1080p", 1)] });
    await click(primary());
    expect(onQueued).not.toHaveBeenCalled();
    expect(card()).not.toBeNull();
    expect(card()!.textContent).toContain("This source is already in the library.");
  });

  it("shows a retry when the version read fails and reads again on demand", async () => {
    let fail = true;
    sourcesReply = () => { if (fail) return json({ error: "The versions could not be loaded." }, 500); return json({ streams: [stream("v2", "1080p", 1)] }); };
    await render();
    expect(sourceCalls).toHaveLength(1);
    expect(card()!.textContent).toContain("The versions could not be loaded.");
    expect(primary().disabled).toBe(true);
    fail = false;
    await click([...card()!.querySelectorAll("button")].find((button) => button.textContent?.includes("Try again"))!);
    expect(sourceCalls).toHaveLength(2);
    expect(primary().disabled).toBe(false);
  });
});

it("waits for an episode's parent before saving its series identity", async () => {
  const originalFetch = globalThis.fetch;
  let release!: (value: Response) => void;
  const parent = new Promise<Response>((resolve) => { release = resolve; });
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/items/s1")) return parent;
    return originalFetch(input, init);
  }));
  await render({ item: episode(), knownSources: [stream("v1", "720p", 1)] });
  expect(primary().disabled).toBe(true);
  await click(primary());
  expect(downloadCalls).toHaveLength(0);
  await act(async () => { release(json({ item: series() })); });
  await flush();
  expect(primary().disabled).toBe(false);
  await click(primary());
  const media = downloadCalls[0]!.media as Record<string, unknown>;
  expect(media.title).toBe("The Show");
  expect(media.id).toBe("tt5000");
});
