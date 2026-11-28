import { localeTag } from "./i18n";

const KEY = "player-speed";

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export type Speed = typeof SPEEDS[number];

/** A supported speed, or 1 for anything else. */
export function parseSpeed(value: unknown): Speed {
  if (typeof value !== "number" && typeof value !== "string") return 1;
  const parsed = Number(value);
  return (SPEEDS as readonly number[]).includes(parsed) ? parsed as Speed : 1;
}

export function readSpeed(): Speed {
  try { return parseSpeed(localStorage.getItem(KEY)); }
  catch { return 1; }
}

export function writeSpeed(value: Speed): void {
  try { localStorage.setItem(KEY, String(value)); } catch { /* storage may be unavailable */ }
}

export function stepSpeed(current: Speed, direction: 1 | -1): Speed {
  const index = SPEEDS.indexOf(current);
  return SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, index + direction))]!;
}

export function applySpeed(video: HTMLVideoElement, speed: Speed): void {
  video.defaultPlaybackRate = speed;
  if (video.playbackRate !== speed) video.playbackRate = speed;
  video.preservesPitch = true;
  if ("webkitPreservesPitch" in video) {
    (video as HTMLVideoElement & { webkitPreservesPitch: boolean }).webkitPreservesPitch = true;
  }
}

export function formatSpeed(speed: Speed): string {
  return `${new Intl.NumberFormat(localeTag(), { maximumFractionDigits: 2 }).format(speed)}×`;
}
