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
  role: "Director",
  ...over,
});

const filmography = (over: Partial<PersonFilmography> = {}): PersonFilmography => ({
  id: 138,
  name: "Quentin Tarantino",
  photo: "/quentin.jpg",
  sections: [
    {
      key: "crew",
      titles: [
        title({ id: "tt0110912", name: "Pulp Fiction", year: "1994", role: "Director, Writer", inLibrary: true, poster: "/pulp.jpg", tmdbId: 680 }),
      ],
    },
    {
      key: "acting",
      titles: [
        title({ type: "series", id: "tmdb:1396", name: "Breaking Bad", year: "2008", role: "Mr. Brown", tmdbId: 1396 }),
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

const mount = async (over: Partial<Parameters<typeof PersonView>[0]> = {}, answer: PersonFilmography | Promise<PersonFilmography> = filmography()) => {
  const person = vi.spyOn(api, "person").mockImplementation(() => Promise.resolve(answer) as Promise<PersonFilmography>);
  const onBack = vi.fn();
  const onUnavailable = vi.fn();
  const onOpenTitle = vi.fn();
  const onNotify = vi.fn();
  await act(async () => {
    root.render(<PersonView person={{ id: 138, name: "Card Name" }} language="en" shape="poster"
      onBack={onBack} onUnavailable={onUnavailable} onOpenTitle={onOpenTitle} onNotify={onNotify} {...over}/>);
  });
  await flush();
  return { person, onBack, onUnavailable, onOpenTitle, onNotify };
};

describe("PersonView", () => {
  it("renders both sections in the server's order with headings, tiles, labels and the library marker from the answer", async () => {
    await mount();
    const region = host.querySelector(".person-view")!;
    expect(region.getAttribute("aria-label")).toBe("Filmography of Quentin Tarantino");
    expect(region.querySelector("h2")!.textContent).toBe("Quentin Tarantino");
    expect(region.querySelector(".person-portrait img")!.getAttribute("src")).toBe("/quentin.jpg");
    expect(region.textContent).not.toContain("Card Name");
    const sections = [...host.querySelectorAll(".person-section")];
    expect(sections.map((section) => section.getAttribute("data-section"))).toEqual(["crew", "acting"]);
    expect(sections[0]!.querySelector("h3")!.textContent).toBe("Directing and writing");
    expect(sections[1]!.querySelector("h3")!.textContent).toBe("Acting");
    const crewTile = sections[0]!.querySelector(".browse-item")!;
    expect(crewTile.querySelector("strong")!.textContent).toBe("Pulp Fiction");
    expect(crewTile.querySelector("small")!.textContent).toBe("1994 · Film · Director, Writer");
    expect(crewTile.querySelector(".in-library")!.textContent).toBe("In your library");
    const actingTile = sections[1]!.querySelector(".browse-item")!;
    expect(actingTile.querySelector("strong")!.textContent).toBe("Breaking Bad");
    expect(actingTile.querySelector("small")!.textContent).toBe("2008 · Series · Mr. Brown");
    expect(actingTile.querySelector(".in-library")).toBeNull();
  });

  it("opens a tt tile immediately and resolves a tmdb tile before opening", async () => {
    const { onOpenTitle } = await mount();
    const personTitle = vi.spyOn(api, "personTitle");
    let resolveTitle!: (value: { id: string; imdb?: "none" }) => void;
    personTitle.mockReturnValue(new Promise((resolve) => { resolveTitle = resolve; }));

    const pulp = [...host.querySelectorAll<HTMLButtonElement>(".browse-item")].find((button) => button.textContent?.includes("Pulp Fiction"))!;
    await act(async () => { pulp.click(); });
    expect(onOpenTitle).toHaveBeenCalledWith({ type: "movie", id: "tt0110912", name: "Pulp Fiction", poster: "/pulp.jpg" });
    expect(personTitle).not.toHaveBeenCalled();
    onOpenTitle.mockClear();

    const bad = [...host.querySelectorAll<HTMLButtonElement>(".browse-item")].find((button) => button.textContent?.includes("Breaking Bad"))!;
    await act(async () => { bad.click(); });
    expect(personTitle).toHaveBeenCalledWith("series", 1396, expect.any(AbortSignal));
    expect(bad.disabled).toBe(true);
    expect(bad.getAttribute("aria-busy")).toBe("true");
    expect(bad.textContent).toContain("Opening…");
    expect(onOpenTitle).not.toHaveBeenCalled();

    await act(async () => { resolveTitle({ id: "tt0903747" }); await flush(); });
    expect(onOpenTitle).toHaveBeenCalledWith({ type: "series", id: "tt0903747", name: "Breaking Bad" });
  });

  it("opens a tmdb title with no IMDb id using the tmdb id and the noImdb notice", async () => {
    const { onOpenTitle } = await mount();
    vi.spyOn(api, "personTitle").mockResolvedValue({ id: "tmdb:1396", imdb: "none" });
    const bad = [...host.querySelectorAll<HTMLButtonElement>(".browse-item")].find((button) => button.textContent?.includes("Breaking Bad"))!;
    await act(async () => { bad.click(); });
    await flush();
    expect(onOpenTitle).toHaveBeenCalledWith({ type: "series", id: "tmdb:1396", name: "Breaking Bad" }, "noImdb");
  });

  it("leaves a tmdb tile enabled and does not open it when the lookup fails", async () => {
    const { onOpenTitle, onNotify } = await mount();
    vi.spyOn(api, "personTitle").mockRejectedValue(new ApiError("The filmography could not be loaded.", 502, undefined, "err.personLookupFailed"));
    const bad = [...host.querySelectorAll<HTMLButtonElement>(".browse-item")].find((button) => button.textContent?.includes("Breaking Bad"))!;
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
        onBack={vi.fn()} onUnavailable={onUnavailable} onOpenTitle={vi.fn()} onNotify={vi.fn()}/>);
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
        onBack={vi.fn()} onUnavailable={vi.fn()} onOpenTitle={vi.fn()} onNotify={vi.fn()}/>);
    });
    await flush();
    expect(host.querySelector("[role='alert']")!.textContent).toContain("The filmography could not be loaded. Try again later.");
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Try again")!;
    await act(async () => { retry.click(); });
    await flush();
    expect(person).toHaveBeenCalledTimes(2);
    expect(host.querySelector("h2")!.textContent).toBe("Quentin Tarantino");
  });

  it("shows the empty copy when the answer has no sections", async () => {
    await mount({}, filmography({ sections: [] }));
    expect(host.textContent).toContain("TMDB lists no films or series for this person.");
    expect(host.querySelector(".person-section")).toBeNull();
  });

  it("renders 40 tiles of a long section until the sentinel intersects", async () => {
    vi.stubGlobal("IntersectionObserver", RecordingIntersectionObserver);
    const titles = Array.from({ length: 120 }, (_, index) => title({
      id: `tt${index}`, name: `Film ${index}`, tmdbId: index + 1, year: "2000", role: "Actor",
    }));
    await mount({}, filmography({ sections: [{ key: "acting", titles }] }));
    expect(host.querySelectorAll(".person-section[data-section='acting'] .browse-item")).toHaveLength(40);
    const sentinel = host.querySelector(".person-sentinel")!;
    const observer = RecordingIntersectionObserver.instances.find((instance) => instance.elements.has(sentinel));
    expect(observer).toBeTruthy();
    await act(async () => {
      observer!.callback([{ isIntersecting: true, target: sentinel } as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
    });
    expect(host.querySelectorAll(".person-section[data-section='acting'] .browse-item")).toHaveLength(120);
  });
});
