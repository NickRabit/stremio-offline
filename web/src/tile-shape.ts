import type { TileShape } from "./types";

export type TileFit = "cover" | "contain";
export interface TileArtChoice { url?: string; fit: TileFit }

const present = (value?: string) => (value && value.trim() ? value : undefined);

/**
 * Which of a title's two pictures a tile of this shape draws, and how it sits in the frame.
 * The wanted one fills it. The other is letterboxed rather than cropped: a portrait poster
 * cut to 16:9 loses two thirds of its height, which takes the face and the title with it.
 */
export function pickTileArt(shape: TileShape, poster?: string, wide?: string): TileArtChoice {
  const [wanted, other] = shape === "wide" ? [present(wide), present(poster)] : [present(poster), present(wide)];
  if (wanted) return { url: wanted, fit: "cover" };
  if (other) return { url: other, fit: "contain" };
  return { fit: "cover" };
}
