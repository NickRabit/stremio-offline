import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { forgetKnownSizes, KNOWN_SIZE_LIMIT, PosterMosaic, TileArt } from "./TileArt";
import { setLocale } from "./i18n";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  forgetKnownSizes();
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

  it("draws the listing width of a remote backdrop and falls back from that same address", () => {
    const backdrop = "/api/remote-libraries/rlib_a/items/item-1/artwork/Backdrop";
    render("wide", "poster.jpg", `${backdrop}?tag=abc`);
    expect(host.querySelector("img:not(.tile-blur)")?.getAttribute("src")).toBe(`${backdrop}?tag=abc&size=tile`);
    fail();
    expect(host.querySelector("img:not(.tile-blur)")?.getAttribute("src")).toBe("poster.jpg");
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

describe("TileArt picture layout", () => {
  const render = (shape: "wide" | "poster", poster?: string, wide?: string) =>
    act(() => root.render(<TileArt shape={shape} poster={poster} wide={wide} fallback={<span data-fallback/>}/>));
  const picture = () => host.querySelector<HTMLImageElement>("img:not(.tile-blur)")!;
  const load = (node: HTMLImageElement, width: number, height: number) => {
    Object.defineProperty(node, "naturalWidth", { value: width, configurable: true });
    Object.defineProperty(node, "naturalHeight", { value: height, configurable: true });
    act(() => node.dispatchEvent(new Event("load")));
  };

  it("remembers the measured fit of a picture for its next mount", () => {
    render("poster", "/wide.jpg");
    expect(host.querySelector(".tile-fit")).toBeNull();
    load(picture(), 1600, 900);
    expect(host.querySelector(".tile-fit")).not.toBeNull();
    expect(host.querySelector(".tile-blur")).not.toBeNull();
    expect([...host.querySelectorAll("img")].map((image) => image.getAttribute("decoding"))).toEqual(["async", "async"]);

    act(() => root.unmount());
    root = createRoot(host);
    render("poster", "/wide.jpg");
    expect(host.querySelector(".tile-fit")).not.toBeNull();
    expect(host.querySelector(".tile-blur")).not.toBeNull();
  });

  it("keeps a picture's real size for a shape it has not been drawn in yet", () => {
    // A square picture fills both frames; a load in one shape must still settle the other.
    render("poster", "/square.jpg");
    load(picture(), 600, 600);
    render("wide", "/square.jpg");
    expect(host.querySelector(".tile-fit")).toBeNull();
    expect(host.querySelector(".tile-blur")).toBeNull();
  });

  it("keeps the fit of a tile on screen after the shared memory has let its picture go", () => {
    render("poster", "/wide.jpg");
    load(picture(), 1600, 900);
    expect(host.querySelector(".tile-fit")).not.toBeNull();
    // Other tiles load enough pictures to push this one out of the shared memory.
    const others = document.createElement("div");
    const otherRoot = createRoot(others);
    for (let index = 0; index <= KNOWN_SIZE_LIMIT; index += 1) {
      act(() => otherRoot.render(<TileArt shape="poster" poster={`/other-${index}.jpg`} fallback={null}/>));
      const node = others.querySelector<HTMLImageElement>("img:not(.tile-blur)")!;
      Object.defineProperty(node, "naturalWidth", { value: 400, configurable: true });
      Object.defineProperty(node, "naturalHeight", { value: 600, configurable: true });
      act(() => node.dispatchEvent(new Event("load")));
    }
    act(() => otherRoot.unmount());
    render("poster", "/wide.jpg");
    expect(host.querySelector(".tile-fit")).not.toBeNull();
  });

  it("does not rerender when a loaded picture already has the drawn fit", () => {
    let renders = 0;
    act(() => root.render(<Profiler id="tile" onRender={() => { renders += 1; }}><TileArt shape="wide" poster="/poster.jpg" fallback={<span data-fallback/>}/></Profiler>));
    const beforeLoad = renders;

    load(picture(), 400, 600);

    expect(renders).toBe(beforeLoad);
  });
});
