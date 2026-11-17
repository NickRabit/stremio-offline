import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api } from "./api";
import { report } from "./diagnostics";
import { freshPrefetch } from "./next-prefetch";
import { isLocalStream } from "./streams";
import type { Stream, Subtitle } from "./types";

interface TitleSourcesOptions {
  setBusy(busy: boolean): void;
  fail(error: unknown): void;
}

export interface SourcePrefetch {
  id: string;
  at: number;
  promise: Promise<{ streams: Stream[]; subtitles: Subtitle[] }>;
}

export interface TitleSources {
  streams: Stream[];
  localStreams: Stream[];
  localLoading: boolean;
  subtitles: Subtitle[];
  sourcesLoaded: boolean;
  sourcesComplete: boolean;
  pendingSources: number;
  setStreams: Dispatch<SetStateAction<Stream[]>>;
  setLocalStreams: Dispatch<SetStateAction<Stream[]>>;
  setLocalLoading: Dispatch<SetStateAction<boolean>>;
  setSubtitles: Dispatch<SetStateAction<Subtitle[]>>;
  setSourcesLoaded: Dispatch<SetStateAction<boolean>>;
  setPendingSources: Dispatch<SetStateAction<number>>;
  begin(): number;
  current(): number;
  isCurrent(token: number): boolean;
  invalidate(): void;
  load(type: string, id: string, token: number): Promise<void>;
  resetRows(): void;
  resetSources(): void;
  resetParts(): void;
  resetEpisode(): void;
  dropWork(): void;
  episodeSources(type: string, id: string): Promise<{ streams: Stream[]; subtitles: Subtitle[] }>;
  loadStreamPart(type: string, id: string, source: { key: string; name: string }): Promise<Stream[]>;
  prefetchedEpisode(id: string): SourcePrefetch | null;
  prefetchEpisode(type: string, id: string): void;
  subtitlesReady(): Promise<void>;
}

export function useTitleSources(options: TitleSourcesOptions): TitleSources {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [streams, setStreams] = useState<Stream[]>([]);
  const [localStreams, setLocalStreams] = useState<Stream[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [sourcesLoaded, setSourcesLoaded] = useState(false);
  const [sourcesComplete, setSourcesComplete] = useState(false);
  const [pendingSources, setPendingSources] = useState(0);

  const sourcesRequestRef = useRef(0);
  const subtitlesReadyRef = useRef<Promise<unknown>>(Promise.resolve());
  const nextEpisodePrefetchRef = useRef<SourcePrefetch | null>(null);
  const sourcesBusyRef = useRef(false);

  const begin = useCallback(() => ++sourcesRequestRef.current, []);
  const current = useCallback(() => sourcesRequestRef.current, []);
  const isCurrent = useCallback((token: number) => token === sourcesRequestRef.current, []);
  const invalidate = useCallback(() => { sourcesRequestRef.current += 1; }, []);

  const resetRows = useCallback(() => {
    setStreams([]); setLocalStreams([]); setLocalLoading(false);
  }, []);
  const resetSources = useCallback(() => {
    setStreams([]); setLocalStreams([]); setLocalLoading(false); setSubtitles([]); setSourcesLoaded(false); setSourcesComplete(false);
  }, []);
  const resetParts = useCallback(() => {
    setSourcesLoaded(false); setSourcesComplete(false); setPendingSources(0);
    setStreams([]); setLocalStreams([]); setLocalLoading(false); setSubtitles([]);
  }, []);
  const resetEpisode = useCallback(() => {
    setStreams([]); setLocalStreams([]); setLocalLoading(false); setSubtitles([]); setPendingSources(0);
  }, []);

  /** One addon's answer, with a failure turned into nothing. */
  const loadStreamPart = useCallback(async (type: string, id: string, source: { key: string; name: string }) => {
    try { return await api.streams(type, id, source.key); }
    catch (error) {
      // One unreachable addon must neither bring the rest down nor flood the screen with errors.
      report("WARN", `Sources from the addon could not be loaded: ${source.name}`, { addon: source.name, reason: error instanceof Error ? error.message : String(error) });
      return [] as Stream[];
    }
  }, []);

  /** Drops what a superseded or closed sources fetch left switched on. `busy` is shared with the
   *  catalogue's own loading, so only a fetch that set it clears it here. */
  const dropWork = useCallback(() => {
    if (!sourcesBusyRef.current) return;
    sourcesBusyRef.current = false;
    optionsRef.current.setBusy(false); setPendingSources(0); setLocalLoading(false);
  }, []);

  /** Each addon is asked separately, so results show up as they arrive instead of waiting for the slowest. */
  const load = useCallback(async (type: string, id: string, token: number) => {
    const stale = () => !isCurrent(token);
    sourcesBusyRef.current = true;
    setSourcesLoaded(false); setSourcesComplete(false); optionsRef.current.setBusy(true);
    setStreams([]); setLocalStreams([]); setLocalLoading(false); setSubtitles([]); setPendingSources(0);
    // Local copies are asked for beside the addons and outside the try: an addon or subtitle
    // failure must not drop them.
    setLocalLoading(true);
    void api.localStreams(type, id)
      .then((found) => { if (!stale()) setLocalStreams(found.filter(isLocalStream)); })
      .catch(() => undefined)
      .finally(() => { if (!stale()) setLocalLoading(false); });
    // Subtitles never hold up the sources; a play waits for them instead (startCatalogPlayback),
    // because the server binds a film's addon subtitles to the session it starts.
    subtitlesReadyRef.current = api.subtitles(type, id)
      .then((next) => { if (!stale()) setSubtitles(next); })
      .catch(() => undefined);
    try {
      const sources = await api.streamSources(type, id);
      if (stale()) return;
      setSourcesLoaded(true); optionsRef.current.setBusy(false); sourcesBusyRef.current = false; setPendingSources(sources.length);
      await Promise.all(sources.map(async (source) => {
        const part = await loadStreamPart(type, id, source);
        if (!stale() && part.length) setStreams((previous) => [...previous, ...part]);
        if (!stale()) setPendingSources((count) => count - 1);
      }));
      // Every provider has answered: the shared detail may take these rows instead of asking again.
      if (!stale()) setSourcesComplete(true);
    } catch (error) { if (!stale()) { optionsRef.current.fail(error); setSourcesLoaded(true); } }
    finally { if (!stale()) { optionsRef.current.setBusy(false); sourcesBusyRef.current = false; } }
  }, [isCurrent, loadStreamPart]);

  const episodeSources = useCallback(async (type: string, id: string) => {
    const [sources, nextSubtitles] = await Promise.all([api.streamSources(type, id), api.subtitles(type, id).catch(() => [] as Subtitle[])]);
    const parts = await Promise.all(sources.map((source) => loadStreamPart(type, id, source)));
    return { streams: parts.flat(), subtitles: nextSubtitles };
  }, [loadStreamPart]);

  const prefetchedEpisode = useCallback((id: string) => {
    const prefetched = freshPrefetch(nextEpisodePrefetchRef.current);
    return prefetched?.id === id ? prefetched : null;
  }, []);
  const prefetchEpisode = useCallback((type: string, id: string) => {
    const promise = episodeSources(type, id);
    // The viewer may never ask for this one, and nobody would be waiting to hear it failed.
    void promise.catch(() => undefined);
    nextEpisodePrefetchRef.current = { id, at: Date.now(), promise };
  }, [episodeSources]);

  const subtitlesReady = useCallback(async () => {
    await subtitlesReadyRef.current;
  }, []);

  return {
    streams,
    localStreams,
    localLoading,
    subtitles,
    sourcesLoaded,
    sourcesComplete,
    pendingSources,
    setStreams,
    setLocalStreams,
    setLocalLoading,
    setSubtitles,
    setSourcesLoaded,
    setPendingSources,
    begin,
    current,
    isCurrent,
    invalidate,
    load,
    resetRows,
    resetSources,
    resetParts,
    resetEpisode,
    dropWork,
    episodeSources,
    loadStreamPart,
    prefetchedEpisode,
    prefetchEpisode,
    subtitlesReady,
  };
}
