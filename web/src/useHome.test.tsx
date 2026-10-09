import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "./api";
import { useHome } from "./useHome";
import { homeCatalogRowId, type HomeResponse, type HomeRowId } from "../../server/src/home";
import type { Addon } from "./types";

const addon = { key: "cinemeta", role: "catalog", enabled: true, globalSearch: true, showOnHome: true,
  manifest: { id: "c", name: "Cinemeta", version: "1", catalogs: [{ type: "movie", id: "top" }, { type: "series", id: "top" }] } } as unknown as Addon;
const movie = homeCatalogRowId("cinemeta", "movie", "top");
const series = homeCatalogRowId("cinemeta", "series", "top");
const addons = [addon];

let root: Root;
let hook: ReturnType<typeof useHome>;
const Probe = () => { hook = useHome({ active: true, account: "alice", admin: false, addons, playerOpen: false }); return null; };

const answer = (rows: readonly HomeRowId[], partial: ReadonlySet<HomeRowId> = new Set()): HomeResponse => ({
  generatedAt: "", rows: Object.fromEntries(rows.map((row) => [row, { status: "ok", items: [], hasMore: false, ...(partial.has(row) ? { partial: true } : {}) }])),
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useHome", () => {
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
