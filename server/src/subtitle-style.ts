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

export function normalizeSubtitleStyle(value: unknown): SubtitleStyle | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const source = value as Record<string, unknown>;
  const supported = <T extends string | number>(values: readonly T[], field: unknown, fallback: T): T =>
    values.includes(field as T) ? field as T : fallback;
  return {
    size: supported(SUBTITLE_SIZES, source.size, DEFAULT_SUBTITLE_STYLE.size),
    color: supported(SUBTITLE_COLORS, source.color, DEFAULT_SUBTITLE_STYLE.color),
    textOpacity: supported(SUBTITLE_TEXT_OPACITIES, source.textOpacity, DEFAULT_SUBTITLE_STYLE.textOpacity),
    background: supported(SUBTITLE_BACKGROUNDS, source.background, DEFAULT_SUBTITLE_STYLE.background),
    backgroundOpacity: supported(SUBTITLE_BACKGROUND_OPACITIES, source.backgroundOpacity, DEFAULT_SUBTITLE_STYLE.backgroundOpacity),
    edge: supported(SUBTITLE_EDGES, source.edge, DEFAULT_SUBTITLE_STYLE.edge),
    position: supported(SUBTITLE_POSITIONS, source.position, DEFAULT_SUBTITLE_STYLE.position),
  };
}

/** The exact shape a client must send: the seven known fields, each a supported value. */
export function isSubtitleStyle(value: unknown): value is SubtitleStyle {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  return keys.length === 7
    && (SUBTITLE_SIZES as readonly unknown[]).includes(source.size)
    && (SUBTITLE_COLORS as readonly unknown[]).includes(source.color)
    && (SUBTITLE_TEXT_OPACITIES as readonly unknown[]).includes(source.textOpacity)
    && (SUBTITLE_BACKGROUNDS as readonly unknown[]).includes(source.background)
    && (SUBTITLE_BACKGROUND_OPACITIES as readonly unknown[]).includes(source.backgroundOpacity)
    && (SUBTITLE_EDGES as readonly unknown[]).includes(source.edge)
    && (SUBTITLE_POSITIONS as readonly unknown[]).includes(source.position);
}

export const isDefaultSubtitleStyle = (style: SubtitleStyle): boolean =>
  (Object.keys(DEFAULT_SUBTITLE_STYLE) as (keyof SubtitleStyle)[]).every((key) => style[key] === DEFAULT_SUBTITLE_STYLE[key]);
