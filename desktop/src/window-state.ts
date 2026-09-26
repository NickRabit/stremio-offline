import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SerialQueue } from "./serial-queue.js";

export interface Rect { x: number; y: number; width: number; height: number }
export interface WindowState { bounds: Rect; maximized: boolean }

export const WINDOW_STATE_FILE = "window-state.json";
export const DEFAULT_SIZE = { width: 1280, height: 800 };
export const MIN_SIZE = { width: 800, height: 560 };

export type WindowName = "main" | "settings";

const TITLE_BAR_HEIGHT = 40;
const MIN_VISIBLE = 100;

const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

const readRect = (value: unknown): Rect | null => {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!isInteger(record.x) || !isInteger(record.y) || !isInteger(record.width) || !isInteger(record.height)) return null;
  if (record.width < MIN_SIZE.width || record.height < MIN_SIZE.height) return null;
  return { x: record.x, y: record.y, width: record.width, height: record.height };
};

const readState = (value: unknown): WindowState | null => {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const bounds = readRect(record.bounds);
  if (bounds === null) return null;
  return { bounds, maximized: record.maximized === true };
};

const readFileText = async (file: string): Promise<string | null> => {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
};

const parse = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The file may hold several named windows; a missing name, a malformed file or a value of the wrong shape all mean "no state". */
export async function readWindowState(dir: string, name: WindowName): Promise<WindowState | null> {
  const body = parse(await readFileText(path.join(dir, WINDOW_STATE_FILE)));
  return isRecord(body) ? readState(body[name]) : null;
}

const queue = new SerialQueue();

export async function writeWindowState(dir: string, name: WindowName, state: WindowState): Promise<void> {
  await queue.run(async () => {
    const body = parse(await readFileText(path.join(dir, WINDOW_STATE_FILE)));
    const store: Record<string, unknown> = isRecord(body) ? body : {};
    store[name] = { bounds: { ...state.bounds }, maximized: state.maximized };
    await mkdir(dir, { recursive: true });
    const temporary = path.join(dir, `${WINDOW_STATE_FILE}.${randomUUID()}`);
    try {
      await writeFile(temporary, JSON.stringify(store) + "\n", { encoding: "utf8", flag: "wx" });
      await rename(temporary, path.join(dir, WINDOW_STATE_FILE));
    } catch (error) {
      await rm(temporary).catch(() => {});
      throw error;
    }
  });
}

const intersect = (a: Rect, b: Rect): { width: number; height: number } => ({
  width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
  height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
});

const overlapArea = (a: Rect, b: Rect): number => {
  const { width, height } = intersect(a, b);
  return Math.max(0, width) * Math.max(0, height);
};

const keepsTitleBar = (bounds: Rect, display: Rect): boolean => {
  const { width, height } = intersect(bounds, display);
  return width >= MIN_VISIBLE && height >= MIN_VISIBLE;
};

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

const centred = (area: Rect, size: { width: number; height: number }): WindowState => {
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  return {
    bounds: {
      x: area.x + Math.round((area.width - width) / 2),
      y: area.y + Math.round((area.height - height) / 2),
      width,
      height,
    },
    maximized: false,
  };
};

/**
 * Where a window opens. A saved rectangle survives only when at least 100×100 px of it lies on a
 * connected display; then it is clamped so the title bar sits inside that display and the size
 * does not exceed its work area. Anything else opens centred on the primary display.
 */
export function restoreBounds(saved: WindowState | null, displays: readonly Rect[], primary: Rect,
  defaultSize: { width: number; height: number }): WindowState {
  if (saved === null) return centred(primary, defaultSize);
  let host: Rect | null = null;
  let best = 0;
  for (const display of displays) {
    if (!keepsTitleBar(saved.bounds, display)) continue;
    const area = overlapArea(saved.bounds, display);
    if (host === null || area > best) {
      host = display;
      best = area;
    }
  }
  if (host === null) return centred(primary, defaultSize);
  const width = Math.min(saved.bounds.width, host.width);
  const height = Math.min(saved.bounds.height, host.height);
  return {
    bounds: {
      x: clamp(saved.bounds.x, host.x, host.x + host.width - width),
      y: clamp(saved.bounds.y, host.y, host.y + host.height - TITLE_BAR_HEIGHT),
      width,
      height,
    },
    maximized: saved.maximized,
  };
}

/** Calls `write` at most once per `delayMs` after the last `schedule`; `flush()` writes now if pending. */
export class Debounced {
  private handle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly write: () => void,
    private readonly delayMs: number,
    private readonly timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
  ) {}

  schedule(): void {
    if (this.handle !== null) this.timers.clear(this.handle);
    this.handle = this.timers.set(() => {
      this.handle = null;
      this.write();
    }, this.delayMs);
  }

  flush(): void {
    if (this.handle === null) return;
    this.timers.clear(this.handle);
    this.handle = null;
    this.write();
  }
}
