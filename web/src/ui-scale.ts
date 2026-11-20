import { useSyncExternalStore } from "react";

export const UI_SCALES = [1, 1.15, 1.3, 1.5] as const;
export type UiScale = typeof UI_SCALES[number];

const STORAGE_KEY = "ui-scale";
const listeners = new Set<() => void>();

export function readUiScale(): UiScale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return UI_SCALES.find((scale) => String(scale) === stored) ?? 1;
  } catch {
    return 1;
  }
}

export function effectiveUiScale(chosen: number, width: number, height: number): number {
  // Floored to whole percent, with a nudge so 1.15 (114.999... after * 100) stays 115.
  return Math.floor(Math.max(1, Math.min(chosen, width / 1024, height / 640)) * 100 + 1e-6) / 100;
}

/**
 * Layout conditions that used to be `@media` rules. A media query sees the window, not the space
 * left once the root is zoomed, so at 150 % a 1920x1080 window would keep its roomy catalogue
 * while really holding 1280x720 of layout. Each token is the old query evaluated on that space
 * (CSS pixels) and lands in `data-viewport` on the root; style.css reads it through `:where()`
 * so the selectors keep the specificity the media rules had. Width counts the scrollbar, as a
 * media query does; height is the stable client height, which phone toolbars do not move.
 */
export function viewportConditions(width: number, height: number): string[] {
  const conditions: string[] = [];
  const landscape = width > height;
  if (width >= 981 && height <= 780) conditions.push("wide-short");
  if ((width >= 981 && height <= 900) || (width >= 981 && width <= 1400 && height <= 1050)) conditions.push("catalog-tight");
  if ((width >= 701 && height >= 501 && height <= 900) || (width >= 981 && width <= 1400 && height <= 1050)) conditions.push("catalog-compact");
  if (width <= 1300) conditions.push("narrow-1300");
  if (width >= 1100) conditions.push("wide-1100");
  if (height <= 880) conditions.push("short-880");
  if (width >= 1920) conditions.push("wide-1920");
  if (width >= 701 && height >= 501 && height <= 680 && landscape) conditions.push("landscape-short");
  return conditions;
}

let currentChosen = readUiScale();
let currentEffective = effectiveUiScale(currentChosen, window.innerWidth, window.innerHeight);
let currentSnapshot = { chosen: currentChosen, effective: currentEffective };

const notify = () => {
  for (const listener of listeners) listener();
};

/** Applies the choice held in memory: read from storage once at start, then set by
 *  [writeUiScale], so a choice storage refused still holds for this page. */
export function applyUiScale(chosen: UiScale = currentChosen): void {
  const effective = effectiveUiScale(chosen, window.innerWidth, window.innerHeight);
  const root = document.documentElement;
  if (effective === 1) {
    root.style.removeProperty("zoom");
    root.style.removeProperty("--ui-scale");
  } else {
    root.style.setProperty("zoom", String(effective));
    root.style.setProperty("--ui-scale", String(effective));
  }
  // In standards mode the root's client height is in viewport pixels, like innerWidth.
  const height = root.clientHeight || window.innerHeight;
  root.dataset.viewport = viewportConditions(window.innerWidth / effective, height / effective).join(" ");
  if (chosen !== currentChosen || effective !== currentEffective) {
    currentChosen = chosen;
    currentEffective = effective;
    currentSnapshot = { chosen, effective };
    notify();
  }
}

/** Stores this device's choice and applies it. Given an anchor (the control that made the
 *  change), the page scrolls so the anchor stays where it was on screen instead of the
 *  document growing or shrinking away from it. */
export function writeUiScale(scale: UiScale, anchor?: Element | null): void {
  const before = anchor?.getBoundingClientRect().top;
  try {
    localStorage.setItem(STORAGE_KEY, String(scale));
  } catch {
    // Storage may be unavailable (private mode); the choice still applies to this page.
  }
  applyUiScale(scale);
  notify();
  if (anchor && before !== undefined) {
    // Both values are viewport pixels, the same space window scrolling uses.
    const shift = anchor.getBoundingClientRect().top - before;
    if (shift) window.scrollBy(0, shift);
  }
}

export function uiScale(): number {
  return currentEffective;
}

/** Viewport pixels (rects, client coordinates and window scroll) expressed in CSS pixels
 *  (element scroll offsets, offsets and styles). */
export function toCssPx(viewportPx: number): number {
  return viewportPx / uiScale();
}

const onResize = () => applyUiScale();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1) {
    applyUiScale();
    window.addEventListener("resize", onResize);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("resize", onResize);
  };
};

const getSnapshot = () => currentSnapshot;

export function useUiScale(): { chosen: UiScale; effective: number } {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// Set the zoom and the layout conditions before the first paint, not after React subscribes.
applyUiScale();
