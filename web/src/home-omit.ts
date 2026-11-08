import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** How long the page has to stay still before an empty shelf on screen is taken away. */
export const OMIT_IDLE_MS = 1500;
/** A scroll this recent means the viewer is in the middle of a gesture. */
export const SCROLLING_MS = 1000;

// When the page -- or anything in it -- last scrolled. Capture sees every scroller's events.
let lastScrollAt = Number.NEGATIVE_INFINITY;
if (typeof document !== "undefined") {
  document.addEventListener("scroll", () => { lastScrollAt = Date.now(); }, { capture: true, passive: true });
}
export function isScrolling(): boolean {
  return Date.now() - lastScrollAt < SCROLLING_MS;
}

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
 * already in view and the viewer is scrolling. Taking it away then pulls everything below it up
 * under the thumb. So a shelf that turns out empty on screen in the middle of a scroll keeps its
 * place until it scrolls out of view -- and if it left over the top, the page is shifted by its
 * height so nothing in view moves -- or until the page has been still for a moment.
 *
 * Everything else goes at once, as it always has: a shelf off screen, one that turns empty while
 * nobody is scrolling (a first load, where an empty row left standing would only fall away later),
 * and one that is already empty when it mounts, which is never drawn.
 */
export function useOmission(omit: boolean, element: RefObject<HTMLElement | null>): boolean {
  // A shelf already known to be empty when it mounts -- Home drawn again from rows it holds --
  // is never drawn: only one that turns empty on the page is held.
  const [gone, setGone] = useState(omit);
  const pending = useRef<{ anchor: Element; top: number; scroller: Scroller } | null>(null);

  useEffect(() => {
    if (!omit) { setGone(false); return; }
    if (gone) return;
    const node = element.current;
    if (!node || typeof IntersectionObserver === "undefined" || !isScrolling()) { setGone(true); return; }
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
    // `gone` is read only to skip a shelf that is already off the page; it never restarts a hold.
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
