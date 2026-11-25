import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CatalogFilters, type CatalogFiltersProps } from "./CatalogFilters";
import { setLocale, t } from "./i18n";
import { defaultCatalogView } from "./views";
import type { Catalog } from "./types";

const catalog = (
  addonKey: string,
  addonName: string,
  type: string,
  id: string,
  name: string,
  extra?: Catalog["extra"],
  extraRequired?: string[],
): Catalog => ({
  addonKey, addonName, type, id, name,
  ...(extra ? { extra } : {}),
  ...(extraRequired ? { extraRequired } : {}),
});

const catalogs: Catalog[] = [
  catalog("cinemeta", "Cinemeta", "movie", "top", "Top", [{ name: "genre", options: ["Action", "Drama"] }]),
  catalog("cinemeta", "Cinemeta", "series", "top", "Top", [{ name: "genre", options: ["Action", "Drama"] }]),
  catalog("cinemeta", "Cinemeta", "series", "last-videos", "Last videos", undefined, ["lastVideosIds"]),
  catalog("cz", "CZ", "movie", "nfx", "Netflix", [{ name: "genre", options: ["Action", "Komedie"] }]),
  catalog("cz", "CZ", "series", "nfx", "Netflix", [{ name: "genre", options: ["Action", "Komedie"] }]),
  catalog("webshare", "WebShare", "movie", "m-4k", "4K movies"),
  catalog("webshare", "WebShare", "series", "s", "Series"),
  catalog("tv", "TV addon", "tv", "channels", "Channels"),
];

const current = catalogs[0]!;
let root: Root;
let host: HTMLDivElement;

const render = async (overrides: Partial<CatalogFiltersProps> = {}) => {
  const props: CatalogFiltersProps = {
    catalogs,
    current,
    genre: "",
    prefs: defaultCatalogView(),
    logos: {},
    compact: false,
    sortLabel: "",
    onPickCatalog: vi.fn(),
    onBucket: vi.fn(),
    onGenre: vi.fn(),
    onPrefs: vi.fn(),
    ...overrides,
  };
  await act(async () => { root.render(<CatalogFilters {...props}/>); });
  return props;
};

const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find((node) => node.getAttribute("aria-label") === label || (node.textContent ?? "").startsWith(label));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
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

describe("CatalogFilters", () => {
  it("shows the present buckets and switches type", async () => {
    const props = await render();
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".catalog-type-switch button")];
    expect(buttons.map((node) => node.textContent)).toEqual([
      t("catalog.movies"), t("catalog.series"), t("catalog.typeOther"),
    ]);
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => { buttons[1]?.click(); });
    expect(props.onBucket).toHaveBeenCalledWith("series");
  });

  it("names the catalog trigger and summarises the compact state", async () => {
    await render({ genre: "Action", sortLabel: t("catalog.sortName") });
    const trigger = button(t("catalog.browse"))!;
    expect(trigger.textContent).toContain("Top");
    expect(trigger.textContent).toContain("Cinemeta");

    await render({ compact: true, genre: "Action", sortLabel: t("catalog.sortName") });
    expect(button(t("catalog.browse"))?.textContent)
      .toContain("Movies · Action · Name");
  });

  it("disables genre when the catalog has none", async () => {
    await render({ current: catalogs.find((item) => item.id === "m-4k")! });
    const genre = button(t("catalog.genre"))!;
    expect(genre.disabled).toBe(true);
    expect(genre.textContent).toContain(t("catalog.genreNone"));
  });

  it("shows a paused sticky genre and picks a replacement", async () => {
    const props = await render({ genre: "Missing" });
    const genre = button(t("catalog.genre"))!;
    expect(genre.textContent).toContain(t("catalog.allGenres"));
    expect(genre.textContent).toContain(t("catalog.genrePaused", { genre: "Missing" }));

    await act(async () => { genre.click(); });
    const action = [...host.querySelectorAll<HTMLButtonElement>(".picker-option")]
      .find((node) => node.textContent?.includes("Action"))!;
    await act(async () => { action.click(); });
    expect(props.onGenre).toHaveBeenCalledWith("Action");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("picks a catalog row and closes the picker", async () => {
    const props = await render();
    await act(async () => { button(t("catalog.browse"))?.click(); });
    const netflix = [...host.querySelectorAll<HTMLButtonElement>(".picker-option")]
      .find((node) => node.textContent?.includes("Netflix"))!;
    await act(async () => { netflix.click(); });
    expect(props.onPickCatalog).toHaveBeenCalledWith({ addonKey: "cz", type: "movie", id: "nfx" });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("ignores stored addon keys that are absent from the catalog list", async () => {
    const props = await render({
      prefs: {
        ...defaultCatalogView(),
        hiddenAddons: ["ghost"],
        recent: [{ addonKey: "ghost", type: "movie", id: "missing" }],
        last: { addonKey: "ghost", type: "movie", id: "missing", genre: "" },
      },
    });
    await act(async () => { button(t("catalog.browse"))?.click(); });
    expect(host.textContent).not.toContain("Ghost");
    expect(host.querySelector(".picker-chip")).toBeNull();
    expect(host.querySelector(".picker-badge")).toBeNull();
    expect(props.onPickCatalog).not.toHaveBeenCalled();
  });
});
