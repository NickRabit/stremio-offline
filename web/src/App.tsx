import { FormEvent, ReactNode, TouchEvent as ReactTouchEvent, UIEvent, WheelEvent as ReactWheelEvent, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, BarChart3, Bell, BellRing, History, ArrowUp, Check, RectangleHorizontal, RectangleVertical, Copy, FolderInput, FolderOpen, Home as HomeIcon, ImageOff, Images, LayoutGrid, List, MoreVertical, PanelLeftClose, PanelLeftOpen, Pencil, RotateCcw, ShieldQuestion, SlidersHorizontal, Sparkles, Star, Link2, LogOut, ChevronDown, ChevronLeft, ChevronRight, CirclePlay, Download, Film, FolderCog, HardDrive, Library, PackagePlus, Play, Plus, RefreshCw, Search, SearchX, Settings, Subtitles, Trash2, X } from "lucide-react";
import { preloadLibraryPosters, scheduleIdle } from "./library-preload";
import { api, ApiError, describeError, saveToDevice } from "./api";
import { LoginScreen, PasswordChangeRequired } from "./Login";
import { bytes, Heading, hideBroken } from "./settings-ui";
import { Player } from "./Player";
import { TrailerPlayer } from "./TrailerPlayer";
import { IdentifyDialog } from "./IdentifyDialog";
import { AddonManager } from "./AddonManager";
import { LibraryManagerDialog, libraryTypeLabel } from "./LibraryManager";
import { PosterMosaic, TileArt } from "./TileArt";
import { MoveDialog } from "./MoveDialog";
import { SaveTargetDialog } from "./SaveTargetDialog";
import type { SaveTarget } from "./save-target";
import { SuggestionsDialog } from "./SuggestionsDialog";
import { SeriesDownloadDialog } from "./SeriesDownloadDialog";
import { FollowDialog, toEpisodes } from "./FollowDialog";
import { FollowingPage } from "./FollowingPage";
import { LibraryShelf } from "./LibraryShelf";
import { StatsPanel } from "./Stats";
import { report } from "./diagnostics";
import { label, titleLanguage } from "./languages";
import { locale, localeTag, setLocale, t, useI18n, type Key } from "./i18n";
import { addonNotices, canQueue, noticeText, offeredStreams, pickDefaultStream, pickNextEpisodeStream, repickStream, streamBadge, streamLanguages, streamSize, visibleCatalogStreams, type StreamSort } from "./streams";
import { parseSearchScope } from "./search-scope";
import { createLiveSearch, type LiveSearch, type LiveSearchState } from "./live-search";
import { rankByTitle } from "./title-match";
import { CandidatePool, suggest, type Suggestion } from "./search-suggestions";
import { galleryPayload, gridArt, localizedDownloadTitle, mergeMetaDetail } from "./meta";
import { catalogResumeEntries, localResumeEntries } from "./resume-visibility";
import { resumeTarget, resumeVideo, type ResumeTarget } from "./resume-target";
import { trailerAction } from "./trailers";
import { emptyViews, prefsFor, scopeOf, withDownloads, withExtra, withLibrary } from "./views";
import { Empty, Nav, Onboarding } from "./app-chrome";
import { Downloads } from "./DownloadsPage";
import { Home } from "./Home";
import { useHome } from "./useHome";
import type { ShowAllTarget } from "./home-cards";
import type { HomeCard } from "../../server/src/home";
import { MoreMenu, type MoreItem } from "./MoreMenu";
import { fmtEta } from "./download-format";
import { MediaGallery, type GalleryImage, type GalleryKind } from "./MediaGallery";
import { SettingsPage } from "./SettingsPage";
import { resolveStartView } from "./start-view";
import type { Addon, BuildInfo, BrowseFile, BrowseItem, BrowseLibrary, BrowseResult, DeviceTransfer, DownloadsViewPrefs, FollowView, LibraryOp, LibraryOpsState, LibrarySort, LibraryView, LibraryViewPrefs, NewEpisode, ProgressEntry, UserViews, WatchlistEntry, AddonDownloadSettings, Catalog, Download as DownloadJob, DownloadSelection, Inspection, Meta, QueueHalt, ScanState, SearchableCatalog, Session, Settings as AppSettings, SettingsPatch, SiteLink, Stream, Subtitle, Trailer, Video, SearchState } from "./types";

/** The names of the linked sites. They are trademarks, not interface text, so they are
 *  spelled the same in every language and live here rather than in the catalogues. */
const SITE_LINKS: Record<SiteLink["site"], string> = { csfd: "ČSFD", tmdb: "TMDB", imdb: "IMDb" };

/** The library choices this browser kept before they moved onto the account. Read once and
 *  handed to the visible libraries; private mode may forbid storage, hence the try/catch. */
const recall = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
  try { const value = localStorage.getItem(`library-${key}`); return allowed.includes(value as T) ? value as T : fallback; }
  catch { return fallback; }
};
const LEGACY_KEYS = ["sort", "order", "view", "favorites"] as const;
const legacyLibraryView = (): LibraryViewPrefs | null => {
  try {
    if (!LEGACY_KEYS.some((key) => localStorage.getItem(`library-${key}`) !== null)) return null;
    return {
      sort: recall("sort", ["name", "added", "size", "random"] as const, "name") as LibrarySort,
      order: recall("order", ["asc", "desc"] as const, "asc"),
      favoritesOnly: recall("favorites", ["0", "1"] as const, "0") === "1",
      view: recall("view", ["grid", "list"] as const, "grid"),
    };
  } catch { return null; }
};
const forgetLegacy = () => { try { for (const key of LEGACY_KEYS) localStorage.removeItem(`library-${key}`); } catch { /* storage may be unavailable */ } };

type View = "home" | "catalog" | "library" | "following" | "downloads" | "stats" | "addons" | "settings";
type PlaybackAnchor = { kind: "catalog" | "library"; key: string };
/** What a list is looking at, in terms the layout cannot invalidate: the item on top and
 *  how far it sits into the view. A rotation rewrites every pixel offset; this survives. */
type ViewAnchor = PlaybackAnchor & { offset: number };
type PlaybackReturn = {
  view: View;
  windowY: number;
  gridY?: number;
  catalogCompact: boolean;
  anchor?: PlaybackAnchor & { element: HTMLElement; ratio: number };
};
const streamLabel = (item: Stream) => item.name || item.title?.split("\n")[0] || item.description?.split("\n")[0] || "Stream";
/** A Continue watching tile: the stored position plus the season, the episode number and the
 *  show, which only the preview answers. A tile without them offers no next episode.
 *  `series` comes from the library row, which knows the show by name; the catalogue's own
 *  `series` on a progress entry describes an episode key and never reaches this strip. */
type ResumeTile = Omit<ProgressEntry, "series"> & Partial<Pick<BrowseFile, "season" | "episode" | "series">>;

/** Addons name types freely; only the two we filter by have a translation. */
const typeLabel = (type: string) => type === "movie" ? t("catalog.movies") : type === "series" ? t("catalog.series") : type;
/** The same type as a parenthesised hint next to a catalogue's own name. */
const typeTag = (type: string) => type === "movie" ? t("catalog.typeMovie") : type === "series" ? t("catalog.typeSeries") : type;
/** A video entry may carry nothing but its place in the show; the episode list names it by that. */
const episodeLabel = (video: Video) => video.title || video.name
  || (video.season != null || video.episode != null
    ? `${String(video.season ?? 0).padStart(2, "0")}×${String(video.episode ?? 0).padStart(2, "0")}`
    : t("episodes.one"));


/** Two bars, because the preview reserves a two-line box. */
const skeletonLines = <><span className="skeleton-line"/><span className="skeleton-line"/></>;
/** The IMDb score the catalogue addon carries, as it writes it. Absent for a title nobody
 *  has rated, and never TMDB's own average, which is a different number. */
const imdbRating = (item: Meta | null): string | null => {
  const raw = item?.imdbRating;
  const value = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  return /^\d+(\.\d+)?$/.test(value) ? value : null;
};
const galleryFor = (item: Meta | null): GalleryImage[] => {
  if (!item) return [];
  const images: GalleryImage[] = [];
  const seen = new Set<string>();
  const add = (value: unknown, label: string, shape: GalleryImage["shape"], kind: GalleryKind) => {
    if (typeof value !== "string" || !value.trim() || seen.has(value)) return;
    seen.add(value); images.push({ url: value, label, shape, kind });
  };
  add(item.poster, t("gallery.poster"), "poster", "poster");
  add(item.background, t("gallery.background"), "wide", "background");
  add(item.logo, t("gallery.logo"), "wide", "logo");
  for (const key of ["images", "screenshots"]) {
    const values = item[key];
    if (!Array.isArray(values)) continue;
    for (const [index, value] of values.entries()) {
      const candidate = typeof value === "object" && value ? value as Record<string, unknown> : undefined;
      add(typeof value === "string" ? value : candidate?.url ?? candidate?.src, t("gallery.still", { index: index + 1 }), "wide", "still");
    }
  }
  for (const video of item.videos ?? []) add(video.thumbnail, video.title || video.name || t("gallery.episodeStill"), "wide", "still");
  return images.slice(0, 18);
};

export function App() {
  const { t } = useI18n();
  const [view, setView] = useState<View>("catalog"); const [addons, setAddons] = useState<Addon[]>([]); const [catalogs, setCatalogs] = useState<Catalog[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem("sidebar-collapsed") === "1"; } catch { return false; }
  });
  const [catalogReset, setCatalogReset] = useState(0);
  const [statsReset, setStatsReset] = useState(0);
  const scrollByView = useRef<Partial<Record<View, number>>>({});
  const libraryPrewarmStarted = useRef(false);
  const restoringScroll = useRef(false);
  const viewRef = useRef<View>("catalog");
  /** True once the person has chosen a view themselves, so the start-page switch never
   *  drags them away from where they went on purpose. Reset on a fresh sign-in. */
  const navigated = useRef(false);
  const [galleryIndex, setGalleryIndex] = useState<number | null>(null);
  /** A library item's saved pictures, which take the overlay over while it is open. */
  const [storedGallery, setStoredGallery] = useState<GalleryImage[] | null>(null);
  const [detailCompact, setDetailCompact] = useState(false);
  const [catalogCompact, setCatalogCompact] = useState(false);
  const quietFocus = useRef(false);
  const [libraryCompact, setLibraryCompact] = useState(false);
  const scrollDirection = useRef(new WeakMap<HTMLElement, { top: number; travel: number; until: number }>());
  // A tap does not end the scroll: Safari's momentum runs on for a while afterwards, and those
  // events would fold the header the tap has just opened, which opens again, which folds -- the
  // flicker. So a header opened by hand is held open for as long as that fling lasts, and a
  // fling can last several seconds. Nothing counts it down: it ends when the list falls quiet,
  // or when a new gesture asks for something else. A hold on a timer was tried and it expired
  // mid-fling, folding the header under the reader; a hold that only a gesture could end was
  // tried too, and it outlived the fling and left the header stuck open.
  const heldOpen = useRef(false);
  const holdIdle = useRef(0);
  const releaseHold = () => { heldOpen.current = false; window.clearTimeout(holdIdle.current); };
  const holdHeaderOpen = () => { heldOpen.current = true; };
  useEffect(() => {
    for (const event of ["touchstart", "wheel", "keydown"]) window.addEventListener(event, releaseHold, { passive: true });
    return () => { for (const event of ["touchstart", "wheel", "keydown"]) window.removeEventListener(event, releaseHold); };
  }, []);
  // A deliberate pull towards the start restores folded headers; small direction changes do not.
  function compactOnScroll(event: UIEvent<HTMLDivElement>, compact: boolean, update: (value: boolean) => void, revealOnPull = false) {
    if (playerOpenRef.current || restoringScroll.current) return;
    const element = event.currentTarget;
    const top = Math.max(0, element.scrollTop);
    const previous = scrollDirection.current.get(element) ?? { top: 0, travel: 0, until: 0 };
    const delta = top - previous.top;
    const travel = Math.sign(delta) === Math.sign(previous.travel) ? previous.travel + delta : delta;
    const now = performance.now();
    // Hysteresis, and it is deliberately lopsided. Hiding asks for a deliberate push down and
    // only once the list has really left its top; bringing the header back asks for much more,
    // because a thumb that drifts twenty pixels upward did not mean to ask for it.
    const next = top <= 32 ? false
      : travel > 56 && top > 80 ? true
      : revealOnPull && travel < -64 ? false
      : compact;
    const header = element.closest(".detail-panel")?.querySelector(".hero");
    const headerHeight = header?.getBoundingClientRect().height ?? 200;
    // Keep the list scrollable after hiding its header, so reversing direction still restores it.
    const canHide = element.scrollHeight - element.clientHeight > headerHeight + 32;
    if (heldOpen.current) {
      // Still moving, so keep holding -- and let go shortly after it stops.
      window.clearTimeout(holdIdle.current);
      holdIdle.current = window.setTimeout(releaseHold, 160);
    }
    const changed = !heldOpen.current && now >= previous.until && next !== compact && (!next || canHide);
    scrollDirection.current.set(element, { top, travel: changed ? 0 : travel, until: changed ? now + 250 : previous.until });
    if (changed) update(next);
  }
  type TreeItem = Extract<BrowseItem, { kind: "folder" | "file" }>;
  const [selectedCatalog, setSelectedCatalog] = useState(""); const [search, setSearch] = useState(""); const [items, setItems] = useState<Meta[]>([]); const [selected, setSelected] = useState<Meta | null>(null); const [selectedSummary, setSelectedSummary] = useState<Meta | null>(null); const [selectedDownloadTitle, setSelectedDownloadTitle] = useState("");
  const [selectedVideo, setSelectedVideo] = useState<Video | null>(null); const [streams, setStreams] = useState<Stream[]>([]); const [selectedStream, setSelectedStream] = useState<Stream | null>(null); const [subtitles, setSubtitles] = useState<Subtitle[]>([]); const [localEpisode, setLocalEpisode] = useState(false); const [playbackPreferences, setPlaybackPreferences] = useState<{ audioLanguage?: string; subtitleLanguage?: string | null }>({});
  const nextEpisodePrefetchRef = useRef<{ id: string; promise: Promise<{ streams: Stream[]; subtitles: Subtitle[] }> } | null>(null);
  const [sourcesLoaded, setSourcesLoaded] = useState(false); const [metaLoading, setMetaLoading] = useState(false);
  const [titleLinks, setTitleLinks] = useState<SiteLink[]>([]);
  const [libraryLinks, setLibraryLinks] = useState<Record<string, SiteLink[]>>({});
  const [titleTrailer, setTitleTrailer] = useState<Trailer | null>(null);
  const [libraryTrailers, setLibraryTrailers] = useState<Record<string, Trailer | null>>({});
  const [trailerOpen, setTrailerOpen] = useState<Trailer | null>(null);
  const [episodesOpen, setEpisodesOpen] = useState(true);
  const [season, setSeason] = useState<number | null>(null);
  const [bulkDownload, setBulkDownload] = useState<{ label: string; title: string; type: string; episodes: Array<{ id: string; season?: number; episode?: number; title?: string }>; media: { id?: string; metaType?: string; poster?: string; background?: string; gallery?: Array<{ url: string; kind: GalleryKind }> } } | null>(null);
  const [downloads, setDownloads] = useState<DownloadJob[]>([]); const [queueHalt, setQueueHalt] = useState<QueueHalt | null>(null); const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [error, setError] = useState(""); const [playerOpen, setPlayerOpen] = useState(false);
  const [deviceTransfers, setDeviceTransfers] = useState<DeviceTransfer[]>([]);
  const [settings, setSettings] = useState<AppSettings>({ concurrentDownloads: 1, parallelPerProvider: 1, downloadSegments: 2, uiLanguage: locale(), audioLanguage: "en", subtitleLanguage: "en", downloadTitleLanguage: "ui", mergeByName: true, streamSort: "recommended", trackProgress: true, showResumeRow: true, libraryAutoScan: true, libraryScanPauseOnDownload: false, secureMode: true, addonRefreshHours: 24, catalogTileSize: "medium", libraryTileSize: "medium", catalogTileShape: "poster", libraryTileShape: "poster", homeTileShape: "wide", startView: "catalog", libraryShelf: "resume", realDebridConfigured: false, tmdbConfigured: false });
  const [languages, setLanguages] = useState<Array<{ code: string; name: string }>>([]);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const home = useHome({ active: view === "home", account: session?.username ?? null, admin: session?.role === "admin", playerOpen });
  const [resumePreview, setResumePreview] = useState<BrowseResult | null>(null);
  const [favoritePreview, setFavoritePreview] = useState<BrowseResult | null>(null);
  const [browse, setBrowse] = useState<BrowseResult | null>(null);
  const [libraries, setLibraries] = useState<LibraryView[]>([]);
  const refreshLibraries = () => api.libraries().then(setLibraries).catch(() => undefined);
  const libraryIds = useMemo(() => libraries.map((library) => library.id), [libraries]);
  const [views, setViews] = useState<UserViews>(() => emptyViews());
  /** Set once the stored views and the library list are both in, before the first listing. */
  const [viewsReady, setViewsReady] = useState(false);
  const [browseApplied, setBrowseApplied] = useState(false);
  const [browsePath, setBrowsePath] = useState(""); const [browseQuery, setBrowseQuery] = useState("");
  const [browseSort, setBrowseSort] = useState<LibrarySort>("name");
  const [browseDesc, setBrowseDesc] = useState(false);
  const [browseView, setBrowseView] = useState<"grid" | "list">("grid");
  const [browseBusy, setBrowseBusy] = useState(false);
  const [identifyPath, setIdentifyPath] = useState<string | null>(null);
  const [movePath, setMovePath] = useState<{ path: string; label: string; type?: "movie" | "series"; paths?: string[]; copy?: boolean } | null>(null);
  const [saveTargetOpen, setSaveTargetOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [libraryOps, setLibraryOps] = useState<LibraryOpsState[]>([]);
  const [bulkIdentifyPaths, setBulkIdentifyPaths] = useState<string[] | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  // Identification opened from the suggestion list sits above it rather than replacing it:
  // the list keeps its rows, its scroll position and its filter while the dialog is open.
  const [identifyFrom, setIdentifyFrom] = useState<string | null>(null);
  const [appliedSuggestion, setAppliedSuggestion] = useState<string | null>(null);
  const [libraryManagerOpen, setLibraryManagerOpen] = useState(false);
  const [suggestionCount, setSuggestionCount] = useState(0);
  const [libraryScan, setLibraryScan] = useState<ScanState | null>(null);
  const [scanHintDismissed, setScanHintDismissed] = useState(() => {
    try { return localStorage.getItem("library-scan-hint-dismissed") === "1"; }
    catch { return false; }
  });
  const scanStatus = useRef<ScanState["status"] | undefined>(undefined);
  const opsStatus = useRef(new Map<string, LibraryOpsState["status"]>());
  const finishingOps = useRef(new Set<string>());
  const scanWanted = useRef(false);
  const [scanEpoch, setScanEpoch] = useState(0);
  const browseRequest = useRef(0);
  const browseLocation = useRef("");
  const browseSeed = useRef(String(Date.now()));
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  // Not remembered between visits, unlike the favourites filter: this one is for working
  // through what the scan proposed, and once that queue is empty it has nothing to show.
  const [onlyUnconfirmed, setOnlyUnconfirmed] = useState(false);
  /** "Show in library" must find the file: turn favorites-only off for this visit without
   *  writing that to the account. The next scope apply would otherwise put the stored
   *  filter back on before the listing runs. */
  const suppressFavoritesApply = useRef(false);
  browseLocation.current = JSON.stringify([browsePath, browseQuery, browseSort, browseDesc, onlyFavorites, onlyUnconfirmed]);
  // Preserve the favorites breadcrumb when entering a folder from favorites.
  const [fromFavorites, setFromFavorites] = useState(false);
  const [resume, setResume] = useState<ProgressEntry[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);
  const [follows, setFollows] = useState<FollowView[]>([]);
  const [newEpisodes, setNewEpisodes] = useState<NewEpisode[]>([]);
  const [detailFollow, setDetailFollow] = useState<FollowView | null>(null);
  const [followDialogOpen, setFollowDialogOpen] = useState(false);
  /** The series whose Follow chip was pressed: how to follow it is asked before anything is saved. */
  const [followStart, setFollowStart] = useState<Meta | null>(null);
  const [libraryFavorites, setLibraryFavorites] = useState<string[]>([]);
  const [localPoster, setLocalPoster] = useState<string | undefined>(undefined);
  // The path the listing should scroll to and highlight after a jump from the download queue.
  const [browseFocus, setBrowseFocus] = useState<string | null>(null);
  const focusScrolled = useRef<string | null>(null);
  const focusTimer = useRef(0);

  const toggleSelection = (itemPath: string) => setSelectedPaths((current) => {
    const next = new Set(current);
    if (next.has(itemPath)) next.delete(itemPath); else if (next.size < 500) next.add(itemPath);
    return next;
  });
  const leaveSelection = () => { setSelectionMode(false); setSelectedPaths(new Set()); };
  const refreshLibraryOps = async () => {
    const snapshot = await api.libraryOps();
    setLibraryOps(snapshot.jobs);
    return snapshot.jobs;
  };
  const finishLibraryOp = async (job: LibraryOpsState) => {
    if (finishingOps.current.has(job.id)) return;
    finishingOps.current.add(job.id);
    opsStatus.current.set(job.id, job.status);
    try {
      // A move the user asked for by hand lands somewhere they did not see before, so the
      // listing follows it there. Any other job only leaves a gap behind.
      const target = job.op === "move" && job.total === 1 && job.failed === 0 ? job.results[0]?.to : undefined;
      if (target) revealInLibrary(target);
      else await loadBrowse(browsePath);
      await Promise.all([api.progressList().then(setResume), api.watchlist().then(setWatchlist)]);
      // A job the user stopped did not finish the item, so it keeps the plain wording even
      // when it was the only one.
      const single = job.status === "completed" && job.total === 1
        ? job.op === "move" ? "library.moved" : job.op === "copy" ? "library.copied" : job.op === "delete" ? "library.deleted" : undefined
        : undefined;
      // One item that failed has one reason, and the dialog that would have shown it has
      // closed by now: a count of failures would leave the reason nowhere at all.
      const only = job.total === 1 ? job.results.find((result) => !result.ok) : undefined;
      if (job.error) fail(new ApiError(job.error, 0, undefined, job.errorKey, job.errorVars));
      else if (only) fail(new ApiError(only.error ?? t("library.bulkFinishedFailed", { failed: 1, total: 1 }), 0, undefined, only.errorKey));
      else notify(job.failed
        ? t("library.bulkFinishedFailed", { failed: job.failed, total: job.total })
        : single ? t(single) : t("library.bulkFinished"));
    } finally { finishingOps.current.delete(job.id); }
  };
  const trackQueuedOp = async (id: string) => {
    opsStatus.current.set(id, "paused");
    const jobs = await refreshLibraryOps();
    const job = jobs.find((candidate) => candidate.id === id);
    if (job && job.status !== "running" && job.status !== "paused") await finishLibraryOp(job);
  };
  const startBulk = async (operation: LibraryOp) => {
    try {
      const queued = await api.startLibraryOp(operation);
      leaveSelection();
      await trackQueuedOp(queued.id);
    } catch (error) { fail(error); }
  };
  const openBulkDestination = (copy: boolean) => {
    const paths = [...selectedPaths];
    const selectedItems = browse?.items.filter((item): item is TreeItem => item.kind !== "library" && selectedPaths.has(item.path)) ?? [];
    const kinds = new Set(selectedItems.map((item) => item.titleType).filter(Boolean));
    setMovePath({ path: paths[0]!, paths, copy, label: t("library.bulkItems", { count: paths.length }), type: kinds.size === 1 ? [...kinds][0] : undefined });
  };
  const deleteBulk = () => {
    const items = [...selectedPaths];
    if (items.length && confirm(t("library.bulkDeleteConfirm", { count: items.length }))) void startBulk({ op: "delete", items });
  };
  const createFolder = async () => {
    const name = prompt(t("library.createFolderPrompt"));
    if (!name) return;
    try {
      await api.createLibraryFolder(browsePath, name);
      notify(t("library.folderCreated"));
      await loadBrowse(browsePath);
    } catch (error) { fail(error); }
  };

  const removeItem = async (itemPath: string, label: string, folder: boolean) => {
    setMenuFor(null);
    if (!confirm(t(folder ? "library.deleteFolderConfirm" : "library.deleteFileConfirm", { name: label }))) return;
    void startBulk({ op: "delete", items: [itemPath] });
  };
  const toggleFavorite = async (itemPath: string, favorite: boolean) => {
    setMenuFor(null);
    try { await api.setFavorite(itemPath, favorite); await loadBrowse(browsePath); } catch (error) { fail(error); }
  };
  const inWatchlist = (type?: string, id?: string) => Boolean(id && watchlist.some((item) => item.key === `${type ?? "movie"}:${id}`));
  const toggleWatchlist = async (item: Meta) => {
    const favorite = !inWatchlist(item.type, item.id);
    try {
      await api.setWatchlist({ type: item.type || "movie", id: item.id, name: item.name, poster: item.poster, favorite });
      setWatchlist(await api.watchlist());
      notify(t(favorite ? "watchlist.added" : "watchlist.removed"));
    } catch (error) { fail(error); }
  };
  /** The player's star points where it belongs: a file to the library, a title to the list. */
  const togglePlayerFavorite = async () => {
    const path = localStream?.localPath;
    if (path) {
      const wanted = !libraryFavorites.includes(path);
      try {
        await api.setFavorite(path, wanted);
        setLibraryFavorites((current) => wanted ? [...current, path] : current.filter((item) => item !== path));
        notify(t(wanted ? "favorite.added" : "favorite.removed"));
      } catch (error) { fail(error); }
      return;
    }
    if (selected) await toggleWatchlist(selected);
  };

  /** Opens a catalogue title; the resume position then follows from the key on its own. */
  const openFromCatalog = async (entry: { type: string; id: string; name: string; poster?: string }) => {
    navigated.current = true;
    setView("catalog");
    await openMeta({ id: entry.id, type: entry.type, name: entry.name, poster: entry.poster } as Meta);
  };

  const forgetWatched = async (itemPath: string) => {
    setMenuFor(null);
    try { await api.forgetProgress(`file:${itemPath}`); await loadBrowse(browsePath); setResume(await api.progressList()); }
    catch (error) { fail(error); }
  };
  const renameItem = async (itemPath: string, label: string) => {
    setMenuFor(null);
    const wanted = prompt(t("library.renamePrompt"), label);
    if (!wanted || wanted === label) return;
    try { await api.renameLibraryItem(itemPath, wanted); notify(t("library.renamed")); await loadBrowse(browsePath); } catch (error) { fail(error); }
  };
  const openMove = (itemPath: string, label: string, type?: "movie" | "series") => { setMenuFor(null); setMovePath({ path: itemPath, label, type }); };
  const openIdentify = (itemPath: string) => { setMenuFor(null); setIdentifyPath(itemPath); };
  const unmatchItem = async (itemPath: string) => {
    setMenuFor(null);
    try {
      await api.matchLibraryItem({ path: itemPath, id: "", type: "movie" });
      notify(t("library.unmatched"));
      await loadBrowse(browsePath);
    } catch (error) { fail(error); }
  };
  const setCatalogLookup = async (itemPath: string, enabled: boolean) => {
    setMenuFor(null);
    try {
      await api.matchLibraryItem({ path: itemPath, skipLookup: !enabled });
      notify(t(enabled ? "library.lookupEnabled" : "library.lookupSkipped"));
      await loadBrowse(browsePath);
    } catch (error) { fail(error); }
  };
  const loadSuggestionCount = async () => {
    // Matching suggestions are an administrator's business and the endpoint refuses anybody
    // else, so an ordinary account would spend a refusal on every load to learn nothing.
    if (session?.role !== "admin") return;
    try { setSuggestionCount((await api.librarySuggestions()).total); }
    catch { /* the count is optional chrome */ }
  };
  const applyScanState = (state: ScanState) => {
    setLibraryScan(state);
    if (state.status === "completed" && scanWanted.current) {
      scanWanted.current = false;
      notify(t("library.scanDone", { matched: state.matched, skipped: state.skipped, failed: state.failed }));
      setScanEpoch((value) => value + 1);
      void loadSuggestionCount();
    }
  };
  /** The library the browse path is inside. One configured library has no prefix on the
   *  wire path, so it is named by its own id rather than read out of the path. */
  const currentLibraryId = libraries.length === 1
    ? libraries[0]?.id
    : libraries.find((library) => browsePath === library.id || browsePath.startsWith(`${library.id}/`))?.id;
  const startScan = async (options: { force?: boolean } = {}) => {
    try {
      scanWanted.current = true;
      const state = await api.startLibraryScan(options);
      scanStatus.current = state.status;
      applyScanState(state);
    } catch (error) { scanWanted.current = false; fail(error); }
  };
  /** The repair path for a wrong automatic binding: one library's unlocked scan records
   *  are looked at again, and anything that now reads differently comes back as a proposal. */
  const recheckAutomatic = async () => {
    setMenuFor(null);
    const libraryId = currentLibraryId;
    if (!libraryId) { notify(t("library.recheckNeedsLibrary")); return; }
    try {
      scanWanted.current = true;
      const state = await api.startLibraryScan({ recheckScanBindings: true, libraryId });
      scanStatus.current = state.status;
      notify(t("library.recheckStarted"));
      applyScanState(state);
    } catch (error) { scanWanted.current = false; fail(error); }
  };
  const stopScan = async () => {
    try { await api.stopLibraryScan(); setLibraryScan(await api.libraryScan()); void loadSuggestionCount(); }
    catch (error) { fail(error); }
  };
  const dismissScanHint = () => {
    setScanHintDismissed(true);
    try { localStorage.setItem("library-scan-hint-dismissed", "1"); } catch { /* storage may be unavailable */ }
  };
  const confirmSuggestion = async (item: TreeItem) => {
    setMenuFor(null);
    if (!item.suggestion) return;
    try {
      await api.matchLibraryItem({ path: item.path, id: item.suggestion.id, type: item.suggestion.type });
      notify(t("library.suggestionApplied", { name: item.suggestion.name }));
      void loadSuggestionCount();
      await loadBrowse(browsePath);
    } catch (error) { fail(error); }
  };
  const dismissSuggestion = async (item: TreeItem) => {
    setMenuFor(null);
    try {
      await api.dismissLibrarySuggestion(item.path);
      void loadSuggestionCount();
      await loadBrowse(browsePath);
    } catch (error) { fail(error); }
  };
  const scanItem = async (itemPath: string) => {
    setMenuFor(null);
    try {
      await api.startLibraryScan({ path: itemPath });
      notify(t("library.scanItemStarted"));
    } catch (error) { fail(error); }
  };
  /** The mosaic on the home screen is scanned over prepared artwork, so a cover that is not
   *  for the living-room screen is kept out here, and everything below a folder with it. */
  const setMosaic = async (itemPath: string, shown: boolean) => {
    setMenuFor(null);
    try {
      await api.matchLibraryItem({ path: itemPath, skipMosaic: !shown });
      notify(t(shown ? "library.mosaicShown" : "library.mosaicHidden"));
      await loadBrowse(browsePath);
    } catch (error) { fail(error); }
  };
  /** The links row, rendered the same way under the description and in the library menu. */
  const titleLinksRow = (links: SiteLink[]) => links.length > 0 && <div className="title-links">
    {links.map((link) => <a key={link.site} href={link.url} target="_blank" rel="noopener noreferrer"
      title={t("links.openOn", { site: SITE_LINKS[link.site] })}>{SITE_LINKS[link.site]}</a>)}
  </div>;
  const trailerPill = (trailer: Trailer | null) => {
    const action = trailerAction(trailer, settings.secureMode);
    if (!action) return null;
    return action.kind === "external"
      ? <a className="trailer-action" href={action.href} target="_blank" rel="noopener noreferrer" title={t("trailers.openHint")}>{t("trailers.openOnYouTube")}</a>
      : <button className="trailer-action" title={t("trailers.openHint")} onClick={() => setTrailerOpen(action.trailer)}>{t("trailers.watch")}</button>;
  };
  /** Everything that identifies a title, as one row of chips of one size: the watchlist star and
   *  the kind where there is one, then the trailer and the sites that know the title. The
   *  catalogue detail and a library menu render the same row, so they look the same. */
  const titleChips = (trailer: Trailer | null, links: SiteLink[], leading?: ReactNode) => {
    const trailerChip = trailerPill(trailer);
    if (!leading && !trailerChip && !links.length) return null;
    return <div className="title-chips">{leading}{trailerChip}{titleLinksRow(links)}</div>;
  };
  /** A menu is asked about once per path per session; the answer is chrome either way. */
  const loadLibraryLinks = (item: TreeItem) => {
    if (item.match !== "matched" || askedLibraryLinks.current.has(item.path)) return;
    askedLibraryLinks.current.add(item.path);
    void api.libraryLinks(item.path, settings.uiLanguage)
      .then((answer) => setLibraryLinks((current) => ({ ...current, [item.path]: answer.links })))
      .catch(() => { /* a failure only leaves the menu without the row */ });
  };
  const loadLibraryTrailer = (item: TreeItem) => {
    if (item.match !== "matched" || askedLibraryTrailers.current.has(item.path)) return;
    askedLibraryTrailers.current.add(item.path);
    void api.libraryTrailer(item.path, settings.uiLanguage)
      .then((answer) => setLibraryTrailers((current) => ({ ...current, [item.path]: answer.trailer })))
      .catch(() => setLibraryTrailers((current) => ({ ...current, [item.path]: null })));
  };
  const openMenu = (item: TreeItem) => {
    const next = menuFor === item.path ? null : item.path;
    setMenuFor(next);
    if (next) { loadLibraryLinks(item); loadLibraryTrailer(item); }
  };
  const matchActions = (item: TreeItem) => {
    const match = item.match ?? "unmatched";
    const skipped = Boolean(item.skipLookup);
    return <>
      {match === "suggested" && item.suggestion && <>
        <button onClick={() => void confirmSuggestion(item)}><Check/> {t("library.suggestionConfirmNamed", { name: item.suggestion.name })}</button>
        <button onClick={() => void dismissSuggestion(item)}><X/> {t("library.suggestionDismiss")}</button>
      </>}
      {match === "matched"
        ? <>
          <button onClick={() => openIdentify(item.path)}><Sparkles/> {t("library.fixMatch")}</button>
          <button onClick={() => void unmatchItem(item.path)}><X/> {t("library.unmatch")}</button>
        </>
        : <>
          <button onClick={() => openIdentify(item.path)}><Sparkles/> {t("library.identify")}</button>
          <button onClick={() => void scanItem(item.path)}><Search/> {t("library.scanItem")}</button>
        </>}
      {skipped
        ? <button onClick={() => void setCatalogLookup(item.path, true)}><Search/> {t("library.allowLookup")}</button>
        : <button onClick={() => void setCatalogLookup(item.path, false)}><SearchX/> {t("library.skipLookup")}</button>}
      {item.skipMosaic
        ? <button onClick={() => void setMosaic(item.path, true)}><Images/> {t("library.mosaicShow")}</button>
        : <button onClick={() => void setMosaic(item.path, false)}><ImageOff/> {t("library.mosaicHide")}</button>}
    </>;
  };
  const libraryMeta = (item: BrowseLibrary) => [
    libraryTypeLabel(item.type),
    t("library.fileCount", { count: item.fileCount }),
    bytes(item.size),
    !item.enabled ? t("library.disabled") : item.unreachable ? t("library.unreachable") : item.readOnly ? t("library.readOnly") : "",
  ].filter(Boolean).join(" · ");
  const folderMeta = (item: Extract<BrowseItem, { kind: "folder" }>) =>
    [item.year, t("library.fileCount", { count: item.fileCount }), bytes(item.size)].filter(Boolean).join(" · ");
  const fileMeta = (item: Extract<BrowseItem, { kind: "file" }>) =>
    browsePath === ":resume" && item.progress
      ? t("library.remaining", { time: fmtEta(Math.max(0, item.progress.duration - item.progress.position)) })
      : [item.year, bytes(item.size)].filter(Boolean).join(" · ");
  const descriptionLine = (item: TreeItem) => item.description
    ? (item.catalogName ? `${item.catalogName} · ${item.description}` : item.description)
    : item.match === "suggested" && item.suggestion
      ? t("library.suggestionLine", { name: item.suggestion.name, score: item.suggestion.titleSimilarity ?? item.suggestion.score })
      : item.catalogName;
  const [localStream, setLocalStream] = useState<Stream | null>(null); const [localTitle, setLocalTitle] = useState("");
  const [streamAddon, setStreamAddon] = useState(""); const [streamLanguage, setStreamLanguage] = useState(""); const [streamSort, setStreamSort] = useState<StreamSort>("recommended");
  useEffect(() => { setStreamSort(settings.streamSort as StreamSort); }, [settings.streamSort]);
  const [submittedQuery, setSubmittedQuery] = useState(""); const [searchScopeValue, setSearchScopeValue] = useState(""); const [searchable, setSearchable] = useState<SearchableCatalog[]>([]); const [typeFilter, setTypeFilter] = useState(""); const [genre, setGenre] = useState(""); const [sort, setSort] = useState("default"); const [searchSort, setSearchSort] = useState("default");
  const [liveState, setLiveState] = useState<LiveSearchState>("idle");
  // One debounce controller for the searchbox. It commits the draft to `submittedQuery`
  // itself, so nothing else has to watch keystrokes.
  const liveRef = useRef<LiveSearch | null>(null);
  if (!liveRef.current) liveRef.current = createLiveSearch({ onCommit: setSubmittedQuery, onState: setLiveState });
  const live = liveRef.current;
  const [searchState, setSearchState] = useState<SearchState | null>(null);
  const searchStateRef = useRef<SearchState | null>(null); searchStateRef.current = searchState;
  const liveSearchOn = searchState?.liveSearch !== false;
  const loadSearchState = () => api.searchState().then(setSearchState).catch(() => undefined);
  // A query is remembered once somebody acted on it -- Enter, a suggestion, an opened result --
  // and only after its first page came back. Whatever was merely typed past is not.
  const firstPageOk = useRef<string | null>(null); const recordIntent = useRef<string | null>(null); const recordedQuery = useRef<string | null>(null);
  const recordSearch = (query: string) => {
    if (!searchStateRef.current?.saveHistory || recordedQuery.current === query) return;
    recordedQuery.current = query;
    const key = query.toLowerCase();
    api.recordSearch(query).then(() => setSearchState((current) => current?.saveHistory
      ? { ...current, recent: [{ query, usedAt: new Date().toISOString() }, ...current.recent.filter((entry) => entry.query.toLowerCase() !== key)].slice(0, 20) }
      : current)).catch(() => undefined);
  };
  /** Drops one query at once, then takes what the server holds; a failure puts it back. */
  const forgetSearch = (query: string) => {
    const key = query.toLowerCase();
    setSearchState((current) => current && { ...current, recent: current.recent.filter((entry) => entry.query.toLowerCase() !== key) });
    if (recordedQuery.current === query) recordedQuery.current = null;
    api.forgetSearch(query).then(setSearchState).catch((error) => { fail(error); void loadSearchState(); });
  };
  const actOnSearch = (query: string) => {
    if (firstPageOk.current === query) recordSearch(query);
    else recordIntent.current = query;
  };
  const poolRef = useRef<CandidatePool | null>(null);
  if (!poolRef.current) poolRef.current = new CandidatePool();
  const pool = poolRef.current;
  const [suggestOpen, setSuggestOpen] = useState(false); const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const searchScope = parseSearchScope(searchScopeValue);
  const scopedCatalog = searchScope.catalogId ? searchable.find((item) => item.addonKey === searchScope.addonKey && item.type === searchScope.catalogType && item.id === searchScope.catalogId) : undefined;
  const effectiveTypeFilter = searchScope.catalogType ?? typeFilter;
  /** Picking one catalogue to search in also points the browse picker at it, so the
   *  catalogue stays on screen once the search is cleared. The wider scopes -- one
   *  addon, or all of them -- have nothing to point at and leave it alone. */
  const pickSearchScope = (value: string) => {
    setSearchScopeValue(value);
    const picked = parseSearchScope(value);
    if (picked.catalogId) setSelectedCatalog(`${picked.addonKey}:${picked.catalogType}:${picked.catalogId}`);
  };
  const [skip, setSkip] = useState(0); const [cursor, setCursor] = useState(""); const [hasMore, setHasMore] = useState(false); const [loadingMore, setLoadingMore] = useState(false); const [sourceCount, setSourceCount] = useState(0);
  const [pendingSources, setPendingSources] = useState(0);
  const pickedRef = useRef(false); const sourcesRequestRef = useRef(0);
  const linksRequestRef = useRef(0); const trailerRequestRef = useRef(0); const askedLibraryLinks = useRef(new Set<string>()); const askedLibraryTrailers = useRef(new Set<string>());
  const loadingRef = useRef(false); const requestRef = useRef(0); const itemsRef = useRef<Meta[]>([]); const gridRef = useRef<HTMLDivElement>(null); const browseScrollRef = useRef<HTMLDivElement | null>(null); const detailRef = useRef<HTMLElement>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const loadedSearchRef = useRef<{ query: string; scope: string; type: string; genre: string; virtual: string; catalog: string; reset: number } | null>(null);
  const playerOpenRef = useRef(false); const playbackReturn = useRef<PlaybackReturn | null>(null);
  const viewAnchor = useRef<ViewAnchor | null>(null); const anchorFrozen = useRef(false); const anchorFrame = useRef(0);
  // A toolbar folds to give a scrolling list more room. A list that already fits has nothing to
  // scroll, so nothing could ever unfold the toolbar again: it opens instead of staying folded.
  useEffect(() => {
    const target = view === "library" ? { compact: libraryCompact, set: setLibraryCompact, element: browseScrollRef.current }
      : view === "catalog" ? { compact: catalogCompact, set: setCatalogCompact, element: gridRef.current } : null;
    const element = target?.element;
    if (!target?.compact || !element) return;
    const unfoldIfFits = () => { if (element.scrollHeight <= element.clientHeight + 1) target.set(false); };
    const observer = new ResizeObserver(unfoldIfFits);
    observer.observe(element);
    const settled = window.setTimeout(unfoldIfFits, 450);
    return () => { observer.disconnect(); window.clearTimeout(settled); };
  }, [view, libraryCompact, catalogCompact, items, browse]);
  // The built-in lists look like a catalogue, they just do not come from an addon.
  const VIRTUAL = { resume: ":resume", watchlist: ":watchlist" } as const;
  const virtualCatalog = selectedCatalog === VIRTUAL.resume || selectedCatalog === VIRTUAL.watchlist ? selectedCatalog : "";
  const currentCatalog = virtualCatalog ? undefined
    : catalogs.find((catalog) => `${catalog.addonKey}:${catalog.type}:${catalog.id}` === selectedCatalog) ?? catalogs[0];
  const searchRequired = Boolean(currentCatalog?.extra?.some((extra) => extra.name === "search" && extra.isRequired));
  const downloadTitleLanguage = settings.downloadTitleLanguage === "ui" ? settings.uiLanguage : settings.downloadTitleLanguage;
  const baseDownloadTitle = selectedDownloadTitle || selected?.name || "Video";
  const videoId = selectedVideo?.id || selected?.id; const videoTitle = selectedVideo ? `${baseDownloadTitle} · ${episodeLabel(selectedVideo)}` : baseDownloadTitle;
  // Long shows run to hundreds of episodes, so the list branches by season. Specials (season 0) belong at the end.
  const seasons = [...new Set((selected?.videos ?? []).map((video) => video.season).filter((value): value is number => typeof value === "number"))].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
  const activeSeason = season ?? selectedVideo?.season ?? seasons.find((value) => value > 0) ?? seasons[0] ?? null;
  const visibleEpisodes = (selected?.videos ?? []).filter((video) => seasons.length <= 1 || activeSeason === null || video.season === activeSeason);
  // Once its sources are in, the chosen episode heads the source list instead of taking a row of its own.
  const chosenEpisode = Boolean(selected?.videos?.length) && selectedVideo && !episodesOpen
    ? <div className="episode-current"><small>{t("episodes.chosen")}</small><b>{selectedVideo.season != null ? `${String(selectedVideo.season).padStart(2,"0")}×${String(selectedVideo.episode || 0).padStart(2,"0")}` : t("episodes.part")}</b><span>{selectedVideo.title || selectedVideo.name || t("episodes.one")}</span><button onClick={() => setEpisodesOpen(true)}>{t("episodes.change")}</button></div>
    : null;
  const galleryImages = useMemo(() => galleryFor(selected), [selected]);
  const shownGallery = storedGallery ?? galleryImages;
  const closeGallery = () => { setGalleryIndex(null); setStoredGallery(null); };
  /** The pictures a downloaded title kept. Named here rather than on the server, which stores
   *  what each one is and leaves the wording to the interface. */
  const openStoredGallery = async (path: string) => {
    setMenuFor(null);
    try {
      const { images } = await api.libraryGallery(path);
      if (!images.length) return;
      let stills = 0;
      setStoredGallery(images.map((image) => ({
        url: image.url, shape: image.shape, kind: image.kind,
        label: image.kind === "still" ? t("gallery.still", { index: ++stills }) : t(`gallery.${image.kind}`),
      })));
      setGalleryIndex(0);
    } catch (error) { fail(error); }
  };
  const notify = (text: string) => { setMessage(text); setTimeout(() => setMessage(""), 3200); };
  const fail = (value: unknown) => {
    if (value instanceof ApiError && value.status === 401) { setSession(null); return; }
    // A failure with a reference stays long enough to copy the reference down.
    setError(describeError(value)); setTimeout(() => setError(""), value instanceof ApiError && value.reference ? 15000 : 6000);
  };
  /** Writes wait for the hand to stop: one PATCH per gesture, not per click of a shape
   *  someone is flipping through. The latest patch wins, and nothing here runs on its own --
   *  a stored view is only ever written by the control somebody just touched. */
  const pendingViews = useRef<Partial<UserViews>>({});
  const viewsTimer = useRef(0);
  const queueViews = (patch: Partial<UserViews>) => {
    const pending = pendingViews.current;
    pendingViews.current = {
      ...pending, ...patch,
      libraries: { ...pending.libraries, ...patch.libraries },
      extras: { ...pending.extras, ...patch.extras },
      downloads: patch.downloads ?? pending.downloads,
    };
    window.clearTimeout(viewsTimer.current);
    viewsTimer.current = window.setTimeout(() => {
      const body = pendingViews.current;
      pendingViews.current = {};
      api.updateViews(body).then(setViews).catch(fail);
    }, 300);
  };
  const persistLibraryPrefs = (next: Partial<LibraryViewPrefs>) => {
    const scope = scopeOf(browsePath, libraryIds);
    if (scope.kind === "none") return;
    const prefs: LibraryViewPrefs = { sort: browseSort, order: browseDesc ? "desc" : "asc", favoritesOnly: onlyFavorites, view: browseView, ...next };
    if (scope.kind === "library") {
      setViews((current) => withLibrary(current, scope.id, prefs));
      queueViews({ libraries: { [scope.id]: prefs } });
    } else {
      setViews((current) => withExtra(current, scope.id, prefs));
      queueViews({ extras: { [scope.id]: prefs } });
    }
  };
  const persistDownloadPrefs = (prefs: DownloadsViewPrefs) => {
    setViews((current) => withDownloads(current, prefs));
    queueViews({ downloads: prefs });
  };

  const findPlaybackAnchor = ({ kind, key }: PlaybackAnchor) => {
    const attribute = kind === "catalog" ? "catalogKey" : "path";
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(kind === "catalog" ? "[data-catalog-key]" : "[data-path]"));
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return candidates.find((element) => element === active && element.dataset[attribute] === key)
      ?? candidates.find((element) => element.dataset[attribute] === key && element.getClientRects().length > 0)
      ?? candidates.find((element) => element.dataset[attribute] === key);
  };
  // Only the library keeps its offset in a box of its own; every other view still rides the document.
  const viewScrollTop = () => viewRef.current === "library" ? browseScrollRef.current?.scrollTop ?? 0 : window.scrollY;
  /** The box a listing scrolls in, by the kind of tile that was played from it. */
  const scrollerOf = (kind?: PlaybackAnchor["kind"]) =>
    kind === "catalog" ? gridRef.current : kind === "library" ? browseScrollRef.current : null;
  const capturePlaybackReturn = (anchor?: PlaybackAnchor): PlaybackReturn => {
    const element = anchor && findPlaybackAnchor(anchor);
    const scroller = scrollerOf(anchor?.kind);
    const viewportTop = scroller?.getBoundingClientRect().top ?? 0;
    const viewportHeight = scroller?.clientHeight || window.innerHeight;
    return {
      view,
      windowY: window.scrollY,
      gridY: scroller?.scrollTop,
      catalogCompact,
      anchor: element && anchor ? { ...anchor, element, ratio: (element.getBoundingClientRect().top - viewportTop) / viewportHeight } : undefined,
    };
  };
  const openPlayer = (anchor?: PlaybackAnchor) => {
    playbackReturn.current = capturePlaybackReturn(anchor);
    scrollByView.current[view] = viewScrollTop();
    playerOpenRef.current = true;
    pickedRef.current = true;
    setPlayerOpen(true);
  };

  // Chrome that sits outside the list is a dead zone for a gesture: a finger that lands on the
  // header scrolls nothing -- and a header that has just sprung back at the top of the list is
  // exactly where the next finger lands, which made the list look stuck. A wheel or a drag that
  // starts on the chrome is handed to the list instead. Anything that scrolls on its own keeps
  // its gesture: the mobile detail panel and the episode and source lists live in here too.
  const chromeDrag = useRef<{ from: number; dragging: boolean } | null>(null);
  const ownScroller = (target: EventTarget | null, stop: HTMLElement) => {
    // An icon is an SVGElement and not an HTMLElement -- start the walk at any element, or a
    // gesture that lands on one is read as though it had landed on nothing.
    let node = target instanceof Element ? target : null;
    while (node && node !== stop) {
      const style = getComputedStyle(node);
      // A panel laid over the view -- the detail on a phone -- owns everything that happens on
      // it, scrollable or not. Forwarding from there would drag the list hidden behind it.
      if (style.position === "fixed") return true;
      if ((style.overflowY === "auto" || style.overflowY === "scroll") && node.scrollHeight > node.clientHeight) return true;
      node = node.parentElement;
    }
    return false;
  };
  const chromeGestures = (scroller: () => HTMLDivElement | null) => ({
    onWheel: (event: ReactWheelEvent<HTMLElement>) => {
      const list = scroller();
      if (!list || ownScroller(event.target, event.currentTarget)) return;
      list.scrollTop += event.deltaY;
    },
    onTouchStart: (event: ReactTouchEvent<HTMLElement>) => {
      // A control keeps its own touch. Nudging the list from under a button being pressed is
      // what made the header flicker: no tap is perfectly still, and every stray pixel moved
      // the list, which then folded the header the tap had just opened.
      const onControl = event.target instanceof Element && event.target.closest("button,a,input,select,textarea,label");
      chromeDrag.current = scroller() && !onControl && !ownScroller(event.target, event.currentTarget)
        ? { from: event.touches[0].clientY, dragging: false }
        : null;
    },
    onTouchMove: (event: ReactTouchEvent<HTMLElement>) => {
      const list = scroller();
      const drag = chromeDrag.current;
      if (!list || !drag) return;
      const y = event.touches[0].clientY;
      // A drag has to travel before it counts as one, or a wobbling finger scrolls the list.
      if (!drag.dragging && Math.abs(drag.from - y) < 8) return;
      drag.dragging = true;
      list.scrollTop += drag.from - y;
      drag.from = y;
    },
    onTouchEnd: () => { chromeDrag.current = null; },
  });

  // Where the two lists that survive a rotation keep their position: both scroll inside a box
  // of their own now -- the catalogue in its grid, the library in its listing.
  const anchorScroller = () => viewRef.current === "catalog" ? gridRef.current : viewRef.current === "library" ? browseScrollRef.current : null;
  const anchorKind = () => viewRef.current === "catalog" ? "catalog" as const : viewRef.current === "library" ? "library" as const : null;
  const trackViewAnchor = () => {
    if (anchorFrozen.current || restoringScroll.current || playerOpenRef.current) return;
    const kind = anchorKind();
    if (!kind) return;
    const scroller = anchorScroller();
    const top = scroller?.getBoundingClientRect().top ?? 0;
    const first = Array.from(document.querySelectorAll<HTMLElement>(kind === "catalog" ? "[data-catalog-key]" : "[data-path]"))
      .find((element) => element.getClientRects().length > 0 && element.getBoundingClientRect().bottom > top + 1);
    const key = kind === "catalog" ? first?.dataset.catalogKey : first?.dataset.path;
    viewAnchor.current = first && key ? { kind, key, offset: first.getBoundingClientRect().top - top } : null;
  };
  const scheduleViewAnchor = () => {
    if (anchorFrame.current) return;
    anchorFrame.current = requestAnimationFrame(() => { anchorFrame.current = 0; trackViewAnchor(); });
  };
  const applyViewAnchor = () => {
    const saved = viewAnchor.current;
    if (!saved) return;
    const element = findPlaybackAnchor(saved);
    if (!element) return;
    const scroller = anchorScroller();
    const delta = element.getBoundingClientRect().top - (scroller?.getBoundingClientRect().top ?? 0) - saved.offset;
    if (Math.abs(delta) < 1) return;
    if (scroller) scroller.scrollTop += delta;
    else window.scrollBy(0, delta);
  };

  useEffect(() => {
    const onScroll = () => {
      // The library's listing scrolls on its own, so the document offset says nothing about it.
      if (!restoringScroll.current && !playerOpenRef.current && viewRef.current !== "library") scrollByView.current[viewRef.current] = window.scrollY;
      scheduleViewAnchor();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  // A rotation collapses the scrollable range -- the catalogue grid trades three columns for
  // eight -- and the browser clamps the offset to the new maximum, which throws the position
  // away for good. No pixel offset survives that, so the position is held as the item on top
  // and how far it sits into the view, then re-applied once the new layout settles. The resize
  // steps run before the scroll steps, so freezing the anchor here beats the clamp's own event.
  // Only a rotation is worth answering. Safari slides its toolbars away as the page scrolls,
  // which changes innerHeight and fires resize just the same -- and answering that dragged the
  // list somewhere else mid-scroll. The width and the orientation tell the two apart.
  const viewportShape = () => `${window.innerWidth}:${window.matchMedia("(orientation: landscape)").matches}`;
  useEffect(() => {
    let size = viewportShape();
    let handle = 0;
    let listening = false;
    const release = () => {
      cancelAnimationFrame(handle);
      anchorFrozen.current = false;
      restoringScroll.current = false;
      if (listening) {
        listening = false;
        for (const event of ["wheel", "touchmove", "keydown"]) window.removeEventListener(event, release);
      }
      scrollByView.current[viewRef.current] = viewScrollTop();
    };
    const onResize = () => {
      const next = viewportShape();
      if (next === size) return;
      size = next;
      if (!viewAnchor.current || playerOpenRef.current) return;
      anchorFrozen.current = true;
      restoringScroll.current = true;
      cancelAnimationFrame(handle);
      if (!listening) {
        listening = true;
        for (const event of ["wheel", "touchmove", "keydown"]) window.addEventListener(event, release, { passive: true });
      }
      const deadline = performance.now() + 700;
      const chase = () => {
        applyViewAnchor();
        if (performance.now() < deadline) handle = requestAnimationFrame(chase);
        else release();
      };
      handle = requestAnimationFrame(chase);
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      release();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);
  // A section's content arrives asynchronously, so the saved position is chased for a moment.
  useEffect(() => {
    viewRef.current = view;
    const wanted = scrollByView.current[view] ?? 0;
    restoringScroll.current = true;
    const deadline = performance.now() + 1500;
    let handle = 0;
    const apply = () => {
      if (viewRef.current === "library") {
        const element = browseScrollRef.current;
        if (element) element.scrollTop = wanted;
        // The listing may not hold its content yet, so the position is chased until it sticks.
        if ((!element || Math.abs(element.scrollTop - wanted) > 1) && performance.now() < deadline) handle = requestAnimationFrame(apply);
        else restoringScroll.current = false;
        return;
      }
      window.scrollTo(0, wanted);
      if (Math.abs(window.scrollY - wanted) > 1 && performance.now() < deadline) handle = requestAnimationFrame(apply);
      else restoringScroll.current = false;
    };
    handle = requestAnimationFrame(apply);
    // The chase gives way as soon as the viewer touches the page themselves.
    const stop = () => { cancelAnimationFrame(handle); restoringScroll.current = false; };
    for (const event of ["wheel", "touchstart", "keydown"]) window.addEventListener(event, stop, { passive: true, once: true });
    return () => {
      stop();
      for (const event of ["wheel", "touchstart", "keydown"]) window.removeEventListener(event, stop);
    };
  }, [view]);
  useEffect(() => {
    playerOpenRef.current = playerOpen;
    if (playerOpen) return;
    const saved = playbackReturn.current;
    if (!saved || saved.view !== view) return;
    restoringScroll.current = true;
    setCatalogCompact(saved.catalogCompact);
    const deadline = performance.now() + 1000;
    let handle = 0;
    const apply = () => {
      const anchor = saved.anchor;
      const element = anchor && (anchor.element.isConnected ? anchor.element : findPlaybackAnchor(anchor));
      const scroller = scrollerOf(anchor?.kind);
      if (scroller && anchor) {
        if (element) {
          const current = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
          scroller.scrollTop += current - anchor.ratio * scroller.clientHeight;
        } else if (saved.gridY != null) scroller.scrollTop = saved.gridY;
      } else if (element && anchor) {
        window.scrollBy(0, element.getBoundingClientRect().top - anchor.ratio * window.innerHeight);
      } else window.scrollTo(0, saved.windowY);
      if (performance.now() < deadline) handle = requestAnimationFrame(apply);
      else { restoringScroll.current = false; playbackReturn.current = null; }
    };
    handle = requestAnimationFrame(apply);
    const stop = () => {
      cancelAnimationFrame(handle);
      restoringScroll.current = false;
      playbackReturn.current = null;
    };
    for (const event of ["wheel", "touchmove", "keydown"]) window.addEventListener(event, stop, { passive: true, once: true });
    return () => {
      stop();
      for (const event of ["wheel", "touchmove", "keydown"]) window.removeEventListener(event, stop);
    };
  }, [playerOpen, view]);
  useEffect(() => {
    const panel = detailRef.current;
    if (!panel || !selected) return;
    let startX = 0;
    let startY = 0;
    const onStart = (event: TouchEvent) => {
      startX = event.touches[0]?.clientX ?? 0;
      startY = event.touches[0]?.clientY ?? 0;
    };
    const onMove = (event: TouchEvent) => {
      if (!window.matchMedia("(orientation: landscape)").matches) return;
      const dx = (event.touches[0]?.clientX ?? 0) - startX;
      const dy = (event.touches[0]?.clientY ?? 0) - startY;
      if (Math.abs(dx) > Math.abs(dy)) event.preventDefault();
    };
    panel.addEventListener("touchstart", onStart, { passive: true });
    panel.addEventListener("touchmove", onMove, { passive: false });
    return () => {
      panel.removeEventListener("touchstart", onStart);
      panel.removeEventListener("touchmove", onMove);
    };
  }, [selected]);

  const resetCatalog = () => {
    navigated.current = true;
    live.cancel();
    setCatalogCompact(false);
    const firstCatalog = catalogs[0];
    scrollByView.current.catalog = 0;
    setView("catalog");
    setSearch(""); setSubmittedQuery(""); setSearchScopeValue(""); setTypeFilter(""); setGenre(""); setSort("default"); setSearchSort("default");
    setSelectedCatalog(firstCatalog ? `${firstCatalog.addonKey}:${firstCatalog.type}:${firstCatalog.id}` : "");
    setSelected(null); setSelectedVideo(null); setStreams([]); setSelectedStream(null); setSubtitles([]); setSourcesLoaded(false);
    setGalleryIndex(null);
    setStreamAddon(""); setStreamLanguage(""); setStreamSort(settings.streamSort as StreamSort);
    setEpisodesOpen(true); setSeason(null); setCatalogReset((value) => value + 1);
  };
  const resetLibrary = () => {
    setLibraryCompact(false);
    setMenuFor(null); setFromFavorites(false); setBrowseFocus(null);
    setBrowsePath(""); setBrowseQuery("");
  };
  /** Clicking the section we are already in resets it; otherwise the last filters
   * and the page position are restored. */
  const openView = (target: View) => {
    navigated.current = true;
    if (target !== view) { setView(target); return; }
    scrollByView.current[target] = 0;
    if (target === "catalog") resetCatalog();
    else if (target === "library") resetLibrary();
    else if (target === "stats") setStatsReset((value) => value + 1);
    // The catalogue and the library scroll in a box of their own, so the document offset is not
    // the one that holds their position.
    const list = target === "catalog" ? gridRef.current : target === "library" ? browseScrollRef.current : null;
    if (list) list.scrollTop = 0;
    window.scrollTo(0, 0);
  };
  const toggleSidebar = () => setSidebarCollapsed((current) => {
    const next = !current;
    try { localStorage.setItem("sidebar-collapsed", next ? "1" : "0"); } catch { /* private mode may forbid storage */ }
    return next;
  });
  /** The top bar and the More menu sign out through the same call. */
  const signOut = async () => { try { await api.logout(); } finally { location.reload(); } };

  const refresh = async (selectFirst = false) => {
    const [nextAddons, nextCatalogs] = await Promise.all([api.addons(), api.catalogs()]); setAddons(nextAddons); setCatalogs(nextCatalogs);
    if ((selectFirst || !selectedCatalog) && nextCatalogs[0]) setSelectedCatalog(`${nextCatalogs[0].addonKey}:${nextCatalogs[0].type}:${nextCatalogs[0].id}`);
  };
  const downloadsSeen = useRef(false);
  const jobStatus = useRef(new Map<string, DownloadJob["status"]>());
  const applyDownloads = (snapshot: { jobs?: DownloadJob[]; halt?: QueueHalt | null; deviceTransfers?: DeviceTransfer[] } | DownloadJob[]) => {
    const jobs = Array.isArray(snapshot) ? snapshot : snapshot.jobs ?? [];
    if (downloadsSeen.current) {
      for (const job of jobs) {
        const previous = jobStatus.current.get(job.id);
        if (previous === "waiting" && job.status !== "waiting" && job.status !== "paused" && job.status !== "failed") {
          notify(t("downloads.debridReady", { title: job.title }));
        }
        if (previous && previous !== "completed" && job.status === "completed") {
          notify(t("downloads.inLibrary", { title: job.title }));
          // Ready to play and Recently added gained a card; Home refreshes only those rows, and
          // only while it is the view on screen -- the answer would otherwise land behind another view.
          if (viewRef.current === "home") home.refresh(["completed", "recent"]);
        }
      }
    }
    downloadsSeen.current = true;
    jobStatus.current = new Map(jobs.map((job) => [job.id, job.status]));
    setDownloads(jobs);
    setQueueHalt(Array.isArray(snapshot) ? null : snapshot.halt ?? null);
    setDeviceTransfers(Array.isArray(snapshot) ? [] : snapshot.deviceTransfers ?? []);
  };
  const loadDownloads = () => api.downloads().then(applyDownloads).catch(fail);
  /** Home's queue card action: the mutation, then the poll that carries its result, with the
   *  failure handed to the toast the rest of the app uses. */
  const homeAction = async (job: DownloadJob, action: "pause" | "resume" | "retry") => {
    try { await api.downloadAction(job.id, action); await loadDownloads(); } catch (error) { fail(error); }
  };
  /** The followed series and the episodes they announced: the Library row needs both. */
  const loadFollows = () => Promise.all([api.follows(), api.newEpisodes()])
    .then(([list, items]) => { setFollows(list); setNewEpisodes(items); })
    .catch(() => undefined);
  const applyFollowChange = (id: string, follow: FollowView | null) => {
    setDetailFollow((current) => current && current.id === id ? follow : current);
    setFollows((current) => follow
      ? (current.some((item) => item.id === id) ? current.map((item) => item.id === id ? follow : item) : [...current, follow])
      : current.filter((item) => item.id !== id));
    void loadFollows();
    // A follow change moves the New episodes row; refresh it only while Home is on screen.
    if (viewRef.current === "home") home.refresh(["episodes"]);
  };
  /** Following from the detail hero: the chip switches state and the Library rows catch up. */
  const followed = (item: Meta, follow: FollowView) => {
    // The chip of the title on screen switches at once; `applyFollowChange` only replaces a
    // follow the detail already holds, and this one did not exist a moment ago.
    if (selectedIdRef.current === item.id) setDetailFollow(follow);
    applyFollowChange(follow.id, follow);
    notify(t("follow.followed"));
    // The server checks a new follow straight away; its episodes land a moment later.
    setTimeout(() => { void api.followByMeta(follow.type, follow.metaId).then((fresh) => { if (fresh) applyFollowChange(fresh.id, fresh); }).catch(() => undefined); }, 5000);
  };
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);
  const restricted = buildInfo?.restricted === true;
  // What the instance owns is administrator-only, and an ordinary user gets the same
  // read-only shape the demo mode uses: the API refuses those writes either way.
  const admin = session?.role === "admin";
  useEffect(() => { api.status().then(setBuildInfo).catch(() => setBuildInfo(null)); }, []);
  // The sign-in and setup screens render before anything else, so the stored language
  // rides along on this one call. Only a fresh install falls back to the browser's guess.
  useEffect(() => {
    api.me()
      .then((status) => {
        if (status.language) setLocale(status.language);
        if ("setup" in status) { setSetupNeeded(true); setSession(null); } else setSession(status);
      })
      .catch(() => setSession(null));
  }, []);
  const ready = Boolean(session);
  // Loading data only makes sense after signing in; before that it would just throw 401s.
  // Every settings answer is merged into the state rather than assigned over it: an ordinary
  // account is not told the instance keys, and the defaults above stand in for them.
  /** The stored browsing chrome, or the defaults. The library list comes first: a leftover
   *  browser-wide choice is handed to the libraries this account can see, once, and then
   *  forgotten -- which is what ends the leak on a shared browser. */
  const loadViews = async () => {
    const visible = await api.libraries().catch(() => [] as LibraryView[]);
    setLibraries(visible);
    let next = emptyViews();
    try { next = await api.views(); } catch { /* the defaults stand */ }
    const legacy = legacyLibraryView();
    if (legacy) {
      if (Object.keys(next.libraries).length) forgetLegacy();
      else if (visible.length) {
        const libraries = Object.fromEntries(visible.map((library) => [library.id, legacy]));
        try {
          next = await api.updateViews({ libraries });
          forgetLegacy();
        } catch { /* keep the keys and try again next visit */ }
      }
    }
    setViews(next);
    setViewsReady(true);
  };
  useEffect(() => {
    // A fresh sign-in re-arms the start page: signing out again must not remember the last
    // switch as if the person had navigated.
    if (!ready) { navigated.current = false; return; }
    refresh().catch(fail); loadDownloads(); loadFollows();
    api.settings().then((next) => {
      setSettings((current: AppSettings) => ({ ...current, ...next }));
      setLocale(next.uiLanguage);
      // The chosen page is opened once, and only while nobody has gone anywhere yet.
      if (view === "catalog" && !navigated.current && !selected && !playerOpen) {
        const target = resolveStartView(next.startView, { restricted, navigated: navigated.current });
        if (target) { navigated.current = true; openView(target); }
      }
    }).catch(fail);
    api.languages().then(setLanguages).catch(() => undefined);
    void loadViews();
  }, [ready]);
  // Which addons are worth searching changes as they are switched on and off.
  useEffect(() => { api.searchable().then(setSearchable).catch(() => undefined); }, [addons]);
  // Only a file probe knows the exact languages, so we run one for the chosen stream.
  useEffect(() => {
    setInspection(null);
    if (!selectedStream?.playable) return;
    let stale = false;
    api.inspect(selectedStream).then((value) => { if (!stale) setInspection(value); }).catch(() => undefined);
    return () => { stale = true; };
  }, [selectedStream]);
  /** The shape buttons save like any other setting, but without the toast: one per click
   *  while somebody flips back and forth is noise. A refused save puts the grid back. */
  const toggleShape = async (key: "catalogTileShape" | "libraryTileShape" | "homeTileShape") => {
    const before = settings[key];
    const next = before === "wide" ? "poster" : "wide";
    setSettings((current: AppSettings) => ({ ...current, [key]: next }));
    try { const saved = await api.updateSettings({ [key]: next }); setSettings((current: AppSettings) => ({ ...current, ...saved })); }
    catch (e) { setSettings((current: AppSettings) => ({ ...current, [key]: before })); fail(e); }
  };
  /** The library shelf's segment saves like a shape: optimistic, silent, and put back on
   *  failure so the clicked segment never sticks without the write behind it. */
  const chooseLibraryShelf = async (segment: AppSettings["libraryShelf"]) => {
    const before = settings.libraryShelf;
    setSettings((current: AppSettings) => ({ ...current, libraryShelf: segment }));
    try { const saved = await api.updateSettings({ libraryShelf: segment }); setSettings((current: AppSettings) => ({ ...current, ...saved })); }
    catch (e) { setSettings((current: AppSettings) => ({ ...current, libraryShelf: before })); fail(e); }
  };

  const saveSettings = async (patch: SettingsPatch) => {
    const { realDebridToken: _token, tmdbApiKey: _apiKey, ...rest } = patch;
    if (Object.keys(rest).length) setSettings((current: AppSettings) => ({ ...current, ...rest }));
    try { const saved = await api.updateSettings(patch); setSettings((current: AppSettings) => ({ ...current, ...saved })); notify(t("settings.saved")); } catch (e) { fail(e); }
  };
  // An empty path with more than one library configured is the library list; a
  // single-library install still opens straight into the tree.
  const libraryList = browsePath === "" && libraries.length > 1;
  const loadBrowse = async (target = browsePath, skip = 0) => {
    const request = ++browseRequest.current;
    const wanted = JSON.stringify([target, browseQuery, browseSort, browseDesc, onlyFavorites, onlyUnconfirmed]);
    setBrowseBusy(true);
    try {
      const options = { skip, limit: 60, sort: browseSort, order: browseDesc ? "desc" : "asc", seed: browseSeed.current };
      // Favorites include entries from the entire library tree.
      const page = target === ":resume"
        ? await api.resumeLibrary({ ...options, query: browseQuery, favorites: onlyFavorites })
        : target === ":favorites"
        ? await api.favorites(options)
        : await api.browse({ ...options, path: target, query: browseQuery, favorites: onlyFavorites, unconfirmed: onlyUnconfirmed });
      if (request !== browseRequest.current || wanted !== browseLocation.current) return;
      setBrowse((previous) => skip && previous ? { ...page, items: [...previous.items, ...page.items] } : page);
    } catch (error) { if (request === browseRequest.current && wanted === browseLocation.current) fail(error); }
    finally { if (request === browseRequest.current) setBrowseBusy(false); }
  };
  const refreshBrowse = async (limit: number) => {
    const location = JSON.stringify([browsePath, browseQuery, browseSort, browseDesc, onlyFavorites, onlyUnconfirmed]);
    if (location !== browseLocation.current) return;
    const request = browseRequest.current;
    try {
      const options = { limit: Math.max(60, limit), sort: browseSort, order: browseDesc ? "desc" : "asc", seed: browseSeed.current };
      const page = browsePath === ":resume"
        ? await api.resumeLibrary({ ...options, query: browseQuery, favorites: onlyFavorites })
        : browsePath === ":favorites"
        ? await api.favorites(options)
        : await api.browse({ ...options, path: browsePath, query: browseQuery, favorites: onlyFavorites, unconfirmed: onlyUnconfirmed });
      if (location === browseLocation.current && request === browseRequest.current) setBrowse(page);
    } catch { /* Artwork refresh is optional. */ }
  };
  useEffect(() => { if (!ready) return; api.watchlist().then(setWatchlist).catch(() => undefined); void loadFollows(); }, [ready, view]);
  // The follow of the title on screen. A slow answer for a title that is already gone is
  // dropped; a failure leaves the chip in the not-followed state and never blocks the detail.
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selected?.id ?? null;
  const followLoadedFor = useRef<string | null>(null);
  useEffect(() => {
    const item = selected;
    if (!item || !(item.type === "series" || item.type === "movie" || item.videos?.length)) { setDetailFollow(null); followLoadedFor.current = null; return; }
    const wanted = item.id;
    // Metadata that arrives later only adds `videos` to the same title, which must not drop
    // the follow the chip already shows: only a different title resets it.
    if (followLoadedFor.current !== wanted) { setDetailFollow(null); followLoadedFor.current = wanted; }
    let stale = false;
    api.followByMeta(item.type || "series", wanted).then((follow) => {
      if (!stale && selectedIdRef.current === wanted) setDetailFollow(follow);
    }).catch(() => { if (!stale && selectedIdRef.current === wanted) setDetailFollow(null); });
    return () => { stale = true; };
  }, [selected?.id, selected?.type, selected?.videos?.length]);
  useEffect(() => {
    if (!browse) return;
    // Every listed entry carries its own favourite flag; collecting them is enough.
    setLibraryFavorites((current) => {
      const next = new Set(current);
      for (const item of browse.items) { if (item.kind !== "library" && item.favorite) next.add(item.path); else next.delete(item.path); }
      return [...next];
    });
  }, [browse]);
  useEffect(() => {
    if (!ready) return;
    // After the player closes the last position is still on its way, so we wait a moment.
    // Both the catalogue and the library need the list; only the library needs the folder listing.
    const timer = setTimeout(() => {
      api.progressList().then(setResume).catch(() => undefined);
      if (!playerOpen && view === "library") void refreshBrowse(browse?.items.length ?? 60);
    }, playerOpen ? 0 : 900);
    return () => clearTimeout(timer);
  }, [ready, view, playerOpen]);
  useEffect(() => {
    if (!ready || view !== "library" || browsePath || browseQuery || onlyFavorites) return;
    let cancelled = false;
    void api.resumeLibrary({ limit: 8 }).then((result) => { if (!cancelled) setResumePreview(result); }).catch(() => { if (!cancelled) setResumePreview(null); });
    void api.favorites({ limit: 12 }).then((result) => { if (!cancelled) setFavoritePreview(result); }).catch(() => { if (!cancelled) setFavoritePreview(null); });
    return () => { cancelled = true; };
  }, [ready, view, browse, browsePath, browseQuery, onlyFavorites]);

  // While the user is somewhere other than the library, idle time goes into the root listing
  // and the pictures it will draw, so the first visit finds them warm. Best-effort: the
  // ordinary request on entry stays the authoritative one, and a cancelled pass starts nothing.
  useEffect(() => {
    if (!ready) { libraryPrewarmStarted.current = false; return; }
    if (!viewsReady || view === "library" || !libraries.length || libraryPrewarmStarted.current) return;
    const controller = new AbortController();
    let started = false;
    const cancelIdle = scheduleIdle(() => {
      started = true;
      libraryPrewarmStarted.current = true;
      void api.browse({ path: "", limit: 20, prewarm: true })
        .then((page) => preloadLibraryPosters(page.items, { signal: controller.signal }))
        .catch(() => undefined);
    });
    return () => { controller.abort(); cancelIdle(); if (!started) libraryPrewarmStarted.current = false; };
  }, [ready, viewsReady, view, libraries.length]);

  /** Each scope opens on what it was left in. Walking deeper inside one is the same scope:
   *  the tools keep what they show, and nothing is re-applied or written. */
  const scopeKey = JSON.stringify(scopeOf(browsePath, libraryIds));
  const appliedScope = useRef("");
  useEffect(() => {
    if (!viewsReady || appliedScope.current === scopeKey) return;
    appliedScope.current = scopeKey;
    const prefs = prefsFor(views, scopeOf(browsePath, libraryIds));
    setBrowseSort(prefs.sort);
    setBrowseDesc(prefs.order === "desc");
    setOnlyFavorites(suppressFavoritesApply.current ? false : prefs.favoritesOnly);
    suppressFavoritesApply.current = false;
    setBrowseView(prefs.view);
    setBrowseApplied(true);
  }, [viewsReady, scopeKey, views]);
  // The first listing waits for that apply: an account that sorts by size must not see the
  // name order first and then watch it jump.
  useEffect(() => { if (!ready || view !== "library" || !browseApplied) return; void loadBrowse(browsePath); },
    [ready, view, browseApplied, browsePath, browseQuery, browseSort, browseDesc, onlyFavorites, onlyUnconfirmed, scanEpoch]);
  useEffect(() => { setSelectionMode(false); setSelectedPaths(new Set()); }, [browsePath]);
  // Polling only means something while a scan is on; otherwise one look on entry is enough.
  const scanning = libraryScan?.status === "running" || libraryScan?.status === "paused";
  useEffect(() => {
    if (!ready || view !== "library") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const state = await api.libraryScan();
        if (cancelled) return;
        const previous = scanStatus.current;
        if (previous === "running" && state.status === "idle") return;
        scanStatus.current = state.status;
        applyScanState(state);
      } catch { /* scan status is optional chrome */ }
    };
    void tick();
    if (!scanning) return () => { cancelled = true; };
    const timer = window.setInterval(() => void tick(), 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [ready, view, scanning]);
  const operationsActive = libraryOps.some((job) => job.status === "running" || job.status === "paused");
  useEffect(() => {
    // The library operations queue is administrator-only, reading included: polling it as an
    // ordinary account is a refusal every few seconds for a panel that never shows.
    if (!ready || view !== "library" || session?.role !== "admin") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const jobs = await api.libraryOps();
        if (cancelled) return;
        let completed: LibraryOpsState | undefined;
        for (const job of jobs.jobs) {
          const previous = opsStatus.current.get(job.id);
          const terminal = job.status === "completed" || job.status === "failed" || job.status === "cancelled";
          if (previous && (previous === "running" || previous === "paused") && terminal) completed = job;
          opsStatus.current.set(job.id, job.status);
        }
        setLibraryOps(jobs.jobs);
        if (completed) await finishLibraryOp(completed);
      } catch { /* operation status is optional chrome */ }
    };
    void tick();
    // A job this tab did not queue still has to appear, so the idle wait is short enough to
    // notice one -- and slow enough not to ask the server every second for nothing.
    const timer = window.setInterval(() => void tick(), operationsActive ? 1000 : 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [ready, view, session?.role, operationsActive, browsePath]);
  useEffect(() => { if (ready && view === "library") void loadSuggestionCount(); }, [ready, view, session?.role, scanEpoch]);
  // Confirming the last title takes the button away with it, and a filter nobody can switch
  // off would leave the listing empty for good.
  useEffect(() => { if (!suggestionCount) setOnlyUnconfirmed(false); }, [suggestionCount]);
  // The To confirm shelf opens the same suggestions dialog the library page does; once it
  // closes, Home re-reads the row so a confirmed or dismissed proposal leaves the shelf.
  const suggestionsWereOpen = useRef(false);
  useEffect(() => {
    if (suggestionsWereOpen.current && !suggestionsOpen && viewRef.current === "home") home.refresh(["confirm"]);
    suggestionsWereOpen.current = suggestionsOpen;
  }, [suggestionsOpen]);
  // Page-scroll paging, the same as in the catalogue. The button stays as a fallback.
  useEffect(() => {
    if (view !== "library" || !browse) return;
    const element = browseScrollRef.current;
    if (!element) return;
    const nactenych = browse.items.length;
    if (nactenych >= browse.total) return;
    const onScroll = () => {
      if (browseBusy || restoringScroll.current) return;
      if (element.scrollTop + element.clientHeight >= element.scrollHeight - 500) void loadBrowse(browsePath, nactenych);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => element.removeEventListener("scroll", onScroll);
  }, [view, browse, browseBusy, browsePath]);

  // The wanted entry need not be on the first page, so pages load until it turns up.
  // Scroll and the hide timer run once per jump; a later artwork refresh must not repeat them.
  useEffect(() => {
    if (!browseFocus) {
      focusScrolled.current = null;
      window.clearTimeout(focusTimer.current);
      return;
    }
    if (view !== "library" || !browse || browse.path !== browsePath) return;
    if (!browse.items.some((item) => item.path === browseFocus)) {
      if (browseBusy) return;
      if (browse.items.length < browse.total) void loadBrowse(browsePath, browse.items.length);
      else setBrowseFocus(null);
      return;
    }
    if (focusScrolled.current === browseFocus) return;
    document.querySelector(`[data-path="${CSS.escape(browseFocus)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    focusScrolled.current = browseFocus;
    window.clearTimeout(focusTimer.current);
    focusTimer.current = window.setTimeout(() => setBrowseFocus(null), 5000);
  }, [view, browse, browseBusy, browseFocus]);

  // Artwork is finished in the background; once it is ready the page refreshes itself.
  // Asking once was not enough: a poster fetched from a catalogue takes longer than a
  // second, and the answer still said "pending", which left the tile bare until the user
  // reloaded the page. The wait doubles instead, and gives up rather than polling forever
  // over a file that will never produce a thumbnail.
  const artworkPolls = useRef(0);
  useEffect(() => { artworkPolls.current = 0; }, [browsePath, browseQuery, browseSort, browseDesc, onlyFavorites, onlyUnconfirmed, scanEpoch]);
  useEffect(() => {
    if (view !== "library" || !browse?.pending) return;
    const attempt = artworkPolls.current;
    if (attempt >= 8) return;
    // Only as many entries as are already loaded are refreshed, so the list does not scroll back.
    const nactenych = browse.items.length;
    const timer = setTimeout(() => { artworkPolls.current = attempt + 1; void refreshBrowse(nactenych); }, Math.min(8000, 1000 * 2 ** attempt));
    return () => clearTimeout(timer);
  }, [view, browse, browsePath, browseQuery, browseSort, browseDesc, onlyFavorites, onlyUnconfirmed]);

  /** Jumping from the download queue: opens the folder the file sits in and finds it there.
   * The filters have to be cleared, or the wanted file would stay filtered out of the listing. */
  const revealInLibrary = (target: string) => {
    navigated.current = true;
    const slash = target.lastIndexOf("/");
    setMenuFor(null); setFromFavorites(false); setOnlyFavorites(false); setBrowseQuery("");
    suppressFavoritesApply.current = true;
    setBrowsePath(slash > 0 ? target.slice(0, slash) : "");
    focusScrolled.current = null;
    setBrowseFocus(target);
    // The view is switched in this same tick, so the scroller of the new listing need not exist
    // yet; the stored offset is what the restore reads.
    scrollByView.current.library = 0;
    const scroller = browseScrollRef.current;
    if (scroller) scroller.scrollTop = 0;
    setView("library");
  };

  const [previousFile, setPreviousFile] = useState<{ path: string; title: string } | null>(null);
  const [nextFile, setNextFile] = useState<{ path: string; title: string } | null>(null);
  const [nextBusy, setNextBusy] = useState(false);
  const nextBusyRef = useRef(false);
  useEffect(() => {
    setNextFile(null); setPreviousFile(null);
    if (!playerOpen || !localStream) return;
    let stale = false;
    void api.previousLibraryFile(localStream.sourceId).then((file) => { if (!stale) setPreviousFile(file); }).catch(() => undefined);
    void api.nextLibraryFile(localStream.sourceId).then((file) => { if (!stale) setNextFile(file); }).catch(() => undefined);
    return () => { stale = true; };
  }, [playerOpen, localStream]);
  const playAdjacent = async (file: { path: string; title: string }) => {
    if (!file || nextBusyRef.current) return false;
    nextBusyRef.current = true; setNextBusy(true);
    try { return await playLocal(file.title, file.path, localPoster, localEpisode); }
    finally { nextBusyRef.current = false; setNextBusy(false); }
  };
  const playLocal = async (title: string, path: string, poster?: string, episode = false) => {
    const returning = capturePlaybackReturn({ kind: "library", key: path });
    try {
      const source = await api.librarySource(path);
      setLocalPoster(poster);
      setLocalTitle(title);
      setLocalEpisode(episode);
      setLocalStream({ ...source, localPath: path });
      playbackReturn.current = returning;
      scrollByView.current[view] = returning.windowY;
      playerOpenRef.current = true;
      pickedRef.current = true;
      setPlayerOpen(true);
      return true;
    } catch (error) { fail(error); return false; }
  };
  // Polling reschedules itself instead of running on a fixed interval: a hidden tab
  // does nothing, and a failing server is asked ever less often. A toast on every tick
  // would only cover the screen while the server restarts.
  useEffect(() => {
    if (!ready) return;
    const base = view === "downloads" ? 1200 : 5000;
    let delay = base;
    let timer: number | undefined;
    let stopped = false;
    const plan = (ms: number) => { if (!stopped) timer = window.setTimeout(tick, ms); };
    const tick = async () => {
      if (document.hidden) return plan(base);
      try { applyDownloads(await api.downloads(8000)); delay = base; }
      catch (error) { if (error instanceof ApiError && error.status === 401) setSession(null); delay = Math.min(delay * 2, 30_000); }
      plan(delay);
    };
    const wake = () => { if (!document.hidden) { clearTimeout(timer); delay = base; void tick(); } };
    document.addEventListener("visibilitychange", wake);
    void tick();
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", wake); };
  }, [view, ready]);

  const genreOptions = currentCatalog?.extra?.find((extra) => extra.name === "genre")?.options ?? [];
  // A genre belongs to one catalogue. Switching catalogues drops it from the menu but leaves
  // it in state, and a catalogue returns nothing for a genre it does not know. So we only take it
  // when it exists.
  const activeGenre = genreOptions.includes(genre) ? genre : "";

  /** The same entries can come back from several addons and from several pages. */
  const merge = (previous: Meta[], incoming: Meta[]) => {
    const seen = new Set(previous.map((item) => `${item.type}:${item.id}`));
    return [...previous, ...incoming.filter((item) => !seen.has(`${item.type}:${item.id}`))];
  };

  const loadPage = async (reset: boolean) => {
    if (!submittedQuery && !virtualCatalog && !currentCatalog) return;
    // Paging may be dropped, a new query may not -- that one has to override the run before it.
    if (!reset && loadingRef.current) return;
    const request = reset ? ++requestRef.current : requestRef.current;
    const stale = () => request !== requestRef.current;
    loadingRef.current = true;
    const from = reset ? 0 : skip;
    if (reset) {
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
      setBusy(true); setSelected(null); setStreams([]);
    } else setLoadingMore(true);
    try {
      if (submittedQuery) {
        const controller = new AbortController();
        searchAbortRef.current = controller;
        const result = await api.search(submittedQuery, { ...searchScope, type: effectiveTypeFilter, cursor: reset ? "" : cursor, signal: controller.signal });
        if (stale()) return;
        const next = reset ? result.items : merge(itemsRef.current, result.items);
        // An addon may keep returning the same thing; without this guard paging would never end.
        const gainedNothing = !reset && next.length === itemsRef.current.length;
        itemsRef.current = next; setItems(next);
        setSourceCount(result.sources); setCursor(result.cursor); setHasMore(result.hasMore && !gainedNothing);
        pool.add(result.items, searchScope.addonKey);
        if (reset) {
          firstPageOk.current = submittedQuery;
          if (recordIntent.current === submittedQuery) { recordIntent.current = null; recordSearch(submittedQuery); }
        }
      } else if (virtualCatalog) {
        // The content is derived, so there is nothing to load here.
        setHasMore(false);
      } else {
        const metas = await api.catalog(currentCatalog!, "", from, activeGenre);
        if (stale()) return;
        pool.add(metas, currentCatalog!.addonKey);
        const next = reset ? metas : merge(itemsRef.current, metas);
        const gainedNothing = !reset && next.length === itemsRef.current.length;
        itemsRef.current = next; setItems(next);
        setSkip(from + metas.length); setHasMore(metas.length > 0 && !gainedNothing);
      }
    } catch (e) {
      // A superseded search aborts the fetch in the browser; that is not a failure to report.
      if ((e as { name?: unknown } | null)?.name === "AbortError") return;
      if (!stale()) { if (reset) { itemsRef.current = []; setItems([]); recordIntent.current = null; } fail(e); setHasMore(false); }
    }
    finally { if (!stale()) { loadingRef.current = false; setBusy(false); setLoadingMore(false); } }
  };

  // After Enter or a debounced commit the committed query changes, so the note is recomputed.
  useEffect(() => { if (liveSearchOn) live.update(search, submittedQuery); }, [submittedQuery]);
  useEffect(() => { if (!liveSearchOn) live.cancel(); }, [liveSearchOn]);
  useEffect(() => { if (ready) void loadSearchState(); }, [ready]);
  // Grants or addons changed: titles seen under the old set may no longer be offered.
  useEffect(() => { pool.clear(); }, [addons]);
  // Leaving the catalogue drops a pending commit instead of firing it from behind another view.
  useEffect(() => { if (view !== "catalog") live.cancel(); }, [view]);
  useEffect(() => () => live.cancel(), []);
  const submitSearch = (event?: FormEvent) => {
    event?.preventDefault(); live.cancel(); setSuggestOpen(false);
    const query = search.trim();
    if (query) actOnSearch(query);
    setSubmittedQuery(query);
  };
  const chooseSuggestion = (suggestion: Suggestion) => {
    setSearch(suggestion.text); live.cancel(); setSuggestOpen(false); setActiveSuggestion(-1);
    actOnSearch(suggestion.text);
    setSubmittedQuery(suggestion.text);
  };
  // A changed catalogue, query or filter starts from the first page. The scope only
  // decides what a search asks for, so on its own it reloads nothing.
  useEffect(() => {
    const snapshot = { query: submittedQuery, scope: searchScopeValue, type: typeFilter, genre: activeGenre, virtual: virtualCatalog, catalog: `${currentCatalog?.addonKey}:${currentCatalog?.type}:${currentCatalog?.id}`, reset: catalogReset };
    const previous = loadedSearchRef.current;
    loadedSearchRef.current = snapshot;
    firstPageOk.current = null;
    if (recordIntent.current !== submittedQuery) recordIntent.current = null;
    if (recordedQuery.current !== submittedQuery) recordedQuery.current = null;
    // Only a new query text inside the same search keeps the previous results on screen; every
    // other reset -- new scope, filter, catalogue or built-in list -- starts from nothing.
    const queryOnly = previous !== null && previous.query !== "" && snapshot.query !== "" && previous.query !== snapshot.query
      && previous.scope === snapshot.scope && previous.type === snapshot.type && previous.genre === snapshot.genre
      && previous.virtual === snapshot.virtual && previous.catalog === snapshot.catalog && previous.reset === snapshot.reset;
    if (!queryOnly) { itemsRef.current = []; setItems([]); setSourceCount(0); }
    setSkip(0); setCursor(""); setHasMore(false); void loadPage(true);
  },
    [submittedQuery, submittedQuery && searchScopeValue, typeFilter, activeGenre, virtualCatalog, currentCatalog?.addonKey, currentCatalog?.type, currentCatalog?.id, catalogReset]);
  // Entering search starts from the addon order; browse keeps its own sort untouched.
  useEffect(() => { setSearchSort(searchStateRef.current?.defaultOrder === "titleMatch" ? "titleMatch" : "default"); }, [Boolean(submittedQuery)]);

  // The grid scrolls on its own. A plain scroll listener works even where
  // IntersectionObserver stays quiet (a hidden document, power-saving modes).
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || !hasMore) return;
    // A rotation shortens the grid enough to land inside the margin on its own, and the clamp
    // that follows arrives as a scroll event -- which fetched a page nobody had scrolled for.
    // The margin follows the viewport so a short one cannot sit permanently at the end, and a
    // scroll the restore itself caused is not the viewer reaching the bottom.
    const onScroll = () => {
      if (restoringScroll.current) return;
      const margin = Math.min(400, grid.clientHeight);
      if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - margin) void loadPage(false);
    };
    grid.addEventListener("scroll", onScroll, { passive: true });
    return () => grid.removeEventListener("scroll", onScroll);
  }, [hasMore, skip, cursor, submittedQuery, submittedQuery && searchScopeValue, typeFilter, activeGenre, currentCatalog?.addonKey, currentCatalog?.type, currentCatalog?.id]);

  /** Every addon files the same film under its own id. We merge by name and year and keep
   *  the entry with an IMDb id, because that is what source addons look streams up by. */
  const groupByName = (list: Meta[]) => {
    const groups = new Map<string, Meta>();
    for (const item of list) {
      const year = String(item.releaseInfo ?? item.year ?? "").slice(0, 4);
      const key = `${item.type}|${String(item.name ?? item.id ?? "").trim().toLowerCase()}|${year}`;
      const sources = item.sources ?? [item.addonName].filter(Boolean) as string[];
      const existing = groups.get(key);
      if (!existing) { groups.set(key, { ...item, sources: [...sources] }); continue; }
      const merged = existing.sources ?? [];
      for (const source of sources) if (!merged.includes(source)) merged.push(source);
      const preferIncoming = !String(existing.id).startsWith("tt") && String(item.id).startsWith("tt");
      const winner = preferIncoming ? { ...item } : existing;
      winner.sources = merged;
      winner.poster = existing.poster || item.poster;
      winner.description = existing.description || item.description;
      groups.set(key, winner);
    }
    return [...groups.values()];
  };

  // An addon's priority is its position in the list, set by the arrows on its card.
  const addonPriority = useMemo(() => new Map(addons.map((addon, index) => [addon.manifest.name, index])), [addons]);
  // Cinemeta names the language of a few titles; it stands in where an addon admits it found none.
  const metaLanguage = useMemo(() => titleLanguage(selected?.language), [selected]);
  const offered = useMemo(() => offeredStreams(streams), [streams]);
  const notices = useMemo(() => addonNotices(streams), [streams]);
  const listedStreams = useMemo(
    () => settings.realDebridConfigured ? offered : offered.filter((stream) => stream.kind !== "torrent"),
    [offered, settings.realDebridConfigured]);
  const hiddenTorrents = listedStreams.length < offered.length;
  const visibleStreams = useMemo(
    () => visibleCatalogStreams(listedStreams, { addon: streamAddon, language: streamLanguage, sort: streamSort }, settings.audioLanguage, addonPriority, true, metaLanguage),
    [listedStreams, streamAddon, streamLanguage, streamSort, settings.audioLanguage, addonPriority, metaLanguage]);
  // The counts in each menu apply to what passes the other filter, or they would contradict each other.
  const byLanguage = useMemo(
    () => streamLanguage ? listedStreams.filter((stream) => streamLanguages(stream, metaLanguage).includes(streamLanguage)) : listedStreams,
    [listedStreams, streamLanguage, metaLanguage]);
  const byAddon = useMemo(
    () => streamAddon ? listedStreams.filter((stream) => stream.addonName === streamAddon) : listedStreams,
    [listedStreams, streamAddon]);

  const streamAddons = useMemo(() => {
    const counts = new Map<string, number>();
    for (const stream of byLanguage) { const name = stream.addonName ?? "?"; counts.set(name, (counts.get(name) ?? 0) + 1); }
    // The chosen addon has to stay in the menu even when nothing is left for it, or the field empties.
    if (streamAddon && !counts.has(streamAddon)) counts.set(streamAddon, 0);
    const rank = (name: string) => addonPriority.get(name) ?? Number.MAX_SAFE_INTEGER;
    return [...counts.entries()].sort((a, b) => (rank(a[0]) - rank(b[0])) || (b[1] - a[1]));
  }, [byLanguage, streamAddon, addonPriority]);
  const streamLangs = useMemo(() => {
    const counts = new Map<string, number>();
    for (const stream of byAddon) for (const code of streamLanguages(stream, metaLanguage)) counts.set(code, (counts.get(code) ?? 0) + 1);
    if (streamLanguage && !counts.has(streamLanguage)) counts.set(streamLanguage, 0);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [byAddon, streamLanguage, metaLanguage]);
  // When a filter removes the chosen source, the pick moves to the first one left -- unless
  // the film is already playing on it, when moving it would restart playback on another source.
  useEffect(() => {
    const next = repickStream({
      playing: playerOpen, picked: pickedRef.current, pending: pendingSources,
      visible: visibleStreams, selected: selectedStream, preferred: pickDefaultStream(visibleStreams) ?? null,
    });
    if (next.move) setSelectedStream(next.to);
  }, [visibleStreams, pendingSources, playerOpen]);

  const catalogResume = useMemo(() => catalogResumeEntries(resume, addons), [resume, addons]);
  /** Each Continue watching row with the episode it remembers, in the server's order. */
  const catalogResumeTargets = useMemo(() => catalogResume.map((entry) => resumeTarget(entry)), [catalogResume]);
  /** The same rows by the key the grid gives its tiles. */
  const catalogResumeTargetByKey = useMemo(() => new Map<string, ResumeTarget>(catalogResumeTargets.map((target) => [
    `${target.meta.type || "movie"}:${target.meta.id}`, target,
  ] as const)), [catalogResumeTargets]);
  /** The built-in lists are computed from memory; they must not go through a full load,
   *  which would drop the selected title. */
  const virtualItems = useMemo<Meta[]>(() => {
    if (virtualCatalog === VIRTUAL.watchlist) return watchlist.map((item) => ({ id: item.id, type: item.type, name: item.name, poster: item.poster }));
    if (virtualCatalog === VIRTUAL.resume) return catalogResumeTargets.map((target) => target.meta);
    return [];
  }, [virtualCatalog, watchlist, catalogResumeTargets]);
  useEffect(() => {
    if (!virtualCatalog) return;
    itemsRef.current = virtualItems; setItems(virtualItems); setHasMore(false);
  }, [virtualCatalog, virtualItems]);

  // The library preview includes existing local files; catalog progress stays separate.
  const localResume = useMemo<ResumeTile[]>(() => resumePreview
    ? resumePreview.items.flatMap((item) => item.kind === "file" && item.progress ? [{ key: `file:${item.path}`, path: item.path, title: item.label, poster: item.poster, season: item.season, series: item.series, updatedAt: item.modified, ...item.progress }] : [])
    : localResumeEntries(resume, libraries), [resumePreview, resume, libraries]);
  const catalogProgress = (item: Meta) => resume.find((entry) => item.type === "series"
    ? entry.series?.id === item.id
    : entry.key === `${item.type || "movie"}:${item.id}`);
  const forgetCatalogWatched = async (entry: ProgressEntry) => {
    setMenuFor(null);
    try { await api.forgetProgress(entry.key); setResume(await api.progressList()); }
    catch (error) { fail(error); }
  };

  const visibleItems = useMemo(() => {
    const year = (item: Meta) => Number(String(item.releaseInfo ?? item.year ?? "").slice(0, 4)) || 0;
    // The built-in lists carry their own meaningful order: last watched first, last added
    // to the list. General sorting would only break it.
    if (virtualCatalog) return items;
    const list = settings.mergeByName ? groupByName(items) : [...items];
    const active = submittedQuery ? searchSort : sort;
    if (active === "titleMatch") return rankByTitle(list, submittedQuery);
    if (active === "name") list.sort((a, b) => a.name.localeCompare(b.name, localeTag()));
    else if (active === "year") list.sort((a, b) => year(b) - year(a));
    return list;
  }, [items, sort, searchSort, submittedQuery, settings.mergeByName, virtualCatalog]);
  const activeSort = submittedQuery ? searchSort : sort;
  const suggestions = suggestOpen && view === "catalog"
    ? suggest({ draft: search, recent: searchState?.saveHistory ? searchState.recent : [], candidates: pool.list(), addonKey: searchScope.addonKey, type: effectiveTypeFilter || undefined })
    : [];
  const activeOption = activeSuggestion < suggestions.length ? activeSuggestion : -1;
  const staleGrid = busy && items.length > 0;
  /** One addon's answer, with a failure turned into nothing. */
  const loadStreamPart = async (type: string, id: string, source: { key: string; name: string }) => {
    try { return await api.streams(type, id, source.key); }
    catch (error) {
      // One unreachable addon must neither bring the rest down nor flood the screen with errors.
      report("WARN", `Sources from the addon could not be loaded: ${source.name}`, { addon: source.name, reason: error instanceof Error ? error.message : String(error) });
      return [] as Stream[];
    }
  };
  /** Each addon is asked separately, so results show up as they arrive instead of waiting for the slowest. */
  const fetchSources = async (type: string, id: string, video?: Video) => {
    const request = ++sourcesRequestRef.current;
    const stale = () => request !== sourcesRequestRef.current;
    setSelectedVideo(video ?? null); setSourcesLoaded(false); setBusy(true);
    setStreams([]); setSelectedStream(null); setSubtitles([]); setPendingSources(0);
    pickedRef.current = false;
    try {
      const [sources, nextSubtitles] = await Promise.all([api.streamSources(type, id), api.subtitles(type, id)]);
      if (stale()) return;
      setSubtitles(nextSubtitles); setSourcesLoaded(true); setBusy(false); setPendingSources(sources.length);
      await Promise.all(sources.map(async (source) => {
        const part = await loadStreamPart(type, id, source);
        if (!stale() && part.length) setStreams((previous) => [...previous, ...part]);
        if (!stale()) setPendingSources((count) => count - 1);
      }));
    } catch (e) { if (!stale()) { fail(e); setSourcesLoaded(true); } }
    finally { if (!stale()) setBusy(false); }
  };
  const openMeta = async (item: Meta, resume?: ResumeTarget["episode"]) => {
    const request = ++sourcesRequestRef.current;
    const linksRequest = ++linksRequestRef.current;
    const trailerRequest = ++trailerRequestRef.current;
    setMetaLoading(true);
    // The row the grid drew from, kept beside the merged detail: its pictures are the ones on
    // screen, and they are what a download has to carry into the library.
    setSelected(item); setSelectedSummary(item); setSelectedDownloadTitle(item.name); setSelectedVideo(null); setEpisodesOpen(true); setSeason(null); setStreams([]); setSelectedStream(null); setSubtitles([]); setSourcesLoaded(false); setGalleryIndex(null); setDetailCompact(false); setTitleLinks([]); setTitleTrailer(null);
    requestAnimationFrame(() => detailRef.current?.scrollTo({ top: 0 }));
    const type = item.type || currentCatalog?.type || "movie";
    let detail = item;
    try {
      const metadata = await api.meta(type, item.id, settings.uiLanguage);
      detail = mergeMetaDetail(item, metadata); setSelected(detail); setSelectedDownloadTitle(localizedDownloadTitle(item, metadata, downloadTitleLanguage));
    } catch { /* catalog item is still useful */ }
    finally { if (request === sourcesRequestRef.current) setMetaLoading(false); }
    // The links never hold up the description, and only the title on screen keeps them.
    void api.links(type, item.id, settings.uiLanguage)
      .then((answer) => { if (linksRequest === linksRequestRef.current) setTitleLinks(answer.links); })
      .catch(() => { if (linksRequest === linksRequestRef.current) setTitleLinks([]); });
    void api.trailer(type, item.id, settings.uiLanguage)
      .then((answer) => { if (trailerRequest === trailerRequestRef.current) setTitleTrailer(answer.trailer); })
      .catch(() => { if (trailerRequest === trailerRequestRef.current) setTitleTrailer(null); });
    // The sources fetch moves the same token, so an abandoned open must not start one.
    if (request !== sourcesRequestRef.current) return;
    const remembered = resumeVideo(detail.videos, resume);
    if (remembered) {
      setSeason(remembered.season ?? null); setEpisodesOpen(false);
      await fetchSources(type, remembered.id!, remembered);
    } else if (type !== "series" && !detail.videos?.length) await fetchSources(type, item.id);
  };
  const closeMeta = () => {
    sourcesRequestRef.current += 1;
    linksRequestRef.current += 1;
    trailerRequestRef.current += 1;
    setSelected(null); setSelectedSummary(null); setSelectedDownloadTitle(""); setSelectedVideo(null); setStreams([]); setSelectedStream(null); setSubtitles([]); setSourcesLoaded(false); setGalleryIndex(null); setDetailCompact(false); setTitleLinks([]); setTitleTrailer(null);
  };
  const loadSources = async (video?: Video) => {
    if (!selected) return; await fetchSources(selected.type || currentCatalog?.type || "movie", video?.id || selected.id, video);
  };
  const fetchEpisodeSources = async (type: string, id: string) => {
    const [sources, nextSubtitles] = await Promise.all([api.streamSources(type, id), api.subtitles(type, id).catch(() => [] as Subtitle[])]);
    const parts = await Promise.all(sources.map((source) => loadStreamPart(type, id, source)));
    return { streams: parts.flat(), subtitles: nextSubtitles };
  };
  const orderedEpisodes = useMemo(() => (selected?.videos ?? []).map((video, index) => ({ video, index })).sort((a, b) => {
    const season = (value: Video) => value.season === 0 ? Number.MAX_SAFE_INTEGER : value.season ?? Number.MAX_SAFE_INTEGER - 1;
    return season(a.video) - season(b.video) || (a.video.episode ?? a.index) - (b.video.episode ?? b.index) || a.index - b.index;
  }).map(({ video }) => video), [selected?.videos]);
  const nextCatalogEpisode = useMemo(() => {
    if (!selectedVideo) return null;
    const index = orderedEpisodes.findIndex((video) => video === selectedVideo || (video.id && video.id === selectedVideo.id));
    return index >= 0 ? orderedEpisodes[index + 1] ?? null : null;
  }, [orderedEpisodes, selectedVideo]);
  useEffect(() => {
    if (!playerOpen || localStream || !selected || !nextCatalogEpisode?.id) return;
    const id = nextCatalogEpisode.id;
    const type = selected.type || currentCatalog?.type || "series";
    const promise = fetchEpisodeSources(type, id);
    // The viewer may never ask for this one, and nobody would be waiting to hear it failed.
    void promise.catch(() => undefined);
    nextEpisodePrefetchRef.current = { id, promise };
  }, [playerOpen, localStream, selected?.id, selected?.type, nextCatalogEpisode?.id, currentCatalog?.type]);
  const playNextCatalogEpisode = async () => {
    if (!selected || !nextCatalogEpisode || nextBusyRef.current) return false;
    nextBusyRef.current = true; setNextBusy(true);
    const currentStream = selectedStream;
    const request = ++sourcesRequestRef.current;
    const stale = () => request !== sourcesRequestRef.current;
    setSelectedVideo(nextCatalogEpisode); setEpisodesOpen(false); setSourcesLoaded(false); setBusy(true);
    setStreams([]); setSelectedStream(null); setSubtitles([]); setPendingSources(0); pickedRef.current = false;
    try {
      const type = selected.type || currentCatalog?.type || "series";
      const id = nextCatalogEpisode.id || selected.id;
      const prefetched = nextEpisodePrefetchRef.current;
      let { streams: nextStreams, subtitles: nextSubtitles } = prefetched?.id === id
        ? await prefetched.promise.catch(() => fetchEpisodeSources(type, id))
        : await fetchEpisodeSources(type, id);
      if (stale()) return false;
      const currentLanguage = playbackPreferences.audioLanguage ?? (currentStream ? streamLanguages(currentStream, metaLanguage)[0] : undefined);
      const preferredLanguage = currentLanguage ?? settings.audioLanguage;
      let nextStream = pickNextEpisodeStream(nextStreams, currentStream, preferredLanguage, addonPriority, metaLanguage) ?? null;
      // A listing comes back without the addon that is playing when its request failed or the
      // provider was busy. Asking that one on its own keeps the viewer with the provider they
      // chose instead of moving a binge to another one, in another language.
      if (currentStream?.addonKey && !nextStreams.some((stream) => stream.addonKey === currentStream.addonKey)) {
        const again = await loadStreamPart(type, id, { key: currentStream.addonKey, name: currentStream.addonName ?? "" });
        if (stale()) return false;
        if (again.length) {
          nextStreams = [...nextStreams, ...again];
          nextStream = pickNextEpisodeStream(nextStreams, currentStream, preferredLanguage, addonPriority, metaLanguage) ?? nextStream;
        }
      }
      if (currentStream && nextStream && nextStream.addonKey !== currentStream.addonKey) {
        report("INFO", "The addon that was playing has no source for the next episode", { addon: currentStream.addonName, using: nextStream.addonName });
      }
      setSubtitles(nextSubtitles);
      setStreams(nextStreams); setSelectedStream(nextStream); setPendingSources(0); setSourcesLoaded(true);
      return Boolean(nextStream?.playable);
    } catch (error) {
      if (!stale()) { fail(error); setSourcesLoaded(true); }
      return false;
    } finally {
      if (!stale()) setBusy(false);
      nextBusyRef.current = false; setNextBusy(false);
    }
  };
  const selectedMedia = () => {
    const art = { ...gridArt(selectedSummary, selected), gallery: galleryPayload(galleryImages) };
    // The catalogue's year, first four digits: it names the film's folder and file the way the
    // matcher reads a remake apart from the original. An episode's file carries no year.
    const rawYear = String(selectedSummary?.releaseInfo ?? selectedSummary?.year ?? selected?.releaseInfo ?? selected?.year ?? "").slice(0, 4);
    const year = Number(rawYear);
    const movieYear = rawYear && year >= 1900 && year <= 2100 ? year : undefined;
    return selectedVideo
      ? { kind: "episode", title: baseDownloadTitle, season: selectedVideo.season, episode: selectedVideo.episode, episodeTitle: selectedVideo.title || selectedVideo.name, id: selected?.id, metaType: selected?.type, ...art }
      : { kind: "movie", title: baseDownloadTitle, ...(movieYear ? { year: movieYear } : {}), id: selected?.id, metaType: selected?.type, ...art };
  };
  const canPlay = Boolean(selectedStream?.playable);
  const enqueue = async (target?: SaveTarget) => {
    if (!selectedStream || !canQueue(selectedStream, settings.realDebridConfigured)) return false;
    // The server builds the path from this; without it an episode would end up a flat file.
    const media = selectedMedia();
    try {
      const job = await api.download(videoTitle, selectedStream, media, target);
      notify(t(job.status === "waiting" ? "downloads.waitingDebrid" : "downloads.queued"));
      await loadDownloads(); return true;
    } catch (e) { fail(e); return false; }
  };

  const downloadStreamToDevice = async () => {
    if (!selectedStream?.playable) return false;
    try {
      const filename = await saveToDevice({ title: videoTitle, stream: selectedStream, media: selectedMedia() });
      notify(t("save.startedViaServer", { filename }));
      return true;
    } catch (e) { fail(e); return false; }
  };
  const downloadLibraryFile = async (filePath: string) => {
    try {
      const filename = await saveToDevice({ path: filePath });
      notify(t("save.started", { filename }));
      return true;
    } catch (e) { fail(e); return false; }
  };

  /** Bulk download: the queue gets lazy jobs and each picks its own source (the largest in the
   *  preferred language) when its turn comes. That way addons never get an avalanche of requests. */
  const enqueueEpisodes = async (scope: "series" | "season") => {
    if (!selected?.videos?.length) return;
    const now = Date.now();
    const episodes = selected.videos.filter((video) => {
      if (!video.id) return false;
      if (scope === "season" && video.season !== activeSeason) return false;
      // The whole show means the regular seasons; specials (season 0) and unreleased episodes are skipped.
      if (scope === "series" && typeof video.season === "number" && video.season <= 0) return false;
      if (video.released && Date.parse(String(video.released)) > now) return false;
      return true;
    });
    if (!episodes.length) { fail(new Error(t("episodes.noneToDownload"))); return; }
    const label = scope === "season"
      ? t(activeSeason === 0 ? "episodes.specialsCount" : "episodes.seasonCount", { count: episodes.length, season: activeSeason ?? 0 })
      : t("episodes.wholeShowCount", { count: episodes.length });
    const metaType = selected.type || currentCatalog?.type || "series";
    setBulkDownload({
      label, title: baseDownloadTitle, type: metaType,
      episodes: episodes.map((video) => ({ id: String(video.id), season: video.season, episode: video.episode, title: video.title || video.name })),
      media: { id: selected.id, metaType, ...gridArt(selectedSummary, selected), gallery: galleryPayload(galleryImages) },
    });
  };

  const submitBulkDownload = async (selection: DownloadSelection, target?: SaveTarget) => {
    if (!bulkDownload) return;
    const result = await api.downloadBulk(bulkDownload.title, bulkDownload.type, bulkDownload.episodes, selection, bulkDownload.media, target);
    notify(t("episodes.bulkAdded", { count: result.added }) + (result.skipped ? ` ${t("episodes.bulkSkipped", { count: result.skipped })}` : ""));
    await loadDownloads();
  };

  /** The library's own Continue watching list or its favourites list. Both drop the filters
   *  that would hide what they open, the way the library's own links do. */
  const openHomeLibraryList = (target: ":resume" | ":favorites") => {
    navigated.current = true;
    setMenuFor(null); setFromFavorites(false); setBrowseQuery(""); setOnlyFavorites(false);
    suppressFavoritesApply.current = true;
    setBrowsePath(target);
    scrollByView.current.library = 0;
    setView("library");
  };

  /** A Home media card's action, by kind: a file plays, a catalogue entry opens the remembered
   *  episode the way a catalogue Continue-watching tile does, a favourite or Tonight folder opens
   *  itself, a new episode opens its show the way the Library's row does, and a suggestion opens
   *  the dialog the library page opens. */
  const homePlay = (card: HomeCard) => {
    if (card.kind === "resume-catalogue" || card.kind === "episode" || card.kind === "confirm") return;
    const title = card.kind === "favorite" || card.kind === "recent" || card.kind === "tonight" ? card.label : card.title;
    void playLocal(title, card.path, card.poster, (card.kind === "resume-file" || card.kind === "completed" || card.kind === "recent") && card.season != null);
  };
  const homeOpen = (card: HomeCard) => {
    if (card.kind === "episode") { void openFromCatalog({ type: card.type, id: card.metaId, name: card.name, poster: card.poster }); return; }
    if (card.kind === "confirm") { setSuggestionsOpen(true); return; }
    if (card.kind !== "resume-catalogue") return;
    navigated.current = true;
    setView("catalog");
    const episode = card.season != null && card.episode != null ? { key: card.key, season: card.season, number: card.episode } : undefined;
    void openMeta({ id: card.id, type: card.type, name: card.name, poster: card.poster } as Meta, episode);
  };
  const homeShowAll = (target: ShowAllTarget) => {
    navigated.current = true;
    if (target === "downloads") openView("downloads");
    else if (target === "following") openView("following");
    else if (target === "library") openView("library");
    else if (target === "confirm") setSuggestionsOpen(true);
    else if (target === "catalog-resume") { setView("catalog"); setSelectedCatalog(VIRTUAL.resume); }
    else openHomeLibraryList(target === "library-resume" ? ":resume" : ":favorites");
  };

  const activeLibraryOp = libraryOps.find((job) => job.status === "running" || job.status === "paused");
  const operationProgress = activeLibraryOp
    ? activeLibraryOp.bytesTotal > 0 ? activeLibraryOp.bytes / activeLibraryOp.bytesTotal : (activeLibraryOp.done + activeLibraryOp.failed) / Math.max(1, activeLibraryOp.total)
    : 0;

  if (session === undefined) return <div className="login-screen"><div className="loading">{t("common.loading")}</div></div>;
  if (!ready) return <LoginScreen setup={setupNeeded} onSession={(next) => { setSetupNeeded(false); setSession(next); }}/>;
  // Signed in, but on a password an administrator chose: the server allows this form, reading
  // one's own name and signing out, and nothing else. Rendering the application here would
  // render a shell whose every request comes back refused with nothing to explain it.
  if (session?.mustChangePassword) return <PasswordChangeRequired session={session} onSession={setSession}/>;

  // Following, Addons, Settings and Statistics are the destinations the compact chrome folds
  // into More. `badge` on More is the Following indicator: new episodes plus attention.
  const followingBadge = (newEpisodes.length + follows.reduce((sum, follow) => sum + follow.downloads.attention, 0)) || undefined;
  const moreItems: MoreItem[] = [
    { key: "following", icon: <BellRing/>, label: t("nav.following"), badge: followingBadge, active: view === "following", onSelect: () => openView("following") },
    { key: "addons", icon: <PackagePlus/>, label: t("nav.addons"), badge: addons.length, active: view === "addons", onSelect: () => openView("addons") },
    { key: "settings", icon: <Settings/>, label: t("nav.settings"), active: view === "settings", onSelect: () => openView("settings") },
    ...(session!.role === "admin" ? [{ key: "stats", icon: <BarChart3/>, label: t("nav.stats"), active: view === "stats", onSelect: () => openView("stats") }] : []),
  ];
  const moreActive = view === "following" || view === "addons" || view === "settings" || view === "stats";

  return <div className={`app-shell catalog-tiles-${settings.catalogTileSize} library-tiles-${settings.libraryTileSize} catalog-shape-${settings.catalogTileShape} library-shape-${settings.libraryTileShape} home-shape-${settings.homeTileShape}${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
    <header className="topbar"><button className="brand brand-home" title={t("app.goToCleanCatalog")} aria-label={t("app.goToCleanCatalog")} onClick={resetCatalog}><div className="brand-mark"><CirclePlay/></div><div><small>{t("auth.brandEyebrow")}</small><h1>Stremio <span>Offline</span></h1></div></button><div className="topbar-right">{restricted && <div className="restricted-chip">{t("restricted.chip")}</div>}<div className="online"><i/> {t("app.serverOnline")}</div>
      <div className="topbar-user"><span className="topbar-user-name">
        <strong title={t("auth.signedInAs", { username: session?.username ?? "" })}>{session?.username}</strong>
        {session?.role === "admin" && <i className="library-badge">{t("users.administrator")}</i>}
      </span><button className="signout" title={t("auth.signedInAs", { username: session?.username ?? "" })} aria-label={t("app.signOut")} onClick={signOut}><LogOut/> <span className="signout-label">{t("app.signOut")}</span></button></div></div></header>
    <aside className="sidebar"><nav>
      {/* Restricted accounts have no Home: the view needs the personal data they are not
          given, so the destination is not offered at all. */}
      {!restricted && <Nav icon={<HomeIcon/>} label={t("nav.home")} active={view === "home"} onClick={() => openView("home")}/>}
      <Nav icon={<Library/>} label={t("nav.catalog")} active={view === "catalog"} onClick={() => openView("catalog")}/>
      <Nav icon={<HardDrive/>} label={t("nav.library")} active={view === "library"} onClick={() => openView("library")}/>
      <Nav secondary icon={<BellRing/>} label={t("nav.following")} active={view === "following"} badge={followingBadge} onClick={() => openView("following")}/>
      <Nav icon={<Download/>} label={t("nav.downloads")} active={view === "downloads"} badge={downloads.filter((job) => job.status === "checking" || job.status === "downloading" || job.status === "queued" || job.status === "waiting").length} onClick={() => openView("downloads")}/>
      <Nav secondary icon={<PackagePlus/>} label={t("nav.addons")} active={view === "addons"} badge={addons.length} onClick={() => openView("addons")}/>
      <Nav secondary icon={<Settings/>} label={t("nav.settings")} active={view === "settings"} onClick={() => openView("settings")}/>
      {/* `/api/stats` is administrator-only, so for anybody else this is a tab that loads an
          error. */}
      {session!.role === "admin" && <Nav secondary icon={<BarChart3/>} label={t("nav.stats")} active={view === "stats"} onClick={() => openView("stats")}/>}
      <MoreMenu items={moreItems} badge={followingBadge} active={moreActive} onSignOut={signOut}/>
    </nav><div className="sidebar-bottom"><button className="sidebar-toggle" onClick={toggleSidebar} title={t(sidebarCollapsed ? "app.expandMenu" : "app.collapseMenu")} aria-label={t(sidebarCollapsed ? "app.expandMenu" : "app.collapseMenu")}>{sidebarCollapsed ? <PanelLeftOpen/> : <PanelLeftClose/>}<span>{t(sidebarCollapsed ? "app.expandMenu" : "app.collapseMenu")}</span></button><div className="addon-status"><small>{t("app.activeAddons")}</small><strong>{addons.filter((a) => a.enabled).length}</strong><span>{t("app.catalogsAndSources")}</span></div></div></aside>
    <main className={`view-${view}`}>
      {view === "home" && !restricted && <Home jobs={downloads} libraries={libraries} onShowDownloads={() => openView("downloads")} onAction={homeAction} admin={admin}
        rows={home.rows} shape={settings.homeTileShape} onToggleShape={() => void toggleShape("homeTileShape")}
        onRetry={(row) => home.refresh([row])} onShowAll={homeShowAll} onPlay={homePlay} onOpenCatalogue={homeOpen}
        onShuffle={(row, shuffle) => home.refresh([row], { shuffle })}
        onReveal={revealInLibrary} onForgotten={() => home.refresh(["resume"])} onError={fail}/>}
      {view === "catalog" && <section className={`catalog-view ${catalogCompact ? "catalog-compact" : ""}`} {...chromeGestures(() => gridRef.current)} onFocusCapture={(event) => {
        if ((event.target as HTMLElement).closest(".searchbar,.filterbar")) setCatalogCompact(false);
      }}><Heading eyebrow={t("catalog.eyebrow")} title={t("catalog.title")}/>
        {!catalogs.length ? (restricted || session!.role !== "admin"
          // An ordinary account seeing no catalogue has not been granted an addon, and
          // cannot add one: the invitation would lead to a screen it may not use.
          ? <Empty icon={<PackagePlus/>} title={t("onboarding.title")} text={t(restricted ? "restricted.notice" : "onboarding.noneGranted")}/>
          : <Onboarding onOpen={() => { navigated.current = true; setView("addons"); }}/>) : <>
          {/* The head sits on the same columns as the panels below it: search spans both, so it ends
              with the sources panel, and the filters keep to the first, so they end with the results. */}
          <div className="catalog-head"><div className={`fold${catalogCompact ? " closed" : ""}${suggestions.length ? " suggesting" : ""}`}><form className="searchbar" onSubmit={submitSearch}>
            <div className="search-input"><Search/><input value={search} role="combobox" aria-autocomplete="list" aria-expanded={suggestions.length > 0} aria-controls="search-suggestions" aria-activedescendant={activeOption >= 0 ? `search-suggestion-${activeOption}` : undefined}
              onChange={(e) => { setSearch(e.target.value); setSuggestOpen(true); setActiveSuggestion(-1); if (liveSearchOn) live.update(e.target.value, submittedQuery); }}
              onCompositionStart={() => live.compositionStart()} onCompositionEnd={(e) => { if (liveSearchOn) live.compositionEnd(e.currentTarget.value, submittedQuery); }}
              onFocus={() => { if (!quietFocus.current) setSuggestOpen(true); void loadSearchState(); }} onBlur={() => setSuggestOpen(false)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  if (!suggestions.length) { setSuggestOpen(true); return; }
                  e.preventDefault();
                  const step = e.key === "ArrowDown" ? 1 : -1;
                  // The cycle passes through -1, the typed text itself, between the last row and the first.
                  const next = activeOption + step;
                  setActiveSuggestion(next >= suggestions.length ? -1 : next < -1 ? suggestions.length - 1 : next);
                } else if (e.key === "Enter" && activeOption >= 0) { e.preventDefault(); chooseSuggestion(suggestions[activeOption]); }
                // Shift+Delete removes the highlighted recent search, as browsers do in their own lists.
                else if (e.key === "Delete" && e.shiftKey && suggestions[activeOption]?.kind === "recent") { e.preventDefault(); forgetSearch(suggestions[activeOption].text); }
                else if (e.key === "Escape" && suggestions.length) { e.preventDefault(); setSuggestOpen(false); setActiveSuggestion(-1); }
              }} placeholder={t("catalog.searchPlaceholder")}/>

            </div>
            <label className="scope-select"><span>{t("catalog.searchScopeIn")}</span><select aria-label={t("catalog.searchScope")} value={searchScopeValue} onChange={(e) => pickSearchScope(e.target.value)}>
              <option value="">{t("catalog.allAddons")}</option>
              {[...new Map(searchable.map((item) => [item.addonKey, { name: item.addonName, globalSearch: item.globalSearch }])).entries()].map(([key, group]) => <optgroup key={key} label={`${group.name}${group.globalSearch ? "" : " ·"}`} title={group.globalSearch ? undefined : t("catalog.onlyWhenPicked")}>
                <option value={`addon:${key}`} title={group.globalSearch ? undefined : t("catalog.onlyWhenPicked")}>{t("catalog.allCatalogs")}{group.globalSearch ? "" : " ·"}</option>
                {searchable.filter((item) => item.addonKey === key).map((item) => <option key={`${item.type}:${item.id}`} value={`catalog:${key}:${item.type}:${item.id}`} title={item.globalSearch ? undefined : t("catalog.onlyWhenPicked")}>{item.name} ({typeTag(item.type)}){item.globalSearch ? "" : " ·"}</option>)}
              </optgroup>)}
            </select></label>
            <button className="primary"><Search/> {t("catalog.search")}</button>
            {submittedQuery && <button type="button" onClick={() => { live.cancel(); setSearch(""); setSubmittedQuery(""); }}><X/> {t("common.cancel")}</button>}
            {/* Under the whole bar, not the field: on a narrow screen the scope and the Search
                button wrap below the field, and a list hanging from it would cover them. */}
            {suggestions.length > 0 && <ul id="search-suggestions" role="listbox" aria-label={t("catalog.suggestions")} className="search-suggestions">{suggestions.map((suggestion, index) =>
                <li key={`${suggestion.kind}:${suggestion.text}`} id={`search-suggestion-${index}`} role="option" aria-selected={index === activeOption} className={index === activeOption ? "active" : undefined}
                  onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()} onClick={() => chooseSuggestion(suggestion)}>
                  {suggestion.kind === "recent" ? <History/> : <Film/>}<span>{suggestion.text}</span><small>{t(suggestion.kind === "recent" ? "catalog.suggestRecent" : "catalog.suggestTitle")}</small>
                  {/* Outside the tab order: the list is reached through the field, and Shift+Delete does the same. */}
                  {suggestion.kind === "recent" && <button type="button" className="forget-recent" tabIndex={-1} aria-label={t("catalog.forgetRecent")} title={t("catalog.forgetRecent")}
                    onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); forgetSearch(suggestion.text); }}><X/></button>}</li>)}</ul>}
          </form></div>
          <div className="filter-slot"><div className="filterbar">
            {submittedQuery
              ? <>
                  <span className="scope-badge">{t("catalog.searchedCatalogs", { count: sourceCount })} {scopedCatalog ? t("catalog.inCatalog", { addon: scopedCatalog.addonName, catalog: scopedCatalog.name }) : searchScope.addonKey ? t("catalog.inAddon", { addon: searchable.find((item) => item.addonKey === searchScope.addonKey)?.addonName ?? "" }) : t("catalog.inAllAddons")}</span>
                  <label><span>{t("catalog.type")}</span><select aria-label={t("catalog.type")} value={effectiveTypeFilter} disabled={Boolean(searchScope.catalogType)} onChange={(e) => setTypeFilter(e.target.value)}>
                    {searchScope.catalogType
                      ? <option value={searchScope.catalogType}>{typeLabel(searchScope.catalogType)}</option>
                      : <><option value="">{t("common.all")}</option><option value="movie">{t("catalog.movies")}</option><option value="series">{t("catalog.series")}</option></>}
                  </select></label>
                </>
              : <>
                  <label className="catalog-filter"><span>{t("catalog.browse")}</span><select className="catalog-select" aria-label={t("catalog.browse")} value={selectedCatalog} onChange={(e) => setSelectedCatalog(e.target.value)}>
                    <option value={VIRTUAL.watchlist}>★ {t("catalog.myList")} ({watchlist.length})</option>
                    <option value={VIRTUAL.resume}>▸ {t("library.continueWatching")} ({catalogResume.length})</option>
                    {catalogs.map((catalog) => <option key={`${catalog.addonKey}:${catalog.type}:${catalog.id}`} value={`${catalog.addonKey}:${catalog.type}:${catalog.id}`}>{catalog.addonName} · {catalog.name || catalog.id} ({typeTag(catalog.type)})</option>)}
                  </select></label>
                  {genreOptions.length > 0 && <label><span>{t("catalog.genre")}</span><select aria-label={t("catalog.genre")} value={activeGenre} onChange={(e) => setGenre(e.target.value)}><option value="">{t("catalog.allGenres")}</option>{genreOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>}
                </>}
            <label><span>{t("common.sorting")}</span><select aria-label={t("catalog.sorting")} value={activeSort} onChange={(e) => (submittedQuery ? setSearchSort(e.target.value) : setSort(e.target.value))}><option value="default">{t("catalog.sortAddon")}</option>{submittedQuery && <option value="titleMatch">{t("catalog.sortTitleMatch")}</option>}<option value="name">{t("catalog.sortName")}</option><option value="year">{t("catalog.sortYear")}</option></select></label>
            {activeSort !== "default" && <small className="filter-note">{t("catalog.sortNote")}</small>}
            <button className="shape-toggle" title={t(settings.catalogTileShape === "wide" ? "catalog.shapePoster" : "catalog.shapeWide")} aria-pressed={settings.catalogTileShape === "wide"} onClick={() => void toggleShape("catalogTileShape")}>{settings.catalogTileShape === "wide" ? <RectangleVertical/> : <RectangleHorizontal/>}</button>
            {/* The one control the collapsed header keeps: it unfolds the search block and hands over the caret. */}
            <button className="header-expand" title={t("catalog.showTools")} aria-label={t("catalog.showTools")} aria-expanded={!catalogCompact} onClick={(event) => {
              holdHeaderOpen();
              setCatalogCompact(false);
              // A folded box cannot take focus, so the caret waits for the fold itself to finish
              // rather than for a guessed number of milliseconds. The timer is the way out when
              // there is no transition to wait for, as with reduced motion.
              const bar = event.currentTarget.closest(".catalog-view")?.querySelector(".searchbar");
              const focus = () => {
                // The caret is handed over for typing; the list of past searches waits for a keystroke.
                quietFocus.current = true;
                bar?.querySelector<HTMLInputElement>(".search-input input")?.focus();
                quietFocus.current = false;
              };
              const onEnd = (ended: Event) => {
                if ((ended as TransitionEvent).propertyName !== "max-height") return;
                bar?.removeEventListener("transitionend", onEnd);
                focus();
              };
              bar?.addEventListener("transitionend", onEnd);
              window.setTimeout(() => { bar?.removeEventListener("transitionend", onEnd); focus(); }, 400);
            }}><SlidersHorizontal/></button>
          </div></div></div>
          <div className="catalog-layout"><section className={`panel result-panel${staleGrid ? " refreshing" : ""}`}><div className="panel-head"><h3>{submittedQuery ? t("catalog.searchHeading", { query: submittedQuery }) : t("catalog.results")}</h3><small className="search-status" role="status">{liveState === "pending" || (busy && submittedQuery) ? t("catalog.searchUpdating") : liveState === "tooShort" ? t("catalog.searchMinChars") : ""}</small><span>{t("catalog.itemCount", { count: visibleItems.length })}{hasMore ? "+" : ""}</span></div>
            <div className={`poster-grid${staleGrid ? " stale" : ""}`} aria-busy={staleGrid || undefined} ref={gridRef} onScroll={(event) => { compactOnScroll(event, catalogCompact, setCatalogCompact, true); scheduleViewAnchor(); }}>
              {visibleItems.map((item) => {
                const klic = `${item.type || "movie"}:${item.id}`;
                const postup = catalogProgress(item);
                const resumeRow = virtualCatalog === VIRTUAL.resume ? catalogResumeTargetByKey.get(klic) : undefined;
                const vSeznamu = inWatchlist(item.type, item.id);
                const episodeRow = resumeRow?.episode ? episodeLabel({ season: resumeRow.episode.season, episode: resumeRow.episode.number }) : undefined;
                // A row left behind by a finished episode is not being watched yet: it says so
                // instead of pretending to hold a position.
                const metadata = episodeRow
                  ? [postup?.pending ? t("library.nextEpisode") : null, episodeRow].filter(Boolean).join(" · ")
                  : [item.releaseInfo || item.year, submittedQuery ? (item.sources ?? [item.addonName]).filter(Boolean).join(", ") : null].filter(Boolean).join(" · ") || item.type;
                return <button key={klic} data-catalog-key={klic} className={`poster-card ${selected?.id === item.id ? "selected" : ""}`} onClick={() => { if (submittedQuery) actOnSearch(submittedQuery); void openMeta(item, resumeRow?.episode); }}>
                  <span className="poster-wrap">
                    <TileArt shape={settings.catalogTileShape} poster={item.poster} wide={item.background} fallback={<div className="poster-fallback"><Film/></div>}/>
                    {vSeznamu && <i className="fav-mark"><Star/></i>}
                    {postup && !postup.pending && <i className="resume-bar"><i style={{ width: `${Math.min(100, Math.round(postup.position / (postup.duration || 1) * 100))}%` }}/></i>}
                    <span className="browse-menu" onClick={(event) => { event.stopPropagation(); setMenuFor(menuFor === klic ? null : klic); }}><MoreVertical/></span>
                  </span>
                  <strong>{item.name}</strong>
                  <small title={metadata}>{metadata}</small>
                  {menuFor === klic && <span className="browse-actions" onClick={(event) => event.stopPropagation()}>
                    <button onClick={() => { setMenuFor(null); void toggleWatchlist(item); }}><Star/> {t(vSeznamu ? "watchlist.remove" : "watchlist.add")}</button>
                    {postup && <button onClick={() => void forgetCatalogWatched(postup)}><RotateCcw/> {t("library.markUnwatched")}</button>}
                  </span>}
                </button>;
              })}
              {hasMore && <div className="load-more">{loadingMore ? <span>{t("common.loadingMore")}</span> : <button onClick={() => void loadPage(false)}>{t("common.loadMore")}</button>}</div>}
            </div>
            {!items.length && !busy && <Empty icon={<Search/>}
              title={t(submittedQuery ? "catalog.emptySearchTitle" : searchRequired ? "catalog.needQueryTitle" : "catalog.emptyTitle")}
              text={submittedQuery ? t("catalog.emptySearchText", { count: sourceCount }) : t(searchRequired ? "catalog.needQueryText" : "catalog.emptyText")}/>}
            {busy && <div className="loading">{t("common.loading")}</div>}
          </section><section ref={detailRef} className={`panel detail-panel ${selected ? "mobile-open" : ""} ${selected?.videos?.length && episodesOpen ? "series-episodes-layout" : ""} ${sourcesLoaded && (selected?.videos?.length ? selectedVideo && !episodesOpen : true) ? "series-sources-layout" : ""} ${detailCompact ? "hero-compact" : ""}`}>{selected ? <>
            <div className="mobile-detail-head"><button onClick={selected.videos?.length && selectedVideo && !episodesOpen ? () => setEpisodesOpen(true) : closeMeta}><ChevronLeft/> {t(selected.videos?.length && selectedVideo && !episodesOpen ? "episodes.heading" : "catalog.results")}</button><strong>{selected.name}</strong></div>
            <div className="detail-primary"><div className={`hero ${selected.videos?.length ? "series-hero" : ""} ${galleryImages.length ? "has-gallery" : ""}`} style={selected.background ? { backgroundImage: `linear-gradient(90deg,#121721 25%,transparent),url(${selected.background})` } : undefined}><div className="detail-copy">{titleChips(titleTrailer, titleLinks, <><button className={`watch-star ${inWatchlist(selected.type, selected.id) ? "on" : ""}`} title={t(inWatchlist(selected.type, selected.id) ? "watchlist.remove" : "watchlist.add")}
                onClick={() => void toggleWatchlist(selected)}><Star/></button><span className="pill">{t(selected.type === "series" ? "catalog.oneSeries" : "catalog.oneMovie")}</span>{(selected.type === "series" || selected.type === "movie" || Boolean(selected.videos?.length)) && (detailFollow ? <button className="follow-chip on" onClick={() => setFollowDialogOpen(true)}><BellRing/>{t("follow.following")}{detailFollow.autoDownload && <span className="follow-chip-download" aria-hidden="true" title={t("follow.autoOnHint")}><Download/></span>}</button> : <button className="follow-chip" onClick={() => setFollowStart(selected)}><Bell/>{t("follow.follow")}</button>)}</>)}<h2>{selected.name}</h2><p className="meta-line">{imdbRating(selected) && <b className="imdb-rating" title={t("catalog.imdbRating", { rating: imdbRating(selected)! })}><Star/>{imdbRating(selected)}</b>}{imdbRating(selected) && [selected.releaseInfo || selected.year, ...(selected.genres || []).slice(0, 3)].filter(Boolean).length ? " · " : ""}{[selected.releaseInfo || selected.year, ...(selected.genres || []).slice(0, 3)].filter(Boolean).join(" · ")}</p><div className="catalog-description" aria-busy={metaLoading}><p className="description-preview" aria-hidden={metaLoading ? true : undefined}>{metaLoading ? skeletonLines : (selected.description || t("catalog.noDescription"))}</p><details key={selected.id}><summary>{t("catalog.description")}</summary><p tabIndex={0}>{metaLoading ? skeletonLines : (selected.description || t("catalog.noDescription"))}</p></details></div></div>{galleryImages.length > 0 && <button className={`gallery-open ${galleryImages[0].shape}`} onClick={() => setGalleryIndex(0)} title={t("gallery.openHint")}><img src={galleryImages[0].url} alt="" onError={hideBroken}/><span><Images/> {galleryImages.length > 1 ? t("gallery.stillCount", { count: galleryImages.length }) : t("gallery.enlarge")}</span></button>}</div></div>
            <div className="detail-workflow">
            {selected.videos?.length ? !(chosenEpisode && sourcesLoaded) && <div className={`episodes ${chosenEpisode ? "collapsed" : ""}`}>{chosenEpisode ?? <><div className="subhead episode-head"><h3>{t("episodes.heading")}</h3><div className="episode-tools">{seasons.length > 1 && <select className="season-select" aria-label={t("episodes.season")} value={activeSeason ?? ""} onChange={(event) => setSeason(Number(event.target.value))}>{seasons.map((value) => <option key={value} value={value}>{value === 0 ? t("episodes.specials") : t("episodes.seasonNumber", { season: value })}</option>)}</select>}{activeSeason != null && <button title={activeSeason === 0 ? t("episodes.downloadSpecials") : t("episodes.downloadSeason", { season: activeSeason })} onClick={() => void enqueueEpisodes("season")}><Download/> {activeSeason === 0 ? t("episodes.specials") : t("episodes.seasonShort", { season: activeSeason })}</button>}<button title={t("episodes.downloadShow")} onClick={() => void enqueueEpisodes("series")}><Download/> {t("episodes.wholeShow")}</button>{selectedVideo ? <button onClick={() => setEpisodesOpen(false)}>{t("common.collapse")}</button> : <span>{visibleEpisodes.length}</span>}</div></div><div className="episode-list" onScroll={(event) => compactOnScroll(event, detailCompact, setDetailCompact, true)}>{visibleEpisodes.map((video, index) => <button key={video.id || index} className={selectedVideo?.id === video.id ? "selected" : ""} onClick={() => { setEpisodesOpen(false); void loadSources(video); }}><b>{video.season != null ? `${String(video.season).padStart(2,"0")}×${String(video.episode || 0).padStart(2,"0")}` : index + 1}</b><span>{video.title || video.name || t("episodes.one")}</span><ChevronRight/></button>)}</div></>}</div> : !sourcesLoaded && <button className="primary wide" onClick={() => loadSources()} disabled={busy}>{t("sources.load")}</button>}
            {sourcesLoaded && (!selected.videos?.length || !episodesOpen) && <div className="sources"><div className={`subhead ${chosenEpisode ? "sources-episode" : ""}`}>{chosenEpisode ?? <h3>{t("sources.heading")}</h3>}<span>{visibleStreams.length === offered.length ? offered.length : t("sources.ofTotal", { shown: visibleStreams.length, total: offered.length })}{pendingSources > 0 ? ` · ${t("sources.loadingFrom", { count: pendingSources })}` : ""}</span></div>
              {offered.length > 1 && <div className="stream-filters">
                <label><span>{t("sources.addon")}</span><select value={streamAddon} onChange={(event) => setStreamAddon(event.target.value)}>
                  <option value="">{t("sources.allAddons")} ({byLanguage.length})</option>
                  {streamAddons.map(([name, count]) => <option key={name} value={name}>{name} ({count})</option>)}
                </select></label>
                {streamLangs.length > 0 && <label><span>{t("auth.language")}</span><select value={streamLanguage} onChange={(event) => setStreamLanguage(event.target.value)}>
                  <option value="">{t("sources.anyLanguage")} ({byAddon.length})</option>
                  {streamLangs.map(([code, count]) => <option key={code} value={code}>{label(code)} ({count})</option>)}
                </select></label>}
                <label><span>{t("common.sorting")}</span><select value={streamSort} onChange={(event) => setStreamSort(event.target.value as StreamSort)}>
                  <option value="recommended">{t("sources.sortRecommended")}</option>
                  <option value="size-desc">{t("sources.sortLargest")}</option>
                  <option value="size-asc">{t("sources.sortSmallest")}</option>
                  <option value="addon">{t("sources.sortAddon")}</option>
                </select></label>
              </div>}<div className="stream-list" onScroll={(event) => compactOnScroll(event, detailCompact, setDetailCompact, true)}>{visibleStreams.map((stream, index) => <button key={index} className={selectedStream === stream ? "selected" : ""} onClick={() => { pickedRef.current = true; setSelectedStream(stream); }}><i className={stream.kind === "torrent" ? "rd" : stream.playable ? undefined : "ext"}>{streamBadge(stream)}</i><span><strong>{streamLabel(stream)}</strong><small>{stream.addonName}</small></span><span className="stream-meta">{streamSize(stream) ? <b>{bytes(streamSize(stream))}</b> : null}<small>{streamLanguages(stream, metaLanguage).map((code) => <em className="lang-badge" key={code} title={t("sources.languageGuess")}>{label(code)}</em>)}</small></span>{selectedStream === stream && <Check/>}</button>)}</div>
              {!offered.length && pendingSources === 0 && <div className="no-sources">{t("sources.none")}</div>}
              {!offered.length && pendingSources > 0 && <div className="no-sources">{t("sources.asking")}</div>}
              {Boolean(offered.length) && !visibleStreams.length && hiddenTorrents && !streamAddon && !streamLanguage && <div className="no-sources">{t("sources.onlyTorrentsBefore")} <button className="link-button" onClick={() => openView("settings")}>{t("nav.settings")}</button> {t("sources.onlyTorrentsAfter")}</div>}
              {Boolean(offered.length) && !visibleStreams.length && !(hiddenTorrents && !streamAddon && !streamLanguage) && <div className="no-sources">{t("sources.noneMatchFilter", { count: offered.length })} <button className="link-button" onClick={() => { setStreamAddon(""); setStreamLanguage(""); }}>{t("sources.clearFilters")}</button></div>}
              {notices.map((notice) => <p className="notice" key={notice.sourceId}><b>{notice.addonName}</b> {noticeText(notice)}</p>)}
              {selectedStream?.kind === "torrent" && <p className="notice">{t("sources.torrentNotice")}</p>}
              <div className="source-footer"><div className="source-info"><Subtitles/> {t("sources.subtitleCount", { count: subtitles.length + (selectedStream?.subtitles?.length || 0) })}
                {inspection && <> · <b>{t("sources.audioInFile")}</b> {inspection.audioTracks.length ? inspection.audioTracks.map((track, index) => <em className="lang-badge" key={index}>{label(track.language)}</em>) : "—"}
                · <b>{t("sources.subtitlesInFile")}</b> {inspection.subtitleTracks.length ? inspection.subtitleTracks.map((track, index) => <em className="lang-badge" key={index}>{label(track.language)}</em>) : "—"}</>}
              {selectedStream?.playable && !inspection && <> · {t("sources.probing")}</>}</div><div className="action-slot"><div className="actions"><button className="primary" disabled={!canPlay} onClick={() => openPlayer({ kind: "catalog", key: `${selected.type || "movie"}:${selected.id}` })}><CirclePlay/> {t("player.play")}</button><div className="split-button"><button disabled={!selectedStream || !canQueue(selectedStream, settings.realDebridConfigured)} onClick={() => void enqueue()}><HardDrive/> {t("save.toLibrary")}</button><button className="split-button-toggle" disabled={!selectedStream || !canQueue(selectedStream, settings.realDebridConfigured)} aria-haspopup="dialog" aria-label={t("save.toLibraryElsewhere")} title={t("save.toLibraryElsewhere")} onClick={() => setSaveTargetOpen(true)}><ChevronDown/></button></div><button disabled={!canPlay} onClick={() => void downloadStreamToDevice()}><Download/> {t("save.toDevice")}</button></div></div></div>
            </div>}
            </div>
          </> : <Empty icon={<Film/>} title={t("catalog.pickTitle")} text={t("catalog.pickText")}/>}</section></div>
        </>}
      </section>}
      {view === "library" && <section className={`library-page${libraryCompact ? " library-compact" : ""}`} {...chromeGestures(() => browseScrollRef.current)} onKeyDown={(event) => { if (event.key === "Escape") setMenuFor(null); }} onClick={() => menuFor && setMenuFor(null)}><Heading eyebrow={t("library.eyebrow")} title={t("library.title")}/>
        <div className="panel browse-panel">
        <div className="browse-head">
        <div className="browse-bar">
          <nav className="crumbs" aria-label={t("library.breadcrumbs")}>
            {browsePath && <button className="library-back" aria-label={t("library.folderUp")} onClick={() => { setBrowseQuery(""); setMenuFor(null); if (browsePath.startsWith(":")) setFromFavorites(false); setBrowsePath(browsePath.startsWith(":") ? "" : browsePath.includes("/") ? browsePath.slice(0, browsePath.lastIndexOf("/")) : fromFavorites ? ":favorites" : ""); }}><ChevronLeft/></button>}
            <button onClick={() => { setBrowseQuery(""); setFromFavorites(false); setBrowsePath(""); }} disabled={!browsePath}><HardDrive/> {t("nav.library")}</button>
            {(fromFavorites || browsePath === ":favorites") && <span>
              <ChevronRight/>
              <button disabled={browsePath === ":favorites"} onClick={() => { setBrowseQuery(""); setBrowsePath(":favorites"); }}>{t("favorite.off")}</button>
            </span>}
            {browsePath === ":resume" && <span><ChevronRight/><button disabled>{t("library.continueWatching")}</button></span>}
            {!browsePath.startsWith(":") && browsePath.split("/").filter(Boolean).map((part, index, all) => <span key={part + index}>
              <ChevronRight/>
              {/* Segment zero is a library id; the id is never shown. */}
              <button disabled={index === all.length - 1} onClick={() => { setBrowseQuery(""); setBrowsePath(all.slice(0, index + 1).join("/")); }}>{index === 0 ? libraries.find((library) => library.id === part)?.name ?? part : part}</button>
            </span>)}
          </nav>
          <div className="browse-tools">
            <div className={`fold browse-fold${libraryCompact ? " closed" : ""}`}><div className="browse-fold-inner">
            {!libraryList && <div className="search-input"><Search/><input value={browseQuery} aria-label={t("library.filter")} placeholder={t("library.filterPlaceholder")} onChange={(event) => setBrowseQuery(event.target.value)}/></div>}
            {!libraryList && <select aria-label={t("common.sorting")} value={browseSort} onChange={(event) => {
              const next = event.target.value as LibrarySort;
              setBrowseSort(next);
              // Dates and sizes start with the largest value; names start with A.
              setBrowseDesc(next === "added" || next === "size");
              persistLibraryPrefs({ sort: next, order: next === "added" || next === "size" ? "desc" : "asc" });
            }}>
              <option value="name">{t("library.sortName")}</option><option value="added">{t(browsePath === ":resume" ? "library.sortLastWatched" : "library.sortAdded")}</option>
              <option value="size">{t("library.sortSize")}</option><option value="random">{t("library.sortRandom")}</option>
            </select>}
            {!libraryList && <button title={t(browseDesc ? "common.descending" : "common.ascending")} onClick={() => { setBrowseDesc((value) => !value); persistLibraryPrefs({ order: browseDesc ? "asc" : "desc" }); }} disabled={browseSort === "random"}>
              {browseDesc ? <ArrowDown/> : <ArrowUp/>}
            </button>}
            {!libraryList && <button className={onlyFavorites ? "active-filter" : ""} title={t("library.onlyFavorites")} disabled={browsePath === ":favorites"}
              onClick={() => { setOnlyFavorites((value) => !value); persistLibraryPrefs({ favoritesOnly: !onlyFavorites }); }}><Star/></button>}
            {/* Only while the scan has something waiting: with nothing to confirm the filter
                would list an empty folder and say nothing about why. */}
            {!libraryList && suggestionCount > 0 && <button className={onlyUnconfirmed ? "active-filter" : ""} title={t("library.onlyUnconfirmed")}
              aria-pressed={onlyUnconfirmed} disabled={browsePath === ":favorites" || browsePath === ":resume"}
              onClick={() => setOnlyUnconfirmed((value) => !value)}><Sparkles/></button>}
            {!libraryList && <button title={t(browseView === "grid" ? "library.viewRows" : "library.viewTiles")} onClick={() => { setBrowseView((value) => value === "grid" ? "list" : "grid"); persistLibraryPrefs({ view: browseView === "grid" ? "list" : "grid" }); }}>
              {browseView === "grid" ? <List/> : <LayoutGrid/>}
            </button>}
            {admin && !libraryList && <button className={selectionMode ? "active-filter" : ""} title={t("library.selectMode")} aria-pressed={selectionMode}
              onClick={() => { setMenuFor(null); if (selectionMode) leaveSelection(); else setSelectionMode(true); }}><Check/></button>}
            </div></div>
            {/* What a folded header keeps: where the tiles stand, the tools, and the way back. */}
            <div className="browse-keep">
            {!libraryList && browseView === "grid" && <button className="shape-toggle" title={t(settings.libraryTileShape === "wide" ? "library.shapePoster" : "library.shapeWide")} aria-pressed={settings.libraryTileShape === "wide"} onClick={() => void toggleShape("libraryTileShape")}>{settings.libraryTileShape === "wide" ? <RectangleVertical/> : <RectangleHorizontal/>}</button>}
            <div className="library-maintenance" onKeyDown={(event) => {
              if (event.key === "Escape" && menuFor === ":library-tools") event.currentTarget.querySelector<HTMLButtonElement>(".library-maintenance-toggle")?.focus();
            }}>
              <button className="library-maintenance-toggle" aria-label={t("library.tools")} title={t("library.tools")} aria-expanded={menuFor === ":library-tools"} aria-controls="library-maintenance-actions" onClick={(event) => {
                event.stopPropagation();
                setMenuFor(menuFor === ":library-tools" ? null : ":library-tools");
              }}><MoreVertical/></button>
              <div id="library-maintenance-actions" className={`library-maintenance-actions${menuFor === ":library-tools" ? " open" : ""}`}>
                <button title={t("library.scan")} onClick={() => void startScan()} disabled={scanning}>
                  <Sparkles/> {t("library.scan")}
                </button>
                <button title={t("library.rescanHint")} onClick={() => void startScan({ force: true })} disabled={scanning}>
                  <RefreshCw/> {t("library.rescan")}
                </button>
                <button title={t("library.recheckAutomaticHint")} onClick={() => void recheckAutomatic()} disabled={scanning || !currentLibraryId}>
                  <ShieldQuestion/> {t("library.recheckAutomatic")}
                </button>
                {!libraryList && !browsePath.startsWith(":") && <button title={t("library.createFolder")} onClick={() => { setMenuFor(null); void createFolder(); }}>
                  <Plus/> {t("library.createFolder")}
                </button>}
                {/* One library is one thing to manage: the settings section holds it, and the
                    toolbar stays the row it has always been. More than one and managing them
                    is a browse-time job, so the shortcut appears. */}
                {libraries.length > 1 && <button className="library-manager-shortcut" title={t("library.libraries")} onClick={() => { setMenuFor(null); setLibraryManagerOpen(true); }}>
                  <Library/> {t("library.libraries")}
                </button>}
              </div>
            </div>
            <button className="header-expand" title={t("library.showTools")} aria-label={t("library.showTools")} aria-expanded={!libraryCompact} onClick={() => { holdHeaderOpen(); setLibraryCompact(false); }}><SlidersHorizontal/></button>
            </div>
          </div>
        </div>
        {libraryScan && (libraryScan.status === "running" || libraryScan.status === "paused") && <div className="library-scan-status" role="status">
          <span>{t("library.scanProgress", { done: libraryScan.done, total: libraryScan.total, matched: libraryScan.matched })}</span>
          {libraryScan.pauseReason === "playback" && <span>{t("library.scanPausedPlayback")}</span>}
          {libraryScan.pauseReason === "download" && <span>{t("library.scanPausedDownload")}</span>}
          {libraryScan.pauseReason === "breaker" && <span>{t("library.scanPausedAddon")}</span>}
          {libraryScan.pauseReason === "operation" && <span>{t("library.scanPausedOperation")}</span>}
          <button type="button" onClick={() => void stopScan()}>{t("library.scanStop")}</button>
        </div>}
        {activeLibraryOp && <div className="library-op-status" role="status">
          <div><strong>{t(`library.bulkOp.${activeLibraryOp.op}` as Key)}</strong>
            <span>{t("library.bulkProgress", { done: activeLibraryOp.done + activeLibraryOp.failed, total: activeLibraryOp.total, failed: activeLibraryOp.failed })}</span></div>
          <span className="library-op-progress"><i style={{ width: `${Math.min(100, Math.round(operationProgress * 100))}%` }}/></span>
          {activeLibraryOp.pauseReason && activeLibraryOp.pauseReason !== "queue" && <small>{t(`library.bulkPaused.${activeLibraryOp.pauseReason}` as Key)}</small>}
          <button type="button" onClick={() => void api.cancelLibraryOp(activeLibraryOp.id).then(refreshLibraryOps).catch(fail)}>{t("common.cancel")}</button>
        </div>}
        {selectionMode && <div className="library-bulk-bar" role="toolbar" aria-label={t("library.bulkActions")}>
          <strong>{t("library.selectedCount", { count: selectedPaths.size })}</strong>
          <button disabled={!selectedPaths.size} onClick={() => openBulkDestination(false)}><FolderInput/> {t("library.move")}</button>
          <button disabled={!selectedPaths.size} onClick={() => openBulkDestination(true)}><Copy/> {t("library.copy")}</button>
          <button disabled={!selectedPaths.size} onClick={() => void startBulk({ op: "favorite", items: [...selectedPaths], favorite: true })}><Star/> {t("favorite.add")}</button>
          <button disabled={!selectedPaths.size} onClick={() => void startBulk({ op: "favorite", items: [...selectedPaths], favorite: false })}><Star/> {t("favorite.remove")}</button>
          <button disabled={!selectedPaths.size} onClick={() => setBulkIdentifyPaths([...selectedPaths])}><Sparkles/> {t("library.identify")}</button>
          <button disabled={!selectedPaths.size} onClick={() => void startBulk({ op: "unmatch", items: [...selectedPaths] })}><X/> {t("library.unmatch")}</button>
          <button disabled={!selectedPaths.size} onClick={() => void startBulk({ op: "skipLookup", items: [...selectedPaths], skipLookup: true })}><SearchX/> {t("library.skipLookup")}</button>
          <button disabled={!selectedPaths.size} onClick={() => void startBulk({ op: "skipLookup", items: [...selectedPaths], skipLookup: false })}><Search/> {t("library.allowLookup")}</button>
          <button disabled={!selectedPaths.size} onClick={() => void startBulk({ op: "mosaic", items: [...selectedPaths], mosaic: false })}><ImageOff/> {t("library.mosaicHide")}</button>
          <button disabled={!selectedPaths.size} onClick={() => void startBulk({ op: "mosaic", items: [...selectedPaths], mosaic: true })}><Images/> {t("library.mosaicShow")}</button>
          <button disabled={!selectedPaths.size} onClick={() => void startBulk({ op: "artwork", items: [...selectedPaths] })}><Images/> {t("library.regenerateArtwork")}</button>
          <button disabled={!selectedPaths.size} onClick={() => void startBulk({ op: "forget", items: [...selectedPaths] })}><RotateCcw/> {t("library.markUnwatched")}</button>
          <button className="danger" disabled={!selectedPaths.size} onClick={deleteBulk}><Trash2/> {t("common.delete")}</button>
          <button onClick={leaveSelection}><X/> {t("common.cancel")}</button>
        </div>}
        </div>
        <div className="browse-scroll" ref={browseScrollRef} onScroll={(event) => {
          if (!restoringScroll.current && !playerOpenRef.current) scrollByView.current.library = event.currentTarget.scrollTop;
          compactOnScroll(event, libraryCompact, setLibraryCompact, true);
          scheduleViewAnchor();
        }}>
        {!browsePath && !onlyFavorites && !browseQuery && <LibraryShelf
          segment={settings.libraryShelf}
          showResume={settings.showResumeRow}
          resume={localResume.slice(0, 8)}
          resumeTotal={resumePreview?.total ?? localResume.length}
          episodes={newEpisodes}
          follows={follows}
          favorites={favoritePreview}
          onSegment={(segment) => void chooseLibraryShelf(segment)}
          onPlayResume={(item) => { if (item.path) void playLocal(item.title, item.path, item.poster, item.season != null); }}
          onRevealResume={(path) => revealInLibrary(path)}
          onOpenEpisode={(episode) => void openFromCatalog({ type: episode.type, id: episode.metaId, name: episode.name, poster: episode.poster })}
          onOpenFavorite={(item) => { if (item.kind === "folder") { setBrowseQuery(""); setFromFavorites(true); setBrowsePath(item.path); } else void playLocal(item.label, item.path, item.poster); }}
          onShowResume={() => { setBrowseQuery(""); setOnlyFavorites(false); setFromFavorites(false); setMenuFor(null); setBrowsePath(":resume"); }}
          onShowEpisodes={() => openView("following")}
          onShowFavorites={() => { setBrowseQuery(""); setFromFavorites(false); setBrowsePath(":favorites"); }}
        />}
        {!browsePath && !scanHintDismissed && !libraryScan?.finishedAt && (browse?.total ?? 0) >= 10 && <div className="library-scan-hint" role="status">
          <span>{t("library.scanHint")}</span>
          <button type="button" onClick={dismissScanHint}>{t("library.dismissHint")}</button>
        </div>}
        {suggestionCount > 0 && !scanning && <div className="library-scan-hint" role="status">
          <span>{t("library.suggestionsWaiting", { count: suggestionCount })}</span>
          <button type="button" onClick={() => setSuggestionsOpen(true)}>{t("library.suggestionsReview")}</button>
        </div>}
        {!browse || !browse.items.length
          ? (browseBusy ? <div className="loading">{t("common.loading")}</div>
            : <Empty icon={<HardDrive/>} title={t(browseQuery ? "library.emptyFilterTitle" : onlyUnconfirmed ? "library.emptyUnconfirmedTitle" : browsePath === ":resume" ? "library.emptyResumeTitle" : browsePath === ":favorites" || onlyFavorites ? "library.emptyFavoritesTitle" : "library.emptyTitle")} text={t(browseQuery ? "library.emptyFilterText" : onlyUnconfirmed ? "library.emptyUnconfirmedText" : browsePath === ":resume" ? "library.emptyResumeText" : browsePath === ":favorites" || onlyFavorites ? "library.emptyFavoritesText" : "library.emptyText")}/>)
          : <>
            <div className={browseView === "grid" ? "browse-grid" : "browse-rows"}>
              {browse.items.map((item) => item.kind === "library"
                ? <article className={`browse-item library${item.unreachable ? " unreachable" : ""}`} key={item.path} data-path={item.path}>
                    <button className="library-open" disabled={!item.enabled} onClick={() => { setBrowseQuery(""); setFromFavorites(false); setMenuFor(null); setBrowsePath(item.path); }}>
                      <span className="browse-art">{(item.posters?.length ?? 0) > 1
                        ? <span className="library-preview-collage" aria-hidden="true">{item.posters?.map((poster) => <img key={poster} src={poster} alt="" loading="lazy" onError={hideBroken}/>)}</span>
                        : item.posters?.[0] || item.poster ? <img src={item.posters?.[0] ?? item.poster} alt="" loading="lazy" onError={hideBroken}/> : <HardDrive/>}<i className="browse-badge">{item.fileCount}</i></span>
                      <span className="library-copy"><strong>{item.name}</strong><small>{libraryMeta(item)}</small></span>
                      <span className="library-action">{item.enabled ? <><FolderOpen/> {t("library.openFolder")} <ChevronRight/></> : t("library.disabled")}</span>
                    </button>
                  </article>
                : item.kind === "folder"
                ? <article className={`browse-item folder${browseFocus === item.path ? " focused" : ""}${selectedPaths.has(item.path) ? " selected" : ""}`} key={item.path} data-path={item.path} aria-current={browseFocus === item.path ? "true" : undefined}><button className="library-open" onClick={() => { if (selectionMode) { toggleSelection(item.path); return; } setBrowseQuery(""); setFromFavorites(browsePath === ":favorites" || fromFavorites); setBrowsePath(item.path); }}>
                    <span className="browse-art">{(item.posters?.length ?? 0) > 1
                      ? <PosterMosaic posters={item.posters ?? []} label={t("library.mosaicAlt", { count: item.posters?.length ?? 0 })}/>
                      : <TileArt shape={settings.libraryTileShape} poster={item.poster} wide={item.wide} fallback={<FolderOpen/>}/>}<i className="browse-badge">{item.fileCount}</i>{item.favorite && <i className="fav-mark"><Star/></i>}</span>
                    <span className="library-copy"><strong>{item.name}</strong><small>{folderMeta(item)}</small>{descriptionLine(item) && <small className="library-desc" title={descriptionLine(item)}>{descriptionLine(item)}</small>}</span><span className="library-action"><FolderOpen/> {t("library.openFolder")} <ChevronRight/></span></button>
                    {selectionMode && <button className="browse-select" aria-label={t("library.selectItem", { name: item.name })} aria-pressed={selectedPaths.has(item.path)} onClick={(event) => { event.stopPropagation(); toggleSelection(item.path); }}>{selectedPaths.has(item.path) && <Check/>}</button>}
                    {!selectionMode && (item.gallery ?? 0) > 0 && <button className="browse-gallery" aria-label={t("gallery.openStored", { name: item.name })} title={t("gallery.openStored", { name: item.name })} onClick={(event) => { event.stopPropagation(); void openStoredGallery(item.path); }}><Images/></button>}
                    {!selectionMode && <button className="browse-menu" aria-label={t("library.options", { name: item.name })} aria-expanded={menuFor === item.path} onClick={(event) => { event.stopPropagation(); openMenu(item); }}><MoreVertical/></button>}
                    {!selectionMode && menuFor === item.path && <span className="browse-actions" onClick={(event) => event.stopPropagation()}>
                      {item.match === "matched" && titleChips(libraryTrailers[item.path] ?? null, libraryLinks[item.path] ?? [])}
                      {admin && matchActions(item)}
                      <button onClick={() => void toggleFavorite(item.path, !item.favorite)}><Star/> {t(item.favorite ? "favorite.remove" : "favorite.add")}</button>
                      {admin && <>
                        <button onClick={() => void renameItem(item.path, item.name)}><Pencil/> {t("library.rename")}</button>
                        <button onClick={() => openMove(item.path, item.name, item.titleType)}><FolderInput/> {t("library.move")}</button>
                        <button className="danger" onClick={() => void removeItem(item.path, item.name, true)}><Trash2/> {t("common.delete")}</button>
                      </>}
                    </span>}
                  </article>
                : <article className={`browse-item${browseFocus === item.path ? " focused" : ""}${selectedPaths.has(item.path) ? " selected" : ""}`} key={item.path} data-path={item.path} aria-current={browseFocus === item.path ? "true" : undefined}><button className="library-open" onClick={() => selectionMode ? toggleSelection(item.path) : void playLocal(item.label, item.path, item.poster, item.season != null)}>
                    <span className="browse-art"><TileArt shape={settings.libraryTileShape} poster={item.poster} wide={item.wide} fallback={<Film/>}/>{item.favorite && <i className="fav-mark"><Star/></i>}
                    {browseFocus === item.path && <i className="browse-focus-mark">{t("library.thisFile")}</i>}
                    {item.progress && <i className="resume-bar"><i style={{ width: `${Math.min(100, Math.round(item.progress.position / (item.progress.duration || 1) * 100))}%` }}/></i>}</span>
                    <span className="library-copy"><strong>{item.season != null ? `${item.season}×${String(item.episode ?? 0).padStart(2, "0")} ${item.label}` : item.label}</strong>
                    <small>{fileMeta(item)}</small>{descriptionLine(item) && <small className="library-desc" title={descriptionLine(item)}>{descriptionLine(item)}</small>}</span><span className="library-action"><Play/> {t(item.progress ? "library.continue" : "player.play")}</span></button>
                    {selectionMode && <button className="browse-select" aria-label={t("library.selectItem", { name: item.label })} aria-pressed={selectedPaths.has(item.path)} onClick={(event) => { event.stopPropagation(); toggleSelection(item.path); }}>{selectedPaths.has(item.path) && <Check/>}</button>}
                    {!selectionMode && (item.gallery ?? 0) > 0 && <button className="browse-gallery" aria-label={t("gallery.openStored", { name: item.label })} title={t("gallery.openStored", { name: item.label })} onClick={(event) => { event.stopPropagation(); void openStoredGallery(item.path); }}><Images/></button>}
                    {!selectionMode && <button className="browse-menu" aria-label={t("library.options", { name: item.label })} aria-expanded={menuFor === item.path} onClick={(event) => { event.stopPropagation(); openMenu(item); }}><MoreVertical/></button>}
                    {!selectionMode && menuFor === item.path && <span className="browse-actions" onClick={(event) => event.stopPropagation()}>
                      {item.match === "matched" && titleChips(libraryTrailers[item.path] ?? null, libraryLinks[item.path] ?? [])}
                      {admin && matchActions(item)}
                      <button onClick={() => void toggleFavorite(item.path, !item.favorite)}><Star/> {t(item.favorite ? "favorite.remove" : "favorite.add")}</button>
                      {item.progress && <button onClick={() => revealInLibrary(item.path)}><HardDrive/> {t("library.showInLibrary")}</button>}
                      {item.progress && <button onClick={() => void forgetWatched(item.path)}><RotateCcw/> {t("library.markUnwatched")}</button>}
                      <button onClick={() => { setMenuFor(null); void downloadLibraryFile(item.path); }}><Download/> {t("library.downloadToDevice")}</button>
                      {admin && <>
                        <button onClick={() => void renameItem(item.path, item.label)}><Pencil/> {t("library.rename")}</button>
                        <button onClick={() => openMove(item.path, item.label, item.titleType)}><FolderInput/> {t("library.move")}</button>
                        <button className="danger" onClick={() => void removeItem(item.path, item.label, false)}><Trash2/> {t("common.delete")}</button>
                      </>}
                    </span>}
                  </article>)}
            </div>
            {browseBusy && <div className="loading">{t("common.loading")}</div>}
            {(() => {
              const nactenych = browse.items.length;
              return !browseBusy && nactenych < browse.total && <div className="load-more">
                <button onClick={() => void loadBrowse(browsePath, nactenych)}>{t("common.loadMore")} ({browse.total - nactenych})</button>
              </div>;
            })()}
          </>}
        </div>
        </div>
      </section>}
      {view === "addons" && <AddonManager addons={addons} libraries={libraries} restricted={restricted} admin={admin} onChanged={refresh} onNotify={notify} onError={fail}/>} 
      {view === "downloads" && <Downloads jobs={downloads} deviceTransfers={deviceTransfers} libraries={libraries} halt={queueHalt} admin={session!.role === "admin"} refresh={loadDownloads} onError={fail} onReveal={revealInLibrary} prefs={views.downloads} onPrefs={persistDownloadPrefs}/>}
      {view === "stats" && <StatsPanel key={statsReset} onError={fail}/>}
      {view === "following" && <FollowingPage canRetain={session!.role === "admin"} follows={follows} newEpisodes={newEpisodes} languages={languages} libraries={libraries} addons={addons} audioLanguage={settings.audioLanguage} subtitleLanguage={settings.subtitleLanguage} onChanged={applyFollowChange} onOpenSeries={(item) => void openFromCatalog(item)} onNotify={notify}/>}
      {view === "settings" && <SettingsPage build={buildInfo} restricted={restricted} settings={settings} search={searchState} onSearch={(next) => { if (!next.saveHistory || !next.recent.length) recordIntent.current = null; setSearchState(next); }} languages={languages} libraries={libraries} session={session!} onSession={setSession} onSave={saveSettings} onLibrariesChanged={refreshLibraries} onImported={async (backup) => {
        const restored = await api.importSettings(backup);
        setSettings(restored.settings);
        setSelectedCatalog("");
        // Rules that named a library of the machine the backup came from are pointed at this
        // instance's own, or at the default; say how many had to move.
        if (restored.remapped) notify(t("settings.importRemapped", { count: restored.remapped }));
        await refresh(true);
      }} onNotify={notify} onError={fail}/>}
    </main>
    <TrailerPlayer trailer={trailerOpen} onClose={() => setTrailerOpen(null)}/>
    <Player nextTitle={localStream ? nextFile?.title : nextCatalogEpisode ? episodeLabel(nextCatalogEpisode) : undefined} nextBusy={nextBusy} onNext={localStream ? nextFile ? () => playAdjacent(nextFile) : undefined : nextCatalogEpisode ? playNextCatalogEpisode : undefined} autoNext={localStream ? localEpisode : Boolean(nextCatalogEpisode)} previousTitle={previousFile?.title} onPrevious={previousFile ? () => playAdjacent(previousFile) : undefined} open={playerOpen} title={localStream ? localTitle : videoTitle} stream={localStream ?? selectedStream} subtitles={localStream ? [] : subtitles} subtitleLanguage={settings.subtitleLanguage} audioLanguage={settings.audioLanguage} onPreferences={setPlaybackPreferences}
      progressKey={localStream?.localPath ? `file:${localStream.localPath}` : (videoId ? `${selected?.type ?? "movie"}:${videoId}` : undefined)}
      progressPoster={localStream ? localPoster : selected?.poster}
      progressAddonKey={localStream ? undefined : currentCatalog?.addonKey}
      favorite={localStream?.localPath ? libraryFavorites.includes(localStream.localPath) : inWatchlist(selected?.type, selected?.id)}
      onToggleFavorite={localStream?.localPath || selected ? () => void togglePlayerFavorite() : undefined}
      onDownload={enqueue}
      onDeviceDownload={() => localStream?.localPath ? downloadLibraryFile(localStream.localPath) : downloadStreamToDevice()}
      onClose={() => { setPlayerOpen(false); setLocalStream(null); setLocalEpisode(false); setPlaybackPreferences({}); }}/>
    {libraryManagerOpen && <LibraryManagerDialog restricted={restricted || !admin} onClose={() => setLibraryManagerOpen(false)} onChanged={refreshLibraries} onError={fail} onNotify={notify}/>}
    {movePath && <MoveDialog path={movePath.path} paths={movePath.paths} copy={movePath.copy} label={movePath.label}
      itemType={movePath.type} libraries={libraries} onClose={() => setMovePath(null)}
      onQueued={(id) => { leaveSelection(); void trackQueuedOp(id); }}/>}
    {saveTargetOpen && selectedStream && <SaveTargetDialog
      label={videoTitle} kind={selectedMedia().kind === "episode" ? "series" : "movie"} title={baseDownloadTitle}
      season={selectedVideo?.season} libraries={libraries}
      rule={addons.find((addon) => addon.key === selectedStream.addonKey)?.downloadSettings}
      onClose={() => setSaveTargetOpen(false)} onSubmit={enqueue}/>}
    {identifyPath && <IdentifyDialog path={identifyPath} onClose={() => setIdentifyPath(null)}
      onApplied={() => { setIdentifyPath(null); void loadSuggestionCount(); void loadBrowse(browsePath); }}/>}
    {bulkIdentifyPaths?.length && <IdentifyDialog path={bulkIdentifyPaths[0]!} paths={bulkIdentifyPaths}
      onClose={() => setBulkIdentifyPaths(null)} onApplied={(id) => { setBulkIdentifyPaths(null); leaveSelection(); if (id) void trackQueuedOp(id); }}/>}
    {suggestionsOpen && <SuggestionsDialog
      {...(currentLibraryId ? { libraryId: currentLibraryId } : {})}
      identifyPath={identifyFrom}
      appliedKey={appliedSuggestion}
      onClose={() => { setSuggestionsOpen(false); setIdentifyFrom(null); setAppliedSuggestion(null); }}
      onChanged={() => { void loadSuggestionCount(); void loadBrowse(browsePath); }}
      onIdentify={setIdentifyFrom}/>}
    {identifyFrom && <IdentifyDialog path={identifyFrom}
      onClose={() => setIdentifyFrom(null)}
      onApplied={() => { setAppliedSuggestion(identifyFrom); setIdentifyFrom(null); void loadBrowse(browsePath); }}/>}
    {bulkDownload && <SeriesDownloadDialog type={bulkDownload.type} label={bulkDownload.label} title={bulkDownload.title} episodes={bulkDownload.episodes} audioLanguage={settings.audioLanguage} subtitleLanguage={settings.subtitleLanguage} languages={languages} libraries={libraries} addons={addons} canRetain={session!.role === "admin"} onClose={() => setBulkDownload(null)} onSubmit={submitBulkDownload}/>}
    {followDialogOpen && detailFollow && <FollowDialog follow={detailFollow} videos={selected?.videos} languages={languages} libraries={libraries} addons={addons} audioLanguage={settings.audioLanguage} subtitleLanguage={settings.subtitleLanguage} canRetain={session!.role === "admin"} onChanged={(updated) => applyFollowChange(detailFollow.id, updated)} onClose={() => setFollowDialogOpen(false)} onNotify={notify}/>}
    {followStart && <SeriesDownloadDialog type={followStart.type || "series"} label={followStart.name} title={followStart.name} episodes={followStart.type === "movie" ? [{ id: followStart.id }] : toEpisodes(followStart.videos)} audioLanguage={settings.audioLanguage} subtitleLanguage={settings.subtitleLanguage} languages={languages} libraries={libraries} addons={addons}
      canRetain={session!.role === "admin"}
      follow={{ create: { metaId: followStart.id, name: followStart.name, poster: followStart.poster }, onFollowed: (follow) => followed(followStart, follow) }} onClose={() => setFollowStart(null)}/>}
    {galleryIndex !== null && shownGallery[galleryIndex] && <MediaGallery images={shownGallery} index={galleryIndex} onIndex={setGalleryIndex} onClose={closeGallery}/>}
    {(message || error) && <div className={`toast ${error ? "error" : ""}`}>{error || message}<button onClick={() => {setError("");setMessage("");}}><X/></button></div>}
  </div>;
}
