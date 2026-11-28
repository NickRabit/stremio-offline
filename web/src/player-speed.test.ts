import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCatalog, setLocale } from "./i18n";
import { applySpeed, formatSpeed, parseSpeed, readSpeed, SPEEDS, stepSpeed, writeSpeed } from "./player-speed";

const stored = new Map<string, string>();
const memoryStorage = (): Storage => ({
  get length() { return stored.size; },
  clear: () => stored.clear(),
  getItem: (key: string) => stored.get(key) ?? null,
  key: (index: number) => [...stored.keys()][index] ?? null,
  removeItem: (key: string) => { stored.delete(key); },
  setItem: (key: string, value: string) => { stored.set(key, String(value)); },
});

beforeEach(() => {
  stored.clear();
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  setLocale("en");
  vi.unstubAllGlobals();
});

describe("player speed", () => {
  it("accepts every supported speed and falls back to normal", () => {
    for (const speed of SPEEDS) expect(parseSpeed(speed)).toBe(speed);
    for (const value of [null, "", "abc", Number.NaN, 3, 0.6]) expect(parseSpeed(value)).toBe(1);
  });

  it("remembers the chosen speed and survives broken storage", () => {
    writeSpeed(1.75);
    expect(readSpeed()).toBe(1.75);
    stored.set("player-speed", "1.5");
    expect(readSpeed()).toBe(1.5);

    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    });
    expect(readSpeed()).toBe(1);
    expect(() => writeSpeed(0.5)).not.toThrow();
  });

  it("steps through the supported speeds and clamps at both ends", () => {
    expect(stepSpeed(0.5, -1)).toBe(0.5);
    expect(stepSpeed(0.5, 1)).toBe(0.75);
    expect(stepSpeed(1.25, -1)).toBe(1);
    expect(stepSpeed(2, 1)).toBe(2);
  });

  it("sets both rates and preserves pitch", () => {
    const video = {
      defaultPlaybackRate: 1, playbackRate: 1, preservesPitch: false,
    } as HTMLVideoElement;
    applySpeed(video, 1.5);
    expect(video.defaultPlaybackRate).toBe(1.5);
    expect(video.playbackRate).toBe(1.5);
    expect(video.preservesPitch).toBe(true);
    expect("webkitPreservesPitch" in video).toBe(false);

    const webkitVideo = {
      defaultPlaybackRate: 1, playbackRate: 1.5, preservesPitch: false, webkitPreservesPitch: false,
    } as HTMLVideoElement & { webkitPreservesPitch: boolean };
    applySpeed(webkitVideo, 1.5);
    expect(webkitVideo.defaultPlaybackRate).toBe(1.5);
    expect(webkitVideo.playbackRate).toBe(1.5);
    expect(webkitVideo.preservesPitch).toBe(true);
    expect(webkitVideo.webkitPreservesPitch).toBe(true);
  });

  it("formats speeds with the active locale", async () => {
    setLocale("en");
    expect(formatSpeed(1.5)).toBe("1.5×");
    await loadCatalog("cs");
    setLocale("cs");
    expect(formatSpeed(1.5)).toBe("1,5×");
  });
});
