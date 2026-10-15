import { useState, type ReactNode, type SyntheticEvent } from "react";
import { remoteTileArtwork } from "./remote-artwork";
import { fitFor, pickTileArt, type TileFit } from "./tile-shape";
import type { TileShape } from "./types";



/** A folder that stands for several films: their posters as one small mosaic instead of a
 *  single picture. Fewer than two posters is not a mosaic, and the caller falls back to the
 *  folder's own artwork. `label` names it for a screen reader; the folder name stays beside it. */
export function PosterMosaic({ posters, label, fallback = null }: { posters: string[]; label: string; fallback?: ReactNode }) {
  const identity = JSON.stringify(posters);
  const [failure, setFailure] = useState({ identity, urls: [] as string[] });
  const failed = failure.identity === identity ? failure.urls : [];
  const available = posters.filter((url) => !failed.includes(url));
  if (posters.length < 2) return null;
  if (!available.length) return <>{fallback}</>;
  const onError = (url: string) => setFailure((previous) => ({ identity, urls: [...(previous.identity === identity ? previous.urls : []), url] }));
  if (available.length === 1) return <img key={available[0]} src={available[0]} alt="" loading="lazy" onError={() => onError(available[0])}/>;
  return <span className="library-preview-collage" role="img" aria-label={label}>
    {available.map((poster) => <img key={poster} src={poster} alt="" loading="lazy" onError={() => onError(poster)}/>)}
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
  const identity = JSON.stringify([poster, wide]);
  const [failure, setFailure] = useState({ identity, urls: [] as string[] });
  const failed = failure.identity === identity ? failure.urls : [];
  // A tile draws the listing width of the wide picture, so that is the address whose failure it
  // remembers; `pickTileArt` narrows the same way, and narrowing twice is the same address.
  const tiled = remoteTileArtwork(wide);
  const { url, fit } = pickTileArt(shape, failed.includes(poster ?? "") ? undefined : poster, failed.includes(tiled ?? "") ? undefined : wide);
  const [measured, setMeasured] = useState<{ url: string; width: number; height: number }>();
  const onLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    if (url) setMeasured({ url, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
  };
  const onError = () => {
    if (url) setFailure((previous) => ({ identity, urls: [...(previous.identity === identity ? previous.urls : []), url] }));
  };
  if (!url) return <>{fallback}</>;
  const effectiveFit: TileFit = measured?.url === url ? fitFor(shape, measured.width, measured.height) : fit;
  return <>
    {effectiveFit === "contain" && <img key={`blur:${url}`} className="tile-blur" src={url} alt="" aria-hidden="true" loading="lazy"/>}
    <img key={url} className={effectiveFit === "contain" ? "tile-fit" : undefined} src={url} alt="" loading="lazy" onLoad={onLoad} onError={onError}/>
  </>;
}
