import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FavoritesView } from "./FavoritesView";
import { setLocale } from "./i18n";
import type { FavoriteCatalogItem, FavoriteFilter, FavoriteItem, FavoriteLibraryItem } from "./types";

const film = (over: Partial<FavoriteLibraryItem> = {}): FavoriteLibraryItem =>
  ({ kind: "library", path: "lib_00000001/Films/Heat.mkv", label: "Heat", itemKind: "file", ...over });
const show = (): FavoriteLibraryItem => ({ kind: "library", path: "lib_00000001/Shows", label: "Shows", itemKind: "folder" });
const catalog = (): FavoriteCatalogItem => ({ kind: "catalog", type: "movie", id: "tt9", name: "Starred" });

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

type Overrides = Partial<Parameters<typeof FavoritesView>[0]>;

const render = async (over: Overrides = {}) => {
  const props: Parameters<typeof FavoritesView>[0] = {
    filter: "all", onFilter: vi.fn(), items: [], busy: false, shape: "poster",
    onPlay: vi.fn(), onOpenFolder: vi.fn(), onOpenCatalog: vi.fn(),
    hasMore: false, loadingMore: false, onLoadMore: vi.fn(), ...over,
  };
  await act(async () => { root.render(<FavoritesView {...props}/>); });
  return props;
};

const chips = () => [...host.querySelectorAll<HTMLButtonElement>('[role="radiogroup"] button')];
const cards = () => [...host.querySelectorAll<HTMLButtonElement>(".favorites-grid .browse-item")];
const click = async (element: HTMLElement) => { await act(async () => { element.click(); await Promise.resolve(); }); };

describe("FavoritesView", () => {
  it("offers the three filters and reports the chosen one", async () => {
    const { onFilter } = await render({ filter: "all", items: [film()] });
    expect(chips().map((button) => button.textContent)).toEqual(["All", "In library", "From catalog"]);
    expect(chips()[0]!.getAttribute("aria-pressed")).toBe("true");
    await click(chips()[2]!);
    expect(onFilter).toHaveBeenCalledWith("catalog");
  });

  it("opens a library folder, plays a library file and opens a catalogue detail", async () => {
    const folder = show();
    const file = film();
    const star = catalog();
    const { onPlay, onOpenFolder, onOpenCatalog } = await render({ items: [folder, file, star] as FavoriteItem[] });
    expect(cards().map((card) => card.dataset.kind)).toEqual(["favorite-library", "favorite-library", "favorite-catalog"]);
    await click(cards()[0]!);
    expect(onOpenFolder).toHaveBeenCalledWith(folder);
    await click(cards()[1]!);
    expect(onPlay).toHaveBeenCalledWith(file);
    await click(cards()[2]!);
    expect(onOpenCatalog).toHaveBeenCalledWith(star);
  });

  it("names an empty state per filter", async () => {
    const titles = new Map<FavoriteFilter, string>();
    for (const filter of ["all", "library", "catalog"] as FavoriteFilter[]) {
      await render({ filter });
      titles.set(filter, host.querySelector(".empty h3")!.textContent!);
    }
    expect(new Set(titles.values()).size).toBe(3);
  });

  it("offers more only when the server has more", async () => {
    const { onLoadMore } = await render({ items: [film()], hasMore: true });
    expect(host.querySelector(".load-more")).not.toBeNull();
    await click(host.querySelector<HTMLButtonElement>(".load-more button")!);
    expect(onLoadMore).toHaveBeenCalled();
    await render({ items: [film()], hasMore: false });
    expect(host.querySelector(".load-more")).toBeNull();
  });
});
