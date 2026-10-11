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

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  setLocale("en");
  vi.spyOn(api, "homeLayout").mockImplementation(async () => layout());
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
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
    expect(labels()).toEqual(["Continue watching", "Favourites", "Ready to play", "Cinemeta · Popular"]);
    expect([...host.querySelectorAll(".home-layout-add li span")].map((element) => element.textContent)).toEqual(["Extra · Trending"]);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Show Favourites"]')!.checked).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Show Ready to play"]')!.checked).toBe(false);
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
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Add Extra · Trending"]')!.click(); });
    await flushSave();
    expect(update).toHaveBeenCalledWith({ homeLayout: { order: ["resume", "favorites", "completed", movie], hidden: ["completed"], feeds: [homeFeedSelectionKey("extra", "movie", "trending")] } });
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
