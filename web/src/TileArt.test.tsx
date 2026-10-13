import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PosterMosaic, TileArt } from "./TileArt";
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

describe("PosterMosaic", () => {
  it("draws one picture per distinct film and names itself", () => {
    act(() => root.render(<PosterMosaic posters={["Heat.jpg", "Ronin.jpg"]} label="Poster mosaic of 2 films"/>));
    const mosaic = host.querySelector(".library-preview-collage")!;
    expect(mosaic.getAttribute("role")).toBe("img");
    expect(mosaic.getAttribute("aria-label")).toBe("Poster mosaic of 2 films");
    expect([...mosaic.querySelectorAll("img")].map((image) => image.getAttribute("src"))).toEqual(["Heat.jpg", "Ronin.jpg"]);
  });

  it("is not a mosaic for a folder that stands for one film", () => {
    act(() => root.render(<PosterMosaic posters={["Heat.jpg"]} label="Poster mosaic of 1 films"/>));
    expect(host.querySelector(".library-preview-collage")).toBeNull();
    act(() => root.render(<PosterMosaic posters={[]} label="Poster mosaic of 0 films"/>));
    expect(host.querySelector(".library-preview-collage")).toBeNull();
  });
});


describe("TileArt image failures", () => {
  const render = (shape: "wide" | "poster", poster = "poster.jpg", wide = "wide.jpg") =>
    act(() => root.render(<TileArt shape={shape} poster={poster} wide={wide} fallback={<span data-fallback/>}/>));
  const fail = () => act(() => host.querySelector<HTMLImageElement>("img:not(.tile-blur)")!.dispatchEvent(new Event("error")));

  it("falls back from a missing backdrop to the poster and survives repeated shape changes", () => {
    render("wide");
    fail();
    expect(host.querySelector("img:not(.tile-blur)")?.getAttribute("src")).toBe("poster.jpg");
    for (const shape of ["poster", "wide", "poster", "wide"] as const) {
      render(shape);
      expect(host.querySelector("img:not(.tile-blur)")?.getAttribute("src")).toBe("poster.jpg");
      expect(host.querySelector(".broken")).toBeNull();
    }
  });

  it("uses the icon when both images fail, and resets failures for a different item", () => {
    render("wide"); fail(); fail();
    expect(host.querySelector("[data-fallback]")).not.toBeNull();
    render("poster", "next-poster.jpg", "next-wide.jpg");
    expect(host.querySelector("img")?.getAttribute("src")).toBe("next-poster.jpg");
    expect(host.querySelector(".broken")).toBeNull();
  });

  it("retains a healthy image after switching away from a failed poster", () => {
    render("poster"); fail();
    render("wide");
    expect(host.querySelector("img:not(.tile-blur)")?.getAttribute("src")).toBe("wide.jpg");
    render("poster");
    expect(host.querySelector("img:not(.tile-blur)")?.getAttribute("src")).toBe("wide.jpg");
  });

  it("removes failed mosaic cells and shows the fallback when every cell fails", () => {
    act(() => root.render(<PosterMosaic posters={["a.jpg", "b.jpg"]} label="Mosaic" fallback={<span data-fallback/>}/>));
    act(() => host.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(host.querySelector("img")?.getAttribute("src")).toBe("b.jpg");
    expect(host.querySelector(".library-preview-collage")).toBeNull();
    act(() => host.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(host.querySelector("[data-fallback]")).not.toBeNull();
  });
});
