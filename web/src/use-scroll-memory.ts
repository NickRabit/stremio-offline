import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { View } from "./App";
import { toCssPx, uiScale } from "./ui-scale";

export type PlaybackAnchor = { kind: "catalog" | "library"; key: string };
/** What a list is looking at, in terms the layout cannot invalidate: the item on top and
 *  how far it sits into the view. A rotation rewrites every pixel offset; this survives. */
type ViewAnchor = PlaybackAnchor & { offset: number };
type PlaybackReturn = {
  view: View;
  windowY: number;
  gridY?: number;
  catalogCompact: boolean;
  anchor?: PlaybackAnchor & { element: HTMLElement; ratio: number };
};

export interface ScrollMemoryOptions {
  view: View;
  viewRef: RefObject<View>;
  playerOpen: boolean;
  playerOpenRef: RefObject<boolean>;
  gridRef: RefObject<HTMLDivElement | null>;
  browseScrollRef: RefObject<HTMLDivElement | null>;
  catalogCompact: boolean;
  setCatalogCompact: Dispatch<SetStateAction<boolean>>;
}

export interface ScrollMemory {
  scrollByView: RefObject<Partial<Record<View, number>>>;
  restoringScroll: RefObject<boolean>;
  playbackReturn: RefObject<PlaybackReturn | null>;
  capturePlaybackReturn(anchor?: PlaybackAnchor): PlaybackReturn;
  viewScrollTop(): number;
  scheduleViewAnchor(): void;
}

export function useScrollMemory(options: ScrollMemoryOptions): ScrollMemory {
  const { view, viewRef, playerOpen, playerOpenRef, gridRef, browseScrollRef, catalogCompact, setCatalogCompact } = options;
  const scrollByView = useRef<Partial<Record<View, number>>>({});
  const restoringScroll = useRef(false);
  const playbackReturn = useRef<PlaybackReturn | null>(null);
  const viewAnchor = useRef<ViewAnchor | null>(null);
  const anchorFrozen = useRef(false);
  const anchorFrame = useRef(0);

  const findPlaybackAnchor = ({ kind, key }: PlaybackAnchor) => {
    const attribute = kind === "catalog" ? "catalogKey" : "path";
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(kind === "catalog" ? "[data-catalog-key]" : "[data-path]"));
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return candidates.find((element) => element === active && element.dataset[attribute] === key)
      ?? candidates.find((element) => element.dataset[attribute] === key && element.getClientRects().length > 0)
      ?? candidates.find((element) => element.dataset[attribute] === key);
  };
  // Only the library keeps its offset in a box of its own; every other view still rides the document.
  const viewScrollTop = () => viewRef.current === "library" ? browseScrollRef.current?.scrollTop ?? 0 : window.scrollY;
  /** The box a listing scrolls in, by the kind of tile that was played from it. */
  const scrollerOf = (kind?: PlaybackAnchor["kind"]) =>
    kind === "catalog" ? gridRef.current : kind === "library" ? browseScrollRef.current : null;
  const capturePlaybackReturn = (anchor?: PlaybackAnchor): PlaybackReturn => {
    const element = anchor && findPlaybackAnchor(anchor);
    const scroller = scrollerOf(anchor?.kind);
    const viewportTop = scroller?.getBoundingClientRect().top ?? 0;
    const viewportHeight = scroller && scroller.clientHeight > 0 ? scroller.clientHeight * uiScale() : window.innerHeight;
    return {
      view,
      windowY: window.scrollY,
      gridY: scroller?.scrollTop,
      catalogCompact,
      anchor: element && anchor ? { ...anchor, element, ratio: (element.getBoundingClientRect().top - viewportTop) / viewportHeight } : undefined,
    };
  };

  // Where the two lists that survive a rotation keep their position: both scroll inside a box
  // of their own now -- the catalogue in its grid, the library in its listing.
  const anchorScroller = () => viewRef.current === "catalog" ? gridRef.current : viewRef.current === "library" ? browseScrollRef.current : null;
  const anchorKind = () => viewRef.current === "catalog" ? "catalog" as const : viewRef.current === "library" ? "library" as const : null;
  const trackViewAnchor = () => {
    if (anchorFrozen.current || restoringScroll.current || playerOpenRef.current) return;
    const kind = anchorKind();
    if (!kind) return;
    const scroller = anchorScroller();
    const top = scroller?.getBoundingClientRect().top ?? 0;
    const first = Array.from(document.querySelectorAll<HTMLElement>(kind === "catalog" ? "[data-catalog-key]" : "[data-path]"))
      .find((element) => element.getClientRects().length > 0 && element.getBoundingClientRect().bottom > top + 1);
    const key = kind === "catalog" ? first?.dataset.catalogKey : first?.dataset.path;
    viewAnchor.current = first && key ? { kind, key, offset: first.getBoundingClientRect().top - top } : null;
  };
  const scheduleViewAnchor = () => {
    if (anchorFrame.current) return;
    anchorFrame.current = requestAnimationFrame(() => { anchorFrame.current = 0; trackViewAnchor(); });
  };
  const applyViewAnchor = () => {
    const saved = viewAnchor.current;
    if (!saved) return;
    const element = findPlaybackAnchor(saved);
    if (!element) return;
    const scroller = anchorScroller();
    const delta = element.getBoundingClientRect().top - (scroller?.getBoundingClientRect().top ?? 0) - saved.offset;
    if (Math.abs(delta) < 1) return;
    if (scroller) scroller.scrollTop += toCssPx(delta);
    else window.scrollBy(0, delta);
  };

  useEffect(() => {
    const onScroll = () => {
      // The library's listing scrolls on its own, so the document offset says nothing about it.
      if (!restoringScroll.current && !playerOpenRef.current && viewRef.current !== "library") scrollByView.current[viewRef.current] = window.scrollY;
      scheduleViewAnchor();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  // A rotation collapses the scrollable range -- the catalogue grid trades three columns for
  // eight -- and the browser clamps the offset to the new maximum, which throws the position
  // away for good. No pixel offset survives that, so the position is held as the item on top
  // and how far it sits into the view, then re-applied once the new layout settles. The resize
  // steps run before the scroll steps, so freezing the anchor here beats the clamp's own event.
  // Only a rotation is worth answering. Safari slides its toolbars away as the page scrolls,
  // which changes innerHeight and fires resize just the same -- and answering that dragged the
  // list somewhere else mid-scroll. The width and the orientation tell the two apart.
  const viewportShape = () => `${window.innerWidth}:${window.matchMedia("(orientation: landscape)").matches}`;
  useEffect(() => {
    let size = viewportShape();
    let handle = 0;
    let listening = false;
    const release = () => {
      cancelAnimationFrame(handle);
      anchorFrozen.current = false;
      restoringScroll.current = false;
      if (listening) {
        listening = false;
        for (const event of ["wheel", "touchmove", "keydown"]) window.removeEventListener(event, release);
      }
      scrollByView.current[viewRef.current] = viewScrollTop();
    };
    const onResize = () => {
      const next = viewportShape();
      if (next === size) return;
      size = next;
      if (!viewAnchor.current || playerOpenRef.current) return;
      anchorFrozen.current = true;
      restoringScroll.current = true;
      cancelAnimationFrame(handle);
      if (!listening) {
        listening = true;
        for (const event of ["wheel", "touchmove", "keydown"]) window.addEventListener(event, release, { passive: true });
      }
      const deadline = performance.now() + 700;
      const chase = () => {
        applyViewAnchor();
        if (performance.now() < deadline) handle = requestAnimationFrame(chase);
        else release();
      };
      handle = requestAnimationFrame(chase);
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      release();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);
  // A section's content arrives asynchronously, so the saved position is chased for a moment.
  useEffect(() => {
    viewRef.current = view;
    const wanted = scrollByView.current[view] ?? 0;
    restoringScroll.current = true;
    const deadline = performance.now() + 1500;
    let handle = 0;
    const apply = () => {
      if (viewRef.current === "library") {
        const element = browseScrollRef.current;
        if (element) element.scrollTop = wanted;
        // The listing may not hold its content yet, so the position is chased until it sticks.
        if ((!element || Math.abs(element.scrollTop - wanted) > 1) && performance.now() < deadline) handle = requestAnimationFrame(apply);
        else restoringScroll.current = false;
        return;
      }
      window.scrollTo(0, wanted);
      if (Math.abs(window.scrollY - wanted) > 1 && performance.now() < deadline) handle = requestAnimationFrame(apply);
      else restoringScroll.current = false;
    };
    handle = requestAnimationFrame(apply);
    // The chase gives way as soon as the viewer touches the page themselves.
    const stop = () => { cancelAnimationFrame(handle); restoringScroll.current = false; };
    for (const event of ["wheel", "touchstart", "keydown"]) window.addEventListener(event, stop, { passive: true, once: true });
    return () => {
      stop();
      for (const event of ["wheel", "touchstart", "keydown"]) window.removeEventListener(event, stop);
    };
  }, [view]);
  useEffect(() => {
    playerOpenRef.current = playerOpen;
    if (playerOpen) return;
    const saved = playbackReturn.current;
    if (!saved || saved.view !== view) return;
    restoringScroll.current = true;
    setCatalogCompact(saved.catalogCompact);
    const deadline = performance.now() + 1000;
    let handle = 0;
    const apply = () => {
      const anchor = saved.anchor;
      const element = anchor && (anchor.element.isConnected ? anchor.element : findPlaybackAnchor(anchor));
      const scroller = scrollerOf(anchor?.kind);
      if (scroller && anchor) {
        if (element) {
          const current = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
          scroller.scrollTop += toCssPx(current) - anchor.ratio * scroller.clientHeight;
        } else if (saved.gridY != null) scroller.scrollTop = saved.gridY;
      } else if (element && anchor) {
        window.scrollBy(0, element.getBoundingClientRect().top - anchor.ratio * window.innerHeight);
      } else window.scrollTo(0, saved.windowY);
      if (performance.now() < deadline) handle = requestAnimationFrame(apply);
      else { restoringScroll.current = false; playbackReturn.current = null; }
    };
    handle = requestAnimationFrame(apply);
    const stop = () => {
      cancelAnimationFrame(handle);
      restoringScroll.current = false;
      playbackReturn.current = null;
    };
    for (const event of ["wheel", "touchmove", "keydown"]) window.addEventListener(event, stop, { passive: true, once: true });
    return () => {
      stop();
      for (const event of ["wheel", "touchmove", "keydown"]) window.removeEventListener(event, stop);
    };
  }, [playerOpen, view]);

  return { scrollByView, restoringScroll, playbackReturn, capturePlaybackReturn, viewScrollTop, scheduleViewAnchor };
}
