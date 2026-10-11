import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "./api";
import { HOME_LAYOUT_SAVE_MS, HomeLayoutSettings } from "./HomeLayoutSettings";
import { setLocale } from "./i18n";
import { homeCatalogRowId, homeFeedSelectionKey, type HomeLayoutResponse } from "../../server/src/home";

const movie = homeCatalogRowId("cinemeta", "movie", "top");
const trending = homeCatalogRowId("extra", "movie", "trending");

const layout = (): HomeLayoutResponse => ({
  rows: [
    { id: "resume", kind: "builtin", label: "home.continue", shown: true, position: 0, added: true },
    { id: "favorites", kind: "builtin", label: "home.favorites", shown: true, position: 1, added: true },
    { id: "completed", kind: "builtin", label: "home.readyToPlay", shown: false, position: 2, added: true },
    { id: movie, kind: "feed", label: "Cinemeta · Popular", shown: true, position: 3, added: true },
    { id: trending, kind: "feed", label: "Extra · Trending", shown: false, position: 4, added: false },
  ],
  layout: { order: ["resume", "favorites", "completed", movie], hidden: ["completed"], feeds: [] },
});

let root: Root;
let host: HTMLDivElement;
let mounted = true;
let homeLayout: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  setLocale("en");
  mounted = true;
  homeLayout = vi.spyOn(api, "homeLayout").mockImplementation(async () => layout());
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  if (mounted) act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const render = async (disabled = false) => {
  await act(async () => { root.render(<HomeLayoutSettings disabled={disabled} onError={vi.fn()}/>); });
};

const flushSave = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(HOME_LAYOUT_SAVE_MS + 20); }); };
const labels = () => [...host.querySelectorAll(".home-layout-row .home-layout-label")].map((element) => element.textContent);

describe("HomeLayoutSettings", () => {
  it("renders the arranged rows and the catalogues that could be added", async () => {
    await render();
    expect(labels()).toEqual(["Continue watching", "Favourites", "Ready to play", "Cinemeta · Popular (movie)"]);
    expect([...host.querySelectorAll(".home-layout-add li span")].map((element) => element.textContent)).toEqual(["Extra · Trending (movie)"]);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Show Favourites"]')!.checked).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Show Ready to play"]')!.checked).toBe(false);
  });

  it("tells two catalogues of the same name apart by their type", async () => {
    const movieTop = homeCatalogRowId("cinemeta", "movie", "top");
    const seriesTop = homeCatalogRowId("cinemeta", "series", "top");
    homeLayout.mockResolvedValueOnce({
      rows: [
        { id: movieTop, kind: "feed", label: "Cinemeta · Popular", shown: true, position: 0, added: true },
        { id: seriesTop, kind: "feed", label: "Cinemeta · Popular", shown: true, position: 1, added: true },
      ],
      layout: { order: [movieTop, seriesTop], hidden: [], feeds: [] },
    });
    await render();
    expect(labels()).toEqual(["Cinemeta · Popular (movie)", "Cinemeta · Popular (series)"]);
  });

  it("hides a row when its switch is turned off", async () => {
    const update = vi.spyOn(api, "updateSettings").mockResolvedValue({} as never);
    await render();
    await act(async () => { host.querySelector<HTMLInputElement>('input[aria-label="Show Favourites"]')!.click(); });
    await flushSave();
    expect(update).toHaveBeenCalledWith({ homeLayout: { order: ["resume", "favorites", "completed", movie], hidden: ["completed", "favorites"], feeds: [] } });
  });

  it("saves the new order when a row is moved up", async () => {
    const update = vi.spyOn(api, "updateSettings").mockResolvedValue({} as never);
    await render();
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Move Favourites up"]')!.click(); });
    await flushSave();
    expect(update).toHaveBeenCalledWith({ homeLayout: { order: ["favorites", "resume", "completed", movie], hidden: ["completed"], feeds: [] } });
  });

  it("adds a catalogue feed the account could use", async () => {
    const update = vi.spyOn(api, "updateSettings").mockResolvedValue({} as never);
    await render();
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Add Extra · Trending (movie)"]')!.click(); });
    await flushSave();
    expect(update).toHaveBeenCalledWith({ homeLayout: { order: ["resume", "favorites", "completed", movie], hidden: ["completed"], feeds: [homeFeedSelectionKey("extra", "movie", "trending")] } });
  });

  it("sends a change that was still waiting when the section unmounts", async () => {
    const update = vi.spyOn(api, "updateSettings").mockResolvedValue({} as never);
    await render();
    await act(async () => { host.querySelector<HTMLInputElement>('input[aria-label="Show Favourites"]')!.click(); });
    expect(update).not.toHaveBeenCalled();
    mounted = false;
    await act(async () => { root.unmount(); });
    expect(update).toHaveBeenCalledWith({ homeLayout: { order: ["resume", "favorites", "completed", movie], hidden: ["completed", "favorites"], feeds: [] } });
  });

  it("does not let a slow reload overwrite a newer edit", async () => {
    let release: ((value: HomeLayoutResponse) => void) | undefined;
    const slow = new Promise<HomeLayoutResponse>((resolve) => { release = resolve; });
    homeLayout.mockResolvedValueOnce(layout());
    homeLayout.mockReturnValueOnce(slow);
    vi.spyOn(api, "updateSettings").mockResolvedValue({} as never);
    await render();
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Move Favourites up"]')!.click(); });
    await flushSave();
    await act(async () => { host.querySelector<HTMLInputElement>('input[aria-label="Show Ready to play"]')!.click(); });
    await act(async () => { release!(layout()); await Promise.resolve(); });
    expect(labels()).toEqual(["Favourites", "Continue watching", "Ready to play", "Cinemeta · Popular (movie)"]);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Show Ready to play"]')!.checked).toBe(true);
  });

  it("offers confirm only a show/hide switch, with no move buttons", async () => {
    homeLayout.mockResolvedValueOnce({
      rows: [
        { id: "resume", kind: "builtin", label: "home.continue", shown: true, position: 0, added: true },
        { id: "confirm", kind: "builtin", label: "home.toConfirm", shown: true, position: 1, added: true },
        { id: "favorites", kind: "builtin", label: "home.favorites", shown: true, position: 2, added: true },
      ],
      layout: { order: ["resume", "confirm", "favorites"], hidden: [], feeds: [] },
    });
    await render();
    const byLabel = (text: string) => [...host.querySelectorAll<HTMLLIElement>(".home-layout-row")]
      .find((element) => element.querySelector(".home-layout-label")!.textContent === text)!;
    expect(byLabel("To confirm").querySelectorAll("button").length).toBe(0);
    expect(byLabel("To confirm").querySelector('input[role="switch"]')).not.toBeNull();
    expect(byLabel("Favourites").querySelectorAll("button").length).toBe(2);
  });

  it("clears the layout on reset", async () => {
    const update = vi.spyOn(api, "updateSettings").mockResolvedValue({} as never);
    await render();
    await act(async () => { host.querySelector<HTMLButtonElement>(".home-layout-section .setting-actions button")!.click(); });
    expect(update).toHaveBeenCalledWith({ homeLayout: null });
  });

  it("disables its controls for a restricted account", async () => {
    await render(true);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Show Favourites"]')!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Move Favourites up"]')!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>(".home-layout-section .setting-actions button")!.disabled).toBe(true);
  });
});
