import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TitleChips, type TitleChipsProps } from "./TitleChips";
import { setLocale } from "./i18n";
import type { SiteLink, Trailer } from "./types";

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

const trailer: Trailer = { youtubeId: "abcdefghijk", provider: "tmdb" };
const render = (over: Partial<TitleChipsProps> = {}) => {
  const onTrailer = vi.fn();
  act(() => root.render(<TitleChips onTrailer={onTrailer} secureMode={false} {...over}/>));
  return onTrailer;
};
const chips = () => [...host.querySelectorAll<HTMLElement>(".title-chips > *")];

describe("TitleChips", () => {
  it("renders nothing at all when the title has no kind, trailer or link", () => {
    render();
    expect(host.querySelector(".title-chips")).toBeNull();
  });

  it("keeps the order the catalogue uses: controls, kind, trailer, then the sites", () => {
    render({
      leading: <button className="watch-star">star</button>,
      kind: "Movie",
      trailer,
      links: [{ site: "imdb", url: "/imdb" }, { site: "csfd", url: "/csfd" }, { site: "tmdb", url: "/tmdb" }],
    });
    expect(chips().map((node) => node.className.split(" ")[0])).toEqual(["watch-star", "pill", "trailer-action", "title-links"]);
    // The links keep a fixed order of their own, whatever order the server sent them in.
    expect([...host.querySelectorAll(".title-links a")].map((anchor) => anchor.textContent)).toEqual(["ČSFD", "TMDB", "IMDb"]);
  });

  it("opens the app's own overlay for the trailer unless Secure Mode is on", () => {
    const onTrailer = render({ kind: "Series", trailer });
    act(() => host.querySelector<HTMLButtonElement>(".trailer-action")!.click());
    expect(onTrailer).toHaveBeenCalledWith(trailer);
    expect(host.querySelector(".trailer-action")!.textContent).toBe("TRAILER");
    render({ kind: "Series", trailer, secureMode: true });
    const anchor = host.querySelector<HTMLAnchorElement>("a.trailer-action")!;
    expect(anchor.href).toContain("youtube.com/watch");
  });

  it("drops a trailer that is not a usable YouTube id", () => {
    render({ kind: "Movie", trailer: { youtubeId: "nope", provider: "tmdb" } });
    expect(host.querySelector(".trailer-action")).toBeNull();
    expect(host.querySelector(".pill")!.textContent).toBe("Movie");
  });

  it("names each site by its trademark and each link by the site it opens", () => {
    render({ links: [{ site: "csfd", url: "/csfd" }] as SiteLink[] });
    const anchor = host.querySelector<HTMLAnchorElement>(".title-links a")!;
    expect(anchor.textContent).toBe("ČSFD");
    expect(anchor.getAttribute("title")).toBe("Open on ČSFD");
    expect(anchor.getAttribute("href")).toBe("/csfd");
  });
});
