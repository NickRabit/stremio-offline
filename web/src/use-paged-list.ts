import { useCallback, useLayoutEffect, useRef, useState } from "react";

export interface Page<T> {
  items: T[];
  total: number;
}

export interface PagedList<T, F> {
  items: T[];
  total: number;
  busy: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  /** Re-reads the first page of the current filter, keeping the cards until it lands. */
  refresh: () => Promise<void>;
  /** Asks for the next page of the current filter; ignored while one is outstanding. */
  loadMore: () => Promise<void>;
}

const NO_ITEMS: never[] = [];

interface StoredList<T, F> {
  filter: F;
  items: T[];
  total: number;
  busy: boolean;
  loadingMore: boolean;
  active: boolean;
}

export function usePagedList<T, F>(options: {
  filter: F;
  active: boolean;
  fetchPage: (filter: F, skip: number) => Promise<Page<T>>;
  onError: (error: unknown) => void;
}): PagedList<T, F> {
  const { filter, active } = options;
  const [stored, setStored] = useState<StoredList<T, F>>(() => ({
    filter,
    items: [],
    total: 0,
    busy: active,
    loadingMore: false,
    active,
  }));
  const storedRef = useRef(stored);
  storedRef.current = stored;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const activeRef = useRef(active);
  activeRef.current = active;
  const fetchPageRef = useRef(options.fetchPage);
  fetchPageRef.current = options.fetchPage;
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;
  const generationRef = useRef(0);
  const loadMoreGenerationRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  const firstPage = useCallback((wantedFilter: F, keepItems: boolean): Promise<void> => {
    if (!activeRef.current) return Promise.resolve();
    const generation = ++generationRef.current;
    loadMoreGenerationRef.current = null;
    setStored((current) => ({
      filter: wantedFilter,
      items: keepItems && Object.is(current.filter, wantedFilter) ? current.items : [],
      total: keepItems && Object.is(current.filter, wantedFilter) ? current.total : 0,
      busy: true,
      loadingMore: false,
      active: true,
    }));
    return fetchPageRef.current(wantedFilter, 0).then(
      (page) => {
        if (!mountedRef.current || generation !== generationRef.current) return;
        setStored((current) => {
          if (!mountedRef.current || generation !== generationRef.current) return current;
          return {
            filter: wantedFilter,
            items: page.items,
            total: page.total,
            busy: false,
            loadingMore: false,
            active: true,
          };
        });
      },
      (error: unknown) => {
        if (!mountedRef.current || generation !== generationRef.current) return;
        onErrorRef.current(error);
        setStored((current) => {
          if (!mountedRef.current || generation !== generationRef.current) return current;
          return { ...current, busy: false, loadingMore: false, active: true };
        });
      },
    );
  }, []);

  useLayoutEffect(() => {
    const generation = ++generationRef.current;
    loadMoreGenerationRef.current = null;
    if (!active) {
      setStored((current) => ({ ...current, busy: false, loadingMore: false, active: false }));
      return;
    }
    void firstPage(filter, false);
    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [filter, active, firstPage]);

  const refresh = useCallback(() => firstPage(filterRef.current, true), [firstPage]);

  const loadMore = useCallback((): Promise<void> => {
    const wantedFilter = filterRef.current;
    const current = storedRef.current;
    const generation = generationRef.current;
    if (
      !activeRef.current
      || !Object.is(current.filter, wantedFilter)
      || !current.active
      || current.busy
      || current.loadingMore
      || loadMoreGenerationRef.current !== null
      || current.items.length >= current.total
    ) return Promise.resolve();
    loadMoreGenerationRef.current = generation;
    const skip = current.items.length;
    setStored((value) => ({ ...value, loadingMore: true }));
    return fetchPageRef.current(wantedFilter, skip).then(
      (page) => {
        if (!mountedRef.current || generation !== generationRef.current) return;
        loadMoreGenerationRef.current = null;
        setStored((value) => {
          if (!mountedRef.current || generation !== generationRef.current) return value;
          return {
            ...value,
            items: [...value.items, ...page.items],
            total: page.total,
            loadingMore: false,
          };
        });
      },
      (error: unknown) => {
        if (!mountedRef.current || generation !== generationRef.current) return;
        loadMoreGenerationRef.current = null;
        onErrorRef.current(error);
        setStored((value) => {
          if (!mountedRef.current || generation !== generationRef.current) return value;
          return { ...value, loadingMore: false };
        });
      },
    );
  }, []);

  const owned = Object.is(stored.filter, filter);
  const current = owned && (stored.active || !active);
  const items: T[] = current ? stored.items : NO_ITEMS;
  const total = current ? stored.total : 0;
  return {
    items,
    total,
    busy: active && (!current || stored.busy),
    loadingMore: active && current && stored.loadingMore,
    hasMore: items.length < total,
    refresh,
    loadMore,
  };
}
