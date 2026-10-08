import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LibraryShelf } from "./LibraryShelf";
import { setLocale } from "./i18n";
import type { BrowseResult, FollowView, NewEpisode } from "./types";

const at = "2026-01-01T00:00:00.000Z";
const episode = (): NewEpisode => ({ followId: "f", type: "series", metaId: "tt1", name: "Show", videoId: "v1", season: 1, episode: 2, released: "2026-10-03T00:00:00Z" });
const follow = (): FollowView => ({
  id: "f", ownerUserId: "usr_00000001", type: "series", metaId: "tt1", name: "Show",
  createdAt: at, updatedAt: at, enabled: true, revision: 1, nextCheckAt: at, failures: 0, episodeCount: 1,
  downloads: { queued: 0, waiting: 0, completed: 0, skipped: 0, attention: 0 },
});
const favorites = (): BrowseResult => ({
  path: ":favorites", total: 1, pending: false,
  items: [{ kind: "file", path: "lib_00000001/Film.mkv", label: "Film", season: null, episode: null, size: 0, modified: at }],
});
const resumeItem = () => ({ key: "file:lib_00000001/A.mkv", path: "lib_00000001/A.mkv", title: "A", position: 1, duration: 4 });

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

type Overrides = Partial<Parameters<typeof LibraryShelf>[0]>;

const render = async (over: Overrides = {}) => {
  const props: Parameters<typeof LibraryShelf>[0] = {
    segment: "resume", showResume: true, resume: [], resumeTotal: 0, episodes: [], follows: [], favorites: null,
    onSegment: vi.fn(), onPlayResume: vi.fn(), onRevealResume: vi.fn(), onOpenEpisode: vi.fn(), onOpenFavorite: vi.fn(),
    onShowResume: vi.fn(), onShowEpisodes: vi.fn(), onShowFavorites: vi.fn(), ...over,
  };
  await act(async () => { root.render(<LibraryShelf {...props}/>); });
  return props;
};

const segments = () => [...host.querySelectorAll<HTMLButtonElement>('[role="radiogroup"] button')];
const showAll = () => host.querySelector<HTMLButtonElement>(".resume-show-all")!;
const click = async (element: HTMLElement) => { await act(async () => { element.click(); await Promise.resolve(); }); };

describe("LibraryShelf", () => {
  it("shows all three segments when Continue is allowed", async () => {
    await render({ segment: "resume", showResume: true, resume: [resumeItem()] });
    expect(segments().map((button) => button.textContent)).toEqual(["Continue", "New episodes", "Favourites"]);
    expect(segments()[0].getAttribute("aria-pressed")).toBe("true");
  });

  it("reports a segment click to the caller", async () => {
    const { onSegment } = await render({ segment: "resume", favorites: favorites() });
    await click(segments()[2]);
    expect(onSegment).toHaveBeenCalledWith("favorites");
  });

  it("shows all calls the callback of the displayed segment", async () => {
    const resume = await render({ segment: "resume", resume: [resumeItem()] });
    await click(showAll());
    expect(resume.onShowResume).toHaveBeenCalled();

    const episodes = await render({ segment: "episodes", follows: [follow()], episodes: [episode()] });
    expect(showAll().textContent).toContain("Followed series (1)");
    await click(showAll());
    expect(episodes.onShowEpisodes).toHaveBeenCalled();

    const favourite = await render({ segment: "favorites", favorites: favorites() });
    await click(showAll());
    expect(favourite.onShowFavorites).toHaveBeenCalled();
  });

  it("opens the resume menu onto reveal and plays a card", async () => {
    const { onPlayResume, onRevealResume } = await render({ segment: "resume", resume: [resumeItem()] });
    await click(host.querySelector<HTMLButtonElement>(".browse-item")!);
    expect(onPlayResume).toHaveBeenCalledWith(expect.objectContaining({ path: "lib_00000001/A.mkv" }));
    await click(host.querySelector<HTMLButtonElement>(".browse-menu")!);
    await click([...host.querySelectorAll<HTMLButtonElement>(".browse-actions button")][0]!);
    expect(onRevealResume).toHaveBeenCalledWith("lib_00000001/A.mkv");
  });

  it("opens a favourite on click", async () => {
    const { onOpenFavorite } = await render({ segment: "favorites", favorites: favorites() });
    await click(host.querySelector<HTMLButtonElement>(".resume-strip .browse-item")!);
    expect(onOpenFavorite).toHaveBeenCalledWith(expect.objectContaining({ path: "lib_00000001/Film.mkv" }));
  });

  it("hides Continue, displays Favourites and does not write a preference", async () => {
    const onSegment = vi.fn();
    await render({ segment: "resume", showResume: false, favorites: favorites(), onSegment });
    expect(segments().map((button) => button.textContent)).toEqual(["New episodes", "Favourites"]);
    expect(segments()[1].getAttribute("aria-pressed")).toBe("true");
    expect(onSegment).not.toHaveBeenCalled();
    expect(host.querySelector(".resume-strip")!.textContent).toContain("Film");
  });

  it("renders nothing when every source is empty and Continue is hidden", async () => {
    await render({ showResume: false });
    expect(host.querySelector(".library-shelf")).toBeNull();
  });

  it("names the empty displayed segment", async () => {
    await render({ segment: "episodes", follows: [follow()], episodes: [] });
    expect(host.querySelector(".library-shelf")!.textContent).toContain("No new episodes");
    await render({ segment: "favorites", follows: [follow()], favorites: { path: ":favorites", total: 0, pending: false, items: [] } });
    expect(host.querySelector(".library-shelf")!.textContent).toContain("No favourites yet");
  });
});
