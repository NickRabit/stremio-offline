import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FollowDialog } from "./FollowDialog";
import { setLocale } from "./i18n";
import type { FollowEpisodeRow, FollowView } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const follow: FollowView = {
  id: "f1", ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show",
  createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z",
  enabled: true, revision: 1, nextCheckAt: "2024-01-02T00:00:00.000Z", failures: 0,
  episodeCount: 6,
  nextEpisode: { season: 1, episode: 3, released: "2030-01-01" },
  autoDownload: { enabledAt: "2024-01-01T00:00:00.000Z", startMode: "new", selection: { addonKeys: ["first"], sourceStrategy: "priority", audioLanguage: "en", subtitleMode: "off" } },
  downloads: { queued: 1, waiting: 1, completed: 1, skipped: 1, attention: 1 },
};

const episodes: FollowEpisodeRow[] = [
  { key: "1:1", season: 1, episode: 1, title: "Queued", released: "2024-01-01", eligibility: "eligible", download: { state: "queued", intent: "a", generation: 1, attempts: 0, updatedAt: "" } },
  { key: "1:2", season: 1, episode: 2, title: "Waiting", released: "2024-01-08", eligibility: "eligible", download: { state: "waiting", intent: "b", generation: 1, attempts: 1, nextAttemptAt: "2099-01-01T00:00:00.000Z", reasonKey: "err.followDownloadFailed", updatedAt: "" } },
  { key: "1:3", season: 1, episode: 3, title: "Done", released: "2024-01-15", eligibility: "eligible", download: { state: "completed", intent: "c", generation: 1, attempts: 1, updatedAt: "" } },
  { key: "1:4", season: 1, episode: 4, title: "Skipped", released: "2024-01-22", eligibility: "eligible", download: { state: "skipped", intent: "d", generation: 1, attempts: 0, reasonKey: "err.followSkipped", updatedAt: "" } },
  { key: "1:5", season: 1, episode: 5, title: "Broken", released: "2024-01-29", eligibility: "eligible", download: { state: "attention", intent: "e", generation: 1, attempts: 0, reasonKey: "err.followNoReleaseDate", updatedAt: "" } },
  { key: "1:6", season: 1, episode: 6, title: "Later", eligibility: "upcoming" },
];

let fetchMock: ReturnType<typeof vi.fn>;
let root: Root;
let host: HTMLDivElement;

const render = async (value: FollowView = follow, overrides: Partial<FollowEpisodeRow[]> = episodes) => {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.includes("/episodes/") && target.endsWith("/skip")) return Promise.resolve(new Response(null, { status: 204 }));
    if (target.includes("/episodes/") && target.endsWith("/retry")) return Promise.resolve(new Response(null, { status: 204 }));
    if (target.includes("/episodes")) return Promise.resolve(json({ episodes: overrides }));
    if (target.includes("/by-meta/")) return Promise.resolve(json(value));
    if (init?.method === "PATCH") return Promise.resolve(json({ ...value, enabled: !value.enabled, revision: value.revision + 1 }));
    return Promise.resolve(json(value));
  });
  await act(async () => {
    root.render(<FollowDialog follow={value} languages={[{ code: "en", name: "English" }]} libraries={[]} addons={[]} audioLanguage="en" subtitleLanguage="en" onChanged={() => undefined} onClose={() => undefined} onNotify={() => undefined}/>);
  });
  await act(async () => { await Promise.resolve(); });
};

const rowFor = (code: string) => [...host.querySelectorAll<HTMLElement>(".follow-episode")].find((row) => row.textContent?.includes(code));
const button = (container: HTMLElement, label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("FollowDialog", () => {
  it("renders the status, summary and every episode state", async () => {
    await render();
    const text = host.textContent ?? "";
    expect(text).toContain("Show");
    expect(text).toContain("Following");
    expect(text).toContain("Next episode: S01E03");
    expect(text).toContain("In the queue");
    expect(text).toContain("Waiting for a source");
    expect(text).toContain("Downloaded");
    expect(text).toContain("Skipped");
    expect(text).toContain("Needs attention");
    expect(text).toContain("Not released yet");
    expect(text).toContain("1 queued");
  });

  it("pauses the follow as soon as the switch changes", async () => {
    await render();
    const pause = host.querySelector<HTMLInputElement>(".follow-pause input[type=checkbox]")!;
    await act(async () => { pause.click(); await Promise.resolve(); });
    const patch = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "PATCH");
    expect(String(patch?.[0])).toContain("/api/follows/f1");
    expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({ enabled: false });
  });

  it("skips a queued episode and retries a waiting one", async () => {
    await render();
    await act(async () => { button(rowFor("S01E01")!, "Skip")!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock.mock.calls.some((call) => decodeURIComponent(String(call[0])).endsWith("/episodes/1:1/skip"))).toBe(true);
    await act(async () => { button(rowFor("S01E02")!, "Retry")!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock.mock.calls.some((call) => decodeURIComponent(String(call[0])).endsWith("/episodes/1:2/retry"))).toBe(true);
  });
});
