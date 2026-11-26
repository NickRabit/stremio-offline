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
import { browseMembers, catalogRefKey, effectiveGenre, genreOptions, refOf, type BrowseCatalog } from "./catalog-picker-model";
import type { SearchScope } from "./search-scope";
import type { Meta } from "./types";

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
  catalog: BrowseCatalog | undefined;
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
  /** Scrolling near the end asks for the next page, but never retries one that failed. */
  autoLoadPage(): void;
  actOnSearch(query: string): void;
  clearPendingRecord(): void;
}

export function useCatalogLoader(options: CatalogLoaderOptions): CatalogLoader {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [items, setItems] = useState<Meta[]>([]);
  const browseOffsets = useRef(new Map<string, number | null>());
  const [cursor, setCursor] = useState("");
  const [hasMore, setHasMoreState] = useState(false);
  const [pageFailed, setPageFailedState] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sourceCount, setSourceCount] = useState(0);

  const itemsRef = useRef<Meta[]>([]);
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

  // Scroll events can arrive before the render that follows a page, so the automatic loader reads these.
  const hasMoreRef = useRef(false);
  const pageFailedRef = useRef(false);
  const setHasMore = useCallback((next: boolean) => {
    hasMoreRef.current = next;
    setHasMoreState(next);
  }, []);
  const setPageFailed = useCallback((next: boolean) => {
    pageFailedRef.current = next;
    setPageFailedState(next);
  }, []);
  const updateItems = useCallback((next: Meta[]) => {
    itemsRef.current = next;
    setItems(next);
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
        const members = (catalog![browseMembers] ?? [catalog!]).filter((member) =>
          !current.genre || genreOptions(member).includes(current.genre));
        if (reset) browseOffsets.current.clear();
        const pending = members.filter((member) => browseOffsets.current.get(member.type) !== null);
        const pages = await Promise.allSettled(pending.map((member) => api.catalog(member, "",
          browseOffsets.current.get(member.type) ?? 0, effectiveGenre(member, current.genre))));
        if (stale()) return;
        const previous = reset ? [] : itemsRef.current;
        const seen = new Set(previous.map((item) => JSON.stringify([item.type, item.id])));
        const fresh = pages.map((page, index) => {
          if (page.status === "rejected") return [];
          const member = pending[index]!;
          const items = page.value.flatMap((meta) => {
            const item = meta.type ? meta : { ...meta, type: member.type };
            const key = JSON.stringify([item.type, item.id]);
            if (seen.has(key)) return [];
            seen.add(key);
            return [item];
          });
          const offset = browseOffsets.current.get(member.type) ?? 0;
          browseOffsets.current.set(member.type, items.length ? offset + page.value.length : null);
          return items;
        });
        const appended: Meta[] = [];
        for (let index = 0; fresh.some((page) => index < page.length); index++) {
          for (const page of fresh) if (page[index]) appended.push(page[index]!);
        }
        updateItems([...previous, ...appended]);
        optionsRef.current.onItems(appended, catalog!.addonKey);
        setHasMore(members.some((member) => browseOffsets.current.get(member.type) !== null));
        const failure = pages.find((page) => page.status === "rejected");
        if (failure) {
          setPageFailed(true);
          optionsRef.current.onError(failure.reason);
        }
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
  }, [deleteCatalogSearchSession, recordFirstPage, setHasMore, setPageFailed, updateCursor, updateItems]);

  const autoLoadPage = useCallback(() => {
    if (hasMoreRef.current && !pageFailedRef.current) void loadPage(false);
  }, [loadPage]);

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
  const browseKey = JSON.stringify(options.catalog?.[browseMembers]?.map((member) => [catalogRefKey(refOf(member)), effectiveGenre(member, options.genre), !options.genre || genreOptions(member).includes(options.genre)]));
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
    browseOffsets.current.clear();
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
    setHasMore,
    updateCursor,
    updateItems,
    browseKey,
  ]);

  return {
    items,
    hasMore,
    loadingMore,
    pageFailed,
    sourceCount,
    loadPage,
    autoLoadPage,
    actOnSearch,
    clearPendingRecord,
  };
}
