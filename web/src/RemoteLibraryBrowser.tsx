import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, CirclePlay, Film, FolderOpen, HardDrive, LayoutGrid, List, Play, RectangleHorizontal, RectangleVertical, Search, SlidersHorizontal, Star } from "lucide-react";
import { ApiError, api, describeError } from "./api";
import { relativeAge } from "./home-cards";
import { localeTag, t, useI18n } from "./i18n";
import { LibraryItem, LibraryItemMenu } from "./library-item";
import { LibraryTile } from "./library-tile";
import { Player } from "./Player";
import { RemoteFolderArt, RemoteLibraryArt, RemoteTileArt } from "./remote-mosaic";
import { createCompactOnScroll } from "./scroll-fold";
import { bytes } from "./settings-ui";
import { TileArt } from "./TileArt";
import type { LibraryType, LibraryViewPrefs, MediaServerProvider, RemoteBrowseMode, RemoteItem, RemoteItemState, RemoteItemType, RemoteLibrary, Stream, TileShape, UserViews } from "./types";

interface Props {
  onRootPresenceChange?: (visible: boolean) => void;
  audioLanguage: string; subtitleLanguage: string; onError: (error: unknown) => void;
  /** The one library tile shape, so a remote tile sits in the same grid as a local one. */
  libraryTileShape: TileShape;
  /** Turns the shared shape over, the way the library toolbar's own switch does. */
  onToggleLibraryShape: () => void;
  /** The stored browsing chrome, so a remote library keeps its sort, order and grid/rows. */
  views: UserViews;
  onPersistPrefs: (libraryId: string, prefs: LibraryViewPrefs) => void;
  /** Raised while a remote library or its detail is open, so the local panel steps aside. */
  onOpenChange: (open: boolean) => void;
  /** The library toolbar's folded state, shared so the remote one folds identically. */
  compact: boolean;
  onCompactChange: (value: boolean) => void;
  /** The item this browser should open once its libraries are known; a new nonce opens it again. */
  initialTarget?: { libraryId: string; itemId: string; nonce: number };
  /** A favourite, a watched flag or a position changed here, so Home and the shelf re-read. */
  onPersonalChange?: () => void;
}

type Status = { items: RemoteItem[]; cursor?: string; total: number; loading: boolean; error: string };
type Playing = { stream: Stream; libraryId: string; item: RemoteItem; title: string; favorite: boolean };
type TileRef = { current: HTMLElement | null };

const PAGE_SIZE = 60;
const emptyStatus = (): Status => ({ items: [], total: 0, loading: false, error: "" });
const aborted = (error: unknown) => error instanceof DOMException && error.name === "AbortError";
const isStale = (error: unknown) => error instanceof ApiError && (error.status === 409 || error.messageKey === "err.mediaServerStale");

const providerKey = (provider: MediaServerProvider) =>
  provider === "emby" ? "mediaServer.provider.emby" as const : "mediaServer.provider.jellyfin" as const;
const libraryTypeKey = (type: LibraryType) =>
  type === "movie" ? "mediaServer.type.movie" as const : type === "series" ? "mediaServer.type.series" as const : "library.libraryTypeMixed" as const;
const itemTypeKey = (type: RemoteItemType) =>
  type === "movie" ? "mediaServer.type.movie" as const
  : type === "series" ? "mediaServer.type.series" as const
  : type === "season" ? "mediaServer.type.season" as const
  : type === "episode" ? "mediaServer.type.episode" as const
  : "mediaServer.type.folder" as const;
/** The stored state of one item, keyed by library and item so two listings never share it. */
const stateKey = (libraryId: string, itemId: string) => `${libraryId}:${itemId}`;
/** A run time in the reader's own units. The client has no shared runtime helper, so the
 *  browser's number formatting supplies the words and no new string is introduced. */
const unitLabel = (unit: "hour" | "minute" | "second", value: number) =>
  new Intl.NumberFormat(localeTag(), { style: "unit", unit, unitDisplay: "narrow" }).format(value);
const runtimeLabel = (ticks?: number): string | undefined => {
  if (!ticks || ticks <= 0) return undefined;
  const seconds = Math.round(ticks / 10_000_000);
  if (seconds < 60) return unitLabel("second", seconds);
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return unitLabel("minute", minutes);
  const rest = minutes % 60;
  return rest ? `${unitLabel("hour", Math.floor(minutes / 60))} ${unitLabel("minute", rest)}` : unitLabel("hour", Math.floor(minutes / 60));
};
/** A remote tile's line: when it was made, how long it runs, and what it is. */
const itemMetaLine = (item: RemoteItem) => {
  const playable = item.type === "movie" || item.type === "episode";
  return [item.year, playable ? runtimeLabel(item.durationTicks) : undefined, t(itemTypeKey(item.type))].filter(Boolean).join(" · ");
};
/** The extra facts a remote detail adds, all from normalized fields, nothing guessed. */
const itemFacts = (item: RemoteItem) => {
  const added = item.addedAt && Number.isFinite(Date.parse(item.addedAt))
    ? relativeAge(item.addedAt, Date.now(), localeTag()) : undefined;
  return [item.year, runtimeLabel(item.durationTicks), item.size ? bytes(item.size) : undefined, added].filter(Boolean).join(" · ");
};
/** Mixed libraries keep the provider's folders; a library of one medium flattens to titles. */
const effectiveMode = (library: RemoteLibrary): RemoteBrowseMode =>
  library.browseMode ?? (library.type === "mixed" ? "folders" : "titles");
const sortFor = (sort: LibraryViewPrefs["sort"]): RemoteItemSort =>
  sort === "added" || sort === "size" ? sort : "name";
type RemoteItemSort = "name" | "added" | "size";
const defaultPrefs = (): LibraryViewPrefs => ({ sort: "name", order: "asc", favoritesOnly: false, view: "grid" });

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

export function RemoteLibraryBrowser({ onRootPresenceChange, audioLanguage, subtitleLanguage, onError, libraryTileShape, onToggleLibraryShape, views, onPersistPrefs, onOpenChange, compact, onCompactChange, initialTarget, onPersonalChange }: Props) {
  useI18n();
  const [libraries, setLibraries] = useState<RemoteLibrary[] | null>(null);
  const [librariesError, setLibrariesError] = useState("");
  const [selected, setSelected] = useState<RemoteLibrary | null>(null);
  const [stack, setStack] = useState<RemoteItem[]>([]);
  const [listing, setListing] = useState<Status>(emptyStatus);
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<RemoteItemSort>("name");
  const [desc, setDesc] = useState(false);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [nonce, setNonce] = useState(0);
  const [detail, setDetail] = useState<RemoteItem | null>(null);
  const [series, setSeries] = useState<RemoteItem | null>(null);
  const [episodes, setEpisodes] = useState<Status>(emptyStatus);
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
  /** The one overflow menu that may be open, its item's state and how that read went. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [menuState, setMenuState] = useState<RemoteItemState | null>(null);
  const [menuLoading, setMenuLoading] = useState(false);
  const [menuError, setMenuError] = useState("");
  const [menuBusy, setMenuBusy] = useState(false);
  /** The last known state of each item, so a tile keeps its badges across a re-render. */
  const [itemStates, setItemStates] = useState<Record<string, RemoteItemState>>({});

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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const pendingRootFocus = useRef<string | null>(null);
  /** The listing offset to put back when a detail closes over it. */
  const savedScroll = useRef(0);
  /** One stable ref per remote tile, so the lazy preview can watch the element it draws. */
  const tileRefs = useRef(new Map<string, TileRef>());
  const [fold] = useState(createCompactOnScroll);
  useEffect(() => { fold.attach(); return fold.dispose; }, [fold]);
  /** The streams a hand-off already fetched, so the panel does not scan the same item twice. */
  const handoffStreams = useRef<{ itemId: string; streams: Stream[]; selected: Stream | null } | null>(null);
  /** Set when a version was chosen by hand or by a hand-off, so a late state read never moves it. */
  const explicitPick = useRef(false);
  const selectedRef = useRef<RemoteLibrary | null>(null);
  const detailRef = useRef<RemoteItem | null>(null);
  const playingRef = useRef<Playing | null>(null);
  const menuEpoch = useRef(0);
  const menuAbort = useRef<AbortController | null>(null);
  selectedRef.current = selected;
  detailRef.current = detail;
  playingRef.current = playing;

  const artRef = (key: string): TileRef => {
    let ref = tileRefs.current.get(key);
    if (!ref) { ref = { current: null }; tileRefs.current.set(key, ref); }
    return ref;
  };
  const cancelItemsMore = () => { itemsMoreAbort.current?.abort(); itemsMoreAbort.current = null; };
  const cancelEpisodesMore = () => { episodesMoreAbort.current?.abort(); episodesMoreAbort.current = null; };
  const cancelHandoff = () => {
    handoffEpoch.current += 1;
    handoffAbort.current?.abort();
    handoffAbort.current = null;
    setNextBusy(false);
  };
  const rememberState = (libraryId: string, itemId: string, value: RemoteItemState) =>
    setItemStates((current) => ({ ...current, [stateKey(libraryId, itemId)]: value }));
  /** Dismiss the menu and cancel whatever it was reading; every navigation does this too. */
  const closeMenu = () => {
    menuEpoch.current += 1;
    menuAbort.current?.abort();
    menuAbort.current = null;
    setMenuFor(null);
    setMenuState(null);
    setMenuError("");
    setMenuLoading(false);
    setMenuBusy(false);
  };
  const toggleItemMenu = (item: RemoteItem) => {
    const library = selectedRef.current;
    if (menuFor === item.id || !library) { closeMenu(); return; }
    menuEpoch.current += 1;
    const epoch = menuEpoch.current;
    menuAbort.current?.abort();
    const controller = new AbortController();
    menuAbort.current = controller;
    setMenuFor(item.id);
    setMenuState(itemStates[stateKey(library.id, item.id)] ?? null);
    setMenuError("");
    setMenuLoading(true);
    setMenuBusy(false);
    // One read per open, never a state call for every tile in the listing.
    void api.remoteState(library.id, item.id, controller.signal)
      .then((value) => {
        if (epoch !== menuEpoch.current || controller.signal.aborted || selectedRef.current?.id !== library.id) return;
        setMenuState(value);
        setMenuLoading(false);
        rememberState(library.id, item.id, value);
      })
      .catch((error) => {
        if (epoch !== menuEpoch.current || controller.signal.aborted || aborted(error)) return;
        setMenuError(describeError(error));
        setMenuLoading(false);
      });
  };
  /** A detail or the player showing the same item takes the saved state too. */
  const syncPersonal = (libraryId: string, itemId: string, saved: RemoteItemState) => {
    if (selectedRef.current?.id === libraryId && detailRef.current?.id === itemId) setState(saved);
    const current = playingRef.current;
    if (current?.libraryId === libraryId && current.item.id === itemId)
      setPlaying((value) => value && value.libraryId === libraryId && value.item.id === itemId ? { ...value, favorite: saved.favorite } : value);
  };
  const writeMenuState = async (patch: { favorite?: boolean; watched?: boolean }) => {
    const library = selectedRef.current;
    const itemId = menuFor;
    if (!library || !itemId) return;
    const epoch = menuEpoch.current;
    setMenuBusy(true);
    try {
      const saved = await api.saveRemoteState(library.id, itemId, patch);
      if (selectedRef.current?.id !== library.id) return;
      rememberState(library.id, itemId, saved);
      syncPersonal(library.id, itemId, saved);
      onPersonalChange?.();
      if (epoch === menuEpoch.current) {
        setMenuState(saved);
        setMenuError("");
      }
    } catch (error) {
      if (epoch === menuEpoch.current) setMenuError(describeError(error));
      onError(error);
    } finally {
      if (epoch === menuEpoch.current) setMenuBusy(false);
    }
  };
  const focusMenuTrigger = (itemId: string) => {
    const container = scrollRef.current;
    if (!container) return;
    const tile = [...container.querySelectorAll<HTMLElement>("[data-remote-id]")].find((node) => node.dataset.remoteId === itemId);
    tile?.querySelector<HTMLButtonElement>(".browse-menu")?.focus();
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
      setLibraries([...rows].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)));
    } catch (error) {
      if (epoch !== librariesEpoch.current || controller.signal.aborted || aborted(error)) return;
      setLibrariesError(describeError(error));
    }
  };
  useEffect(() => { void loadLibraries(); }, []);
  useEffect(() => {
    onRootPresenceChange?.(Boolean(libraries?.length));
    return () => onRootPresenceChange?.(false);
  }, [Boolean(libraries?.length), onRootPresenceChange]);
  useEffect(() => {
    const wanted = selected ? pendingFocus.current : pendingRootFocus.current;
    const container = selected ? scrollRef.current : rootRef.current;
    if (!wanted || !container) return;
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>(".library-open")).find((node) => {
      const tile = node.closest<HTMLElement>("[data-remote-id], [data-path]");
      return tile?.dataset.remoteId === wanted || tile?.dataset.path === wanted;
    });
    if (!button) return;
    button.focus({ preventScroll: false });
    if (selected) pendingFocus.current = null;
    else pendingRootFocus.current = null;
  }, [selected, detail, listing.items, episodes.items]);

  const prefsOf = (libraryId: string): LibraryViewPrefs => views.libraries[libraryId] ?? defaultPrefs();
  const mosaicOn = (library: RemoteLibrary | null) => Boolean(library) && library!.mosaic !== false;
  const mode: RemoteBrowseMode = selected && stack.length ? "folders" : selected ? effectiveMode(selected) : "folders";
  const parentId = stack.length ? stack[stack.length - 1]!.id : undefined;

  // One bounded page per request; a fresh search, sort, folder or library starts the listing over.
  useEffect(() => {
    const library = selected;
    if (!library) return;
    const epoch = ++listEpoch.current;
    const controller = new AbortController();
    cancelItemsMore();
    setListing({ items: [], total: 0, loading: true, error: "" });
    api.remoteBrowse(library.id, { parentId, mode, limit: PAGE_SIZE, search: query || undefined, sort, order: desc ? "desc" : "asc", signal: controller.signal })
      .then((page) => {
        if (epoch !== listEpoch.current) return;
        setListing({ items: page.items, cursor: page.cursor, total: page.total, loading: false, error: "" });
      })
      .catch((error) => {
        if (epoch !== listEpoch.current || controller.signal.aborted || aborted(error)) return;
        setListing({ items: [], total: 0, loading: false, error: describeError(error) });
      });
    return () => { controller.abort(); if (listEpoch.current === epoch) listEpoch.current += 1; cancelItemsMore(); };
  }, [selected, parentId, mode, query, sort, desc, nonce]);

  // Series episodes are one more lazy page of the provider's own listing, not a stored snapshot.
  useEffect(() => {
    const library = selected;
    if (!library || !series) return;
    const epoch = ++episodeEpoch.current;
    const controller = new AbortController();
    cancelEpisodesMore();
    setEpisodes({ items: [], total: 0, loading: true, error: "" });
    api.remoteBrowse(library.id, { parentId: series.id, mode: "titles", type: "episode", limit: PAGE_SIZE, signal: controller.signal })
      .then((page) => {
        if (epoch !== episodeEpoch.current) return;
        setEpisodes({ items: page.items, cursor: page.cursor, total: page.total, loading: false, error: "" });
      })
      .catch((error) => {
        if (epoch !== episodeEpoch.current || controller.signal.aborted || aborted(error)) return;
        setEpisodes({ items: [], total: 0, loading: false, error: describeError(error) });
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
        rememberState(library.id, itemId, value);
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

  // A debounce keeps typing in the search box from firing one provider read per keystroke.
  useEffect(() => {
    const handle = window.setTimeout(() => setQuery(searchInput.trim()), 300);
    return () => window.clearTimeout(handle);
  }, [searchInput]);
  // The listing keeps its offset while a detail is open over it; the panel is restored after.
  useEffect(() => {
    if (detail || !scrollRef.current || !savedScroll.current) return;
    scrollRef.current.scrollTop = savedScroll.current;
  }, [detail]);
  useEffect(() => () => {
    cancelItemsMore();
    cancelEpisodesMore();
    handoffAbort.current?.abort();
    menuAbort.current?.abort();
    librariesAbort.current?.abort();
    // The page that draws the local listing may outlive this browser; make sure it comes back.
    onOpenChange(false);
  }, []);

  // A remote card from Home or Favourites opens its item in the native browser.
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

  // A menu belongs to the listing it was opened on: a new library, folder, query, sort or detail
  // dismisses it, so its state read and its writes can never belong to a listing that is gone.
  useEffect(() => { closeMenu(); }, [selected, parentId, mode, query, sort, desc, nonce, detail]);

  const openLibrary = (library: RemoteLibrary) => {
    closeMenu();
    cancelItemsMore();
    cancelEpisodesMore();
    cancelHandoff();
    const prefs = prefsOf(library.id);
    setSelected(library);
    setStack([]);
    setSearchInput("");
    setQuery("");
    setSort(sortFor(prefs.sort));
    setDesc(prefs.order === "desc");
    setView(prefs.view);
    setNonce(0);
    setListing(emptyStatus());
    setDetail(null);
    setSeries(null);
    setSources(null);
    setState(null);
    setSelectedSource(null);
    savedScroll.current = 0;
    onOpenChange(true);
  };
  const closeLibrary = () => {
    closeMenu();
    pendingRootFocus.current = selected?.id ?? null;
    cancelItemsMore();
    cancelEpisodesMore();
    cancelHandoff();
    setSelected(null);
    setStack([]);
    setListing(emptyStatus());
    setDetail(null);
    setSeries(null);
    setSources(null);
    setState(null);
    setSelectedSource(null);
    setSearchInput("");
    setQuery("");
    savedScroll.current = 0;
    onOpenChange(false);
  };
  const stepBack = () => {
    closeMenu();
    cancelHandoff();
    if (detail) {
      pendingFocus.current = detail.id;
      if (detail.type === "episode" && series) { setDetail(series); return; }
      setDetail(null);
      setSeries(null);
      return;
    }
    if (stack.length) {
      pendingFocus.current = stack[stack.length - 1]!.id;
      setDetail(null); setSeries(null); setSearchInput(""); setQuery(""); setStack(stack.slice(0, -1)); return;
    }
    closeLibrary();
  };
  const openItem = (item: RemoteItem) => {
    closeMenu();
    cancelItemsMore();
    cancelHandoff();
    if (item.type === "folder" || item.type === "season") {
      savedScroll.current = 0;
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
      setDetail(null);
      setSeries(null);
      setSearchInput("");
      setQuery("");
      setStack([...stack, item]);
      return;
    }
    savedScroll.current = scrollRef.current?.scrollTop ?? 0;
    if (item.type === "series") { setSeries(item); setDetail(item); setSources(null); setState(null); setSelectedSource(null); return; }
    setSeries(null);
    setDetail(item);
  };
  const openEpisode = (episode: RemoteItem) => {
    closeMenu();
    cancelEpisodesMore();
    cancelHandoff();
    savedScroll.current = scrollRef.current?.scrollTop ?? 0;
    setDetail(episode);
  };
  const goToFolder = (index: number) => {
    closeMenu();
    setSearchInput(""); setQuery("");
    cancelItemsMore();
    cancelHandoff();
    savedScroll.current = 0;
    setDetail(null);
    setSeries(null);
    setStack(stack.slice(0, index + 1));
  };
  const goLibraryRoot = () => {
    closeMenu();
    setSearchInput(""); setQuery("");
    cancelItemsMore();
    cancelHandoff();
    savedScroll.current = 0;
    setDetail(null);
    setSeries(null);
    setStack([]);
  };
  const retryListing = () => setNonce((value) => value + 1);
  const retryEpisodes = () => setEpisodeNonce((value) => value + 1);
  const retryDetail = () => setDetailNonce((value) => value + 1);

  const persistPrefs = (patch: Partial<LibraryViewPrefs>) => {
    const library = selectedRef.current;
    if (!library) return;
    onPersistPrefs(library.id, { sort, order: desc ? "desc" : "asc", favoritesOnly: false, view, ...patch });
  };
  const changeSort = (next: RemoteItemSort) => {
    setSort(next);
    const order = next === "added" || next === "size" ? "desc" : "asc";
    setDesc(order === "desc");
    persistPrefs({ sort: next, order });
  };
  const changeView = () => {
    const next = view === "grid" ? "list" : "grid";
    setView(next);
    persistPrefs({ view: next });
  };

  const loadMoreItems = async () => {
    const library = selectedRef.current;
    const cursor = listing.cursor;
    if (!library || !cursor) return;
    const epoch = listEpoch.current;
    const controller = new AbortController();
    itemsMoreAbort.current?.abort();
    itemsMoreAbort.current = controller;
    setListing((current) => ({ ...current, loading: true }));
    try {
      const page = await api.remoteBrowse(library.id, { parentId, mode, limit: PAGE_SIZE, search: query || undefined, sort, order: desc ? "desc" : "asc", cursor, signal: controller.signal });
      if (epoch !== listEpoch.current || controller.signal.aborted) return;
      setListing((current) => {
        const seen = new Set(current.items.map((item) => item.id));
        return { items: [...current.items, ...page.items.filter((item) => !seen.has(item.id))], cursor: page.cursor, total: page.total, loading: false, error: "" };
      });
    } catch (error) {
      if (epoch !== listEpoch.current || controller.signal.aborted || aborted(error)) return;
      // A cursor from another snapshot restarts the listing instead of mixing two pages.
      if (isStale(error)) { setNonce((value) => value + 1); return; }
      setListing((current) => ({ ...current, loading: false, error: describeError(error) }));
    }
  };
  const loadEpisodes = async () => {
    const library = selectedRef.current;
    const heading = series;
    const cursor = episodes.cursor;
    if (!library || !heading || !cursor) return;
    const epoch = episodeEpoch.current;
    const controller = new AbortController();
    episodesMoreAbort.current?.abort();
    episodesMoreAbort.current = controller;
    setEpisodes((current) => ({ ...current, loading: true }));
    try {
      const page = await api.remoteBrowse(library.id, { parentId: heading.id, mode: "titles", type: "episode", limit: PAGE_SIZE, cursor, signal: controller.signal });
      if (epoch !== episodeEpoch.current || controller.signal.aborted) return;
      setEpisodes((current) => {
        const seen = new Set(current.items.map((item) => item.id));
        return { items: [...current.items, ...page.items.filter((item) => !seen.has(item.id))], cursor: page.cursor, total: page.total, loading: false, error: "" };
      });
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
      rememberState(library.id, item.id, saved);
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
      if (selectedRef.current?.id === current.libraryId) {
        rememberState(current.libraryId, current.item.id, saved);
        if (detailRef.current?.id === current.item.id) setState(saved);
      }
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
      rememberState(library.id, item.id, saved);
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

  const grouped = groupEpisodes(episodes.items);
  const previewKey = { libraryId: selected?.id ?? "", generation: nonce };

  const renderTile = (item: RemoteItem, onOpen: (item: RemoteItem) => void, preview: PreviewInput): ReactNode => {
    const key = `${preview.parentId ?? "root"}:${item.id}`;
    if (item.type === "folder" || item.type === "season") {
      return <LibraryItem key={item.id} folder dataRemoteId={item.id} artRef={artRef(key)} onOpen={() => onOpen(item)}
        art={<RemoteFolderArt {...previewKey} parentId={item.id} enabled={preview.enabled} target={artRef(key)} shape={libraryTileShape} poster={item.poster} wide={item.wide}/>}
        title={item.name} meta={itemMetaLine(item)} description={item.overview}
        action={<><FolderOpen/> {t("library.openFolder")} <ChevronRight/></>}/>;
    }
    const playable = item.type === "movie" || item.type === "episode";
    const stored = itemStates[stateKey(selected?.id ?? "", item.id)];
    const locked = menuLoading || menuBusy || Boolean(menuError);
    return <LibraryItem key={item.id} dataRemoteId={item.id} artRef={artRef(key)} onOpen={() => onOpen(item)}
      art={<>
        <RemoteTileArt target={artRef(key)} shape={libraryTileShape} poster={item.poster} wide={item.wide} fallback={<Film/>}/>
        {stored?.favorite && <i className="fav-mark"><Star/></i>}
        {stored?.watched && <i className="browse-badge">{t("mediaServer.watched")}</i>}
      </>}
      title={item.type === "episode" ? `${t("mediaServer.episodeLabel", { season: item.season ?? 0, episode: item.episode ?? 0 })} · ${item.name}` : item.name}
      meta={itemMetaLine(item)} description={item.overview}
      action={playable ? <><Play/> {t("player.play")}</> : <><FolderOpen/> {t("library.openFolder")} <ChevronRight/></>}>
      <LibraryItemMenu name={item.name} open={menuFor === item.id} onToggle={() => toggleItemMenu(item)}>
        {menuLoading && <span className="identify-hint" role="status">{t("common.loading")}</span>}
        {menuError && <span className="identify-hint" role="alert">{menuError}</span>}
        <button disabled={locked || !menuState} aria-pressed={menuState?.favorite ?? false} onClick={() => void writeMenuState({ favorite: !(menuState?.favorite ?? false) })}>
          <Star/> {t(menuState?.favorite ? "favorite.remove" : "favorite.add")}
        </button>
        {playable && <button disabled={locked || !menuState} aria-pressed={menuState?.watched ?? false} onClick={() => void writeMenuState({ watched: !(menuState?.watched ?? false) })}>
          <Check/> {t(menuState?.watched ? "mediaServer.markUnwatched" : "mediaServer.markWatched")}
        </button>}
        <button onClick={() => { closeMenu(); onOpen(item); }}>{item.type === "series" ? <><FolderOpen/> {t("library.openFolder")}</> : <><CirclePlay/> {t("mediaServer.versions")}</>}</button>
      </LibraryItemMenu>
    </LibraryItem>;
  };

  const onBrowseScroll = (event: Parameters<typeof fold.compactOnScroll>[0]) => {
    fold.compactOnScroll(event, compact, onCompactChange);
  };

  return <>
    {!selected && libraries && libraries.length > 0 && <section className="remote-libraries" ref={rootRef} aria-label={t("mediaServer.remoteTitle")}>
      <div className="remote-libraries-head">
        <h3>{t("mediaServer.remoteTitle")}</h3>
        <small>{t("mediaServer.remoteHint")}</small>
      </div>
      <div className="browse-grid">
        {libraries.map((library) => {
          const key = `root:${library.id}`;
          return <LibraryTile key={library.id} path={library.id}
            name={library.name}
            meta={[t(providerKey(library.provider)), t(libraryTypeKey(library.type)), t("mediaServer.readOnly")].join(" · ")}
            fallback={<HardDrive/>}
            enabled={library.enabled}
            action={library.enabled ? <><FolderOpen/> {t("library.openFolder")} <ChevronRight/></> : t("library.disabled")}
            containerRef={artRef(key)}
            art={<RemoteLibraryArt libraryId={library.id} enabled={library.mosaic !== false} generation={0} target={artRef(key)}/>}
            onOpen={() => openLibrary(library)}
          />;
        })}
      </div>
    </section>}
    {librariesError && <div className="remote-error" role="alert">
      <span>{t("mediaServer.loadFailed")} {librariesError}</span>
      <button type="button" onClick={() => void loadLibraries()}>{t("mediaServer.retry")}</button>
    </div>}
    {targetError && <div className="remote-error" role="alert">
      <span>{targetError}</span>
      <button type="button" onClick={() => setTargetAttempt((value) => value + 1)}>{t("mediaServer.retry")}</button>
    </div>}
    {selected && <div className="panel browse-panel remote-browse-panel" onClick={() => menuFor && closeMenu()}
      onKeyDown={(event) => { if (event.key === "Escape" && menuFor) { const id = menuFor; closeMenu(); focusMenuTrigger(id); } }}>
      <div className="browse-head">
        <div className="browse-bar">
          <nav className="crumbs" aria-label={t("library.breadcrumbs")}>
            <button className="library-back" aria-label={detail || stack.length ? t("mediaServer.back") : t("mediaServer.backToLibraries")}
              title={detail || stack.length ? t("mediaServer.back") : t("mediaServer.backToLibraries")} onClick={stepBack}><ChevronLeft/></button>
            <button onClick={goLibraryRoot} disabled={!stack.length}><HardDrive/> {selected.name}</button>
            {stack.map((folder, index) => <span key={folder.id}>
              <ChevronRight/>
              <button disabled={index === stack.length - 1} onClick={() => goToFolder(index)}>{folder.name}</button>
            </span>)}
          </nav>
          <div className="browse-tools">
            <div className={`fold browse-fold${compact ? " closed" : ""}`}><div className="browse-fold-inner">
              {!detail && <div className="search-input"><Search/><input value={searchInput} aria-label={t("mediaServer.searchPlaceholder")} placeholder={t("mediaServer.searchPlaceholder")} onChange={(event) => setSearchInput(event.target.value)}/></div>}
              {!detail && <select aria-label={t("common.sorting")} value={sort} onChange={(event) => changeSort(event.target.value as RemoteItemSort)}>
                <option value="name">{t("library.sortName")}</option>
                <option value="added">{t("library.sortAdded")}</option>
                <option value="size">{t("library.sortSize")}</option>
              </select>}
              {!detail && <button title={t(desc ? "common.descending" : "common.ascending")} aria-label={t(desc ? "common.descending" : "common.ascending")} aria-pressed={desc}
                onClick={() => { const next = !desc; setDesc(next); persistPrefs({ order: next ? "desc" : "asc" }); }}>{desc ? <ArrowDown/> : <ArrowUp/>}</button>}
              {!detail && <button title={t(view === "grid" ? "library.viewRows" : "library.viewTiles")} aria-label={t(view === "grid" ? "library.viewRows" : "library.viewTiles")} aria-pressed={view === "list"}
                onClick={changeView}>{view === "grid" ? <List/> : <LayoutGrid/>}</button>}
            </div></div>
            <div className="browse-keep">
              {!detail && view === "grid" && <button className="shape-toggle" title={t(libraryTileShape === "wide" ? "library.shapePoster" : "library.shapeWide")} aria-pressed={libraryTileShape === "wide"} onClick={onToggleLibraryShape}>{libraryTileShape === "wide" ? <RectangleVertical/> : <RectangleHorizontal/>}</button>}
              <button className="header-expand" title={t("library.showTools")} aria-label={t("library.showTools")} aria-expanded={!compact} onClick={() => { fold.hold(); onCompactChange(false); }}><SlidersHorizontal/></button>
            </div>
          </div>
        </div>
      </div>
      <div className="browse-scroll" ref={scrollRef} onScroll={onBrowseScroll}>
        {!detail && <>
          {listing.error && <div className="remote-error" role="alert">
            <span>{listing.error}</span>
            <button type="button" onClick={retryListing}>{t("mediaServer.retry")}</button>
          </div>}
          {listing.loading && !listing.items.length ? <div className="loading" role="status">{t("common.loading")}</div>
            : listing.items.length > 0 ? <div className={view === "grid" ? "browse-grid" : "browse-rows"}>
              {listing.items.map((item) => renderTile(item, openItem, { enabled: mosaicOn(selected), parentId }))}
            </div>
            : !listing.error ? <p className="identify-hint">{query ? t("mediaServer.emptySearch") : t("mediaServer.emptyItems")}</p> : null}
          {listing.cursor && <div className="load-more"><button type="button" disabled={listing.loading} onClick={() => void loadMoreItems()}>{t("common.loadMore")}</button></div>}
          {listing.loading && listing.items.length > 0 && <div className="loading" role="status">{t("common.loadingMore")}</div>}
        </>}
        {detail && detail.type === "series" && <div className="remote-detail">
          <div className="remote-subhead"><h4>{t("mediaServer.episodes")}</h4><span>{detail.name}</span></div>
          {episodes.error && <div className="remote-error" role="alert">
            <span>{episodes.error}</span>
            <button type="button" onClick={retryEpisodes}>{t("mediaServer.retry")}</button>
          </div>}
          {grouped.map((group) => <div className="remote-season-group" key={group.season}>
            <div className="remote-season">{t("mediaServer.seasonLabel", { season: group.season })}</div>
            <div className={view === "grid" ? "browse-grid" : "browse-rows"}>
              {group.items.map((episode) => renderTile(episode, openEpisode, { enabled: false }))}
            </div>
          </div>)}
          {episodes.loading && !grouped.length && <div className="loading" role="status">{t("common.loading")}</div>}
          {!episodes.loading && !episodes.error && !grouped.length && !episodes.cursor && <p className="identify-hint">{t("mediaServer.noEpisodes")}</p>}
          {episodes.cursor && <div className="load-more"><button type="button" disabled={episodes.loading} onClick={() => void loadEpisodes()}>{t("common.loadMore")}</button></div>}
          {episodes.loading && grouped.length > 0 && <div className="loading" role="status">{t("common.loadingMore")}</div>}
        </div>}
        {detail && detail.type !== "series" && <div className="remote-detail">
          <div className="remote-subhead">
            <h4>{detail.type === "episode" ? t("mediaServer.episodeLabel", { season: detail.season ?? 0, episode: detail.episode ?? 0 }) : detail.name}</h4>
            <span>{detail.type === "episode" ? detail.name : series?.name ?? ""}</span>
          </div>
          {(detail.poster || detail.wide) && <div className="remote-detail-art"><TileArt shape={libraryTileShape} poster={detail.poster} wide={detail.wide} fallback={<Film/>}/></div>}
          {detail.overview && <p className="identify-hint">{detail.overview}</p>}
          {itemFacts(detail) && <p className="meta-line">{itemFacts(detail)}</p>}
          {detail.genres?.length ? <p className="meta-line">{detail.genres.join(" · ")}</p> : null}
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
      </div>
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
  </>;
}

interface PreviewInput { enabled: boolean; parentId?: string }
