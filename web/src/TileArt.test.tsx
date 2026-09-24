import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PosterMosaic } from "./TileArt";
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
