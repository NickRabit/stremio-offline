import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsPage } from "./SettingsPage";
import { setLocale } from "./i18n";
import { en } from "./i18n/en";
import type { Session, Settings as AppSettings, SourceProfile } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const settings = (over: Partial<AppSettings> = {}): AppSettings => ({
  concurrentDownloads: 1, parallelPerProvider: 1, downloadSegments: 2,
  uiLanguage: "en", audioLanguage: "en", subtitleLanguage: "en", downloadTitleLanguage: "ui",
  mergeByName: true, streamSort: "rule:balanced", trackProgress: true, showResumeRow: true,
  libraryAutoScan: true, libraryScanPauseOnDownload: false, secureMode: true, addonRefreshHours: 24,
  tileSize: "medium",
  catalogTileShape: "poster", libraryTileShape: "poster", favoritesTileShape: "poster", resumeTileShape: "poster", followingTileShape: "poster", homeTileShape: "wide", searchTileShape: "poster",
  startView: "catalog", libraryShelf: "resume", realDebridConfigured: false, tmdbConfigured: false, ...over,
});

const sourceProfiles: SourceProfile[] = [
  { id: "balanced", nameKey: "rules.preset.balanced", template: "rules", revision: 1, operations: ["downloadToLibrary", "play"], policy: {} as SourceProfile["policy"] },
  { id: "best", nameKey: "rules.preset.best", template: "rules", revision: 1, operations: ["downloadToLibrary", "play"], policy: {} as SourceProfile["policy"] },
  { id: "my-language", nameKey: "rules.preset.myLanguage", template: "rules", revision: 1, operations: ["downloadToLibrary", "play"], policy: {} as SourceProfile["policy"] },
];

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

const render = async (over: Partial<AppSettings> = {}, restricted = false, role: Session["role"] = "user", profiles: SourceProfile[] | null = sourceProfiles) => {
  const onSave = vi.fn(() => Promise.resolve());
  await act(async () => {
    root.render(<SettingsPage build={null} restricted={restricted} settings={settings(over)} search={null}
      onSearch={vi.fn()} languages={[{ code: "en", name: "English" }]} libraries={[]}
      session={{ username: "bob", role }} onSession={vi.fn()} onSave={onSave} sourceProfiles={profiles}
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

const stubSourceProfiles = () => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/source-profiles") return Promise.resolve(json({ profiles: sourceProfiles }));
    if (url === "/api/admin/source-profiles") return Promise.resolve(json({ profiles: sourceProfiles }));
    if (url === "/api/addons") return Promise.resolve(json([]));
    if (url === "/api/libraries") return Promise.resolve(json([]));
    if (url === "/api/media-servers/libraries") return Promise.resolve(json({ libraries: [] }));
    if (url.includes("/api/home/layout")) {
      return Promise.resolve(json({ rows: [], layout: { order: [], hidden: [], feeds: [] } }));
    }
    return Promise.resolve(json({ saveHistory: true, liveSearch: true, defaultOrder: "source", recent: [] }));
  }));
};

const startView = () => host.querySelector<HTMLSelectElement>('select[aria-label="Start page"]')!;

describe("SettingsPage tabs", () => {
  it("shows an administrator seven tabs and keeps the instance services out of Downloads", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/media-servers/libraries")) return Promise.resolve(json({ libraries: [] }));
      if (url.includes("/api/media-servers")) return Promise.resolve(json({ connections: [], keyConfigured: true }));
      if (url.includes("/api/libraries")) return Promise.resolve(json([]));
      return Promise.resolve(json({}));
    }));

    await render({}, false, "admin");
    expect([...host.querySelectorAll('.section-filter [role="tab"]')].map((candidate) => candidate.textContent))
      .toEqual(["Libraries", "Home", "Playback", "Sources", "Downloads", "Services", "Account"]);

    await selectTab("Downloads");
    expect(host.querySelectorAll(".credentials-section")).toHaveLength(0);
    expect(host.querySelector(".source-profiles-section")).toBeNull();
    expect(host.querySelector(`select[aria-label="${en["settings.addonRefreshLabel"]}"]`)).toBeNull();

    await selectTab("Services");
    expect(host.querySelectorAll(".credentials-section")).toHaveLength(2);
    expect(host.querySelector(`select[aria-label="${en["settings.addonRefreshLabel"]}"]`)).not.toBeNull();
  });

  it("shows an ordinary account six tabs without Services", async () => {
    await render();
    expect([...host.querySelectorAll('.section-filter [role="tab"]')].map((candidate) => candidate.textContent))
      .toEqual(["Libraries", "Home", "Playback", "Sources", "Downloads", "Account"]);
    expect([...host.querySelectorAll('.section-filter [role="tab"]')].some((candidate) => candidate.textContent === "Services")).toBe(false);
  });

  it("opens a stored Services tab on Libraries for an ordinary account", async () => {
    sessionStorage.setItem("stremio-offline-settings-tab", "services");
    await render();
    expect(host.querySelector('.section-filter [role="tab"][aria-selected="true"]')?.textContent).toBe("Libraries");
  });

  it("reopens a remembered Sources tab", async () => {
    sessionStorage.setItem("stremio-offline-settings-tab", "sources");
    await render();
    expect(host.querySelector('.section-filter [role="tab"][aria-selected="true"]')?.textContent).toBe("Sources");
    expect(host.textContent).toContain(en["settings.defaultsTitle"]);
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
    expect(host.querySelector(`select[aria-label="${en["settings.streamSort"]}"]`)).toBeNull();
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

describe("SettingsPage Sources tab", () => {
  it("shows the defaults, source order and administrator rules in order", async () => {
    stubSourceProfiles();
    await render({}, false, "admin");
    await selectTab("Sources");

    const defaults = host.querySelector<HTMLElement>(".source-defaults-section")!;
    expect(defaults.textContent).toContain(en["settings.defaultsTitle"]);
    expect(defaults.textContent).toContain(en["settings.defaultsHint"]);
    expect(defaults.textContent).toContain(en["settings.defaultRulesDownloadsHint"]);
    expect(defaults.textContent).toContain(en["settings.defaultRulesFollowsHint"]);
    const downloads = defaults.querySelector<HTMLSelectElement>(`select[aria-label="${en["settings.defaultRulesDownloads"]}"]`)!;
    const follows = defaults.querySelector<HTMLSelectElement>(`select[aria-label="${en["settings.defaultRulesFollows"]}"]`)!;
    expect(defaults.querySelectorAll("select")).toHaveLength(2);
    expect(downloads.value).toBe("balanced");
    expect(follows.value).toBe("my-language");

    const sourceOrder = host.querySelector<HTMLElement>(".source-order-section")!;
    const order = sourceOrder.querySelector<HTMLSelectElement>(`select[aria-label="${en["settings.streamSort"]}"]`)!;
    expect([...order.options].map((option) => option.textContent)).toEqual([
      en["rules.preset.balanced"], en["rules.preset.best"], en["rules.preset.myLanguage"],
      en["sources.sortLargest"], en["sources.sortSmallest"], en["sources.sortAddon"],
    ]);
    expect(order.value).toBe("rule:balanced");
    expect(sourceOrder.textContent).toContain(en["settings.defaultRulesHint"]);
    const rules = host.querySelector<HTMLElement>(".source-profiles-section")!;
    expect(rules.textContent).toContain(en["settings.sourceRulesTitle"]);
    expect(rules.textContent).toContain(en["settings.sourceRulesHint"]);
    expect(rules.textContent).toContain(en["rules.preset.balanced"]);

    const sections = [...host.querySelectorAll<HTMLElement>(".settings-grid > section")];
    expect(sections.indexOf(defaults)).toBeLessThan(sections.indexOf(sourceOrder));
    expect(sections.indexOf(sourceOrder)).toBeLessThan(sections.indexOf(rules));
  });

  it("saves the rule download and follow defaults and the source order", async () => {
    stubSourceProfiles();
    const { onSave } = await render();
    await selectTab("Sources");

    const choices = [
      [en["settings.defaultRulesDownloads"], { downloadSourceProfile: "best" }],
      [en["settings.defaultRulesFollows"], { followSourceProfile: "best" }],
      [en["settings.streamSort"], { streamSort: "rule:best" }],
    ] as const;
    for (const [label, patch] of choices) {
      const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
      await act(async () => {
        select.value = label === en["settings.streamSort"] ? "rule:best" : "best";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(onSave).toHaveBeenCalledWith(patch);
    }
  });

  it("uses stored download and follow defaults", async () => {
    stubSourceProfiles();
    await render({ downloadSourceProfile: "best", followSourceProfile: "best", streamSort: "rule:best" });
    await selectTab("Sources");
    expect(host.querySelector<HTMLSelectElement>(`select[aria-label="${en["settings.defaultRulesDownloads"]}"]`)!.value).toBe("best");
    expect(host.querySelector<HTMLSelectElement>(`select[aria-label="${en["settings.defaultRulesFollows"]}"]`)!.value).toBe("best");
    expect(host.querySelector<HTMLSelectElement>(`select[aria-label="${en["settings.streamSort"]}"]`)!.value).toBe("rule:best");
  });

  it("shows defaults and source order without rules to a non-admin", async () => {
    stubSourceProfiles();
    await render();
    await selectTab("Sources");
    expect(host.querySelector(`select[aria-label="${en["settings.defaultRulesDownloads"]}"]`)).not.toBeNull();
    expect(host.querySelector(`select[aria-label="${en["settings.defaultRulesFollows"]}"]`)).not.toBeNull();
    expect(host.querySelector(`select[aria-label="${en["settings.streamSort"]}"]`)).not.toBeNull();
    expect(host.querySelector(".source-profiles-section")).toBeNull();
    expect(host.textContent).not.toContain(en["settings.sourceRulesTitle"]);
  });

  it("disables the source preferences when restricted", async () => {
    stubSourceProfiles();
    await render({}, true);
    await selectTab("Sources");
    const selects = [...host.querySelectorAll<HTMLSelectElement>(".settings-grid select")];
    expect(selects).toHaveLength(3);
    expect(selects.every((select) => select.disabled)).toBe(true);
  });
});
