import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StatsPanel } from "./Stats";
import type { StatsBucket, StatsBucketHost, StatsSummary } from "./types";
import { localeTag, setLocale } from "./i18n";
import { en } from "./i18n/en";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The panel formats decimal units, so the fixtures count in the same ones. */
const GB = 1_000_000_000;

const host = (key: string, bytes: number): StatsBucketHost => ({ key, label: key, bytes, items: 1 });
const bucket = (key: string, bytes: number, hosts?: StatsBucketHost[]): StatsBucket =>
  ({ key, label: key, bytes, count: hosts?.length ?? 1, ...(hosts ? { hosts } : {}) });

/** Ten rows of each long breakdown: two thirds of them sit behind the control. */
const domains = [
  bucket("real-debrid.com", 13 * GB, [
    host("den2-4.download.real-debrid.com", 9 * GB),
    host("131-4.download.real-debrid.com", 4 * GB),
  ]),
  ...Array.from({ length: 9 }, (_, index) => bucket(`host${index}.test`, (9 - index) * GB)),
];
const addons = Array.from({ length: 10 }, (_, index) => bucket(`addon-${index}`, (10 - index) * GB));

const data: StatsSummary = {
  hour: { bytes: 0, count: 0 }, day: { bytes: 0, count: 0 }, week: { bytes: 0, count: 0 },
  month: { bytes: 0, count: 0 }, total: { bytes: 0, count: 0 },
  step: "hour",
  points: [
    { at: "2026-09-02T17:00:00.000Z", bytes: 4 * GB, count: 1 },
    { at: "2026-09-02T18:00:00.000Z", bytes: 0, count: 0 },
  ],
  providers: domains,
  addons,
  sources: [bucket("download", 4 * GB)],
  byProvider: domains.map((item) => ({ key: item.key, label: item.label, points: [4 * GB, 0] })),
  byAddon: addons.map((item) => ({ key: item.key, label: item.label, points: [4 * GB, 0] })),
  bySource: [{ key: "download", label: "Downloads", points: [4 * GB, 0] }],
};

let fetchMock: ReturnType<typeof vi.fn>;
let root: Root;
let hostElement: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  fetchMock = vi.fn((input: RequestInfo | URL) =>
    Promise.resolve(json(String(input).includes("/api/stats/activity") ? { items: [], users: [], total: 0 } : String(input).includes("/api/stats/streams") ? [] : data)));
  vi.stubGlobal("fetch", fetchMock);
  hostElement = document.createElement("div");
  document.body.appendChild(hostElement);
  root = createRoot(hostElement);
});

afterEach(() => {
  act(() => root.unmount());
  hostElement.remove();
  vi.unstubAllGlobals();
});

const render = async () => {
  await act(async () => { root.render(<StatsPanel onError={vi.fn()}/>); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
};

it("counts the calls that reached the media server, in total and by kind", async () => {
  const withProvider: StatsSummary = { ...data, provider: {
    info: 1, login: 1, user: 1, views: 2, items: 0, directory: 4, match: 0,
    detail: 3, ancestors: 1, versions: 2, artwork: 12, subtitle: 0, original: 0, playback: 0,
  } };
  fetchMock.mockImplementation((input: RequestInfo | URL) => Promise.resolve(json(
    String(input).includes("/api/stats/activity") ? { items: [], users: [], total: 0 }
      : String(input).includes("/api/stats/streams") ? [] : withProvider)));
  await render();
  const cards = [...hostElement.querySelectorAll(".stats-card")].map((card) => card.textContent);
  expect(cards).toContain("All calls27");
  expect(cards).toContain("Browsing4");
  expect(cards).toContain("Pictures12");
});

/** The first panel is the provider breakdown, the second the addon one. */
const panel = (order: number) => hostElement.querySelectorAll(".stats-breakdown")[order] as HTMLElement;
const rows = (order: number) => panel(order).querySelectorAll(".stats-pick").length;
const control = (order: number, text: string) =>
  [...panel(order).querySelectorAll("button")].find((node) => node.textContent === text);

it("shows eight provider rows until the rest are asked for", async () => {
  await render();
  expect(rows(0)).toBe(8);
  expect(hostElement.textContent).toContain("Show all 10");

  await act(async () => { control(0, "Show all 10")?.click(); });
  expect(rows(0)).toBe(10);
  expect(hostElement.textContent).toContain("Show fewer");

  await act(async () => { control(0, "Show fewer")?.click(); });
  expect(rows(0)).toBe(8);
});

it("caps the addon breakdown the same way", async () => {
  await render();
  expect(rows(1)).toBe(8);
  await act(async () => { control(1, "Show all 10")?.click(); });
  expect(rows(1)).toBe(10);
});

it("opens a provider row onto the hosts behind it, largest first", async () => {
  await render();
  expect(hostElement.textContent).not.toContain("131-4.download.real-debrid.com");

  await act(async () => { control(0, "2 servers")?.click(); });
  const hosts = [...panel(0).querySelectorAll(".stats-hosts li")].map((row) => row.textContent);
  expect(hosts).toEqual([
    "den2-4.download.real-debrid.com · 9.0 GB · Finished: 1",
    "131-4.download.real-debrid.com · 4.0 GB · Finished: 1",
  ]);

  await act(async () => { control(0, "Show fewer")?.click(); });
  expect(hostElement.textContent).not.toContain("131-4.download.real-debrid.com");
});

it("still plots a grouped row when it is selected, and survives opening it", async () => {
  await render();
  const pick = () => panel(0).querySelector(".stats-pick") as HTMLButtonElement;
  expect(pick().getAttribute("aria-pressed")).toBe("false");

  await act(async () => { pick().click(); });
  expect(pick().getAttribute("aria-pressed")).toBe("true");
  expect(pick().querySelector(".stats-name")?.textContent).toBe("real-debrid.com");
  expect(hostElement.querySelectorAll("svg.stats-lines polyline").length).toBe(1);

  await act(async () => { control(0, "2 servers")?.click(); });
  expect(pick().getAttribute("aria-pressed")).toBe("true");
  expect(hostElement.querySelectorAll("svg.stats-lines polyline").length).toBe(1);

  await act(async () => { pick().click(); });
  expect(pick().getAttribute("aria-pressed")).toBe("false");
});


it("filters history on the server, pages by cursor and does not poll it with live streams", async () => {
  vi.useFakeTimers();
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname !== "/api/stats/activity") return Promise.resolve(json(url.pathname.endsWith("streams") ? [] : data));
    const older = url.searchParams.has("before");
    return Promise.resolve(json({ items: [{ id: older ? 1 : 2, at: "2026-09-21T12:00:00Z", kind: "device", title: older ? "Older.mkv" : "Recent.mkv", username: "Ada" }], users: [{ id: "ada", username: "Ada" }], total: 2, next: older ? undefined : 2 }));
  });
  await render();
  const history = hostElement.querySelector(".stats-history")!;
  expect(history.textContent).toContain("Recent.mkv");
  expect(history.textContent).toContain("Ada");
  await act(async () => { [...history.querySelectorAll("button")].find((button) => button.textContent === "Older")!.click(); });
  expect(history.textContent).toContain("Older.mkv");
  const select = history.querySelector("select")!;
  await act(async () => { select.value = "device"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(history.textContent).toContain("Recent.mkv");
  const urls = fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes("/activity"));
  expect(urls.at(-1)).toContain("kind=device");
  expect(urls.at(-1)).not.toContain("before=");
  const streamCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes("/streams")).length;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/streams"))).toHaveLength(streamCalls + 2);
  expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/activity"))).toHaveLength(urls.length);
  vi.useRealTimers();
});

it("does not poll live streams while the tab is hidden, and picks up again once it is shown", async () => {
  vi.useFakeTimers();
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/stats/activity") return Promise.resolve(json({ items: [], users: [], total: 0 }));
    return Promise.resolve(json(url.pathname.endsWith("streams") ? [] : data));
  });
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  try {
    await render();
    const streams = () => fetchMock.mock.calls.filter(([input]) => String(input).includes("/streams")).length;
    const first = streams();
    expect(first).toBe(1);
    hidden.mockReturnValue(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(streams(), "a hidden tab asks nothing").toBe(first);
    hidden.mockReturnValue(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(streams(), "the next tick after the tab is shown asks again").toBe(first + 1);
  } finally {
    hidden.mockRestore();
    vi.useRealTimers();
  }
});

it("labels a day bar with the server's day, whatever the viewer's time zone", async () => {
  // Midnight of 3 September on a server two hours east of UTC is still 2 September in New York.
  const days: StatsSummary = { ...data, step: "day", points: [
    { at: "2026-09-01T22:00:00.000Z", day: "2026-09-02", bytes: GB, count: 1 },
    { at: "2026-09-02T22:00:00.000Z", day: "2026-09-03", bytes: GB, count: 1 },
  ], byProvider: [], byAddon: [], bySource: [] };
  fetchMock.mockImplementation((input: RequestInfo | URL) => Promise.resolve(json(
    String(input).includes("/api/stats/activity") ? { items: [], users: [], total: 0 }
      : String(input).includes("/api/stats/streams") ? [] : days)));
  process.env.TZ = "America/New_York";
  try {
    await render();
    const axis = [...hostElement.querySelectorAll(".stats-xaxis span")].map((node) => node.textContent);
    expect(axis).toEqual(["02/09", "03/09"]);
  } finally {
    delete process.env.TZ;
  }
});

const lead = () => hostElement.querySelector(".stats-head p")!;
const periodButton = (label: string) =>
  [...hostElement.querySelectorAll<HTMLButtonElement>(".stats-periods button")].find((button) => button.textContent === label)!;
const statsRequests = () => fetchMock.mock.calls.filter(([input]) => {
  const url = String(input);
  return url.includes("/api/stats") && !url.includes("/api/stats/activity") && !url.includes("/api/stats/streams");
});
const emptyActivity = { items: [], users: [], total: 0 };
const reply = (input: RequestInfo | URL, summary: StatsSummary) => {
  const url = String(input);
  if (url.includes("/api/stats/activity")) return Promise.resolve(json(emptyActivity));
  if (url.includes("/api/stats/streams")) return Promise.resolve(json([]));
  return Promise.resolve(json(summary));
};

it("does not show the empty lead while the first summary is loading, then shows the date", async () => {
  let release: ((value: Response) => void) | undefined;
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/stats/activity")) return Promise.resolve(json(emptyActivity));
    if (url.includes("/api/stats/streams")) return Promise.resolve(json([]));
    return new Promise<Response>((resolve) => { release = resolve; });
  });
  await act(async () => { root.render(<StatsPanel onError={vi.fn()}/>); });
  await act(async () => { await Promise.resolve(); });
  expect(lead().textContent).not.toContain(en["stats.leadEmpty"]);
  expect(hostElement.textContent).not.toContain(en["stats.leadEmpty"]);

  const since = "2026-01-15T00:00:00.000Z";
  await act(async () => { release!(json({ ...data, since })); });
  expect(lead().textContent).toContain(new Date(since).toLocaleDateString(localeTag()));
  expect(hostElement.textContent).not.toContain(en["stats.leadEmpty"]);
});

it("shows the empty lead when a summary has no since", async () => {
  await render();
  expect(lead().textContent).toContain(en["stats.leadEmpty"]);
});

it("does not show the empty lead when the first request fails", async () => {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/stats/activity")) return Promise.resolve(json(emptyActivity));
    if (url.includes("/api/stats/streams")) return Promise.resolve(json([]));
    return Promise.resolve(json({ error: "fail" }, 500));
  });
  await act(async () => { root.render(<StatsPanel onError={vi.fn()}/>); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  expect(lead().textContent).not.toContain(en["stats.leadEmpty"]);
  expect(hostElement.textContent).toContain(en["stats.loadFailed"]);
});

it("keeps the previous summary stale while another period loads, and reverts on failure", async () => {
  const month: StatsSummary = { ...data, since: "2026-01-01T00:00:00.000Z", sources: [bucket("download", 30 * GB)] };
  const onError = vi.fn();
  let pending: { resolve: (value: Response) => void; reject: (error: Error) => void } | undefined;
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/stats/activity")) return Promise.resolve(json(emptyActivity));
    if (url.includes("/api/stats/streams")) return Promise.resolve(json([]));
    if (url.includes("hours=168") && !url.includes("/activity") && !url.includes("/streams")) {
      return new Promise<Response>((resolve, reject) => { pending = { resolve, reject }; });
    }
    return Promise.resolve(json(month));
  });
  await act(async () => { root.render(<StatsPanel onError={onError}/>); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  expect(periodButton("30 days").getAttribute("aria-pressed")).toBe("true");
  const before = statsRequests().length;

  await act(async () => { periodButton("7 days").click(); });
  const stale = hostElement.querySelector(".stats-stale")!;
  expect(stale).toBeTruthy();
  expect(stale.getAttribute("aria-busy")).toBe("true");
  expect(periodButton("7 days").getAttribute("aria-pressed")).toBe("true");
  expect(hostElement.textContent).toContain("30.0 GB");

  await act(async () => { pending!.resolve(json({ error: "fail" }, 500)); });
  expect(onError).toHaveBeenCalledTimes(1);
  expect(periodButton("30 days").getAttribute("aria-pressed")).toBe("true");
  expect(hostElement.querySelector(".stats-stale")).toBeNull();
  expect(statsRequests()).toHaveLength(before + 1);
});

it("shows the new period once its summary arrives", async () => {
  const month: StatsSummary = { ...data, since: "2026-01-01T00:00:00.000Z", sources: [bucket("download", 30 * GB)] };
  const week: StatsSummary = { ...data, since: "2026-09-01T00:00:00.000Z", sources: [bucket("download", 7 * GB)] };
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("hours=168") && !url.includes("/activity") && !url.includes("/streams")) return reply(input, week);
    return reply(input, month);
  });
  await act(async () => { root.render(<StatsPanel onError={vi.fn()}/>); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });

  await act(async () => { periodButton("7 days").click(); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });

  expect(periodButton("7 days").getAttribute("aria-pressed")).toBe("true");
  expect(hostElement.querySelector(".stats-stale")).toBeNull();
  expect(lead().textContent).toContain(new Date(week.since!).toLocaleDateString(localeTag()));
  expect(hostElement.textContent).toContain("7.0 GB");
  expect(hostElement.textContent).not.toContain("30.0 GB");
});
