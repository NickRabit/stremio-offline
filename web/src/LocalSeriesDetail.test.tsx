import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { episodeFiles, episodeName, LocalSeriesDetail, nextEpisode } from "./LocalSeriesDetail";
import { setLocale } from "./i18n";
import { clearTitleEnrichment } from "./title-enrichment";
import { clearTitleExtras } from "./title-extras";
import type { BrowseFile, BrowseFolder, IdentityPreview } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const episode = (path: string, season: number, number: number, over: Partial<BrowseFile> = {}): BrowseFile => ({
  path, label: `Show - S${String(season).padStart(2, "0")}E${String(number).padStart(2, "0")} - Episode ${number}`,
  season, episode: number, size: 1_000_000_000, modified: "2026-09-01", ...over,
});

const show: BrowseFolder = {
  path: "Shows/Show", name: "Show", fileCount: 3, size: 3_000_000_000,
  match: "matched", titleType: "series",
};

const identity: IdentityPreview = {
  path: show.path, key: show.path, kind: "series", file: false, label: show.name,
  parsed: { title: show.name, query: show.name }, match: "matched",
  bound: { type: "series", id: "tt-show", name: show.name },
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("cs");
  clearTitleEnrichment();
  clearTitleExtras();
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

describe("LocalSeriesDetail episodes", () => {
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

  it("reads the episode title out of a numbered file name", () => {
    expect(episodeName({ ...episode("", 1, 2), label: "Show - S01E02 - The Pilot (2)" })).toBe("The Pilot");
  });
});

describe("LocalSeriesDetail", () => {
  beforeEach(() => {
    const first = episode("Shows/Show/Season 1/Show - S01E01 - First.mkv", 1, 1, {
      progress: { position: 100, duration: 100 },
    });
    const second = episode("Shows/Show/Season 1/Show - S01E02 - Second.mkv", 1, 2, {
      progress: { position: 40, duration: 100 },
    });
    const third = episode("Shows/Show/Season 2/Show - S02E01 - Third.mkv", 2, 1);
    const folders = [
      { kind: "folder", path: "Shows/Show/Season 1", name: "Season 1", fileCount: 2, size: 2_000_000_000 },
      { kind: "folder", path: "Shows/Show/Season 2", name: "Season 2", fileCount: 1, size: 1_000_000_000 },
    ] as const;

    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/library/identity") return Promise.resolve(json(identity));
      if (url.pathname === "/api/library/links") return Promise.resolve(json({ links: [] }));
      if (url.pathname === "/api/library/trailer") return Promise.resolve(json({ trailer: null }));
      if (url.pathname === "/api/library/browse") {
        const path = url.searchParams.get("path");
        const items = path === show.path ? folders
          : path === folders[0].path ? [{ kind: "file", ...first }, { kind: "file", ...second }]
            : path === folders[1].path ? [{ kind: "file", ...third }]
              : [];
        return Promise.resolve(json({ path, items, total: items.length, pending: false }));
      }
      if (url.pathname.endsWith("/extras")) return Promise.resolve(json({ people: [], related: [], source: "addon" }));
      return Promise.resolve(json({}, 404));
    }));
  });

  it("groups episodes by season and resumes the part-way episode", async () => {
    const onPlayEpisode = vi.fn();
    const onOpenEpisode = vi.fn();
    const props = {
      folder: show, favorite: false, onToggleFavorite: vi.fn(), onOpenEpisode, onPlayEpisode,
      uiLanguage: "cs", secureMode: true, onTrailer: vi.fn(), tileShape: "poster" as const,
    };

    await act(async () => { root.render(<LocalSeriesDetail {...props}/>); });
    await flush();
    await flush();

    expect([...host.querySelectorAll(".remote-season")].map((node) => node.textContent)).toEqual(["Série 1", "Série 2"]);
    expect(host.querySelectorAll(".remote-season-group .browse-item")).toHaveLength(3);

    const primary = host.querySelector<HTMLButtonElement>(".library-detail-play button.primary")!;
    expect(primary.textContent?.trim()).toBe("Pokračovat · S1 E2");
    await click(primary);
    expect(onPlayEpisode).toHaveBeenCalledWith(
      expect.objectContaining({ path: "Shows/Show/Season 1/Show - S01E02 - Second.mkv" }),
      false,
      { type: "series", id: "tt-show" },
    );

    await click(host.querySelector('[data-path="Shows/Show/Season 1/Show - S01E01 - First.mkv"] .library-open'));
    expect(onOpenEpisode).toHaveBeenCalledWith(expect.objectContaining({
      path: "Shows/Show/Season 1/Show - S01E01 - First.mkv",
    }));
  });
});
