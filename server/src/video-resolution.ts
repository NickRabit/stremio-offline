export const RESOLUTION_CLASSES = [2160, 1440, 1080, 720, 576, 480, 360] as const;

export function videoResolutionClass(
  width: number | undefined,
  height: number | undefined,
): number | undefined {
  const knownWidth = typeof width === "number" && Number.isFinite(width) && width > 0
    ? width
    : 0;
  const knownHeight = typeof height === "number" && Number.isFinite(height) && height > 0
    ? height
    : 0;
  if (knownWidth === 0 && knownHeight === 0) return undefined;

  const lines = Math.max(knownHeight, knownWidth * 9 / 16);
  return RESOLUTION_CLASSES.find((resolutionClass) => lines >= resolutionClass * 0.9)
    ?? Math.round(lines);
}
