import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CatalogueTitleDetail, catalogueStreamId, type CatalogueDetailTarget, type CatalogueTitleDetailProps } from "./CatalogueTitleDetail";
import { setLocale } from "./i18n";
import type { Meta, Stream, Video } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const addon = (id: string, name: string, size?: number): Stream => ({
  sourceId: id, kind: "remote", playable: true, name, addonKey: "torrentio", addonName: "Torrentio",
  ...(size === undefined ? {} : { behaviorHints: { videoSize: size } }),
});

const local = (path: string, name: string, size?: number): Stream => ({
  sourceId: `lib:${path}`, kind: "library", playable: true, localPath: path, libraryName: "Films", name,
  behaviorHints: { filename: name, ...(size === undefined ? {} : { videoSize: size }) },
});

const episode = (id: string, season: number, number: number, title?: string): Video =>
  ({ id, season, episode: number, ...(title ? { title } : {}) });

const film = (over: Partial<Meta> = {}): Meta =>
  ({ id: "tt-film", type: "movie", name: "A film", description: "A quiet film.", poster: "/poster.jpg", background: "/wide.jpg", releaseInfo: "1995", genres: ["Crime", "Drama"], ...over });

const series = (videos: Video[]): Meta =>
  ({ id: "tt-series", type: "series", name: "A show", description: "A long show.", poster: "/show.jpg", videos });

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

type Handler = (url: URL) => Response | Promise<Response>;
let metaReply: Handler;
let providerReply: Handler;
let streamReply: Handler;
const calls = { meta: [] as URL[], providers: [] as URL[], streams: [] as URL[] };

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  calls.meta = []; calls.providers = []; calls.streams = [];
  metaReply = () => json(film());
  providerReply = () => json([{ key: "torrentio", name: "Torrentio" }]);
  streamReply = () => json([addon("a1", "1080p", 1_000)]);
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;
    if (path.startsWith("/api/meta/")) { calls.meta.push(url); return Promise.resolve(metaReply(url)); }
    if (path.startsWith("/api/stream-sources/")) { calls.providers.push(url); return Promise.resolve(providerReply(url)); }
    if (path.startsWith("/api/streams/")) { calls.streams.push(url); return Promise.resolve(streamReply(url)); }
    return Promise.resolve(new Response(null, { status: 404 }));
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
const click = async (element: Element | null) => { await act(async () => { (element as HTMLElement).click(); }); await flush(); };
const playButton = () => host.querySelector<HTMLButtonElement>(".library-detail-play button.primary")!;
const episodeRows = () => [...host.querySelectorAll<HTMLButtonElement>(".catalogue-episodes .episode-list button")];
const pickerRows = () => [...document.querySelectorAll<HTMLButtonElement>(".library-source-card .remote-streams button")];
const chosenRow = () => pickerRows().find((row) => row.getAttribute("aria-pressed") === "true");
const pickerArrow = () => host.querySelector<HTMLButtonElement>(".split-button-toggle");

const render = async (over: Partial<CatalogueTitleDetailProps> = {}) => {
  const onPlay = vi.fn();
  const onSaveToLibrary = vi.fn();
  const onSaveElsewhere = vi.fn();
  const onDownloadToDevice = vi.fn();
  const props: CatalogueTitleDetailProps = {
    target: { type: "movie", id: "tt-film", name: "A film" },
    onPlay, onSaveToLibrary, onSaveElsewhere, saveSupported: () => true, onDownloadToDevice,
    ...over,
  };
  await act(async () => { root.render(<CatalogueTitleDetail {...props}/>); });
  await flush();
  return { props, onPlay, onSaveToLibrary, onSaveElsewhere, onDownloadToDevice };
};

const rerender = async (over: Partial<CatalogueTitleDetailProps>) => {
  await act(async () => { root.render(<CatalogueTitleDetail
    target={{ type: "movie", id: "tt-film", name: "A film" }}
    onPlay={vi.fn()} onSaveToLibrary={vi.fn()} onSaveElsewhere={vi.fn()} saveSupported={() => true} onDownloadToDevice={vi.fn()}
    {...over}/>); });
  await flush();
};

describe("catalogueStreamId", () => {
  it("names an episode by the exact video the catalogue listed, and falls back to its numbering", () => {
    expect(catalogueStreamId({ id: "tt1", videoId: "tt1:5:2", season: 5, episode: 2 })).toBe("tt1:5:2");
    expect(catalogueStreamId({ id: "tt1", season: 5, episode: 2 })).toBe("tt1:5:2");
    expect(catalogueStreamId({ id: "tt1" })).toBe("tt1");
  });
});

describe("CatalogueTitleDetail metadata", () => {
  it("takes the catalogue's own snapshot and never reads metadata again", async () => {
    await render({ target: { type: "movie", id: "tt-film", name: "The catalogue's title", initialMeta: film({ name: "The catalogue's title" }) }, onGallery: vi.fn() });
    expect(calls.meta).toHaveLength(0);
    expect(host.querySelector("h2")!.textContent).toBe("The catalogue's title");
    expect(host.querySelector(".library-detail-synopsis")!.textContent).toBe("A quiet film.");
    expect(host.querySelector(".hero")!.textContent).toContain("1995 · Crime · Drama");
    expect(host.querySelector(".gallery-open img")!.getAttribute("src")).toBe("/poster.jpg");
  });

  it("reads the metadata of a title only Home or a favourite knows", async () => {
    await render();
    expect(calls.meta).toHaveLength(1);
    expect(calls.meta[0]!.pathname).toBe("/api/meta/movie/tt-film");
    expect(host.querySelector(".library-detail-synopsis")!.textContent).toBe("A quiet film.");
  });

  it("says so and offers the retry when the metadata read fails", async () => {
    metaReply = () => json({ error: "boom" }, 500);
    await render();
    const error = host.querySelector(".remote-error")!;
    expect(error).not.toBeNull();
    expect(error.textContent).toContain("boom");
    // The title the caller named still stands in, so the page is never blank.
    expect(host.querySelector("h2")!.textContent).toBe("A film");
    metaReply = () => json(film({ description: "Read the second time." }));
    await click(error.querySelector("button"));
    expect(host.querySelector(".library-detail-synopsis")!.textContent).toBe("Read the second time.");
    expect(host.querySelector(".remote-error")).toBeNull();
  });

  it("refuses a slow answer for a title that is no longer on screen", async () => {
    const slow = deferred<Response>();
    metaReply = (url) => url.pathname.includes("tt-film") ? slow.promise : json(series([]));
    await render();
    expect(host.querySelector("h2")!.textContent).toBe("A film");
    await rerender({ target: { type: "series", id: "tt-series", name: "A show" } });
    expect(host.querySelector("h2")!.textContent).toBe("A show");
    await act(async () => { slow.resolve(json(film({ name: "A late film" }))); });
    await flush();
    expect(host.querySelector("h2")!.textContent).toBe("A show");
    expect(host.querySelector(".library-detail-synopsis")!.textContent).toBe("A long show.");
  });
});

describe("CatalogueTitleDetail sources", () => {
  it("reuses the rows the catalogue read and plays the row it was opened on", async () => {
    const picked = addon("picked-row", "Torrent 4K", 4_000_000_000);
    const { onPlay, onSaveToLibrary, onDownloadToDevice } = await render({
      target: { type: "movie", id: "tt-film", name: "A film", initialMeta: film(), initialSource: picked },
      initialSources: [picked, addon("a2", "1080p", 1_000)],
      onDownloadToDevice: vi.fn(),
    });
    expect(calls.providers).toHaveLength(0);
    expect(calls.streams).toHaveLength(0);
    await click(playButton());
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "picked-row" }), expect.objectContaining({ type: "movie", id: "tt-film" }), false);
    await click(host.querySelector<HTMLButtonElement>(".library-detail-actions button[aria-label='To library']"));
    expect(onSaveToLibrary).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "picked-row" }), expect.objectContaining({ id: "tt-film" }));
    expect(onDownloadToDevice).not.toHaveBeenCalled();
    // A catalogue title's rows are not a local file, so the device action is not offered.
    expect(host.querySelector(".library-detail-actions button[aria-label='Download to device']")).toBeNull();
  });

  it("takes an empty handed-over answer as the answer and asks nothing again", async () => {
    await render({ target: { type: "movie", id: "tt-film", name: "A film", initialMeta: film() }, initialSources: [] });
    expect(calls.providers).toHaveLength(0);
    expect(host.querySelector(".library-title-detail")!.textContent).toContain("No playable version");
  });

  it("asks the providers itself when the catalogue handed nothing over", async () => {
    const { onPlay } = await render({ target: { type: "movie", id: "tt-film", name: "A film", initialMeta: film() } });
    expect(calls.providers).toHaveLength(1);
    expect(calls.streams).toHaveLength(1);
    expect(calls.streams[0]!.searchParams.get("addon")).toBe("torrentio");
    await click(playButton());
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "a1" }), expect.anything(), false);
  });

  it("shows a retryable failure when every provider failed, never an empty title", async () => {
    streamReply = () => json({ error: "every provider is down" }, 500);
    const { onPlay } = await render({ target: { type: "movie", id: "tt-film", name: "A film", initialMeta: film() } });
    const error = host.querySelector(".remote-error")!;
    expect(error.textContent).toContain("every provider is down");
    expect(playButton().disabled).toBe(true);
    streamReply = () => json([addon("a1", "1080p", 1_000)]);
    await click(error.querySelector("button"));
    expect(host.querySelector(".remote-error")).toBeNull();
    await click(playButton());
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "a1" }), expect.anything(), false);
  });

  it("keeps the rows that answered when another provider failed", async () => {
    providerReply = () => json([{ key: "torrentio", name: "Torrentio" }, { key: "other", name: "Other" }]);
    streamReply = (url) => url.searchParams.get("addon") === "other" ? json({ error: "down" }, 500) : json([addon("a1", "1080p", 1_000)]);
    await render({ target: { type: "movie", id: "tt-film", name: "A film", initialMeta: film() } });
    expect(host.querySelector(".remote-error")).toBeNull();
    expect(pickerArrow()).not.toBeNull();
    await click(pickerArrow());
    expect(pickerRows().some((row) => row.textContent?.includes("1080p"))).toBe(true);
  });
});

describe("CatalogueTitleDetail resume", () => {
  it("plays the source Continue watching stored, once, as soon as the rows list it", async () => {
    const stored = { ...addon("a2", "4K", 4_000), stableKey: "u:stored" };
    streamReply = () => json([addon("a1", "1080p", 1_000), stored]);
    const target: CatalogueDetailTarget = { type: "movie", id: "tt-film", name: "A film", initialMeta: film(), resume: true };
    const { onPlay } = await render({ target });
    // The key arrives from the caller's progress read, after the rows.
    expect(onPlay).not.toHaveBeenCalled();
    await rerender({ target, resumeStableKey: "u:stored", onPlay });
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "a2" }), expect.objectContaining({ id: "tt-film" }), false);
    await rerender({ target, resumeStableKey: "u:stored", onPlay });
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it("stays on the detail when the stored source is no longer offered, and never plays outside resume", async () => {
    const target: CatalogueDetailTarget = { type: "movie", id: "tt-film", name: "A film", initialMeta: film(), resume: true };
    const gone = await render({ target, resumeStableKey: "u:gone" });
    expect(gone.onPlay).not.toHaveBeenCalled();
    streamReply = () => json([{ ...addon("a1", "1080p", 1_000), stableKey: "u:kept" }]);
    const plain = await render({ target: { type: "movie", id: "tt-film", name: "A film", initialMeta: film() }, resumeStableKey: "u:kept" });
    expect(plain.onPlay).not.toHaveBeenCalled();
  });
});

describe("CatalogueTitleDetail series", () => {
  const videos = [episode("tt-series:1:1", 1, 1, "The first one"), episode("tt-series:1:2", 1, 2, "The second one")];

  it("asks nothing and plays nothing until an episode is chosen", async () => {
    const { onPlay } = await render({ target: { type: "series", id: "tt-series", name: "A show", initialMeta: series(videos) } });
    expect(calls.providers).toHaveLength(0);
    expect(calls.streams).toHaveLength(0);
    expect(episodeRows()).toHaveLength(2);
    expect(playButton().disabled).toBe(true);
    await click(playButton());
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("asks for the exact video of the chosen episode and hands its own target on", async () => {
    const { onPlay } = await render({ target: { type: "series", id: "tt-series", name: "A show", initialMeta: series(videos) } });
    await click(episodeRows()[1]!);
    expect(calls.streams).toHaveLength(1);
    expect(calls.streams[0]!.pathname).toBe("/api/streams/series/tt-series%3A1%3A2");
    await click(playButton());
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "a1" }),
      expect.objectContaining({ type: "series", id: "tt-series", season: 1, episode: 2, videoId: "tt-series:1:2" }), false);
  });

  it("never treats a series id as a film, even with no episodes to choose", async () => {
    const { onPlay } = await render({ target: { type: "series", id: "tt-series", name: "A show", initialMeta: series([]) } });
    expect(calls.providers).toHaveLength(0);
    expect(host.querySelector(".catalogue-episodes")!.textContent).toContain("no episodes");
    expect(playButton().disabled).toBe(true);
    await click(playButton());
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("opens on the episode the catalogue had selected and resets the source choice per episode", async () => {
    streamReply = () => json([addon("small", "720p", 10), addon("large", "1080p", 2_000_000_000)]);
    const { onPlay } = await render({
      target: { type: "series", id: "tt-series", name: "A show", season: 1, episode: 2, videoId: "tt-series:1:2", initialMeta: series(videos) },
      initialSources: [addon("small", "720p", 10), addon("large", "1080p", 2_000_000_000)],
    });
    expect(calls.streams).toHaveLength(0);
    expect(host.querySelector(".catalogue-episodes .episode-current")!.textContent).toContain("The second one");
    // The viewer takes the smaller row of this episode.
    await click(pickerArrow());
    await click(pickerRows()[1]!);
    await click(playButton());
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "small" }), expect.objectContaining({ videoId: "tt-series:1:2" }), false);
    // Another episode is asked for itself, and its own default stands: the pick did not travel.
    await click(host.querySelector(".catalogue-episodes .episode-current button"));
    await click(episodeRows()[0]!);
    expect(calls.streams.at(-1)!.pathname).toBe("/api/streams/series/tt-series%3A1%3A1");
    await click(playButton());
    expect(onPlay).toHaveBeenLastCalledWith(expect.objectContaining({ sourceId: "large" }), expect.objectContaining({ season: 1, episode: 1, videoId: "tt-series:1:1" }), false);
  });

  it("plays and queues a local copy of the chosen episode through its effective target", async () => {
    const picked = local("Films/Show S01E02.mkv", "Show S01E02.mkv", 500);
    const { onPlay, onSaveToLibrary } = await render({
      target: { type: "series", id: "tt-series", name: "A show", season: 1, episode: 2, videoId: "tt-series:1:2", initialMeta: series(videos), initialSource: picked },
      initialSources: [picked, addon("a1", "1080p", 1_000)],
    });
    await click(playButton());
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ localPath: "Films/Show S01E02.mkv" }),
      expect.objectContaining({ season: 1, episode: 2, videoId: "tt-series:1:2" }), false);
    await click(host.querySelector<HTMLButtonElement>(".library-detail-actions button[aria-label='To library']"));
    expect(onSaveToLibrary).toHaveBeenCalledWith(expect.objectContaining({ localPath: "Films/Show S01E02.mkv" }), expect.objectContaining({ episode: 2 }));
  });

  it("opens the gallery over the episode's own pictures and target", async () => {
    const onGallery = vi.fn();
    await render({
      target: { type: "series", id: "tt-series", name: "A show", season: 1, episode: 1, videoId: "tt-series:1:1", initialMeta: series(videos) },
      initialSources: [addon("a1", "1080p", 1_000)],
      onGallery,
    });
    await click(host.querySelector(".gallery-open"));
    expect(onGallery).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ type: "series", id: "tt-series", videoId: "tt-series:1:1" }));
  });

  it("keeps the row it was opened on out of another episode's own sources", async () => {
    const picked = local("Films/Show S01E02.mkv", "Show S01E02.mkv", 500);
    const { onPlay } = await render({
      target: { type: "series", id: "tt-series", name: "A show", season: 1, episode: 2, videoId: "tt-series:1:2", initialMeta: series(videos), initialSource: picked },
      initialSources: [picked, addon("a1", "1080p", 1_000)],
    });
    expect(host.querySelector(".catalogue-episodes .episode-current")!.textContent).toContain("The second one");
    await click(host.querySelector(".catalogue-episodes .episode-current button"));
    await click(episodeRows()[0]!);
    await click(playButton());
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "a1" }), expect.objectContaining({ videoId: "tt-series:1:1" }), false);
    await click(pickerArrow());
    expect(pickerRows().some((row) => row.textContent?.includes("Show S01E02.mkv"))).toBe(false);
  });
});
