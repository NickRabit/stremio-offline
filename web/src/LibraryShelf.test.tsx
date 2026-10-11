import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LibraryShelf } from "./LibraryShelf";
import { setLocale } from "./i18n";
import type { FollowView, NewEpisode } from "./types";

const at = "2026-01-01T00:00:00.000Z";
const episode = (): NewEpisode => ({ followId: "f", type: "series", metaId: "tt1", name: "Show", videoId: "v1", season: 1, episode: 2, released: "2026-10-03T00:00:00Z" });
const follow = (): FollowView => ({
  id: "f", ownerUserId: "usr_00000001", type: "series", metaId: "tt1", name: "Show",
  createdAt: at, updatedAt: at, enabled: true, revision: 1, nextCheckAt: at, failures: 0, episodeCount: 1,
  downloads: { queued: 0, waiting: 0, completed: 0, skipped: 0, attention: 0 },
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
    segment: "resume", showResume: true, resume: [], resumeTotal: 0, episodes: [], follows: [],
    onSegment: vi.fn(), onPlayResume: vi.fn(), onRevealResume: vi.fn(), onOpenEpisode: vi.fn(),
    onShowResume: vi.fn(), onShowEpisodes: vi.fn(), ...over,
  };
  await act(async () => { root.render(<LibraryShelf {...props}/>); });
  return props;
};

const segments = () => [...host.querySelectorAll<HTMLButtonElement>('[role="radiogroup"] button')];
const showAll = () => host.querySelector<HTMLButtonElement>(".resume-show-all")!;
const click = async (element: HTMLElement) => { await act(async () => { element.click(); await Promise.resolve(); }); };

describe("LibraryShelf", () => {
  it("shows Continue and New episodes when Continue is allowed, and no Favourites segment", async () => {
    await render({ segment: "resume", showResume: true, resume: [resumeItem()] });
    expect(segments().map((button) => button.textContent)).toEqual(["Continue", "New episodes"]);
    expect(segments()[0].getAttribute("aria-pressed")).toBe("true");
  });

  it("reports a segment click to the caller and reads an old favourites choice harmlessly", async () => {
    const { onSegment } = await render({ segment: "resume", follows: [follow()], episodes: [episode()] });
    await click(segments()[1]);
    expect(onSegment).toHaveBeenCalledWith("episodes");
    await render({ segment: "favorites", showResume: false, follows: [follow()], episodes: [episode()] });
    expect(segments().map((button) => button.textContent)).toEqual(["New episodes"]);
    expect(segments()[0].getAttribute("aria-pressed")).toBe("true");
  });

  it("shows all calls the callback of the displayed segment", async () => {
    const resume = await render({ segment: "resume", resume: [resumeItem()] });
    await click(showAll());
    expect(resume.onShowResume).toHaveBeenCalled();

    const episodes = await render({ segment: "episodes", follows: [follow()], episodes: [episode()] });
    expect(showAll().textContent).toContain("Followed series (1)");
    await click(showAll());
    expect(episodes.onShowEpisodes).toHaveBeenCalled();
  });

  it("opens the resume menu onto reveal and plays a card", async () => {
    const { onPlayResume, onRevealResume } = await render({ segment: "resume", resume: [resumeItem()] });
    await click(host.querySelector<HTMLButtonElement>(".browse-item")!);
    expect(onPlayResume).toHaveBeenCalledWith(expect.objectContaining({ path: "lib_00000001/A.mkv" }));
    await click(host.querySelector<HTMLButtonElement>(".browse-menu")!);
    await click([...host.querySelectorAll<HTMLButtonElement>(".browse-actions button")][0]!);
    expect(onRevealResume).toHaveBeenCalledWith("lib_00000001/A.mkv");
  });

  it("hides Continue, displays New episodes and does not write a preference", async () => {
    const onSegment = vi.fn();
    await render({ segment: "resume", showResume: false, follows: [follow()], episodes: [episode()], onSegment });
    expect(segments().map((button) => button.textContent)).toEqual(["New episodes"]);
    expect(segments()[0].getAttribute("aria-pressed")).toBe("true");
    expect(onSegment).not.toHaveBeenCalled();
    expect(host.querySelector(".resume-strip")!.textContent).toContain("Show");
  });

  it("renders nothing when every source is empty and Continue is hidden", async () => {
    await render({ showResume: false });
    expect(host.querySelector(".library-shelf")).toBeNull();
  });

  it("names the empty displayed segment", async () => {
    await render({ segment: "episodes", follows: [follow()], episodes: [] });
    expect(host.querySelector(".library-shelf")!.textContent).toContain("No new episodes");
    await render({ segment: "favorites", showResume: true, resume: [], follows: [follow()] });
    expect(host.querySelector(".library-shelf")!.textContent).toContain("Nothing to continue");
  });
});
