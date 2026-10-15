import { useEffect, useRef, useState, type RefObject } from "react";
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

/** The same pictures, whatever order the preview happened to return them in. Replacing a fan
 *  the page already shows would hide it and assemble it again. */
const sameSet = (left: string[], right: string[]) =>
  left.length === right.length && left.every((url) => right.includes(url));

/** How many pictures one pass warms. A screen of fans is a handful of posters. */
const PRELOAD_LIMIT = 24;
const warmed = new Set<string>();

/** Fetches a poster into the browser cache and remembers it once it can be painted. A repeat
 *  visit then draws the fan in the first frame, the way a local mosaic already does. */
export function preloadRemotePosters(urls: Array<string | undefined>): void {
  if (typeof Image === "undefined") return;
  let left = PRELOAD_LIMIT;
  for (const url of urls) {
    if (!url || warmed.has(url)) continue;
    if (left <= 0) return;
    left -= 1;
    warmed.add(url);
    const image = new Image();
    image.onload = () => {
      const painted = image.decode?.() ?? Promise.resolve();
      void painted.then(() => { decodedPosters.add(url); }, () => { decodedPosters.add(url); });
    };
    image.onerror = () => { brokenPosters.add(url); decodedPosters.add(url); };
    image.src = url;
  }
}

/** The fans this tab already showed. Started as the module loads, so a refresh decodes them
 *  while the library list is still on its way. */
const warmStoredMosaics = () => {
  if (typeof sessionStorage === "undefined") return;
  const urls: string[] = [];
  try {
    for (let index = 0; index < sessionStorage.length && urls.length < PRELOAD_LIMIT; index += 1) {
      const name = sessionStorage.key(index);
      if (!name?.startsWith(MOSAIC_STORAGE)) continue;
      const parsed = JSON.parse(sessionStorage.getItem(name) ?? "null") as unknown;
      if (!Array.isArray(parsed)) continue;
      for (const url of parsed) {
        if (typeof url === "string" && urls.length < PRELOAD_LIMIT) urls.push(url);
      }
    }
  } catch { /* unavailable */ }
  preloadRemotePosters(urls);
};
warmStoredMosaics();

/** Drops remembered fans. Tests start from an empty page. */
export function clearRemoteMosaicCache(): void {
  mosaicMemory.clear();
  decodedPosters.clear();
  brokenPosters.clear();
  warmed.clear();
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
export function useRemotePosters({ libraryId, parentId, enabled, generation }: PreviewKey, target: TileRef, preferChildren = false): { posters: string[]; pending: boolean; instant: boolean } {
  const key = mosaicKey(libraryId, parentId, preferChildren);
  const remembered = enabled ? readMosaic(key) : undefined;
  const [posters, setPosters] = useState<string[]>(remembered ?? []);
  const [pending, setPending] = useState(enabled && !remembered);
  // A fan this tab already showed is painted at once. A brand-new list stays hidden until every
  // poster has decoded, so the first visit does not fill in one picture at a time.
  const [instant, setInstant] = useState(Boolean(remembered && remembered.length > 1));
  const postersRef = useRef(posters);
  postersRef.current = posters;
  useEffect(() => {
    if (!enabled) {
      setPosters([]);
      setPending(false);
      setInstant(false);
      return;
    }
    const stored = readMosaic(key);
    if (stored) {
      setPosters((current) => samePosters(current, stored) ? current : stored);
      setPending(false);
      setInstant(stored.length > 1);
      preloadRemotePosters(stored);
    } else {
      setPosters([]);
      setPending(true);
      setInstant(false);
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
          preloadRemotePosters(answer.posters);
          // Keep the fan that is already on screen when the preview names the same pictures.
          if (!sameSet(postersRef.current, answer.posters)) {
            setInstant(false);
            setPosters(answer.posters);
          }
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
  return { posters, pending, instant };
}

/** The fan of posters the local library tile already draws. A fan this tab already showed is
 *  visible immediately. A new one stays hidden until every poster has arrived or failed, and a
 *  poster that already failed stays hidden on the next paint. */
function LibraryCollage({ posters, instant = false }: { posters: string[]; instant?: boolean }) {
  const latest = useRef({ posters, instant });
  latest.current = { posters, instant };
  const signature = posters.join("\0");
  const ready = () => instant || posters.every((url) => decodedPosters.has(url));
  const [shown, setShown] = useState(signature);
  const [waiting, setWaiting] = useState(() => !ready());
  if (shown !== signature) {
    setShown(signature);
    setWaiting(!ready());
  }
  const settle = (url: string) => {
    decodedPosters.add(url);
    setWaiting(!latest.current.instant && latest.current.posters.some((item) => !decodedPosters.has(item)));
  };
  // A remembered fan is on screen immediately, like a local mosaic. A new one stays hidden
  // until every poster has decoded, then appears whole.
  return <span className={`library-preview-collage${waiting ? " is-pending" : ""}`} aria-hidden="true">
    {posters.map((url) => <img key={url} src={url} alt=""
      className={brokenPosters.has(url) ? "broken" : undefined}
      ref={(node) => { if (node?.complete && node.naturalWidth > 0) settle(url); }}
      onLoad={(event) => {
        const painted = event.currentTarget.decode?.() ?? Promise.resolve();
        void painted.then(() => settle(url), () => settle(url));
      }}
      onError={(event) => { brokenPosters.add(url); hideBroken(event); settle(url); }}/>)}
  </span>;
}

/** A remote root library's picture: a collage of its films, one film, the library's own poster or
 *  the drive icon. The tile keeps that frame while the fan assembles -- the fan covers it once
 *  every poster has decoded -- so a reload never leaves the tile empty while four pictures are
 *  fetched. With mosaics off the own poster is drawn as it is. */
export function RemoteLibraryArt(props: PreviewKey & { target: TileRef; poster?: string }) {
  const { target, poster, ...key } = props;
  const { posters, pending, instant } = useRemotePosters(key, target, true);
  const tile = <TileArt shape="poster" poster={key.enabled ? posters[0] ?? poster : poster} fallback={<HardDrive/>}/>;
  if (posters.length > 1) return <>{tile}<LibraryCollage posters={posters} instant={instant}/></>;
  return tile;
}

/** The picture the listing already named. It is drawn at once, the way a local tile is;
 *  `loading="lazy"` on the image is what keeps an off-screen poster from being fetched. */
export function RemoteTileArt(props: Parameters<typeof TileArt>[0]) {
  return <TileArt {...props}/>;
}

/** A remote folder's picture: the artwork the folder already carries, or the same fan the local
 *  folder tile draws, or the folder icon. A folder with a poster draws it and asks for no
 *  preview, and a single preview poster stays a single picture rather than a collage. A poster
 *  that fails stays in its slot, so the fan does not collapse into a different frame. */
export function RemoteFolderArt({ shape, poster, wide, ...picture }: PreviewKey & { target: TileRef; shape: TileShape; poster?: string; wide?: string }) {
  const { target, ...key } = picture;
  const ask = key.enabled && !poster;
  const { posters, pending, instant } = useRemotePosters({ ...key, enabled: ask }, target);
  // What the folder would draw without a fan -- its own picture, the first of the fan, or the
  // folder icon -- stays in the frame until the fan is ready to cover it.
  const tile = <RemoteTileArt shape={shape} poster={poster ?? posters[0]} wide={wide} fallback={<FolderOpen/>}/>;
  if (posters.length > 1) return <>{tile}<LibraryCollage posters={posters} instant={instant}/></>;
  return tile;
}
