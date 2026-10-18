import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SearchEverywhere } from "./SearchEverywhere";
import { setLocale } from "./i18n";
import type { SearchClusterView, SearchMember, SearchMemberPage, SearchSnapshot, SearchableCatalog } from "./types";
import type { SearchEverywhereController } from "./useSearchEverywhere";

const cluster = (key: string, over: Partial<SearchClusterView> = {}): SearchClusterView => ({
  key,
  kind: "movie",
  title: key,
  sourceLabels: ["Catalog"],
  hasLocal: false,
  hasRemote: false,
  memberCount: 1,
  primaryMemberKey: `member-${key}`,
  memberKeys: [`member-${key}`],
  rank: 1,
  score: 1,
  ...over,
});

const snapshot = (over: Partial<SearchSnapshot> = {}): SearchSnapshot => ({
  revision: 1,
  state: "complete",
  sources: [],
  clusters: [],
  unidentified: [],
  aliases: [],
  limitReached: false,
  ...over,
});

const member = (over: Partial<SearchMember> = {}): SearchMember => ({
  memberKey: "member-one",
  sourceId: "source-one",
  sourceClass: "catalog",
  sourceLabel: "Catalog",
  kind: "episode",
  title: "Pilot",
  year: 2024,
  season: 1,
  episode: 2,
  episodeEnd: 3,
  locator: { kind: "catalog", addonKey: "cinemeta", type: "series", id: "tt-one" },
  ...over,
});

const controller = (over: Partial<SearchEverywhereController> = {}): SearchEverywhereController => ({
  draft: "alpha",
  setDraft: vi.fn(),
  compositionStart: vi.fn(),
  compositionEnd: vi.fn(),
  committed: "alpha",
  submit: vi.fn(),
  clear: vi.fn(),
  sources: [],
  setSources: vi.fn(),
  scope: null,
  setScope: vi.fn(),
  kind: "all",
  setKind: vi.fn(),
  snapshot: snapshot(),
  previousQuery: false,
  order: [],
  unidentifiedOrder: [],
  loadMore: vi.fn(),
  retry: vi.fn(),
  members: vi.fn(async (): Promise<SearchMemberPage> => ({ clusterKey: "one", members: [], truncated: false })),
  liveSearch: false,
  error: null,
  focusAnchor: null,
  setFocusAnchor: vi.fn(),
  markInteracted: vi.fn(),
  scrollTop: 0,
  setScrollTop: vi.fn(),
  ...over,
});

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.querySelectorAll(".identify-overlay").forEach((element) => element.remove());
  vi.restoreAllMocks();
});

const render = async (search: SearchEverywhereController, handlers: {
  onOpenMember?: (member: SearchMember, anchorKey: string, libraryFirst?: boolean) => void;
  onOpenCanonical?: (canonical: NonNullable<SearchMemberPage["canonical"]>, anchorKey: string, libraryFirst?: boolean) => void;
  searchable?: SearchableCatalog[];
} = {}) => {
  await act(async () => {
    root.render(<SearchEverywhere search={search} shape="poster" onToggleShape={vi.fn()}
      searchable={handlers.searchable ?? []}
      onOpenMember={handlers.onOpenMember ?? vi.fn()} onOpenCanonical={handlers.onOpenCanonical ?? vi.fn()}/>);
  });
};

const clickCard = async () => {
  const card = host.querySelector<HTMLButtonElement>("[data-search-card]")!;
  await act(async () => {
    card.click();
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("SearchEverywhere", () => {
  it("offers the Catalog scope only for the Catalog filter", async () => {
    const searchable: SearchableCatalog[] = [
      { addonKey: "addon-a", addonName: "Addon A", globalSearch: false, type: "movie", id: "films", name: "Films" },
      { addonKey: "addon-a", addonName: "Addon A", globalSearch: false, type: "series", id: "shows", name: "Shows" },
    ];
    const setScope = vi.fn();
    const setSources = vi.fn();
    await render(controller({ sources: ["catalog"], setScope, setSources }), { searchable });

    const select = host.querySelector<HTMLSelectElement>("select[aria-label='Where to search']")!;
    expect(select).not.toBeNull();
    expect([...select.querySelectorAll("option")].map((option) => option.value)).toEqual([
      "",
      "addon:addon-a",
      "catalog:addon-a:movie:films",
      "catalog:addon-a:series:shows",
    ]);
    await act(async () => {
      select.value = "catalog:addon-a:movie:films";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(setScope).toHaveBeenCalledWith({ addonKey: "addon-a", catalogType: "movie", catalogId: "films" });

    await render(controller({ sources: ["local"], setScope, setSources }), { searchable });
    expect(host.querySelector("select[aria-label='Where to search']")).toBeNull();
    const local = [...host.querySelectorAll<HTMLButtonElement>(".search-filters button")]
      .find((button) => button.textContent === "Local")!;
    await act(async () => { local.click(); });
    expect(setSources).toHaveBeenCalledWith(["local"]);
  });

  it("renders source states and offers Retry only for retryable sources", async () => {
    const search = controller({
      snapshot: snapshot({
        sources: [
          { id: "queued", sourceClass: "catalog", label: "Waiting source", state: "queued", loaded: 0, hasMore: false, continuation: "supported", retryable: false },
          { id: "loading", sourceClass: "catalog", label: "Loading source", state: "loading", loaded: 2, hasMore: false, continuation: "supported", retryable: false },
          { id: "indexing", sourceClass: "local", label: "Index source", state: "indexing", loaded: 0, hasMore: false, continuation: "supported", retryable: false },
          { id: "failed", sourceClass: "remote", label: "Failed source", state: "failed", loaded: 0, hasMore: false, continuation: "supported", retryable: true, errorCode: "timeout" },
        ],
      }),
    });
    await render(search);

    expect(host.querySelector("[aria-live='polite']")?.textContent).toContain("Still searching 3 sources");
    const summary = host.querySelector<HTMLElement>(".search-source-strip summary")!;
    await act(async () => { summary.click(); });
    expect(host.textContent).toContain("Waiting");
    expect(host.textContent).toContain("Searching…");
    expect(host.textContent).toContain("Indexing…");
    expect(host.textContent).toContain("Failed");
    expect(host.querySelectorAll(".search-source-state button")).toHaveLength(1);
    expect(host.querySelector(".search-source-state button")?.textContent).toBe("Retry");
  });

  it("labels cards that still belong to the previous query", async () => {
    const item = cluster("old", { title: "Old result" });
    await render(controller({ previousQuery: true, snapshot: snapshot({ clusters: [item] }), order: ["old"] }));

    expect(host.textContent).toContain("Results for the previous search");
    expect(host.querySelector(".search-results")?.classList.contains("previous-query")).toBe(true);
  });

  it("opens the one title page when the title has an id every source shares", async () => {
    const item = cluster("show", { title: "A show", primaryMemberKey: "member-show", memberKeys: ["member-show"] });
    const canonical = { type: "series" as const, id: "tt-show", name: "A show" };
    const members = vi.fn(async (): Promise<SearchMemberPage> => ({
      clusterKey: "show",
      members: [member({ memberKey: "member-show" }), member({ memberKey: "member-local", sourceClass: "local", locator: { kind: "local", key: "lib/show", libraryId: "lib", itemKind: "folder" } })],
      truncated: false,
      canonical,
    }));
    const onOpenCanonical = vi.fn();
    await render(controller({ snapshot: snapshot({ clusters: [item] }), order: ["show"], members }), { onOpenCanonical });

    await clickCard();

    expect(onOpenCanonical).toHaveBeenCalledWith(canonical, "member-show");
    expect(document.body.textContent).not.toContain("Where to open A show");
  });

  it("asks where to open a title without a shared id, with episode ranges and conflicts", async () => {
    const item = cluster("show", { title: "A show", primaryMemberKey: "member-show", memberKeys: ["member-show"] });
    const members = vi.fn(async (): Promise<SearchMemberPage> => ({
      clusterKey: "show",
      members: [
        member({ memberKey: "member-show", conflict: true }),
        member({ memberKey: "member-second", sourceLabel: "Second source", sourceClass: "local", locator: { kind: "local", key: "lib/show.mkv", libraryId: "lib", itemKind: "file" } }),
      ],
      truncated: false,
    }));
    await render(controller({ snapshot: snapshot({ clusters: [item] }), order: ["show"], members }));

    await clickCard();

    expect(document.body.textContent).toContain("Where to open A show");
    expect(document.body.textContent).toContain("S1E2–E3");
    expect(document.body.textContent).toContain("Conflicting ids");
    expect([...document.body.querySelectorAll("button")].some((button) => button.textContent === "Open title page")).toBe(false);
  });

  it("treats several catalogues of one addon as one copy and opens it directly", async () => {
    const item = cluster("film", { title: "A film", primaryMemberKey: "member-a", memberKeys: ["member-a", "member-b"] });
    const locator = { kind: "catalog" as const, addonKey: "addon", type: "movie", id: "addon:film" };
    const first = member({ memberKey: "member-a", sourceLabel: "Addon · Movies", locator: { ...locator, catalogId: "movies" } });
    const members = vi.fn(async (): Promise<SearchMemberPage> => ({
      clusterKey: "film",
      members: [first, member({ memberKey: "member-b", sourceLabel: "Addon · Netflix", locator: { ...locator, catalogId: "netflix" } })],
      truncated: false,
    }));
    const onOpenMember = vi.fn();
    await render(controller({ snapshot: snapshot({ clusters: [item] }), order: ["film"], members }), { onOpenMember });

    await clickCard();

    expect(onOpenMember).toHaveBeenCalledWith(first, "member-a");
    expect(document.body.textContent).not.toContain("Where to open A film");
  });
  it("asks for the next page by itself near the end, never while a source still loads", async () => {
    const source = (state: "ready" | "loading") => ({ id: "s0", sourceClass: "catalog" as const, label: "Catalog", state, loaded: 20, hasMore: state === "ready", continuation: "supported" as const, retryable: false });
    const item = cluster("one", { title: "One" });
    const idle = controller({ snapshot: snapshot({ sources: [source("ready")], clusters: [item] }), order: ["one"], loadMore: vi.fn() });
    await render(idle);
    expect(idle.loadMore).toHaveBeenCalledTimes(1);
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Load more")).toBe(false);

    const busy = controller({ snapshot: snapshot({ sources: [source("loading")], clusters: [item] }), order: ["one"], loadMore: vi.fn() });
    await render(busy);
    await act(async () => { window.dispatchEvent(new Event("scroll")); });
    expect(busy.loadMore).not.toHaveBeenCalled();
  });
});
