import { useEffect, useState, type ReactNode, type SyntheticEvent } from "react";
import { fitFor, pickTileArt, type TileFit } from "./tile-shape";
import type { TileShape } from "./types";

const hideBroken = (event: SyntheticEvent<HTMLImageElement>) => event.currentTarget.classList.add("broken");

/** A folder that stands for several films: their posters as one small mosaic instead of a
 *  single picture. Fewer than two posters is not a mosaic, and the caller falls back to the
 *  folder's own artwork. `label` names it for a screen reader; the folder name stays beside it. */
export function PosterMosaic({ posters, label }: { posters: string[]; label: string }) {
  if (posters.length < 2) return null;
  return <span className="library-preview-collage" role="img" aria-label={label}>
    {posters.map((poster) => <img key={poster} src={poster} alt="" loading="lazy" onError={hideBroken}/>)}
  </span>;
}

/**
 * A tile's picture. The one the shape asked for fills the frame; the other is drawn to fit,
 * over a blurred copy of itself, so a portrait poster in a landscape frame is letterboxed
 * instead of losing two thirds of its height to the crop.
 *
 * Which of the two it turns out to be is settled by the loaded picture, not by the name the
 * catalogue filed it under: an addon that calls a 16:9 picture a poster is common enough that
 * trusting the label crops half its titles to a sliver.
 */
export function TileArt({ shape, poster, wide, fallback }: {
  shape: TileShape;
  poster?: string;
  wide?: string;
  /** Drawn when the title has neither picture. */
  fallback: ReactNode;
}) {
  const { url, fit } = pickTileArt(shape, poster, wide);
  const [measured, setMeasured] = useState<TileFit>();
  useEffect(() => setMeasured(undefined), [url]);
  const onLoad = (event: SyntheticEvent<HTMLImageElement>) =>
    setMeasured(fitFor(shape, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight));
  if (!url) return <>{fallback}</>;
  if ((measured ?? fit) === "cover") return <img src={url} alt="" loading="lazy" onLoad={onLoad} onError={hideBroken}/>;
  return <>
    <img className="tile-blur" src={url} alt="" aria-hidden="true" loading="lazy"/>
    <img className="tile-fit" src={url} alt="" loading="lazy" onLoad={onLoad} onError={hideBroken}/>
  </>;
}
