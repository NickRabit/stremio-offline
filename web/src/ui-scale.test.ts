import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectiveUiScale, readUiScale, toCssPx, writeUiScale } from "./ui-scale";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("interface scale", () => {
  it("limits the chosen scale to the space available", () => {
    expect(effectiveUiScale(1.5, 1920, 1080)).toBe(1.5);
    expect(effectiveUiScale(1.5, 1280, 720)).toBe(1.12);
    expect(effectiveUiScale(1.3, 390, 844)).toBe(1);
    expect(effectiveUiScale(1, 3840, 2160)).toBe(1);
    expect(effectiveUiScale(1.15, 1100, 900)).toBe(1.07);
  });

  it("reads only a supported stored scale", () => {
    expect(readUiScale()).toBe(1);
    localStorage.setItem("ui-scale", "2");
    expect(readUiScale()).toBe(1);
    localStorage.setItem("ui-scale", "abc");
    expect(readUiScale()).toBe(1);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    expect(readUiScale()).toBe(1);
  });

  it("applies the effective zoom and removes it at the standard scale", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1920);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(1080);
    writeUiScale(1.3);
    expect(document.documentElement.style.zoom).toBe("1.3");
    expect(document.documentElement.style.getPropertyValue("--ui-scale")).toBe("1.3");
    writeUiScale(1.5);
    expect(toCssPx(300)).toBe(200);

    writeUiScale(1);
    expect(document.documentElement.style.zoom).toBe("");
    expect(document.documentElement.style.getPropertyValue("--ui-scale")).toBe("");
  });
});
