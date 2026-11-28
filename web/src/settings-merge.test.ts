import { describe, expect, it } from "vitest";
import { mergeSettings } from "./settings-merge";
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
