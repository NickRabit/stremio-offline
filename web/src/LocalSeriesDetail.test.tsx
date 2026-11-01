import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { chosenEpisode, episodeFiles, episodeName, nextEpisode, useLocalSeries } from "./LocalSeriesDetail";
import type { BrowseFile } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const episode = (path: string, season: number, number: number, over: Partial<BrowseFile> = {}): BrowseFile => ({
  path, label: `Show - S${String(season).padStart(2, "0")}E${String(number).padStart(2, "0")} - Episode ${number}`,
  season, episode: number, size: 1_000_000_000, modified: "2026-09-01", ...over,
});

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

function SeriesProbe({ path, revision = 0 }: { path: string; revision?: number }) {
  const series = useLocalSeries(path, revision);
  return <div data-loading={String(series.loading)} data-error={series.error} data-next={nextEpisode(series.episodes, series.resume)?.path ?? ""}>
    {series.episodes.map((file) => <i key={file.path} data-path={file.path}/>)}
  </div>;
}

describe("local series helpers", () => {
  it("folds copies, keeps the watched or largest copy, and puts specials last", () => {
    const files = [
      episode("/special.mkv", 0, 1, { size: 900 }),
      episode("/s2e1-small.mkv", 2, 1, { size: 100 }),
      episode("/s2e1-large.mkv", 2, 1, { size: 800 }),
      episode("/s1e1-small.mkv", 1, 1, { size: 100, progress: { position: 10, duration: 100 } }),
      episode("/s1e1-large.mkv", 1, 1, { size: 1_000 }),
    ];

    expect(episodeFiles(files).map((file) => file.path)).toEqual([
      "/s1e1-small.mkv",
      "/s2e1-large.mkv",
      "/special.mkv",
    ]);
  });

  it("starts nothing, resumes the episode in progress, and advances after a finished one", () => {
    const first = episode("/s1e1.mkv", 1, 1);
    const second = episode("/s1e2.mkv", 1, 2);
    const third = episode("/s2e1.mkv", 2, 1);
    const resuming = { ...second, progress: { position: 10, duration: 100 } };

    expect(nextEpisode([first, second, third])).toBe(first);
    expect(nextEpisode([first, resuming, third])).toBe(resuming);
    expect(nextEpisode([{ ...first, progress: { position: 95, duration: 100 } }, second, third])).toBe(second);
  });

  it("chooses the wanted episode by path", () => {
    const first = episode("/s1e1.mkv", 1, 1);
    const second = episode("/s1e2.mkv", 1, 2);

    expect(chosenEpisode([first, second], { path: second.path }, null)).toBe(second);
  });

  it("chooses a folded copy by season and episode", () => {
    const copy = episode("/s1e2-copy.mkv", 1, 2);
    const representative = episode("/s1e2.mkv", 1, 2, { size: 2_000_000_000 });

    expect(chosenEpisode([representative], { path: copy.path, season: 1, episode: 2 }, null)).toBe(representative);
  });

  it("falls back to the next episode when nothing was chosen", () => {
    const first = episode("/s1e1.mkv", 1, 1);
    const second = episode("/s1e2.mkv", 1, 2);

    expect(chosenEpisode([first, second], null, { season: 1, episode: 2 })).toBe(second);
  });

  it("reads the episode title out of a numbered file name", () => {
    expect(episodeName({ ...episode("", 1, 2), label: "Show - S01E02 - The Pilot (2)" })).toBe("The Pilot");
  });
});

describe("useLocalSeries", () => {
  it("recursively loads and folds a show's episode files", async () => {
    const first = episode("Shows/Show/Season 1/Show - S01E01 - First.mkv", 1, 1);
    const second = episode("Shows/Show/Season 1/Show - S01E02 - Second.mkv", 1, 2);
    const third = episode("Shows/Show/Season 2/Show - S02E01 - Third.mkv", 2, 1);
    const folders = [
      { kind: "folder", path: "Shows/Show/Season 1", name: "Season 1", fileCount: 2, size: 2_000_000_000 },
      { kind: "folder", path: "Shows/Show/Season 2", name: "Season 2", fileCount: 1, size: 1_000_000_000 },
    ] as const;

    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/library/browse") {
        const path = url.searchParams.get("path");
        const items = path === "Shows/Show" ? folders
          : path === folders[0].path ? [{ kind: "file", ...first }, { kind: "file", ...second }]
            : path === folders[1].path ? [{ kind: "file", ...third }]
              : [];
        return Promise.resolve(json({ path, items, total: items.length, pending: false }));
      }
      return Promise.resolve(json({}, 404));
    }));

    await act(async () => { root.render(<SeriesProbe path="Shows/Show"/>); });
    await flush();
    await flush();

    expect(host.firstElementChild?.getAttribute("data-loading")).toBe("false");
    expect(host.firstElementChild?.getAttribute("data-error")).toBe("");
    expect([...host.querySelectorAll("[data-path]")].map((node) => node.getAttribute("data-path"))).toEqual([
      "Shows/Show/Season 1/Show - S01E01 - First.mkv",
      "Shows/Show/Season 1/Show - S01E02 - Second.mkv",
      "Shows/Show/Season 2/Show - S02E01 - Third.mkv",
    ]);
  });

  it("opens on the episode the server names after a finished one that kept no position", async () => {
    // The server drops a file's position past 94 % and keeps a per-series marker instead: the
    // finished first episode looks untouched, and only the progress row names the second.
    const first = episode("Shows/Show/Show - S01E01 - First.mkv", 1, 1);
    const second = episode("Shows/Show/Show - S01E02 - Second.mkv", 1, 2);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/library/browse") {
        const items = [{ kind: "file", ...first }, { kind: "file", ...second }];
        return Promise.resolve(json({ path: "Shows/Show", items, total: items.length, pending: false }));
      }
      if (url.pathname === "/api/library/identity") {
        return Promise.resolve(json({ path: "Shows/Show", key: "k", kind: "series", file: false, label: "Show", parsed: { title: "Show", query: "Show" }, match: "matched", bound: { type: "series", id: "tt123" } }));
      }
      if (url.pathname === "/api/progress") {
        return Promise.resolve(json([{ key: "series:tt123:1:2", position: 0, duration: 0, title: "Show", series: { id: "tt123", name: "Show", season: 1, episode: 2 }, pending: true, updatedAt: "2026-01-01T00:00:00Z" }]));
      }
      return Promise.resolve(json({}, 404));
    }));

    await act(async () => { root.render(<SeriesProbe path="Shows/Show"/>); });
    await flush();
    await flush();

    expect(host.firstElementChild?.getAttribute("data-next")).toBe(second.path);
  });

  it("does not read a series when no path is open", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await act(async () => { root.render(<SeriesProbe path=""/>); });
    await flush();

    expect(fetch).not.toHaveBeenCalled();
    expect(host.firstElementChild?.getAttribute("data-loading")).toBe("false");
    expect(host.querySelectorAll("[data-path]")).toHaveLength(0);
  });
});
