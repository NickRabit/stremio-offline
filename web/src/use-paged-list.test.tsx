import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { usePagedList, type Page, type PagedList } from "./use-paged-list";

interface Pending {
  filter: string;
  skip: number;
  resolve: (page: Page<string>) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

interface RenderState {
  filter: string;
  items: string[];
  total: number;
  busy: boolean;
  loadingMore: boolean;
  hasMore: boolean;
}

let root: Root;
let host: HTMLDivElement;
let props: { filter: string; active: boolean };
let current: PagedList<string, string>;
let pending: Pending[];
let fetchPage: ReturnType<typeof vi.fn<(filter: string, skip: number) => Promise<Page<string>>>>;
let onError: ReturnType<typeof vi.fn<(error: unknown) => void>>;
let renders: RenderState[];

function Harness() {
  current = usePagedList({
    filter: props.filter,
    active: props.active,
    fetchPage,
    onError,
  });
  renders.push({
    filter: props.filter,
    items: current.items,
    total: current.total,
    busy: current.busy,
    loadingMore: current.loadingMore,
    hasMore: current.hasMore,
  });
  return null;
}

const mount = async () => {
  await act(async () => { root.render(createElement(Harness)); });
};

const setFilter = async (filter: string) => {
  props = { ...props, filter };
  await act(async () => { root.render(createElement(Harness)); });
};

const request = (filter: string, skip: number) => {
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const candidate = pending[index]!;
    if (!candidate.settled && candidate.filter === filter && candidate.skip === skip) return candidate;
  }
  throw new Error(`No pending request for ${filter} at ${skip}`);
};

const answer = async (filter: string, skip: number, page: Page<string>) => {
  const target = request(filter, skip);
  target.settled = true;
  await act(async () => {
    target.resolve(page);
    await Promise.resolve();
  });
};

const reject = async (filter: string, skip: number, error: unknown) => {
  const target = request(filter, skip);
  target.settled = true;
  await act(async () => {
    target.reject(error);
    await Promise.resolve();
  });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  props = { filter: "A", active: true };
  pending = [];
  renders = [];
  fetchPage = vi.fn<(filter: string, skip: number) => Promise<Page<string>>>((filter, skip) => new Promise<Page<string>>((resolve, rejectPage) => {
    pending.push({ filter, skip, resolve, reject: rejectPage, settled: false });
  }));
  onError = vi.fn<(error: unknown) => void>();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("usePagedList", () => {
  it("drops a late first page from the previous filter", async () => {
    await mount();
    await setFilter("B");
    await answer("B", 0, { items: ["b1"], total: 1 });
    await answer("A", 0, { items: ["a1"], total: 9 });

    expect(current.items).toEqual(["b1"]);
    expect(current.total).toBe(1);
    expect(current.busy).toBe(false);
  });

  it("keeps loading until the current filter answers", async () => {
    await mount();
    await setFilter("B");
    await answer("A", 0, { items: ["a1"], total: 1 });

    expect(current.items).toEqual([]);
    expect(current.total).toBe(0);
    expect(current.busy).toBe(true);

    await answer("B", 0, { items: ["b1"], total: 1 });
    expect(current.items).toEqual(["b1"]);
    expect(current.busy).toBe(false);
  });

  it("drops next pages from the previous filter before or after the current first page lands", async () => {
    await mount();
    await answer("A", 0, { items: ["a1"], total: 2 });
    await act(async () => { void current.loadMore(); });
    expect(request("A", 1).skip).toBe(1);

    await setFilter("B");
    await answer("B", 0, { items: ["b1"], total: 3 });
    await answer("A", 1, { items: ["a2"], total: 2 });
    expect(current.items).toEqual(["b1"]);
    expect(current.total).toBe(3);
    expect(current.hasMore).toBe(true);

    await setFilter("A");
    await answer("A", 0, { items: ["a1"], total: 2 });
    await act(async () => { void current.loadMore(); });
    await setFilter("B");
    await answer("A", 1, { items: ["a2"], total: 2 });
    expect(current.items).toEqual([]);
    expect(current.total).toBe(0);
    expect(current.busy).toBe(true);

    await answer("B", 0, { items: ["b2"], total: 4 });
    expect(current.items).toEqual(["b2"]);
    expect(current.total).toBe(4);
    expect(current.hasMore).toBe(true);
  });

  it("keeps the current cards visible while the same filter refreshes", async () => {
    await mount();
    await answer("A", 0, { items: ["a1"], total: 1 });

    await act(async () => { void current.refresh(); });
    expect(current.items).toEqual(["a1"]);
    expect(current.busy).toBe(true);

    await answer("A", 0, { items: ["a2"], total: 1 });
    expect(current.items).toEqual(["a2"]);
    expect(current.busy).toBe(false);
  });

  it("ignores a late failure from a superseded request", async () => {
    await mount();
    await setFilter("B");
    await reject("A", 0, new Error("old filter failed"));

    expect(onError).not.toHaveBeenCalled();
    expect(current.items).toEqual([]);
    expect(current.busy).toBe(true);

    await answer("B", 0, { items: ["b1"], total: 1 });
    expect(current.busy).toBe(false);
  });

  it("does not ask for another page while a first page is busy", async () => {
    await mount();
    await answer("A", 0, { items: ["a1"], total: 2 });
    const callsBeforeRefresh = fetchPage.mock.calls.length;

    await act(async () => { void current.refresh(); });
    await act(async () => { void current.loadMore(); });
    expect(fetchPage).toHaveBeenCalledTimes(callsBeforeRefresh + 1);

    await answer("A", 0, { items: ["a2"], total: 2 });
  });

  it("renders no old cards on the first render with a new filter", async () => {
    await mount();
    await answer("A", 0, { items: ["a1"], total: 1 });
    const beforeSwitch = renders.length;

    await setFilter("B");
    const firstNewFilterRender = renders.slice(beforeSwitch).find((render) => render.filter === "B");
    expect(firstNewFilterRender?.items).toEqual([]);
    expect(firstNewFilterRender?.total).toBe(0);
  });
});
