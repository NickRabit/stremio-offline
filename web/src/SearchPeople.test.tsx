import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "./api";
import { SearchEverywhere } from "./SearchEverywhere";
import { setLocale } from "./i18n";
import type { PersonHit, SearchSnapshot } from "./types";
import type { SearchEverywhereController } from "./useSearchEverywhere";

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

const controller = (over: Partial<SearchEverywhereController> = {}): SearchEverywhereController => ({
  draft: "brad",
  setDraft: vi.fn(),
  compositionStart: vi.fn(),
  compositionEnd: vi.fn(),
  committed: "brad",
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
  members: vi.fn(async () => ({ clusterKey: "one", members: [], truncated: false })),
  liveSearch: false,
  error: null,
  focusAnchor: null,
  setFocusAnchor: vi.fn(),
  markInteracted: vi.fn(),
  scrollTop: 0,
  setScrollTop: vi.fn(),
  ...over,
});

const pitt: PersonHit = {
  id: 287,
  name: "Brad Pitt",
  photo: "/brad.jpg",
  knownFor: "acting",
  knownTitles: ["Fight Club", "Ocean's Eleven", "Troy"],
};
const tarantino: PersonHit = {
  id: 138,
  name: "Quentin Tarantino",
  knownFor: "crew",
  knownTitles: ["Pulp Fiction", "Kill Bill"],
};

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
  vi.restoreAllMocks();
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const render = async (search: SearchEverywhereController, onOpenPerson = vi.fn()) => {
  await act(async () => {
    root.render(<SearchEverywhere search={search} shape="poster" onToggleShape={vi.fn()}
      searchable={[]} recent={[]} onRecord={vi.fn()} onForget={vi.fn()} onRefreshRecent={vi.fn()}
      onOpenMember={vi.fn()} onOpenCanonical={vi.fn()} onOpenPerson={onOpenPerson}/>);
  });
  await flush();
  return onOpenPerson;
};

describe("SearchEverywhere people", () => {
  it("requests people once per committed query and skips a one-letter query and the Libraries source", async () => {
    const searchPeople = vi.spyOn(api, "searchPeople").mockResolvedValue({ people: [pitt] });
    await render(controller({ committed: "b" }));
    expect(searchPeople).not.toHaveBeenCalled();
    expect(host.querySelector(".search-people")).toBeNull();

    await render(controller({ committed: "brad" }));
    expect(searchPeople).toHaveBeenCalledTimes(1);
    expect(searchPeople).toHaveBeenCalledWith("brad", "en", expect.any(AbortSignal));

    await render(controller({ committed: "brad", kind: "movie" }));
    expect(searchPeople).toHaveBeenCalledTimes(1);

    await render(controller({ committed: "brad", sources: ["catalog"] }));
    expect(searchPeople).toHaveBeenCalledTimes(1);

    await render(controller({ committed: "pitt" }));
    expect(searchPeople).toHaveBeenCalledTimes(2);
    expect(searchPeople).toHaveBeenLastCalledWith("pitt", "en", expect.any(AbortSignal));

    searchPeople.mockClear();
    await render(controller({ committed: "brad", sources: ["local", "remote"] }));
    expect(searchPeople).not.toHaveBeenCalled();
    expect(host.querySelector(".search-people")).toBeNull();
  });

  it("renders names, the known-for line and portraits", async () => {
    vi.spyOn(api, "searchPeople").mockResolvedValue({ people: [pitt, tarantino] });
    const onOpenPerson = await render(controller({ committed: "brad" }));
    const row = host.querySelector("section.search-people")!;
    expect(row.querySelector("h3")!.textContent).toBe("People");
    const cards = [...row.querySelectorAll<HTMLButtonElement>("button.search-person")];
    expect(cards).toHaveLength(2);
    expect(cards[0]!.querySelector("strong")!.textContent).toBe("Brad Pitt");
    expect(cards[0]!.querySelector("small")!.textContent).toBe("Acting · Fight Club, Ocean's Eleven");
    expect(cards[0]!.querySelector("img")!.getAttribute("src")).toBe("/brad.jpg");
    expect(cards[1]!.querySelector("strong")!.textContent).toBe("Quentin Tarantino");
    expect(cards[1]!.querySelector("small")!.textContent).toBe("Directing and writing · Pulp Fiction, Kill Bill");
    expect(cards[1]!.querySelector(".person-face")!.textContent).toBe("QT");
    await act(async () => { cards[0]!.click(); });
    expect(onOpenPerson).toHaveBeenCalledWith({ id: 287, name: "Brad Pitt" });
  });

  it("renders no row for a failure or an empty answer", async () => {
    vi.spyOn(api, "searchPeople").mockRejectedValueOnce(new Error("lookup failed"));
    await render(controller({ committed: "brad" }));
    expect(host.querySelector(".search-people")).toBeNull();
    expect(host.textContent).not.toContain("People");

    vi.spyOn(api, "searchPeople").mockResolvedValue({ people: [] });
    await render(controller({ committed: "pitt" }));
    expect(host.querySelector(".search-people")).toBeNull();
  });

  it("aborts the previous request when the committed query changes", async () => {
    const signals: AbortSignal[] = [];
    vi.spyOn(api, "searchPeople").mockImplementation((_query, _language, signal) => {
      if (signal) signals.push(signal);
      return new Promise(() => undefined);
    });
    await render(controller({ committed: "brad" }));
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    await render(controller({ committed: "pitt" }));
    expect(signals[0]!.aborted).toBe(true);
    expect(signals).toHaveLength(2);
  });
});
