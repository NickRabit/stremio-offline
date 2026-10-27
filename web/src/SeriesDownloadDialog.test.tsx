import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SeriesDownloadDialog } from "./SeriesDownloadDialog";
import { setLocale } from "./i18n";
import type { FollowAutoDownload } from "./types";

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
  it("submits a bulk download with a source profile and hides profile-managed choices", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    fetchMock.mockImplementation(async (url: string) => {
      const body = String(url) === "/api/source-profiles"
        ? { profiles: [
            { id: "travel", nameKey: "sourceProfile.travel", revision: 1, operations: ["downloadToLibrary"], policy: {} },
            { id: "provider", nameKey: "sourceProfile.providerPriority", revision: 1, operations: ["downloadToLibrary"], policy: {} },
          ] }
        : [{ key: "first", name: "First" }];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Season 1" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1" }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }]} onClose={() => undefined} onSubmit={onSubmit}/>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(host.textContent).toContain("Travel (small files)");
    expect(host.textContent).toContain("Addon order, verified");
    const travel = host.querySelector<HTMLInputElement>('input[name="source-strategy"][value="profile:travel"]')!;
    await act(async () => { travel.click(); });

    expect(host.querySelector(".bulk-sources")).toBeNull();
    const headings = [...host.querySelectorAll(".bulk-section h3")].map((heading) => heading.textContent);
    expect(headings).not.toContain("Audio");
    expect(headings).not.toContain("Subtitles");
    const add = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Add to queue"))!;
    await act(async () => { add.click(); await Promise.resolve(); });
    expect(onSubmit).toHaveBeenCalledWith({ profile: { profileId: "travel", revision: 1 } }, undefined);
  });

  it("opens on an offered remembered source profile", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const body = String(url) === "/api/source-profiles"
        ? { profiles: [{ id: "travel", nameKey: "sourceProfile.travel", revision: 1, operations: ["downloadToLibrary"], policy: {} }] }
        : [{ key: "first", name: "First" }];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Season 1" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1" }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }]} defaultSourceProfileId="travel" onClose={() => undefined} onSubmit={vi.fn()}/>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(host.querySelector<HTMLInputElement>('input[name="source-strategy"][value="profile:travel"]')!.checked).toBe(true);
    expect(host.textContent).not.toContain("The profile this follow used is no longer available");
  });

  it("uses today's source choice without a warning when the remembered profile is not offered", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const body = String(url) === "/api/source-profiles"
        ? { profiles: [{ id: "provider", nameKey: "sourceProfile.providerPriority", revision: 1, operations: ["downloadToLibrary"], policy: {} }] }
        : [{ key: "first", name: "First" }];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Season 1" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1" }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }]} defaultSourceProfileId="travel" onClose={() => undefined} onSubmit={vi.fn()}/>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(host.querySelector<HTMLInputElement>('input[name="source-strategy"][value="largest"]')!.checked).toBe(true);
    expect(host.textContent).not.toContain("The profile this follow used is no longer available");
  });

  it("shows the default checkbox only for a different choice and does not remember an unticked one", async () => {
    const onRememberSourceProfile = vi.fn().mockResolvedValue(undefined);
    fetchMock.mockImplementation(async (url: string) => {
      const body = String(url) === "/api/source-profiles"
        ? { profiles: [
            { id: "travel", nameKey: "sourceProfile.travel", revision: 1, operations: ["downloadToLibrary"], policy: {} },
            { id: "provider", nameKey: "sourceProfile.providerPriority", revision: 1, operations: ["downloadToLibrary"], policy: {} },
          ] }
        : [{ key: "first", name: "First" }];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Season 1" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1" }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }]} defaultSourceProfileId="travel" onRememberSourceProfile={onRememberSourceProfile} onClose={() => undefined} onSubmit={vi.fn()}/>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector(".bulk-remember-profile")).toBeNull();

    await act(async () => { host.querySelector<HTMLInputElement>('input[name="source-strategy"][value="profile:provider"]')!.click(); });
    expect(host.querySelector(".bulk-remember-profile")).not.toBeNull();
    const add = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Add to queue"))!;
    await act(async () => { add.click(); await Promise.resolve(); });

    expect(onRememberSourceProfile).not.toHaveBeenCalled();
  });

  it("remembers a ticked source profile after a successful submit", async () => {
    const onRememberSourceProfile = vi.fn().mockResolvedValue(undefined);
    fetchMock.mockImplementation(async (url: string) => {
      const body = String(url) === "/api/source-profiles"
        ? { profiles: [
            { id: "travel", nameKey: "sourceProfile.travel", revision: 1, operations: ["downloadToLibrary"], policy: {} },
            { id: "provider", nameKey: "sourceProfile.providerPriority", revision: 1, operations: ["downloadToLibrary"], policy: {} },
          ] }
        : [{ key: "first", name: "First" }];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Season 1" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1" }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }]} defaultSourceProfileId="travel" onRememberSourceProfile={onRememberSourceProfile} onClose={() => undefined} onSubmit={vi.fn()}/>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { host.querySelector<HTMLInputElement>('input[name="source-strategy"][value="profile:provider"]')!.click(); });
    await act(async () => { host.querySelector<HTMLInputElement>(".bulk-remember-profile input")!.click(); });
    const add = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Add to queue"))!;
    await act(async () => { add.click(); await Promise.resolve(); });

    expect(onRememberSourceProfile).toHaveBeenCalledWith("provider");
  });

  it("remembers a legacy choice as no default", async () => {
    const onRememberSourceProfile = vi.fn().mockResolvedValue(undefined);
    fetchMock.mockImplementation(async (url: string) => {
      const body = String(url) === "/api/source-profiles"
        ? { profiles: [{ id: "travel", nameKey: "sourceProfile.travel", revision: 1, operations: ["downloadToLibrary"], policy: {} }] }
        : [{ key: "first", name: "First" }];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Season 1" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1" }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }]} defaultSourceProfileId="travel" onRememberSourceProfile={onRememberSourceProfile} onClose={() => undefined} onSubmit={vi.fn()}/>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { host.querySelector<HTMLInputElement>('input[name="source-strategy"][value="largest"]')!.click(); });
    await act(async () => { host.querySelector<HTMLInputElement>(".bulk-remember-profile input")!.click(); });
    const add = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Add to queue"))!;
    await act(async () => { add.click(); await Promise.resolve(); });

    expect(onRememberSourceProfile).toHaveBeenCalledWith(null);
  });

  it("ignores a failed attempt to remember the source choice and still closes", async () => {
    const onRememberSourceProfile = vi.fn().mockRejectedValue(new Error("offline"));
    const onClose = vi.fn();
    fetchMock.mockImplementation(async (url: string) => {
      const body = String(url) === "/api/source-profiles"
        ? { profiles: [
            { id: "travel", nameKey: "sourceProfile.travel", revision: 1, operations: ["downloadToLibrary"], policy: {} },
            { id: "provider", nameKey: "sourceProfile.providerPriority", revision: 1, operations: ["downloadToLibrary"], policy: {} },
          ] }
        : [{ key: "first", name: "First" }];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Season 1" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1" }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }]} defaultSourceProfileId="travel" onRememberSourceProfile={onRememberSourceProfile} onClose={onClose} onSubmit={vi.fn()}/>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { host.querySelector<HTMLInputElement>('input[name="source-strategy"][value="profile:provider"]')!.click(); });
    await act(async () => { host.querySelector<HTMLInputElement>(".bulk-remember-profile input")!.click(); });
    const add = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Add to queue"))!;
    await act(async () => { add.click(); await Promise.resolve(); await Promise.resolve(); });

    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps a follow's initial source profile ahead of the default one", async () => {
    const initial: FollowAutoDownload = {
      enabledAt: "2024-01-01T00:00:00.000Z",
      startMode: "new",
      selection: { addonKeys: ["first"], sourceStrategy: "priority", audioLanguage: "cs", subtitleMode: "off" },
      sourceProfile: { profileId: "provider", revision: 1 },
    };
    fetchMock.mockImplementation(async (url: string) => {
      const body = String(url) === "/api/source-profiles"
        ? { profiles: [
            { id: "travel", nameKey: "sourceProfile.travel", revision: 1, operations: ["downloadToLibrary"], policy: {} },
            { id: "provider", nameKey: "sourceProfile.providerPriority", revision: 1, operations: ["downloadToLibrary"], policy: {} },
          ] }
        : [{ key: "first", name: "First" }];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Show" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1" }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }]} follow={{ followId: "f1", initial }} defaultSourceProfileId="travel" onClose={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(host.querySelector<HTMLInputElement>('input[name="source-strategy"][value="profile:provider"]')!.checked).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[name="source-strategy"][value="profile:travel"]')!.checked).toBe(false);
  });

  it("offers only source profiles that can download to the library and have a known name", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const body = String(url) === "/api/source-profiles"
        ? { profiles: [
            { id: "travel", nameKey: "sourceProfile.travel", revision: 1, operations: ["downloadToLibrary"], policy: {} },
            { id: "play-only", nameKey: "sourceProfile.recommended", revision: 1, operations: ["play"], policy: {} },
            { id: "unknown-name", nameKey: "sourceProfile.unknown", revision: 1, operations: ["downloadToLibrary"], policy: {} },
          ] }
        : [{ key: "first", name: "First" }];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Season 1" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1" }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }]} onClose={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(host.querySelector('input[name="source-strategy"][value="profile:travel"]')).not.toBeNull();
    expect(host.querySelector('input[name="source-strategy"][value="profile:play-only"]')).toBeNull();
    expect(host.querySelector('input[name="source-strategy"][value="profile:unknown-name"]')).toBeNull();
  });

  it("offers and submits a named custom source profile without a translated hint", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    fetchMock.mockImplementation(async (url: string) => {
      const body = String(url) === "/api/source-profiles"
        ? { profiles: [{
            id: "kids-720",
            name: "Kids 720p",
            revision: 3,
            template: "travel",
            operations: ["downloadToLibrary"],
            policy: {},
          }] }
        : [{ key: "first", name: "First" }];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Season 1" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1" }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }]} onClose={() => undefined} onSubmit={onSubmit}/>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const option = host.querySelector<HTMLInputElement>('input[name="source-strategy"][value="profile:kids-720"]');
    expect(option).not.toBeNull();
    expect(option!.closest("label")?.textContent).toBe("Kids 720p");
    await act(async () => { option!.click(); });
    const add = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Add to queue"))!;
    await act(async () => { add.click(); await Promise.resolve(); });

    expect(onSubmit).toHaveBeenCalledWith({ profile: { profileId: "kids-720", revision: 3 } }, undefined);
  });

  it("keeps the legacy source choices when source profiles fail to load", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url) === "/api/source-profiles") throw new Error("offline");
      return new Response(JSON.stringify([{ key: "first", name: "First" }]), { status: 200, headers: { "content-type": "application/json" } });
    });
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Season 1" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1" }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }]} onClose={() => undefined} onSubmit={onSubmit}/>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect([...host.querySelectorAll<HTMLInputElement>('input[name="source-strategy"]')].map((input) => input.value)).toEqual(["largest", "priority"]);
    expect(host.textContent).not.toContain("The profile this follow used");
    const add = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Add to queue"))!;
    await act(async () => { add.click(); await Promise.resolve(); });
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ addonKeys: ["first"], sourceStrategy: "largest" }), undefined);
  });

  it("preselects an edited follow's source profile and saves it without follow defaults", async () => {
    const initial: FollowAutoDownload = {
      enabledAt: "2024-01-01T00:00:00.000Z",
      startMode: "new",
      graceDays: 14,
      selection: { addonKeys: ["first"], sourceStrategy: "priority", audioLanguage: "cs", audioMode: "listed", subtitleMode: "off" },
      sourceProfile: { profileId: "provider", revision: 1 },
    };
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const body = String(url) === "/api/source-profiles"
        ? { profiles: [{ id: "provider", nameKey: "sourceProfile.providerPriority", revision: 1, operations: ["downloadToLibrary"], policy: {} }] }
        : (init as RequestInit | undefined)?.method === "PATCH"
          ? { id: "f1", type: "series", metaId: "tt1", name: "Show", enabled: true, downloads: {} }
          : [{ key: "first", name: "First" }];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Show" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1" }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }]} follow={{ followId: "f1", initial }} onClose={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(host.querySelector<HTMLInputElement>('input[name="source-strategy"][value="profile:provider"]')!.checked).toBe(true);
    const save = [...host.querySelectorAll("button")].find((button) => button.textContent === "Turn on")!;
    await act(async () => { save.click(); await Promise.resolve(); await Promise.resolve(); });
    const patch = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "PATCH")!;
    const body = JSON.parse(String((patch[1] as RequestInit).body));
    expect(body.autoDownload.selection).toEqual({ profile: { profileId: "provider", revision: 1 } });
    expect(body.autoDownload.graceDays).toBe(0);
    expect(fetchMock.mock.calls.some(([url, init]) => String(url) === "/api/follows/defaults" && (init as RequestInit | undefined)?.method === "PUT")).toBe(false);
  });

  it("falls back to preferred addon first when an edited follow's profile is unavailable", async () => {
    const initial: FollowAutoDownload = {
      enabledAt: "2024-01-01T00:00:00.000Z",
      startMode: "new",
      selection: { addonKeys: ["first"], sourceStrategy: "priority", audioLanguage: "cs", subtitleMode: "off" },
      sourceProfile: { profileId: "removed", revision: 1 },
    };
    fetchMock.mockImplementation(async (url: string) => {
      const body = String(url) === "/api/source-profiles"
        ? { profiles: [{ id: "travel", nameKey: "sourceProfile.travel", revision: 1, operations: ["downloadToLibrary"], policy: {} }] }
        : [{ key: "first", name: "First" }];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Show" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1" }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }]} follow={{ followId: "f1", initial }} onClose={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(host.querySelector<HTMLInputElement>('input[name="source-strategy"][value="priority"]')!.checked).toBe(true);
    expect(host.textContent).toContain("The profile this follow used is no longer available. Choose another one.");
  });

  it("submits ordered sources and per-batch language choices", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Season 1" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1" }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }, { code: "en", name: "English" }]} onClose={() => undefined} onSubmit={onSubmit}/>); });
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
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ addonKeys: ["second", "first"], sourceStrategy: "priority", audioLanguage: "cs", fallbackAudioLanguage: "en", audioMode: "listed", subtitleMode: "required", subtitleLanguage: "cs" }), undefined);
  });

  it("submits the chosen audio matching mode", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Season 1" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1" }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }, { code: "en", name: "English" }]} onClose={() => undefined} onSubmit={onSubmit}/>); });
    await act(async () => { await Promise.resolve(); });
    const audioMode = [...host.querySelectorAll("select")].find((select) => [...select.options].some((option) => option.value === "preferred"))!;
    await act(async () => { audioMode.value = "preferred"; audioMode.dispatchEvent(new Event("change", { bubbles: true })); });
    const add = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Add to queue"))!;
    await act(async () => { add.click(); await Promise.resolve(); });
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ audioMode: "preferred" }), undefined);
  });

  it("defaults a follow rule to priority and saves through updateFollow", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Show" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1" }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }, { code: "en", name: "English" }]} follow={{ followId: "f1" }} onClose={() => undefined} onSubmit={onSubmit}/>); });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector<HTMLInputElement>('input[name="source-strategy"][value="priority"]')!.checked).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[name="source-strategy"][value="largest"]')!.checked).toBe(false);
    const save = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Turn on"))!;
    await act(async () => { save.click(); await Promise.resolve(); });
    const patch = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "PATCH");
    expect(String(patch?.[0])).toContain("/api/follows/f1");
    const body = JSON.parse(String((patch?.[1] as RequestInit).body));
    expect(body.autoDownload.startMode).toBe("new");
    expect(body.autoDownload.selection.sourceStrategy).toBe("priority");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("prefills and sends the preferred-audio window", async () => {
    const initial: FollowAutoDownload = { enabledAt: "2024-01-01T00:00:00.000Z", startMode: "new", graceDays: 14, selection: { addonKeys: ["first"], sourceStrategy: "priority", audioLanguage: "cs", audioMode: "preferred", subtitleMode: "off" } };
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Show" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1" }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }]} follow={{ followId: "f1", initial }} onClose={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); });
    const grace = [...host.querySelectorAll("select")].find((select) => [...select.options].some((option) => option.value === "14"))!;
    expect(grace.value).toBe("14");
    const save = [...host.querySelectorAll("button")].find((button) => button.textContent === "Turn on")!;
    await act(async () => { save.click(); await Promise.resolve(); });
    const patch = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "PATCH")!;
    expect(JSON.parse(String((patch[1] as RequestInit).body)).autoDownload.graceDays).toBe(14);
  });

  it("sends an ahead rule with its episode count", async () => {
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Show" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1", season: 1, episode: 1 }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }]} follow={{ followId: "f1" }} onClose={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); });
    const ahead = host.querySelector<HTMLInputElement>('input[name="follow-start"][value="ahead"]')!;
    await act(async () => { ahead.click(); });
    const count = [...host.querySelectorAll("select")].find((select) => select.getAttribute("aria-label") === "Keep episodes ready from where I am watching")!;
    expect(count.value).toBe("3");
    await act(async () => { count.value = "5"; count.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); });
    const save = [...host.querySelectorAll("button")].find((button) => button.textContent === "Turn on")!;
    await act(async () => { save.click(); await Promise.resolve(); });
    const patch = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "PATCH")!;
    const body = JSON.parse(String((patch[1] as RequestInit).body));
    expect(body.autoDownload.startMode).toBe("ahead");
    expect(body.autoDownload.aheadCount).toBe(5);
  });

  it("creates the follow under the add-on the title came from", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const body = String(url).includes("/api/follows")
        ? { id: "f9", type: "series", metaId: "tt1", name: "Show", enabled: true, downloads: {} }
        : [{ key: "first", name: "First" }];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Show" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1", season: 1, episode: 1 }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }]} follow={{ create: { metaId: "tt1", name: "Show", addonKey: "pleasure" }, onFollowed: () => undefined }} onClose={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); });
    const follow = [...host.querySelectorAll("button")].find((button) => button.textContent === "Follow")!;
    await act(async () => { follow.click(); await Promise.resolve(); await Promise.resolve(); });
    const post = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/api/follows") && (init as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((post![1] as RequestInit).body)).addonKey).toBe("pleasure");
  });

  it("asks how to follow first and only creates the follow on confirm", async () => {
    const onFollowed = vi.fn();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const body = String(url).includes("/api/follows")
        ? { id: "f9", type: "series", metaId: "tt1", name: "Show", enabled: true, downloads: {} }
        : [{ key: "first", name: "First" }];
      void init;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Show" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1", season: 1, episode: 1 }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }]} follow={{ create: { metaId: "tt1", name: "Show" }, onFollowed }} onClose={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector<HTMLInputElement>('input[name="follow-mode"][value="notify"]')!.checked).toBe(true);
    expect(host.querySelector('input[name="source-strategy"]'), "download settings stay hidden for notify-only").toBeNull();
    const writes = fetchMock.mock.calls.filter(([url, init]) => String(url).includes("/api/follows") && (init as RequestInit | undefined)?.method !== undefined);
    expect(writes, "nothing is saved before confirming").toEqual([]);

    const follow = [...host.querySelectorAll("button")].find((button) => button.textContent === "Follow")!;
    await act(async () => { follow.click(); await Promise.resolve(); await Promise.resolve(); });
    const calls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/follows"));
    expect(calls.map(([, init]) => (init as RequestInit | undefined)?.method ?? "GET")).toEqual(["GET", "POST", "PUT"]);
    expect(onFollowed).toHaveBeenCalledWith(expect.objectContaining({ id: "f9" }));
  });

  it("follows and switches automatic downloads on in one confirmation", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const body = String(url).includes("/api/follows")
        ? { id: "f9", type: "series", metaId: "tt1", name: "Show", enabled: true, downloads: {} }
        : [{ key: "first", name: "First" }];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Show" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1", season: 1, episode: 1 }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }]} follow={{ create: { metaId: "tt1", name: "Show" }, onFollowed: () => undefined }} onClose={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { host.querySelector<HTMLInputElement>('input[name="follow-mode"][value="download"]')!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector<HTMLInputElement>('input[name="source-strategy"][value="priority"]')!.checked).toBe(true);
    const confirm = [...host.querySelectorAll("button")].find((button) => button.textContent === "Follow and download")!;
    await act(async () => { confirm.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const calls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/follows"));
    expect(calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${String(url)}`)).toEqual([
      "GET /api/follows/defaults", "POST /api/follows", "PATCH /api/follows/f9", "PUT /api/follows/defaults",
    ]);
    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT")!;
    expect(JSON.parse(String((put[1] as RequestInit).body))).toMatchObject({ mode: "download", startMode: "new" });
  });

  it("prefills a new follow from the stored defaults", async () => {
    fetchMock.mockImplementation(async (url: string) => String(url).includes("/api/follows/defaults")
      ? new Response(JSON.stringify({ defaults: { mode: "download", startMode: "from", graceDays: 7, selection: { addonKeys: ["second"], sourceStrategy: "priority", audioLanguage: "en", audioMode: "preferred", subtitleMode: "off" } } }), { status: 200, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify([{ key: "first", name: "First" }, { key: "second", name: "Second" }]), { status: 200, headers: { "content-type": "application/json" } }));
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Show" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1", season: 1, episode: 1 }]} audioLanguage="en" subtitleLanguage="en" languages={[{ code: "en", name: "English" }]} follow={{ create: { metaId: "tt1", name: "Show" }, onFollowed: () => undefined }} onClose={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector<HTMLInputElement>('input[name="follow-mode"][value="download"]')!.checked).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[name="follow-start"][value="from"]')!.checked).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[name="source-strategy"][value="priority"]')!.checked).toBe(true);
    const grace = [...host.querySelectorAll("select")].find((select) => [...select.options].some((option) => option.value === "14"))!;
    expect(grace.value).toBe("7");
    const sources = [...host.querySelectorAll<HTMLElement>(".bulk-sources label")];
    expect(sources.find((label) => label.textContent?.includes("Second"))!.querySelector("input")!.checked).toBe(true);
    expect(sources.find((label) => label.textContent?.includes("First"))!.querySelector("input")!.checked).toBe(false);
  });

  it("keeps a control the user changed before the defaults arrive", async () => {
    let release: (body: unknown) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => { release = (body) => resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })); });
    fetchMock.mockImplementation(async (url: string) => String(url).includes("/api/follows/defaults")
      ? pending
      : new Response(JSON.stringify([{ key: "first", name: "First" }]), { status: 200, headers: { "content-type": "application/json" } }));
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Show" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1", season: 1, episode: 1 }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }]} follow={{ create: { metaId: "tt1", name: "Show" }, onFollowed: () => undefined }} onClose={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { host.querySelector<HTMLInputElement>('input[name="follow-mode"][value="download"]')!.click(); });
    await act(async () => { release({ defaults: { mode: "notify" } }); await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector<HTMLInputElement>('input[name="follow-mode"][value="download"]')!.checked).toBe(true);
  });

  it("neither reads nor writes defaults while editing a follow", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([{ key: "first", name: "First" }]), { status: 200, headers: { "content-type": "application/json" } }));
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Show" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1", season: 1, episode: 1 }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }]} follow={{ followId: "f1" }} onClose={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/follows/defaults"))).toBe(false);
    const save = [...host.querySelectorAll("button")].find((button) => button.textContent === "Turn on")!;
    await act(async () => { save.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/follows/defaults"))).toBe(false);
  });

  it("following a film asks no start episode and uses the film wording", async () => {
    fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify(String(url).includes("/api/follows") ? { defaults: null } : [{ key: "first", name: "First" }]), { status: 200, headers: { "content-type": "application/json" } }));
    await act(async () => { root.render(<SeriesDownloadDialog type="movie" label="Film" title="Film" libraries={[]} addons={[]} episodes={[{ id: "tt9" }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }]} follow={{ create: { metaId: "tt9", name: "Film" }, onFollowed: () => undefined }} onClose={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector("h2")!.textContent).toBe("Follow film");
    expect(host.textContent).toContain("Only tell me when it comes out");
    await act(async () => { host.querySelector<HTMLInputElement>('input[name="follow-mode"][value="download"]')!.click(); });
    expect(host.querySelector('input[name="follow-start"]'), "no where-to-start for a film").toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/stream-sources/movie/tt9"))).toBe(true);
  });

  it("shows the after-watching choice for an administrator's series and sends it", async () => {
    const initial: FollowAutoDownload = { enabledAt: "2024-01-01T00:00:00.000Z", startMode: "new", selection: { addonKeys: ["first"], sourceStrategy: "priority", audioLanguage: "cs", audioMode: "listed", subtitleMode: "off" } };
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Show" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1", season: 1, episode: 1 }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }]} follow={{ followId: "f1", initial }} canRetain onClose={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain("After watching");
    const select = [...host.querySelectorAll("select")].find((entry) => [...entry.options].some((option) => option.textContent === "Delete 30 days after watching"))!;
    await act(async () => { select.value = "7"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    const save = [...host.querySelectorAll("button")].find((button) => button.textContent === "Turn on")!;
    await act(async () => { save.click(); await Promise.resolve(); });
    const patch = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "PATCH")!;
    expect(JSON.parse(String((patch[1] as RequestInit).body)).retention).toEqual({ afterWatchedDays: 7 });
  });

  it("hides the after-watching choice from a plain account and for a film", async () => {
    await act(async () => { root.render(<SeriesDownloadDialog type="series" label="Show" title="Show" libraries={[]} addons={[]} episodes={[{ id: "tt1:1:1", season: 1, episode: 1 }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }]} follow={{ followId: "f1" }} onClose={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).not.toContain("After watching");
    await act(async () => { root.render(<SeriesDownloadDialog type="movie" label="Film" title="Film" libraries={[]} addons={[]} episodes={[{ id: "tt9" }]} audioLanguage="cs" subtitleLanguage="cs" languages={[{ code: "cs", name: "Čeština" }]} follow={{ followId: "f1" }} canRetain onClose={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).not.toContain("After watching");
  });
});
