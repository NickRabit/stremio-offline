import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useI18n } from "./i18n";
import type { TitleExtras } from "./types";

/** An addon answer is the catalogue's own cast, which goes stale as libraries change. */
const ADDON_TTL_MS = 10 * 60 * 1000;
/** A catalogue (TMDB) answer changes slowly. */
const OTHER_TTL_MS = 60 * 60 * 1000;

interface CacheEntry { extras: TitleExtras; at: number }

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<TitleExtras>>();
let generation = 0;
let now = () => Date.now();

/** Test seam: the lifetime below is measured with this clock. */
export const setTitleExtrasClock = (clock: () => number) => { now = clock; };

const fresh = (entry: CacheEntry) => now() - entry.at < (entry.extras.source === "addon" ? ADDON_TTL_MS : OTHER_TTL_MS);

const readCache = (key: string): TitleExtras | null => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (fresh(entry)) return entry.extras;
  cache.delete(key);
  return null;
};

/** Drops every language of every title. A failure is never stored, so there is nothing to drop for one. */
export const clearTitleExtrasCache = () => {
  generation += 1;
  cache.clear();
  inflight.clear();
};

export const clearTitleExtras = clearTitleExtrasCache;

const catalogueType = (type?: string): type is "movie" | "series" => type === "movie" || type === "series";

/**
 * Cast, similar titles and the hero facts of one movie or series. An addon answer is kept for
 * ten minutes and any other answer for an hour, per identity and UI language. A failed read is
 * not remembered. A reply for a title that has already been replaced is ignored, and a reply
 * that lands after the cache was cleared is not put back.
 */
export function useTitleExtras(type?: string, id?: string): { extras: TitleExtras | null; loading: boolean } {
  const { locale } = useI18n();
  const key = catalogueType(type) && id ? `${type}:${id}@${locale}` : "";
  const [state, setState] = useState<{ key: string; extras: TitleExtras | null; loading: boolean }>(() => {
    const cached = key ? readCache(key) : null;
    return { key, extras: cached, loading: Boolean(key) && !cached };
  });
  const epoch = useRef(0);
  useEffect(() => {
    const mine = ++epoch.current;
    if (!key || !catalogueType(type) || !id) {
      setState({ key, extras: null, loading: false });
      return;
    }
    const cached = readCache(key);
    if (cached) {
      setState({ key, extras: cached, loading: false });
      return;
    }
    setState({ key, extras: null, loading: true });
    let running = inflight.get(key);
    if (!running) {
      const titleType = type;
      const titleId = id;
      const seen = generation;
      const request = api.titleExtras(titleType, titleId, locale).then((answer) => {
        if (seen === generation) {
          cache.set(key, { extras: answer, at: now() });
          if (cache.size > 256) cache.delete(cache.keys().next().value!);
        }
        return answer;
      });
      void request.finally(() => { if (inflight.get(key) === request) inflight.delete(key); }).catch(() => undefined);
      running = request;
      inflight.set(key, request);
    }
    void running.then((answer) => {
      if (mine === epoch.current) setState({ key, extras: answer, loading: false });
    }).catch(() => {
      if (mine === epoch.current) setState({ key, extras: null, loading: false });
    });
    return () => { if (epoch.current === mine) epoch.current += 1; };
  }, [key, type, id, locale]);
  if (!key) return { extras: null, loading: false };
  if (state.key !== key) {
    const cached = readCache(key);
    return { extras: cached, loading: !cached };
  }
  return { extras: state.extras, loading: state.loading };
}
