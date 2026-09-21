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

/** How far from square a picture has to be before its own proportions overrule the label the
 *  catalogue gave it. The same ratio the server stores artwork by. */
const SHAPE_RATIO = 1.15;

/**
 * How a picture sits in the frame once its real proportions are known. A catalogue that hands
 * out a landscape picture under `poster` -- and there are addons that do -- would otherwise
 * have it cropped to a sliver, and a different picture would appear in the library than the
 * one the catalogue showed. A near-square picture fills the frame as before.
 */
export function fitFor(shape: TileShape, width: number, height: number): TileFit {
  if (!width || !height) return "cover";
  const real = width >= height * SHAPE_RATIO ? "wide" : height >= width * SHAPE_RATIO ? "poster" : shape;
  return real === shape ? "cover" : "contain";
}
