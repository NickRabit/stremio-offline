import { useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { remoteTileArtwork } from "./remote-artwork";
import { fitFor, pickTileArt, type TileFit } from "./tile-shape";
import type { TileShape } from "./types";

export const KNOWN_SIZE_LIMIT = 1000;
// A picture's real size, by address: a tile drawn again -- or in the other shape -- already knows
// how its picture sits, with no load event and no refit after it.
const knownSize = new Map<string, { width: number; height: number }>();

function rememberSize(url: string, width: number, height: number): void {
  knownSize.delete(url);
  knownSize.set(url, { width, height });
  if (knownSize.size <= KNOWN_SIZE_LIMIT) return;
  const oldest = knownSize.keys().next().value;
  if (oldest !== undefined) knownSize.delete(oldest);
}

export function forgetKnownSizes(): void {
  knownSize.clear();
}


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
export function TileArt({ shape, poster, wide, fallback, eager = false }: {
  shape: TileShape;
  poster?: string;
  wide?: string;
  /** Drawn when the title has neither picture. */
  fallback: ReactNode;
  eager?: boolean;
}) {
  const identity = JSON.stringify([poster, wide]);
  const [failure, setFailure] = useState({ identity, urls: [] as string[] });
  const failed = failure.identity === identity ? failure.urls : [];
  // A tile draws the listing width of the wide picture, so that is the address whose failure it
  // remembers; `pickTileArt` narrows the same way, and narrowing twice is the same address.
  const tiled = remoteTileArtwork(wide);
  const { url, fit } = pickTileArt(shape, failed.includes(poster ?? "") ? undefined : poster, failed.includes(tiled ?? "") ? undefined : wide);
  // Bumped only when a load changes how the picture sits. The size is kept here as well as in
  // knownSize, so a tile on screen keeps it after the shared memory has let it go.
  const [, setRefit] = useState(0);
  const own = useRef<{ url: string; width: number; height: number } | undefined>(undefined);
  const size = url ? knownSize.get(url) ?? (own.current?.url === url ? own.current : undefined) : undefined;
  const effectiveFit: TileFit = size ? fitFor(shape, size.width, size.height) : fit;
  const onLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    if (!url) return;
    const width = event.currentTarget.naturalWidth;
    const height = event.currentTarget.naturalHeight;
    rememberSize(url, width, height);
    own.current = { url, width, height };
    if (fitFor(shape, width, height) !== effectiveFit) setRefit((count) => count + 1);
  };
  const onError = () => {
    if (url) setFailure((previous) => ({ identity, urls: [...(previous.identity === identity ? previous.urls : []), url] }));
  };
  if (!url) return <>{fallback}</>;
  const loading = eager ? "eager" : "lazy";
  return <>
    {effectiveFit === "contain" && <img key={`blur:${url}`} className="tile-blur" src={url} alt="" aria-hidden="true" loading={loading} decoding="async"/>}
    <img key={url} className={effectiveFit === "contain" ? "tile-fit" : undefined} src={url} alt="" loading={loading} decoding="async" onLoad={onLoad} onError={onError}/>
  </>;
}
