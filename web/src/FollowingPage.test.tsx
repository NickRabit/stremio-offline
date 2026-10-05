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

/** A screen of the given width answering min-/max-width queries the way a browser would. */
const stubMatchMedia = (width: number) => vi.stubGlobal("matchMedia", (query: string) => ({
  matches: (() => {
    const bound = Number(/(\d+)px/.exec(query)?.[1] ?? 0);
    return query.includes("max-width") ? width <= bound : width >= bound;
  })(), media: query, onchange: null,
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
  stubMatchMedia(1280);
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

  it("places an episode on its day in the month grid and lists it for the chosen day", async () => {
    fetchMock.mockImplementation(async (url: string) => String(url).includes("/api/follows/calendar")
      ? json({ items: [{ followId: "f1", type: "series", metaId: "tt1", name: "Show", videoId: "v1", season: 1, episode: 2, title: "Pilot", released: new Date().toISOString(), state: "released" }], undated: [] })
      : json({ items: [] }));
    await render([]);
    await clickTab("Calendar");
    const today = host.querySelector(".following-day.today")!;
    const event = today.querySelector<HTMLButtonElement>(".following-event")!;
    expect(event.className).toContain("state-released");
    expect(event.textContent).toBe("ShowS01E02");
    expect(today.querySelector(".following-day-dots i.state-released"), "the narrow layout shows a dot").not.toBeNull();
    // Today is the chosen day when the calendar opens.
    const panel = host.querySelector(".following-day-panel")!;
    expect(panel.querySelector("h4")!.textContent).toMatch(/^Today · /);
    expect(panel.querySelector(".following-episode-copy small")!.textContent).toBe("S01E02 · Pilot");
    expect(panel.querySelector(".state-pill")!.textContent).toBe("Released");
  });

  it("choosing another day lists that day's episodes", async () => {
    const other = new Date(); other.setDate(other.getDate() === 15 ? 16 : 15); other.setHours(20, 0, 0, 0);
    fetchMock.mockImplementation(async (url: string) => String(url).includes("/api/follows/calendar")
      ? json({ items: [{ followId: "f1", type: "series", metaId: "tt1", name: "Show", videoId: "v1", season: 1, episode: 5, released: other.toISOString(), state: "waiting" }], undated: [] })
      : json({ items: [] }));
    await render([]);
    await clickTab("Calendar");
    expect(host.querySelector(".following-day-panel .following-episode-row")).toBeNull();
    const day = [...host.querySelectorAll(".following-day.busy")][0]!;
    await act(async () => { day.querySelector<HTMLButtonElement>(".following-day-hit")!.click(); });
    expect(day.className).toContain("selected");
    expect(host.querySelector(".following-day-panel .state-pill")!.textContent).toBe("Waiting for a source");
  });

  it("a phone opens the calendar as a list grouped by day", async () => {
    stubMatchMedia(390);
    fetchMock.mockImplementation(async (url: string) => String(url).includes("/api/follows/calendar")
      ? json({ items: [{ followId: "f1", type: "series", metaId: "tt1", name: "Show", videoId: "v1", season: 1, episode: 2, title: "Pilot", released: new Date().toISOString(), state: "waiting" }], undated: [] })
      : json({ items: [] }));
    await render([]);
    await clickTab("Calendar");
    expect(host.querySelector(".following-calendar"), "no month grid on a phone by default").toBeNull();
    const day = host.querySelector(".following-agenda-day.today")!;
    expect(day.querySelector(".following-agenda-date b")!.textContent).toBe(String(new Date().getDate()));
    expect(day.querySelector(".following-episode-copy small")!.textContent).toBe("S01E02 · Pilot");
    const month = [...host.querySelectorAll<HTMLButtonElement>(".following-cal-mode button")].find((button) => button.textContent === "Month")!;
    await act(async () => { month.click(); });
    expect(host.querySelector(".following-calendar")).not.toBeNull();
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

    const event = host.querySelector<HTMLButtonElement>(".following-event")!;
    expect(event.querySelector("small")!.textContent).toBe("≈ S01E02");
    expect(event.getAttribute("title")).toBe("The exact date is not announced yet; this is the season's start.");

    const block = host.querySelector(".following-undated")!;
    expect(block.querySelector("h4")!.textContent).toBe("Date not announced");
    expect(block.querySelector(".following-episode-copy small")!.textContent).toBe("≈ S01E03");
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

  it("creates a calendar feed link and clears it again on revoke", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!String(url).includes("/api/follows/calendar-feed")) return json({ items: [] });
      if (init?.method === "POST") return json({ token: "tok123" });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json({ token: null });
    });
    vi.stubGlobal("confirm", () => true);
    await render([]);
    await clickTab("Calendar");
    const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(".following-feed button")].find((item) => item.textContent === label);

    await act(async () => { button("Subscribe in a calendar app…")!.click(); await Promise.resolve(); await Promise.resolve(); });
    const input = host.querySelector<HTMLInputElement>(".following-feed-url")!;
    expect(input.value).toBe(`${window.location.origin}/calendar/tok123.ics`);
    expect(input.readOnly).toBe(true);
    expect(host.querySelector<HTMLAnchorElement>(".following-feed a")!.getAttribute("href")).toBe(`webcal://${window.location.host}/calendar/tok123.ics`);

    await act(async () => { button("Revoke link")!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector(".following-feed-url")).toBeNull();
    expect(button("Subscribe in a calendar app…")).toBeTruthy();
  });
});
