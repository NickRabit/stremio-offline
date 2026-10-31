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
  library: null,
  applyPreset: vi.fn(),
  clearLibrary: vi.fn(),
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
  recent?: string[];
  onRecord?: (query: string) => void;
  onForget?: (query: string) => void;
  onRefreshRecent?: () => void;
} = {}) => {
  await act(async () => {
    root.render(<SearchEverywhere search={search} shape="poster" onToggleShape={vi.fn()}
      searchable={handlers.searchable ?? []} recent={handlers.recent ?? []}
      onRecord={handlers.onRecord ?? vi.fn()} onForget={handlers.onForget ?? vi.fn()} onRefreshRecent={handlers.onRefreshRecent ?? vi.fn()}
      onOpenMember={handlers.onOpenMember ?? vi.fn()} onOpenCanonical={handlers.onOpenCanonical ?? vi.fn()}/>);
  });
};

const sourceButtons = (): HTMLButtonElement[] =>
  [...host.querySelectorAll<HTMLButtonElement>(".search-filters .library-shelf-segments")[0]!.querySelectorAll("button")];

const clickCard = async () => {
  const card = host.querySelector<HTMLButtonElement>("[data-search-card]")!;
  await act(async () => {
    card.click();
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("SearchEverywhere", () => {
  it("draws the library chip after the sources and the library return only when given", async () => {
    const clearLibrary = vi.fn();
    const search = controller({
      sources: ["local", "remote"],
      library: {
        scope: { libraryId: "lib", path: "filmy" },
        source: "local",
        title: "TV test – filmy",
      },
      clearLibrary,
    });
    await render(search);
    const chip = [...host.querySelectorAll<HTMLButtonElement>(".search-filters button")]
      .find((button) => button.getAttribute("aria-label") === "Search all libraries");
    expect(chip?.textContent).toContain("TV test – filmy");
    const filters = host.querySelector(".search-filters")!;
    expect(filters.innerHTML.indexOf("library-shelf-segments")).toBeLessThan(filters.innerHTML.indexOf("Search all libraries"));
    expect(host.querySelector(".search-return")).toBeNull();
    await act(async () => { chip!.click(); });
    expect(clearLibrary).toHaveBeenCalledOnce();
  });

  const openList = async () => {
    const input = host.querySelector<HTMLInputElement>("[data-search-input]")!;
    await act(async () => input.focus());
    return input;
  };
  const rows = () => [...host.querySelectorAll<HTMLLIElement>("#search-all-suggestions [role=option]")];
  const key = async (input: HTMLInputElement, init: KeyboardEventInit) => {
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init })); });
  };

  it("drops the recent searches under the focused field, like the Catalog search", async () => {
    const search = controller({ draft: "", committed: "", snapshot: null });
    const onRecord = vi.fn();
    const onRefreshRecent = vi.fn();
    await render(search, { recent: ["alpha", "beta"], onRecord, onRefreshRecent });
    expect(host.querySelector("#search-all-suggestions")).toBeNull();

    const input = await openList();
    expect(onRefreshRecent).toHaveBeenCalled();
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(rows().map((row) => row.querySelector("span")?.textContent)).toEqual(["alpha", "beta"]);

    await act(async () => rows()[1]!.click());
    expect(search.setDraft).toHaveBeenCalledWith("beta");
    expect(search.submit).toHaveBeenCalled();
    expect(host.querySelector("#search-all-suggestions")).toBeNull();
    expect(onRecord).not.toHaveBeenCalled();
    await render({ ...search, draft: "beta", committed: "beta", snapshot: snapshot() }, { recent: ["alpha", "beta"], onRecord });
    expect(onRecord).toHaveBeenCalledWith("beta");
  });

  it("walks the list with the arrows, runs a row with Enter, drops one with Shift+Delete or its cross and closes on Escape", async () => {
    const search = controller({ draft: "", committed: "", snapshot: null });
    const onForget = vi.fn();
    await render(search, { recent: ["alpha", "beta"], onForget });
    const input = await openList();

    await key(input, { key: "ArrowDown" });
    await key(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe("search-all-suggestion-1");
    expect(rows()[1]!.getAttribute("aria-selected")).toBe("true");
    await key(input, { key: "Delete", shiftKey: true });
    expect(onForget).toHaveBeenCalledWith("beta");

    await act(async () => rows()[0]!.querySelector<HTMLButtonElement>(".forget-recent")!.click());
    expect(onForget).toHaveBeenCalledWith("alpha");
    expect(search.submit).not.toHaveBeenCalled();

    await key(input, { key: "ArrowUp" });
    await key(input, { key: "Enter" });
    expect(search.setDraft).toHaveBeenCalledWith("alpha");
    expect(search.submit).toHaveBeenCalled();

    await openList();
    await act(async () => input.blur());
    await act(async () => input.focus());
    expect(rows()).toHaveLength(2);
    await key(input, { key: "Escape" });
    expect(host.querySelector("#search-all-suggestions")).toBeNull();
  });

  it("narrows the list to recent searches that match what is typed", async () => {
    await render(controller({ draft: "alp", committed: "" }), { recent: ["alpha", "beta", "alpine"] });
    await openList();
    expect(rows().map((row) => row.querySelector("span")?.textContent)).toEqual(["alpha", "alpine"]);
  });

  it("forgets a pending submit once the search is cleared, so a later typed commit is not recorded", async () => {
    const onRecord = vi.fn();
    const search = controller({ draft: "gamma", committed: "", snapshot: null });
    await render(search, { onRecord });
    await act(async () => host.querySelector<HTMLFormElement>("form.search-everywhere-form")!.requestSubmit());
    await render({ ...search, committed: "gamma", snapshot: null }, { onRecord });
    await render({ ...search, draft: "", committed: "", snapshot: null }, { onRecord });
    await render({ ...search, committed: "gamma", snapshot: snapshot() }, { onRecord });
    expect(onRecord).not.toHaveBeenCalled();
  });

  it("does not record the new query when a card of the previous one is opened", async () => {
    const onRecord = vi.fn();
    await render(controller({ committed: "beta", previousQuery: true, order: ["one"], snapshot: snapshot({ clusters: [cluster("one")] }) }), { onRecord });
    await clickCard();
    expect(onRecord).not.toHaveBeenCalled();
  });

  it("lets go of the field after a search on a touch screen, and keeps it on a desktop", async () => {
    const search = controller({ draft: "gamma" });
    await render(search);
    const input = host.querySelector<HTMLInputElement>("[data-search-input]")!;
    const submit = async () => {
      input.focus();
      await act(async () => host.querySelector<HTMLFormElement>("form.search-everywhere-form")!.requestSubmit());
    };
    await submit();
    expect(document.activeElement).toBe(input);

    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)" }));
    try {
      await submit();
      expect(document.activeElement).not.toBe(input);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("remembers a submitted query once it is answered, and one whose result was opened", async () => {
    const onRecord = vi.fn();
    const search = controller({ draft: " gamma ", order: ["one"], snapshot: snapshot({ clusters: [cluster("one")] }) });
    await render(search, { onRecord });
    await act(async () => host.querySelector<HTMLFormElement>("form.search-everywhere-form")!.requestSubmit());
    expect(search.submit).toHaveBeenCalled();
    await render({ ...search, committed: "gamma", previousQuery: true }, { onRecord });
    expect(onRecord).not.toHaveBeenCalled();
    await render({ ...search, committed: "gamma" }, { onRecord });
    expect(onRecord).toHaveBeenCalledWith("gamma");

    onRecord.mockClear();
    await clickCard();
    expect(onRecord).toHaveBeenCalledWith("gamma");
  });

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
    const libraries = sourceButtons().find((button) => button.textContent === "Libraries")!;
    await act(async () => { libraries.click(); });
    expect(setSources).toHaveBeenCalledWith(["local", "remote"]);
  });

  it("offers All, Catalog and Libraries", async () => {
    const setSources = vi.fn();
    await render(controller({ sources: ["remote", "local"], setSources }));

    const buttons = sourceButtons();
    expect(buttons.map((button) => button.textContent)).toEqual(["All", "Catalog", "Libraries"]);
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
    await act(async () => { buttons[2]!.click(); });
    expect(setSources).toHaveBeenCalledWith(["local", "remote"]);
  });

  it("drops the source strip once every source answered, and before any search", async () => {
    const answered = (state: "ready" | "exhausted") => ({ id: state, sourceClass: "catalog" as const, label: state, state, loaded: 1, hasMore: false, continuation: "supported" as const, retryable: false });
    await render(controller({ snapshot: snapshot({ sources: [answered("ready"), answered("exhausted")] }) }));
    expect(host.querySelector(".search-source-strip")).toBeNull();
    expect(host.textContent).not.toContain("All sources answered");

    await render(controller({ committed: "", snapshot: null }));
    expect(host.querySelector(".search-source-strip")).toBeNull();

    await render(controller({ snapshot: snapshot({ sources: [answered("ready"), { ...answered("ready"), id: "bad", state: "failed", retryable: true }] }) }));
    expect(host.querySelector(".search-source-strip")).not.toBeNull();
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

  it("a folder card says how much it holds and the summary names what is left", async () => {
    const folder = cluster("folder", { kind: "folder", title: "GirlsDoPorn", itemCount: 3 });
    const file = cluster("file", { kind: "file", title: "818" });
    await render(controller({
      snapshot: snapshot({ clusters: [folder], unidentified: [file] }),
      order: ["folder"],
      unidentifiedOrder: ["file"],
    }));

    const caption = host.querySelector("[data-search-card] small")?.textContent ?? "";
    expect(caption).toContain("Folder");
    expect(caption).toContain("3");
    expect(host.querySelector(".search-unidentified summary")?.textContent).toBe("More files and folders (1)");
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

  it("opens the series itself from a series card, not one of its episodes", async () => {
    const item = cluster("show", { title: "Jiste pane ministře", kind: "series", hasRemote: true, primaryMemberKey: "series", memberKeys: ["series"] });
    const series = member({ memberKey: "series", kind: "series", sourceClass: "remote", sourceLabel: "Seriály", locator: { kind: "remote", libraryId: "lib", itemId: "s9", itemType: "series" } });
    const episode = (index: number) => member({ memberKey: `e${index}`, kind: "episode", sourceClass: "remote", season: 1, episode: index, locator: { kind: "remote", libraryId: "lib", itemId: `e${index}`, itemType: "episode" } });
    const members = vi.fn(async (): Promise<SearchMemberPage> => ({ clusterKey: "show", members: [series, episode(1), episode(2)], truncated: false }));
    const onOpenMember = vi.fn();
    await render(controller({ snapshot: snapshot({ clusters: [item] }), order: ["show"], members }), { onOpenMember });

    await clickCard();

    expect(onOpenMember).toHaveBeenCalledWith(series, "series", true);
    expect(document.body.textContent).not.toContain("Where to open Jiste pane ministře");
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
