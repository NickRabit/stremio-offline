import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setLocale } from "./i18n";
import { TitleExtraFacts, TitleExtrasActions, TitleExtrasRows, type TitleExtrasActionsValue } from "./TitleExtras";
import type { TitleExtras } from "./types";

const cast = {
  people: [
    { name: "Show Runner", role: "creator" as const },
    { name: "Rob Reiner", role: "director" as const },
    { name: "Nora Ephron", role: "writer" as const },
    { name: "Aaron Sorkin", role: "writer" as const },
    { name: "Jane Austen", role: "novel" as const },
    { name: "Ada Lovelace", role: "cast" as const, character: "Ada", photo: "/ada.jpg" },
    { name: "Grace Hopper", role: "cast" as const, character: "Grace" },
    { name: "Cher", role: "cast" as const, photo: "   " },
  ],
  related: [
    { type: "movie" as const, id: "tt2", name: "When Harry Met Sally", year: "1989", poster: "/sally.jpg", inLibrary: true },
    { type: "series" as const, id: "tt3", name: "Plain Show", year: "2001" },
  ],
  ageRating: "PG-13",
  originalTitle: "Když Harry potkal Sally",
  originalLanguage: "cs",
  nextEpisode: { season: 6, episode: 3, name: "The one", released: "2099-03-04" },
  source: "tmdb" as const,
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
});

const mount = (node: ReactNode, actions?: TitleExtrasActionsValue) => {
  const value = actions ?? { searchPerson: vi.fn(), openTitle: vi.fn() };
  act(() => {
    root.render(<TitleExtrasActions.Provider value={value}>{node}</TitleExtrasActions.Provider>);
  });
  return value;
};

describe("TitleExtrasRows", () => {
  it("renders the crew line in role order and the cast with photos or initials", () => {
    mount(<TitleExtrasRows extras={cast} loading={false}/>);
    expect(host.querySelector(".extras-crew")!.textContent).toBe(
      "Created by Show Runner · Director Rob Reiner · Writer Nora Ephron, Aaron Sorkin · Novel Jane Austen",
    );
    const portraits = [...host.querySelectorAll(".person")];
    expect(portraits.map((button) => button.querySelector("strong")!.textContent)).toEqual(["Ada Lovelace", "Grace Hopper", "Cher"]);
    expect(portraits[0]!.querySelector("img")!.getAttribute("src")).toBe("/ada.jpg");
    expect(portraits[0]!.querySelector("small")!.textContent).toBe("Ada");
    expect(portraits[1]!.querySelector("img")).toBeNull();
    expect(portraits[1]!.querySelector(".person-face")!.textContent).toBe("GH");
    expect(portraits[2]!.querySelector(".person-face")!.textContent).toBe("C");
    expect(portraits[0]!.getAttribute("title")).toBe("Search for Ada Lovelace");
    expect(host.querySelector(".extras-crew button")!.getAttribute("title")).toBe("Search for Show Runner");
  });

  it("falls back to initials when a portrait fails to load", () => {
    mount(<TitleExtrasRows extras={cast} loading={false}/>);
    const image = host.querySelector<HTMLImageElement>(".person img")!;
    act(() => { image.dispatchEvent(new Event("error")); });
    const face = host.querySelector(".person")!.querySelector(".person-face")!;
    expect(face.querySelector("img")).toBeNull();
    expect(face.textContent).toBe("AL");
  });

  it("renders similar titles, the library mark and a plain tile when there is no poster", () => {
    mount(<TitleExtrasRows extras={cast} loading={false}/>);
    const tiles = [...host.querySelectorAll(".related")];
    expect(tiles[0]!.querySelector("img")!.getAttribute("src")).toBe("/sally.jpg");
    expect(tiles[0]!.querySelector("strong")!.textContent).toBe("When Harry Met Sally");
    expect(tiles[0]!.querySelector("small")!.textContent).toBe("1989");
    expect(tiles[0]!.querySelector(".in-library")!.textContent).toBe("In a library");
    expect(tiles[1]!.querySelector("img")).toBeNull();
    expect(tiles[1]!.querySelector(".related-art")!.textContent).toBe("Plain Show");
    expect(tiles[1]!.querySelector(".in-library")).toBeNull();
  });

  it("searches a person from the portrait and the crew line, and opens a related title", () => {
    const actions = mount(<TitleExtrasRows extras={cast} loading={false}/>);
    const portrait = [...host.querySelectorAll<HTMLButtonElement>(".person")].find((button) => button.textContent?.includes("Grace Hopper"))!;
    act(() => { portrait.click(); });
    expect(actions.searchPerson).toHaveBeenCalledWith("Grace Hopper");
    const writer = [...host.querySelectorAll<HTMLButtonElement>(".extras-crew button")].find((button) => button.textContent === "Aaron Sorkin")!;
    act(() => { writer.click(); });
    expect(actions.searchPerson).toHaveBeenCalledWith("Aaron Sorkin");
    act(() => { host.querySelector<HTMLButtonElement>(".related")!.click(); });
    expect(actions.openTitle).toHaveBeenCalledWith({ type: "movie", id: "tt2", name: "When Harry Met Sally", poster: "/sally.jpg" });
    act(() => { host.querySelectorAll<HTMLButtonElement>(".related")[1]!.click(); });
    expect(actions.openTitle).toHaveBeenCalledWith({ type: "series", id: "tt3", name: "Plain Show", poster: undefined });
  });

  it("shows both headings and seven skeletons while the read is in flight", () => {
    mount(<TitleExtrasRows extras={null} loading/>);
    const section = host.querySelector(".title-extras")!;
    expect(section.getAttribute("aria-busy")).toBe("true");
    expect(section.textContent).toContain("Cast and crew");
    expect(section.textContent).toContain("Select a name to search for it");
    expect(section.textContent).toContain("More like this");
    expect(host.querySelectorAll(".extras-skeleton .person")).toHaveLength(7);
    expect(host.querySelectorAll(".extras-skeleton .related")).toHaveLength(7);
    expect(host.querySelector(".person button, .related button, button.person, button.related")).toBeNull();
  });

  it("draws nothing for an empty answer and nothing when the request failed", () => {
    mount(<TitleExtrasRows extras={{ people: [], related: [], source: "addon" }} loading={false}/>);
    expect(host.querySelector(".title-extras")).toBeNull();
    mount(<TitleExtrasRows extras={null} loading={false}/>);
    expect(host.querySelector(".title-extras")).toBeNull();
    expect(host.textContent).not.toMatch(/error|failed/i);
  });
});

describe("TitleExtraFacts", () => {
  it("builds the age badge, the original title and the next episode", () => {
    const pieces = TitleExtraFacts({ extras: cast, language: "en", name: "When Harry Met Sally" });
    mount(<>{pieces.ageBadge}{pieces.heroLines}</>);
    const badge = host.querySelector(".age-badge")!;
    expect(badge.textContent).toBe("PG-13");
    expect(badge.getAttribute("title")).toBe("Age rating PG-13");
    const original = host.querySelector(".original-line")!;
    expect(original.querySelector("b")!.textContent).toBe("Když Harry potkal Sally");
    expect(original.textContent).toContain("Czech");
    const next = host.querySelector(".next-episode")!;
    expect(next.querySelector("b")!.textContent).toBe("S06E03 „The one“");
    expect(next.textContent).toContain("Next episode");
  });

  it("returns nothing to draw when the extras carry none of the hero facts", () => {
    const pieces = TitleExtraFacts({ extras: { people: [], related: [], source: "addon" }, language: "en", name: "Heat" });
    expect(pieces.ageBadge).toBeNull();
    expect(pieces.heroLines).toBeNull();
  });

  it("shows a different original title, and only the language when that is all that differs", () => {
    const same = TitleExtraFacts({
      extras: { ...cast, originalTitle: " when harry met sally ", originalLanguage: "en", nextEpisode: undefined },
      language: "en",
      name: "When Harry Met Sally",
    });
    expect(same.heroLines).toBeNull();
    const languageOnly = TitleExtraFacts({
      extras: { ...cast, originalTitle: "Heat", originalLanguage: "cs", nextEpisode: undefined },
      language: "en",
      name: "Heat",
    });
    mount(<>{languageOnly.heroLines}</>);
    const line = host.querySelector(".original-line")!;
    expect(line.textContent).toBe("Original language Czech");
    expect(line.querySelector("b")).toBeNull();
  });

  it("names the region an age rating was issued for", () => {
    const pieces = TitleExtraFacts({
      extras: { ...cast, ageRatingRegion: "US" },
      language: "en",
      name: "When Harry Met Sally",
    });
    mount(<>{pieces.ageBadge}</>);
    expect(host.querySelector(".age-badge")!.getAttribute("title")).toBe("Age rating PG-13 (United States)");
    expect(host.querySelector(".age-badge")!.textContent).toBe("PG-13");
  });

  it("drops the next episode once it has aired, without remounting", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-01T12:00:00Z"));
      const pieces = TitleExtraFacts({
        extras: {
          ...cast,
          originalTitle: undefined,
          originalLanguage: undefined,
          nextEpisode: { season: 6, episode: 3, name: "The one", released: "2026-06-01T12:00:30Z" },
        },
        language: "en",
        name: "Show",
      });
      mount(<>{pieces.heroLines}</>);
      expect(host.querySelector(".next-episode")).not.toBeNull();
      await act(async () => {
        vi.setSystemTime(new Date("2026-06-01T12:01:00Z"));
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(host.querySelector(".next-episode")).toBeNull();
      expect(host.querySelector(".title-extras")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
