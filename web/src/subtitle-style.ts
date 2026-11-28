import { createElement, Fragment } from "react";

export const SUBTITLE_SIZES = [75, 100, 125, 150, 200] as const;
export const SUBTITLE_COLORS = ["white", "yellow", "cyan", "green", "grey"] as const;
export const SUBTITLE_TEXT_OPACITIES = [100, 75, 50] as const;
export const SUBTITLE_BACKGROUNDS = ["none", "box", "line"] as const;
export const SUBTITLE_BACKGROUND_OPACITIES = [25, 50, 75, 100] as const;
export const SUBTITLE_EDGES = ["shadow", "outline", "none"] as const;
export const SUBTITLE_POSITIONS = [0, 5, 10, 15, 20] as const;

export interface SubtitleStyle {
  size: typeof SUBTITLE_SIZES[number];
  color: typeof SUBTITLE_COLORS[number];
  textOpacity: typeof SUBTITLE_TEXT_OPACITIES[number];
  background: typeof SUBTITLE_BACKGROUNDS[number];
  backgroundOpacity: typeof SUBTITLE_BACKGROUND_OPACITIES[number];
  edge: typeof SUBTITLE_EDGES[number];
  position: typeof SUBTITLE_POSITIONS[number];
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  size: 100,
  color: "white",
  textOpacity: 100,
  background: "none",
  backgroundOpacity: 75,
  edge: "shadow",
  position: 0,
};

const COLOR_RGB: Record<SubtitleStyle["color"], [number, number, number]> = {
  white: [255, 255, 255],
  yellow: [255, 233, 77],
  cyan: [92, 225, 240],
  green: [124, 240, 168],
  grey: [200, 200, 200],
};

export function effectiveSubtitleStyle(
  settings: { subtitleStyle?: SubtitleStyle; subtitleStyleHdr?: SubtitleStyle },
  hdr: boolean,
): SubtitleStyle {
  return hdr && settings.subtitleStyleHdr
    ? settings.subtitleStyleHdr
    : settings.subtitleStyle ?? DEFAULT_SUBTITLE_STYLE;
}

export function subtitleStyleVars(style: SubtitleStyle): Record<string, string> {
  const vars: Record<string, string> = {};
  if (style.size !== DEFAULT_SUBTITLE_STYLE.size) vars["--sub-scale"] = String(style.size / 100);
  if (style.color !== DEFAULT_SUBTITLE_STYLE.color || style.textOpacity !== DEFAULT_SUBTITLE_STYLE.textOpacity) {
    const [red, green, blue] = COLOR_RGB[style.color];
    vars["--sub-color"] = `rgba(${red}, ${green}, ${blue}, ${style.textOpacity / 100})`;
  }
  if (style.edge === "outline") {
    vars["--sub-shadow"] = "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 3px #000";
  } else if (style.edge === "none") {
    vars["--sub-shadow"] = "none";
  }
  if (style.background !== "none") {
    vars["--sub-bg"] = `rgba(0, 0, 0, ${style.backgroundOpacity / 100})`;
  }
  if (style.position > 0) {
    vars["--sub-lift"] = `calc(${style.position} * 1dvh / var(--ui-scale, 1))`;
  }
  return vars;
}

export function SubtitleText({ text, style }: { text: string; style: SubtitleStyle }) {
  if (style.background === "none") return text;
  if (style.background === "box") return createElement("span", { className: "player-subtitle-box" }, text);
  return createElement(Fragment, null, ...text.split("\n").flatMap((line, index) => [
    index > 0 ? createElement("br", { key: `br-${index}` }) : null,
    createElement("span", { key: index, className: "player-subtitle-line" }, line),
  ]));
}
