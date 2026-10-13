import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DetailDescription, DetailHero } from "./DetailHero";
import { setLocale } from "./i18n";

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

const render = (node: ReactNode) => act(() => root.render(<>{node}</>));

describe("DetailHero", () => {
  it("renders the shared hero, flags a gallery and keeps the modifier and backdrop", () => {
    render(<DetailHero className="series-hero" background="/backdrop.jpg" copy={<h2>Title</h2>}/>);
    const hero = host.querySelector<HTMLElement>(".hero")!;
    expect(hero.classList.contains("series-hero")).toBe(true);
    expect(hero.classList.contains("has-gallery")).toBe(false);
    expect(hero.querySelector(".detail-copy h2")!.textContent).toBe("Title");
    expect(hero.style.backgroundImage).toContain("/backdrop.jpg");
    render(<DetailHero copy={<h2>Title</h2>} gallery={<div className="gallery-open"/>}/>);
    expect(host.querySelector(".hero.has-gallery .gallery-open")).not.toBeNull();
  });
});

describe("DetailDescription", () => {
  it("falls back to the catalogue's words and shows its skeleton while loading", () => {
    render(<DetailDescription identityKey="m1"/>);
    expect(host.querySelector(".description-preview")!.textContent).toBe("No description.");
    render(<DetailDescription identityKey="m1" loading skeleton={<span className="skeleton-line"/>}/>);
    expect(host.querySelector(".catalog-description")!.getAttribute("aria-busy")).toBe("true");
    expect(host.querySelector(".description-preview .skeleton-line")).not.toBeNull();
  });
});
