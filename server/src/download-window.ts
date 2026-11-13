import type { DownloadWindow } from "./api-types.js";

export const DOWNLOAD_WINDOW_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DOWNLOAD_WINDOW_TIME_WITH_SECONDS = /^([01]\d|2[0-3]):[0-5]\d:00$/;

const parseTime = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  if (DOWNLOAD_WINDOW_TIME.test(value)) return value;
  const match = DOWNLOAD_WINDOW_TIME_WITH_SECONDS.exec(value);
  return match ? value.slice(0, 5) : undefined;
};

export function parseDownloadWindow(value: unknown): DownloadWindow | undefined | "invalid" {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return "invalid";
  const { start, end } = value as Record<string, unknown>;
  const parsedStart = parseTime(start);
  const parsedEnd = parseTime(end);
  if (!parsedStart || !parsedEnd || parsedStart === parsedEnd) return "invalid";
  return { start: parsedStart, end: parsedEnd };
}

export function localMinuteOfDay(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return hour * 60 + minute;
}

const minuteValue = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

export function windowOpen(window: DownloadWindow, at: number, timeZone: string): boolean {
  const current = localMinuteOfDay(at, timeZone);
  const start = minuteValue(window.start);
  const end = minuteValue(window.end);
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
