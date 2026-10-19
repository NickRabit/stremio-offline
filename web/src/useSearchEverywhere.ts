import { useEffect, useRef, useState } from "react";
import { api, ApiError, describeError } from "./api";
import { createLiveSearch, type LiveSearch } from "./live-search";
import { t } from "./i18n";
import type {
  SearchClusterView,
  SearchKindFilter,
  SearchMemberPage,
  SearchSnapshot,
  SearchSourceClass,
  SearchStartBody,
} from "./types";

const ALL_SOURCES: SearchSourceClass[] = ["catalog", "local", "remote"];
const POLL_PARTIAL_MS = 250;
const POLL_COMPLETE_MS = 1_000;
const POLL_COMPLETE_SLOW_MS = 10_000;
const POLL_COMPLETE_SLOW_AFTER_MS = 30_000;

const slotId = (): string => {
  const uuid = globalThis.crypto?.randomUUID?.().replaceAll("-", "");
  if (uuid) return uuid;
  const bytes = new Uint8Array(18);
  globalThis.crypto?.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const mergeOrder = (
  previous: string[],
  clusters: SearchClusterView[],
  aliases: Array<{ retired: string; current: string }>,
): string[] => {
  const present = new Set(clusters.map((cluster) => cluster.key));
  const retired = new Map(aliases.map((alias) => [alias.retired, alias.current]));
  const resolve = (key: string): string => {
    const seen = new Set<string>();
    let current = key;
    while (retired.has(current) && !seen.has(current)) {
      seen.add(current);
      current = retired.get(current)!;
    }
    return current;
  };
  const result: string[] = [];
  const added = new Set<string>();
  for (const key of previous) {
    const current = resolve(key);
    if (!present.has(current) || added.has(current)) continue;
    result.push(current);
    added.add(current);
  }
  for (const cluster of clusters) {
    if (added.has(cluster.key)) continue;
    result.push(cluster.key);
    added.add(cluster.key);
  }
  return result;
};

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

export type LibrarySearchScope =
  | { libraryId: string; path?: string }
  | { libraryId: string; parentId?: string };

export function useSearchEverywhere(options: {
  active: boolean;
  covered: boolean;
  library?: LibrarySearchScope;
  sources?: SearchSourceClass[];
}) {
  const [draft, setDraftState] = useState("");
  const [committed, setCommittedState] = useState("");
  const [sources, setSourcesState] = useState<SearchSourceClass[]>(options.sources ?? []);
  const [scope, setScopeState] = useState<SearchStartBody["scope"] | null>(null);
  const [kind, setKindState] = useState<SearchKindFilter>("all");
  const [snapshot, setSnapshotState] = useState<SearchSnapshot | null>(null);
  const [previousQuery, setPreviousQuery] = useState(false);
  const [order, setOrderState] = useState<string[]>([]);
  const [unidentifiedOrder, setUnidentifiedOrderState] = useState<string[]>([]);
  const [liveSearch, setLiveSearch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusAnchor, setFocusAnchorState] = useState<string | null>(null);
  const [scrollTop, setScrollTopState] = useState(0);

  const slotRef = useRef<string | null>(null);
  if (slotRef.current === null) slotRef.current = slotId();
  const generationRef = useRef(0);
  const restartDepthRef = useRef(0);
  /** An expired session is started again behind the results already drawn: they stay until the
   *  new session has answered in full, so the page never shrinks under the reader. */
  const holdingRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const revisionRef = useRef(0);
  const snapshotRef = useRef<SearchSnapshot | null>(null);
  const orderRef = useRef<string[]>([]);
  const unidentifiedOrderRef = useRef<string[]>([]);
  const committedRef = useRef("");
  const draftRef = useRef("");
  const sourcesRef = useRef<SearchSourceClass[]>(options.sources ?? []);
  const fixedSourcesRef = useRef(options.sources);
  const libraryRef = useRef(options.library);
  const scopeRef = useRef<SearchStartBody["scope"] | null>(null);
  const kindRef = useRef<SearchKindFilter>("all");
  const interactedRef = useRef(false);
  const activeRef = useRef(options.active);
  const coveredRef = useRef(options.covered);
  const liveSearchRef = useRef(false);
  const preferencesRequested = useRef(false);
  const startControllerRef = useRef<AbortController | null>(null);
  const pollControllerRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollInFlightRef = useRef(false);
  const pendingPollRef = useRef<{ delay: number; generation: number } | null>(null);
  const completeSinceRef = useRef<number | null>(null);
  const commitRef = useRef<(query: string) => void>(() => undefined);
  const liveRef = useRef<LiveSearch | null>(null);
  if (liveRef.current === null) {
    liveRef.current = createLiveSearch({ onCommit: (query) => commitRef.current(query) });
  }

  activeRef.current = options.active;
  coveredRef.current = options.covered;
  fixedSourcesRef.current = options.sources;
  libraryRef.current = options.library;

  const canPoll = () =>
    activeRef.current
    && !coveredRef.current
    && document.visibilityState !== "hidden";

  const clearPollTimer = () => {
    if (pollTimerRef.current !== null) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
  };

  const pausePolling = () => {
    clearPollTimer();
    pendingPollRef.current = null;
    pollControllerRef.current?.abort();
    pollControllerRef.current = null;
  };

  const pollDelay = (): number => {
    if (holdingRef.current || snapshotRef.current?.state === "partial") return POLL_PARTIAL_MS;
    if (snapshotRef.current?.state === "complete" && completeSinceRef.current !== null
      && Date.now() - completeSinceRef.current > POLL_COMPLETE_SLOW_AFTER_MS) {
      return POLL_COMPLETE_SLOW_MS;
    }
    return POLL_COMPLETE_MS;
  };

  const applySnapshot = (next: SearchSnapshot, freshLayout: boolean) => {
    if (holdingRef.current && !freshLayout && next.state === "partial") {
      revisionRef.current = next.revision;
      return;
    }
    holdingRef.current = false;
    const adoptServerOrder = freshLayout || !interactedRef.current;
    const main = adoptServerOrder ? next.clusters.map((cluster) => cluster.key) : mergeOrder(orderRef.current, next.clusters, next.aliases);
    const unidentified = adoptServerOrder
      ? next.unidentified.map((cluster) => cluster.key)
      : mergeOrder(unidentifiedOrderRef.current, next.unidentified, next.aliases);
    orderRef.current = main;
    unidentifiedOrderRef.current = unidentified;
    setOrderState(main);
    setUnidentifiedOrderState(unidentified);
    if (next.state === "complete" && snapshotRef.current?.state !== "complete") {
      completeSinceRef.current = Date.now();
    } else if (next.state !== "complete") {
      completeSinceRef.current = null;
    }
    snapshotRef.current = next;
    revisionRef.current = next.revision;
    setSnapshotState(next);
    setPreviousQuery(false);
  };

  const schedulePoll = (delay: number, generation: number) => {
    if (generation !== generationRef.current || !sessionIdRef.current || !canPoll()) return;
    if (pollTimerRef.current !== null) return;
    if (pollInFlightRef.current) {
      pendingPollRef.current = { delay, generation };
      return;
    }
    pollTimerRef.current = setTimeout(() => {
      pollTimerRef.current = null;
      void pollOnce(generation);
    }, delay);
  };

  const handleRequestError = (value: unknown, generation: number, query: string) => {
    if (generation !== generationRef.current) return;
    if (value instanceof ApiError && value.status === 410) {
      if (restartDepthRef.current === 0) {
        restartDepthRef.current = 1;
        holdingRef.current = snapshotRef.current !== null;
        startSearch(query, false);
        return;
      }
      pausePolling();
      sessionIdRef.current = null;
      setError(t("searchAll.restartFailed"));
      return;
    }
    if (
      value instanceof ApiError
      && (value.status === 429 || value.status === 503)
      && (value.code === "search-session-limit"
        || value.code === "search-capacity-limit"
        || value.messageKey === "err.searchSessionLimit"
        || value.messageKey === "err.searchCapacityLimit")
    ) {
      pausePolling();
      setError(describeError(value));
      return;
    }
    if (!isAbort(value)) setError(describeError(value));
  };

  async function pollOnce(generation: number) {
    const id = sessionIdRef.current;
    if (!id || generation !== generationRef.current || !canPoll()) return;
    const controller = new AbortController();
    pollControllerRef.current = controller;
    pollInFlightRef.current = true;
    let nextDelay: number | null = null;
    try {
      const answer = await api.searchEverywherePoll(id, revisionRef.current, controller.signal);
      if (generation !== generationRef.current || controller.signal.aborted) return;
      if (answer.changed) applySnapshot(answer.snapshot, false);
      nextDelay = answer.changed ? 0 : pollDelay();
    } catch (value) {
      if (!controller.signal.aborted && !isAbort(value)) handleRequestError(value, generation, committedRef.current);
    } finally {
      if (pollControllerRef.current === controller) pollControllerRef.current = null;
      pollInFlightRef.current = false;
      const pending = pendingPollRef.current;
      pendingPollRef.current = null;
      if (pending !== null) schedulePoll(pending.delay, pending.generation);
      else if (nextDelay !== null) schedulePoll(nextDelay, generation);
    }
  }

  const abortRequests = () => {
    startControllerRef.current?.abort();
    startControllerRef.current = null;
    pausePolling();
  };

  const deleteSession = () => {
    const id = sessionIdRef.current;
    sessionIdRef.current = null;
    if (id !== null) api.searchEverywhereDelete(id);
  };

  const resetSession = () => {
    generationRef.current += 1;
    abortRequests();
    deleteSession();
    liveRef.current?.cancel();
    committedRef.current = "";
    draftRef.current = "";
    snapshotRef.current = null;
    orderRef.current = [];
    unidentifiedOrderRef.current = [];
    completeSinceRef.current = null;
    revisionRef.current = 0;
    restartDepthRef.current = 0;
    holdingRef.current = false;
    setCommittedState("");
    setDraftState("");
    scopeRef.current = null;
    interactedRef.current = false;
    setScopeState(null);
    setSnapshotState(null);
    setOrderState([]);
    setUnidentifiedOrderState([]);
    setPreviousQuery(false);
    setError(null);
    setFocusAnchorState(null);
    setScrollTopState(0);
  };

  function startSearch(value: string, freshLayout: boolean) {
    const query = value.trim();
    if (!query) {
      resetSession();
      return;
    }
    if (freshLayout) {
      restartDepthRef.current = 0;
      interactedRef.current = false;
      holdingRef.current = false;
    }
    const generation = ++generationRef.current;
    const requestSources = fixedSourcesRef.current ?? (sourcesRef.current.length ? sourcesRef.current : ALL_SOURCES);
    abortRequests();
    committedRef.current = query;
    setCommittedState(query);
    setError(null);
    setPreviousQuery(snapshotRef.current !== null && !holdingRef.current);
    setSnapshotState(snapshotRef.current);
    completeSinceRef.current = null;
    const controller = new AbortController();
    startControllerRef.current = controller;
    void api.searchEverywhereStart({
      query,
      kind: kindRef.current,
      sources: [...requestSources],
      slotId: slotRef.current!,
      generation,
      ...(scopeRef.current ? { scope: { ...scopeRef.current } } : {}),
      ...(libraryRef.current ? { library: { ...libraryRef.current } } : {}),
    }, controller.signal).then((answer) => {
      if (generation !== generationRef.current || controller.signal.aborted) return;
      sessionIdRef.current = answer.id;
      applySnapshot(answer.snapshot, freshLayout);
      schedulePoll(0, generation);
    }).catch((value: unknown) => {
      if (controller.signal.aborted) return;
      handleRequestError(value, generation, query);
    }).finally(() => {
      if (startControllerRef.current === controller) startControllerRef.current = null;
    });
  }

  const setDraft = (value: string) => {
    draftRef.current = value;
    setDraftState(value);
    if (liveSearchRef.current) liveRef.current?.update(value, committedRef.current);
  };

  const compositionStart = () => liveRef.current?.compositionStart();

  const compositionEnd = (value: string) => {
    draftRef.current = value;
    setDraftState(value);
    if (liveSearchRef.current) liveRef.current?.compositionEnd(value, committedRef.current);
  };

  const submit = () => {
    const query = draftRef.current.trim();
    if (!query) return;
    liveRef.current?.cancel();
    startSearch(query, true);
  };

  const clear = () => {
    resetSession();
  };

  const setSources = (value: SearchSourceClass[]) => {
    if (fixedSourcesRef.current) return;
    const next = [...new Set(value)];
    if (!(next.length === 1 && next[0] === "catalog")) {
      scopeRef.current = null;
      setScopeState(null);
    }
    if (JSON.stringify(next) === JSON.stringify(sourcesRef.current)) return;
    sourcesRef.current = next;
    setSourcesState(next);
    if (committedRef.current) startSearch(committedRef.current, true);
  };

  const setScope = (value: SearchStartBody["scope"] | null) => {
    const next = value?.addonKey ? value : null;
    if (JSON.stringify(next) === JSON.stringify(scopeRef.current)) return;
    scopeRef.current = next;
    setScopeState(next);
    if (next && !(sourcesRef.current.length === 1 && sourcesRef.current[0] === "catalog")) {
      sourcesRef.current = ["catalog"];
      setSourcesState(["catalog"]);
    }
    if (committedRef.current) startSearch(committedRef.current, true);
  };

  const setKind = (value: SearchKindFilter) => {
    if (value === kindRef.current) return;
    kindRef.current = value;
    setKindState(value);
    if (committedRef.current) startSearch(committedRef.current, true);
  };

  const loadMore = () => {
    const id = sessionIdRef.current;
    if (!id) return;
    void api.searchEverywherePage(id).then(() => {
      clearPollTimer();
      schedulePoll(0, generationRef.current);
    }).catch((value: unknown) => setError(describeError(value)));
  };

  const retry = (sourceId: string) => {
    const id = sessionIdRef.current;
    if (!id) return;
    void api.searchEverywhereRetry(id, sourceId).then(() => {
      clearPollTimer();
      schedulePoll(0, generationRef.current);
    }).catch((value: unknown) => setError(describeError(value)));
  };

  const members = async (memberKey: string, from = 0): Promise<SearchMemberPage> => {
    const id = sessionIdRef.current;
    if (!id) throw new ApiError(t("err.searchNotFound"), 404, "search-not-found", "err.searchNotFound");
    const generation = generationRef.current;
    const answer = await api.searchEverywhereMembers(id, memberKey, from);
    if (generation !== generationRef.current) throw new DOMException(t("err.searchGenerationConflict"), "AbortError");
    return answer;
  };

  const setFocusAnchor = (memberKey: string | null) => {
    setFocusAnchorState(memberKey);
  };

  const markInteracted = () => {
    interactedRef.current = true;
  };

  const setScrollTop = (value: number) => {
    setScrollTopState(value);
  };

  commitRef.current = (value) => {
    if (value.trim()) startSearch(value, true);
    else resetSession();
  };

  useEffect(() => {
    if (!options.active || preferencesRequested.current) return;
    preferencesRequested.current = true;
    void api.searchPreferences().then((answer) => {
      liveSearchRef.current = answer.liveSearch;
      setLiveSearch(answer.liveSearch);
      if (answer.liveSearch) liveRef.current?.update(draftRef.current, committedRef.current);
    }).catch(() => {
      liveSearchRef.current = false;
      setLiveSearch(false);
    });
  }, [options.active]);

  useEffect(() => {
    if (!options.active && !options.covered) {
      if (sessionIdRef.current !== null || committedRef.current || draftRef.current || snapshotRef.current) resetSession();
      else pausePolling();
    } else if (options.active && !options.covered) {
      schedulePoll(0, generationRef.current);
    } else {
      pausePolling();
    }
  }, [options.active, options.covered]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") pausePolling();
      else schedulePoll(0, generationRef.current);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => () => {
    generationRef.current += 1;
    abortRequests();
    deleteSession();
  }, []);

  // Closing or reloading the page ends its search on the way out instead of leaving the session
  // to expire; the delete is a keepalive request, so it still leaves while the page goes.
  useEffect(() => {
    const onPageHide = () => deleteSession();
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  return {
    draft,
    setDraft,
    compositionStart,
    compositionEnd,
    committed,
    submit,
    clear,
    sources,
    setSources,
    scope,
    setScope,
    kind,
    setKind,
    snapshot,
    previousQuery,
    order,
    unidentifiedOrder,
    loadMore,
    retry,
    members,
    liveSearch,
    error,
    focusAnchor,
    setFocusAnchor,
    markInteracted,
    scrollTop,
    setScrollTop,
  };
}

export type SearchEverywhereController = ReturnType<typeof useSearchEverywhere>;
