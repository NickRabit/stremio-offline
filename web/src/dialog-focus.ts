import { useEffect, type RefObject } from "react";

export function useDialogFocus(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const controls = () => [...dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]),a[href],input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
    )].filter((node) => node.tabIndex >= 0 && !node.matches(":disabled") && node.getClientRects().length > 0 && !node.closest('[hidden],[inert]') && getComputedStyle(node).visibility !== "hidden");
    if (!dialog.contains(document.activeElement)) (controls()[0] ?? dialog).focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].at(-1) !== dialog) return;
      const available = controls();
      const first = available[0];
      const last = available.at(-1);
      const outside = document.activeElement === dialog || !dialog.contains(document.activeElement);
      if (!first) { event.preventDefault(); dialog.focus(); }
      else if (event.shiftKey && (outside || document.activeElement === first)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (outside || document.activeElement === last)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (previous?.isConnected && (dialog.contains(document.activeElement) || document.activeElement === document.body)) previous.focus({ preventScroll: true });
    };
  }, [ref]);
}
