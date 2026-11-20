import { localeTag } from "./i18n";

export function endsAt(nowMs: number, position: number, duration: number): number | null {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const start = Math.max(0, position);
  if (!(start < duration)) return null;
  return nowMs + (duration - start) * 1000;
}

export function formatEndsAt(epochMs: number): string {
  return new Intl.DateTimeFormat(localeTag(), { hour: "numeric", minute: "2-digit" }).format(epochMs);
}
