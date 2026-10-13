import { useEffect, useState, type RefObject } from "react";
import { HardDrive, FolderOpen } from "lucide-react";
import { api } from "./api";
import { t } from "./i18n";
import { PosterMosaic, TileArt } from "./TileArt";
import type { TileShape } from "./types";

/** Transfer an occupied slot directly to the next waiter so queued previews cannot exceed two. */
const PREVIEW_CONCURRENCY = 2;
let previewActive = 0;
const previewQueue: Array<() => void> = [];
const withPreviewSlot = async <T,>(task: () => Promise<T>): Promise<T> => {
  await new Promise<void>((resolve) => {
    if (previewActive < PREVIEW_CONCURRENCY) { previewActive += 1; resolve(); }
    else previewQueue.push(resolve);
  });
  try { return await task(); }
  finally {
    const next = previewQueue.shift();
    if (next) next();
    else previewActive -= 1;
  }
};

/** Everything the effect needs to know when a tile or a library changed. */
export interface PreviewKey {
  libraryId: string;
  parentId?: string;
  /** Mosaics off means the library issues no preview request at all. */
  enabled: boolean;
  /** Bumped whenever the listing is rebuilt, so a stale mosaic never survives a refresh. */
  generation: number;
}

type TileRef = RefObject<HTMLElement | null>;

/**
 * The posters for one tile, read once the tile is actually on screen. The observer disconnects
 * after the first request, and the component keeps its answer until it unmounts or its key
 * changes -- so the cache lives no longer than the authorized listing that drew it.
 */
export function useRemotePosters({ libraryId, parentId, enabled, generation }: PreviewKey, target: TileRef): string[] {
  const [posters, setPosters] = useState<string[]>([]);
  useEffect(() => {
    setPosters([]);
    if (!enabled) return;
    const controller = new AbortController();
    let live = true;
    const load = () => {
      void withPreviewSlot(() => {
        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        return api.remotePreview(libraryId, parentId, controller.signal);
      })
        .then((answer) => { if (live) setPosters(answer.posters); })
        .catch(() => undefined);
    };
    const element = target.current;
    // No observer (an old browser or a test without one): read straight away rather than never.
    if (typeof IntersectionObserver === "undefined" || !element) { load(); return () => { live = false; controller.abort(); }; }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      load();
    });
    observer.observe(element);
    return () => { live = false; observer.disconnect(); controller.abort(); };
  }, [libraryId, parentId, enabled, generation]);
  return posters;
}

/** A remote root library's picture: the library's own poster when it has one, a collage of its
 *  first films, one film, or the drive icon. A library that carries its own poster asks for no
 *  child mosaic at all; a missing one keeps the bounded, visibility-gated preview. */
export function RemoteLibraryArt(props: PreviewKey & { target: TileRef; poster?: string }) {
  const { target, poster, ...key } = props;
  const posters = useRemotePosters({ ...key, enabled: key.enabled && !poster }, target);
  if (poster) return <TileArt shape="poster" poster={poster} fallback={<HardDrive/>}/>;
  if (posters.length > 1) return <PosterMosaic posters={posters} label={t("library.mosaicAlt", { count: posters.length })} fallback={<HardDrive/>}/>;
  return <TileArt shape="poster" poster={posters[0]} fallback={<HardDrive/>}/>;
}

/** A remote folder's picture: the same mosaic the local folder tile draws, or the ordinary
 *  artwork the folder carries, or the folder icon. */
export function RemoteTileArt({ target, ...props }: Parameters<typeof TileArt>[0] & { target: TileRef }) {
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (visible) return;
    const element = target.current;
    if (!element || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      setVisible(true);
    }, { rootMargin: "100px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [target, visible]);
  return visible ? <TileArt {...props}/> : <>{props.fallback}</>;
}

/** A remote folder's picture: the artwork the folder already carries, or the local folder tile's
 *  mosaic, or the folder icon. A folder with a poster draws it and asks for no preview, and a
 *  single preview poster stays a single picture rather than a collage. */
export function RemoteFolderArt({ shape, poster, wide, ...picture }: PreviewKey & { target: TileRef; shape: TileShape; poster?: string; wide?: string }) {
  const { target, ...key } = picture;
  const posters = useRemotePosters({ ...key, enabled: key.enabled && !poster }, target);
  if (posters.length > 1) return <PosterMosaic posters={posters} label={t("library.mosaicAlt", { count: posters.length })} fallback={<RemoteTileArt target={target} shape={shape} poster={poster} wide={wide} fallback={<FolderOpen/>}/>}/>;
  return <RemoteTileArt target={target} shape={shape} poster={poster ?? posters[0]} wide={wide} fallback={<FolderOpen/>}/>;
}
