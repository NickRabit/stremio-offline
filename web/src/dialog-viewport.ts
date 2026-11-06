import { RefObject, useEffect } from "react";

let locks = 0;

/** The element a touch drag at `target` would scroll inside the overlay, if any can still move. */
const scrollableAncestor = (target: EventTarget | null, overlay: HTMLElement): HTMLElement | null => {
  for (let node = target instanceof Element ? target : null; node && node !== overlay; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
};

/**
 * A fixed overlay is laid out against the large viewport, so on a phone the
 * on-screen keyboard pushes half the dialog off the screen and nothing can be
 * scrolled back into view. The visual viewport is the part actually on screen;
 * the overlay is sized and positioned against that instead.
 *
 * The page behind stays put while a dialog is open. The document's overflow is
 * hidden without moving it -- the app reads `window.scrollY` to restore views --
 * and a drag that starts outside the dialog's own scrolling body is cancelled,
 * because iOS otherwise scrolls the page under the overlay once the keyboard is up.
 */
export function useDialogViewport(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (locks++ === 0) document.documentElement.classList.add("dialog-locked");
    const overlay = ref.current;
    const onTouchMove = (event: TouchEvent) => {
      if (overlay && !scrollableAncestor(event.target, overlay)) event.preventDefault();
    };
    overlay?.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      overlay?.removeEventListener("touchmove", onTouchMove);
      if (--locks === 0) document.documentElement.classList.remove("dialog-locked");
    };
  }, [ref]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const overlay = ref.current;
    if (!viewport || !overlay) return;
    const fit = () => {
      overlay.style.setProperty("--dialog-viewport-height", `${viewport.height}px`);
      overlay.style.setProperty("--dialog-viewport-top", `${viewport.offsetTop}px`);
    };
    fit();
    viewport.addEventListener("resize", fit);
    viewport.addEventListener("scroll", fit);
    return () => {
      viewport.removeEventListener("resize", fit);
      viewport.removeEventListener("scroll", fit);
      overlay.style.removeProperty("--dialog-viewport-height");
      overlay.style.removeProperty("--dialog-viewport-top");
    };
  }, [ref]);
}
