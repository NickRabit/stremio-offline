import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsPage } from "./SettingsPage";
import { setLocale } from "./i18n";
import { en } from "./i18n/en";
import type { Session, Settings as AppSettings } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const settings = (over: Partial<AppSettings> = {}): AppSettings => ({
  concurrentDownloads: 1, parallelPerProvider: 1, downloadSegments: 2,
  uiLanguage: "en", audioLanguage: "en", subtitleLanguage: "en", downloadTitleLanguage: "ui",
  mergeByName: true, streamSort: "recommended", trackProgress: true, showResumeRow: true,
  libraryAutoScan: true, libraryScanPauseOnDownload: false, secureMode: true, addonRefreshHours: 24,
  tileSize: "medium",
  catalogTileShape: "poster", libraryTileShape: "poster", favoritesTileShape: "poster", resumeTileShape: "poster", followingTileShape: "poster", homeTileShape: "wide", searchTileShape: "poster",
  startView: "catalog", libraryShelf: "resume", realDebridConfigured: false, tmdbConfigured: false, ...over,
});

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    if (String(input).includes("/api/home/layout")) {
      return Promise.resolve(json({ rows: [], layout: { order: [], hidden: [], feeds: [] } }));
    }
    return Promise.resolve(json({ saveHistory: true, liveSearch: true, defaultOrder: "source", recent: [] }));
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

const render = async (over: Partial<AppSettings> = {}, restricted = false, role: Session["role"] = "user") => {
  const onSave = vi.fn(() => Promise.resolve());
  await act(async () => {
    root.render(<SettingsPage build={null} restricted={restricted} settings={settings(over)} search={null}
      onSearch={vi.fn()} languages={[{ code: "en", name: "English" }]} libraries={[]}
      session={{ username: "bob", role }} onSession={vi.fn()} onSave={onSave}
      onImported={vi.fn(() => Promise.resolve())} onLibrariesChanged={vi.fn()} onNotify={vi.fn()} onError={vi.fn()}/>);
  });
  return { onSave };
};

const tab = (name: string) => {
  const button = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find((candidate) => candidate.textContent?.trim() === name);
  expect(button, `the ${name} tab is on screen`).toBeTruthy();
  return button!;
};

const selectTab = async (name: string) => {
  await act(async () => { tab(name).click(); await Promise.resolve(); });
};

const startView = () => host.querySelector<HTMLSelectElement>('select[aria-label="Start page"]')!;

describe("SettingsPage tabs", () => {
  it("shows an administrator six tabs and keeps the instance services out of Downloads", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/media-servers/libraries")) return Promise.resolve(json({ libraries: [] }));
      if (url.includes("/api/media-servers")) return Promise.resolve(json({ connections: [], keyConfigured: true }));
      if (url.includes("/api/libraries")) return Promise.resolve(json([]));
      return Promise.resolve(json({}));
    }));

    await render({}, false, "admin");
    expect([...host.querySelectorAll('.section-filter [role="tab"]')].map((candidate) => candidate.textContent))
      .toEqual(["Libraries", "Home", "Playback", "Downloads", "Services", "Account"]);

    await selectTab("Downloads");
    expect(host.querySelectorAll(".credentials-section")).toHaveLength(0);
    expect(host.querySelector(`select[aria-label="${en["settings.addonRefreshLabel"]}"]`)).toBeNull();

    await selectTab("Services");
    expect(host.querySelectorAll(".credentials-section")).toHaveLength(2);
    expect(host.querySelector(`select[aria-label="${en["settings.addonRefreshLabel"]}"]`)).not.toBeNull();
  });

  it("shows an ordinary account five tabs without Services", async () => {
    await render();
    expect([...host.querySelectorAll('.section-filter [role="tab"]')].map((candidate) => candidate.textContent))
      .toEqual(["Libraries", "Home", "Playback", "Downloads", "Account"]);
    expect([...host.querySelectorAll('.section-filter [role="tab"]')].some((candidate) => candidate.textContent === "Services")).toBe(false);
  });

  it("opens a stored Services tab on Libraries for an ordinary account", async () => {
    sessionStorage.setItem("stremio-offline-settings-tab", "services");
    await render();
    expect(host.querySelector('.section-filter [role="tab"][aria-selected="true"]')?.textContent).toBe("Libraries");
  });

  it("moves the start page onto the Home tab and saves the choice", async () => {
    const { onSave } = await render();
    expect(startView(), "the start page is not on the tab the page opens on").toBeNull();
    await selectTab("Home");
    const control = startView();
    expect(control.value).toBe("catalog");
    await act(async () => { control.value = "library"; control.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(onSave).toHaveBeenCalledWith({ startView: "library" });
  });

  it("is disabled for a restricted account", async () => {
    await render({}, true);
    await selectTab("Home");
    expect(startView().disabled).toBe(true);
  });

  it("reopens the tab the session stored", async () => {
    await render();
    await selectTab("Home");
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await render();
    expect(host.querySelector('.section-filter [role="tab"][aria-selected="true"]')?.textContent).toBe("Home");
    expect(startView()).not.toBeNull();
  });

  it("shows an administrator the Libraries tab, and Playback only once it is chosen", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/media-servers/libraries")) return Promise.resolve(json({ libraries: [] }));
      if (url.includes("/api/media-servers")) return Promise.resolve(json({ connections: [], keyConfigured: true }));
      if (url.includes("/api/libraries")) return Promise.resolve(json([]));
      if (url.includes("/api/users")) return Promise.resolve(json([]));
      return Promise.resolve(json({}));
    }));

    await render({}, false, "admin");
    expect(host.querySelector(".library-manager"), "the manager is on the tab the page opens on").not.toBeNull();
    expect(host.querySelector('select[aria-label="Preferred audio language"]')).toBeNull();
    await selectTab("Playback");
    expect(host.querySelector('select[aria-label="Preferred audio language"]')).not.toBeNull();
  });
});

describe("SettingsPage Home tab", () => {
  it("shows the Home section to an ordinary account", async () => {
    await render();
    await selectTab("Home");
    expect(host.querySelector(".home-layout-section")).not.toBeNull();
  });

  it("orders the Home rows before Appearance and Search", async () => {
    await render();
    await selectTab("Home");
    const sections = [...host.querySelectorAll("section")];
    expect(sections.indexOf(host.querySelector(".home-layout-section")!))
      .toBeLessThan(sections.indexOf(host.querySelector(".language-section")!));
    expect(sections.indexOf(host.querySelector(".language-section")!))
      .toBeLessThan(sections.indexOf(host.querySelector(".search-settings")!));
  });
});

describe("SettingsPage Libraries tab", () => {
  it("shows an ordinary account the same-titles control and no manager", async () => {
    await render();
    expect(host.querySelector('select[aria-label="Identical titles"]')).not.toBeNull();
    expect(host.querySelector(".library-manager")).toBeNull();
    expect(host.querySelector(".media-server-manager")).toBeNull();
  });
});

describe("SettingsPage library row", () => {
  it("no longer offers a dead Continue watching row switch", async () => {
    const { onSave } = await render();
    expect([...host.querySelectorAll("select")].some((select) => select.getAttribute("aria-label") === "Part-watched row")).toBe(false);
    await act(async () => {
      for (const select of [...host.querySelectorAll<HTMLSelectElement>("select")]) select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onSave).not.toHaveBeenCalledWith({ showResumeRow: false });
  });
});

describe("SettingsPage default rules", () => {
  it("lists rules profiles, defaults to balanced and saves the chosen profile", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/source-profiles")) {
        return Promise.resolve(json({ profiles: [
          { id: "balanced", nameKey: "rules.preset.balanced", template: "rules" },
          { id: "best", nameKey: "rules.preset.best", template: "rules" },
          { id: "recommended", template: "recommended" },
        ] }));
      }
      return Promise.resolve(json({ saveHistory: true, liveSearch: true, defaultOrder: "source", recent: [] }));
    }));

    const { onSave } = await render();
    await selectTab("Playback");
    const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${en["settings.defaultRules"]}"]`)!;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      en["rules.preset.balanced"],
      en["rules.preset.best"],
    ]);
    expect(select.value).toBe("balanced");
    await act(async () => {
      select.value = "best";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onSave).toHaveBeenCalledWith({ defaultRulesProfileId: "best" });
  });
});
