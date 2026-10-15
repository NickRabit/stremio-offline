import { useEffect, useRef, useState, type RefObject } from "react";
import { HardDrive, FolderOpen } from "lucide-react";
import { api } from "./api";
import { remoteMosaicArtwork } from "./remote-artwork";
import { TileArt } from "./TileArt";
import type { TileShape } from "./types";

/** How many tiles ask the server at once. A tile asks only once it is on screen, and a grid of
 *  folders must not open a dozen requests, let alone a dozen compositions, at the same moment. */
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
  /** Mosaics off means the tile issues no preview request at all. */
  enabled: boolean;
  /** Bumped whenever the listing is rebuilt, so a stale fan never survives a refresh. */
  generation: number;
}

type TileRef = RefObject<HTMLElement | null>;

/** The picture the last answer named. A repeat visit paints it while the next answer is on its
 *  way, instead of showing the folder's own frame and then swapping it. */
const mosaicMemory = new Map<string, string>();
const MOSAIC_STORAGE = "stremio.remote-mosaic.";

const mosaicKey = (libraryId: string, parentId: string | undefined, preferChildren: boolean) =>
  `${libraryId}|${parentId ?? ""}|${preferChildren ? "c" : "o"}`;

const readMosaic = (key: string): string | undefined => {
  const remembered = mosaicMemory.get(key);
  if (remembered) return remembered;
  try {
    const raw = sessionStorage.getItem(MOSAIC_STORAGE + key);
    if (!raw) return;
    // An entry written before the server composed fans is a list of posters; the first of them
    // is the picture that stood for the folder then.
    const parsed = JSON.parse(raw) as unknown;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (typeof first !== "string" || !first) return;
    mosaicMemory.set(key, first);
    return first;
  } catch {
    return;
  }
};

const writeMosaic = (key: string, picture: string) => {
  mosaicMemory.set(key, picture);
  try { sessionStorage.setItem(MOSAIC_STORAGE + key, JSON.stringify(picture)); } catch { /* full or unavailable */ }
};

/** Drops the remembered pictures. Tests start from an empty page. */
export function clearRemoteMosaicCache(): void {
  mosaicMemory.clear();
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
 * The one picture a tile draws: the fan the server composed for this folder, or the folder's own
 * picture when it has one and they are not the same thing. Read once the tile is on screen.
 */
function useRemotePicture({ libraryId, parentId, enabled, generation }: PreviewKey, target: TileRef, preferChildren = false): string | undefined {
  const key = mosaicKey(libraryId, parentId, preferChildren);
  const [picture, setPicture] = useState<string | undefined>(() => (enabled ? readMosaic(key) : undefined));
  const pictureRef = useRef(picture);
  pictureRef.current = picture;
  useEffect(() => {
    if (!enabled) {
      setPicture(undefined);
      return;
    }
    const stored = readMosaic(key);
    if (stored) setPicture((current) => (current === stored ? current : stored));
    const controller = new AbortController();
    let live = true;
    const load = () => {
      void withPreviewSlot(() => {
        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        return api.remotePreview(libraryId, parentId, controller.signal, preferChildren);
      })
        .then((answer) => {
          if (!live) return;
          const next = answer.mosaic ?? answer.posters[0];
          if (!next) return;
          writeMosaic(key, next);
          if (pictureRef.current !== next) setPicture(next);
        })
        .catch(() => undefined);
    };
    const element = target.current;
    // No observer (an old browser or a test without one): read straight away rather than never.
    if (typeof IntersectionObserver === "undefined" || !element) {
      load();
      return () => { live = false; controller.abort(); };
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      load();
    });
    observer.observe(element);
    return () => { live = false; observer.disconnect(); controller.abort(); };
  }, [key, libraryId, parentId, enabled, generation, preferChildren]);
  return enabled ? picture : undefined;
}

/** A remote root library's picture: the fan of its films, its own view image, or the drive icon.
 *  The tile keeps the frame it would draw without a fan while the fan is fetched or composed. */
export function RemoteLibraryArt(props: PreviewKey & { target: TileRef; poster?: string }) {
  const { target, poster, ...key } = props;
  const fan = remoteMosaicArtwork(useRemotePicture(key, target, true), "poster");
  return <TileArt shape="poster" poster={fan ?? poster} fallback={<HardDrive/>}/>;
}

/** The picture the listing already named. It is drawn at once, the way a local tile is;
 *  `loading="lazy"` on the image is what keeps an off-screen poster from being fetched. */
export function RemoteTileArt(props: Parameters<typeof TileArt>[0]) {
  return <TileArt {...props}/>;
}

/** A remote folder's picture: the fan of the films inside it, its own artwork, or the folder
 *  icon. A folder with a poster draws it and asks for no fan. */
export function RemoteFolderArt({ shape, poster, wide, ...picture }: PreviewKey & { target: TileRef; shape: TileShape; poster?: string; wide?: string }) {
  const { target, ...key } = picture;
  const fan = remoteMosaicArtwork(useRemotePicture({ ...key, enabled: key.enabled && !poster }, target), shape);
  if (fan) return <RemoteTileArt shape={shape} poster={fan} fallback={<FolderOpen/>}/>;
  return <RemoteTileArt shape={shape} poster={poster} wide={wide} fallback={<FolderOpen/>}/>;
}
