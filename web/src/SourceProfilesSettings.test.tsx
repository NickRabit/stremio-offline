import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsPage } from "./SettingsPage";
import { SourceProfilesSettings } from "./SourceProfilesSettings";
import { setLocale } from "./i18n";
import type { Addon, AdminSourceProfile, Session, Settings as AppSettings } from "./types";

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

const STAMP = "2026-10-01T00:00:00.000Z";
const RECOMMENDED = "39de76cc-0ca0-4a5e-95ad-08927fb45410";
const PROVIDER = "390a8b1a-85f6-4ded-9d7e-701a299720bb";
const TRAVEL = "7e15d713-965c-4636-9ed3-3a112c521fe1";
const VARIANT = "11111111-1111-4111-8111-111111111111";

const travelParameters = (audioMode: "listed" | "preferred" | "strict" = "preferred"): AdminSourceProfile["parameters"] => ({
  scope: { mode: "allAvailable" },
  providerOrder: { from: "viewer" },
  audioMode,
  subtitleMode: "optional",
  heightPixels: { min: 480 },
});

const recommended: AdminSourceProfile = {
  id: RECOMMENDED, revision: 1, template: "recommended", nameKey: "sourceProfile.recommended",
  createdAt: STAMP, updatedAt: STAMP,
};
const travelBuiltin: AdminSourceProfile = {
  id: TRAVEL, revision: 2, template: "travel", nameKey: "sourceProfile.travel",
  parameters: travelParameters(), createdAt: STAMP, updatedAt: STAMP,
};
const providerBuiltin: AdminSourceProfile = {
  id: PROVIDER, revision: 3, template: "providerPriority", nameKey: "sourceProfile.providerPriority",
  parameters: {
    scope: { mode: "allAvailable" }, providerOrder: { from: "viewer" },
    sizeDirection: "desc", transfer: ["http", "torrent"], audioMode: "preferred", subtitleMode: "optional",
  },
  createdAt: STAMP, updatedAt: STAMP,
};
const variant: AdminSourceProfile = {
  id: VARIANT, revision: 4, template: "travel", name: "Weekend trip",
  parameters: travelParameters("strict"), createdAt: STAMP, updatedAt: STAMP,
};

const addon = (key: string, name: string, resources: Array<string | { name: string }>): Addon => ({
  key, role: "source", enabled: true, globalSearch: false,
  manifest: { id: `org.${key}`, name, version: "1.0.0", resources },
});
const torrentio = addon("torrentio", "Torrentio", ["stream"]);
const comet = addon("comet", "Comet", ["stream"]);
const cinemeta = addon("cinemeta", "Cinemeta", ["catalog"]);

const EFFECT = "The change applies to new downloads and to later episodes of followed series. Downloads already in the queue keep their original rules.";
const FALLBACK = "People who had it as their default choose again.";
const STALE = "This source profile revision is no longer available.";

let fetchMock: ReturnType<typeof vi.fn>;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  sessionStorage.clear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const flush = async () => { await act(async () => { await new Promise((done) => setTimeout(done, 0)); }); };

const dialog = () => {
  const node = host.querySelector<HTMLElement>('[role="dialog"]');
  expect(node, "a dialog is open").toBeTruthy();
  return node!;
};

const clickText = async (text: string, scope: ParentNode = host) => {
  const button = [...scope.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);
  expect(button, `"${text}" is on screen`).toBeTruthy();
  await act(async () => { button!.click(); });
  await flush();
};

const clickRadio = async (name: string, value: string) => {
  const input = dialog().querySelector<HTMLInputElement>(`input[type="radio"][name="${name}"][value="${value}"]`);
  expect(input, `${name}=${value}`).toBeTruthy();
  await act(async () => { input!.click(); });
};

const clickLabel = async (label: string) => {
  const button = dialog().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button, `"${label}" is on screen`).toBeTruthy();
  await act(async () => { button!.click(); });
  await flush();
};

const clickBox = async (label: string) => {
  const box = dialog().querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="${label}"]`);
  expect(box, `"${label}" is on screen`).toBeTruthy();
  await act(async () => { box!.click(); });
};

const fill = async (label: string, value: string) => {
  const input = dialog().querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(input, `"${label}" is on screen`).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input!.dispatchEvent(new Event("input", { bubbles: true })); });
};

const choose = async (label: string, value: string) => {
  const select = dialog().querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  expect(select, `"${label}" is on screen`).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => { setter.call(select, value); select!.dispatchEvent(new Event("change", { bubbles: true })); });
};

const calls = () => fetchMock.mock.calls.map((call) => {
  const init = call[1] as RequestInit | undefined;
  return {
    url: String(call[0]),
    method: init?.method ?? "GET",
    body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined,
  };
});

const mountProfiles = async (profiles: AdminSourceProfile[], addons: Addon[] = [torrentio, cinemeta, comet], onWrite?: (url: string, method: string, body: unknown) => Response | undefined) => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
      const answered = onWrite?.(String(url), method, body);
      if (answered) return answered;
      if (method === "DELETE") return new Response(null, { status: 204 });
      return json({});
    }
    if (url === "/api/admin/source-profiles") return json({ profiles });
    if (url === "/api/addons") return json(addons);
    if (url === "/api/libraries") return json([]);
    if (String(url).includes("/api/media-servers/libraries")) return json({ libraries: [] });
    if (String(url).includes("/api/media-servers")) return json({ connections: [], keyConfigured: true });
    return json({});
  });
  await act(async () => { root.render(<SourceProfilesSettings />); });
  await flush();
};

const renderSettings = async (role: Session["role"], restricted = false) => {
  fetchMock.mockImplementation(async (url: string) => {
    const path = String(url);
    if (path.includes("/api/libraries")) return json([]);
    if (path.includes("/api/media-servers/libraries")) return json({ libraries: [] });
    if (path.includes("/api/media-servers")) return json({ connections: [], keyConfigured: true });
    if (path.includes("/api/users")) return json([]);
    if (path === "/api/admin/source-profiles") return json({ profiles: [] });
    if (path === "/api/addons") return json([]);
    return json({});
  });
  await act(async () => {
    root.render(<SettingsPage build={null} restricted={restricted} settings={settings()} search={null}
      onSearch={vi.fn()} languages={[{ code: "en", name: "English" }]} libraries={[]}
      session={{ username: "ada", role }} onSession={vi.fn()} onSave={vi.fn(() => Promise.resolve())}
      onImported={vi.fn(() => Promise.resolve())} onLibrariesChanged={vi.fn()} onNotify={vi.fn()} onError={vi.fn()}/>);
  });
  await flush();
  const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((candidate) => candidate.textContent?.trim() === "Downloads");
  expect(tab, "the Downloads tab is on screen").toBeTruthy();
  await act(async () => { tab!.click(); });
  await flush();
};

it("hides the section from an ordinary account and from a restricted administrator", async () => {
  await renderSettings("user");
  expect(host.querySelector(".source-profiles-section")).toBeNull();

  await renderSettings("admin", true);
  expect(host.querySelector(".source-profiles-section")).toBeNull();

  await renderSettings("admin");
  expect(host.querySelector(".source-profiles-section")).not.toBeNull();
  expect(host.textContent).toContain("Profiles people choose for bulk downloads and Follow. Built-in profiles can be adjusted; your own are variants of Travel or Provider priority.");
});

it("lists built-ins by their translated name and variants by name, and hides the actions a built-in cannot take", async () => {
  await mountProfiles([recommended, travelBuiltin, providerBuiltin, variant]);

  const row = (id: string) => host.querySelector<HTMLElement>(`[data-profile-id="${id}"]`)!;
  const actions = (id: string) => [...row(id).querySelectorAll("button")].map((button) => button.textContent?.trim());

  expect(row(RECOMMENDED).querySelector("strong")?.textContent).toBe("Recommended");
  expect(row(RECOMMENDED).querySelector("small")?.textContent).toBe("Recommended");
  expect(actions(RECOMMENDED)).toEqual([]);

  expect(row(TRAVEL).querySelector("strong")?.textContent).toBe("Travel (small files)");
  expect(row(TRAVEL).querySelector("small")?.textContent).toBe("Travel");
  expect(actions(TRAVEL)).toEqual(["Edit", "Duplicate"]);

  expect(row(PROVIDER).querySelector("strong")?.textContent).toBe("Addon order, verified");
  expect(row(PROVIDER).querySelector("small")?.textContent).toBe("Provider priority");
  expect(actions(PROVIDER)).toEqual(["Edit", "Duplicate"]);

  expect(row(VARIANT).querySelector("strong")?.textContent).toBe("Weekend trip");
  expect(row(VARIANT).querySelector("small")?.textContent).toBe("Travel");
  expect(actions(VARIANT)).toEqual(["Edit", "Duplicate", "Delete"]);
  expect(host.textContent).not.toContain("sourceProfile.");
});

it("creates a Travel variant from the chosen addons, order and limits", async () => {
  const posted: unknown[] = [];
  await mountProfiles([recommended, travelBuiltin], [torrentio, cinemeta, comet], (url, method, body) => {
    if (method === "POST" && url === "/api/admin/source-profiles") {
      posted.push(body);
      return json({ id: "new", revision: 1, template: "travel", name: "Night train", createdAt: STAMP, updatedAt: STAMP }, 201);
    }
    return undefined;
  });

  await clickText("Add profile");
  await clickRadio("source-profile-template", "travel");
  await fill("Name", "Night train");
  await clickRadio("source-profile-scope", "selected");
  await clickBox("Torrentio");
  await clickBox("Comet");
  await clickLabel("Move Comet up");
  await choose("Minimum height", "720");
  await choose("Audio", "strict");
  expect(dialog().querySelector<HTMLSelectElement>('select[aria-label="Maximum height"]')?.value).toBe("");
  expect(dialog().textContent).toContain("Torrentio");
  expect(dialog().textContent).toContain("Comet");
  expect(dialog().textContent).not.toContain("Cinemeta");
  await clickText("Save", dialog());

  expect(posted).toEqual([{
    template: "travel",
    name: "Night train",
    parameters: {
      scope: { mode: "selected", addonKeys: ["comet", "torrentio"] },
      providerOrder: { addonKeys: ["comet", "torrentio"] },
      audioMode: "strict",
      subtitleMode: "optional",
      heightPixels: { min: 720 },
    },
  }]);
});

it("patches the loaded revision and reloads the editor after a stale revision", async () => {
  let current: AdminSourceProfile = variant;
  const patched: unknown[] = [];
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body));
      patched.push(body);
      if (body.revision === 4) {
        current = { ...current, revision: 5, parameters: travelParameters("listed") };
        return json({ error: STALE, messageKey: "err.sourceProfileRevisionStale" }, 409);
      }
      return json(current);
    }
    if (url === "/api/admin/source-profiles") return json({ profiles: [recommended, current] });
    if (url === "/api/addons") return json([torrentio]);
    return json({});
  });
  await act(async () => { root.render(<SourceProfilesSettings />); });
  await flush();

  const row = host.querySelector<HTMLElement>(`[data-profile-id="${VARIANT}"]`)!;
  await clickText("Edit", row);
  expect(dialog().textContent).toContain(EFFECT);
  await clickText("Save", dialog());

  expect(patched[0]).toEqual({
    revision: 4,
    name: "Weekend trip",
    parameters: {
      scope: { mode: "allAvailable" },
      providerOrder: { from: "viewer" },
      audioMode: "strict",
      subtitleMode: "optional",
      heightPixels: { min: 480 },
    },
  });
  expect(dialog().textContent).toContain(STALE);
  expect([...dialog().querySelectorAll("button")].some((button) => button.textContent?.trim() === "Load again")).toBe(true);

  await clickText("Load again", dialog());
  expect(dialog().textContent).not.toContain(STALE);
  expect(dialog().querySelector<HTMLSelectElement>('select[aria-label="Audio"]')?.value).toBe("listed");

  await clickText("Save", dialog());
  expect(patched[1]).toEqual({
    revision: 5,
    name: "Weekend trip",
    parameters: {
      scope: { mode: "allAvailable" },
      providerOrder: { from: "viewer" },
      audioMode: "listed",
      subtitleMode: "optional",
      heightPixels: { min: 480 },
    },
  });
});

it("refuses to save a provider-priority profile with no transfer selected", async () => {
  await mountProfiles([providerBuiltin]);
  await clickText("Add profile");
  await clickRadio("source-profile-template", "providerPriority");
  await fill("Name", "Fast");
  await clickBox("HTTP");
  await clickBox("Real-Debrid torrents");

  expect(dialog().textContent).toContain("Choose at least one.");
  const save = dialog().querySelector<HTMLButtonElement>("button.primary");
  expect(save?.disabled).toBe(true);
  await act(async () => { save!.click(); });
  await flush();
  expect(calls().some((call) => call.method === "POST")).toBe(false);
});

it("asks before deleting a variant and sends the revision", async () => {
  await mountProfiles([recommended, travelBuiltin, variant]);
  const row = host.querySelector<HTMLElement>(`[data-profile-id="${VARIANT}"]`)!;
  await clickText("Delete", row);

  expect(calls().some((call) => call.method === "DELETE")).toBe(false);
  expect(dialog().textContent).toContain("Weekend trip");
  expect(dialog().textContent).toContain(EFFECT);
  expect(dialog().textContent).toContain(FALLBACK);

  await clickText("Delete", dialog());
  expect(calls().filter((call) => call.method === "DELETE")).toEqual([
    { url: `/api/admin/source-profiles/${VARIANT}?revision=4`, method: "DELETE", body: undefined },
  ]);
});
