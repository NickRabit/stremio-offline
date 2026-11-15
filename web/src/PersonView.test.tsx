import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ApiError, api } from "./api";
import { setLocale } from "./i18n";
import { PersonView } from "./PersonView";
import type { PersonFilmography, PersonTitle } from "./types";

class RecordingIntersectionObserver {
  static instances: RecordingIntersectionObserver[] = [];

  readonly root: Element | Document | null;
  readonly elements = new Set<Element>();

  constructor(readonly callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.root = options?.root ?? null;
    RecordingIntersectionObserver.instances.push(this);
  }

  observe(element: Element) { this.elements.add(element); }
  unobserve(element: Element) { this.elements.delete(element); }
  disconnect() { this.elements.clear(); }
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

const title = (over: Partial<PersonTitle> & Pick<PersonTitle, "id" | "name">): PersonTitle => ({
  type: "movie",
  tmdbId: 1,
  year: "1994",
  ...over,
});

const filmography = (over: Partial<PersonFilmography> = {}): PersonFilmography => ({
  id: 138,
  name: "Quentin Tarantino",
  photo: "/quentin.jpg",
  knownFor: "crew",
  total: 2,
  sections: [
    {
      key: "crew",
      titles: [
        title({ id: "tt0110912", name: "Pulp Fiction", year: "1994", jobs: ["director", "writer"], character: "Jimmie", inLibrary: true, poster: "/pulp.jpg", tmdbId: 680 }),
      ],
    },
    {
      key: "acting",
      titles: [
        title({ type: "series", id: "tmdb:1396", name: "Breaking Bad", year: "2008", character: "Mr. Brown", tmdbId: 1396 }),
      ],
    },
  ],
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
  RecordingIntersectionObserver.instances = [];
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((done) => setTimeout(done, 0));
  });
};

const setInput = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const mount = async (over: Partial<Parameters<typeof PersonView>[0]> = {}, answer: PersonFilmography | Promise<PersonFilmography> = filmography()) => {
  const person = vi.spyOn(api, "person").mockImplementation(() => Promise.resolve(answer) as Promise<PersonFilmography>);
  const onBack = vi.fn();
  const onUnavailable = vi.fn();
  const onOpenTitle = vi.fn();
  const onNotify = vi.fn();
  const onSearchText = vi.fn();
  const onToggleShape = vi.fn();
  await act(async () => {
    root.render(<PersonView person={{ id: 138, name: "Card Name" }} language="en" shape="poster"
      onBack={onBack} onUnavailable={onUnavailable} onOpenTitle={onOpenTitle} onNotify={onNotify}
      onSearchText={onSearchText} onToggleShape={onToggleShape} {...over}/>);
  });
  await flush();
  return { person, onBack, onUnavailable, onOpenTitle, onNotify, onSearchText, onToggleShape };
};

const section = (key: string) => host.querySelector(`section[data-section='${key}']`);
const tile = (name: string) => [...host.querySelectorAll<HTMLButtonElement>(".browse-item")].find((button) => button.textContent?.includes(name));

describe("PersonView", () => {
  it("renders the search heading, the person's name in the form, and the card line with the plural count", async () => {
    await mount();
    const region = host.querySelector(".person-view")!;
    expect(region.getAttribute("aria-label")).toBe("Filmography of Quentin Tarantino");
    expect(region.querySelector(".heading small")!.textContent).toBe("Search");
    expect(region.querySelector(".heading h2")!.textContent).toBe("Search everywhere");
    const form = region.querySelector("form.search-everywhere-form")!;
    expect(form.getAttribute("role")).toBe("search");
    expect(form.querySelector("input")!.value).toBe("Card Name");
    expect(form.querySelector("button.primary")!.textContent).toContain("Search");
    const card = region.querySelector(".person-card")!;
    expect(card.querySelector("h2")!.textContent).toBe("Quentin Tarantino");
    expect(card.querySelector("img")!.getAttribute("src")).toBe("/quentin.jpg");
    expect(card.querySelector("p")!.textContent).toBe("Directing and writing · 2 titles");
    expect(card.querySelector(".person-text-search")!.textContent?.trim()).toBe("Search for “Quentin Tarantino” as text");
  });

  it("shows the clicked name and a skeleton portrait with placeholder tiles while loading", async () => {
    await mount({}, new Promise(() => undefined) as Promise<PersonFilmography>);
    const card = host.querySelector(".person-card")!;
    expect(card.querySelector("h2")!.textContent).toBe("Card Name");
    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector("span")).not.toBeNull();
    expect(card.querySelector("p")).toBeNull();
    expect(host.querySelectorAll(".search-results .browse-art")).toHaveLength(12);
    expect(host.querySelector("section[data-section]")).toBeNull();
  });

  it("renders both sections in the server's order with counts, captions and the library mark", async () => {
    await mount();
    const sections = [...host.querySelectorAll("section[data-section]")];
    expect(sections.map((item) => item.getAttribute("data-section"))).toEqual(["crew", "acting"]);
    expect(sections[0]!.querySelector("h3")!.textContent).toBe("Directing and writing 1");
    expect(sections[1]!.querySelector("h3")!.textContent).toBe("Acting 1");
    const crewTile = tile("Pulp Fiction")!;
    expect(crewTile.querySelector("strong")!.textContent).toBe("Pulp Fiction");
    expect(crewTile.querySelector("small")!.textContent).toBe("1994 · Film · Director · Writer · Jimmie");
    expect(crewTile.querySelector(".fav-mark")!.getAttribute("aria-label")).toBe("Local");
    expect(crewTile.querySelector(".fav-mark svg")).not.toBeNull();
    const actingTile = tile("Breaking Bad")!;
    expect(actingTile.querySelector("small")!.textContent).toBe("2008 · Series · Mr. Brown");
    expect(actingTile.querySelector(".fav-mark")).toBeNull();
  });

  it("hides series when the movies filter is chosen", async () => {
    await mount();
    const movies = [...host.querySelectorAll<HTMLButtonElement>(".search-filters button")].find((button) => button.textContent === "Movies")!;
    await act(async () => { movies.click(); });
    expect(tile("Pulp Fiction")).toBeTruthy();
    expect(tile("Breaking Bad")).toBeUndefined();
    expect(section("acting")).toBeNull();
    expect(section("crew")!.querySelector("h3")!.textContent).toBe("Directing and writing 1");
  });

  it("draws the wide picture in the wide shape and falls back when a title has none", async () => {
    await mount({ shape: "wide" }, filmography({
      sections: [{
        key: "acting",
        titles: [
          title({ id: "tt1", name: "Wide One", background: "/wide.jpg", poster: "/poster.jpg", character: "Actor" }),
          title({ id: "tt2", name: "Poster Only", poster: "/only-poster.jpg", character: "Actor" }),
          title({ id: "tt3", name: "Bare", year: undefined, character: undefined }),
        ],
      }],
    }));
    const grid = host.querySelector(".tile-shape-wide")!;
    expect(grid.className).toContain("search-results");
    const wide = tile("Wide One")!;
    expect(wide.querySelector("img")!.getAttribute("src")).toBe("/wide.jpg");
    const posterOnly = tile("Poster Only")!;
    expect([...posterOnly.querySelectorAll("img")].map((image) => image.getAttribute("src"))).toEqual(["/only-poster.jpg", "/only-poster.jpg"]);
    const bare = tile("Bare")!;
    expect(bare.querySelector("img")).toBeNull();
    expect(bare.querySelector("svg")).not.toBeNull();
  });

  it("opens a tt tile immediately and resolves a tmdb tile before opening", async () => {
    const { onOpenTitle } = await mount();
    const personTitle = vi.spyOn(api, "personTitle");
    let resolveTitle!: (value: { id: string; imdb?: "none" }) => void;
    personTitle.mockReturnValue(new Promise((resolve) => { resolveTitle = resolve; }));

    await act(async () => { tile("Pulp Fiction")!.click(); });
    expect(onOpenTitle).toHaveBeenCalledWith({ type: "movie", id: "tt0110912", name: "Pulp Fiction", poster: "/pulp.jpg" });
    expect(personTitle).not.toHaveBeenCalled();
    onOpenTitle.mockClear();

    const bad = tile("Breaking Bad")!;
    await act(async () => { bad.click(); });
    expect(personTitle).toHaveBeenCalledWith("series", 1396, expect.any(AbortSignal));
    expect(bad.disabled).toBe(true);
    expect(bad.getAttribute("aria-busy")).toBe("true");
    expect(bad.querySelector("small")!.textContent).toBe("Opening…");
    expect(onOpenTitle).not.toHaveBeenCalled();

    await act(async () => { resolveTitle({ id: "tt0903747" }); await flush(); });
    expect(onOpenTitle).toHaveBeenCalledWith({ type: "series", id: "tt0903747", name: "Breaking Bad" });
  });

  it("opens a tmdb title with no IMDb id using the tmdb id and the noImdb notice", async () => {
    const { onOpenTitle } = await mount();
    vi.spyOn(api, "personTitle").mockResolvedValue({ id: "tmdb:1396", imdb: "none" });
    await act(async () => { tile("Breaking Bad")!.click(); });
    await flush();
    expect(onOpenTitle).toHaveBeenCalledWith({ type: "series", id: "tmdb:1396", name: "Breaking Bad" }, "noImdb");
  });

  it("leaves a tmdb tile enabled and does not open it when the lookup fails", async () => {
    const { onOpenTitle, onNotify } = await mount();
    vi.spyOn(api, "personTitle").mockRejectedValue(new ApiError("The filmography could not be loaded.", 502, undefined, "err.personLookupFailed"));
    const bad = tile("Breaking Bad")!;
    await act(async () => { bad.click(); });
    await flush();
    expect(onOpenTitle).not.toHaveBeenCalled();
    expect(onNotify).toHaveBeenCalledWith("The filmography could not be loaded. Try again later.");
    expect(bad.disabled).toBe(false);
    expect(bad.getAttribute("aria-busy")).toBeNull();
  });

  it("calls onUnavailable when the person is unknown", async () => {
    vi.spyOn(api, "person").mockRejectedValue(new ApiError("Nothing is known about this person.", 404, undefined, "err.personUnavailable"));
    const onUnavailable = vi.fn();
    await act(async () => {
      root.render(<PersonView person={{ id: 1, name: "Unknown" }} language="en" shape="poster"
        onBack={vi.fn()} onUnavailable={onUnavailable} onOpenTitle={vi.fn()} onNotify={vi.fn()}
        onSearchText={vi.fn()} onToggleShape={vi.fn()}/>);
    });
    await flush();
    expect(onUnavailable).toHaveBeenCalledWith("Unknown");
    expect(host.textContent).not.toContain("Try again");
  });

  it("shows another failure with Try again, which fetches again", async () => {
    const person = vi.spyOn(api, "person")
      .mockRejectedValueOnce(new ApiError("The filmography could not be loaded.", 502, undefined, "err.personLookupFailed"))
      .mockResolvedValueOnce(filmography());
    await act(async () => {
      root.render(<PersonView person={{ id: 138, name: "Card Name" }} language="en" shape="poster"
        onBack={vi.fn()} onUnavailable={vi.fn()} onOpenTitle={vi.fn()} onNotify={vi.fn()}
        onSearchText={vi.fn()} onToggleShape={vi.fn()}/>);
    });
    await flush();
    const alert = host.querySelector("p.search-error")!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("The filmography could not be loaded. Try again later.");
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Try again")!;
    await act(async () => { retry.click(); });
    await flush();
    expect(person).toHaveBeenCalledTimes(2);
    expect(host.querySelector(".person-card h2")!.textContent).toBe("Quentin Tarantino");
  });

  it("shows the empty copy when the answer has no sections", async () => {
    await mount({}, filmography({ sections: [] }));
    expect(host.querySelector("p.search-empty")!.textContent).toBe("TMDB lists no films or series for this person.");
    expect(host.querySelector("section[data-section]")).toBeNull();
  });

  it("searches the card name and a submitted query", async () => {
    const { onSearchText } = await mount();
    await act(async () => { host.querySelector<HTMLButtonElement>(".person-card .person-text-search")!.click(); });
    expect(onSearchText).toHaveBeenCalledWith("Quentin Tarantino");
    const input = host.querySelector<HTMLInputElement>(".search-everywhere-form input")!;
    await act(async () => { setInput(input, "   "); input.form!.requestSubmit(); });
    expect(onSearchText).toHaveBeenCalledTimes(1);
    await act(async () => { setInput(input, "  Heat  "); input.form!.requestSubmit(); });
    expect(onSearchText).toHaveBeenCalledWith("Heat");
  });

  it("names the title the person was opened from on the back link", async () => {
    const { onBack } = await mount({ fromTitle: "Heat" });
    const back = host.querySelector<HTMLButtonElement>(".search-return")!;
    expect(back.textContent).toContain("Back to Heat");
    await act(async () => { back.click(); });
    expect(onBack).toHaveBeenCalled();
  });

  it("shows backLabel on the back link when given", async () => {
    const { onBack } = await mount({ backLabel: "Back to search" });
    const back = host.querySelector<HTMLButtonElement>(".search-return")!;
    expect(back.textContent).toContain("Back to search");
    expect(back.textContent).not.toContain("Back to Heat");
    await act(async () => { back.click(); });
    expect(onBack).toHaveBeenCalled();
  });

  it("renders 40 tiles of a long section until the sentinel intersects", async () => {
    vi.stubGlobal("IntersectionObserver", RecordingIntersectionObserver);
    const titles = Array.from({ length: 120 }, (_, index) => title({
      id: `tt${index}`, name: `Film ${index}`, tmdbId: index + 1, year: "2000", character: "Actor",
    }));
    await mount({}, filmography({ sections: [{ key: "acting", titles }] }));
    expect(host.querySelectorAll("section[data-section='acting'] .browse-item")).toHaveLength(40);
    const sentinel = host.querySelector(".person-sentinel")!;
    const observer = RecordingIntersectionObserver.instances.find((instance) => instance.elements.has(sentinel));
    expect(observer).toBeTruthy();
    await act(async () => {
      observer!.callback([{ isIntersecting: true, target: sentinel } as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
    });
    expect(host.querySelectorAll("section[data-section='acting'] .browse-item")).toHaveLength(120);
  });
});
