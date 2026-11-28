import { describe, expect, it } from "vitest";
import { loadedSettings, mergeSettings, revertSettings, withoutAccountSettings } from "./settings-merge";
import type { Settings } from "./types";

const style = { size: 150, color: "yellow", textOpacity: 100, background: "none", backgroundOpacity: 75, edge: "shadow", position: 0 } as const;
const current = { uiLanguage: "en", subtitleStyle: style, subtitleStyleHdr: style } as unknown as Settings;

describe("mergeSettings", () => {
  it("drops styles the patch cleared even when the server answer leaves them out", () => {
    const saved = { uiLanguage: "en" } as Partial<Settings>;
    const next = mergeSettings(current, saved, { subtitleStyle: null, subtitleStyleHdr: null });
    expect("subtitleStyle" in next).toBe(false);
    expect("subtitleStyleHdr" in next).toBe(false);
  });

  it("keeps keys the patch did not clear", () => {
    const next = mergeSettings(current, {}, { subtitleStyleHdr: null });
    expect(next.subtitleStyle).toEqual(style);
    expect("subtitleStyleHdr" in next).toBe(false);
  });
});

describe("loadedSettings", () => {
  it("does not keep the previous account's subtitle styles when the new account has none", () => {
    const next = loadedSettings(current, { uiLanguage: "cs" } as Settings);
    expect(next.uiLanguage).toBe("cs");
    expect("subtitleStyle" in next).toBe(false);
    expect("subtitleStyleHdr" in next).toBe(false);
  });

  it("takes the styles the answer carries", () => {
    const hdr = { ...style, color: "grey" } as const;
    const next = loadedSettings(current, { uiLanguage: "en", subtitleStyleHdr: hdr } as unknown as Settings);
    expect("subtitleStyle" in next).toBe(false);
    expect(next.subtitleStyleHdr).toEqual(hdr);
  });

  it("clears the styles before an answer arrives or when none will", () => {
    const next = withoutAccountSettings(current);
    expect("subtitleStyle" in next).toBe(false);
    expect("subtitleStyleHdr" in next).toBe(false);
    expect(next.uiLanguage).toBe("en");
  });
});

describe("revertSettings", () => {
  it("puts back a style a failed reset removed", () => {
    const before = { subtitleStyleHdr: style } as Partial<Settings>;
    const failed = mergeSettings(current, {}, { subtitleStyleHdr: null });
    const next = revertSettings(failed, before, { subtitleStyleHdr: undefined }, ["subtitleStyleHdr"]);
    expect(next.subtitleStyleHdr).toEqual(style);
  });

  it("keeps a newer value that landed after the failed save", () => {
    const newer = { ...style, size: 200 } as const;
    const attempted = { ...style, size: 75 } as const;
    const latest = { ...current, subtitleStyle: newer } as unknown as Settings;
    const next = revertSettings(latest, { subtitleStyle: style } as Partial<Settings>, { subtitleStyle: attempted } as unknown as Partial<Settings>, ["subtitleStyle"]);
    expect(next.subtitleStyle).toEqual(newer);
  });
});
