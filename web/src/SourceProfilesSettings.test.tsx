import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "./i18n";
import { SourceProfilesSettings } from "./SourceProfilesSettings";
import type { Addon, AdminRemoteLibrary, AdminSourceProfile, DownloadRules } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const STAMP = "2026-10-01T00:00:00.000Z";
const BALANCED = "88302ead-d701-4282-9059-777d47ed913c";
const CUSTOM = "11111111-1111-4111-8111-111111111111";
const REMOTE_ONE = `rlib_${"1".repeat(32)}`;
const REMOTE_TWO = `rlib_${"2".repeat(32)}`;
const REMOTE_OFF = `rlib_${"3".repeat(32)}`;

const rules = (over: Partial<DownloadRules> = {}): DownloadRules => ({
  addons: { scope: "all", order: "viewer" }, torrents: true,
  resolution: { min: 720, max: 1080 }, audio: { mode: "prefer", language: "mine", fallback: null },
  subtitles: "ifAvailable", subtitleLanguage: "mine", sizeGb: {
    episode: { min: null, max: 4 }, movie: { min: null, max: 15 },
  }, skipCinema: true,
  preference: ["language", "resolutionHigher", "addonOrder", "smaller"], ...over,
});
const preset: AdminSourceProfile = {
  id: BALANCED, revision: 2, template: "rules", nameKey: "rules.preset.balanced",
  parameters: rules(), createdAt: STAMP, updatedAt: STAMP,
};
const custom: AdminSourceProfile = {
  id: CUSTOM, revision: 4, template: "rules", name: "Living room",
  parameters: rules(), createdAt: STAMP, updatedAt: STAMP,
};
const addon = (key: string, name: string): Addon => ({
  key, role: "source", enabled: true, globalSearch: false,
  manifest: { id: `org.${key}`, name, version: "1.0.0", resources: ["stream"] },
});
const remoteLibrary = (
  id: string,
  name: string,
  order: number,
  provider: AdminRemoteLibrary["provider"],
  enabled = true,
): AdminRemoteLibrary => ({
  id, connectionId: `mconn_${id}`, remoteId: id, name, type: "movie",
  enabled, order, showOnHome: true, showInContinueWatching: true, allowedUsers: [],
  ...(provider ? { provider } : {}),
});
const remotes = [
  remoteLibrary(REMOTE_TWO, "Series", 2, "emby"),
  remoteLibrary(REMOTE_OFF, "Hidden", 0, "jellyfin", false),
  remoteLibrary(REMOTE_ONE, "Films", 1, "jellyfin"),
];

let fetchMock: ReturnType<typeof vi.fn>;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
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
const dialog = () => host.querySelector<HTMLElement>('[role="dialog"]')!;
const clickText = async (text: string, scope: ParentNode = host) => {
  const button = [...scope.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);
  expect(button, `button ${text}`).toBeTruthy();
  await act(async () => { button!.click(); });
  await flush();
};
const clickLabel = async (label: string) => {
  const button = dialog().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button, `button ${label}`).toBeTruthy();
  await act(async () => { button!.click(); });
  await flush();
};
const setInput = async (label: string, value: string) => {
  const input = dialog().querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
};
const setSelect = async (label: string, value: string) => {
  const select = dialog().querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => { setter.call(select, value); select.dispatchEvent(new Event("change", { bubbles: true })); });
};
const clickRadio = async (name: string, value: string) => {
  await act(async () => { dialog().querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`)!.click(); });
};
const clickBox = async (label: string) => {
  const input = dialog().querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="${label}"]`)!;
  expect(input, `checkbox ${label}`).toBeTruthy();
  await act(async () => { input.click(); });
};
const mount = async (
  profiles: AdminSourceProfile[] = [preset, custom],
  onWrite?: (url: string, method: string, body: unknown) => Response | undefined,
  remoteLibraries: AdminRemoteLibrary[] | "fail" = remotes,
  onChanged?: () => void,
) => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return onWrite?.(String(url), method, body) ?? (method === "DELETE" ? new Response(null, { status: 204 }) : json({}));
    }
    if (url === "/api/admin/source-profiles") return json({ profiles });
    if (url === "/api/addons") return json([addon("first", "First"), addon("second", "Second")]);
    if (url === "/api/media-servers/libraries") {
      return remoteLibraries === "fail" ? json({ error: "unavailable" }, 503) : json({ libraries: remoteLibraries });
    }
    return json({});
  });
  await act(async () => { root.render(<SourceProfilesSettings languages={[{ code: "cs", name: "Čeština" }, { code: "en", name: "English" }]} {...(onChanged ? { onChanged } : {})}/>); });
  await flush();
};

it("lists preset and custom rules with summaries and protects the preset from deletion", async () => {
  await mount();
  const presetRow = host.querySelector<HTMLElement>(`[data-profile-id="${BALANCED}"]`)!;
  const customRow = host.querySelector<HTMLElement>(`[data-profile-id="${CUSTOM}"]`)!;
  expect(presetRow.textContent).toContain("Balanced");
  expect(presetRow.textContent).toContain("720p–1080p · prefer my language · up to ~4 GB per episode");
  expect([...presetRow.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Edit", "Duplicate"]);
  expect(customRow.textContent).toContain("Living room");
  expect([...customRow.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Edit", "Duplicate", "Delete"]);
});

it("accepts the Sources heading without replacing the catalogue default", async () => {
  await mount();
  expect(host.querySelector(".settings-section-head")?.textContent).toContain("Download rules");
  expect(host.querySelector(".settings-section-head")?.textContent).toContain("Rules people choose for manual downloads and follows.");
  await act(async () => {
    root.render(<SourceProfilesSettings languages={[]} titleKey="settings.sourceRulesTitle" hintKey="settings.sourceRulesHint"/>);
  });
  await flush();
  expect(host.querySelector(".settings-section-head")?.textContent).toContain("Source selection rules");
  expect(host.querySelector(".settings-section-head")?.textContent).toContain("The rules choose the source for playback, manual downloads and follows.");
});

it("renders the sources, quality and language groups in order", async () => {
  await mount();
  await clickText("Add rules");
  expect([...dialog().querySelectorAll("legend")].map((legend) => legend.textContent))
    .toEqual(["Sources", "Quality and size", "Language", "What to prefer"]);
});

it("renders local and enabled remote libraries before addons in both source lists", async () => {
  await mount();
  await clickText("Add rules");
  await clickRadio("download-rules-scope", "selected");
  const selectedLabels = [...dialog().querySelectorAll<HTMLInputElement>(".bulk-sources input[type=checkbox]")]
    .map((input) => input.getAttribute("aria-label"));
  expect(selectedLabels).toEqual([
    "Local library (playback only)",
    "Jellyfin · Films",
    "Emby · Series",
    "First",
    "Second",
  ]);

  await clickRadio("download-rules-order", "explicit");
  const orderedLabels = [...dialog().querySelectorAll(".rules-order-list > div")]
    .map((row) => row.querySelector("span")?.textContent);
  expect(orderedLabels).toEqual(selectedLabels);
});

it("keeps local and addon rows without an error banner when remote libraries fail to load", async () => {
  await mount([preset], undefined, "fail");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await clickText("Add rules");
  await clickRadio("download-rules-scope", "selected");
  expect([...dialog().querySelectorAll<HTMLInputElement>(".bulk-sources input[type=checkbox]")]
    .map((input) => input.getAttribute("aria-label"))).toEqual([
    "Local library (playback only)",
    "First",
    "Second",
  ]);
});

it("maps every editor field to the exact rules body", async () => {
  const posted: unknown[] = [];
  await mount([preset], (url, method, body) => {
    if (url === "/api/admin/source-profiles" && method === "POST") {
      posted.push(body);
      return json({ id: CUSTOM, revision: 1, template: "rules", name: "Cinema", parameters: rules(), createdAt: STAMP, updatedAt: STAMP }, 201);
    }
    return undefined;
  });
  await clickText("Add rules");
  await setInput("Name", "Cinema");
  await clickRadio("download-rules-scope", "selected");
  await clickRadio("download-rules-order", "explicit");
  await clickLabel("Move Second up");
  await clickBox("Allow torrents through Real-Debrid");
  await setSelect("Resolution from", "480");
  await setSelect("Resolution to", "2160");
  await setSelect("Audio", "prefer");
  await setSelect("Audio language", "en");
  await setSelect("Fallback language", "cs");
  await setSelect("Subtitles", "required");
  await setInput("Episode from", "1.2");
  await setInput("Episode to", "2.5");
  await setInput("Film from", "5");
  await setInput("Film to", "12");
  await clickBox("Skip cinema copies (CAM, TS)");
  await clickText("Advanced", dialog());
  await clickBox("English");
  await clickBox("Higher resolution");
  await clickBox("Addon order");
  await clickBox("Smaller file");
  await clickBox("Lower resolution");
  await clickBox("Larger file");
  await clickText("Save", dialog());
  expect(posted).toEqual([{
    name: "Cinema",
    rules: {
      addons: {
        scope: { selected: ["local", `remote:${REMOTE_ONE}`, `remote:${REMOTE_TWO}`, "first", "second"] },
        order: { explicit: ["local", `remote:${REMOTE_ONE}`, `remote:${REMOTE_TWO}`, "second", "first"] },
      },
      torrents: false, resolution: { min: 480, max: 2160 },
      audio: { mode: "prefer", language: "en", fallback: "cs" },
      subtitles: "required", subtitleLanguage: "mine", sizeGb: {
        episode: { min: 1.2, max: 2.5 }, movie: { min: 5, max: 12 },
      }, skipCinema: false,
      preference: ["resolutionLower", "larger"],
    },
  }]);
});

it("unchecks a remote library and saves a scope without it", async () => {
  const posted: Array<{ rules: DownloadRules }> = [];
  await mount([preset], (url, method, body) => {
    if (url === "/api/admin/source-profiles" && method === "POST") posted.push(body as { rules: DownloadRules });
    return undefined;
  });
  await clickText("Add rules");
  await setInput("Name", "No films");
  await clickRadio("download-rules-scope", "selected");
  await clickBox("Jellyfin · Films");
  await clickText("Save", dialog());

  expect(posted[0]?.rules.addons.scope).toEqual({
    selected: ["local", `remote:${REMOTE_TWO}`, "first", "second"],
  });
});

it("moves a remote library above an addon and saves the explicit order", async () => {
  let patched: { rules: DownloadRules } | undefined;
  const ordered = {
    ...custom,
    parameters: rules({
      addons: {
        scope: { selected: ["local", `remote:${REMOTE_ONE}`, "first"] },
        order: { explicit: ["first", `remote:${REMOTE_ONE}`, "local"] },
      },
    }),
  };
  await mount([ordered], (_url, method, body) => {
    if (method === "PATCH") patched = body as { rules: DownloadRules };
    return undefined;
  });
  await clickText("Edit", host.querySelector(`[data-profile-id="${CUSTOM}"]`)!);
  await clickLabel("Move Jellyfin · Films up");
  await clickText("Save", dialog());

  expect(patched?.rules.addons.order).toEqual({
    explicit: [`remote:${REMOTE_ONE}`, "first", "local"],
  });
});

it("renders subtitle language, disables it for off and resets it when subtitles are disabled", async () => {
  await mount([custom]);
  await clickText("Edit", host.querySelector(`[data-profile-id="${CUSTOM}"]`)!);
  const language = dialog().querySelector<HTMLSelectElement>('select[aria-label="Subtitle language"]')!;
  expect(language).not.toBeNull();
  expect(language.value).toBe("mine");
  await setSelect("Subtitle language", "cs");
  expect(language.value).toBe("cs");
  await setSelect("Subtitles", "off");
  expect(language.disabled).toBe(true);
  expect(language.value).toBe("mine");
});

it("saves a chosen subtitle language", async () => {
  let patched: DownloadRules | undefined;
  await mount([custom], (_url, method, body) => {
    if (method === "PATCH") patched = (body as { rules: DownloadRules }).rules;
    return undefined;
  });
  await clickText("Edit", host.querySelector(`[data-profile-id="${CUSTOM}"]`)!);
  await setSelect("Subtitle language", "cs");
  await clickText("Save", dialog());
  expect(patched?.subtitleLanguage).toBe("cs");
});

it("switches to any language and keeps the preference order valid", async () => {
  const anyCustom = {
    ...custom,
    parameters: rules({
      audio: { mode: "prefer", language: "mine", fallback: "en" },
      preference: ["language"],
    }),
  };
  let patched: { rules: DownloadRules } | undefined;
  await mount([anyCustom], (_url, method, body) => {
    if (method === "PATCH") patched = body as { rules: DownloadRules };
    return undefined;
  });
  await clickText("Edit", host.querySelector(`[data-profile-id="${CUSTOM}"]`)!);
  await clickText("Advanced", dialog());
  expect(dialog().querySelector('input[aria-label="My language"]')).not.toBeNull();

  await setSelect("Audio", "any");
  const language = dialog().querySelector<HTMLSelectElement>('select[aria-label="Audio language"]')!;
  const fallback = dialog().querySelector<HTMLSelectElement>('select[aria-label="Fallback language"]')!;
  expect(language.disabled).toBe(true);
  expect(fallback.disabled).toBe(true);
  expect(fallback.value).toBe("");
  expect(dialog().querySelector('input[aria-label="My language"]')).toBeNull();

  await clickText("Save", dialog());
  expect(patched?.rules.audio).toEqual({ mode: "any", language: "mine", fallback: null });
  expect(patched?.rules.preference).toEqual(["addonOrder"]);
});

it("clears a matching fallback when choosing an explicit language", async () => {
  const posted: unknown[] = [];
  await mount([preset], (url, method, body) => {
    if (url === "/api/admin/source-profiles" && method === "POST") posted.push(body);
    return undefined;
  });
  await clickText("Add rules");
  await setInput("Name", "English");
  await setSelect("Fallback language", "en");
  await setSelect("Audio language", "en");
  const fallback = dialog().querySelector<HTMLSelectElement>('select[aria-label="Fallback language"]')!;
  expect(fallback.value).toBe("");
  expect([...fallback.options].some((option) => option.value === "en")).toBe(false);
  await clickText("Save", dialog());
  expect((posted[0] as { rules: DownloadRules }).rules.audio)
    .toEqual({ mode: "prefer", language: "en", fallback: null });
});

it("disables saving and shows an inline error when a size range is reversed", async () => {
  await mount([custom]);
  await clickText("Edit", host.querySelector(`[data-profile-id="${CUSTOM}"]`)!);
  await setInput("Episode from", "10");
  await setInput("Episode to", "4");
  expect(dialog().querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(dialog().querySelector(".login-error")?.textContent).toBe("The “from” size must not be larger than the “to” size.");
});

it("clears and disables fallback for my-language-only audio", async () => {
  await mount([custom]);
  await clickText("Edit", host.querySelector(`[data-profile-id="${CUSTOM}"]`)!);
  await setSelect("Fallback language", "en");
  await setSelect("Audio", "only");
  const fallback = dialog().querySelector<HTMLSelectElement>('select[aria-label="Fallback language"]')!;
  expect(fallback.disabled).toBe(true);
  expect(fallback.value).toBe("");
});

it("prevents opposite resolution directions in advanced preference order", async () => {
  await mount([custom]);
  await clickText("Edit", host.querySelector(`[data-profile-id="${CUSTOM}"]`)!);
  await clickText("Advanced", dialog());
  const higher = dialog().querySelector<HTMLInputElement>('input[aria-label="Higher resolution"]')!;
  const lower = dialog().querySelector<HTMLInputElement>('input[aria-label="Lower resolution"]')!;
  expect(higher.checked).toBe(true);
  expect(lower.disabled).toBe(true);
  await act(async () => { higher.click(); });
  expect(lower.disabled).toBe(false);
  await act(async () => { lower.click(); });
  expect(higher.disabled).toBe(true);
});

it("keeps stale-revision reload handling and patches rules", async () => {
  let current = custom;
  const patches: unknown[] = [];
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "PATCH") {
      const body = JSON.parse(String(init?.body));
      patches.push(body);
      if (body.revision === 4) {
        current = { ...current, revision: 5 };
        return json({ error: "This download rule revision is no longer available.", messageKey: "err.sourceProfileRevisionStale" }, 409);
      }
      return json(current);
    }
    if (url === "/api/admin/source-profiles") return json({ profiles: [current] });
    if (url === "/api/addons") return json([addon("first", "First")]);
    return json({});
  });
  await act(async () => { root.render(<SourceProfilesSettings languages={[]}/>); });
  await flush();
  await clickText("Edit", host.querySelector(`[data-profile-id="${CUSTOM}"]`)!);
  await clickText("Save", dialog());
  expect(dialog().textContent).toContain("This download rule revision is no longer available.");
  await clickText("Load again", dialog());
  await clickText("Save", dialog());
  expect(patches.map((patch) => (patch as { revision: number }).revision)).toEqual([4, 5]);
  expect(patches[0]).toMatchObject({ name: "Living room", rules: custom.parameters });
});

it("tells the caller after a rule was duplicated or deleted, so sort options reload", async () => {
  const onChanged = vi.fn();
  await mount([preset, custom], () => json(custom), remotes, onChanged);
  await clickText("Duplicate", host.querySelector(`[data-profile-id="${CUSTOM}"]`)!);
  await setInput("Name", "Copy");
  await act(async () => { dialog().querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
  await flush();
  expect(onChanged).toHaveBeenCalledTimes(1);

  await clickText("Delete", host.querySelector(`[data-profile-id="${CUSTOM}"]`)!);
  await act(async () => { dialog().querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
  await flush();
  expect(onChanged).toHaveBeenCalledTimes(2);
});
