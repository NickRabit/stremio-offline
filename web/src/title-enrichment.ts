import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { localGalleryImage, type GalleryImage } from "./gallery-images";
import type { Meta, SiteLink, Trailer } from "./types";

/** A catalogue identity the enrichment may trust: an exact movie or series, nothing else. */
export interface CatalogueRef { type: "movie" | "series"; id: string }

/**
 * The catalogue identity of a title, validated and never guessed: a provider id that is a real
 * IMDb id wins, a numeric TMDB id becomes the `tmdb:` form the catalogue answers to, and the type
 * has to be a movie or a series. An episode is asked about through its series, never itself.
 */
export const catalogueRef = (type: string | undefined, ids: { imdb?: string; tmdb?: string } | undefined): CatalogueRef | null => {
  if (type !== "movie" && type !== "series") return null;
  const imdb = ids?.imdb;
  if (imdb && /^tt[0-9]+$/.test(imdb)) return { type, id: imdb };
  const tmdb = ids?.tmdb;
  if (tmdb && /^[0-9]+$/.test(tmdb)) return { type, id: `tmdb:${tmdb}` };
  return null;
};

/** Where a title's links and trailer come from: a local path, or a catalogue identity. */
export type TitleSource =
  | { kind: "local"; path: string }
  | { kind: "catalogue"; ref: CatalogueRef };

export interface TitleEnrichment { meta: Meta | null; links: SiteLink[]; trailer: Trailer | null }

const linksCache = new Map<string, SiteLink[]>();
const linksInflight = new Map<string, Promise<SiteLink[]>>();
const trailerCache = new Map<string, Trailer | null>();
const trailerInflight = new Map<string, Promise<Trailer | null>>();
const metaCache = new Map<string, Meta | null>();
const metaInflight = new Map<string, Promise<Meta | null>>();
const EMPTY_LINKS: SiteLink[] = [];
const galleryCache = new Map<string, { at: number; result: Promise<GalleryImage[]> }>();

export const clearTitleEnrichment = () => {
  galleryCache.clear();
  linksCache.clear(); linksInflight.clear(); trailerCache.clear(); trailerInflight.clear(); metaCache.clear(); metaInflight.clear();
};

const sourceKey = (source: TitleSource) =>
  source.kind === "local" ? `local:${source.path}` : `catalogue:${source.ref.type}:${source.ref.id}`;

/** One cached value per key for the session, with an epoch so a late answer never overwrites a
 *  newer title. Two callers for the same key share one request. */
function useSessionValue<T>(cache: Map<string, T>, inflight: Map<string, Promise<T>>, key: string, load: () => Promise<T>, empty: T): T {
  const [value, setValue] = useState<{ key: string; answer: T }>(() => ({ key, answer: key && cache.has(key) ? cache.get(key)! : empty }));
  const epoch = useRef(0);
  useEffect(() => {
    const mine = ++epoch.current;
    if (!key) { setValue({ key, answer: empty }); return; }
    if (cache.has(key)) { setValue({ key, answer: cache.get(key)! }); return; }
    setValue({ key, answer: empty });
    let running = inflight.get(key);
    if (!running) {
      running = load().then((answer) => { cache.set(key, answer); if (cache.size > 256) cache.delete(cache.keys().next().value!); return answer; }).finally(() => { inflight.delete(key); });
      inflight.set(key, running);
    }
    void running.then((answer) => { if (mine === epoch.current) setValue({ key, answer }); }).catch(() => undefined);
    return () => { if (epoch.current === mine) epoch.current += 1; };
  }, [key]);
  return value.key === key ? value.answer : cache.get(key) ?? empty;
}

/**
 * The links, the trailer and the catalogue facts of one explicitly opened title, read once per
 * identity and language for the session. Best effort throughout: a failed read leaves that part
 * empty and never blocks the sources the viewer is already waiting for.
 */
export function useTitleEnrichment(source: TitleSource | null, metaRef: CatalogueRef | null, language: string): TitleEnrichment {
  const key = source ? `${sourceKey(source)}@${language}` : "";
  const links = useSessionValue(linksCache, linksInflight, key,
    () => (source?.kind === "local" ? api.libraryLinks(source.path, language)
      : source ? api.links(source.ref.type, source.ref.id, language) : Promise.resolve({ links: EMPTY_LINKS }))
      .then((answer) => answer.links).catch(() => EMPTY_LINKS), EMPTY_LINKS);
  const trailer = useSessionValue(trailerCache, trailerInflight, key,
    () => (source?.kind === "local" ? api.libraryTrailer(source.path, language)
      : source ? api.trailer(source.ref.type, source.ref.id, language) : Promise.resolve({ trailer: null }))
      .then((answer) => answer.trailer).catch(() => null), null);
  const meta = useSessionValue(metaCache, metaInflight, metaRef ? `${metaRef.type}:${metaRef.id}@${language}` : "",
    () => metaRef ? api.meta(metaRef.type, metaRef.id, language) : Promise.resolve(null), null);
  return { meta, links, trailer };
}


export function loadTitleGallery(ref: CatalogueRef, language: string): Promise<GalleryImage[]> {
  const key = `${ref.type}:${ref.id}@${language}`;
  const cached = galleryCache.get(key);
  if (cached && Date.now() - cached.at < 30 * 60_000) return cached.result;
  const result = api.titleGallery(ref.type, ref.id, language).then((answer) => answer.images.map(localGalleryImage)).catch(() => []);
  galleryCache.set(key, { at: Date.now(), result });
  if (galleryCache.size > 128) galleryCache.delete(galleryCache.keys().next().value!);
  return result;
}
