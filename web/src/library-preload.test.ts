import { describe, expect, it } from "vitest";
import { posterUrls, preloadLibraryPosters } from "./library-preload";
import type { BrowseItem } from "./types";

const folder = (path: string, poster?: string, posters?: string[]): BrowseItem => ({
  kind: "folder", path, name: path, fileCount: 1, size: 0,
  ...(poster !== undefined ? { poster } : {}),
  ...(posters ? { posters } : {}),
});

describe("posterUrls", () => {
  it("selects at most twenty distinct pictures", () => {
    const items = Array.from({ length: 30 }, (_, index) => folder(`f${index}`, `p${index}.jpg`));
    const urls = posterUrls(items);
    expect(urls).toHaveLength(20);
    expect(new Set(urls).size).toBe(20);
  });

  it("ignores duplicates and rows without a picture", () => {
    const urls = posterUrls([folder("a", "x.jpg"), folder("b", "x.jpg"), folder("c"), folder("d", "", ["y.jpg", "y.jpg"])]);
    expect(urls).toEqual(["x.jpg", "y.jpg"]);
  });

  it("takes a mosaic's own tiles before the folder picture", () => {
    expect(posterUrls([folder("c", "own.jpg", ["m1.jpg", "m2.jpg"])])).toEqual(["m1.jpg", "m2.jpg", "own.jpg"]);
  });
});

describe("preloadLibraryPosters", () => {
  it("loads every selected picture with at most four at once", async () => {
    const items = Array.from({ length: 20 }, (_, index) => folder(`f${index}`, `p${index}.jpg`));
    const started: string[] = [];
    let active = 0;
    let peak = 0;
    const load = (url: string) => new Promise<void>((resolve) => {
      started.push(url);
      active += 1;
      peak = Math.max(peak, active);
      setTimeout(() => { active -= 1; resolve(); }, 0);
    });
    await preloadLibraryPosters(items, { load });
    expect(started).toHaveLength(20);
    expect(peak).toBe(4);
  });

  it("starts nothing when the rows hold no picture", async () => {
    let calls = 0;
    await preloadLibraryPosters([folder("a"), folder("b")], { load: async () => { calls += 1; } });
    expect(calls).toBe(0);
  });

  it("stops queued pictures once the preload is aborted", async () => {
    const items = Array.from({ length: 20 }, (_, index) => folder(`f${index}`, `p${index}.jpg`));
    const started: string[] = [];
    const pending: Array<() => void> = [];
    const load = (url: string) => {
      started.push(url);
      return new Promise<void>((resolve) => pending.push(resolve));
    };
    const controller = new AbortController();
    const done = preloadLibraryPosters(items, { load, signal: controller.signal });
    controller.abort();
    for (const resolve of pending) resolve();
    await done;
    expect(started).toHaveLength(4);
  });
});
