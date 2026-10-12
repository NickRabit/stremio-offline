import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, ChevronLeft, ChevronRight, CirclePlay, Film, Search, Star } from "lucide-react";
import { ApiError, api, describeError } from "./api";
import { t, useI18n } from "./i18n";
import { Player } from "./Player";
import { TileArt } from "./TileArt";
import type { LibraryType, MediaServerProvider, RemoteItem, RemoteItemState, RemoteLibrary, Stream } from "./types";

interface Props {
  audioLanguage: string; subtitleLanguage: string; onError: (error: unknown) => void;
  /** The item this browser should open once its libraries are known; a new nonce opens it again. */
  initialTarget?: { libraryId: string; itemId: string; nonce: number };
  /** A favourite, a watched flag or a position changed here, so Home and the shelf re-read. */
  onPersonalChange?: () => void;
}

type Filter = "all" | "movie" | "series";
type BucketKey = "movie" | "series";
type Bucket = { items: RemoteItem[]; cursor?: string; total: number; loading: boolean; error: string };
type Playing = { stream: Stream; libraryId: string; item: RemoteItem; title: string; favorite: boolean };

const emptyBucket = (): Bucket => ({ items: [], total: 0, loading: false, error: "" });
const aborted = (error: unknown) => error instanceof DOMException && error.name === "AbortError";
const isStale = (error: unknown) => error instanceof ApiError && (error.status === 409 || error.messageKey === "err.mediaServerStale");

const providerKey = (provider: MediaServerProvider) =>
  provider === "emby" ? "mediaServer.provider.emby" as const : "mediaServer.provider.jellyfin" as const;
const libraryTypeKey = (type: LibraryType) =>
  type === "movie" ? "mediaServer.type.movie" as const : type === "series" ? "mediaServer.type.series" as const : "library.libraryTypeMixed" as const;

const sourceLabel = (stream: Stream) => stream.name || stream.title || stream.description || stream.sourceId;
/** Carry-over key: the provider's version name alone, so a title or a library label can never match. */
const versionKey = (stream: Stream) => stream.name?.trim() ?? "";
const defaultPick = (streams: Stream[]) => streams.find((stream) => stream.playable) ?? streams[0] ?? null;

const episodeOrder = (left: RemoteItem, right: RemoteItem) =>
  (left.season ?? 0) - (right.season ?? 0) || (left.episode ?? 0) - (right.episode ?? 0) || left.name.localeCompare(right.name);

const groupEpisodes = (items: RemoteItem[]) => {
  const groups = new Map<number, RemoteItem[]>();
  for (const item of [...items].sort(episodeOrder)) {
    const season = item.season ?? 0;
    const list = groups.get(season);
    if (list) list.push(item); else groups.set(season, [item]);
  }
  return [...groups.entries()].map(([season, group]) => ({ season, items: group }));
};

export function RemoteLibraryBrowser({ audioLanguage, subtitleLanguage, onError, initialTarget, onPersonalChange }: Props) {
  useI18n();
  const [libraries, setLibraries] = useState<RemoteLibrary[] | null>(null);
  const [librariesError, setLibrariesError] = useState("");
  const [selected, setSelected] = useState<RemoteLibrary | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [nonce, setNonce] = useState(0);
  const [buckets, setBuckets] = useState<Record<BucketKey, Bucket>>({ movie: emptyBucket(), series: emptyBucket() });
  const [detail, setDetail] = useState<RemoteItem | null>(null);
  const [series, setSeries] = useState<RemoteItem | null>(null);
  const [episodes, setEpisodes] = useState<{ items: RemoteItem[]; cursor?: string; loading: boolean; error: string }>({ items: [], loading: false, error: "" });
  const [episodeNonce, setEpisodeNonce] = useState(0);
  const [sources, setSources] = useState<Stream[] | null>(null);
  const [sourceError, setSourceError] = useState("");
  const [selectedSource, setSelectedSource] = useState<Stream | null>(null);
  const [state, setState] = useState<RemoteItemState | null>(null);
  const [stateError, setStateError] = useState("");
  const [detailNonce, setDetailNonce] = useState(0);
  const [playing, setPlaying] = useState<Playing | null>(null);
  const [nextBusy, setNextBusy] = useState(false);
  const [targetError, setTargetError] = useState("");
  const [targetAttempt, setTargetAttempt] = useState(0);

  const listEpoch = useRef(0);
  const episodeEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const handoffEpoch = useRef(0);
  const targetEpoch = useRef(0);
  const librariesEpoch = useRef(0);
  const librariesAbort = useRef<AbortController | null>(null);
  const itemsMoreAbort = useRef<AbortController | null>(null);
  const episodesMoreAbort = useRef<AbortController | null>(null);
  const handoffAbort = useRef<AbortController | null>(null);
  /** The streams a hand-off already fetched, so the panel does not scan the same item twice. */
  const handoffStreams = useRef<{ itemId: string; streams: Stream[]; selected: Stream | null } | null>(null);
  /** Set when a version was chosen by hand or by a hand-off, so a late state read never moves it. */
  const explicitPick = useRef(false);
  const selectedRef = useRef<RemoteLibrary | null>(null);
  const detailRef = useRef<RemoteItem | null>(null);
  const playingRef = useRef<Playing | null>(null);
  selectedRef.current = selected;
  detailRef.current = detail;
  playingRef.current = playing;

  const cancelItemsMore = () => { itemsMoreAbort.current?.abort(); itemsMoreAbort.current = null; };
  const cancelEpisodesMore = () => { episodesMoreAbort.current?.abort(); episodesMoreAbort.current = null; };
  const cancelHandoff = () => {
    handoffEpoch.current += 1;
    handoffAbort.current?.abort();
    handoffAbort.current = null;
    setNextBusy(false);
  };

  const loadLibraries = async () => {
    librariesAbort.current?.abort();
    const controller = new AbortController();
    librariesAbort.current = controller;
    const epoch = ++librariesEpoch.current;
    setLibrariesError("");
    try {
      const rows = await api.remoteLibraries({ signal: controller.signal });
      if (epoch !== librariesEpoch.current || controller.signal.aborted) return;
      setLibraries(rows);
    } catch (error) {
      if (epoch !== librariesEpoch.current || controller.signal.aborted || aborted(error)) return;
      setLibrariesError(describeError(error));
    }
  };
  useEffect(() => { void loadLibraries(); }, []);

  // A cold shared index refuses two scans at once, so "All" walks the two types one after the
  // other; every await re-checks the epoch, and the sequence's own abort ends both.
  useEffect(() => {
    const library = selected;
    if (!library) return;
    const epoch = ++listEpoch.current;
    const controller = new AbortController();
    cancelItemsMore();
    const kinds: BucketKey[] = filter === "all" ? ["movie", "series"] : [filter];
    setBuckets(() => {
      const next: Record<BucketKey, Bucket> = { movie: emptyBucket(), series: emptyBucket() };
      for (const kind of kinds) next[kind] = { ...next[kind], loading: true };
      return next;
    });
    const read = async (kind: BucketKey) => {
      try {
        const page = await api.remoteItems(library.id, { type: kind, limit: 100, search: query || undefined, signal: controller.signal });
        if (epoch !== listEpoch.current) return;
        setBuckets((current) => ({ ...current, [kind]: { items: page.items, cursor: page.cursor, total: page.total, loading: false, error: "" } }));
      } catch (error) {
        if (epoch !== listEpoch.current || controller.signal.aborted || aborted(error)) return;
        setBuckets((current) => ({ ...current, [kind]: { ...current[kind], loading: false, error: describeError(error) } }));
      }
    };
    void (async () => { for (const kind of kinds) { if (epoch !== listEpoch.current) return; await read(kind); } })();
    return () => { controller.abort(); if (listEpoch.current === epoch) listEpoch.current += 1; cancelItemsMore(); };
  }, [selected, filter, query, nonce]);

  useEffect(() => {
    const library = selected;
    if (!library || !series) return;
    const epoch = ++episodeEpoch.current;
    const controller = new AbortController();
    cancelEpisodesMore();
    setEpisodes({ items: [], loading: true, error: "" });
    void api.remoteEpisodes(library.id, series.id, { limit: 100, signal: controller.signal })
      .then((page) => {
        if (epoch !== episodeEpoch.current) return;
        setEpisodes({ items: page.items, cursor: page.cursor, loading: false, error: "" });
      })
      .catch((error) => {
        if (epoch !== episodeEpoch.current || controller.signal.aborted || aborted(error)) return;
        setEpisodes({ items: [], loading: false, error: describeError(error) });
      });
    return () => { controller.abort(); if (episodeEpoch.current === epoch) episodeEpoch.current += 1; cancelEpisodesMore(); };
  }, [selected, series, episodeNonce]);

  useEffect(() => {
    const library = selected;
    if (!library || !detail || detail.type === "series") return;
    const epoch = ++detailEpoch.current;
    const itemId = detail.id;
    const controller = new AbortController();
    const handoff = handoffStreams.current?.itemId === itemId ? handoffStreams.current : null;
    handoffStreams.current = null;
    const live = () => epoch === detailEpoch.current && selectedRef.current?.id === library.id && detailRef.current?.id === itemId;
    explicitPick.current = false;
    let streams: Stream[] | null = handoff?.streams ?? null;
    let saved: RemoteItemState | null = null;
    let gotSources = Boolean(handoff);
    let gotState = false;
    // Waits for both answers and prefers the version last played; a late read never moves a pick.
    const settle = () => {
      if (!gotSources || !gotState || !live() || explicitPick.current || !streams) return;
      const wanted = saved?.mediaSourceId;
      const match = wanted ? streams.find((stream) => stream.remoteItem?.mediaSourceId === wanted) : undefined;
      const next = match ?? defaultPick(streams);
      if (next) setSelectedSource((current) => current ?? next);
    };
    setSources(streams);
    setSourceError("");
    setState(null);
    setStateError("");
    setSelectedSource(handoff?.selected ?? null);
    if (handoff?.selected) explicitPick.current = true;
    if (!handoff) {
      void api.remoteSources(library.id, itemId, controller.signal)
        .then((found) => {
          if (!live()) return;
          streams = found;
          setSources(found);
          gotSources = true;
          settle();
        })
        .catch((error) => {
          if (!live() || controller.signal.aborted || aborted(error)) return;
          setSourceError(describeError(error));
        });
    }
    void api.remoteState(library.id, itemId, controller.signal)
      .then((value) => {
        if (!live()) return;
        saved = value;
        setState(value);
        gotState = true;
        settle();
      })
      .catch((error) => {
        if (!live() || controller.signal.aborted || aborted(error)) return;
        setStateError(describeError(error));
        gotState = true;
        settle();
      });
    return () => { controller.abort(); if (detailEpoch.current === epoch) detailEpoch.current += 1; };
  }, [selected, detail, detailNonce]);

  useEffect(() => () => { cancelItemsMore(); cancelEpisodesMore(); handoffAbort.current?.abort(); librariesAbort.current?.abort(); }, []);

  // Opens a card's item directly; an episode also gets its verified parent series for next/previous.
  useEffect(() => {
    const target = initialTarget;
    if (!target || !libraries) return;
    const library = libraries.find((row) => row.id === target.libraryId);
    if (!library) { setTargetError(t("mediaServer.itemUnavailable")); return; }
    setTargetError("");
    const epoch = ++targetEpoch.current;
    const controller = new AbortController();
    openLibrary(library);
    void api.remoteItem(library.id, target.itemId, controller.signal)
      .then(({ item }) => {
        if (epoch !== targetEpoch.current) return;
        if (item.type === "series") { setSeries(item); setDetail(item); return; }
        setDetail(item);
        if (item.type !== "episode" || !item.seriesId) return;
        void api.remoteItem(library.id, item.seriesId, controller.signal)
          .then(({ item: parent }) => { if (epoch === targetEpoch.current && parent.type === "series") setSeries(parent); })
          .catch(() => undefined);
      })
      .catch((value) => { if (epoch === targetEpoch.current && !aborted(value)) setTargetError(t("mediaServer.itemUnavailable")); });
    return () => controller.abort();
  }, [initialTarget?.libraryId, initialTarget?.itemId, initialTarget?.nonce, targetAttempt, libraries]);

  useEffect(() => {
    const current = playingRef.current;
    if (!state || !current || detailRef.current?.id !== current.item.id || selectedRef.current?.id !== current.libraryId || state.favorite === current.favorite) return;
    setPlaying((value) => value && value.libraryId === current.libraryId && value.item.id === current.item.id ? { ...value, favorite: state.favorite } : value);
  }, [state]);

  const openLibrary = (library: RemoteLibrary) => {
    cancelItemsMore();
    cancelEpisodesMore();
    cancelHandoff();
    setSelected(library);
    setFilter("all");
    setSearchInput("");
    setQuery("");
    setNonce(0);
    setDetail(null);
    setSeries(null);
    setSources(null);
    setState(null);
    setSelectedSource(null);
  };
  const closeLibrary = () => {
    cancelItemsMore();
    cancelEpisodesMore();
    cancelHandoff();
    setSelected(null);
    setDetail(null);
    setSeries(null);
    setSources(null);
    setState(null);
    setSelectedSource(null);
    setSearchInput("");
    setQuery("");
  };
  const stepBack = () => {
    cancelHandoff();
    if (detail) {
      if (detail.type === "episode" && series) { setDetail(series); return; }
      setDetail(null);
      setSeries(null);
      return;
    }
    closeLibrary();
  };
  const openItem = (item: RemoteItem) => {
    cancelItemsMore();
    cancelHandoff();
    if (item.type === "series") { setSeries(item); setDetail(item); setSources(null); setState(null); setSelectedSource(null); return; }
    setSeries(null);
    setDetail(item);
  };
  const openEpisode = (episode: RemoteItem) => {
    cancelEpisodesMore();
    cancelHandoff();
    setDetail(episode);
  };
  const submitSearch = (event: FormEvent) => { event.preventDefault(); setQuery(searchInput.trim()); };
  const clearSearch = () => { setSearchInput(""); setQuery(""); };
  const retryListing = () => setNonce((value) => value + 1);
  const retryEpisodes = () => setEpisodeNonce((value) => value + 1);
  const retryDetail = () => setDetailNonce((value) => value + 1);

  const loadMoreItems = async () => {
    const library = selectedRef.current;
    if (!library) return;
    const epoch = listEpoch.current;
    const kinds: BucketKey[] = filter === "all" ? ["movie", "series"] : [filter];
    for (const kind of kinds) {
      const cursor = buckets[kind].cursor;
      if (!cursor) continue;
      const controller = new AbortController();
      itemsMoreAbort.current?.abort();
      itemsMoreAbort.current = controller;
      setBuckets((current) => ({ ...current, [kind]: { ...current[kind], loading: true } }));
      try {
        const page = await api.remoteItems(library.id, { type: kind, limit: 100, search: query || undefined, cursor, signal: controller.signal });
        if (epoch !== listEpoch.current || controller.signal.aborted) return;
        setBuckets((current) => ({ ...current, [kind]: { items: [...current[kind].items, ...page.items], cursor: page.cursor, total: page.total, loading: false, error: "" } }));
      } catch (error) {
        if (epoch !== listEpoch.current || controller.signal.aborted || aborted(error)) return;
        // A cursor from another snapshot restarts the listing instead of mixing two pages.
        setBuckets((current) => ({ ...current, [kind]: { ...current[kind], loading: false, error: describeError(error), cursor: isStale(error) ? undefined : cursor } }));
      }
    }
  };
  const loadEpisodes = async () => {
    const library = selectedRef.current;
    const heading = series;
    if (!library || !heading || !episodes.cursor) return;
    const epoch = episodeEpoch.current;
    const cursor = episodes.cursor;
    const controller = new AbortController();
    episodesMoreAbort.current?.abort();
    episodesMoreAbort.current = controller;
    setEpisodes((current) => ({ ...current, loading: true }));
    try {
      const page = await api.remoteEpisodes(library.id, heading.id, { limit: 100, cursor, signal: controller.signal });
      if (epoch !== episodeEpoch.current || controller.signal.aborted) return;
      setEpisodes((current) => ({ items: [...current.items, ...page.items], cursor: page.cursor, loading: false, error: "" }));
    } catch (error) {
      if (epoch !== episodeEpoch.current || controller.signal.aborted || aborted(error)) return;
      setEpisodes((current) => ({ ...current, loading: false, error: describeError(error), cursor: isStale(error) ? undefined : cursor }));
    }
  };

  const toggleState = async (patch: { favorite?: boolean; watched?: boolean }) => {
    const library = selectedRef.current;
    const item = detailRef.current;
    if (!library || !item || item.type === "series" || !state) return;
    const epoch = detailEpoch.current;
    try {
      const saved = await api.saveRemoteState(library.id, item.id, patch);
      if (epoch !== detailEpoch.current || detailRef.current?.id !== item.id || selectedRef.current?.id !== library.id) return;
      setState(saved);
      setStateError("");
      onPersonalChange?.();
    } catch (error) { onError(error); }
  };
  const togglePlayingFavorite = async () => {
    const current = playingRef.current;
    if (!current) return;
    try {
      const saved = await api.saveRemoteState(current.libraryId, current.item.id, { favorite: !current.favorite });
      setPlaying((value) => value && value.libraryId === current.libraryId && value.item.id === current.item.id ? { ...value, favorite: saved.favorite } : value);
      if (selectedRef.current?.id === current.libraryId && detailRef.current?.id === current.item.id) setState(saved);
      onPersonalChange?.();
    } catch (error) { onError(error); }
  };
  const refreshState = async () => {
    const library = selectedRef.current;
    const item = detailRef.current;
    if (!library || !item || item.type === "series") return;
    const epoch = detailEpoch.current;
    try {
      const saved = await api.remoteState(library.id, item.id);
      if (epoch !== detailEpoch.current || detailRef.current?.id !== item.id || selectedRef.current?.id !== library.id) return;
      setState(saved);
      setStateError("");
      onPersonalChange?.();
    } catch { /* the panel keeps the state it had */ }
  };

  const sequence = [...episodes.items].sort(episodeOrder);
  const episodeTitle = (item: RemoteItem) =>
    `${t("mediaServer.episodeLabel", { season: item.season ?? 0, episode: item.episode ?? 0 })} · ${item.name}`;
  const playIndex = playing ? sequence.findIndex((item) => item.id === playing.item.id) : -1;
  const playPrevious = playIndex > 0 ? sequence[playIndex - 1] : null;
  const playNext = playIndex >= 0 && playIndex < sequence.length - 1 ? sequence[playIndex + 1] : null;

  /** Hand-off: the running player is left alone until a same-named version of the next episode
   *  is in hand; without one it stops and the panel asks for an explicit play. */
  const changeEpisode = async (episode: RemoteItem) => {
    const library = selectedRef.current;
    const current = playingRef.current;
    if (!library || !current) return false;
    const epoch = ++handoffEpoch.current;
    handoffAbort.current?.abort();
    const controller = new AbortController();
    handoffAbort.current = controller;
    const live = () => epoch === handoffEpoch.current
      && selectedRef.current?.id === library.id
      && playingRef.current?.libraryId === library.id
      && playingRef.current?.item.id === current.item.id
      && playingRef.current?.stream.sourceId === current.stream.sourceId;
    setNextBusy(true);
    try {
      const streams = await api.remoteSources(library.id, episode.id, controller.signal);
      if (!live()) return false;
      const wanted = versionKey(current.stream);
      const pick = wanted ? streams.find((stream) => versionKey(stream) === wanted) ?? null : null;
      handoffStreams.current = { itemId: episode.id, streams, selected: pick };
      if (!pick) {
        setPlaying(null);
        setDetail(episode);
        return true;
      }
      setPlaying({ stream: pick, libraryId: library.id, item: episode, title: episodeTitle(episode), favorite: false });
      setDetail(episode);
      return true;
    } catch (error) {
      if (epoch === handoffEpoch.current && !aborted(error)) onError(error);
      return false;
    } finally {
      if (epoch === handoffEpoch.current) { setNextBusy(false); handoffAbort.current = null; }
    }
  };

  if (!librariesError && !targetError && (libraries === null || !libraries.length)) return null;

  const kinds: BucketKey[] = filter === "all" ? ["movie", "series"] : [filter];
  const rows = kinds.flatMap((kind) => buckets[kind].items);
  const listLoading = kinds.some((kind) => buckets[kind].loading);
  const listError = kinds.map((kind) => buckets[kind].error).find(Boolean) ?? "";
  const hasCursor = kinds.some((kind) => Boolean(buckets[kind].cursor));
  const grouped = groupEpisodes(episodes.items);

  return <section className="remote-libraries" aria-label={t("mediaServer.remoteTitle")}>
    <div className="remote-libraries-head">
      <h3>{t("mediaServer.remoteTitle")}</h3>
      <small>{t("mediaServer.remoteHint")}</small>
    </div>
    {librariesError && <div className="remote-error" role="alert">
      <span>{t("mediaServer.loadFailed")} {librariesError}</span>
      <button type="button" onClick={() => void loadLibraries()}>{t("mediaServer.retry")}</button>
    </div>}
    {targetError && <div className="remote-error" role="alert">
      <span>{targetError}</span>
      <button type="button" onClick={() => setTargetAttempt((value) => value + 1)}>{t("mediaServer.retry")}</button>
    </div>}
    {!selected && libraries && libraries.length > 0 && <div className="remote-library-rows">
      {libraries.map((library) => <button type="button" className="remote-library-row" key={library.id} onClick={() => openLibrary(library)}>
        <span className="remote-library-copy">
          <strong>{library.name}</strong>
          <small>{t(providerKey(library.provider))} · {t(libraryTypeKey(library.type))}</small>
        </span>
        <i className="library-badge">{t("mediaServer.readOnly")}</i>
        <ChevronRight aria-hidden="true"/>
      </button>)}
    </div>}
    {selected && <div className="remote-browser">
      <div className="remote-browser-bar">
        <button type="button" className="library-back" onClick={stepBack}
          aria-label={detail ? t("mediaServer.back") : t("mediaServer.backToLibraries")}
          title={detail ? t("mediaServer.back") : t("mediaServer.backToLibraries")}><ChevronLeft/></button>
        <span className="remote-browser-title">
          <strong>{selected.name}</strong>
          <small>{t(providerKey(selected.provider))} · {t("mediaServer.readOnly")}</small>
        </span>
        {!detail && <form className="remote-search" role="search" onSubmit={submitSearch}>
          <div className="search-input">
            <Search aria-hidden="true"/>
            <input value={searchInput} aria-label={t("mediaServer.searchPlaceholder")} placeholder={t("mediaServer.searchPlaceholder")} onChange={(event) => setSearchInput(event.target.value)}/>
          </div>
          <button type="submit">{t("mediaServer.search")}</button>
          {query && <button type="button" onClick={clearSearch}>{t("mediaServer.clearSearch")}</button>}
        </form>}
        {!detail && <label className="remote-filter">
          <span>{t("mediaServer.filterLabel")}</span>
          <select value={filter} aria-label={t("mediaServer.filterLabel")} onChange={(event) => setFilter(event.target.value as Filter)}>
            <option value="all">{t("common.all")}</option>
            <option value="movie">{t("mediaServer.filterMovies")}</option>
            <option value="series">{t("mediaServer.filterSeries")}</option>
          </select>
        </label>}
      </div>

      {!detail && <div className="remote-list">
        {listError && <div className="remote-error" role="alert">
          <span>{listError}</span>
          <button type="button" onClick={retryListing}>{t("mediaServer.retry")}</button>
        </div>}
        {rows.map((item) => <button type="button" className="remote-item" key={item.id} onClick={() => openItem(item)}>
          <span className="browse-art remote-item-art"><TileArt shape="wide" poster={item.poster} wide={item.wide} fallback={<Film/>}/></span>
          <span>
            <strong>{item.name}</strong>
            <small>{item.type === "movie" ? t("mediaServer.type.movie") : t("mediaServer.type.series")}</small>
          </span>
          <ChevronRight aria-hidden="true"/>
        </button>)}
        {listLoading && !rows.length && <div className="loading" role="status">{t("common.loading")}</div>}
        {!rows.length && !listLoading && !listError && !hasCursor && <p className="identify-hint">{query ? t("mediaServer.emptySearch") : t("mediaServer.emptyItems")}</p>}
        {hasCursor && !listLoading && <div className="load-more"><button type="button" onClick={() => void loadMoreItems()}>{t("common.loadMore")}</button></div>}
        {listLoading && rows.length > 0 && <div className="loading" role="status">{t("common.loadingMore")}</div>}
      </div>}

      {detail && detail.type === "series" && <div className="remote-list">
        <div className="remote-subhead"><h4>{t("mediaServer.episodes")}</h4><span>{detail.name}</span></div>
        {episodes.error && <div className="remote-error" role="alert">
          <span>{episodes.error}</span>
          <button type="button" onClick={retryEpisodes}>{t("mediaServer.retry")}</button>
        </div>}
        {grouped.map((group) => <div className="remote-season-group" key={group.season}>
          <div className="remote-season">{t("mediaServer.seasonLabel", { season: group.season })}</div>
          {group.items.map((episode) => <button type="button" className="remote-item" key={episode.id} onClick={() => openEpisode(episode)}>
            <span className="browse-art remote-item-art"><TileArt shape="wide" poster={episode.poster} wide={episode.wide} fallback={<Film/>}/></span>
            <span>
              <strong>{t("mediaServer.episodeLabel", { season: episode.season ?? 0, episode: episode.episode ?? 0 })} · {episode.name}</strong>
            </span>
            <ChevronRight aria-hidden="true"/>
          </button>)}
        </div>)}
        {episodes.loading && !grouped.length && <div className="loading" role="status">{t("common.loading")}</div>}
        {!episodes.loading && !episodes.error && !grouped.length && !episodes.cursor && <p className="identify-hint">{t("mediaServer.noEpisodes")}</p>}
        {episodes.cursor && !episodes.loading && <div className="load-more"><button type="button" onClick={() => void loadEpisodes()}>{t("common.loadMore")}</button></div>}
        {episodes.loading && grouped.length > 0 && <div className="loading" role="status">{t("common.loadingMore")}</div>}
      </div>}

      {detail && detail.type !== "series" && <div className="remote-detail">
        <div className="remote-subhead">
          <h4>{detail.type === "episode" ? t("mediaServer.episodeLabel", { season: detail.season ?? 0, episode: detail.episode ?? 0 }) : detail.name}</h4>
          <span>{detail.type === "episode" ? detail.name : series?.name ?? ""}</span>
        </div>
        {(detail.poster || detail.wide) && <div className="remote-detail-art"><TileArt shape="wide" poster={detail.poster} wide={detail.wide} fallback={<Film/>}/></div>}
        {stateError && <div className="remote-error" role="alert">
          <span>{stateError}</span>
          <button type="button" onClick={retryDetail}>{t("mediaServer.retry")}</button>
        </div>}
        <div className="remote-detail-actions">
          <button type="button" disabled={!state} aria-pressed={state?.favorite ?? false} onClick={() => void toggleState({ favorite: !(state?.favorite ?? false) })}>
            <Star fill={state?.favorite ? "currentColor" : "none"}/> {t("mediaServer.favorite")}
          </button>
          <button type="button" disabled={!state} aria-pressed={state?.watched ?? false} onClick={() => void toggleState({ watched: !(state?.watched ?? false) })}>
            <Check/> {state?.watched ? t("mediaServer.markUnwatched") : t("mediaServer.markWatched")}
          </button>
          {state?.watched && <i className="library-badge">{t("mediaServer.watched")}</i>}
        </div>
        <p className="identify-hint">{t("mediaServer.localStateNote")}</p>
        <div className="remote-subhead"><h4>{t("mediaServer.versions")}</h4></div>
        {sourceError && <div className="remote-error" role="alert">
          <span>{sourceError}</span>
          <button type="button" onClick={retryDetail}>{t("mediaServer.retry")}</button>
        </div>}
        {sources === null && !sourceError && <div className="loading" role="status">{t("common.loading")}</div>}
        {sources && !sources.length && <><p className="identify-hint">{t("mediaServer.noSources")}</p><p className="identify-hint">{t("mediaServer.noSourcesHint")}</p></>}
        {sources && sources.length > 0 && <>
          <p className="identify-hint">{t("mediaServer.versionsHint")}</p>
          <div className="remote-streams">
            {sources.map((stream) => <button type="button" key={stream.sourceId} className={selectedSource === stream ? "selected" : ""} aria-pressed={selectedSource === stream} onClick={() => { explicitPick.current = true; setSelectedSource(stream); }}>
              <i className="library-badge">{t(providerKey(selected.provider))}</i>
              <span><strong>{sourceLabel(stream)}</strong>{stream.libraryName && <small>{stream.libraryName}</small>}</span>
              {selectedSource === stream && <Check aria-hidden="true"/>}
            </button>)}
          </div>
          <div className="actions remote-play">
            <button className="primary" disabled={!selectedSource} onClick={() => {
              if (!selectedSource) return;
              setPlaying({ stream: selectedSource, libraryId: selected.id, item: detail, title: detail.type === "episode" ? `${series ? `${series.name} · ` : ""}${episodeTitle(detail)}` : detail.name, favorite: state?.favorite ?? false });
            }}><CirclePlay/> {t("player.play")}</button>
          </div>
        </>}
      </div>}
    </div>}
    {playing && <Player
      open
      title={playing.title}
      stream={playing.stream}
      subtitles={[]}
      subtitleLanguage={subtitleLanguage}
      audioLanguage={audioLanguage}
      previousTitle={playPrevious ? episodeTitle(playPrevious) : undefined}
      onPrevious={playPrevious ? () => changeEpisode(playPrevious) : undefined}
      nextTitle={playNext ? episodeTitle(playNext) : undefined}
      onNext={playNext ? () => changeEpisode(playNext) : undefined}
      autoNext={false}
      nextBusy={nextBusy}
      favorite={playing.favorite}
      onToggleFavorite={() => void togglePlayingFavorite()}
      onDownload={async () => false}
      onDeviceDownload={async () => false}
      onClose={() => { cancelHandoff(); setPlaying(null); void refreshState(); }}/>}
  </section>;
}
