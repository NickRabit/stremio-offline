import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import {
  CatalogSearchStartNotFound,
  catalogSearchHasMore,
  catalogSearchSession,
  newCatalogSearchSlot,
  runCatalogSearch,
  type CatalogSearchCursor,
} from "./catalog-search-session";
import type { SearchScope } from "./search-scope";
import type { Catalog, Meta } from "./types";

const merge = (previous: Meta[], incoming: Meta[]) => {
  const seen = new Set(previous.map((item) => `${item.type}:${item.id}`));
  return [...previous, ...incoming.filter((item) => !seen.has(`${item.type}:${item.id}`))];
};

interface CatalogLoaderOptions {
  view: string;
  query: string;
  scopeValue: string;
  scope: SearchScope;
  typeFilter: string;
  effectiveTypeFilter: string;
  genre: string;
  catalog: Catalog | undefined;
  resetKey: number;
  searchSessionEnabled: boolean;
  onFirstPageStart(): void;
  onItems(items: Meta[], addonKey?: string): void;
  onRecordSearch(query: string): void;
  onSearchReset(query: string): void;
  onError(error: unknown): void;
  onBusyChange(busy: boolean): void;
}

interface LoadedSearch {
  query: string;
  scope: string;
  type: string;
  genre: string;
  catalog: string;
  reset: number;
}

export interface CatalogLoader {
  items: Meta[];
  hasMore: boolean;
  loadingMore: boolean;
  pageFailed: boolean;
  sourceCount: number;
  loadPage(reset: boolean): Promise<void>;
  actOnSearch(query: string): void;
  clearPendingRecord(): void;
}

export function useCatalogLoader(options: CatalogLoaderOptions): CatalogLoader {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [items, setItems] = useState<Meta[]>([]);
  const [skip, setSkip] = useState(0);
  const [cursor, setCursor] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [pageFailed, setPageFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sourceCount, setSourceCount] = useState(0);

  const itemsRef = useRef<Meta[]>([]);
  const skipRef = useRef(0);
  const cursorRef = useRef("");
  const loadingRef = useRef(false);
  const requestRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);
  const catalogSearchSlotRef = useRef<string | null>(null);
  if (catalogSearchSlotRef.current === null) catalogSearchSlotRef.current = newCatalogSearchSlot();
  const catalogSearchGenerationRef = useRef(0);
  const catalogSearchSessionRef = useRef<CatalogSearchCursor>({ id: null, revision: 0 });
  const catalogSessionUnsupportedRef = useRef(false);
  const loadedSearchRef = useRef<LoadedSearch | null>(null);
  const firstPageOkRef = useRef<string | null>(null);
  const recordIntentRef = useRef<string | null>(null);

  const updateItems = useCallback((next: Meta[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);
  const updateSkip = useCallback((next: number) => {
    skipRef.current = next;
    setSkip(next);
  }, []);
  const updateCursor = useCallback((next: string) => {
    cursorRef.current = next;
    setCursor(next);
  }, []);

  const deleteCatalogSearchSession = useCallback(() => {
    const id = catalogSearchSessionRef.current.id;
    catalogSearchSessionRef.current = { id: null, revision: 0 };
    if (id !== null) catalogSearchSession.delete(id);
  }, []);

  const stopSearch = useCallback(() => {
    searchAbortRef.current?.abort();
    deleteCatalogSearchSession();
  }, [deleteCatalogSearchSession]);

  const recordFirstPage = useCallback((query: string) => {
    firstPageOkRef.current = query;
    if (recordIntentRef.current === query) {
      recordIntentRef.current = null;
      optionsRef.current.onRecordSearch(query);
    }
  }, []);

  const loadPage = useCallback(async (reset: boolean) => {
    const current = optionsRef.current;
    const query = current.query;
    const scope = current.scope;
    const type = current.effectiveTypeFilter;
    const catalog = current.catalog;
    if (!query && !catalog) return;
    // Paging may be dropped, while a new query has to replace the run before it.
    if (!reset && loadingRef.current) return;
    const request = reset ? ++requestRef.current : requestRef.current;
    const stale = () => request !== requestRef.current;
    loadingRef.current = true;
    setPageFailed(false);
    const from = reset ? 0 : skipRef.current;

    if (reset) {
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
      deleteCatalogSearchSession();
      catalogSearchGenerationRef.current += 1;
      optionsRef.current.onBusyChange(true);
      optionsRef.current.onFirstPageStart();
    } else {
      setLoadingMore(true);
    }

    try {
      if (query) {
        const controller = new AbortController();
        searchAbortRef.current = controller;
        const loadCurrentSearch = async () => {
          const result = await api.search(query, {
            ...scope,
            type,
            cursor: reset ? "" : cursorRef.current,
            signal: controller.signal,
          });
          if (stale()) return;
          const previous = itemsRef.current;
          const next = reset ? result.items : merge(previous, result.items);
          // Some addons answer every page with the same entries.
          const gainedNothing = !reset && next.length === previous.length;
          updateItems(next);
          setSourceCount(result.sources);
          updateCursor(result.cursor);
          setHasMore(result.hasMore && !gainedNothing);
          optionsRef.current.onItems(result.items, scope.addonKey);
          if (reset) recordFirstPage(query);
        };

        if (!current.searchSessionEnabled || catalogSessionUnsupportedRef.current) {
          await loadCurrentSearch();
        } else {
          const before = new Set(itemsRef.current.map((item) => `${item.type}:${item.id}`));
          let gained = false;
          try {
            await runCatalogSearch({
              reset,
              request: {
                query,
                ...(type === "movie" || type === "series" ? { type } : {}),
                ...(scope.addonKey === undefined
                  ? {}
                  : {
                    scope: {
                      addonKey: scope.addonKey,
                      ...(scope.catalogType === undefined ? {} : { catalogType: scope.catalogType }),
                      ...(scope.catalogId === undefined ? {} : { catalogId: scope.catalogId }),
                    },
                  }),
                slotId: catalogSearchSlotRef.current!,
                generation: catalogSearchGenerationRef.current,
              },
              cursor: catalogSearchSessionRef.current,
              signal: controller.signal,
              onSnapshot: (snapshot) => {
                if (stale()) return;
                const next = snapshot.items;
                for (const item of next) {
                  if (!before.has(`${item.type}:${item.id}`)) {
                    gained = true;
                    break;
                  }
                }
                updateItems(next);
                updateCursor("");
                setSourceCount(snapshot.sources);
                setHasMore(catalogSearchHasMore(snapshot, reset, gained));
                optionsRef.current.onItems(next, scope.addonKey);
                if (next.length > 0 || snapshot.state === "complete") optionsRef.current.onBusyChange(false);
              },
              onFirstSnapshot: () => {
                if (reset) recordFirstPage(query);
              },
            });
          } catch (error) {
            if (!(error instanceof CatalogSearchStartNotFound)) throw error;
            catalogSessionUnsupportedRef.current = true;
            deleteCatalogSearchSession();
            await loadCurrentSearch();
          }
        }
      } else {
        const metas = await api.catalog(catalog!, "", from, current.genre);
        if (stale()) return;
        optionsRef.current.onItems(metas, catalog!.addonKey);
        const previous = itemsRef.current;
        const next = reset ? metas : merge(previous, metas);
        const gainedNothing = !reset && next.length === previous.length;
        updateItems(next);
        updateSkip(from + metas.length);
        setHasMore(metas.length > 0 && !gainedNothing);
      }
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name === "AbortError") return;
      if (!stale()) {
        if (reset) {
          updateItems([]);
          recordIntentRef.current = null;
          setHasMore(false);
        } else setPageFailed(true);
        optionsRef.current.onError(error);
      }
    } finally {
      if (!stale()) {
        loadingRef.current = false;
        optionsRef.current.onBusyChange(false);
        setLoadingMore(false);
      }
    }
  }, [deleteCatalogSearchSession, recordFirstPage, updateCursor, updateItems, updateSkip]);

  const actOnSearch = useCallback((query: string) => {
    if (firstPageOkRef.current === query) optionsRef.current.onRecordSearch(query);
    else recordIntentRef.current = query;
  }, []);
  const clearPendingRecord = useCallback(() => {
    recordIntentRef.current = null;
  }, []);

  useEffect(() => {
    if (options.view !== "catalog") stopSearch();
  }, [options.view, stopSearch]);
  useEffect(() => () => stopSearch(), [stopSearch]);

  const reloadScope = options.query && options.scopeValue;
  const catalogAddonKey = options.catalog?.addonKey;
  const catalogType = options.catalog?.type;
  const catalogId = options.catalog?.id;
  useEffect(() => {
    const current = optionsRef.current;
    const snapshot: LoadedSearch = {
      query: current.query,
      scope: current.scopeValue,
      type: current.typeFilter,
      genre: current.genre,
      catalog: `${current.catalog?.addonKey}:${current.catalog?.type}:${current.catalog?.id}`,
      reset: current.resetKey,
    };
    const previous = loadedSearchRef.current;
    loadedSearchRef.current = snapshot;
    firstPageOkRef.current = null;
    if (recordIntentRef.current !== current.query) recordIntentRef.current = null;
    current.onSearchReset(current.query);
    // A new query inside the same search keeps its results; every other reset starts empty.
    const queryOnly = previous !== null && previous.query !== "" && snapshot.query !== ""
      && previous.query !== snapshot.query
      && previous.scope === snapshot.scope && previous.type === snapshot.type
      && previous.genre === snapshot.genre && previous.catalog === snapshot.catalog
      && previous.reset === snapshot.reset;
    if (!queryOnly) {
      updateItems([]);
      setSourceCount(0);
    }
    updateSkip(0);
    updateCursor("");
    setHasMore(false);
    void loadPage(true);
  }, [
    options.query,
    reloadScope,
    options.typeFilter,
    options.genre,
    catalogAddonKey,
    catalogType,
    catalogId,
    options.resetKey,
    loadPage,
    updateCursor,
    updateItems,
    updateSkip,
  ]);

  return {
    items,
    hasMore,
    loadingMore,
    pageFailed,
    sourceCount,
    loadPage,
    actOnSearch,
    clearPendingRecord,
  };
}
