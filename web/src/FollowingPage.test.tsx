import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FollowingPage } from "./FollowingPage";
import { setLocale } from "./i18n";
import type { FollowView } from "./types";

const downloads = { queued: 0, waiting: 0, completed: 0, skipped: 0, attention: 0 };
const follow = (overrides: Partial<FollowView>): FollowView => ({
  id: "f1", ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show",
  createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z",
  enabled: true, revision: 1, nextCheckAt: "2024-01-02T00:00:00.000Z", failures: 0,
  episodeCount: 0, downloads: { ...downloads },
  ...overrides,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
let root: Root;
let host: HTMLDivElement;

const stubMatchMedia = (wide: boolean) => vi.stubGlobal("matchMedia", (query: string) => ({
  matches: wide, media: query, onchange: null,
  addEventListener: () => undefined, removeEventListener: () => undefined,
  addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
}));

const render = async (follows: FollowView[]) => {
  await act(async () => {
    root.render(<FollowingPage follows={follows} newEpisodes={[]} languages={[]} libraries={[]} addons={[]}
      audioLanguage="en" subtitleLanguage="en" onChanged={() => undefined} onOpenSeries={() => undefined} onNotify={() => undefined}/>);
  });
};

const clickTab = async (label: string) => {
  const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((item) => item.textContent === label)!;
  await act(async () => { tab.click(); await Promise.resolve(); await Promise.resolve(); });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  stubMatchMedia(true);
  fetchMock = vi.fn().mockResolvedValue(json({ items: [] }));
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("FollowingPage", () => {
  it("renders the three tabs and switches them with the arrow keys", async () => {
    await render([]);
    const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect([...tabs].map((tab) => tab.textContent)).toEqual(["Overview", "Calendar", "Activity"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");

    await act(async () => { tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect(host.querySelector<HTMLButtonElement>('[role="tab"]')!.getAttribute("aria-selected")).toBe("false");
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector('[role="tabpanel"]')!.getAttribute("aria-labelledby")).toBe("following-tab-calendar");
  });

  it("puts a follow that needs attention first in the overview", async () => {
    await render([
      follow({ id: "b", name: "Beta" }),
      follow({ id: "a", name: "Alpha", downloads: { ...downloads, attention: 2 } }),
    ]);
    expect([...host.querySelectorAll(".following-card strong")].map((node) => node.textContent)).toEqual(["Alpha", "Beta"]);
    expect(host.querySelector(".following-chip.attention")!.textContent).toBe("2 to resolve");
  });

  it("places an episode on its day in the month grid", async () => {
    fetchMock.mockImplementation(async (url: string) => String(url).includes("/api/follows/calendar")
      ? json({ items: [{ followId: "f1", type: "series", metaId: "tt1", name: "Show", videoId: "v1", season: 1, episode: 2, released: new Date().toISOString(), state: "released" }] })
      : json({ items: [] }));
    await render([]);
    await clickTab("Calendar");
    const item = host.querySelector<HTMLButtonElement>(".following-cal-item")!;
    expect(item.textContent).toBe("Show S01E02");
    expect(item.className).toContain("cal-released");
    expect(host.querySelector(".following-day.today")!.contains(item)).toBe(true);
  });

  it("groups an episode under its day in the agenda", async () => {
    stubMatchMedia(false);
    fetchMock.mockImplementation(async (url: string) => String(url).includes("/api/follows/calendar")
      ? json({ items: [{ followId: "f1", type: "series", metaId: "tt1", name: "Show", videoId: "v1", season: 1, episode: 2, title: "Pilot", released: new Date().toISOString(), state: "released" }] })
      : json({ items: [] }));
    await render([]);
    await clickTab("Calendar");
    expect(host.querySelector(".following-agenda-day h4")!.textContent).toBe("Today");
    expect(host.querySelector(".following-agenda-row small")!.textContent).toBe("S01E02 · Pilot");
  });

  it("marks an uncertain date and lists undated episodes apart", async () => {
    fetchMock.mockImplementation(async (url: string) => String(url).includes("/api/follows/calendar")
      ? json({
          items: [{ followId: "f1", type: "series", metaId: "tt1", name: "Show", videoId: "v1", season: 1, episode: 2, released: new Date().toISOString(), state: "upcoming", dateUncertain: true }],
          undated: [{ followId: "f1", type: "series", metaId: "tt1", name: "Show", videoId: "v2", season: 1, episode: 3, state: "upcoming", dateUncertain: true }],
        })
      : json({ items: [] }));
    await render([]);
    await clickTab("Calendar");

    const item = host.querySelector<HTMLButtonElement>(".following-cal-item")!;
    expect(item.textContent).toBe("≈ Show S01E02");
    expect(item.getAttribute("title")).toBe("The exact date is not announced yet; this is the season's start.");

    const block = host.querySelector(".following-undated")!;
    expect(block.querySelector("h4")!.textContent).toBe("Date not announced");
    expect(block.querySelector(".following-agenda-row")!.textContent).toContain("≈ Show");
  });

  it("retries a waiting episode from the activity tab", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!String(url).includes("/api/follows/activity")) return new Response(null, { status: 204 });
      void init;
      return json({ items: [{ followId: "f1", type: "series", metaId: "tt1", name: "Show", season: 1, episode: 2, state: "waiting", nextAttemptAt: "2030-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z" }] });
    });
    await render([]);
    await clickTab("Activity");
    const retry = [...host.querySelectorAll<HTMLButtonElement>(".following-activity-row button")].find((button) => button.textContent === "Retry")!;
    await act(async () => { retry.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/follows/f1/episodes/1%3A2/retry")).toBe(true);
  });
});
