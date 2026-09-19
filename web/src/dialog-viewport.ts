import { RefObject, useEffect } from "react";

/**
 * A fixed overlay is laid out against the large viewport, so on a phone the
 * on-screen keyboard pushes half the dialog off the screen and nothing can be
 * scrolled back into view. The visual viewport is the part actually on screen;
 * the overlay is sized and positioned against that instead.
 */
export function useDialogViewport(ref: RefObject<HTMLElement | null>) {
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
