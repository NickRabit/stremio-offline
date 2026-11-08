import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ARTWORK_AHEAD_MIN_PX, ArtworkProximity, artworkAhead } from "./artwork-proximity";
import { TileArt } from "./TileArt";

class StubIntersectionObserver {
  static instances: StubIntersectionObserver[] = [];

  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly threshold = [];
  readonly elements = new Set<Element>();
  disconnected = false;

  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    this.root = options?.root ?? null;
    this.rootMargin = options?.rootMargin ?? "0px";
    StubIntersectionObserver.instances.push(this);
  }

  observe(element: Element) {
    this.elements.add(element);
  }

  unobserve(element: Element) {
    this.elements.delete(element);
  }

  disconnect() {
    this.disconnected = true;
    this.elements.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  fire(elements: Element[]) {
    this.callback(elements.map((target) => ({
      target,
      isIntersecting: true,
    } as IntersectionObserverEntry)), this as unknown as IntersectionObserver);
  }
}

let root: Root;
let host: HTMLDivElement;
let scroller: HTMLDivElement;
let scrollerRef: { current: HTMLDivElement | null };

const picture = (poster: string, key = poster) =>
  <TileArt key={key} shape="poster" poster={poster} fallback={<span/>}/>;

const withProvider = (children: React.ReactNode) =>
  <div ref={scrollerRef}>
    <ArtworkProximity scroller={scrollerRef}>{children}</ArtworkProximity>
  </div>;

const render = (children: React.ReactNode) => {
  act(() => root.render(withProvider(children)));
};

const image = (poster: string) =>
  host.querySelector<HTMLImageElement>(`img[src="${poster}"]:not(.tile-blur)`)!;

const loading = (poster: string) => image(poster).getAttribute("loading");

const observer = () => StubIntersectionObserver.instances.at(-1)!;

// A layout that scrolls the element gives it overflow; one that scrolls the page does not.
const setScrolling = (scrolls: boolean) => {
  scroller.style.overflowY = scrolls ? "auto" : "visible";
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  StubIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  scrollerRef = { current: null };
  act(() => root.render(<div ref={scrollerRef}/>));
  scroller = scrollerRef.current!;
  setScrolling(false);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ArtworkProximity", () => {
  it("uses a scrolling container as the shared root and the page when it does not scroll", () => {
    setScrolling(true);
    render(picture("/first.jpg"));
    expect(observer().root).toBe(scroller);
    expect(observer().rootMargin).toBe(artworkAhead(scroller));

    act(() => root.render(<div ref={scrollerRef}/>));
    setScrolling(false);
    render(picture("/second.jpg"));
    expect(observer().root).toBeNull();
  });

  it("keeps tiles lazy until each one is reported intersecting", () => {
    render(<>{picture("/first.jpg")}{picture("/second.jpg")}</>);
    expect(loading("/first.jpg")).toBe("lazy");
    expect(loading("/second.jpg")).toBe("lazy");

    act(() => observer().fire([image("/first.jpg")]));
    expect(loading("/first.jpg")).toBe("eager");
    expect(loading("/second.jpg")).toBe("lazy");
  });

  it("unobserves reported and unmounted tiles, disconnects the provider, and ignores late entries", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<>{picture("/first.jpg")}{picture("/second.jpg")}</>);
    const watched = observer();
    const first = image("/first.jpg");
    const second = image("/second.jpg");

    act(() => watched.fire([first]));
    expect(watched.elements.has(first)).toBe(false);

    render(picture("/second.jpg"));
    expect(watched.elements.has(second)).toBe(true);
    act(() => root.render(<div ref={scrollerRef}/>));
    expect(watched.elements.has(second)).toBe(false);
    expect(watched.disconnected).toBe(true);

    act(() => watched.fire([second]));
    expect(host.querySelector("img")).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it("makes a tile lazy again when its picture changes", () => {
    render(picture("/first.jpg"));
    act(() => observer().fire([image("/first.jpg")]));
    expect(loading("/first.jpg")).toBe("eager");

    render(picture("/second.jpg"));
    expect(loading("/second.jpg")).toBe("lazy");
    expect(observer().elements.has(image("/second.jpg"))).toBe(true);
    act(() => observer().fire([image("/second.jpg")]));
    expect(loading("/second.jpg")).toBe("eager");
  });

  it("keeps TileArt lazy without a provider and creates no observer", () => {
    act(() => root.render(picture("/alone.jpg")));
    expect(loading("/alone.jpg")).toBe("lazy");
    expect(StubIntersectionObserver.instances).toHaveLength(0);
  });

  it("switches to page scrolling on resize and re-observes registered tiles", () => {
    setScrolling(true);
    render(picture("/first.jpg"));
    const scrolling = observer();
    expect(scrolling.root).toBe(scroller);
    expect(scrolling.elements.has(image("/first.jpg"))).toBe(true);

    setScrolling(false);
    act(() => window.dispatchEvent(new Event("resize")));

    const page = observer();
    expect(page).not.toBe(scrolling);
    expect(scrolling.disconnected).toBe(true);
    expect(page.root).toBeNull();
    expect(page.elements.has(image("/first.jpg"))).toBe(true);
    expect(loading("/first.jpg")).toBe("lazy");
    act(() => page.fire([image("/first.jpg")]));
    expect(loading("/first.jpg")).toBe("eager");
  });

  it("takes a scrolling grid as its root while the grid is still empty", () => {
    setScrolling(true);
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 0 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 500 });
    render(null);
    expect(observer().root).toBe(scroller);
  });

  it("reaches one panel ahead, and never less than the minimum", () => {
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 1400 });
    expect(artworkAhead(scroller)).toBe("1400px 700px");
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 300 });
    expect(artworkAhead(scroller)).toBe(`${ARTWORK_AHEAD_MIN_PX}px ${ARTWORK_AHEAD_MIN_PX / 2}px`);
  });
});
