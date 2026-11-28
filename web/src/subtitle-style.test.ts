import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBTITLE_STYLE,
  SubtitleText,
  effectiveSubtitleStyle,
  subtitleStyleVars,
  type SubtitleStyle,
} from "./subtitle-style";

const style = (over: Partial<SubtitleStyle> = {}): SubtitleStyle => ({ ...DEFAULT_SUBTITLE_STYLE, ...over });
const text = (over: Partial<SubtitleStyle>) =>
  renderToStaticMarkup(createElement(SubtitleText, { text: "First\nSecond", style: style(over) }));

describe("subtitle styles", () => {
  it("returns no variables for the default", () => {
    expect(subtitleStyleVars(DEFAULT_SUBTITLE_STYLE)).toEqual({});
  });

  it("maps size and position", () => {
    expect(subtitleStyleVars(style({ size: 200 }))["--sub-scale"]).toBe("2");
    expect(subtitleStyleVars(style({ position: 15 }))["--sub-lift"])
      .toBe("calc(15 * 1dvh / var(--ui-scale, 1))");
  });

  it("maps every colour and text opacity", () => {
    const expected = {
      white: "rgba(255, 255, 255, 0.5)",
      yellow: "rgba(255, 233, 77, 0.5)",
      cyan: "rgba(92, 225, 240, 0.5)",
      green: "rgba(124, 240, 168, 0.5)",
      grey: "rgba(200, 200, 200, 0.5)",
    } as const;
    for (const [color, value] of Object.entries(expected)) {
      expect(subtitleStyleVars(style({ color: color as SubtitleStyle["color"], textOpacity: 50 }))["--sub-color"])
        .toBe(value);
    }
  });

  it("maps edges", () => {
    expect(subtitleStyleVars(style({ edge: "outline" }))["--sub-shadow"])
      .toBe("-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 3px #000");
    expect(subtitleStyleVars(style({ edge: "none" }))["--sub-shadow"]).toBe("none");
    expect(subtitleStyleVars(style({ edge: "shadow" }))).toEqual({});
  });

  it("maps each background and its opacity", () => {
    expect(subtitleStyleVars(style({ background: "box", backgroundOpacity: 25 }))["--sub-bg"])
      .toBe("rgba(0, 0, 0, 0.25)");
    expect(subtitleStyleVars(style({ background: "line", backgroundOpacity: 100 }))["--sub-bg"])
      .toBe("rgba(0, 0, 0, 1)");
    expect(subtitleStyleVars(style({ background: "none", backgroundOpacity: 25 }))).toEqual({});
  });

  it("uses HDR only when HDR is playing and a style is set", () => {
    const sdr = style({ size: 125 });
    const hdr = style({ size: 200, textOpacity: 75 });
    expect(effectiveSubtitleStyle({ subtitleStyle: sdr, subtitleStyleHdr: hdr }, true)).toBe(hdr);
    expect(effectiveSubtitleStyle({ subtitleStyle: sdr, subtitleStyleHdr: hdr }, false)).toBe(sdr);
    expect(effectiveSubtitleStyle({ subtitleStyle: sdr }, true)).toBe(sdr);
    expect(effectiveSubtitleStyle({}, false)).toBe(DEFAULT_SUBTITLE_STYLE);
  });

  it("renders plain text, a box or one background per line", () => {
    expect(text({ background: "none" })).toBe("First\nSecond");
    expect(text({ background: "box" })).toBe('<span class="player-subtitle-box">First\nSecond</span>');
    expect(text({ background: "line" }))
      .toBe('<span class="player-subtitle-line">First</span><br/><span class="player-subtitle-line">Second</span>');
  });
});
