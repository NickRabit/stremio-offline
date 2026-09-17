import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SeriesDownloadDialog } from "./SeriesDownloadDialog";
import { setLocale } from "./i18n";

let fetchMock: ReturnType<typeof vi.fn>;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([
    { key: "first", name: "First" }, { key: "second", name: "Second" },
  ]), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("SeriesDownloadDialog", () => {
  it("submits ordered sources and per-batch language choices", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Season 1" episodes={[{ id: "tt1:1:1" }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }, { code: "en", name: "English" }]} onClose={() => undefined} onSubmit={onSubmit}/>); });
    await act(async () => { await Promise.resolve(); });
    const priorityStrategy = host.querySelector<HTMLInputElement>('input[name="source-strategy"][value="priority"]')!;
    expect(host.querySelector<HTMLInputElement>('input[name="source-strategy"][value="largest"]')!.checked).toBe(true);
    await act(async () => { priorityStrategy.click(); });
    const down = host.querySelector<HTMLButtonElement>('button[aria-label="Move First down"]')!;
    await act(async () => { down.click(); });
    const subtitleMode = [...host.querySelectorAll("select")].find((select) => [...select.options].some((option) => option.value === "required"))!;
    await act(async () => { subtitleMode.value = "required"; subtitleMode.dispatchEvent(new Event("change", { bubbles: true })); });
    const add = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Add to queue"))!;
    await act(async () => { add.click(); await Promise.resolve(); });
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ addonKeys: ["second", "first"], sourceStrategy: "priority", audioLanguage: "cs", fallbackAudioLanguage: "en", audioMode: "listed", subtitleMode: "required", subtitleLanguage: "cs" }));
  });

  it("submits the chosen audio matching mode", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Season 1" episodes={[{ id: "tt1:1:1" }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }, { code: "en", name: "English" }]} onClose={() => undefined} onSubmit={onSubmit}/>); });
    await act(async () => { await Promise.resolve(); });
    const audioMode = [...host.querySelectorAll("select")].find((select) => [...select.options].some((option) => option.value === "preferred"))!;
    await act(async () => { audioMode.value = "preferred"; audioMode.dispatchEvent(new Event("change", { bubbles: true })); });
    const add = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Add to queue"))!;
    await act(async () => { add.click(); await Promise.resolve(); });
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ audioMode: "preferred" }));
  });
});
