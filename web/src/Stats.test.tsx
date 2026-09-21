import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StatsPanel } from "./Stats";
import type { StatsBucket, StatsBucketHost, StatsSummary } from "./types";
import { setLocale } from "./i18n";

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
    Promise.resolve(json(String(input).includes("/api/stats/streams") ? [] : data)));
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
    "den2-4.download.real-debrid.com · 9.0 GB · 1 item",
    "131-4.download.real-debrid.com · 4.0 GB · 1 item",
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
