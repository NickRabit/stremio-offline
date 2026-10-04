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
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/follows")), "nothing is saved before confirming").toBe(false);

    const follow = [...host.querySelectorAll("button")].find((button) => button.textContent === "Follow")!;
    await act(async () => { follow.click(); await Promise.resolve(); await Promise.resolve(); });
    const calls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/follows"));
    expect(calls.map(([, init]) => (init as RequestInit | undefined)?.method)).toEqual(["POST"]);
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
    expect(calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method} ${String(url)}`)).toEqual(["POST /api/follows", "PATCH /api/follows/f9"]);
  });
});
