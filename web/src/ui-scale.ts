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
  return Math.floor(Math.max(1, Math.min(chosen, width / 1024, height / 640)) * 100) / 100;
}

let currentChosen = readUiScale();
let currentEffective = effectiveUiScale(currentChosen, window.innerWidth, window.innerHeight);
let currentSnapshot = { chosen: currentChosen, effective: currentEffective };

const notify = () => {
  for (const listener of listeners) listener();
};

export function applyUiScale(): void {
  const chosen = readUiScale();
  const effective = effectiveUiScale(chosen, window.innerWidth, window.innerHeight);
  const root = document.documentElement;
  if (effective === 1) {
    root.style.removeProperty("zoom");
    root.style.removeProperty("--ui-scale");
  } else {
    root.style.setProperty("zoom", String(effective));
    root.style.setProperty("--ui-scale", String(effective));
  }
  if (chosen !== currentChosen || effective !== currentEffective) {
    currentChosen = chosen;
    currentEffective = effective;
    currentSnapshot = { chosen, effective };
    notify();
  }
}

export function writeUiScale(scale: UiScale): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(scale));
  } catch {
    // Storage may be unavailable (private mode); the choice still applies to this page.
  }
  applyUiScale();
  notify();
}

export function uiScale(): number {
  return currentEffective;
}

/** Viewport pixels (rects, client coordinates and window scroll) expressed in CSS pixels
 *  (element scroll offsets, offsets and styles). */
export function toCssPx(viewportPx: number): number {
  return viewportPx / uiScale();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1) {
    applyUiScale();
    window.addEventListener("resize", applyUiScale);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("resize", applyUiScale);
  };
};

const getSnapshot = () => currentSnapshot;

export function useUiScale(): { chosen: UiScale; effective: number } {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
