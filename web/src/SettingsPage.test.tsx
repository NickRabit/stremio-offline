import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsPage } from "./SettingsPage";
import { setLocale } from "./i18n";
import type { Settings as AppSettings } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const settings = (over: Partial<AppSettings> = {}): AppSettings => ({
  concurrentDownloads: 1, parallelPerProvider: 1, downloadSegments: 2,
  uiLanguage: "en", audioLanguage: "en", subtitleLanguage: "en", downloadTitleLanguage: "ui",
  mergeByName: true, streamSort: "recommended", trackProgress: true, showResumeRow: true,
  libraryAutoScan: true, libraryScanPauseOnDownload: false, secureMode: true, addonRefreshHours: 24,
  catalogTileSize: "medium", libraryTileSize: "medium",
  catalogTileShape: "poster", libraryTileShape: "poster", homeTileShape: "wide",
  startView: "catalog", realDebridConfigured: false, tmdbConfigured: false, ...over,
});

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  vi.stubGlobal("fetch", vi.fn(() =>
    Promise.resolve(json({ saveHistory: true, liveSearch: true, defaultOrder: "source", recent: [] }))));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const render = async (over: Partial<AppSettings> = {}, restricted = false) => {
  const onSave = vi.fn(() => Promise.resolve());
  await act(async () => {
    root.render(<SettingsPage build={null} restricted={restricted} settings={settings(over)} search={null}
      onSearch={vi.fn()} languages={[{ code: "en", name: "English" }]} libraries={[]}
      session={{ username: "bob", role: "user" }} onSession={vi.fn()} onSave={onSave}
      onImported={vi.fn(() => Promise.resolve())} onLibrariesChanged={vi.fn()} onNotify={vi.fn()} onError={vi.fn()}/>);
  });
  return { onSave };
};

const startView = () => host.querySelector<HTMLSelectElement>('select[aria-label="Start page"]')!;

describe("SettingsPage start page", () => {
  it("saves the chosen start page on change", async () => {
    const { onSave } = await render();
    const control = startView();
    expect(control.value).toBe("catalog");
    await act(async () => { control.value = "library"; control.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(onSave).toHaveBeenCalledWith({ startView: "library" });
  });

  it("is disabled for a restricted account", async () => {
    await render({}, true);
    expect(startView().disabled).toBe(true);
  });
});
