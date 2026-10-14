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

/** Poster lists from the last preview. A repeat visit paints that fan at once instead of
 *  clearing the tile and assembling it again. Image requests still recheck the grant. */
const mosaicMemory = new Map<string, string[]>();
const decodedPosters = new Set<string>();
const brokenPosters = new Set<string>();
const MOSAIC_STORAGE = "stremio.remote-mosaic.";

const mosaicKey = (libraryId: string, parentId: string | undefined, preferChildren: boolean) =>
  `${libraryId}|${parentId ?? ""}|${preferChildren ? "c" : "o"}`;

const readMosaic = (key: string): string[] | undefined => {
  const remembered = mosaicMemory.get(key);
  if (remembered) return remembered;
  try {
    const raw = sessionStorage.getItem(MOSAIC_STORAGE + key);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) return;
    const posters = parsed as string[];
    mosaicMemory.set(key, posters);
    return posters;
  } catch {
    return;
  }
};

const writeMosaic = (key: string, posters: string[]) => {
  mosaicMemory.set(key, posters);
  try { sessionStorage.setItem(MOSAIC_STORAGE + key, JSON.stringify(posters)); } catch { /* full or unavailable */ }
};

const samePosters = (left: string[], right: string[]) =>
  left.length === right.length && left.every((url, index) => url === right[index]);

/** Drops remembered fans. Tests start from an empty page. */
export function clearRemoteMosaicCache(): void {
  mosaicMemory.clear();
  decodedPosters.clear();
  brokenPosters.clear();
  try {
    const drop: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const name = sessionStorage.key(index);
      if (name?.startsWith(MOSAIC_STORAGE)) drop.push(name);
    }
    for (const name of drop) sessionStorage.removeItem(name);
  } catch { /* unavailable */ }
}

/**
 * The posters for one tile, read once the tile is actually on screen. A fan this page already
 * showed stays up while a newer preview is in flight, and is replaced only when the answer
 * actually changed.
 */
export function useRemotePosters({ libraryId, parentId, enabled, generation }: PreviewKey, target: TileRef, preferChildren = false): { posters: string[]; pending: boolean } {
  const key = mosaicKey(libraryId, parentId, preferChildren);
  const remembered = enabled ? readMosaic(key) : undefined;
  const [posters, setPosters] = useState<string[]>(remembered ?? []);
  const [pending, setPending] = useState(enabled && !remembered);
  useEffect(() => {
    if (!enabled) {
      setPosters([]);
      setPending(false);
      return;
    }
    if (!readMosaic(key)) {
      setPosters([]);
      setPending(true);
    }
    const controller = new AbortController();
    let live = true;
    const load = () => {
      void withPreviewSlot(() => {
        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        return api.remotePreview(libraryId, parentId, controller.signal, preferChildren);
      })
        .then((answer) => {
          if (!live) return;
          writeMosaic(key, answer.posters);
          setPosters((current) => samePosters(current, answer.posters) ? current : answer.posters);
          setPending(false);
        })
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
  }, [key, libraryId, parentId, enabled, generation, preferChildren]);
  return { posters, pending };
}

/** The fan of posters the local library tile already draws. It stays hidden until every poster
 *  has arrived or failed, so the tile does not fill in one picture at a time. A poster that
 *  already failed stays hidden on the next paint. */
function LibraryCollage({ posters }: { posters: string[] }) {
  const signature = posters.join("\0");
  const [shown, setShown] = useState(signature);
  const [waiting, setWaiting] = useState(() => posters.some((url) => !decodedPosters.has(url)));
  if (shown !== signature) {
    setShown(signature);
    setWaiting(posters.some((url) => !decodedPosters.has(url)));
  }
  const settle = (url: string) => {
    if (decodedPosters.has(url)) return;
    decodedPosters.add(url);
    setWaiting(posters.some((item) => !decodedPosters.has(item)));
  };
  return <span className={`library-preview-collage${waiting ? " is-pending" : ""}`} aria-hidden="true">
    {posters.map((url) => <img key={url} src={url} alt="" decoding="async"
      className={brokenPosters.has(url) ? "broken" : undefined}
      ref={(node) => { if (node?.complete && node.naturalWidth > 0) settle(url); }}
      onLoad={() => settle(url)}
      onError={(event) => { brokenPosters.add(url); hideBroken(event); settle(url); }}/>)}
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
