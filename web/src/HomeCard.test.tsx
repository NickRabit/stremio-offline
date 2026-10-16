import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HomeCard } from "./HomeCard";
import { setLocale } from "./i18n";
import type { HomeCard as HomeCardData } from "../../server/src/home";

const at = "2026-01-01T00:00:00.000Z";
const episode = (over: Partial<Extract<HomeCardData, { kind: "episode" }>> = {}): HomeCardData => ({
  kind: "episode", key: "episode:f:1", followId: "f", type: "series", metaId: "tt2", name: "Show",
  poster: "/poster.jpg", season: 2, episode: 4, released: at, ...over,
});
const catalogueStar = (over: Partial<Extract<HomeCardData, { kind: "favorite-catalogue" }>> = {}): HomeCardData => ({
  kind: "favorite-catalogue", key: "series:tt2", type: "series", id: "tt2", name: "Show", poster: "/poster.jpg", ...over,
});
const resumeFile = (over: Partial<Extract<HomeCardData, { kind: "resume-file" }>> = {}): HomeCardData => ({
  kind: "resume-file", key: "file:fil_1/Films/Heat.mkv", title: "Heat", path: "Films/Heat.mkv",
  progress: { position: 30, duration: 600 }, updatedAt: at, forgetKeys: ["file:fil_1/Films/Heat.mkv"], ...over,
});
const resumeCatalogue = (over: Partial<Extract<HomeCardData, { kind: "resume-catalogue" }>> = {}): HomeCardData => ({
  kind: "resume-catalogue", key: "movie:tt9", title: "Heat", type: "movie", id: "tt9", name: "Heat",
  progress: { position: 30, duration: 600 }, updatedAt: at, forgetKeys: ["movie:tt9"], ...over,
});
const favorite = (over: Partial<Extract<HomeCardData, { kind: "favorite" }>> = {}): HomeCardData => ({
  kind: "favorite", key: "Films/Heat", path: "Films/Heat", itemKind: "folder", label: "Heat", ...over,
});
const tonight = (over: Partial<Extract<HomeCardData, { kind: "tonight" }>> = {}): HomeCardData => ({
  kind: "tonight", key: "Films/Heat", path: "Films/Heat", itemKind: "folder", label: "Heat",
  year: "1995", libraryId: "lib_00000001", ...over,
});

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
});

const render = (card: HomeCardData) => {
  const actions = { play: vi.fn(), open: vi.fn(), reveal: vi.fn(), forget: vi.fn() };
  act(() => root.render(<HomeCard card={card} shape="wide" actions={actions}/>));
  return actions;
};
const picture = () => host.querySelector<HTMLImageElement>(".browse-art img:not(.tile-blur)");
const loads = (node: HTMLImageElement, width: number, height: number) => {
  Object.defineProperty(node, "naturalWidth", { value: width, configurable: true });
  Object.defineProperty(node, "naturalHeight", { value: height, configurable: true });
  act(() => node.dispatchEvent(new Event("load")));
};

describe("HomeCard wide tiles", () => {
  it("draws the wide picture of a new episode and of a catalogue star", () => {
    render(episode({ wide: "/episode-wide.jpg" }));
    expect(picture()!.getAttribute("src")).toBe("/episode-wide.jpg");
    render(catalogueStar({ wide: "/catalogue-wide.jpg" }));
    expect(picture()!.getAttribute("src")).toBe("/catalogue-wide.jpg");
  });

  it("letterboxes the portrait poster when the card has no wide picture at all", () => {
    render(episode());
    expect(picture()!.getAttribute("src")).toBe("/poster.jpg");
    loads(picture()!, 400, 600);
    expect(picture()!.classList.contains("tile-fit")).toBe(true);
    render(catalogueStar());
    loads(picture()!, 400, 600);
    expect(picture()!.classList.contains("tile-fit")).toBe(true);
  });

  it("opens the shared detail for a new episode and a catalogue star", () => {
    const card = episode();
    const actions = render(card);
    host.querySelector<HTMLButtonElement>(".browse-open")!.click();
    expect(actions.open).toHaveBeenCalledWith(card);
  });

  it("plays a catalogue card that names the library file it was written from", () => {
    const withFile = resumeCatalogue({ path: "Films/Heat.mkv" });
    const actions = render(withFile);
    host.querySelector<HTMLButtonElement>(".browse-open")!.click();
    expect(actions.play).toHaveBeenCalledWith(withFile);

    // A row with no file behind it has nothing to play and opens its detail instead.
    const without = resumeCatalogue();
    const other = render(without);
    host.querySelector<HTMLButtonElement>(".browse-open")!.click();
    expect(other.play).not.toHaveBeenCalled();
    expect(other.open).toHaveBeenCalledWith(without);
  });

  it("offers the detail of a bound file and of every catalogue card", () => {
    // The card keeps its own menu state, so a rerender of the same host leaves it as it was.
    const openMenu = () => {
      const button = host.querySelector<HTMLButtonElement>(".browse-menu")!;
      if (button.getAttribute("aria-expanded") !== "true") act(() => button.click());
    };
    const bound = resumeFile({ identity: { type: "movie", id: "tt9" } });
    const actions = render(bound);
    const openDetail = () => [...host.querySelectorAll<HTMLButtonElement>(".home-actions button")].find((button) => button.textContent?.includes("Open detail"));
    openMenu();
    expect(openDetail()).toBeTruthy();
    act(() => openDetail()!.click());
    expect(actions.open).toHaveBeenCalledWith(bound);

    // An unbound file has no title to open.
    render(resumeFile());
    openMenu();
    expect(openDetail()).toBeUndefined();

    const catalogue = resumeCatalogue();
    const rows = render(catalogue);
    openMenu();
    expect(openDetail()).toBeTruthy();
    act(() => openDetail()!.click());
    expect(rows.open).toHaveBeenCalledWith(catalogue);
  });

  it("opens the title of a favourite bound to one, and the folder or file otherwise", () => {
    const bound = favorite({ title: { type: "movie", id: "tt9" } });
    const actions = render(bound);
    host.querySelector<HTMLButtonElement>(".browse-open")!.click();
    expect(actions.open).toHaveBeenCalledWith(bound);
    expect(actions.reveal).not.toHaveBeenCalled();

    const loose = favorite();
    const other = render(loose);
    host.querySelector<HTMLButtonElement>(".browse-open")!.click();
    expect(other.reveal).toHaveBeenCalledWith("Films/Heat");
  });

  it("opens the title of a Tonight card bound to one, and the folder otherwise", () => {
    const bound = tonight({ title: { type: "movie", id: "tt9" } });
    const actions = render(bound);
    host.querySelector<HTMLButtonElement>(".browse-open")!.click();
    expect(actions.open).toHaveBeenCalledWith(bound);
    expect(actions.reveal).not.toHaveBeenCalled();

    const loose = tonight();
    const other = render(loose);
    host.querySelector<HTMLButtonElement>(".browse-open")!.click();
    expect(other.reveal).toHaveBeenCalledWith("Films/Heat");
  });
});
