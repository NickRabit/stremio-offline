import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clampVolume, readVolume, writeVolume } from "./player-volume";

/** jsdom hands out no working storage for its default opaque origin, so the test brings its own. */
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

afterEach(() => vi.unstubAllGlobals());

describe("the player's volume", () => {
  it("starts at full for a device that has never been set", () => {
    expect(readVolume()).toBe(1);
  });

  it("comes back as it was left", () => {
    writeVolume(0.4);
    expect(readVolume()).toBe(0.4);
    writeVolume(0);
    expect(readVolume(), "silence is a choice like any other").toBe(0);
  });

  it("keeps a stored value inside what an element can hold", () => {
    expect(clampVolume(1.5)).toBe(1);
    expect(clampVolume(-2)).toBe(0);
    expect(clampVolume(0.35)).toBe(0.35);
    // A hand-edited or corrupt value is not a reason to blow up, or to go silent.
    expect(clampVolume(Number.NaN)).toBe(1);
    stored.set("player-volume", "loud");
    expect(readVolume()).toBe(1);
    stored.set("player-volume", "2");
    expect(readVolume()).toBe(1);
    stored.set("player-volume", "");
    expect(readVolume()).toBe(1);
  });

  it("survives storage that refuses to work", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    });
    expect(readVolume()).toBe(1);
    expect(() => writeVolume(0.5)).not.toThrow();
  });
});
