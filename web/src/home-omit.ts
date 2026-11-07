import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** How long the page has to stay still before an empty shelf on screen is taken away. */
export const OMIT_IDLE_MS = 1500;

type Scroller = HTMLElement | null;

/** The element that scrolls `element`, or null for the window. */
function scrollParent(element: HTMLElement): Scroller {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/**
 * Whether a shelf that has nothing to show may leave the page now.
 *
 * A shelf loads as it nears the screen, so on a slow server it can come back empty while it is
 * already in view. Taking it away then pulls everything below it up under the viewer's thumb. So
 * a shelf that turns out empty on screen keeps its place until it scrolls out of view -- and if
 * it left over the top, the page is shifted by its height so nothing in view moves -- or until
 * the page has been still for a moment, when a change is no longer in the middle of a gesture.
 * Off screen it goes at once.
 */
export function useOmission(omit: boolean, element: RefObject<HTMLElement | null>): boolean {
  const [gone, setGone] = useState(false);
  const pending = useRef<{ anchor: Element; top: number; scroller: Scroller } | null>(null);

  useEffect(() => {
    if (!omit) { setGone(false); return; }
    const node = element.current;
    if (!node || typeof IntersectionObserver === "undefined") { setGone(true); return; }
    const scroller = scrollParent(node);
    const scrollTarget: EventTarget = scroller ?? window;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const leave = (above: boolean) => {
      if (done) return;
      done = true;
      stop();
      const anchor = node.nextElementSibling;
      pending.current = above && anchor ? { anchor, top: anchor.getBoundingClientRect().top, scroller } : null;
      setGone(true);
    };
    const restartIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => leave(false), OMIT_IDLE_MS);
    };
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      if (entry.isIntersecting) { restartIdle(); return; }
      leave(entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? 0));
    });
    const stop = () => {
      observer.disconnect();
      clearTimeout(idle);
      scrollTarget.removeEventListener("scroll", restartIdle);
    };
    scrollTarget.addEventListener("scroll", restartIdle, { passive: true });
    observer.observe(node);
    return stop;
  }, [omit, element]);

  // The shelf has just left over the top: put the first thing after it back where it was. A
  // browser that anchors scrolling by itself has already done so, and the difference is zero.
  useLayoutEffect(() => {
    const kept = pending.current;
    if (!gone || !kept) return;
    pending.current = null;
    const delta = kept.anchor.getBoundingClientRect().top - kept.top;
    if (delta !== 0) (kept.scroller ?? window).scrollBy(0, delta);
  }, [gone]);

  return gone;
}
