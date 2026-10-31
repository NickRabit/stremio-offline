import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, CirclePlay, Film, FolderOpen, HardDrive, Images, LayoutGrid, List, Play, RectangleHorizontal, RectangleVertical, Search, SlidersHorizontal, Star } from "lucide-react";
import { ApiError, api, describeError, saveToDevice } from "./api";
import { relativeAge } from "./home-cards";
import { localeTag, t, useI18n } from "./i18n";
import { LibraryItem, LibraryItemMenu } from "./library-item";
import { LibraryTile } from "./library-tile";
import { LibraryTitleDetail } from "./LibraryTitleDetail";
import { NativeLibrarySaveDialog, type NativeSaveLibrary } from "./NativeLibrarySaveDialog";
import { defaultSource, sourceIdentity } from "./library-detail-sources";
import { useLibrarySources } from "./library-sources";
import { Player } from "./Player";
import { streamGroupLabel } from "./source-rows";
import { SaveTargetDialog } from "./SaveTargetDialog";
import { alternativeSaveRequest } from "./alternative-save";
import { addonMediaSubject, genericProgressKey, supplementaryIdentity } from "./native-addon-sources";
import { sourceProgressOwner, versionSavedRow, type SourceProgressOwner } from "./source-progress";
import { canQueue, isLocalStream, isRemoteStream } from "./streams";
import { sourceTargetRule } from "./save-target";
import { DetailHero, LIBRARY_HERO_EMPTY_GRADIENT, LIBRARY_HERO_GRADIENT, useBackdrop } from "./DetailHero";
import type { CatalogueDetailTarget } from "./CatalogueTitleDetail";
import { remoteDetailArtwork } from "./remote-artwork";
import { RemoteFolderArt, RemoteLibraryArt, RemoteTileArt } from "./remote-mosaic";
import { pickTileArt } from "./tile-shape";
import { TitleChips } from "./TitleChips";
import { catalogueGalleryImages, mergeGallery, posterAndWide, type GalleryImage } from "./gallery-images";
import { createCompactOnScroll } from "./scroll-fold";
import { bytes, hideBroken } from "./settings-ui";
import { catalogueRef, useTitleEnrichment, type CatalogueRef } from "./title-enrichment";
import { TitleExtraFacts, TitleExtrasRows } from "./TitleExtras";
import { useTitleExtras } from "./title-extras";
import type { SaveTarget } from "./save-target";
import type { Addon, AddonDownloadSettings, LibraryType, LibraryView, LibraryViewPrefs, MediaServerProvider, RemoteBrowseMode, RemoteItem, RemoteItemState, RemoteItemType, RemoteLibrary, RemoteStreamContext, SourceProfile, Stream, Subtitle, TileShape, Trailer, UserViews } from "./types";

interface Props {
  onRootPresenceChange?: (visible: boolean) => void;
  /** Drop the root library block while a local folder owns the page; only the roots hide. */
  hideRoots?: boolean;
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
  /** An item to open; `play` starts the version the detail selects as soon as it can play, the way
   *  a Continue watching card plays whatever wrote it. */
  initialTarget?: { libraryId: string; itemId: string; nonce: number; play?: boolean };
  /** A favourite, a watched flag or a position changed here, so Home and the shelf re-read. */
  onPersonalChange?: () => void;
  /** The reader's interface language, so the catalogue is asked in it. */
  uiLanguage: string;
  /** Secure Mode, which decides how the trailer chip behaves. */
  secureMode: boolean;
  /** The app owns the trailer overlay; the chip only asks for it. */
  onTrailer: (trailer: Trailer) => void;
  /** Opens the app's gallery overlay with the pictures this detail already holds. */
  onGallery?: (images: GalleryImage[], ref?: CatalogueRef | null) => void;
  /** Bumped when the sidebar returns to the Library: the browser drops back to the roots. */
  resetSignal?: number;
  /** The libraries this account may write to, so a native copy can choose a destination. */
  downloadLibraries: LibraryView[];
  /** A copy was queued here: the app refreshes its downloads and shows the toast. */
  onDownloadQueued?: () => void;
  /** Opens the shared rules dialog for a title with an exact bulk-route target. */
  onCatalogueDownload?: (stream: Stream, detail: CatalogueDetailTarget) => void;
  /** A short message the app shows, such as a device save that started through the server. */
  onNotify?: (text: string) => void;
  /** The signed-in account: supplementary source state never spans accounts. */
  accountScope?: string;
  /** This account's addons, so a loaded row names its provider and takes its download rule. */
  addons?: Addon[];
  /** Whether a debrid token is configured, so a torrent row may be queued. */
  realDebridConfigured?: boolean;
  sourceProfiles?: SourceProfile[] | null;
  defaultSort?: string;
}

type Status = { items: RemoteItem[]; cursor?: string; total: number; loading: boolean; error: string };
/** The captured identity of an addon row: everything its progress, subtitles and saves need,
 *  so nothing it does can be routed through the native item it was opened beside. */
type AddonPlayback = {
  identity: CatalogueRef;
  progressKey: string;
  /** The title/library/account scope this playback belongs to, so a late answer cannot land
   *  on another title that happens to reuse the same source id. */
  scope: string;
  media: Record<string, unknown>;
  subtitles: Subtitle[];
  poster?: string;
};
/** A copy that belongs to another library, to the viewer's own files or to an addon is played on
 *  its own terms: no native favourite, no episode hand-off, and its own progress store, named by
 *  the owner captured at the click. */
type Playing = {
  stream: Stream; libraryId: string; item: RemoteItem; title: string; favorite: boolean; fromBeginning?: boolean;
  addon?: AddonPlayback; foreign?: boolean;
  /** The position a switch handed over; a playback started here resumes from the store instead. */
  at?: number;
  /** Where this row's saved position lives; the same owner the detail reads and clears. */
  owner: SourceProgressOwner;
  /** The title/library/account scope the playback belongs to, so a late answer cannot land on
   *  another title that happens to reuse the same source id. */
  scope: string;
  /** Addon subtitles of the catalogue title a library copy or a file stands for. */
  subtitles?: Subtitle[];
};
/** The addon save the viewer opened: the exact stream, subject and labels captured at the click,
 *  so no later state change can alter what is submitted. `title` labels the episode, while
 *  `previewTitle` is the media subject's own title the storage preview resolves. */
type AddonSaveRequest = {
  stream: Stream;
  media: Record<string, unknown>;
  title: string;
  previewTitle: string;
  kind: "movie" | "series";
  season?: number;
  /** The destination the exact source projects; an addon answer leaves it to the addon's rule. */
  rule?: AddonDownloadSettings;
  /** A native copy whose server projected no destination: the viewer picks one themselves. */
  ruleUnavailable?: boolean;
};
/** The open native-copy dialog: the library and item captured at the click, the versions the
 *  detail already holds (or nothing, so the dialog reads them once) and an exact artwork hint. */
type SaveRequest = {
  library: NativeSaveLibrary;
  item: RemoteItem;
  series?: RemoteItem | null;
  knownSources?: Stream[] | null;
  initialSource?: Stream | null;
  artwork?: { poster?: string; background?: string };
};
type TileRef = { current: HTMLElement | null };

/** The attached library a native copy lands through: its id scopes the version read, the provider
 *  and name label the chooser. The source projection is the copy's only preselected destination. */
const saveLibrary = (library: RemoteLibrary): NativeSaveLibrary => ({
  id: library.id, provider: library.provider,
  ...(library.name ? { name: library.name } : {}),
});
/** One ancestor listing kept while its children are open, so a jump back needs no new page. */
type ListingSnapshot = {
  libraryId: string;
  parentId?: string;
  mode: RemoteBrowseMode;
  searchInput: string;
  query: string;
  sort: RemoteItemSort;
  desc: boolean;
  status: Status;
  scrollTop: number;
  /** The folder that was entered from this listing, so focus can return to it. */
  focusId: string;
};

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
const mergeDetailMeta = (base: RemoteItem, full: RemoteItem): RemoteItem => ({
  ...base,
  overview: full.overview ?? base.overview,
  genres: full.genres?.length ? full.genres : base.genres,
  year: full.year ?? base.year,
  durationTicks: full.durationTicks ?? base.durationTicks,
  size: full.size ?? base.size,
  addedAt: full.addedAt ?? base.addedAt,
});
const sortFor = (sort: LibraryViewPrefs["sort"]): RemoteItemSort =>
  sort === "added" || sort === "size" ? sort : "name";
type RemoteItemSort = "name" | "added" | "size";
const defaultPrefs = (): LibraryViewPrefs => ({ sort: "name", order: "asc", favoritesOnly: false, view: "grid" });

/** Carry-over key: the provider's version name alone, so a title or a library label can never match. */
const versionKey = (stream: Stream) => stream.name?.trim() ?? "";

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

export function RemoteLibraryBrowser({ onRootPresenceChange, hideRoots, audioLanguage, subtitleLanguage, onError, libraryTileShape, onToggleLibraryShape, views, onPersistPrefs, onOpenChange, compact, onCompactChange, initialTarget, onPersonalChange, uiLanguage, secureMode, onTrailer, onGallery, resetSignal, downloadLibraries, onDownloadQueued, onCatalogueDownload, onNotify, accountScope = "", addons = [], realDebridConfigured = false, sourceProfiles = null, defaultSort }: Props) {
  useI18n();
  // The listing effect must not restart when the shape changes. It still warms only the
  // picture that shape draws, so the other role is fetched when a tile actually asks for it.
  const tileShape = useRef(libraryTileShape);
  tileShape.current = libraryTileShape;
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
  const [state, setState] = useState<RemoteItemState | null>(null);
  const [stateError, setStateError] = useState("");
  /** The version the detail's own selector currently holds, so its state can be matched. */
  const [detailStream, setDetailStream] = useState<Stream | null>(null);
  const [detailNonce, setDetailNonce] = useState(0);
  const [playing, setPlaying] = useState<Playing | null>(null);
  /** The source the title's stored position names, read for the row the detail has selected. */
  const [resumeStableKey, setResumeStableKey] = useState<string | undefined>(undefined);
  /** The item a Continue watching card asked to play, until its detail can. */
  const autoPlay = useRef<string | null>(null);
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
  /** The open native-copy dialog: the exact item, its parent series and the versions the
   *  detail already holds, or nothing so the dialog reads them once after the click. */
  const [saveRequest, setSaveRequest] = useState<SaveRequest | null>(null);
  /** The open addon-save dialog: the exact stream and media subject captured at the click, so no
   *  later state change can alter what is submitted. */
  const [addonSave, setAddonSave] = useState<AddonSaveRequest | null>(null);
  /** The saved position of the selected version; the item's own state is read for the row it owns. */
  const [alternativeProgress, setAlternativeProgress] = useState<{ sourceKey: string; position: number; duration: number } | null>(null);
  /** Whether the source chooser is open: the one intent that reads every extra source group. */
  const [chooserOpen, setChooserOpen] = useState(false);
  /** Whether the player's own Sources panel is open: the same intent, from the play on screen. */
  const [playerSourcesOpen, setPlayerSourcesOpen] = useState(false);
  const listEpoch = useRef(0);
  const episodeEpoch = useRef(0);
  const detailEpoch = useRef(0);
  /** The state read the open detail started, for the selected version's fallback to share. */
  const detailStateRead = useRef<{ libraryId: string; itemId: string; read: Promise<RemoteItemState> } | null>(null);
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
  const savedEpisodeScroll = useRef(0);
  /** The ancestor listings of the open library, indexed by depth; cleared with the library. */
  const snapshots = useRef<ListingSnapshot[]>([]);
  /** One-use token; the listing effect keeps the restored listing instead of reading page one. */
  const pendingRestore = useRef<ListingSnapshot | null>(null);
  /** The listing a return put back, so its offset is applied once that listing is on screen. */
  const restoredListing = useRef<{ status: Status; offset: number } | null>(null);
  /** One stable ref per remote tile, so the lazy preview can watch the element it draws. */
  const tileRefs = useRef(new Map<string, TileRef>());
  const [fold] = useState(createCompactOnScroll);
  useEffect(() => { fold.attach(); return fold.dispose; }, [fold]);
  /** The streams a hand-off already fetched, so the panel does not scan the same item twice. */
  const handoffStreams = useRef<{ itemId: string; streams: Stream[] } | null>(null);
  const selectedRef = useRef<RemoteLibrary | null>(null);
  const detailRef = useRef<RemoteItem | null>(null);
  const playingRef = useRef<Playing | null>(null);
  const detailStreamRef = useRef<Stream | null>(null);
  /** The latest listing/episode page, read by the observer and the scroll fallback, which are set
   *  up once and never capture a stale render. */
  const listingRef = useRef(listing);
  const episodesRef = useRef(episodes);
  /** One synchronous guard per loader: a second callback for the same cursor is dropped, not
   *  restarted, so a fling near the sentinel cannot abort and refetch its own page. */
  const itemsMoreBusy = useRef(false);
  const episodesMoreBusy = useRef(false);
  const loadMoreItemsRef = useRef<HTMLDivElement | null>(null);
  const loadMoreEpisodesRef = useRef<HTMLDivElement | null>(null);
  const autoLoadRef = useRef<() => void>(() => {});
  const menuEpoch = useRef(0);
  const menuAbort = useRef<AbortController | null>(null);
  const addonProgressEpoch = useRef(0);
  const addonSubtitleAbort = useRef<AbortController | null>(null);
  /** Set when a detail was opened from a listing, whose page carries no overview or genres, so its
   *  full record is read once; the direct Home card path already reads it and clears this. */
  const needsDetailMeta = useRef(false);
  const metaEpoch = useRef(0);
  selectedRef.current = selected;
  detailRef.current = detail;
  playingRef.current = playing;
  detailStreamRef.current = detailStream;
  listingRef.current = listing;
  episodesRef.current = episodes;

  const artRef = (key: string): TileRef => {
    let ref = tileRefs.current.get(key);
    if (!ref) { ref = { current: null }; tileRefs.current.set(key, ref); }
    return ref;
  };
  const cancelItemsMore = () => {
    itemsMoreAbort.current?.abort();
    itemsMoreAbort.current = null;
    itemsMoreBusy.current = false;
    // Leaving a listing cancels the page it was reading, and a canceled page is not a page being
    // read: the action has to be usable again the moment the listing comes back, whether or not a
    // request was still in flight when it was left.
    setListing((current) => (current.loading ? { ...current, loading: false } : current));
  };
  const cancelEpisodesMore = () => {
    episodesMoreAbort.current?.abort();
    episodesMoreAbort.current = null;
    episodesMoreBusy.current = false;
    setEpisodes((current) => (current.loading ? { ...current, loading: false } : current));
  };
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
    // The roots are what the page actually draws: a selected library and a hidden root block both
    // leave the local panel on the ordinary, self-scrolling layout.
    onRootPresenceChange?.(Boolean(libraries?.length) && !selected && !hideRoots);
    return () => onRootPresenceChange?.(false);
  }, [Boolean(libraries?.length), Boolean(selected), hideRoots, onRootPresenceChange]);
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
  /** The identity of the listing on screen: the library and the folder path that leads to it. */
  const navKey = selected ? `${selected.id}:${stack.map((folder) => folder.id).join("/")}` : "";

  // One bounded page per request; a fresh search, sort, folder or library starts the listing over.
  useEffect(() => {
    const library = selected;
    if (!library) return;
    const epoch = ++listEpoch.current;
    cancelItemsMore();
    const restore = pendingRestore.current;
    pendingRestore.current = null;
    // An ancestor return keeps the page it left, but only for the exact listing it was saved from.
    if (restore && restore.libraryId === library.id && restore.parentId === parentId && restore.mode === mode
      && restore.query === query && restore.sort === sort && restore.desc === desc) {
      const status: Status = { ...restore.status, loading: false, error: "" };
      restoredListing.current = { status, offset: restore.scrollTop };
      setListing(status);
      return () => { if (listEpoch.current === epoch) listEpoch.current += 1; cancelItemsMore(); };
    }
    const controller = new AbortController();
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
  }, [selected, series?.id, episodeNonce]);

  // Read detail metadata once; merging it does not restart sources or personal state.
  useEffect(() => {
    const library = selected;
    const opened = detail;
    if (!library || !opened || opened.type === "folder" || opened.type === "season") return;
    if (!needsDetailMeta.current) return;
    needsDetailMeta.current = false;
    const epoch = ++metaEpoch.current;
    const itemId = opened.id;
    const controller = new AbortController();
    void api.remoteItem(library.id, itemId, controller.signal)
      .then(({ item: full }) => {
        if (!full || full.id !== itemId) return;
        if (epoch !== metaEpoch.current || controller.signal.aborted || selectedRef.current?.id !== library.id) return;
        setDetail((current) => current && current.id === itemId ? mergeDetailMeta(current, full) : current);
        if (full.type === "series") setSeries((current) => current?.id === itemId ? mergeDetailMeta(current, full) : current);
      })
      .catch(() => undefined);
    return () => { controller.abort(); if (metaEpoch.current === epoch) metaEpoch.current += 1; };
  }, [selected, detail?.id, detailNonce]);

  useEffect(() => {
    const library = selected;
    if (!library || !detail || detail.type === "series") return;
    const epoch = ++detailEpoch.current;
    const itemId = detail.id;
    const controller = new AbortController();
    const handoff = handoffStreams.current?.itemId === itemId ? handoffStreams.current : null;
    handoffStreams.current = null;
    const live = () => epoch === detailEpoch.current && selectedRef.current?.id === library.id && detailRef.current?.id === itemId;
    setSources(handoff?.streams ?? null);
    setSourceError("");
    setState(null);
    setStateError("");
    setDetailStream(null);
    setAlternativeProgress(null);
    setChooserOpen(false);
    setPlayerSourcesOpen(false);
    if (!handoff) {
      void api.remoteSources(library.id, itemId, controller.signal)
        .then((found) => {
          if (!live()) return;
          setSources(found);
        })
        .catch((error) => {
          if (!live() || controller.signal.aborted || aborted(error)) return;
          setSourceError(describeError(error));
        });
    }
    const read = api.remoteState(library.id, itemId, controller.signal);
    detailStateRead.current = { libraryId: library.id, itemId, read };
    void read
      .then((value) => {
        if (!live()) return;
        setState(value);
        rememberState(library.id, itemId, value);
      })
      .catch((error) => {
        if (!live() || controller.signal.aborted || aborted(error)) return;
        setStateError(describeError(error));
      });
    return () => { controller.abort(); if (detailEpoch.current === epoch) detailEpoch.current += 1; };
    // Keyed on the id, not the object: folding the overview in above must not restart this read.
  }, [selected, detail?.id, detailNonce]);

  // A debounce keeps typing in the search box from firing one provider read per keystroke.
  useEffect(() => {
    const handle = window.setTimeout(() => setQuery(searchInput.trim()), 300);
    return () => window.clearTimeout(handle);
  }, [searchInput]);
  // The listing keeps its offset while a detail is open over it; the panel is restored after.
  useEffect(() => {
    if (!scrollRef.current) return;
    if (!detail) scrollRef.current.scrollTop = savedScroll.current;
    else if (detail.type === "series") scrollRef.current.scrollTop = savedEpisodeScroll.current;
  }, [detail?.id, detail?.type, navKey]);
  // An ancestor return puts the offset it left back, once the restored listing itself is on screen.
  useEffect(() => {
    const restore = restoredListing.current;
    if (!restore || restore.status !== listing) return;
    restoredListing.current = null;
    savedScroll.current = restore.offset;
    if (scrollRef.current) scrollRef.current.scrollTop = restore.offset;
  }, [listing, navKey]);
  useEffect(() => () => {
    cancelItemsMore();
    cancelEpisodesMore();
    handoffAbort.current?.abort();
    menuAbort.current?.abort();
    librariesAbort.current?.abort();
    snapshots.current = [];
    pendingRestore.current = null;
    restoredListing.current = null;
    // The page that draws the local listing may outlive this browser; make sure it comes back.
    onOpenChange(false);
  }, []);

  // The sidebar's Library entry returns to the roots from anywhere: a remote library, a folder,
  // a title or the player. It is a deliberate jump to the top, so no offset or focus comes back.
  const resetSeen = useRef(resetSignal ?? 0);
  useEffect(() => {
    if (resetSignal === undefined || resetSignal === resetSeen.current) return;
    resetSeen.current = resetSignal;
    closeMenu();
    cancelItemsMore();
    cancelEpisodesMore();
    cancelHandoff();
    snapshots.current = [];
    pendingRestore.current = null;
    restoredListing.current = null;
    pendingFocus.current = null;
    pendingRootFocus.current = null;
    savedScroll.current = 0;
    setSelected(null);
    setStack([]);
    setListing(emptyStatus());
    setDetail(null);
    needsDetailMeta.current = false;
    setSeries(null);
    setSources(null);
    setState(null);
    setSearchInput("");
    setQuery("");
    onOpenChange(false);
  }, [resetSignal]);

  // One next page arrives on its own as the listing nears its end: an observer on the sentinel
  // the manual button already sits in, rooted in the scroll pane, with the scroll handler as the
  // fallback for a viewport that never crosses the threshold. It disconnects on every navigation.
  useEffect(() => {
    const root = scrollRef.current;
    const target = detail ? (detail.type === "series" ? loadMoreEpisodesRef.current : null) : loadMoreItemsRef.current;
    if (!root || !target || typeof IntersectionObserver === "undefined") return;
    const margin = Math.min(400, root.clientHeight || window.innerHeight || 800);
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) autoLoadRef.current();
    }, { root, rootMargin: `0px 0px ${margin}px 0px` });
    observer.observe(target);
    return () => observer.disconnect();
  }, [selected, detail?.type, detail?.id, listing.cursor, episodes.cursor, nonce, episodeNonce]);

  // A remote card from Home or Favourites opens its item in the native browser.
  useEffect(() => {
    const target = initialTarget;
    if (!target || !libraries) return;
    const library = libraries.find((row) => row.id === target.libraryId);
    if (!library) { setTargetError(t("mediaServer.itemUnavailable")); return; }
    setTargetError("");
    autoPlay.current = target.play ? `${target.libraryId}\u0000${target.itemId}` : null;
    const epoch = ++targetEpoch.current;
    const controller = new AbortController();
    openLibrary(library);
    void api.remoteItem(library.id, target.itemId, controller.signal)
      .then(({ item }) => {
        if (epoch !== targetEpoch.current) return;
        // This path already read the full record, so the detail effect must not read it again.
        needsDetailMeta.current = false;
        if (item.type === "folder" || item.type === "season") {
          setDetail(null);
          setSeries(null);
          setSources(null);
          setState(null);
          setStack([item]);
          return;
        }
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
  // A card that asked to play presses Play once, the first time the item it named is on screen and
  // its detail has selected a row; an item without a playable version stays on its detail.
  useEffect(() => {
    if (!autoPlay.current || !selected || !detail || `${selected.id}\u0000${detail.id}` !== autoPlay.current || sources === null) return;
    autoPlay.current = null;
    // The row the detail holds when it is one of this item's versions, else the default it offers:
    // a selection left over from the previous item is never what plays.
    const held = detailStream && sources.some((stream) => stream.sourceId === detailStream.sourceId) ? detailStream : defaultSource(sources);
    if (held?.playable) playDetailStream(held);
  });

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
    snapshots.current = [];
    pendingRestore.current = null;
    restoredListing.current = null;
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
    needsDetailMeta.current = false;
    setSeries(null);
    setSources(null);
    setState(null);
    savedScroll.current = 0;
    onOpenChange(true);
  };
  const closeLibrary = () => {
    closeMenu();
    pendingRootFocus.current = selected?.id ?? null;
    cancelItemsMore();
    cancelEpisodesMore();
    cancelHandoff();
    snapshots.current = [];
    pendingRestore.current = null;
    restoredListing.current = null;
    setSelected(null);
    setStack([]);
    setListing(emptyStatus());
    setDetail(null);
    needsDetailMeta.current = false;
    setSeries(null);
    setSources(null);
    setState(null);
    setSearchInput("");
    setQuery("");
    savedScroll.current = 0;
    onOpenChange(false);
  };
  const stepBack = () => {
    closeMenu();
    cancelHandoff();
    needsDetailMeta.current = false;
    if (detail) {
      pendingFocus.current = detail.id;
      if (detail.type === "episode" && series) { setDetail(series); return; }
      setDetail(null);
      setSeries(null);
      return;
    }
    if (stack.length) { returnToAncestor(stack.length - 1); return; }
    closeLibrary();
  };
  const openItem = (item: RemoteItem) => {
    closeMenu();
    setSources(null); setSourceError(""); setState(null); setStateError("");
    cancelItemsMore();
    cancelHandoff();
    if (item.type === "folder" || item.type === "season") {
      const library = selectedRef.current;
      // Keep the listing this folder is entered from, so the return reads no page again.
      if (library) snapshots.current = [...snapshots.current.slice(0, stack.length), {
        libraryId: library.id, parentId, mode, searchInput, query, sort, desc,
        status: { ...listingRef.current, loading: false },
        scrollTop: scrollRef.current?.scrollTop ?? 0, focusId: item.id,
      }];
      savedScroll.current = 0;
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
      setDetail(null);
      needsDetailMeta.current = false;
      setSeries(null);
      setSearchInput("");
      setQuery("");
      setStack([...stack, item]);
      return;
    }
    savedScroll.current = scrollRef.current?.scrollTop ?? 0;
    savedEpisodeScroll.current = 0;
    needsDetailMeta.current = true;
    if (item.type === "series") { setSeries(item); setDetail(item); setSources(null); setState(null); return; }
    setSeries(null);
    setDetail(item);
  };
  const openEpisode = (episode: RemoteItem) => {
    closeMenu();
    setSources(null); setSourceError(""); setState(null); setStateError("");
    cancelEpisodesMore();
    cancelHandoff();
    savedEpisodeScroll.current = scrollRef.current?.scrollTop ?? 0;
    needsDetailMeta.current = true;
    setDetail(episode);
  };
  const returnToListing = () => {
    closeMenu();
    cancelHandoff();
    pendingFocus.current = series?.id ?? detail?.id ?? null;
    needsDetailMeta.current = false;
    setDetail(null);
    setSeries(null);
  };
  /** The one return path for stepBack, an ancestor breadcrumb and the library root. */
  const returnToAncestor = (depth: number) => {
    closeMenu();
    cancelItemsMore();
    cancelHandoff();
    needsDetailMeta.current = false;
    setDetail(null);
    setSeries(null);
    setSources(null);
    setState(null);
    const library = selectedRef.current;
    const snapshot = library ? snapshots.current[depth] : undefined;
    if (library && snapshot && snapshot.libraryId === library.id) {
      // Drop every deeper listing: the ones below this depth belong to a history left behind.
      snapshots.current = snapshots.current.slice(0, depth + 1);
      pendingRestore.current = snapshot;
      pendingFocus.current = snapshot.focusId;
      setSearchInput(snapshot.searchInput);
      setQuery(snapshot.query);
      setSort(snapshot.sort);
      setDesc(snapshot.desc);
      setStack(stack.slice(0, depth));
      return;
    }
    snapshots.current = [];
    pendingRestore.current = null;
    restoredListing.current = null;
    pendingFocus.current = stack[depth]?.id ?? null;
    savedScroll.current = 0;
    setSearchInput("");
    setQuery("");
    setStack(stack.slice(0, depth));
  };
  const goToFolder = (index: number) => {
    if (detail && index === stack.length - 1) { returnToListing(); return; }
    returnToAncestor(index + 1);
  };
  const goLibraryRoot = () => {
    if (detail && !stack.length) { returnToListing(); return; }
    returnToAncestor(0);
  };
  /** The series crumb: leave the episode's detail but keep the episode as the tile to focus once
   *  the episode listing returns, exactly the way Back behaves from an episode. */
  const goToSeries = () => {
    if (!series) return;
    closeMenu();
    if (detail && detail.type !== "series") pendingFocus.current = detail.id;
    setDetail(series);
  };
  const retryListing = () => setNonce((value) => value + 1);
  const retryEpisodes = () => setEpisodeNonce((value) => value + 1);
  const retryDetail = () => { needsDetailMeta.current = true; setDetailNonce((value) => value + 1); };

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
    if (!library || !cursor || itemsMoreBusy.current) return;
    const epoch = listEpoch.current;
    const controller = new AbortController();
    itemsMoreAbort.current = controller;
    itemsMoreBusy.current = true;
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
    } finally {
      if (itemsMoreAbort.current === controller) { itemsMoreAbort.current = null; itemsMoreBusy.current = false; }
    }
  };
  const loadEpisodes = async () => {
    const library = selectedRef.current;
    const heading = series;
    const cursor = episodes.cursor;
    if (!library || !heading || !cursor || episodesMoreBusy.current) return;
    const epoch = episodeEpoch.current;
    const controller = new AbortController();
    episodesMoreAbort.current = controller;
    episodesMoreBusy.current = true;
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
    } finally {
      if (episodesMoreAbort.current === controller) { episodesMoreAbort.current = null; episodesMoreBusy.current = false; }
    }
  };

  // The one entry point the observer and the scroll fallback share: it reads the current screen
  // and asks for its next page only while the provider still points at one and the last read was
  // clean, so an error or an exhausted cursor never turns into a retry loop.
  autoLoadRef.current = () => {
    if (detailRef.current) {
      if (detailRef.current.type !== "series") return;
      const page = episodesRef.current;
      if (page.cursor && !page.loading && !page.error) void loadEpisodes();
      return;
    }
    const page = listingRef.current;
    if (page.cursor && !page.loading && !page.error) void loadMoreItems();
  };

  /** Writes one patch to the open title's state and says whether it landed. Clearing the
   *  position goes through here too: favourite and watched are left out of the patch, so the
   *  server keeps them, and a detail the reader has left is never overwritten. */
  const toggleState = async (patch: { favorite?: boolean; watched?: boolean; position?: number; duration?: number }): Promise<boolean> => {
    const library = selectedRef.current;
    const item = detailRef.current;
    if (!library || !item || item.type === "series" || !state) return false;
    const epoch = detailEpoch.current;
    try {
      const saved = await api.saveRemoteState(library.id, item.id, patch);
      if (epoch !== detailEpoch.current || detailRef.current?.id !== item.id || selectedRef.current?.id !== library.id) return false;
      setState(saved);
      rememberState(library.id, item.id, saved);
      setStateError("");
      onPersonalChange?.();
      return true;
    } catch (error) { onError(error); return false; }
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
  /** Marking the item watched also forgets the title's position: the position row and the card
   *  Continue watching draws would otherwise disagree about a title that is finished. */
  const toggleWatched = async (): Promise<void> => {
    const next = !(state?.watched ?? false);
    const scope = titleScope;
    if (!await toggleState({ watched: next })) return;
    if (!next || !addonIdentity) return;
    await api.forgetProgress(genericProgressKey(addonIdentity)).catch(() => undefined);
    if (titleScopeRef.current === scope) setAlternativeProgress(null);
    onPersonalChange?.();
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
      handoffStreams.current = { itemId: episode.id, streams };
      if (!pick) {
        setPlaying(null);
        needsDetailMeta.current = true;
        setDetail(episode);
        return true;
      }
      // The hand-off stays a version of this library's own item, so the owner is the copy's own
      // remote context: the next episode reports its position under its own identity.
      const owner = sourceProgressOwner(pick, addonIdentity);
      if (!owner) return false;
      setPlaying({ stream: pick, libraryId: library.id, item: episode, title: episodeTitle(episode), favorite: false, owner, scope: titleScope });
      needsDetailMeta.current = true;
      setDetail(episode);
      return true;
    } catch (error) {
      if (epoch === handoffEpoch.current && !aborted(error)) onError(error);
      return false;
    } finally {
      if (epoch === handoffEpoch.current) { setNextBusy(false); handoffAbort.current = null; }
    }
  };

  // The catalogue identity this record carries and the title's extra facts. An episode is asked
  // about through its series, never its own ids, and nothing is guessed without a valid id; a
  // folder or a season has no title to ask after. Not one of these calls happens for a listing row.
  const catalogue = detail?.type === "movie" || detail?.type === "series"
    ? catalogueRef(detail.type, detail.providerIds)
    : detail?.type === "episode" ? catalogueRef("series", series?.providerIds) : null;
  const enrichment = useTitleEnrichment(catalogue ? { kind: "catalogue", ref: catalogue } : null, catalogue, uiLanguage);
  const titleExtras = useTitleExtras(catalogue?.type, catalogue?.id);
  const detailPreview = remoteDetailArtwork(detail?.poster);
  const detailBackdrops: Array<string | undefined> = detail
    ? [enrichment.meta?.background, detail.fanart, detail.type === "episode" ? series?.fanart : undefined, detailPreview]
    : [];
  // The series draws its own full-detail surface, so the backdrop is probed here; the shared
  // shell probes for a playable title through the same hook.
  const seriesBackdrop = useBackdrop(detail?.type === "series" ? detailBackdrops : []);
  const seriesGallery: GalleryImage[] = mergeGallery(posterAndWide(detailPreview, detail?.wide), catalogueGalleryImages(enrichment.meta));
  // The supplementary identity of the title on screen: the exact key its addons, the viewer's own
  // copies of it and the other libraries are asked by. Nothing is read until the chooser opens.
  const addonIdentity = supplementaryIdentity(detail, series);
  const addonKey = addonIdentity ? `${addonIdentity.type}:${addonIdentity.id}` : "";
  // Which store the selected row's position lives in, read from the row itself: the title's own key
  // for every version when the catalogue can name it, this item's own remote state while its library
  // owns a version nothing names, and the viewer's own file under its path.
  const detailStreamKey = detailStream ? sourceIdentity(detailStream) : null;
  const detailOwner = detailStream ? sourceProgressOwner(detailStream, addonIdentity) : null;
  // The row is one of this item's own versions only when it carries this item's own context.
  const ownVersion = Boolean(detailOwner?.kind === "remote" && detailOwner.item.libraryId === selected?.id && detailOwner.item.itemId === detail?.id);
  // Only while a detail is open: the row it selected outlives it for a moment, and a read for a
  // detail that is already gone would be thrown away.
  const alternativeSelected = Boolean(detail && detailStream && detailOwner && !ownVersion);
  const detailProgress = detailStreamKey
    ? ownVersion
      ? (detailOwner?.kind === "remote" && state && state.mediaSourceId === detailOwner.item.mediaSourceId
        ? { position: state.position, duration: state.duration, sourceKey: detailStreamKey } : undefined)
      : (alternativeProgress && alternativeProgress.sourceKey === detailStreamKey
        ? { position: alternativeProgress.position, duration: alternativeProgress.duration, sourceKey: detailStreamKey } : undefined)
    : undefined;
  // The version's own remote context, whichever kind of owner the row resolved to: a media-server
  // version named by the catalogue carries it too, and its own store is still the fallback.
  const ownerRemote = detailOwner?.kind === "catalogue" ? detailOwner.remote : detailOwner?.kind === "remote" ? detailOwner.item : undefined;
  // The owner's own fields, as primitives: the read effect must restart on a change of version,
  // never on a redraw that happens to rebuild the object.
  const ownerKind = detailOwner?.kind ?? "";
  const ownerLibrary = ownerRemote?.libraryId ?? "";
  const ownerItemId = ownerRemote?.itemId ?? "";
  const ownerSourceId = ownerRemote?.mediaSourceId ?? "";
  const ownerProgressKey = detailOwner && detailOwner.kind !== "remote" ? detailOwner.progressKey : "";
  // Everything one title's supplementary work is bound to: the account, the library, the item and
  // the exact catalogue key. A late answer from another scope is refused by comparing this string.
  const titleScope = `${accountScope}\u0000${selected?.id ?? ""}\u0000${detail?.id ?? ""}\u0000${addonKey}`;
  const titleScopeRef = useRef(titleScope);
  titleScopeRef.current = titleScope;
  // What this item's own versions are called, in the detail's menu and above the rows the player
  // leads with: the provider and the library they belong to.
  const ownLabel = selected ? `${t(providerKey(selected.provider))} · ${selected.name}` : "";
  // Opening the chooser is the one intent that reads every group: the addons that offer this
  // title, the viewer's own copies of it, and every other library the account may browse. The
  // library the detail already came from is never asked again.
  const extra = useLibrarySources({
    scope: titleScope, open: chooserOpen || playerSourcesOpen, catalogue: addonIdentity,
    ...(series?.name ? { nameHint: series.name } : {}),
    libraries, localCopies: true, ...(selected ? { originLibraryId: selected.id } : {}),
  });
  // The selected row's saved position: the title's own key for every version of a title the
  // catalogue can name, the viewer's own file under its path, and a media-server version's own
  // store only while no title names it -- or as the fallback for a position kept there before the
  // title held it. A late answer can never land on another row or another title.
  useEffect(() => {
    if (!alternativeSelected || !detailStreamKey || !detailOwner) { setAlternativeProgress(null); setResumeStableKey(undefined); return; }
    const mine = ++addonProgressEpoch.current;
    const scope = titleScope;
    const controller = new AbortController();
    // The item on screen had its own state read as the detail opened; that answer is the fallback.
    const shared = detailStateRead.current;
    const readRemote = (remote: RemoteStreamContext, signal?: AbortSignal) =>
      shared && shared.libraryId === remote.libraryId && shared.itemId === remote.itemId ? shared.read : api.remoteState(remote.libraryId, remote.itemId, signal);
    void versionSavedRow(ownerProgressKey || undefined, ownerRemote, controller.signal, readRemote)
      .then((entry) => {
        if (mine !== addonProgressEpoch.current || titleScopeRef.current !== scope || controller.signal.aborted) return;
        setAlternativeProgress(entry && entry.position > 0
          ? { sourceKey: detailStreamKey, position: entry.position, duration: entry.duration } : null);
        // The same record names the source it was played from, which is what the detail opens on.
        setResumeStableKey(entry?.stableKey);
      })
      .catch(() => undefined);
    return () => { controller.abort(); if (addonProgressEpoch.current === mine) addonProgressEpoch.current += 1; };
  }, [alternativeSelected, detailStreamKey, detailNonce, titleScope, selected?.id, ownerKind, ownerLibrary, ownerItemId, ownerSourceId, ownerProgressKey]);

  // A library copy or a file plays as itself, but the subtitle addons still know the catalogue
  // title it is matched to; an addon row reads its own above.
  const playingIdentity = playing && !playing.addon ? supplementaryIdentity(playing.item, series) : null;
  const playingIdentityKey = playingIdentity ? `${playingIdentity.type}:${playingIdentity.id}` : "";
  useEffect(() => {
    if (!playing || playing.addon || !playingIdentity) return;
    const controller = new AbortController();
    const { sourceId } = playing.stream;
    void api.subtitles(playingIdentity.type, playingIdentity.id, controller.signal)
      .then((found) => {
        if (controller.signal.aborted) return;
        setPlaying((value) => value && !value.addon && value.stream.sourceId === sourceId ? { ...value, subtitles: found } : value);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [playing?.stream.sourceId, playingIdentityKey]);

  if (!librariesError && !targetError && (libraries === null || !libraries.length)) return null;

  const grouped = groupEpisodes(episodes.items);
  const previewKey = { libraryId: selected?.id ?? "", generation: nonce };

  /** One kind pill, the trailer and the sites, in the same row the catalogue draws: no provider,
   *  library or series-name chip, and an episode's numbering travels under the title instead. */
  const detailChips = (item: RemoteItem, withFavorite = false): ReactNode =>
    <TitleChips
      // A series opens on this hero alone, and it had no star of its own: the shared shell draws one
      // for every other detail, so the row carries it here instead of the title being unreachable.
      leading={withFavorite ? <button type="button" className={`watch-star${state?.favorite ? " on" : ""}`}
        aria-pressed={state?.favorite ?? false} disabled={!state} aria-label={t(state?.favorite ? "favorite.remove" : "favorite.add")} title={t(state?.favorite ? "favorite.remove" : "favorite.add")}
        onClick={() => void toggleState({ favorite: !(state?.favorite ?? false) })}><Star/></button> : undefined}
      kind={t(item.type === "movie" ? "catalog.oneMovie" : item.type === "series" ? "catalog.oneSeries" : "episodes.one")}
      trailer={enrichment.trailer} links={enrichment.links} onTrailer={onTrailer} secureMode={secureMode}/>;
  /** The metadata line: what the provider normalized, plus the genres it gave. */
  const detailFacts = (item: RemoteItem): string =>
    [itemFacts(item), (item.genres ?? []).join(" · ")].filter(Boolean).join(" · ");
  /** The hero block a series shares with the catalogue: its name, the facts and the provider's
   *  overview. Its chips are the hero's own row, drawn above this block like every other detail's,
   *  so the corner art beside that row cannot narrow it. A playable title reads the same through
   *  the shared shell instead. */
  const detailPieces = TitleExtraFacts({ extras: titleExtras.extras, language: uiLanguage, name: detail?.name });
  const seriesHeroCopy = (item: RemoteItem): ReactNode => {
    const facts = detailFacts(item);
    return <>
      <h2>{item.name}</h2>
      {(facts || detailPieces.ageBadge) && <p className="meta-line">{facts}{facts && detailPieces.ageBadge ? " " : null}{detailPieces.ageBadge}</p>}
      {detailPieces.heroLines}
      <p className="library-detail-synopsis">{item.overview || t("catalog.noDescription")}</p>
    </>;
  };
  const detailCrumb = (item: RemoteItem) =>
    item.type === "episode" ? `${t("mediaServer.episodeLabel", { season: item.season ?? 0, episode: item.episode ?? 0 })} · ${item.name}` : item.name;

  /** The title line a detail's playback and saves are labelled with. */
  const detailTitle = (item: RemoteItem) =>
    item.type === "episode" ? `${series ? `${series.name} · ` : ""}${episodeTitle(item)}` : item.name;
  const catalogueDownloadDetail = (item: RemoteItem, title: string): CatalogueDetailTarget | null => {
    if (item.type === "movie") {
      const ref = catalogueRef("movie", item.providerIds);
      return ref ? { type: ref.type, id: ref.id, name: title, ...(item.poster ? { poster: item.poster } : {}) } : null;
    }
    if (item.type !== "episode" || !series) return null;
    const ref = catalogueRef("series", series.providerIds);
    const season = item.season;
    const episode = item.episode;
    if (!ref || typeof season !== "number" || !Number.isInteger(season) || season < 0) return null;
    if (typeof episode !== "number" || !Number.isInteger(episode) || episode < 1) return null;
    return {
      type: "series", id: ref.id, name: series.name, season, episode,
      videoId: `${ref.id}:${season}:${episode}`, episodeTitle: episodeTitle(item),
      ...(series.poster ?? item.poster ? { poster: series.poster ?? item.poster } : {}),
    };
  };
  /** Catalogue artwork only: a provider proxy path never travels into an addon save. */
  const addonArtwork = () => ({
    ...(enrichment.meta?.poster ? { poster: enrichment.meta.poster } : {}),
    ...(enrichment.meta?.background ? { background: enrichment.meta.background } : {}),
  });

  /** Reads the subtitles of an explicitly started generic playback; an empty or failing answer
   *  never blocks the film, and a late one belongs to a playback that is gone. */
  const loadAddonSubtitles = (ref: CatalogueRef, stream: Stream) => {
    addonSubtitleAbort.current?.abort();
    const controller = new AbortController();
    addonSubtitleAbort.current = controller;
    const key = genericProgressKey(ref);
    void api.subtitles(ref.type, ref.id, controller.signal)
      .then((found) => {
        if (controller.signal.aborted) return;
        // The playback it answers for must be the one still on screen: another title reusing the
        // same source id has a different catalogue key and never receives these subtitles.
        setPlaying((value) => value && value.stream.sourceId === stream.sourceId && value.addon?.progressKey === key
          ? { ...value, addon: { ...value.addon, subtitles: found } } : value);
      })
      .catch(() => undefined);
  };

  /** Play from the detail: a version of this detail's own library keeps the provider's path and
   *  its favorite and hand-off, while a row of the viewer's own files, a copy from another library
   *  and an addon answer play on their own terms -- the file under its path, the copy under its own
   *  remote identity, the addon under the catalogue key -- and none of them borrows this item's
   *  history. */
  const playDetailStream = (stream: Stream, fromBeginning?: boolean, at?: number): boolean => {
    if (!detail || !selected) return false;
    const owner = sourceProgressOwner(stream, addonIdentity);
    if (!owner) return false;
    // A switch hands over the position the row on screen reached; a play from the detail resumes
    // from the store instead.
    const position = at !== undefined ? { at } : {};
    if (isRemoteStream(stream)) {
      // A copy that reports its own remote identity and belongs elsewhere is another library's
      // item: it plays under that identity, never under the item this detail was opened on.
      const foreign = stream.remoteItem && stream.remoteItem.libraryId !== selected.id ? stream.remoteItem : null;
      if (foreign) {
        setPlaying({ stream, libraryId: foreign.libraryId, item: detail, title: detailTitle(detail), favorite: false, fromBeginning, foreign: true, owner, scope: titleScope, ...position });
        return true;
      }
      setPlaying({ stream, libraryId: selected.id, item: detail, title: detailTitle(detail), favorite: state?.favorite ?? false, fromBeginning, owner, scope: titleScope, ...position });
      return true;
    }
    // The viewer's own copy of the title is a file on this server's disk: it plays and reports
    // under its own path, never under the catalogue key of the title it was listed beside, and
    // the catalogue is asked for no subtitles for it. Like a copy from another library it is not
    // this item's own version, so it borrows neither its favorite nor its hand-off.
    if (owner.kind === "file") {
      setPlaying({ stream, libraryId: selected.id, item: detail, title: detailTitle(detail), favorite: false, fromBeginning, owner, scope: titleScope, foreign: true, ...position });
      return true;
    }
    const ref = addonIdentity;
    if (!ref) return false;
    const poster = enrichment.meta?.poster;
    setPlaying({
      stream, libraryId: selected.id, item: detail, title: detailTitle(detail), favorite: false, fromBeginning,
      owner, scope: titleScope, ...position,
      addon: {
        identity: ref, progressKey: genericProgressKey(ref), scope: titleScope, media: addonMediaSubject(detail, series, addonArtwork()),
        subtitles: [], ...(poster ? { poster } : {}),
      },
    });
    loadAddonSubtitles(ref, stream);
    return true;
  };

  /** A switch starts the chosen row through the very path the detail's Play uses, at the position
   *  the row on screen was left at. The player stays mounted, so its track choices stand. */
  const switchDetailSource = (stream: Stream, positionSeconds: number) => {
    if (!playDetailStream(stream, false, positionSeconds)) throw new Error(t("player.noOtherSource"));
  };

  /** The exact subject and labels one addon row is saved under: the media identity keeps the
   *  parent series' catalogue id with no episode suffix, while the label stays episode-specific
   *  and the storage preview resolves the media subject's own title. */
  const addonSaveState = (stream: Stream, item: RemoteItem, title: string, media: Record<string, unknown>): AddonSaveRequest => {
    const kind = item.type === "movie" ? "movie" : "series";
    // The exact source decides the destination: another library's copy brings its own projection,
    // an addon answer the rule of its own addon.
    const destination = alternativeSaveRequest(title, stream, media, kind);
    return {
      stream, media, title, previewTitle: typeof media.title === "string" ? media.title : title, kind,
      ...(item.type === "episode" && item.season != null ? { season: item.season } : {}),
      ...(destination.rule ? { rule: destination.rule } : {}),
      ...(destination.ruleUnavailable ? { ruleUnavailable: true } : {}),
    };
  };

  /** Opens the destination dialog for the exact addon row that was clicked; a row the existing
   *  capability checks would refuse is never offered a queue. */
  /** Saves one row: the server resolves the destination the row's own source projected, and the
   *  viewer may ask to name one instead -- which is the whole job of the arrow half of the button.
   *  A copy whose library projected nothing asks for a destination rather than queueing a copy the
   *  server would refuse. */
  const openAddonSave = (request: AddonSaveRequest, choose = false) => {
    if (!canQueue(request.stream, realDebridConfigured)) return;
    if (choose || (isRemoteStream(request.stream) && sourceTargetRule(request.stream) === undefined)) {
      setAddonSave(request);
      return;
    }
    void api.download(request.title, request.stream, request.media)
      .then(() => onDownloadQueued?.())
      .catch(onError);
  };

  /**
   * Saves one row of this detail exactly as the row itself is: a version of the library the detail
   * was opened on keeps the native dialog and the versions already read for it, a copy that belongs
   * elsewhere is queued as the copy it is with the destination its own source projected, an addon
   * answer takes its addon's rule, and the viewer's own file is never offered. The detail's Save
   * action and the player of an already started row both come through here, so neither can drift.
   */
  const saveDetailStream = (stream: Stream, item: RemoteItem, title: string, media?: Record<string, unknown>, choose = false) => {
    const library = selectedRef.current;
    // A version of this library's own is the one row the arrow keeps a dialog of its own for: it
    // lists the versions already read for the item, and the button queues the row as it stands.
    if (choose && isRemoteStream(stream) && library && stream.remoteItem?.libraryId === library.id) {
      setSaveRequest({ library: saveLibrary(library), item, series, knownSources: sources, initialSource: stream, artwork: addonArtwork() });
      return;
    }
    openAddonSave(addonSaveState(stream, item, title, media ?? addonMediaSubject(item, series, addonArtwork())), choose);
  };
  const submitAddonSave = async (request: AddonSaveRequest, target?: SaveTarget) => {
    await api.download(request.title, request.stream, request.media, target);
    onDownloadQueued?.();
    return true;
  };
  const saveAddonToDevice = async (request: { stream: Stream; media: Record<string, unknown>; title: string }) => {
    try {
      const filename = await saveToDevice({ title: request.title, stream: request.stream, media: request.media });
      onNotify?.(t("save.startedViaServer", { filename }));
      return true;
    } catch (error) { onError(error); return false; }
  };
  /** A file of the viewer's own library reaches the device from its own path, exactly as the
   *  library listing offers it: the server resolves the file again rather than trusting the row. */
  const saveLibraryFileToDevice = async (path: string) => {
    try {
      const filename = await saveToDevice({ path });
      onNotify?.(t("save.startedViaServer", { filename }));
      return true;
    } catch (error) { onError(error); return false; }
  };

  /** Clears the selected row's own stores and nothing else: the title's key every version of a
   *  named title shares, the viewer's own file under its path, and the version's own remote state.
   *  The item on screen keeps its favorite and its watched flag, and a scope that moved on keeps its
   *  state. */
  const clearAlternativeProgress = async (stream: Stream): Promise<boolean> => {
    const owner = sourceProgressOwner(stream, addonIdentity);
    if (!owner || (owner.kind === "remote" && owner.item.libraryId === selected?.id && owner.item.itemId === detail?.id)) return false;
    const scope = titleScope;
    try {
      if (owner.kind === "file") await api.forgetProgress(owner.progressKey);
      else {
        if (owner.kind === "catalogue") await api.forgetProgress(owner.progressKey);
        // The version's own row goes with the title's: a position kept there before the title held
        // it is what the read falls back to, and it would hand the dropped position straight back.
        const remote = owner.kind === "remote" ? owner.item : owner.remote;
        if (remote) await api.saveRemoteState(remote.libraryId, remote.itemId, { position: 0, duration: 0, mediaSourceId: remote.mediaSourceId });
      }
      if (titleScopeRef.current !== scope) return false;
      setAlternativeProgress((current) => current && current.sourceKey === sourceIdentity(stream) ? null : current);
      return true;
    } catch (error) { onError(error); return false; }
  };
  /** After playback the panel shows what was really written, and only for the row still on screen
   *  in the scope the playback belonged to. A remote answer stands in only when it reports the very
   *  version that was played. */
  const refreshPlayedProgress = async (current: Playing) => {
    const owner = current.owner;
    const scope = current.scope;
    try {
      if (owner.kind === "remote" && owner.item.libraryId === selectedRef.current?.id && owner.item.itemId === detailRef.current?.id) {
        // The read itself is scoped to the item on screen: it is refused there when the reader
        // has moved on, so a completed hand-off still reports what it wrote.
        await refreshState();
        return;
      }
      const entry = owner.kind === "remote"
        ? await api.remoteState(owner.item.libraryId, owner.item.itemId)
          .then((value) => value && value.mediaSourceId === owner.item.mediaSourceId ? value : null)
        : await api.progressOf(owner.progressKey);
      if (titleScopeRef.current !== scope) return;
      const shown = detailStreamRef.current;
      if (!shown || sourceIdentity(shown) !== sourceIdentity(current.stream)) return;
      setAlternativeProgress(entry && entry.position > 0
        ? { sourceKey: sourceIdentity(current.stream), position: entry.position, duration: entry.duration } : null);
      onPersonalChange?.();
    } catch { /* the panel keeps the position it had */ }
  };

  const renderTile = (item: RemoteItem, onOpen: (item: RemoteItem) => void, preview: PreviewInput): ReactNode => {
    const key = `${preview.parentId ?? "root"}:${item.id}`;
    if (item.type === "folder" || item.type === "season") {
      // A season never previews: its children are episodes, whose collage says nothing about it.
      return <LibraryItem key={item.id} folder dataRemoteId={item.id} artRef={artRef(key)} onOpen={() => onOpen(item)}
        art={<RemoteFolderArt {...previewKey} parentId={item.id} enabled={preview.enabled && item.type !== "season"} target={artRef(key)} shape={libraryTileShape} poster={item.poster} wide={item.wide}/>}
        title={item.name} meta={itemMetaLine(item)} description={item.overview}
        action={<><FolderOpen/> {t("library.openFolder")} <ChevronRight/></>}/>;
    }
    const playable = item.type === "movie" || item.type === "episode";
    const stored = itemStates[stateKey(selected?.id ?? "", item.id)];
    const locked = menuLoading || menuBusy || Boolean(menuError);
    // A show the server could not identify has no picture of its own; it borrows the folder fan,
    // which the server draws from its episodes when its seasons have none either.
    const unpictured = item.type === "series" && !item.poster && !item.wide;
    return <LibraryItem key={item.id} dataRemoteId={item.id} artRef={artRef(key)} onOpen={() => onOpen(item)}
      art={<>
        {unpictured
          ? <RemoteFolderArt {...previewKey} parentId={item.id} enabled={preview.enabled} target={artRef(key)} shape={libraryTileShape}/>
          : <RemoteTileArt shape={libraryTileShape} poster={item.poster} wide={item.wide} fallback={<Film/>}/>}
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
        {/* Only a playable original can be copied; a folder, a series or a season never is. The
            versions are read once when this is pressed, never while the tile merely draws. */}
        {playable && <button onClick={() => { closeMenu(); if (selectedRef.current) setSaveRequest({ library: saveLibrary(selectedRef.current), item, knownSources: null }); }}><HardDrive/> {t("save.toLibrary")}</button>}
        <button onClick={() => { closeMenu(); onOpen(item); }}>{item.type === "series" ? <><FolderOpen/> {t("library.openFolder")}</> : <><CirclePlay/> {t("mediaServer.versions")}</>}</button>
      </LibraryItemMenu>
    </LibraryItem>;
  };

  const onBrowseScroll = (event: Parameters<typeof fold.compactOnScroll>[0]) => {
    fold.compactOnScroll(event, compact, onCompactChange);
    const element = event.currentTarget;
    if (element.scrollHeight - element.scrollTop - element.clientHeight <= Math.min(400, element.clientHeight || window.innerHeight || 800)) autoLoadRef.current();
  };

  return <>
    {!selected && !hideRoots && libraries && libraries.length > 0 && <section className="panel browse-panel remote-libraries" ref={rootRef} aria-label={t("mediaServer.remoteTitle")}>
      {/* The remote roots are the same panel the local listing is, so the two blocks share their
          heading, borders and grid padding; only the label says which is which. */}
      <div className="browse-head">
        <div className="browse-bar">
          <nav className="crumbs" aria-label={t("library.breadcrumbs")}>
            <button type="button" disabled><HardDrive/> {t("mediaServer.remoteTitle")}</button>
          </nav>
        </div>
      </div>
      <div className="browse-scroll">
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
            art={<RemoteLibraryArt libraryId={library.id} enabled={library.mosaic !== false} generation={0} target={artRef(key)} poster={library.poster}/>}
            onOpen={() => openLibrary(library)}
          />;
          })}
        </div>
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
            {/* The same first step the library's own listing keeps: whichever library is open, the
                way back to the section is named the same way, and only that step wears the icon. It
                closes the remote library the way Back from its listing does, so no detail stays behind. */}
            <button onClick={closeLibrary}><HardDrive/> {t("nav.library")}</button>
            <span><ChevronRight/></span>
            <button onClick={goLibraryRoot} disabled={!detail && !stack.length}>{selected.name}</button>
            {stack.map((folder, index) => <span key={folder.id}>
              <ChevronRight/>
              <button disabled={index === stack.length - 1 && !detail} onClick={() => goToFolder(index)}>{folder.name}</button>
            </span>)}
            {detail && series && detail.type === "episode" && !stack.some((folder) => folder.id === series.id) && <span>
              <ChevronRight/>
              <button onClick={goToSeries}>{series.name}</button>
            </span>}
            {detail && <span>
              <ChevronRight/>
              <button aria-current="page" disabled>{detailCrumb(detail)}</button>
            </span>}
          </nav>
          <div className="browse-tools">
            <div className={`fold browse-fold${compact ? " closed" : ""}`}><div className="browse-fold-inner">
              {!detail && <div className="search-input"><Search/><input value={searchInput} aria-label={t("library.filter")} placeholder={t("library.filterPlaceholder")} onChange={(event) => setSearchInput(event.target.value)}/></div>}
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
          {listing.cursor && <div className="load-more" ref={loadMoreItemsRef}><button type="button" disabled={listing.loading} onClick={() => void loadMoreItems()}>{t("common.loadMore")}</button></div>}
          {listing.loading && listing.items.length > 0 && <div className="loading" role="status">{t("common.loadingMore")}</div>}
        </>}
        {detail && detail.type === "series" && <div className="remote-detail library-title-detail remote-series-detail"
          style={seriesBackdrop ? { backgroundImage: `${LIBRARY_HERO_GRADIENT},url(${seriesBackdrop})` } : { backgroundImage: LIBRARY_HERO_EMPTY_GRADIENT }}>
          {/* The hero is transparent on the shared surface, so the episodes sit on the same wash and
              the gradient's dark bottom keeps them legible. */}
          <DetailHero className="library-detail-hero"
            chips={detailChips(detail, true)}
            gallery={seriesGallery.length && onGallery ? <button type="button" className={`gallery-open ${seriesGallery[0]!.shape === "wide" ? "wide" : "poster"}`}
              title={t("gallery.openHint")} onClick={() => onGallery(seriesGallery, catalogue)}>
              <img key={seriesGallery[0]!.url} src={seriesGallery[0]!.url} alt="" onError={hideBroken}/><span><Images/> {seriesGallery.length > 1 ? t("gallery.stillCount", { count: seriesGallery.length }) : t("gallery.enlarge")}</span>
            </button> : undefined}
            copy={seriesHeroCopy(detail)}/>
          <div className="subhead remote-episodes-head"><h3>{t("mediaServer.episodes")}</h3><span>{detail.name}</span></div>
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
          {episodes.cursor && <div className="load-more" ref={loadMoreEpisodesRef}><button type="button" disabled={episodes.loading} onClick={() => void loadEpisodes()}>{t("common.loadMore")}</button></div>}
          {episodes.loading && grouped.length > 0 && <div className="loading" role="status">{t("common.loadingMore")}</div>}
          <TitleExtrasRows extras={titleExtras.extras} loading={titleExtras.loading}/>
        </div>}
        {detail && detail.type !== "series" && <div className="remote-detail">
          <LibraryTitleDetail
            identityKey={`${selected!.id}:${detail.id}`}
            title={detail.name}
            {...(detail.type === "episode" ? { subtitle: t("mediaServer.episodeLabel", { season: detail.season ?? 0, episode: detail.episode ?? 0 }) } : {})}
            {...(detail.poster ? { poster: detail.poster } : {})}
            backdrops={detailBackdrops}
            gallery={seriesGallery}
            {...(onGallery ? { onGallery: (images) => onGallery(images, catalogue) } : {})}
            {...(detailFacts(detail) ? { facts: detailFacts(detail) } : {})}
            factsExtra={detailPieces.ageBadge}
            heroExtra={detailPieces.heroLines}
            extras={<TitleExtrasRows extras={titleExtras.extras} loading={titleExtras.loading}/>}
            {...(detail.overview ? { description: detail.overview } : {})}
            chips={detailChips(detail)}
            favorite={state?.favorite ?? false}
            favoriteDisabled={!state}
            onToggleFavorite={(next) => void toggleState({ favorite: next })}
            watched={state?.watched ?? false}
            watchedDisabled={!state}
            onToggleWatched={() => void toggleWatched()}
            sources={sources}
            defaultSources={sources}
            sourceProfiles={sourceProfiles}
            {...(defaultSort ? { defaultSort } : {})}
            {...(addonIdentity ? {
              sourceGroups: { groups: extra.groups, retry: extra.retry },
              onOpenSources: () => setChooserOpen(true),
              nativeSourceLabel: ownLabel,
              preferredLanguage: audioLanguage,
            } : {})}
            {...(sourceError ? { sourceError } : {})}
            onRetry={retryDetail}
            {...(resumeStableKey ? { resumeStableKey } : {})}
            {...(detailProgress ? { progress: detailProgress } : {})}
            onSourceChange={setDetailStream}
            // Only the item's own version drops the media-server item's own state; every other row
            // -- and every version of a title the catalogue can name -- clears what the row itself
            // stands for.
            onClearProgress={(stream) => {
              const owner = sourceProgressOwner(stream, addonIdentity);
              return owner?.kind === "remote" && owner.item.libraryId === selected!.id && owner.item.itemId === detail?.id
                ? toggleState({ position: 0, duration: 0 })
                : clearAlternativeProgress(stream);
            }}
            onPlay={playDetailStream}
            // Every row is saved as the row it is: the native dialog for this library's own
            // version, the copy's own projected destination for another library's, the addon's
            // rule for an answer, and nothing at all for a file that is already here.
            onSaveToLibrary={(stream) => saveDetailStream(stream, detail, detailTitle(detail))}
            // The arrow opens the shared rules when the item has an exact catalogue identity;
            // otherwise it keeps the destination dialog this row already used.
            onSaveElsewhere={(stream) => {
              const target = catalogueDownloadDetail(detail, detailTitle(detail));
              if (target && onCatalogueDownload) onCatalogueDownload(stream, target);
              else saveDetailStream(stream, detail, detailTitle(detail), undefined, true);
            }}
            // Only a source the server proved may be copied is offered the action, so a click
            // always reaches a real decision instead of a button that does nothing.
            saveSupported={(stream) => canQueue(stream, realDebridConfigured)}
            // The device at the keyboard: the server fetches the row it plays through its own
            // proxy, so a copy of this library reaches the device the way an addon answer does.
            onDownloadToDevice={(stream) => void (isLocalStream(stream) && stream.localPath
              ? saveLibraryFileToDevice(stream.localPath)
              : saveAddonToDevice({ stream, media: addonMediaSubject(detail, series, addonArtwork()), title: detailTitle(detail) }))}
            sourceBadge={() => t(providerKey(selected!.provider))}
          />
          {stateError && <div className="remote-error" role="alert">
            <span>{stateError}</span>
            <button type="button" onClick={retryDetail}>{t("mediaServer.retry")}</button>
          </div>}
        </div>}
      </div>
    </div>}
    {playing && (() => {
      // A row that is not one of this item's own versions -- the viewer's own file, another
      // library's copy, an addon answer -- plays on its own terms: no native favorite, no
      // next/previous hand-off, and its own progress store. A version of this detail's own
      // library keeps every one of them.
      const addon = playing.addon;
      const away = Boolean(addon || playing.foreign);
      return <Player
        open
        title={playing.title}
        stream={playing.stream}
        subtitles={addon?.subtitles ?? playing.subtitles ?? []}
        subtitleLanguage={subtitleLanguage}
        audioLanguage={audioLanguage}
        previousTitle={away ? undefined : playPrevious ? episodeTitle(playPrevious) : undefined}
        onPrevious={away ? undefined : playPrevious ? () => changeEpisode(playPrevious) : undefined}
        nextTitle={away ? undefined : playNext ? episodeTitle(playNext) : undefined}
        onNext={away ? undefined : playNext ? () => changeEpisode(playNext) : undefined}
        autoNext={false}
        nextBusy={nextBusy}
        favorite={away ? undefined : playing.favorite}
        fromBeginning={playing.fromBeginning}
        onToggleFavorite={away ? undefined : () => void togglePlayingFavorite()}
        progressKey={playing.owner.kind === "remote" ? undefined : playing.owner.progressKey}
        progressPoster={addon?.poster ?? playing.item.poster}
        // The row that is playing is the row that is saved, whichever way it was started: an addon
        // answer through its own captured subject, a copy of another media server through the
        // destination that copy projects, a version of this detail's own library through the
        // native dialog. The viewer's own file is already here and is never queued as a copy.
        onDownload={async () => {
          if (addon) openAddonSave(addonSaveState(playing.stream, playing.item, playing.title, addon.media));
          else saveDetailStream(playing.stream, playing.item, playing.title);
          return false;
        }}
        onDeviceDownload={addon
          ? () => saveAddonToDevice({ stream: playing.stream, media: addon.media, title: playing.title })
          : async () => {
            // A file of the viewer's own library is pulled down from the path it already has; a
            // copy another media server owns is never taken to the device from here.
            const path = playing.owner.kind === "file" ? playing.stream.localPath : undefined;
            return path ? saveLibraryFileToDevice(path) : false;
          }}
        // The final write names its own version: another source's completion never redraws this
        // panel, and the refresh waits for the write itself rather than for a guessed delay.
        onProgressSaved={(key) => {
          if (key === playing.owner.key && !playingRef.current) void refreshPlayedProgress(playing);
        }}
        // Every media-server play offers the Sources control, as every other play does: this
        // item's own versions lead, and the title's other groups follow once the panel asks for
        // them. Nothing is read before that: the panel is the hook's own `open`.
        sources={{
          lead: sources ?? [], leadLabel: ownLabel, groups: extra.groups,
          panel: { groups: extra.groups, retry: extra.retry },
          onOpen: () => setPlayerSourcesOpen(true),
          onSwitch: switchDetailSource,
        }}
        sourceProfiles={sourceProfiles}
        {...(defaultSort ? { defaultSort } : {})}
        {...(playing.at !== undefined ? { startAtSeconds: playing.at } : {})}
        onClose={() => {
          cancelHandoff(); addonSubtitleAbort.current?.abort(); setPlayerSourcesOpen(false); setPlaying(null);
        }}/>;
    })()}
    {addonSave && <SaveTargetDialog
      label={addonSave.title} kind={addonSave.kind} title={addonSave.previewTitle}
      {...(addonSave.season != null ? { season: addonSave.season } : {})}
      libraries={downloadLibraries}
      rule={addonSave.rule ?? addons.find((addon) => addon.key === addonSave.stream.addonKey)?.downloadSettings}
      ruleUnavailable={addonSave.ruleUnavailable ?? false}
      onClose={() => setAddonSave(null)}
      onSubmit={(target) => submitAddonSave(addonSave, target)}/>}
    {saveRequest && <NativeLibrarySaveDialog
      key={`${saveRequest.item.id}:${saveRequest.knownSources ? "known" : "lazy"}`}
      library={saveRequest.library}
      item={saveRequest.item}
      series={saveRequest.series ?? null}
      knownSources={saveRequest.knownSources}
      initialSource={saveRequest.initialSource}
      libraries={downloadLibraries}
      {...(saveRequest.artwork ? { artwork: saveRequest.artwork } : {})}
      onClose={() => setSaveRequest(null)}
      onQueued={() => onDownloadQueued?.()}/>}
  </>;
}

interface PreviewInput { enabled: boolean; parentId?: string }
