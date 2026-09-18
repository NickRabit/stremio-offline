import type { ReactNode, SyntheticEvent } from "react";
import { pickTileArt } from "./tile-shape";
import type { TileShape } from "./types";

const hideBroken = (event: SyntheticEvent<HTMLImageElement>) => event.currentTarget.classList.add("broken");

/**
 * A tile's picture. The one the shape asked for fills the frame; the other is drawn to fit,
 * over a blurred copy of itself, so a portrait poster in a landscape frame is letterboxed
 * instead of losing two thirds of its height to the crop.
 */
export function TileArt({ shape, poster, wide, fallback }: {
  shape: TileShape;
  poster?: string;
  wide?: string;
  /** Drawn when the title has neither picture. */
  fallback: ReactNode;
}) {
  const { url, fit } = pickTileArt(shape, poster, wide);
  if (!url) return <>{fallback}</>;
  if (fit === "cover") return <img src={url} alt="" loading="lazy" onError={hideBroken}/>;
  return <>
    <img className="tile-blur" src={url} alt="" aria-hidden="true" loading="lazy"/>
    <img className="tile-fit" src={url} alt="" loading="lazy" onError={hideBroken}/>
  </>;
}
