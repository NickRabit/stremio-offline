import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SeriesDownloadDialog } from "./SeriesDownloadDialog";
import { setLocale } from "./i18n";
import type { FollowAutoDownload, SourceProfile } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const profile = (
  id: string,
  nameKey: string,
  audio: "preferred" | "strict" = "preferred",
  preferred: { preference: "audio" } | { code: string } = { preference: "audio" },
  audioTier = true,
): SourceProfile => ({
  id, nameKey, template: "rules", revision: 3, operations: ["downloadToLibrary"],
  sizeLimits: { episodeBytes: 4_000_000_000, movieBytes: 15_000_000_000 },
  policy: {
    schemaVersion: 1, scope: { mode: "allAvailable" },
    constraints: {
      sourceKinds: ["localFile", "mediaServerOriginal", "http", "torrent"],
      audio: { mode: audio, preferred },
      subtitles: { mode: "optional", preferred: { preference: "subtitle" } },
      heightPixels: { min: 720, max: 1080 }, bytes: { max: 4_000_000_000 },
    },
    criteria: [
      ...(audioTier ? [{ kind: "audioTier" as const }] : []),
      { kind: "providerOrder", from: "viewer" },
    ],
    nextEpisode: "profile", existingLocalCopy: "meetsRequirements",
  },
});
const balanced = profile("balanced", "rules.preset.balanced");
const best = profile("best", "rules.preset.best");
const myLanguage = profile("my-language", "rules.preset.myLanguage", "strict");
const anyLanguage = profile("any-language", "rules.preset.smaller", "preferred", { preference: "audio" }, false);
const english = profile("english", "rules.preset.best", "preferred", { code: "en" });

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
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const flush = async () => { await act(async () => { await new Promise((done) => setTimeout(done, 0)); }); };
const setupFetch = (profiles: SourceProfile[] | Error) => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url) === "/api/source-profiles") {
      if (profiles instanceof Error) throw profiles;
      return json({ profiles });
    }
    if ((init?.method ?? "GET") === "PATCH") return json({});
    if (String(url).startsWith("/api/follows")) return json({ id: "f1", type: "series", metaId: "tt1", name: "Show", enabled: true, downloads: {} });
    return json({});
  });
};
const renderDialog = async (props: Partial<ComponentProps<typeof SeriesDownloadDialog>> = {}) => {
  await act(async () => {
    root.render(<SeriesDownloadDialog type="series" label="Season 1" title="Show" episodes={[{ id: "tt1:1:1", season: 1, episode: 1 }]}
      libraries={[]} onClose={() => undefined} onSubmit={vi.fn().mockResolvedValue(undefined)} {...props}/>);
  });
  await flush();
};
const selectedProfile = () => host.querySelector<HTMLInputElement>('input[name="download-rules"]:checked')?.value;
const primary = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.classList.contains("primary"))!;

describe("SeriesDownloadDialog", () => {
  it("renders only download-rule cards and no legacy source, audio or subtitle controls", async () => {
    setupFetch([balanced, myLanguage]);
    await renderDialog();
    expect(host.textContent).toContain("Download rules");
    expect(host.textContent).toContain("Balanced");
    expect(host.textContent).toContain("720p–1080p · prefer my language · up to ~4 GB per episode");
    expect(host.querySelector('input[name="source-strategy"]')).toBeNull();
    expect(host.querySelector(".bulk-sources")).toBeNull();
    expect(host.textContent).not.toContain("Fallback audio");
    expect(host.textContent).not.toContain("Subtitle language");
  });

  it.each([["empty", [] as SourceProfile[]], ["failed", new Error("offline")]])
  ("disables submit when the rule list is %s", async (_label, answer) => {
    setupFetch(answer);
    await renderDialog();
    expect(host.textContent).toContain("Download rules are unavailable. Ask an administrator.");
    expect(primary().disabled).toBe(true);
  });

  it("uses the bulk default, otherwise Balanced", async () => {
    setupFetch([balanced, best, myLanguage]);
    await renderDialog({ downloadSourceProfileId: "best" });
    expect(selectedProfile()).toBe("best");
    act(() => root.unmount());
    root = createRoot(host);
    setupFetch([balanced, best, myLanguage]);
    await renderDialog();
    expect(selectedProfile()).toBe("balanced");
  });

  it("uses the follow default, otherwise My language only", async () => {
    setupFetch([balanced, best, myLanguage]);
    await renderDialog({ followSourceProfileId: "best", follow: { followId: "f1" } });
    expect(selectedProfile()).toBe("best");
    act(() => root.unmount());
    root = createRoot(host);
    setupFetch([balanced, best, myLanguage]);
    await renderDialog({ follow: { followId: "f1" } });
    expect(selectedProfile()).toBe("my-language");
  });

  it("shows grace only for preferred audio and sends graceDays", async () => {
    setupFetch([balanced, myLanguage, anyLanguage]);
    await renderDialog({ follow: { followId: "f1" } });
    expect(host.querySelector('select[aria-label="Wait for audio in my language"]')).toBeNull();
    await act(async () => {
      host.querySelector<HTMLInputElement>('input[name="download-rules"][value="any-language"]')!.click();
    });
    expect(host.querySelector('select[aria-label="Wait for audio in my language"]')).toBeNull();
    await act(async () => {
      host.querySelector<HTMLInputElement>('input[name="download-rules"][value="balanced"]')!.click();
    });
    const grace = host.querySelector<HTMLSelectElement>('select[aria-label="Wait for audio in my language"]')!;
    expect(grace.value).toBe("2");
    await act(async () => { grace.value = "7"; grace.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { primary().click(); await Promise.resolve(); });
    const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")!;
    const body = JSON.parse(String((patch[1] as RequestInit).body));
    expect(body.autoDownload.graceDays).toBe(7);
    expect(body.autoDownload.selection).toEqual({ profile: { profileId: "balanced", revision: 3 } });
  });

  it("names the chosen language in the grace label", async () => {
    setupFetch([english, balanced]);
    await renderDialog({ follow: { followId: "f1" }, followSourceProfileId: "english" });
    expect(host.querySelector('select[aria-label="Wait for audio in English"]')).not.toBeNull();
  });

  it("shows the legacy note and saves the preselected profile", async () => {
    const legacy: FollowAutoDownload = {
      enabledAt: "2024-01-01T00:00:00.000Z", startMode: "new",
      selection: { addonKeys: ["old"], sourceStrategy: "priority", audioLanguage: "cs", subtitleMode: "off" },
    };
    setupFetch([balanced, myLanguage]);
    await renderDialog({ follow: { followId: "f1", initial: legacy } });
    expect(host.textContent).toContain("This follow uses the original settings. Saving switches it to download rules.");
    expect(selectedProfile()).toBe("balanced");
    await act(async () => { primary().click(); await Promise.resolve(); });
    const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")!;
    expect(JSON.parse(String((patch[1] as RequestInit).body)).autoDownload.selection)
      .toEqual({ profile: { profileId: "balanced", revision: 3 } });
  });

  it("remembers the selected rule for the matching mode and never calls follow defaults", async () => {
    const remember = vi.fn().mockResolvedValue(undefined);
    setupFetch([balanced, best]);
    await renderDialog({ downloadSourceProfileId: "balanced", onRememberDownloadSourceProfile: remember });
    await act(async () => { host.querySelector<HTMLInputElement>('input[name="download-rules"][value="best"]')!.click(); });
    const checkbox = host.querySelector<HTMLInputElement>('input[aria-label="Use as default for manual downloads"]')!;
    await act(async () => { checkbox.click(); primary().click(); await Promise.resolve(); await Promise.resolve(); });
    expect(remember).toHaveBeenCalledWith("best");
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/follows/defaults")).toBe(false);
  });

  it("keeps an existing follow's rule ahead of its default", async () => {
    const initial: FollowAutoDownload = {
      enabledAt: "2024-01-01T00:00:00.000Z", startMode: "new",
      selection: { addonKeys: ["old"], sourceStrategy: "priority", audioLanguage: "cs", subtitleMode: "off" },
      sourceProfile: { profileId: "balanced", revision: 2 },
    };
    setupFetch([balanced, best, myLanguage]);
    await renderDialog({ followSourceProfileId: "best", follow: { followId: "f1", initial } });
    expect(selectedProfile()).toBe("balanced");
  });

  it("sends an ahead start rule and administrator retention", async () => {
    setupFetch([myLanguage]);
    await renderDialog({ canRetain: true, follow: { followId: "f1" } });
    await act(async () => { host.querySelector<HTMLInputElement>('input[name="follow-start"][value="ahead"]')!.click(); });
    const ahead = host.querySelector<HTMLSelectElement>('select[aria-label="Keep episodes ready from where I am watching"]')!;
    const retention = host.querySelector<HTMLSelectElement>('select[aria-label="After watching"]')!;
    await act(async () => {
      ahead.value = "5"; ahead.dispatchEvent(new Event("change", { bubbles: true }));
      retention.value = "7"; retention.dispatchEvent(new Event("change", { bubbles: true }));
      primary().click(); await Promise.resolve();
    });
    const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")!;
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toMatchObject({
      retention: { afterWatchedDays: 7 },
      autoDownload: { startMode: "ahead", aheadCount: 5 },
    });
  });

  it("creates a notify-only follow without loading rules or saving follow defaults", async () => {
    setupFetch([balanced]);
    await renderDialog({ follow: { create: { metaId: "tt1", name: "Show", addonKey: "catalog" }, onFollowed: vi.fn() } });
    await act(async () => { primary().click(); await Promise.resolve(); });
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse(String((post[1] as RequestInit).body)).addonKey).toBe("catalog");
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/source-profiles")).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/follows/defaults")).toBe(false);
  });

  it("creates a follow and enables automatic downloads with one rules selection", async () => {
    setupFetch([balanced]);
    await renderDialog({ follow: { create: { metaId: "tt1", name: "Show" }, onFollowed: vi.fn() } });
    await act(async () => { host.querySelector<HTMLInputElement>('input[name="follow-mode"][value="download"]')!.click(); });
    await flush();
    await act(async () => { primary().click(); await Promise.resolve(); await Promise.resolve(); });
    const methods = fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/follows"))
      .map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${String(url)}`);
    expect(methods).toEqual(["POST /api/follows", "PATCH /api/follows/f1"]);
  });

  it("uses film wording and hides start and retention controls for a film", async () => {
    setupFetch([balanced]);
    await renderDialog({ type: "movie", episodes: [{ id: "tt9" }], follow: { create: { metaId: "tt9", name: "Film" } }, canRetain: true });
    expect(host.querySelector("h2")?.textContent).toBe("Follow film");
    await act(async () => { host.querySelector<HTMLInputElement>('input[name="follow-mode"][value="download"]')!.click(); });
    await flush();
    expect(host.textContent).toContain("720p–1080p · prefer my language · up to ~15 GB per film");
    expect(host.querySelector('input[name="follow-start"]')).toBeNull();
    expect(host.querySelector('select[aria-label="After watching"]')).toBeNull();
  });
});
