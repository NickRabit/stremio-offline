import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "./api";
import { readHomeCache, writeHomeCache } from "./home-cache";
import { useHome } from "./useHome";
import { SCROLLING_MS } from "./home-omit";
import { homeCatalogRowId, type HomeResponse, type HomeRowId } from "../../server/src/home";
import type { HomeCard, HomeOrderEntry } from "../../server/src/home";
import type { HomeRows, HomeRowState } from "./home-state";

const movie = homeCatalogRowId("cinemeta", "movie", "top");
const series = homeCatalogRowId("cinemeta", "series", "top");

let root: Root;
let hook: ReturnType<typeof useHome>;
let account: string | null;
let renders: Array<{ account: string | null; rows: HomeRows; order: HomeOrderEntry[] }>;
const Probe = () => {
  hook = useHome({ active: true, account, admin: false, playerOpen: false });
  renders.push({ account, rows: hook.rows, order: hook.order });
  return null;
};

const answer = (rows: readonly HomeRowId[], partial: ReadonlySet<HomeRowId> = new Set(), items: Partial<Record<HomeRowId, HomeCard[]>> = {}): HomeResponse => ({
  generatedAt: "", order: [], rows: Object.fromEntries(rows.map((row) => [row, { status: "ok", items: items[row] ?? [], hasMore: false, ...(partial.has(row) ? { partial: true } : {}) }])),
});
const card: HomeCard = {
  kind: "resume-file", key: "file:a", title: "A", path: "Films/A.mkv",
  progress: { position: 1, duration: 4 }, updatedAt: "2026-01-01T00:00:00.000Z", forgetKeys: ["file:a"],
};
const ok = (items: HomeCard[]): HomeRowState => ({ status: "ok", items, hasMore: false, partial: false, request: 0 });
const cachedRows = (): HomeRows => ({
  resume: ok([card]),
  [movie]: ok([card]),
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.useFakeTimers();
  account = "alice";
  renders = [];
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useHome", () => {
  it("draws a cached Home on its first render", async () => {
    const cachedOrder = [{ id: "resume" as const }, { id: movie }];
    writeHomeCache("alice", cachedOrder, cachedRows());
    vi.spyOn(api, "home").mockImplementation(() => new Promise(() => {}));

    await act(async () => { root.render(<Probe/>); });

    expect(renders[0]?.rows.resume?.items).toEqual([card]);
    expect(renders[0]?.order).toEqual(cachedOrder);
  });

  it("draws a cached Home on the first render after the account becomes known", async () => {
    const cachedOrder = [{ id: "resume" as const }, { id: movie }];
    writeHomeCache("alice", cachedOrder, cachedRows());
    vi.spyOn(api, "home").mockImplementation(() => new Promise(() => {}));
    account = null;
    await act(async () => { root.render(<Probe/>); });

    account = "alice";
    await act(async () => { root.render(<Probe/>); });

    const firstAlice = renders.find((render) => render.account === "alice");
    expect(firstAlice?.rows.resume?.items).toEqual([card]);
    expect(firstAlice?.order).toEqual(cachedOrder);
  });

  it("draws the cached rows and refreshes their catalogue shelves", async () => {
    const cachedOrder = [{ id: "resume" as const }, { id: movie }];
    writeHomeCache("alice", cachedOrder, cachedRows());
    const home = vi.spyOn(api, "home").mockImplementation(() => new Promise(() => {}));

    await act(async () => { root.render(<Probe/>); });

    expect(hook.rows.resume?.items).toHaveLength(1);
    expect(hook.order).toEqual(cachedOrder);
    expect(home.mock.calls.some(([rows]) => rows?.includes(movie))).toBe(true);
  });

  it("stores the first answered Home after the debounce", async () => {
    vi.spyOn(api, "home").mockImplementation(async (rows) => answer(rows ?? [], new Set(), { resume: [card] }));
    await act(async () => { root.render(<Probe/>); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(readHomeCache("alice")).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(readHomeCache("alice")?.rows.resume?.items).toEqual([card]);
  });

  it("waits for scrolling to stop before storing the answered Home", async () => {
    vi.spyOn(api, "home").mockImplementation(async (rows) => answer(rows ?? [], new Set(), { resume: [card] }));
    await act(async () => { root.render(<Probe/>); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    for (let elapsed = 0; elapsed < 2000; elapsed += 200) {
      document.dispatchEvent(new Event("scroll"));
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    }
    expect(readHomeCache("alice")).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(SCROLLING_MS + 500); });
    expect(readHomeCache("alice")?.rows.resume?.items).toEqual([card]);
  });

  it("loads the built-in rows first and an addon shelf only once it is revealed, in one request per moment", async () => {
    const home = vi.spyOn(api, "home").mockImplementation(async (rows) => answer(rows ?? []));
    await act(async () => { root.render(<Probe/>); });
    expect(home).toHaveBeenCalledTimes(2);
    expect(home.mock.calls[0]![0]).toEqual(["resume"]);
    expect(home.mock.calls[1]![0]!.some((row) => row.startsWith("catalog:") || row === "resume")).toBe(false);

    await act(async () => { hook.reveal(movie); hook.reveal(series); hook.reveal(movie); await vi.runAllTimersAsync(); });
    expect(home).toHaveBeenCalledTimes(3);
    expect(home.mock.calls[2]![0]).toEqual([movie, series]);
    expect(hook.rows[movie]?.status).toBe("ok");
  });

  it("waits for an account and splits its first Home load around resume", async () => {
    account = null;
    const home = vi.spyOn(api, "home").mockImplementation(() => new Promise(() => {}));
    await act(async () => { root.render(<Probe/>); });
    expect(home).not.toHaveBeenCalled();

    account = "alice";
    await act(async () => { root.render(<Probe/>); });
    expect(home).toHaveBeenCalledTimes(2);
    expect(home.mock.calls[0]![0]).toEqual(["resume"]);
    expect(home.mock.calls[1]![0]).not.toContain("resume");
  });

  it("asks again for a shelf the server could not fill in time, and gives up after a few tries", async () => {
    const home = vi.spyOn(api, "home").mockImplementation(async (rows) => answer(rows ?? [], new Set([movie])));
    await act(async () => { root.render(<Probe/>); });
    await act(async () => { hook.reveal(movie); await vi.advanceTimersByTimeAsync(0); });
    const catalogCalls = () => home.mock.calls.filter(([rows]) => rows?.includes(movie)).length;
    expect(catalogCalls()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(catalogCalls()).toBe(4);
  });
});
