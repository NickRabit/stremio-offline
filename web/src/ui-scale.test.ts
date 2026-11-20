import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectiveUiScale, readUiScale, toCssPx, viewportConditions, writeUiScale } from "./ui-scale";

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
    // 1.15 * 100 is 114.99999999999999 in floating point; the floor must not eat the choice.
    expect(effectiveUiScale(1.15, 1920, 1080)).toBe(1.15);
    expect(effectiveUiScale(1.3, 1920, 1080)).toBe(1.3);
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

  it("keeps the control that changed the scale where it was on screen", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1920);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(1080);
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    const anchor = document.createElement("select");
    // The row sat 400 px down the screen; at 150 % the document grows and pushes it to 2515.
    vi.spyOn(anchor, "getBoundingClientRect")
      .mockReturnValueOnce({ top: 400 } as DOMRect)
      .mockReturnValueOnce({ top: 2515 } as DOMRect);
    writeUiScale(1.5, anchor);
    expect(scrollBy).toHaveBeenCalledWith(0, 2115);

    scrollBy.mockClear();
    writeUiScale(1);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("evaluates the old media conditions on the space left after zooming", () => {
    // A roomy desktop window at the standard size.
    expect(viewportConditions(1920, 1080)).toEqual(["wide-1100", "wide-1920"]);
    // The same window at 150 % holds 1280x720 of layout, so it compacts like that window would.
    expect(viewportConditions(1280, 720)).toEqual(["wide-short", "catalog-tight", "catalog-compact", "narrow-1300", "wide-1100", "short-880"]);
    expect(viewportConditions(1024, 640)).toContain("landscape-short");
    expect(viewportConditions(390, 844)).toEqual(["narrow-1300", "short-880"]);
  });

  it("marks the root with the conditions of the zoomed space", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1920);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(1080);
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(1080);
    writeUiScale(1);
    expect(document.documentElement.dataset.viewport).toBe("wide-1100 wide-1920");
    writeUiScale(1.5);
    expect(document.documentElement.dataset.viewport?.split(" ")).toContain("catalog-compact");
    expect(document.documentElement.dataset.viewport?.split(" ")).not.toContain("wide-1920");
  });
});
