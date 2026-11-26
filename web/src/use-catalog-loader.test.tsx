import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "./api";
import { useCatalogLoader, type CatalogLoader } from "./use-catalog-loader";
import type { BrowseCatalog } from "./catalog-picker-model";
import type { Meta } from "./types";

const catalog: BrowseCatalog = { addonKey: "addon", addonName: "Addon", type: "movie", id: "top" };
const films = (start: number, count: number): Meta[] =>
  Array.from({ length: count }, (_, i) => ({ type: "movie", id: `tt${start + i}`, name: `Film ${start + i}` }));

let root: Root;
let hook: CatalogLoader;
let onError: () => void = () => undefined;
const Probe = () => {
  hook = useCatalogLoader({
    view: "catalog", query: "", scopeValue: "", scope: {}, typeFilter: "", effectiveTypeFilter: "", genre: "",
    catalog, resetKey: 0, searchSessionEnabled: false,
    onFirstPageStart: () => undefined, onItems: () => undefined, onRecordSearch: () => undefined,
    onSearchReset: () => undefined, onError: () => onError(), onBusyChange: () => undefined,
  });
  return null;
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
});

it("a scroll that lands between a failed page and its render does not ask for the page again", async () => {
  let failNext = true;
  const catalogSpy = vi.spyOn(api, "catalog").mockImplementation(async (_catalog, _search, skip = 0) => {
    if (skip === 0) return films(0, 80);
    if (failNext) {
      failNext = false;
      throw new Error("Outbound request timed out");
    }
    return films(skip, 1);
  });
  await act(async () => root.render(<Probe/>));
  expect(hook.items).toHaveLength(80);

  // The grid's scroll handler belongs to this render. The scroll it receives right after the page
  // fails (the toolbar folding resizes the grid) can come before React renders the failure.
  const lastRender = hook;
  onError = () => queueMicrotask(() => lastRender.autoLoadPage());
  await act(async () => lastRender.autoLoadPage());
  expect(lastRender.pageFailed).toBe(false);
  expect(hook.pageFailed).toBe(true);
  expect(hook.loadingMore).toBe(false);
  expect(catalogSpy.mock.calls.filter(([, , skip]) => skip === 80)).toHaveLength(1);

  onError = () => undefined;
  await act(async () => hook.loadPage(false));
  expect(hook.pageFailed).toBe(false);
  expect(hook.items.map((item) => item.id)).toContain("tt80");
});
