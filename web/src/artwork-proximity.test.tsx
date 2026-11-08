import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ARTWORK_AHEAD_MIN_PX, ArtworkProximity, artworkAhead, NearImage, scrollingAncestor } from "./artwork-proximity";
import { PosterMosaic, TileArt } from "./TileArt";

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

class StubResizeObserver {
  static instances: StubResizeObserver[] = [];

  readonly elements = new Set<Element>();
  disconnected = false;

  constructor(readonly callback: ResizeObserverCallback) {
    StubResizeObserver.instances.push(this);
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

  fire() {
    this.callback([...this.elements].map((target) => ({ target } as ResizeObserverEntry)), this as unknown as ResizeObserver);
  }
}

let root: Root;
let host: HTMLDivElement;
let scroller: HTMLDivElement;
let scrollerRef: { current: HTMLDivElement | null };
let ancestorRef: { current: HTMLDivElement | null };
let animationFrames: Map<number, FrameRequestCallback>;
let nextAnimationFrame: number;

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

// The frames tiles hold until they come near, in document order.
const waits = () => [...host.querySelectorAll<HTMLElement>(".tile-art-wait")];

const observer = () => StubIntersectionObserver.instances.at(-1)!;

// A layout that scrolls the element gives it overflow; one that scrolls the page does not.
const setScrolling = (scrolls: boolean) => {
  scroller.style.overflowY = scrolls ? "auto" : "visible";
};

const flushAnimationFrame = () => {
  const callbacks = [...animationFrames.values()];
  animationFrames.clear();
  act(() => callbacks.forEach((callback) => callback(performance.now())));
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  StubIntersectionObserver.instances = [];
  StubResizeObserver.instances = [];
  animationFrames = new Map();
  nextAnimationFrame = 1;
  vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const handle = nextAnimationFrame++;
    animationFrames.set(handle, callback);
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => { animationFrames.delete(handle); });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  scrollerRef = { current: null };
  ancestorRef = { current: null };
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
  it("uses the nearest horizontal or vertical scrolling ancestor", () => {
    act(() => root.render(
      <div ref={ancestorRef} style={{ overflowY: "auto" }}>
        <div ref={scrollerRef}>
          <ArtworkProximity scroller={scrollerRef}>{picture("/first.jpg")}</ArtworkProximity>
        </div>
      </div>,
    ));
    expect(observer().root).toBe(ancestorRef.current);
    expect(scrollingAncestor(scrollerRef.current)).toBe(ancestorRef.current);

    scrollerRef.current!.style.overflowY = "auto";
    expect(scrollingAncestor(scrollerRef.current)).toBe(scrollerRef.current);

    act(() => root.render(<div ref={scrollerRef}/>));
    setScrolling(false);
    render(picture("/second.jpg"));
    expect(observer().root).toBeNull();
  });

  it("creates no picture until its tile is reported near, then loads it eagerly", () => {
    render(<>{picture("/first.jpg")}{picture("/second.jpg")}</>);
    expect(host.querySelector("img")).toBeNull();
    const [first, second] = waits();
    expect(observer().elements.has(first)).toBe(true);
    expect(observer().elements.has(second)).toBe(true);

    act(() => observer().fire([first]));
    expect(loading("/first.jpg")).toBe("eager");
    expect(host.querySelector('img[src="/second.jpg"]')).toBeNull();
    expect(waits()).toEqual([second]);
  });

  it("draws the picture at once where the browser cannot watch tiles", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    render(picture("/first.jpg"));
    expect(loading("/first.jpg")).toBe("lazy");
    expect(waits()).toHaveLength(0);
  });

  it("creates a poster mosaic only once its tile is reported near", () => {
    render(<PosterMosaic posters={["/a.jpg", "/b.jpg"]} label="Two"/>);
    expect(host.querySelector("img")).toBeNull();
    act(() => observer().fire(waits()));
    expect(host.querySelectorAll(".library-preview-collage img")).toHaveLength(2);
  });

  it("unobserves reported and unmounted tiles, disconnects the provider, and ignores late entries", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<>{picture("/first.jpg")}{picture("/second.jpg")}</>);
    const watched = observer();
    const [first, second] = waits();

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

  it("makes a tile wait again when its picture changes", () => {
    render(picture("/first.jpg", "tile"));
    act(() => observer().fire(waits()));
    expect(loading("/first.jpg")).toBe("eager");

    render(picture("/second.jpg", "tile"));
    expect(host.querySelector("img")).toBeNull();
    const [wait] = waits();
    expect(observer().elements.has(wait)).toBe(true);
    act(() => observer().fire([wait]));
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
    const [wait] = waits();
    expect(scrolling.elements.has(wait)).toBe(true);

    setScrolling(false);
    act(() => window.dispatchEvent(new Event("resize")));

    const page = observer();
    expect(page).not.toBe(scrolling);
    expect(scrolling.disconnected).toBe(true);
    expect(page.root).toBeNull();
    expect(page.elements.has(wait)).toBe(true);
    expect(host.querySelector("img")).toBeNull();
    act(() => page.fire([wait]));
    expect(loading("/first.jpg")).toBe("eager");
  });

  it("switches from a self-scrolling pane to its scrolling ancestor after a layout change", () => {
    act(() => root.render(
      <div ref={ancestorRef}>
        <div ref={scrollerRef}>
          <ArtworkProximity scroller={scrollerRef}>{picture("/first.jpg")}</ArtworkProximity>
        </div>
      </div>,
    ));
    scrollerRef.current!.style.overflowY = "auto";
    act(() => window.dispatchEvent(new Event("resize")));
    const pane = observer();
    expect(pane.root).toBe(scrollerRef.current);

    scrollerRef.current!.style.overflowY = "visible";
    ancestorRef.current!.style.overflowY = "auto";
    act(() => StubResizeObserver.instances.at(-1)!.fire());
    flushAnimationFrame();

    const ancestor = observer();
    expect(ancestor).not.toBe(pane);
    expect(pane.disconnected).toBe(true);
    expect(ancestor.root).toBe(ancestorRef.current);
    expect(ancestor.elements.has(waits()[0])).toBe(true);

    const observers = StubIntersectionObserver.instances.length;
    act(() => StubResizeObserver.instances.at(-1)!.fire());
    flushAnimationFrame();
    expect(StubIntersectionObserver.instances).toHaveLength(observers);
  });

  it("uses a horizontal strip as its root and takes half its width as horizontal reach", () => {
    scroller.style.overflowX = "auto";
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 900 });
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 1600 });
    render(picture("/first.jpg"));
    expect(observer().root).toBe(scroller);
    expect(artworkAhead(scroller)).toBe("900px 800px");
    expect(observer().rootMargin).toBe("900px 800px");
  });

  it("makes NearImage lazy and async until reported while preserving its error handler", () => {
    const onError = vi.fn();
    render(<NearImage src="/near.jpg" alt="Near" className="near-picture" onError={onError}/>);
    const picture = image("/near.jpg");
    expect(picture.getAttribute("loading")).toBe("lazy");
    expect(picture.getAttribute("decoding")).toBe("async");
    expect(picture.getAttribute("alt")).toBe("Near");
    expect(picture.className).toBe("near-picture");

    act(() => observer().fire([picture]));
    expect(picture.getAttribute("loading")).toBe("eager");
    act(() => picture.dispatchEvent(new Event("error")));
    expect(onError).toHaveBeenCalledOnce();
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
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 1000 });
    expect(artworkAhead(scroller)).toBe("1400px 500px");
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 300 });
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 200 });
    expect(artworkAhead(scroller)).toBe(`${ARTWORK_AHEAD_MIN_PX}px ${ARTWORK_AHEAD_MIN_PX / 2}px`);
  });
});
