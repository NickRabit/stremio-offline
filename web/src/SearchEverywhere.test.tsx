import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SearchEverywhere } from "./SearchEverywhere";
import { setLocale } from "./i18n";
import type { SearchClusterView, SearchMember, SearchMemberPage, SearchSnapshot } from "./types";
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
  kind: "all",
  setKind: vi.fn(),
  availableLocally: false,
  setAvailableLocally: vi.fn(),
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

const render = async (search: SearchEverywhereController) => {
  await act(async () => {
    root.render(<SearchEverywhere search={search} onOpenMember={vi.fn()} onOpenCanonical={vi.fn()}/>);
  });
};

describe("SearchEverywhere", () => {
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

  it("hides remote-only and catalog-only cards in both lists when Available locally is on", async () => {
    const local = cluster("local", { title: "Local title", hasLocal: true });
    const catalog = cluster("catalog", { title: "Catalog title" });
    const remote = cluster("remote", { title: "Remote title", hasRemote: true });
    const localFile = cluster("local-file", { title: "Local file", hasLocal: true, kind: "file" });
    const remoteFile = cluster("remote-file", { title: "Remote file", hasRemote: true, kind: "file" });
    const search = controller({
      availableLocally: true,
      snapshot: snapshot({ clusters: [local, catalog], unidentified: [localFile, remoteFile, remote] }),
      order: ["local", "catalog"],
      unidentifiedOrder: ["local-file", "remote-file", "remote"],
    });
    await render(search);

    expect(host.textContent).toContain("Local title");
    expect(host.textContent).not.toContain("Catalog title");
    expect(host.querySelector(".search-unidentified summary")?.textContent).toContain("(1)");
    expect(host.textContent).toContain("Local file");
    expect(host.textContent).not.toContain("Remote file");
    expect(host.textContent).not.toContain("Remote title");
  });

  it("labels cards that still belong to the previous query", async () => {
    const item = cluster("old", { title: "Old result" });
    await render(controller({ previousQuery: true, snapshot: snapshot({ clusters: [item] }), order: ["old"] }));

    expect(host.textContent).toContain("Results for the previous search");
    expect(host.querySelector(".search-results")?.classList.contains("previous-query")).toBe(true);
  });

  it("lists every member with episode ranges, conflicts and an optional title page", async () => {
    const item = cluster("show", { title: "A show", primaryMemberKey: "member-show", memberKeys: ["member-show"] });
    const page: SearchMemberPage = {
      clusterKey: "show",
      members: [
        member({ memberKey: "member-show", conflict: true }),
        member({ memberKey: "member-second", sourceLabel: "Second source", sourceClass: "local", locator: { kind: "local", key: "lib/show.mkv", libraryId: "lib", itemKind: "file" } }),
      ],
      truncated: false,
      canonical: { type: "series", id: "tt-show", name: "A show" },
    };
    const members = vi.fn(async () => page);
    await render(controller({
      snapshot: snapshot({ clusters: [item] }),
      order: ["show"],
      members,
    }));

    const card = host.querySelector<HTMLButtonElement>(".search-card")!;
    await act(async () => {
      card.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Where to open A show");
    expect(document.body.textContent).toContain("S1E2–E3");
    expect(document.body.textContent).toContain("Conflicting ids");
    expect([...document.body.querySelectorAll("button")].some((button) => button.textContent === "Open title page")).toBe(true);

    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>(".identify-head button")][0]!.click();
    });
    const withoutCanonical = vi.fn(async () => ({ ...page, canonical: undefined }));
    await render(controller({
      snapshot: snapshot({ clusters: [item] }),
      order: ["show"],
      members: withoutCanonical,
    }));
    const nextCard = host.querySelector<HTMLButtonElement>(".search-card")!;
    await act(async () => {
      nextCard.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect([...document.body.querySelectorAll("button")].some((button) => button.textContent === "Open title page")).toBe(false);
  });
});
