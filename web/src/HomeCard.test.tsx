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
});
