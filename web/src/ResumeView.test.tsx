import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ResumeView } from "./ResumeView";
import type { HomeCardActions } from "./HomeCard";
import { setLocale } from "./i18n";
import type { ResumeCard, ResumeFilter } from "./types";

const file = (over: Partial<Extract<ResumeCard, { kind: "resume-file" }>> = {}): ResumeCard =>
  ({ kind: "resume-file", key: "file:Films/Heat.mkv", title: "Heat", path: "Films/Heat.mkv", progress: { position: 1, duration: 4 }, updatedAt: "", forgetKeys: ["file:Films/Heat.mkv"], ...over });
const series: ResumeCard = { kind: "resume-catalogue", key: "series:tt2:2:4", title: "Show · Finale", type: "series", id: "tt2", name: "Show", season: 2, episode: 4, progress: { position: 1, duration: 4 }, updatedAt: "", forgetKeys: ["series:tt2:2:4"] };

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

type Overrides = Partial<Parameters<typeof ResumeView>[0]>;

const render = async (over: Overrides = {}) => {
  const actions: HomeCardActions = { play: vi.fn(), open: vi.fn(), reveal: vi.fn(), forget: vi.fn() };
  const props: Parameters<typeof ResumeView>[0] = {
    filter: "all", onFilter: vi.fn(), items: [], busy: false, shape: "wide", actions,
    onToggleShape: vi.fn(), hasMore: false, loadingMore: false, onLoadMore: vi.fn(), ...over,
  };
  await act(async () => { root.render(<ResumeView {...props}/>); });
  return props;
};

const chips = () => [...host.querySelectorAll<HTMLButtonElement>('[role="radiogroup"] button')];
const cards = () => [...host.querySelectorAll<HTMLButtonElement>(".browse-grid .browse-item")];
const click = async (element: HTMLElement) => { await act(async () => { element.click(); await Promise.resolve(); }); };

describe("ResumeView", () => {
  it("offers library, catalogue and remote filters and reports the chosen one", async () => {
    const { onFilter } = await render({ filter: "all", items: [file()] });
    expect(chips().map((button) => button.textContent)).toEqual(["All", "In library", "From catalog", "Media servers"]);
    expect(chips()[0]!.getAttribute("aria-pressed")).toBe("true");
    await click(chips()[1]!);
    expect(onFilter).toHaveBeenCalledWith("library");
    await click(chips()[3]!);
    expect(onFilter).toHaveBeenCalledWith("remote");
  });

  it("draws the Favourites grid and reports the page shape setting", async () => {
    const { onToggleShape } = await render({ items: [file()], shape: "poster" });
    expect(host.querySelector(".browse-grid")!.classList.contains("section-grid")).toBe(true);
    expect(host.querySelector(".browse-grid")!.classList.contains("tile-shape-poster")).toBe(true);
    const toggle = host.querySelector<HTMLButtonElement>(".shape-toggle")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await click(toggle);
    expect(onToggleShape).toHaveBeenCalledTimes(1);
  });

  it("plays a library card and opens the episode a catalogue card remembers", async () => {
    const actions = { play: vi.fn(), open: vi.fn(), reveal: vi.fn(), forget: vi.fn() } as HomeCardActions;
    await render({ items: [file(), series], actions });
    expect(cards().map((card) => card.dataset.kind)).toEqual(["resume-file", "resume-catalogue"]);
    await click(cards()[0]!.querySelector<HTMLButtonElement>(".browse-open")!);
    expect(actions.play).toHaveBeenCalledWith(expect.objectContaining({ kind: "resume-file", key: "file:Films/Heat.mkv" }));
    await click(cards()[1]!.querySelector<HTMLButtonElement>(".browse-open")!);
    expect(actions.open).toHaveBeenCalledWith(expect.objectContaining({ kind: "resume-catalogue", key: "series:tt2:2:4" }));
  });

  it("forgets every key a card stands for from its menu", async () => {
    const actions = { play: vi.fn(), open: vi.fn(), reveal: vi.fn(), forget: vi.fn() } as HomeCardActions;
    await render({ items: [file({ forgetKeys: ["file:Films/Heat.mkv", "movie:tt1"] })], actions });
    await click(cards()[0]!.querySelector<HTMLButtonElement>(".browse-menu")!);
    const button = [...host.querySelectorAll<HTMLButtonElement>(".home-actions button")].find((entry) => entry.textContent?.includes("Forget progress"));
    expect(button).toBeTruthy();
    await click(button!);
    expect(actions.forget).toHaveBeenCalledWith(expect.objectContaining({ forgetKeys: ["file:Films/Heat.mkv", "movie:tt1"] }));
  });

  it("names an empty state per filter", async () => {
    const titles = new Map<ResumeFilter, string>();
    for (const filter of ["all", "library", "catalog"] as ResumeFilter[]) {
      await render({ filter });
      titles.set(filter, host.querySelector(".empty h3")!.textContent!);
    }
    expect(new Set(titles.values()).size).toBe(3);
  });

  it("offers more only when the server has more", async () => {
    const { onLoadMore } = await render({ items: [file()], hasMore: true });
    expect(host.querySelector(".load-more")).not.toBeNull();
    await click(host.querySelector<HTMLButtonElement>(".load-more button")!);
    expect(onLoadMore).toHaveBeenCalled();
    await render({ items: [file()], hasMore: false });
    expect(host.querySelector(".load-more")).toBeNull();
  });
});
