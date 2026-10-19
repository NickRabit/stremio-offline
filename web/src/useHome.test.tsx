import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "./api";
import { readHomeCache, writeHomeCache } from "./home-cache";
import { useHome } from "./useHome";
import { homeCatalogRowId, type HomeResponse, type HomeRowId } from "../../server/src/home";
import type { HomeCard } from "../../server/src/home";
import type { HomeRows, HomeRowState } from "./home-state";

const movie = homeCatalogRowId("cinemeta", "movie", "top");
const series = homeCatalogRowId("cinemeta", "series", "top");

let root: Root;
let hook: ReturnType<typeof useHome>;
const Probe = () => { hook = useHome({ active: true, account: "alice", admin: false, playerOpen: false }); return null; };

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
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useHome", () => {
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

  it("loads the built-in rows first and an addon shelf only once it is revealed, in one request per moment", async () => {
    const home = vi.spyOn(api, "home").mockImplementation(async (rows) => answer(rows ?? []));
    await act(async () => { root.render(<Probe/>); });
    expect(home).toHaveBeenCalledTimes(1);
    expect(home.mock.calls[0]![0]!.some((row) => row.startsWith("catalog:"))).toBe(false);

    await act(async () => { hook.reveal(movie); hook.reveal(series); hook.reveal(movie); await vi.runAllTimersAsync(); });
    expect(home).toHaveBeenCalledTimes(2);
    expect(home.mock.calls[1]![0]).toEqual([movie, series]);
    expect(hook.rows[movie]?.status).toBe("ok");
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
