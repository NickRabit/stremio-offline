import { useEffect, useState, type RefObject } from "react";
import { HardDrive, FolderOpen } from "lucide-react";
import { api } from "./api";
import { hideBroken } from "./settings-ui";
import { TileArt } from "./TileArt";
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
export function useRemotePosters({ libraryId, parentId, enabled, generation }: PreviewKey, target: TileRef, preferChildren = false): { posters: string[]; pending: boolean } {
  const [posters, setPosters] = useState<string[]>([]);
  const [pending, setPending] = useState(enabled);
  useEffect(() => {
    if (!enabled) {
      setPosters([]);
      setPending(false);
      return;
    }
    setPosters([]);
    setPending(true);
    const controller = new AbortController();
    let live = true;
    const load = () => {
      void withPreviewSlot(() => {
        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        return api.remotePreview(libraryId, parentId, controller.signal, preferChildren);
      })
        .then((answer) => { if (live) { setPosters(answer.posters); setPending(false); } })
        .catch(() => { if (live) setPending(false); });
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
  }, [libraryId, parentId, enabled, generation, preferChildren]);
  return { posters, pending };
}

/** The fan of posters the local library tile already draws, reused for a remote root so the two
 *  roots look alike. Broken posters drop out; the container underneath stays. */
function LibraryCollage({ posters }: { posters: string[] }) {
  return <span className="library-preview-collage" aria-hidden="true">
    {posters.map((url) => <img key={url} src={url} alt="" loading="lazy" onError={hideBroken}/>)}
  </span>;
}

/** A remote root library's picture: a collage of its films, one film, the library's own poster or
 *  the drive icon. The own poster is not drawn while the child preview is still coming: that
 *  first picture uses a different frame, and replacing it with the fan reshuffles the tile.
 *  With mosaics off the own poster is drawn as it is. */
export function RemoteLibraryArt(props: PreviewKey & { target: TileRef; poster?: string }) {
  const { target, poster, ...key } = props;
  const { posters, pending } = useRemotePosters(key, target, true);
  if (key.enabled && pending) return null;
  if (posters.length > 1) return <LibraryCollage posters={posters}/>;
  return <TileArt shape="poster" poster={key.enabled ? posters[0] ?? poster : poster} fallback={<HardDrive/>}/>;
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

/** A remote folder's picture: the artwork the folder already carries, or the same fan the local
 *  folder tile draws, or the folder icon. A folder with a poster draws it and asks for no
 *  preview, and a single preview poster stays a single picture rather than a collage. A poster
 *  that fails stays in its slot, so the fan does not collapse into a different frame. */
export function RemoteFolderArt({ shape, poster, wide, ...picture }: PreviewKey & { target: TileRef; shape: TileShape; poster?: string; wide?: string }) {
  const { target, ...key } = picture;
  const ask = key.enabled && !poster;
  const { posters, pending } = useRemotePosters({ ...key, enabled: ask }, target);
  if (posters.length > 1) return <LibraryCollage posters={posters}/>;
  if (ask && pending) return <RemoteTileArt target={target} shape={shape} fallback={<FolderOpen/>}/>;
  return <RemoteTileArt target={target} shape={shape} poster={poster ?? posters[0]} wide={wide} fallback={<FolderOpen/>}/>;
}
