import { FormEvent, UIEvent, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, BarChart3, ArrowUp, Check, Copy, FolderInput, FolderOpen, ImageOff, Images, KeyRound, Languages, LayoutGrid, List, MoreVertical, PanelLeftClose, PanelLeftOpen, Pencil, RotateCcw, ShieldCheck, Sparkles, Star, FileJson, Link2, LogOut, ChevronDown, ChevronLeft, ChevronRight, CirclePlay, Download, FileText, Film, FolderCog, HardDrive, Library, PackagePlus, Pause, Play, Plus, RefreshCw, Search, SearchX, Settings, Subtitles, Trash2, Upload, X } from "lucide-react";
import { queueDestination } from "./queue-target";
import { api, ApiError, describeError, logDownloadUrl, saveToDevice } from "./api";
import { AccountSettings, LoginScreen } from "./Login";
import { bytes, SettingControl, SettingsSectionHead } from "./settings-ui";
import { LOCALES, LOCALE_NAMES } from "./i18n";
import { Player } from "./Player";
import { IdentifyDialog } from "./IdentifyDialog";
import { LibraryManager, LibraryManagerDialog, libraryTypeLabel } from "./LibraryManager";
import { MoveDialog } from "./MoveDialog";
import { SuggestionsDialog } from "./SuggestionsDialog";
import { SeriesDownloadDialog } from "./SeriesDownloadDialog";
import { StatsPanel } from "./Stats";
import { copyText } from "./clipboard";
import { report } from "./diagnostics";
import { groupLog, parseLog, type LogGroup, type LogLine } from "./log-groups";
import { label, titleLanguage } from "./languages";
import { languageName, locale, localeTag, serverText, setLocale, t, useI18n, type Key, type Locale } from "./i18n";
import { canQueue, pickDefaultStream, pickNextEpisodeStream, repickStream, streamBadge, streamLanguages, streamSize, visibleCatalogStreams, type StreamSort } from "./streams";
import { parseSearchScope } from "./search-scope";
import { localizedDownloadTitle, mergeMetaDetail } from "./meta";
import type { Addon, BuildInfo, Diagnostics, BrowseItem, BrowseLibrary, BrowseResult, LibraryOp, LibraryOpsState, LibrarySort, LibraryView, ProgressEntry, WatchlistEntry, AddonDownloadSettings, Catalog, Download as DownloadJob, DownloadSelection, Inspection, Meta, QueueHalt, ScanState, SearchableCatalog, Session, Settings as AppSettings, SettingsPatch, SiteLink, Stream, Subtitle, Video } from "./types";

/** The names of the linked sites. They are trademarks, not interface text, so they are
 *  spelled the same in every language and live here rather than in the catalogues. */
const SITE_LINKS: Record<SiteLink["site"], string> = { csfd: "ČSFD", tmdb: "TMDB", imdb: "IMDb" };

/** Library browsing choices survive both a section switch and a browser restart.
 * Private mode may forbid storage, hence the try/catch around everything. */
const remember = (key: string, value: string) => { try { localStorage.setItem(`library-${key}`, value); } catch { /* storage may be unavailable */ } };
const recall = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
  try { const value = localStorage.getItem(`library-${key}`); return allowed.includes(value as T) ? value as T : fallback; }
  catch { return fallback; }
};

type View = "catalog" | "library" | "downloads" | "stats" | "addons" | "settings";
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
const speed = (value: number) => value ? `${bytes(value)}/s` : "—";
const streamLabel = (item: Stream) => item.name || item.title?.split("\n")[0] || item.description?.split("\n")[0] || "Stream";
type GalleryImage = { url: string; label: string; shape: "poster" | "wide" };

/** Artwork comes through the server; when a provider does not deliver, leave the
 *  placeholder underneath rather than a broken image icon. */
const hideBroken = (event: React.SyntheticEvent<HTMLImageElement>) => event.currentTarget.classList.add("broken");
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
const galleryFor = (item: Meta | null): GalleryImage[] => {
  if (!item) return [];
  const images: GalleryImage[] = [];
  const seen = new Set<string>();
  const add = (value: unknown, label: string, shape: GalleryImage["shape"]) => {
    if (typeof value !== "string" || !value.trim() || seen.has(value)) return;
    seen.add(value); images.push({ url: value, label, shape });
  };
  add(item.poster, t("gallery.poster"), "poster");
  add(item.background, t("gallery.background"), "wide");
  add(item.logo, t("gallery.logo"), "wide");
  for (const key of ["images", "screenshots"]) {
    const values = item[key];
    if (!Array.isArray(values)) continue;
    for (const [index, value] of values.entries()) {
      const candidate = typeof value === "object" && value ? value as Record<string, unknown> : undefined;
      add(typeof value === "string" ? value : candidate?.url ?? candidate?.src, t("gallery.still", { index: index + 1 }), "wide");
    }
  }
  for (const video of item.videos ?? []) add(video.thumbnail, video.title || video.name || t("gallery.episodeStill"), "wide");
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
  const restoringScroll = useRef(false);
  const viewRef = useRef<View>("catalog");
  const [galleryIndex, setGalleryIndex] = useState<number | null>(null);
  const [detailCompact, setDetailCompact] = useState(false);
  const [catalogCompact, setCatalogCompact] = useState(false);
  const scrollDirection = useRef(new WeakMap<HTMLElement, { top: number; travel: number; until: number }>());
  function compactOnScroll(event: UIEvent<HTMLDivElement>, compact: boolean, update: (value: boolean) => void) {
    if (playerOpenRef.current || restoringScroll.current) return;
    const element = event.currentTarget;
    const top = Math.max(0, element.scrollTop);
    const previous = scrollDirection.current.get(element) ?? { top: 0, travel: 0, until: 0 };
    const delta = top - previous.top;
    const travel = Math.sign(delta) === Math.sign(previous.travel) ? previous.travel + delta : delta;
    const now = performance.now();
    const next = top <= 0 ? false : travel > 32 ? true : travel < -24 ? false : compact;
    const header = element.closest(".detail-panel")?.querySelector(".hero");
    const headerHeight = header?.getBoundingClientRect().height ?? 200;
    // Keep the list scrollable after hiding its header, so reversing direction still restores it.
    const canHide = element.scrollHeight - element.clientHeight > headerHeight + 32;
    const changed = now >= previous.until && next !== compact && (!next || canHide);
    scrollDirection.current.set(element, { top, travel: changed ? 0 : travel, until: changed ? now + 250 : previous.until });
    if (changed) update(next);
  }
  type TreeItem = Extract<BrowseItem, { kind: "folder" | "file" }>;
  const [selectedCatalog, setSelectedCatalog] = useState(""); const [search, setSearch] = useState(""); const [items, setItems] = useState<Meta[]>([]); const [selected, setSelected] = useState<Meta | null>(null); const [selectedDownloadTitle, setSelectedDownloadTitle] = useState("");
  const [selectedVideo, setSelectedVideo] = useState<Video | null>(null); const [streams, setStreams] = useState<Stream[]>([]); const [selectedStream, setSelectedStream] = useState<Stream | null>(null); const [subtitles, setSubtitles] = useState<Subtitle[]>([]); const [localEpisode, setLocalEpisode] = useState(false); const [playbackPreferences, setPlaybackPreferences] = useState<{ audioLanguage?: string; subtitleLanguage?: string | null }>({});
  const nextEpisodePrefetchRef = useRef<{ id: string; promise: Promise<{ streams: Stream[]; subtitles: Subtitle[] }> } | null>(null);
  const [sourcesLoaded, setSourcesLoaded] = useState(false); const [metaLoading, setMetaLoading] = useState(false);
  const [titleLinks, setTitleLinks] = useState<SiteLink[]>([]);
  const [libraryLinks, setLibraryLinks] = useState<Record<string, SiteLink[]>>({});
  const [episodesOpen, setEpisodesOpen] = useState(true);
  const [season, setSeason] = useState<number | null>(null);
  const [bulkDownload, setBulkDownload] = useState<{ label: string; title: string; type: string; episodes: Array<{ id: string; season?: number; episode?: number; title?: string }>; media: { id?: string; metaType?: string; poster?: string } } | null>(null);
  const [downloads, setDownloads] = useState<DownloadJob[]>([]); const [queueHalt, setQueueHalt] = useState<QueueHalt | null>(null); const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [error, setError] = useState(""); const [playerOpen, setPlayerOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>({ concurrentDownloads: 1, parallelPerProvider: 1, downloadSegments: 2, uiLanguage: locale(), audioLanguage: "en", subtitleLanguage: "en", downloadTitleLanguage: "ui", mergeByName: true, streamSort: "recommended", trackProgress: true, showResumeRow: true, libraryAutoScan: true, libraryScanPauseOnDownload: false, secureMode: true, addonRefreshHours: 24, catalogTileSize: "medium", libraryTileSize: "medium", realDebridConfigured: false, tmdbConfigured: false });
  const [languages, setLanguages] = useState<Array<{ code: string; name: string }>>([]);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [resumePreview, setResumePreview] = useState<BrowseResult | null>(null);
  const [favoritePreview, setFavoritePreview] = useState<BrowseResult | null>(null);
  const [browse, setBrowse] = useState<BrowseResult | null>(null);
  const [libraries, setLibraries] = useState<LibraryView[]>([]);
  const refreshLibraries = () => api.libraries().then(setLibraries).catch(() => undefined);
  const [browsePath, setBrowsePath] = useState(""); const [browseQuery, setBrowseQuery] = useState("");
  const [browseSort, setBrowseSort] = useState<LibrarySort>(() => recall("sort", ["name", "added", "size", "random"] as const, "name") as LibrarySort);
  const [browseDesc, setBrowseDesc] = useState(() => recall("order", ["asc", "desc"] as const, "asc") === "desc");
  const [browseView, setBrowseView] = useState<"grid" | "list">(() => recall("view", ["grid", "list"] as const, "grid"));
  const [browseBusy, setBrowseBusy] = useState(false);
  const [identifyPath, setIdentifyPath] = useState<string | null>(null);
  const [movePath, setMovePath] = useState<{ path: string; label: string; type?: "movie" | "series"; paths?: string[]; copy?: boolean } | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [libraryOps, setLibraryOps] = useState<LibraryOpsState[]>([]);
  const [bulkIdentifyPaths, setBulkIdentifyPaths] = useState<string[] | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
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
  const [onlyFavorites, setOnlyFavorites] = useState(() => recall("favorites", ["0", "1"] as const, "0") === "1");
  browseLocation.current = JSON.stringify([browsePath, browseQuery, browseSort, browseDesc, onlyFavorites]);
  // Preserve the favorites breadcrumb when entering a folder from favorites.
  const [fromFavorites, setFromFavorites] = useState(false);
  const [resume, setResume] = useState<ProgressEntry[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);
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
      await Promise.all([loadBrowse(browsePath), api.progressList().then(setResume), api.watchlist().then(setWatchlist)]);
      notify(job.failed
        ? t("library.bulkFinishedFailed", { failed: job.failed, total: job.total })
        : t("library.bulkFinished"));
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
    // Deleting a file also drops its resume position and its catalogue star, so both
    // lists are reloaded -- otherwise the deleted title would hang around in the rows.
    try {
      await api.deleteLibraryItem(itemPath);
      notify(t("library.deleted"));
      await loadBrowse(browsePath);
      const [nextResume, nextWatchlist] = await Promise.all([api.progressList(), api.watchlist()]);
      setResume(nextResume); setWatchlist(nextWatchlist);
    } catch (error) { fail(error); }
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
  /** Follows the item into its new folder: seeing where it landed beats staring at the
   *  gap it left behind. The resume row and the star carry the old path, so both reload. */
  const finishMove = async (target: string) => {
    setMovePath(null);
    notify(t("library.moved"));
    revealInLibrary(target);
    try {
      const [nextResume, nextWatchlist] = await Promise.all([api.progressList(), api.watchlist()]);
      setResume(nextResume); setWatchlist(nextWatchlist);
    } catch (error) { fail(error); }
  };
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
  const startScan = async (options: { force?: boolean } = {}) => {
    try {
      scanWanted.current = true;
      const state = await api.startLibraryScan(options);
      scanStatus.current = state.status;
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
  /** A menu is asked about once per path per session; the answer is chrome either way. */
  const loadLibraryLinks = (item: TreeItem) => {
    if (item.match !== "matched" || askedLibraryLinks.current.has(item.path)) return;
    askedLibraryLinks.current.add(item.path);
    void api.libraryLinks(item.path, settings.uiLanguage)
      .then((answer) => setLibraryLinks((current) => ({ ...current, [item.path]: answer.links })))
      .catch(() => { /* a failure only leaves the menu without the row */ });
  };
  const openMenu = (item: TreeItem) => {
    const next = menuFor === item.path ? null : item.path;
    setMenuFor(next);
    if (next) loadLibraryLinks(item);
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
      ? t("library.suggestionLine", { name: item.suggestion.name, score: item.suggestion.score })
      : item.catalogName;
  const [localStream, setLocalStream] = useState<Stream | null>(null); const [localTitle, setLocalTitle] = useState("");
  const [streamAddon, setStreamAddon] = useState(""); const [streamLanguage, setStreamLanguage] = useState(""); const [streamSort, setStreamSort] = useState<StreamSort>("recommended");
  useEffect(() => { setStreamSort(settings.streamSort as StreamSort); }, [settings.streamSort]);
  const [submittedQuery, setSubmittedQuery] = useState(""); const [searchScopeValue, setSearchScopeValue] = useState(""); const [searchable, setSearchable] = useState<SearchableCatalog[]>([]); const [typeFilter, setTypeFilter] = useState(""); const [genre, setGenre] = useState(""); const [sort, setSort] = useState("default");
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
  const linksRequestRef = useRef(0); const askedLibraryLinks = useRef(new Set<string>());
  const loadingRef = useRef(false); const requestRef = useRef(0); const itemsRef = useRef<Meta[]>([]); const gridRef = useRef<HTMLDivElement>(null); const detailRef = useRef<HTMLElement>(null);
  const playerOpenRef = useRef(false); const playbackReturn = useRef<PlaybackReturn | null>(null);
  const viewAnchor = useRef<ViewAnchor | null>(null); const anchorFrozen = useRef(false); const anchorFrame = useRef(0);
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
  const galleryImages = useMemo(() => galleryFor(selected), [selected]);
  useEffect(() => { remember("sort", browseSort); remember("order", browseDesc ? "desc" : "asc"); }, [browseSort, browseDesc]);
  useEffect(() => { remember("view", browseView); }, [browseView]);
  useEffect(() => { remember("favorites", onlyFavorites ? "1" : "0"); }, [onlyFavorites]);
  const notify = (text: string) => { setMessage(text); setTimeout(() => setMessage(""), 3200); };
  const fail = (value: unknown) => {
    if (value instanceof ApiError && value.status === 401) { setSession(null); return; }
    setError(describeError(value)); setTimeout(() => setError(""), 6000);
  };

  const findPlaybackAnchor = ({ kind, key }: PlaybackAnchor) => {
    const attribute = kind === "catalog" ? "catalogKey" : "path";
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(kind === "catalog" ? "[data-catalog-key]" : "[data-path]"));
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return candidates.find((element) => element === active && element.dataset[attribute] === key)
      ?? candidates.find((element) => element.dataset[attribute] === key && element.getClientRects().length > 0)
      ?? candidates.find((element) => element.dataset[attribute] === key);
  };
  const capturePlaybackReturn = (anchor?: PlaybackAnchor): PlaybackReturn => {
    const element = anchor && findPlaybackAnchor(anchor);
    const grid = anchor?.kind === "catalog" ? gridRef.current : null;
    const viewportTop = grid?.getBoundingClientRect().top ?? 0;
    const viewportHeight = grid?.clientHeight || window.innerHeight;
    return {
      view,
      windowY: window.scrollY,
      gridY: grid?.scrollTop,
      catalogCompact,
      anchor: element && anchor ? { ...anchor, element, ratio: (element.getBoundingClientRect().top - viewportTop) / viewportHeight } : undefined,
    };
  };
  const openPlayer = (anchor?: PlaybackAnchor) => {
    playbackReturn.current = capturePlaybackReturn(anchor);
    scrollByView.current[view] = window.scrollY;
    playerOpenRef.current = true;
    pickedRef.current = true;
    setPlayerOpen(true);
  };

  // Where the two lists that survive a rotation keep their position: the catalogue scrolls
  // inside its own grid, the library scrolls with the document.
  const anchorScroller = () => viewRef.current === "catalog" ? gridRef.current : null;
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
      if (!restoringScroll.current && !playerOpenRef.current) scrollByView.current[viewRef.current] = window.scrollY;
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
  useEffect(() => {
    let size = `${window.innerWidth}x${window.innerHeight}`;
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
      scrollByView.current[viewRef.current] = window.scrollY;
    };
    const onResize = () => {
      const next = `${window.innerWidth}x${window.innerHeight}`;
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
      if (anchor?.kind === "catalog") {
        const grid = gridRef.current;
        if (grid && element) {
          const current = element.getBoundingClientRect().top - grid.getBoundingClientRect().top;
          grid.scrollTop += current - anchor.ratio * grid.clientHeight;
        } else if (grid && saved.gridY != null) grid.scrollTop = saved.gridY;
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
    setCatalogCompact(false);
    const firstCatalog = catalogs[0];
    scrollByView.current.catalog = 0;
    setView("catalog");
    setSearch(""); setSubmittedQuery(""); setSearchScopeValue(""); setTypeFilter(""); setGenre(""); setSort("default");
    setSelectedCatalog(firstCatalog ? `${firstCatalog.addonKey}:${firstCatalog.type}:${firstCatalog.id}` : "");
    setSelected(null); setSelectedVideo(null); setStreams([]); setSelectedStream(null); setSubtitles([]); setSourcesLoaded(false);
    setGalleryIndex(null);
    setStreamAddon(""); setStreamLanguage(""); setStreamSort(settings.streamSort as StreamSort);
    setEpisodesOpen(true); setSeason(null); setCatalogReset((value) => value + 1);
  };
  const resetLibrary = () => {
    setMenuFor(null); setFromFavorites(false); setBrowseFocus(null);
    setBrowsePath(""); setBrowseQuery("");
    setBrowseSort("name"); setBrowseDesc(false); setOnlyFavorites(false);
  };
  /** Clicking the section we are already in resets it; otherwise the last filters
   * and the page position are restored. */
  const openView = (target: View) => {
    if (target !== view) { setView(target); return; }
    scrollByView.current[target] = 0;
    if (target === "catalog") resetCatalog();
    else if (target === "library") resetLibrary();
    else if (target === "stats") setStatsReset((value) => value + 1);
    window.scrollTo(0, 0);
  };
  const toggleSidebar = () => setSidebarCollapsed((current) => {
    const next = !current;
    try { localStorage.setItem("sidebar-collapsed", next ? "1" : "0"); } catch { /* private mode may forbid storage */ }
    return next;
  });

  const refresh = async (selectFirst = false) => {
    const [nextAddons, nextCatalogs] = await Promise.all([api.addons(), api.catalogs()]); setAddons(nextAddons); setCatalogs(nextCatalogs);
    if ((selectFirst || !selectedCatalog) && nextCatalogs[0]) setSelectedCatalog(`${nextCatalogs[0].addonKey}:${nextCatalogs[0].type}:${nextCatalogs[0].id}`);
  };
  const downloadsSeen = useRef(false);
  const jobStatus = useRef(new Map<string, DownloadJob["status"]>());
  const applyDownloads = (snapshot: { jobs?: DownloadJob[]; halt?: QueueHalt | null } | DownloadJob[]) => {
    const jobs = Array.isArray(snapshot) ? snapshot : snapshot.jobs ?? [];
    if (downloadsSeen.current) {
      for (const job of jobs) {
        const previous = jobStatus.current.get(job.id);
        if (previous === "waiting" && job.status !== "waiting" && job.status !== "paused" && job.status !== "failed") {
          notify(t("downloads.debridReady", { title: job.title }));
        }
        if (previous && previous !== "completed" && job.status === "completed") {
          notify(t("downloads.inLibrary", { title: job.title }));
        }
      }
    }
    downloadsSeen.current = true;
    jobStatus.current = new Map(jobs.map((job) => [job.id, job.status]));
    setDownloads(jobs);
    setQueueHalt(Array.isArray(snapshot) ? null : snapshot.halt ?? null);
  };
  const loadDownloads = () => api.downloads().then(applyDownloads).catch(fail);
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);
  const restricted = buildInfo?.restricted === true;
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
  useEffect(() => { if (!ready) return; refresh().catch(fail); loadDownloads(); refreshLibraries(); api.settings().then((next) => { setSettings(next); setLocale(next.uiLanguage); }).catch(fail); api.languages().then(setLanguages).catch(() => undefined); }, [ready]);
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
  const saveSettings = async (patch: SettingsPatch) => {
    const { realDebridToken: _token, tmdbApiKey: _apiKey, ...rest } = patch;
    if (Object.keys(rest).length) setSettings((current: AppSettings) => ({ ...current, ...rest }));
    try { setSettings(await api.updateSettings(patch)); notify(t("settings.saved")); } catch (e) { fail(e); }
  };
  // An empty path with more than one library configured is the library list; a
  // single-library install still opens straight into the tree.
  const libraryList = browsePath === "" && libraries.length > 1;
  const loadBrowse = async (target = browsePath, skip = 0) => {
    const request = ++browseRequest.current;
    const wanted = JSON.stringify([target, browseQuery, browseSort, browseDesc, onlyFavorites]);
    setBrowseBusy(true);
    try {
      const options = { skip, limit: 60, sort: browseSort, order: browseDesc ? "desc" : "asc", seed: browseSeed.current };
      // Favorites include entries from the entire library tree.
      const page = target === ":resume"
        ? await api.resumeLibrary({ ...options, query: browseQuery, favorites: onlyFavorites })
        : target === ":favorites"
        ? await api.favorites(options)
        : await api.browse({ ...options, path: target, query: browseQuery, favorites: onlyFavorites });
      if (request !== browseRequest.current || wanted !== browseLocation.current) return;
      setBrowse((previous) => skip && previous ? { ...page, items: [...previous.items, ...page.items] } : page);
    } catch (error) { if (request === browseRequest.current && wanted === browseLocation.current) fail(error); }
    finally { if (request === browseRequest.current) setBrowseBusy(false); }
  };
  const refreshBrowse = async (limit: number) => {
    const location = JSON.stringify([browsePath, browseQuery, browseSort, browseDesc, onlyFavorites]);
    if (location !== browseLocation.current) return;
    const request = browseRequest.current;
    try {
      const options = { limit: Math.max(60, limit), sort: browseSort, order: browseDesc ? "desc" : "asc", seed: browseSeed.current };
      const page = browsePath === ":resume"
        ? await api.resumeLibrary({ ...options, query: browseQuery, favorites: onlyFavorites })
        : browsePath === ":favorites"
        ? await api.favorites(options)
        : await api.browse({ ...options, path: browsePath, query: browseQuery, favorites: onlyFavorites });
      if (location === browseLocation.current && request === browseRequest.current) setBrowse(page);
    } catch { /* Artwork refresh is optional. */ }
  };
  useEffect(() => { if (!ready) return; api.watchlist().then(setWatchlist).catch(() => undefined); }, [ready, view]);
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

  useEffect(() => { if (!ready || view !== "library") return; void loadBrowse(browsePath); },
    [ready, view, browsePath, browseQuery, browseSort, browseDesc, onlyFavorites, scanEpoch]);
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
    if (!ready || view !== "library") return;
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
    if (!operationsActive) return () => { cancelled = true; };
    const timer = window.setInterval(() => void tick(), 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [ready, view, operationsActive, browsePath]);
  useEffect(() => { if (ready && view === "library") void loadSuggestionCount(); }, [ready, view, scanEpoch]);
  // Page-scroll paging, the same as in the catalogue. The button stays as a fallback.
  useEffect(() => {
    if (view !== "library" || !browse) return;
    const nactenych = browse.items.length;
    if (nactenych >= browse.total) return;
    const onScroll = () => {
      if (browseBusy) return;
      if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 500) void loadBrowse(browsePath, nactenych);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
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
  useEffect(() => { artworkPolls.current = 0; }, [browsePath, browseQuery, browseSort, browseDesc, onlyFavorites, scanEpoch]);
  useEffect(() => {
    if (view !== "library" || !browse?.pending) return;
    const attempt = artworkPolls.current;
    if (attempt >= 8) return;
    // Only as many entries as are already loaded are refreshed, so the list does not scroll back.
    const nactenych = browse.items.length;
    const timer = setTimeout(() => { artworkPolls.current = attempt + 1; void refreshBrowse(nactenych); }, Math.min(8000, 1000 * 2 ** attempt));
    return () => clearTimeout(timer);
  }, [view, browse, browsePath, browseQuery, browseSort, browseDesc, onlyFavorites]);

  /** Jumping from the download queue: opens the folder the file sits in and finds it there.
   * The filters have to be cleared, or the wanted file would stay filtered out of the listing. */
  const revealInLibrary = (target: string) => {
    const slash = target.lastIndexOf("/");
    setMenuFor(null); setFromFavorites(false); setOnlyFavorites(false); setBrowseQuery("");
    setBrowsePath(slash > 0 ? target.slice(0, slash) : "");
    focusScrolled.current = null;
    setBrowseFocus(target);
    setView("library");
    window.scrollTo(0, 0);
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
    if (reset) { setBusy(true); setSelected(null); setStreams([]); } else setLoadingMore(true);
    try {
      if (submittedQuery) {
        const result = await api.search(submittedQuery, { ...searchScope, type: effectiveTypeFilter, cursor: reset ? "" : cursor });
        if (stale()) return;
        const next = reset ? result.items : merge(itemsRef.current, result.items);
        // An addon may keep returning the same thing; without this guard paging would never end.
        const gainedNothing = !reset && next.length === itemsRef.current.length;
        itemsRef.current = next; setItems(next);
        setSourceCount(result.sources); setCursor(result.cursor); setHasMore(result.hasMore && !gainedNothing);
      } else if (virtualCatalog) {
        // The content is derived, so there is nothing to load here.
        setHasMore(false);
      } else {
        const metas = await api.catalog(currentCatalog!, "", from, activeGenre);
        if (stale()) return;
        const next = reset ? metas : merge(itemsRef.current, metas);
        const gainedNothing = !reset && next.length === itemsRef.current.length;
        itemsRef.current = next; setItems(next);
        setSkip(from + metas.length); setHasMore(metas.length > 0 && !gainedNothing);
      }
    } catch (e) { if (!stale()) { fail(e); setHasMore(false); } }
    finally { if (!stale()) { loadingRef.current = false; setBusy(false); setLoadingMore(false); } }
  };

  const submitSearch = (event?: FormEvent) => { event?.preventDefault(); setSubmittedQuery(search.trim()); };
  // A changed catalogue, query or filter starts from the first page. The scope only
  // decides what a search asks for, so on its own it reloads nothing.
  useEffect(() => { itemsRef.current = []; setItems([]); setSkip(0); setCursor(""); setHasMore(false); setSourceCount(0); void loadPage(true); },
    [submittedQuery, submittedQuery && searchScopeValue, typeFilter, activeGenre, virtualCatalog, currentCatalog?.addonKey, currentCatalog?.type, currentCatalog?.id, catalogReset]);

  // The grid scrolls on its own. A plain scroll listener works even where
  // IntersectionObserver stays quiet (a hidden document, power-saving modes).
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || !hasMore) return;
    const onScroll = () => { if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 400) void loadPage(false); };
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
  const listedStreams = useMemo(
    () => settings.realDebridConfigured ? streams : streams.filter((stream) => stream.kind !== "torrent"),
    [streams, settings.realDebridConfigured]);
  const hiddenTorrents = listedStreams.length < streams.length;
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

  /** The built-in lists are computed from memory; they must not go through a full load,
   *  which would drop the selected title. */
  const virtualItems = useMemo<Meta[]>(() => {
    if (virtualCatalog === VIRTUAL.watchlist) return watchlist.map((item) => ({ id: item.id, type: item.type, name: item.name, poster: item.poster }));
    if (virtualCatalog === VIRTUAL.resume) return resume.filter((item) => !item.key.startsWith("file:")).map((item) => {
      const [type, ...rest] = item.key.split(":");
      return { id: rest.join(":"), type, name: item.title, poster: item.poster };
    });
    return [];
  }, [virtualCatalog, watchlist, resume]);
  useEffect(() => {
    if (!virtualCatalog) return;
    itemsRef.current = virtualItems; setItems(virtualItems); setHasMore(false);
  }, [virtualCatalog, virtualItems]);

  // The library preview includes existing local files; catalog progress stays separate.
  const localResume = useMemo(() => resumePreview
    ? resumePreview.items.flatMap((item) => item.kind === "file" && item.progress ? [{ key: `file:${item.path}`, path: item.path, title: item.label, poster: item.poster, season: item.season, updatedAt: item.modified, ...item.progress }] : [])
    : resume.filter((item) => item.key.startsWith("file:") && item.path).map((item) => ({ ...item, season: undefined })), [resumePreview, resume]);
  const catalogProgress = (item: Meta) => resume.find((entry) => entry.key === `${item.type || "movie"}:${item.id}`);
  const forgetCatalogWatched = async (item: Meta) => {
    setMenuFor(null);
    try { await api.forgetProgress(`${item.type || "movie"}:${item.id}`); setResume(await api.progressList()); }
    catch (error) { fail(error); }
  };

  const visibleItems = useMemo(() => {
    const year = (item: Meta) => Number(String(item.releaseInfo ?? item.year ?? "").slice(0, 4)) || 0;
    // The built-in lists carry their own meaningful order: last watched first, last added
    // to the list. General sorting would only break it.
    if (virtualCatalog) return items;
    const list = settings.mergeByName ? groupByName(items) : [...items];
    if (sort === "name") list.sort((a, b) => a.name.localeCompare(b.name, localeTag()));
    else if (sort === "year") list.sort((a, b) => year(b) - year(a));
    return list;
  }, [items, sort, settings.mergeByName, virtualCatalog]);
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
  const openMeta = async (item: Meta) => {
    const request = ++sourcesRequestRef.current;
    const linksRequest = ++linksRequestRef.current;
    setMetaLoading(true);
    setSelected(item); setSelectedDownloadTitle(item.name); setSelectedVideo(null); setEpisodesOpen(true); setSeason(null); setStreams([]); setSelectedStream(null); setSubtitles([]); setSourcesLoaded(false); setGalleryIndex(null); setDetailCompact(false); setTitleLinks([]);
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
    // The sources fetch moves the same token, so an abandoned open must not start one.
    if (request === sourcesRequestRef.current && type !== "series" && !detail.videos?.length) await fetchSources(type, item.id);
  };
  const closeMeta = () => {
    sourcesRequestRef.current += 1;
    linksRequestRef.current += 1;
    setSelected(null); setSelectedDownloadTitle(""); setSelectedVideo(null); setStreams([]); setSelectedStream(null); setSubtitles([]); setSourcesLoaded(false); setGalleryIndex(null); setDetailCompact(false); setTitleLinks([]);
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
      const { streams: nextStreams, subtitles: nextSubtitles } = prefetched?.id === id
        ? await prefetched.promise.catch(() => fetchEpisodeSources(type, id))
        : await fetchEpisodeSources(type, id);
      if (stale()) return false;
      setSubtitles(nextSubtitles);
      const currentLanguage = playbackPreferences.audioLanguage ?? (currentStream ? streamLanguages(currentStream, metaLanguage)[0] : undefined);
      const nextStream = pickNextEpisodeStream(nextStreams, currentStream, currentLanguage ?? settings.audioLanguage, addonPriority, metaLanguage) ?? null;
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
  const selectedMedia = () => selectedVideo
    ? { kind: "episode", title: baseDownloadTitle, season: selectedVideo.season, episode: selectedVideo.episode, episodeTitle: selectedVideo.title || selectedVideo.name, id: selected?.id, metaType: selected?.type, poster: selected?.poster }
    : { kind: "movie", title: baseDownloadTitle, id: selected?.id, metaType: selected?.type, poster: selected?.poster };
  const canPlay = Boolean(selectedStream?.playable);
  const enqueue = async () => {
    if (!selectedStream || !canQueue(selectedStream, settings.realDebridConfigured)) return false;
    // The server builds the path from this; without it an episode would end up a flat file.
    const media = selectedMedia();
    try {
      const job = await api.download(videoTitle, selectedStream, media);
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
      media: { id: selected.id, metaType, poster: selected.poster },
    });
  };

  const submitBulkDownload = async (selection: DownloadSelection) => {
    if (!bulkDownload) return;
    const result = await api.downloadBulk(bulkDownload.title, bulkDownload.type, bulkDownload.episodes, selection, bulkDownload.media);
    notify(t("episodes.bulkAdded", { count: result.added }) + (result.skipped ? ` ${t("episodes.bulkSkipped", { count: result.skipped })}` : ""));
    await loadDownloads();
  };

  const activeLibraryOp = libraryOps.find((job) => job.status === "running" || job.status === "paused");
  const operationProgress = activeLibraryOp
    ? activeLibraryOp.bytesTotal > 0 ? activeLibraryOp.bytes / activeLibraryOp.bytesTotal : (activeLibraryOp.done + activeLibraryOp.failed) / Math.max(1, activeLibraryOp.total)
    : 0;

  if (session === undefined) return <div className="login-screen"><div className="loading">{t("common.loading")}</div></div>;
  if (!ready) return <LoginScreen setup={setupNeeded} onSession={(next) => { setSetupNeeded(false); setSession(next); }}/>;

  return <div className={`app-shell catalog-tiles-${settings.catalogTileSize} library-tiles-${settings.libraryTileSize}${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
    <header className="topbar"><button className="brand brand-home" title={t("app.goToCleanCatalog")} aria-label={t("app.goToCleanCatalog")} onClick={resetCatalog}><div className="brand-mark"><CirclePlay/></div><div><small>{t("auth.brandEyebrow")}</small><h1>Stremio <span>Offline</span></h1></div></button><div className="topbar-right">{restricted && <div className="restricted-chip">{t("restricted.chip")}</div>}<div className="online"><i/> {t("app.serverOnline")}</div>
      <button className="signout" title={t("auth.signedInAs", { username: session?.username ?? "" })} onClick={async () => { try { await api.logout(); } finally { location.reload(); } }}><LogOut/> {t("app.signOut")}</button></div></header>
    <aside className="sidebar"><nav>
      <Nav icon={<Library/>} label={t("nav.catalog")} active={view === "catalog"} onClick={() => openView("catalog")}/>
      <Nav icon={<HardDrive/>} label={t("nav.library")} active={view === "library"} onClick={() => openView("library")}/>
      <Nav icon={<Download/>} label={t("nav.downloads")} active={view === "downloads"} badge={downloads.filter((job) => job.status === "checking" || job.status === "downloading" || job.status === "queued" || job.status === "waiting").length} onClick={() => openView("downloads")}/>
      <Nav icon={<PackagePlus/>} label={t("nav.addons")} active={view === "addons"} badge={addons.length} onClick={() => openView("addons")}/>
      <Nav icon={<Settings/>} label={t("nav.settings")} active={view === "settings"} onClick={() => openView("settings")}/>
      <Nav icon={<BarChart3/>} label={t("nav.stats")} active={view === "stats"} onClick={() => openView("stats")}/>
    </nav><div className="sidebar-bottom"><button className="sidebar-toggle" onClick={toggleSidebar} title={t(sidebarCollapsed ? "app.expandMenu" : "app.collapseMenu")} aria-label={t(sidebarCollapsed ? "app.expandMenu" : "app.collapseMenu")}>{sidebarCollapsed ? <PanelLeftOpen/> : <PanelLeftClose/>}<span>{t(sidebarCollapsed ? "app.expandMenu" : "app.collapseMenu")}</span></button><div className="addon-status"><small>{t("app.activeAddons")}</small><strong>{addons.filter((a) => a.enabled).length}</strong><span>{t("app.catalogsAndSources")}</span></div></div></aside>
    <main className={view === "catalog" ? "view-catalog" : ""}>
      {view === "catalog" && <section className={`catalog-view ${catalogCompact ? "catalog-compact" : ""}`} onFocusCapture={(event) => {
        if ((event.target as HTMLElement).closest(".searchbar,.filterbar")) setCatalogCompact(false);
      }}><Heading eyebrow={t("catalog.eyebrow")} title={t("catalog.title")}/>
        {!catalogs.length ? (restricted ? <Empty icon={<PackagePlus/>} title={t("onboarding.title")} text={t("restricted.notice")}/> : <Onboarding onOpen={() => setView("addons")}/>) : <>
          <form className="searchbar" onSubmit={submitSearch}>
            <div className="search-input"><Search/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("catalog.searchPlaceholder")}/></div>
            <label className="scope-select"><span>{t("catalog.searchScopeIn")}</span><select aria-label={t("catalog.searchScope")} value={searchScopeValue} onChange={(e) => pickSearchScope(e.target.value)}>
              <option value="">{t("catalog.allAddons")}</option>
              {[...new Map(searchable.map((item) => [item.addonKey, { name: item.addonName, globalSearch: item.globalSearch }])).entries()].map(([key, group]) => <optgroup key={key} label={`${group.name}${group.globalSearch ? "" : " ·"}`} title={group.globalSearch ? undefined : t("catalog.onlyWhenPicked")}>
                <option value={`addon:${key}`} title={group.globalSearch ? undefined : t("catalog.onlyWhenPicked")}>{t("catalog.allCatalogs")}{group.globalSearch ? "" : " ·"}</option>
                {searchable.filter((item) => item.addonKey === key).map((item) => <option key={`${item.type}:${item.id}`} value={`catalog:${key}:${item.type}:${item.id}`} title={item.globalSearch ? undefined : t("catalog.onlyWhenPicked")}>{item.name} ({typeTag(item.type)}){item.globalSearch ? "" : " ·"}</option>)}
              </optgroup>)}
            </select></label>
            <button className="primary" disabled={busy}><Search/> {t("catalog.search")}</button>
            {submittedQuery && <button type="button" onClick={() => { setSearch(""); setSubmittedQuery(""); }}><X/> {t("common.cancel")}</button>}
          </form>
          <div className="filterbar">
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
                    <option value={VIRTUAL.resume}>▸ {t("library.continueWatching")} ({resume.filter((item) => !item.key.startsWith("file:")).length})</option>
                    {catalogs.map((catalog) => <option key={`${catalog.addonKey}:${catalog.type}:${catalog.id}`} value={`${catalog.addonKey}:${catalog.type}:${catalog.id}`}>{catalog.addonName} · {catalog.name || catalog.id} ({typeTag(catalog.type)})</option>)}
                  </select></label>
                  {genreOptions.length > 0 && <label><span>{t("catalog.genre")}</span><select aria-label={t("catalog.genre")} value={activeGenre} onChange={(e) => setGenre(e.target.value)}><option value="">{t("catalog.allGenres")}</option>{genreOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>}
                </>}
            <label><span>{t("common.sorting")}</span><select aria-label={t("catalog.sorting")} value={sort} onChange={(e) => setSort(e.target.value)}><option value="default">{t("catalog.sortAddon")}</option><option value="name">{t("catalog.sortName")}</option><option value="year">{t("catalog.sortYear")}</option></select></label>
            {sort !== "default" && <small className="filter-note">{t("catalog.sortNote")}</small>}
          </div>
          <div className="catalog-layout"><section className="panel result-panel"><div className="panel-head"><h3>{submittedQuery ? t("catalog.searchHeading", { query: submittedQuery }) : t("catalog.results")}</h3><span>{t("catalog.itemCount", { count: visibleItems.length })}{hasMore ? "+" : ""}</span></div>
            <div className="poster-grid" ref={gridRef} onScroll={(event) => { compactOnScroll(event, catalogCompact, setCatalogCompact); scheduleViewAnchor(); }}>
              {visibleItems.map((item) => {
                const klic = `${item.type || "movie"}:${item.id}`;
                const postup = catalogProgress(item);
                const vSeznamu = inWatchlist(item.type, item.id);
                const metadata = [item.releaseInfo || item.year, submittedQuery ? (item.sources ?? [item.addonName]).filter(Boolean).join(", ") : null].filter(Boolean).join(" · ") || item.type;
                return <button key={klic} data-catalog-key={klic} className={`poster-card ${selected?.id === item.id ? "selected" : ""}`} onClick={() => openMeta(item)}>
                  <span className="poster-wrap">
                    {item.poster ? <img src={item.poster} alt="" loading="lazy" onError={hideBroken}/> : <div className="poster-fallback"><Film/></div>}
                    {vSeznamu && <i className="fav-mark"><Star/></i>}
                    {postup && <i className="resume-bar"><i style={{ width: `${Math.min(100, Math.round(postup.position / (postup.duration || 1) * 100))}%` }}/></i>}
                    <span className="browse-menu" onClick={(event) => { event.stopPropagation(); setMenuFor(menuFor === klic ? null : klic); }}><MoreVertical/></span>
                  </span>
                  <strong>{item.name}</strong>
                  <small title={metadata}>{metadata}</small>
                  {menuFor === klic && <span className="browse-actions" onClick={(event) => event.stopPropagation()}>
                    <button onClick={() => { setMenuFor(null); void toggleWatchlist(item); }}><Star/> {t(vSeznamu ? "watchlist.remove" : "watchlist.add")}</button>
                    {postup && <button onClick={() => void forgetCatalogWatched(item)}><RotateCcw/> {t("library.markUnwatched")}</button>}
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
            <div className="detail-primary"><div className={`hero ${selected.videos?.length ? "series-hero" : ""} ${galleryImages.length ? "has-gallery" : ""}`} style={selected.background ? { backgroundImage: `linear-gradient(90deg,#121721 25%,transparent),url(${selected.background})` } : undefined}><div className="detail-copy"><span className="pill">{t(selected.type === "series" ? "catalog.oneSeries" : "catalog.oneMovie")}</span>
              <button className={`watch-star ${inWatchlist(selected.type, selected.id) ? "on" : ""}`} title={t(inWatchlist(selected.type, selected.id) ? "watchlist.remove" : "watchlist.add")}
                onClick={() => void toggleWatchlist(selected)}><Star/></button>{titleLinksRow(titleLinks)}<h2>{selected.name}</h2><p className="meta-line">{[selected.releaseInfo || selected.year, ...(selected.genres || []).slice(0, 3)].filter(Boolean).join(" · ")}</p><div className="catalog-description" aria-busy={metaLoading}><p className="description-preview" aria-hidden={metaLoading ? true : undefined}>{metaLoading ? skeletonLines : (selected.description || t("catalog.noDescription"))}</p><details key={selected.id}><summary>{t("catalog.description")}</summary><p tabIndex={0}>{metaLoading ? skeletonLines : (selected.description || t("catalog.noDescription"))}</p></details></div></div>{galleryImages.length > 0 && <button className={`gallery-open ${galleryImages[0].shape}`} onClick={() => setGalleryIndex(0)} title={t("gallery.openHint")}><img src={galleryImages[0].url} alt="" onError={hideBroken}/><span><Images/> {galleryImages.length > 1 ? t("gallery.stillCount", { count: galleryImages.length }) : t("gallery.enlarge")}</span></button>}</div></div>
            <div className="detail-workflow">
            {selected.videos?.length ? <div className={`episodes ${selectedVideo && !episodesOpen ? "collapsed" : ""}`}>{selectedVideo && !episodesOpen ? <div className="episode-current"><small>{t("episodes.chosen")}</small><b>{selectedVideo.season != null ? `${String(selectedVideo.season).padStart(2,"0")}×${String(selectedVideo.episode || 0).padStart(2,"0")}` : t("episodes.part")}</b><span>{selectedVideo.title || selectedVideo.name || t("episodes.one")}</span><button onClick={() => setEpisodesOpen(true)}>{t("episodes.change")}</button></div> : <><div className="subhead episode-head"><h3>{t("episodes.heading")}</h3><div className="episode-tools">{seasons.length > 1 && <select className="season-select" aria-label={t("episodes.season")} value={activeSeason ?? ""} onChange={(event) => setSeason(Number(event.target.value))}>{seasons.map((value) => <option key={value} value={value}>{value === 0 ? t("episodes.specials") : t("episodes.seasonNumber", { season: value })}</option>)}</select>}{activeSeason != null && <button title={activeSeason === 0 ? t("episodes.downloadSpecials") : t("episodes.downloadSeason", { season: activeSeason })} onClick={() => void enqueueEpisodes("season")}><Download/> {activeSeason === 0 ? t("episodes.specials") : t("episodes.seasonShort", { season: activeSeason })}</button>}<button title={t("episodes.downloadShow")} onClick={() => void enqueueEpisodes("series")}><Download/> {t("episodes.wholeShow")}</button>{selectedVideo ? <button onClick={() => setEpisodesOpen(false)}>{t("common.collapse")}</button> : <span>{visibleEpisodes.length}</span>}</div></div><div className="episode-list" onScroll={(event) => compactOnScroll(event, detailCompact, setDetailCompact)}>{visibleEpisodes.map((video, index) => <button key={video.id || index} className={selectedVideo?.id === video.id ? "selected" : ""} onClick={() => { setEpisodesOpen(false); void loadSources(video); }}><b>{video.season != null ? `${String(video.season).padStart(2,"0")}×${String(video.episode || 0).padStart(2,"0")}` : index + 1}</b><span>{video.title || video.name || t("episodes.one")}</span><ChevronRight/></button>)}</div></>}</div> : !sourcesLoaded && <button className="primary wide" onClick={() => loadSources()} disabled={busy}>{t("sources.load")}</button>}
            {sourcesLoaded && (!selected.videos?.length || !episodesOpen) && <div className="sources"><div className="subhead"><h3>{t("sources.heading")}</h3><span>{visibleStreams.length === streams.length ? streams.length : t("sources.ofTotal", { shown: visibleStreams.length, total: streams.length })}{pendingSources > 0 ? ` · ${t("sources.loadingFrom", { count: pendingSources })}` : ""}</span></div>
              {streams.length > 1 && <div className="stream-filters">
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
              </div>}<div className="stream-list" onScroll={(event) => compactOnScroll(event, detailCompact, setDetailCompact)}>{visibleStreams.map((stream, index) => <button key={index} className={selectedStream === stream ? "selected" : ""} onClick={() => { pickedRef.current = true; setSelectedStream(stream); }}><i className={stream.kind === "torrent" ? "rd" : stream.playable ? undefined : "ext"}>{streamBadge(stream)}</i><span><strong>{streamLabel(stream)}</strong><small>{stream.addonName} {streamSize(stream) ? `· ${bytes(streamSize(stream))}` : ""} {streamLanguages(stream, metaLanguage).map((code) => <em className="lang-badge" key={code} title={t("sources.languageGuess")}>{label(code)}</em>)}</small></span>{selectedStream === stream && <Check/>}</button>)}</div>
              {!streams.length && pendingSources === 0 && <div className="no-sources">{t("sources.none")}</div>}
              {!streams.length && pendingSources > 0 && <div className="no-sources">{t("sources.asking")}</div>}
              {Boolean(streams.length) && !visibleStreams.length && hiddenTorrents && !streamAddon && !streamLanguage && <div className="no-sources">{t("sources.onlyTorrentsBefore")} <button className="link-button" onClick={() => openView("settings")}>{t("nav.settings")}</button> {t("sources.onlyTorrentsAfter")}</div>}
              {Boolean(streams.length) && !visibleStreams.length && !(hiddenTorrents && !streamAddon && !streamLanguage) && <div className="no-sources">{t("sources.noneMatchFilter", { count: streams.length })} <button className="link-button" onClick={() => { setStreamAddon(""); setStreamLanguage(""); }}>{t("sources.clearFilters")}</button></div>}
              {selectedStream?.kind === "unsupported" && <p className="notice">{t("sources.unsupported")}</p>}
              {selectedStream?.kind === "torrent" && <p className="notice">{t("sources.torrentNotice")}</p>}
              <div className="source-footer"><div className="source-info"><Subtitles/> {t("sources.subtitleCount", { count: subtitles.length + (selectedStream?.subtitles?.length || 0) })}
                {inspection && <> · <b>{t("sources.audioInFile")}</b> {inspection.audioTracks.length ? inspection.audioTracks.map((track, index) => <em className="lang-badge" key={index}>{label(track.language)}</em>) : "—"}
                · <b>{t("sources.subtitlesInFile")}</b> {inspection.subtitleTracks.length ? inspection.subtitleTracks.map((track, index) => <em className="lang-badge" key={index}>{label(track.language)}</em>) : "—"}</>}
              {selectedStream?.playable && !inspection && <> · {t("sources.probing")}</>}</div><div className="actions"><button className="primary" disabled={!canPlay} onClick={() => openPlayer({ kind: "catalog", key: `${selected.type || "movie"}:${selected.id}` })}><CirclePlay/> {t("player.play")}</button><button disabled={!selectedStream || !canQueue(selectedStream, settings.realDebridConfigured)} onClick={() => void enqueue()}><HardDrive/> {t("save.toLibrary")}</button><button disabled={!canPlay} onClick={() => void downloadStreamToDevice()}><Download/> {t("save.toDevice")}</button></div></div>
            </div>}
            </div>
          </> : <Empty icon={<Film/>} title={t("catalog.pickTitle")} text={t("catalog.pickText")}/>}</section></div>
        </>}
      </section>}
      {view === "library" && <section className="library-page" onKeyDown={(event) => { if (event.key === "Escape") setMenuFor(null); }} onClick={() => menuFor && setMenuFor(null)}><Heading eyebrow={t("library.eyebrow")} title={t("library.title")}/>
        {settings.showResumeRow && !browsePath && !onlyFavorites && localResume.length > 0 && <div className="resume-row">
          <div className="subhead"><h3>{t("library.continueWatching")}</h3><button className="resume-show-all" onClick={() => { setBrowseQuery(""); setOnlyFavorites(false); setFromFavorites(false); setMenuFor(null); setBrowseSort("added"); setBrowseDesc(true); setBrowsePath(":resume"); }}>{t("library.showAll")} ({resumePreview?.total ?? localResume.length}) <ChevronRight/></button></div>
          <div className="resume-strip">
            {localResume.slice(0, 8).map((item) => <button className="browse-item" key={item.key} data-path={item.path} onClick={() => {
              if (item.path) void playLocal(item.title, item.path, item.poster, item.season != null);
            }}>
              <span className="browse-art">
                {item.poster ? <img src={item.poster} alt="" loading="lazy"/> : <Film/>}
                <i className="browse-play"><CirclePlay/></i>
                <i className="resume-bar"><i style={{ width: `${Math.min(100, Math.round(item.position / (item.duration || 1) * 100))}%` }}/></i>
              </span>
              <strong>{item.title}</strong>
              <small>{t("library.remaining", { time: fmtEta(Math.max(0, item.duration - item.position)) })}</small>
            </button>)}
          </div>
        </div>}
        <div className="panel browse-panel">
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
            {!libraryList && <div className="search-input"><Search/><input value={browseQuery} aria-label={t("library.filter")} placeholder={t("library.filterPlaceholder")} onChange={(event) => setBrowseQuery(event.target.value)}/></div>}
            {!libraryList && <select aria-label={t("common.sorting")} value={browseSort} onChange={(event) => {
              const next = event.target.value as LibrarySort;
              setBrowseSort(next);
              // Dates and sizes start with the largest value; names start with A.
              setBrowseDesc(next === "added" || next === "size");
            }}>
              <option value="name">{t("library.sortName")}</option><option value="added">{t(browsePath === ":resume" ? "library.sortLastWatched" : "library.sortAdded")}</option>
              <option value="size">{t("library.sortSize")}</option><option value="random">{t("library.sortRandom")}</option>
            </select>}
            {!libraryList && <button title={t(browseDesc ? "common.descending" : "common.ascending")} onClick={() => setBrowseDesc((value) => !value)} disabled={browseSort === "random"}>
              {browseDesc ? <ArrowDown/> : <ArrowUp/>}
            </button>}
            {!libraryList && <button className={onlyFavorites ? "active-filter" : ""} title={t("library.onlyFavorites")} disabled={browsePath === ":favorites"}
              onClick={() => setOnlyFavorites((value) => !value)}><Star/></button>}
            {!libraryList && <button title={t(browseView === "grid" ? "library.viewRows" : "library.viewTiles")} onClick={() => setBrowseView((value) => value === "grid" ? "list" : "grid")}>
              {browseView === "grid" ? <List/> : <LayoutGrid/>}
            </button>}
            {!libraryList && <button className={selectionMode ? "active-filter" : ""} title={t("library.selectMode")} aria-pressed={selectionMode}
              onClick={() => { setMenuFor(null); if (selectionMode) leaveSelection(); else setSelectionMode(true); }}><Check/></button>}
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
        {!browsePath && !scanHintDismissed && !libraryScan?.finishedAt && (browse?.total ?? 0) >= 10 && <div className="library-scan-hint" role="status">
          <span>{t("library.scanHint")}</span>
          <button type="button" onClick={dismissScanHint}>{t("library.dismissHint")}</button>
        </div>}
        {suggestionCount > 0 && !scanning && <div className="library-scan-hint" role="status">
          <span>{t("library.suggestionsWaiting", { count: suggestionCount })}</span>
          <button type="button" onClick={() => setSuggestionsOpen(true)}>{t("library.suggestionsReview")}</button>
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

        {!browsePath && !onlyFavorites && !browseQuery && <button className="library-favorites" onClick={() => { setBrowseQuery(""); setFromFavorites(false); setBrowsePath(":favorites"); }}>
          <span className="favorites-collage" aria-hidden="true">{[...new Set(favoritePreview?.items.map((item) => item.poster).filter((poster): poster is string => Boolean(poster)))].slice(0, 3).map((poster) => <img key={poster} src={poster} alt="" onError={hideBroken}/>)}<Star/></span>
          <span className="favorites-copy"><strong>{t("favorite.off")}</strong><small>{favoritePreview?.total ? t("library.favoritesCount", { count: favoritePreview.total }) : t("library.favoritesEmptyHint")}</small></span><ChevronRight/>
        </button>}
        {!browse || !browse.items.length
          ? (browseBusy ? <div className="loading">{t("common.loading")}</div>
            : <Empty icon={<HardDrive/>} title={t(browseQuery ? "library.emptyFilterTitle" : browsePath === ":resume" ? "library.emptyResumeTitle" : browsePath === ":favorites" || onlyFavorites ? "library.emptyFavoritesTitle" : "library.emptyTitle")} text={t(browseQuery ? "library.emptyFilterText" : browsePath === ":resume" ? "library.emptyResumeText" : browsePath === ":favorites" || onlyFavorites ? "library.emptyFavoritesText" : "library.emptyText")}/>)
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
                    <span className="browse-art">{item.poster ? <img src={item.poster} alt="" loading="lazy"/> : <FolderOpen/>}<i className="browse-badge">{item.fileCount}</i>{item.favorite && <i className="fav-mark"><Star/></i>}</span>
                    <span className="library-copy"><strong>{item.name}</strong><small>{folderMeta(item)}</small>{descriptionLine(item) && <small className="library-desc" title={descriptionLine(item)}>{descriptionLine(item)}</small>}</span><span className="library-action"><FolderOpen/> {t("library.openFolder")} <ChevronRight/></span></button>
                    {selectionMode && <button className="browse-select" aria-label={t("library.selectItem", { name: item.name })} aria-pressed={selectedPaths.has(item.path)} onClick={(event) => { event.stopPropagation(); toggleSelection(item.path); }}>{selectedPaths.has(item.path) && <Check/>}</button>}
                    {!selectionMode && <button className="browse-menu" aria-label={t("library.options", { name: item.name })} aria-expanded={menuFor === item.path} onClick={(event) => { event.stopPropagation(); openMenu(item); }}><MoreVertical/></button>}
                    {!selectionMode && menuFor === item.path && <span className="browse-actions" onClick={(event) => event.stopPropagation()}>
                      {item.match === "matched" && titleLinksRow(libraryLinks[item.path] ?? [])}
                      {matchActions(item)}
                      <button onClick={() => void toggleFavorite(item.path, !item.favorite)}><Star/> {t(item.favorite ? "favorite.remove" : "favorite.add")}</button>
                      <button onClick={() => void renameItem(item.path, item.name)}><Pencil/> {t("library.rename")}</button>
                      <button onClick={() => openMove(item.path, item.name, item.titleType)}><FolderInput/> {t("library.move")}</button>
                      <button className="danger" onClick={() => void removeItem(item.path, item.name, true)}><Trash2/> {t("common.delete")}</button>
                    </span>}
                  </article>
                : <article className={`browse-item${browseFocus === item.path ? " focused" : ""}${selectedPaths.has(item.path) ? " selected" : ""}`} key={item.path} data-path={item.path} aria-current={browseFocus === item.path ? "true" : undefined}><button className="library-open" onClick={() => selectionMode ? toggleSelection(item.path) : void playLocal(item.label, item.path, item.poster, item.season != null)}>
                    <span className="browse-art">{item.poster ? <img src={item.poster} alt="" loading="lazy"/> : <Film/>}{item.favorite && <i className="fav-mark"><Star/></i>}
                    {browseFocus === item.path && <i className="browse-focus-mark">{t("library.thisFile")}</i>}
                    {item.progress && <i className="resume-bar"><i style={{ width: `${Math.min(100, Math.round(item.progress.position / (item.progress.duration || 1) * 100))}%` }}/></i>}</span>
                    <span className="library-copy"><strong>{item.season != null ? `${item.season}×${String(item.episode ?? 0).padStart(2, "0")} ${item.label}` : item.label}</strong>
                    <small>{fileMeta(item)}</small>{descriptionLine(item) && <small className="library-desc" title={descriptionLine(item)}>{descriptionLine(item)}</small>}</span><span className="library-action"><Play/> {t(item.progress ? "library.continue" : "player.play")}</span></button>
                    {selectionMode && <button className="browse-select" aria-label={t("library.selectItem", { name: item.label })} aria-pressed={selectedPaths.has(item.path)} onClick={(event) => { event.stopPropagation(); toggleSelection(item.path); }}>{selectedPaths.has(item.path) && <Check/>}</button>}
                    {!selectionMode && <button className="browse-menu" aria-label={t("library.options", { name: item.label })} aria-expanded={menuFor === item.path} onClick={(event) => { event.stopPropagation(); openMenu(item); }}><MoreVertical/></button>}
                    {!selectionMode && menuFor === item.path && <span className="browse-actions" onClick={(event) => event.stopPropagation()}>
                      {item.match === "matched" && titleLinksRow(libraryLinks[item.path] ?? [])}
                      {matchActions(item)}
                      <button onClick={() => void toggleFavorite(item.path, !item.favorite)}><Star/> {t(item.favorite ? "favorite.remove" : "favorite.add")}</button>
                      {item.progress && <button onClick={() => void forgetWatched(item.path)}><RotateCcw/> {t("library.markUnwatched")}</button>}
                      <button onClick={() => { setMenuFor(null); void downloadLibraryFile(item.path); }}><Download/> {t("library.downloadToDevice")}</button>
                      <button onClick={() => void renameItem(item.path, item.label)}><Pencil/> {t("library.rename")}</button>
                      <button onClick={() => openMove(item.path, item.label, item.titleType)}><FolderInput/> {t("library.move")}</button>
                      <button className="danger" onClick={() => void removeItem(item.path, item.label, false)}><Trash2/> {t("common.delete")}</button>
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
      </section>}
      {view === "addons" && <Addons addons={addons} libraries={libraries} restricted={restricted} onChanged={refresh} onNotify={notify} onError={fail}/>} 
      {view === "downloads" && <Downloads jobs={downloads} libraries={libraries} halt={queueHalt} refresh={loadDownloads} onError={fail} onReveal={revealInLibrary}/>}
      {view === "stats" && <StatsPanel key={statsReset} onError={fail}/>}
      {view === "settings" && <SettingsPage build={buildInfo} restricted={restricted} settings={settings} languages={languages} libraries={libraries} session={session!} onSession={setSession} onSave={saveSettings} onLibrariesChanged={refreshLibraries} onImported={async (backup) => {
        const restored = await api.importSettings(backup);
        setSettings(restored.settings);
        setSelectedCatalog("");
        // Rules that named a library of the machine the backup came from are pointed at this
        // instance's own, or at the default; say how many had to move.
        if (restored.remapped) notify(t("settings.importRemapped", { count: restored.remapped }));
        await refresh(true);
      }} onNotify={notify} onError={fail}/>}
    </main>
    <Player nextTitle={localStream ? nextFile?.title : nextCatalogEpisode ? episodeLabel(nextCatalogEpisode) : undefined} nextBusy={nextBusy} onNext={localStream ? nextFile ? () => playAdjacent(nextFile) : undefined : nextCatalogEpisode ? playNextCatalogEpisode : undefined} autoNext={localStream ? localEpisode : Boolean(nextCatalogEpisode)} previousTitle={previousFile?.title} onPrevious={previousFile ? () => playAdjacent(previousFile) : undefined} open={playerOpen} title={localStream ? localTitle : videoTitle} stream={localStream ?? selectedStream} subtitles={localStream ? [] : subtitles} subtitleLanguage={settings.subtitleLanguage} audioLanguage={settings.audioLanguage} onPreferences={setPlaybackPreferences}
      progressKey={localStream?.localPath ? `file:${localStream.localPath}` : (videoId ? `${selected?.type ?? "movie"}:${videoId}` : undefined)}
      progressPoster={localStream ? localPoster : selected?.poster}
      favorite={localStream?.localPath ? libraryFavorites.includes(localStream.localPath) : inWatchlist(selected?.type, selected?.id)}
      onToggleFavorite={localStream?.localPath || selected ? () => void togglePlayerFavorite() : undefined}
      onDownload={enqueue}
      onDeviceDownload={() => localStream?.localPath ? downloadLibraryFile(localStream.localPath) : downloadStreamToDevice()}
      onClose={() => { setPlayerOpen(false); setLocalStream(null); setLocalEpisode(false); setPlaybackPreferences({}); }}/>
    {libraryManagerOpen && <LibraryManagerDialog restricted={restricted} onClose={() => setLibraryManagerOpen(false)} onChanged={refreshLibraries} onError={fail} onNotify={notify}/>}
    {movePath && <MoveDialog path={movePath.path} paths={movePath.paths} copy={movePath.copy} label={movePath.label}
      itemType={movePath.type} libraries={libraries} onClose={() => setMovePath(null)} onMoved={(target) => void finishMove(target)}
      onQueued={(id) => { leaveSelection(); void trackQueuedOp(id); }}/>}
    {identifyPath && <IdentifyDialog path={identifyPath} onClose={() => setIdentifyPath(null)}
      onApplied={() => { setIdentifyPath(null); void loadSuggestionCount(); void loadBrowse(browsePath); }}/>}
    {bulkIdentifyPaths?.length && <IdentifyDialog path={bulkIdentifyPaths[0]!} paths={bulkIdentifyPaths}
      onClose={() => setBulkIdentifyPaths(null)} onApplied={(id) => { setBulkIdentifyPaths(null); leaveSelection(); if (id) void trackQueuedOp(id); }}/>}
    {suggestionsOpen && <SuggestionsDialog
      onClose={() => setSuggestionsOpen(false)}
      onChanged={() => { void loadSuggestionCount(); void loadBrowse(browsePath); }}
      onIdentify={(target) => { setSuggestionsOpen(false); setIdentifyPath(target); }}/>}
    {bulkDownload && <SeriesDownloadDialog type={bulkDownload.type} label={bulkDownload.label} episodes={bulkDownload.episodes} audioLanguage={settings.audioLanguage} subtitleLanguage={settings.subtitleLanguage} languages={languages} onClose={() => setBulkDownload(null)} onSubmit={submitBulkDownload}/>}
    {galleryIndex !== null && galleryImages[galleryIndex] && <MediaGallery images={galleryImages} index={galleryIndex} onIndex={setGalleryIndex} onClose={() => setGalleryIndex(null)}/>}
    {(message || error) && <div className={`toast ${error ? "error" : ""}`}>{error || message}<button onClick={() => {setError("");setMessage("");}}><X/></button></div>}
  </div>;
}

function Nav({ icon, label, active, badge, onClick }: { icon: React.ReactNode; label: string; active: boolean; badge?: number; onClick: () => void }) { return <button className={active ? "active" : ""} title={label} aria-label={label} onClick={onClick}>{icon}<span>{label}</span>{badge != null && <b>{badge}</b>}</button>; }
function MediaGallery({ images, index, onIndex, onClose }: { images: GalleryImage[]; index: number; onIndex: (index: number) => void; onClose: () => void }) {
  const current = images[index];
  const move = (step: number) => onIndex((index + step + images.length) % images.length);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowLeft" && images.length > 1) move(-1);
      else if (event.key === "ArrowRight" && images.length > 1) move(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, images.length]);
  return <div className="gallery-overlay" role="dialog" aria-modal="true" aria-label={t("gallery.title")} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <button className="gallery-close icon-button" aria-label={t("gallery.close")} onClick={onClose}><X/></button>
    {images.length > 1 && <button className="gallery-arrow previous" aria-label={t("gallery.previous")} onClick={() => move(-1)}><ChevronLeft/></button>}
    <figure><img className={current.shape} src={current.url} alt={current.label} onError={hideBroken}/><figcaption>{t("gallery.caption", { label: current.label, index: index + 1, total: images.length })}</figcaption></figure>
    {images.length > 1 && <button className="gallery-arrow next" aria-label={t("gallery.next")} onClick={() => move(1)}><ChevronRight/></button>}
    {images.length > 1 && <div className="gallery-thumbnails">{images.map((image, itemIndex) => <button key={image.url} className={itemIndex === index ? "selected" : ""} aria-label={t("gallery.show", { label: image.label })} onClick={() => onIndex(itemIndex)}><img src={image.url} alt="" loading="lazy" onError={hideBroken}/></button>)}</div>}
  </div>;
}
function Heading({ eyebrow, title }: { eyebrow: string; title: string }) { return <div className="heading"><small>{eyebrow}</small><h2>{title}</h2></div>; }
function Empty({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) { return <div className="empty"><i>{icon}</i><h3>{title}</h3><p>{text}</p></div>; }
function Onboarding({ onOpen }: { onOpen: () => void }) { return <div className="panel onboarding"><i><PackagePlus/></i><h2>{t("onboarding.title")}</h2><p>{t("onboarding.text")}</p><button className="primary" onClick={onOpen}><Plus/> {t("onboarding.action")}</button></div>; }

function TmdbSettings({ configured, onSave, onError, restricted = false }: { configured: boolean; onSave: (patch: SettingsPatch) => Promise<void>; onError: (error: unknown) => void; restricted?: boolean }) {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const value = apiKey.trim();
    if (!value) return;
    setBusy(true);
    try { await onSave({ tmdbApiKey: value }); setApiKey(""); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    if (!confirm(t("tmdb.removeConfirm"))) return;
    setBusy(true);
    try { await onSave({ tmdbApiKey: "" }); setApiKey(""); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  };
  return <section className="panel settings-section credentials-section">
    <SettingsSectionHead icon={<KeyRound/>} title={t("tmdb.title")} text={t("tmdb.sectionText")}/>
    {configured
      ? <p className="credentials-status" role="status">{t("tmdb.stored")}</p>
      : <p className="credentials-status muted">{t("tmdb.missing")}</p>}
    {!restricted && <div className="credentials-row"><label className="credentials-field">
      <span>{t(configured ? "tmdb.replaceKey" : "tmdb.apiKey")}</span>
      <input type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(event) => setApiKey(event.target.value)}
        aria-label={t("tmdb.keyLabel")} placeholder={configured ? "••••••••" : t("tmdb.keyPlaceholder")}/>
    </label>
    <div className="setting-actions">
      <button className="primary" disabled={busy || !apiKey.trim()} onClick={() => void submit()}>{t(configured ? "tmdb.replaceKey" : "tmdb.saveKey")}</button>
      {configured && <button className="danger" disabled={busy} onClick={() => void clear()}>{t("common.remove")}</button>}
    </div></div>}
  </section>;
}

function RealDebridSettings({ configured, onSave, onError, restricted = false }: { configured: boolean; onSave: (patch: SettingsPatch) => Promise<void>; onError: (error: unknown) => void; restricted?: boolean }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const value = token.trim();
    if (!value) return;
    setBusy(true);
    try { await onSave({ realDebridToken: value }); setToken(""); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    if (!confirm(t("debrid.removeConfirm"))) return;
    setBusy(true);
    try { await onSave({ realDebridToken: "" }); setToken(""); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  };
  return <section className="panel settings-section credentials-section">
    <SettingsSectionHead icon={<KeyRound/>} title={t("debrid.title")} text={t("debrid.sectionText")}/>
    {configured
      ? <p className="credentials-status" role="status">{t("debrid.stored")}</p>
      : <p className="credentials-status muted">{t("debrid.missing")}</p>}
    {!restricted && <div className="credentials-row"><label className="credentials-field">
      <span>{t(configured ? "debrid.replaceToken" : "debrid.apiToken")}</span>
      <input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(event) => setToken(event.target.value)}
        aria-label={t("debrid.tokenLabel")} placeholder={configured ? "••••••••" : t("debrid.tokenPlaceholder")}/>
    </label>
    <div className="setting-actions">
      <button className="primary" disabled={busy || !token.trim()} onClick={() => void submit()}>{t(configured ? "debrid.replaceToken" : "debrid.saveToken")}</button>
      {configured && <button className="danger" disabled={busy} onClick={() => void clear()}>{t("common.remove")}</button>}
    </div></div>}
  </section>;
}

const REFRESH_HOURS = [0, 6, 12, 24, 48, 168] as const;
const refreshIntervalLabel = (hours: number) =>
  hours === 0 ? t("settings.addonRefreshOff")
  : hours === 168 ? t("settings.addonRefreshWeekly")
  : t("settings.addonRefreshHoursOption", { count: hours });

function SettingsPage({ build, restricted = false, settings, languages, libraries = [], session, onSession, onSave, onImported, onLibrariesChanged, onNotify, onError }: { build: BuildInfo | null; restricted?: boolean; settings: AppSettings; languages: Array<{ code: string; name: string }>; libraries?: LibraryView[]; session: Session; onSession: (session: Session) => void; onSave: (patch: SettingsPatch) => Promise<void>; onImported: (backup: unknown) => Promise<void>; onLibrariesChanged: () => void; onNotify: (message: string) => void; onError: (error: unknown) => void }) {
  const { t, locale, setLocale } = useI18n();
  // The names come from the browser in the active language, so they need sorting there too.
  const languageOptions = languages
    .map((item) => ({ code: item.code, name: languageName(item.code) }))
    .sort((a, b) => a.name.localeCompare(b.name, localeTag()))
    .map((item) => <option key={item.code} value={item.code}>{item.name}</option>);
  const tileSizes = [{ value: "compact", key: "settings.tile.compact" }, { value: "small", key: "settings.tile.small" }, { value: "medium", key: "settings.tile.medium" }, { value: "large", key: "settings.tile.large" }] as const;
  const importInput = useRef<HTMLInputElement>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  // Which root a download lands under is a property of the library, and a mount differs per
  // install; showing a fixed path was the last thing here that assumed one.
  const libraryRoot = (libraries.find((library) => library.defaultMovie) ?? libraries[0])?.root ?? t("settings.noLibraryRoot");
  const exportSettings = async () => {
    setBackupBusy(true);
    try {
      const backup = await api.exportSettings();
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url; link.download = `stremio-offline-settings-${new Date().toISOString().slice(0, 10)}.json`; link.click();
      URL.revokeObjectURL(url);
      onNotify(t("settings.exported"));
    } catch (error) { onError(error); }
    finally { setBackupBusy(false); }
  };
  const importSettings = async (file?: File) => {
    if (!file) return;
    if (importInput.current) importInput.current.value = "";
    if (!confirm(t("settings.importConfirm"))) return;
    setBackupBusy(true);
    try {
      let backup: unknown;
      try { backup = JSON.parse(await file.text()); }
      catch { throw new Error(t("settings.importNotJson")); }
      await onImported(backup);
      onNotify(t("settings.imported"));
    } catch (error) { onError(error); }
    finally { setBackupBusy(false); }
  };
  return <section className="settings-page"><div className="settings-title"><Heading eyebrow={t("settings.eyebrow")} title={t("settings.title")}/><span><Check/> {t("settings.autosave")}</span></div>
    {restricted && <p className="notice">{t("restricted.notice")}</p>}
    <div className="settings-grid">
      <section className="panel settings-section library-manager-section"><SettingsSectionHead icon={<Library/>} title={t("library.libraries")} text={t("library.librariesHint")}/><LibraryManager restricted={restricted} onChanged={onLibrariesChanged} onError={onError} onNotify={onNotify}/></section>
      <section className="panel settings-section"><SettingsSectionHead icon={<Library/>} title={t("nav.library")} /><SettingControl title={t("settings.sameTitles")} text={t("settings.sameTitlesHint")}><select aria-label={t("settings.sameTitles")} disabled={restricted} value={settings.mergeByName ? "1" : "0"} onChange={(event) => void onSave({ mergeByName: event.target.value === "1" })}><option value="1">{t("settings.merge")}</option><option value="0">{t("settings.showSeparately")}</option></select></SettingControl>
        <SettingControl title={t("settings.resumeRow")} text={t("settings.resumeRowHint")}>
          <select aria-label={t("settings.resumeRowLabel")} disabled={restricted} value={settings.showResumeRow ? "1" : "0"} onChange={(event) => void onSave({ showResumeRow: event.target.value === "1" })}>
            <option value="1">{t("settings.show")}</option><option value="0">{t("settings.hide")}</option>
          </select></SettingControl>
        <SettingControl title={t("settings.autoScan")} text={t("settings.autoScanHint")}>
          <select aria-label={t("settings.autoScanLabel")} disabled={restricted} value={settings.libraryAutoScan ? "1" : "0"} onChange={(event) => void onSave({ libraryAutoScan: event.target.value === "1" })}>
            <option value="1">{t("settings.autoScanOn")}</option><option value="0">{t("settings.autoScanOff")}</option>
          </select></SettingControl>
        <SettingControl title={t("settings.scanDuringDownload")} text={t("settings.scanDuringDownloadHint")}>
          <select aria-label={t("settings.scanDuringDownloadLabel")} disabled={restricted} value={settings.libraryScanPauseOnDownload ? "0" : "1"} onChange={(event) => void onSave({ libraryScanPauseOnDownload: event.target.value === "0" })}>
            <option value="1">{t("settings.scanDuringDownloadOn")}</option><option value="0">{t("settings.scanDuringDownloadOff")}</option>
          </select></SettingControl>
      </section>
      <section className="panel settings-section storage-section"><SettingsSectionHead icon={<HardDrive/>} title={t("settings.storageTitle")} text={t("settings.storageText")}/><p>{t("settings.artworkMoved")}</p><div className="storage-path"><span>{t("settings.dockerPath")}</span><code>{libraryRoot}</code></div><p>{t("settings.storageNoteBefore")} <code>DOWNLOAD_PATH</code> {t("settings.storageNoteAfter")}</p></section>
      <section className="panel settings-section"><SettingsSectionHead icon={<PackagePlus/>} title={t("settings.addonsTitle")} text={t("settings.addonsText")}/>
        <SettingControl title={t("settings.addonRefresh")} text={t("settings.addonRefreshHint")}>
          <select aria-label={t("settings.addonRefreshLabel")} disabled={restricted} value={settings.addonRefreshHours ?? 24} onChange={(event) => void onSave({ addonRefreshHours: Number(event.target.value) })}>
            {REFRESH_HOURS.map((hours) => <option key={hours} value={hours}>{refreshIntervalLabel(hours)}</option>)}
          </select></SettingControl>
      </section>
      <section className="panel settings-section"><SettingsSectionHead icon={<Download/>} title={t("nav.downloads")} text={t("settings.downloadsText")}/><SettingControl title={t("settings.downloadTitleLanguage")} text={t("settings.downloadTitleLanguageHint")}><select aria-label={t("settings.downloadTitleLanguage")} disabled={restricted} value={settings.downloadTitleLanguage} onChange={(event) => void onSave({ downloadTitleLanguage: event.target.value })}><option value="ui">{t("settings.downloadTitleLanguageUi", { language: LOCALE_NAMES[locale] })}</option>{languageOptions}</select></SettingControl><SettingControl title={t("settings.concurrent")} text={t("settings.concurrentHint")}><select aria-label={t("settings.concurrent")} disabled={restricted} value={settings.concurrentDownloads} onChange={(event) => void onSave({ concurrentDownloads: Number(event.target.value) })}>{[1,2,3,4,5,6,7,8].map((value) => <option key={value} value={value}>{value}</option>)}</select></SettingControl><SettingControl title={t("settings.perProvider")} text={t("settings.perProviderHint")}><select aria-label={t("settings.perProvider")} disabled={restricted} value={settings.parallelPerProvider ?? 1} onChange={(event) => void onSave({ parallelPerProvider: Number(event.target.value) })}>{[1,2,3,4].map((value) => <option key={value} value={value}>{value}</option>)}</select></SettingControl><SettingControl title={t("settings.segments")} text={t("settings.segmentsHint")}><select aria-label={t("settings.segments")} disabled={restricted} value={settings.downloadSegments ?? 1} onChange={(event) => void onSave({ downloadSegments: Number(event.target.value) })}>{[1,2,3,4,6,8].map((value) => <option key={value} value={value}>{value}</option>)}</select></SettingControl></section>
      <TmdbSettings configured={settings.tmdbConfigured} onSave={onSave} onError={onError} restricted={restricted}/>
      <RealDebridSettings configured={settings.realDebridConfigured} onSave={onSave} onError={onError} restricted={restricted}/>
      <section className="panel settings-section playback-section"><SettingsSectionHead icon={<CirclePlay/>} title={t("settings.playbackTitle")} text={t("settings.playbackText")}/><div className="playback-settings"><SettingControl title={t("settings.audioLanguage")} text={t("settings.audioLanguageHint")}><select aria-label={t("settings.audioLanguageLabel")} disabled={restricted} value={settings.audioLanguage} onChange={(event) => void onSave({ audioLanguage: event.target.value })}>{languageOptions}</select></SettingControl><SettingControl title={t("settings.subtitleLanguage")} text={t("settings.subtitleLanguageHint")}><select aria-label={t("settings.subtitleLanguageLabel")} disabled={restricted} value={settings.subtitleLanguage} onChange={(event) => void onSave({ subtitleLanguage: event.target.value })}>{languageOptions}</select></SettingControl></div><SettingControl title={t("settings.streamSort")} text={t("settings.streamSortHint")}><select aria-label={t("settings.streamSort")} disabled={restricted} value={settings.streamSort} onChange={(event) => void onSave({ streamSort: event.target.value })}><option value="recommended">{t("sources.sortRecommended")}</option><option value="size-desc">{t("sources.sortLargest")}</option><option value="size-asc">{t("sources.sortSmallest")}</option><option value="addon">{t("sources.sortAddon")}</option></select></SettingControl><SettingControl title={t("settings.trackProgress")} text={t("settings.trackProgressHint")}>
          <select aria-label={t("settings.trackProgressLabel")} disabled={restricted} value={settings.trackProgress ? "1" : "0"} onChange={(event) => void onSave({ trackProgress: event.target.value === "1" })}>
            <option value="1">{t("settings.store")}</option><option value="0">{t("settings.doNotStore")}</option>
          </select></SettingControl>{!restricted && <SettingControl title={t("settings.history")} text={t("settings.historyHint")}>
          <button className="danger" onClick={async () => {
            if (!confirm(t("settings.historyConfirm"))) return;
            try { await api.clearProgress(); onNotify(t("settings.historyCleared")); } catch (error) { onError(error); }
          }}><Trash2/> {t("settings.clearHistory")}</button></SettingControl>}</section>
      <section className="panel settings-section language-section"><SettingsSectionHead icon={<Languages/>} title={t("settings.appearanceTitle")}/>
        <SettingControl title={t("settings.uiLanguage")} text={t("settings.uiLanguageHint")}>
          <select aria-label={t("settings.uiLanguage")} disabled={restricted} value={locale} onChange={(event) => {
            const next = event.target.value as Locale;
            setLocale(next);
            void onSave({ uiLanguage: next });
          }}>{LOCALES.map((code) => <option key={code} value={code}>{LOCALE_NAMES[code]}</option>)}</select>
        </SettingControl><SettingControl title={t("settings.catalogTiles")} text={t("settings.catalogTilesHint")}><select aria-label={t("settings.catalogTiles")} disabled={restricted} value={settings.catalogTileSize} onChange={(event) => void onSave({ catalogTileSize: event.target.value as AppSettings["catalogTileSize"] })}>{tileSizes.map((size) => <option key={size.value} value={size.value}>{t(size.key)}</option>)}</select></SettingControl><SettingControl title={t("settings.libraryTiles")} text={t("settings.libraryTilesHint")}><select aria-label={t("settings.libraryTiles")} disabled={restricted} value={settings.libraryTileSize} onChange={(event) => void onSave({ libraryTileSize: event.target.value as AppSettings["libraryTileSize"] })}>{tileSizes.map((size) => <option key={size.value} value={size.value}>{t(size.key)}</option>)}</select></SettingControl></section>
      <section className="panel settings-section"><SettingsSectionHead icon={<ShieldCheck/>} title={t("settings.privacyTitle")} text={t("settings.privacyText")}/>
        <SettingControl title={t("settings.secureMode")} text={t("settings.secureModeHint")}>
          <select aria-label={t("settings.secureModeLabel")} disabled={restricted} value={settings.secureMode ? "1" : "0"} onChange={(event) => void onSave({ secureMode: event.target.value === "1" })}>
            <option value="1">{t("settings.secureModeOn")}</option><option value="0">{t("settings.secureModeOff")}</option>
          </select></SettingControl>
      </section>
      <AccountSettings session={session} onSession={onSession} onNotify={onNotify} onError={onError} restricted={restricted}/>
      {!restricted && <section className="panel settings-section backup-section"><SettingsSectionHead icon={<FileJson/>} title={t("settings.backupTitle")} text={t("settings.backupText")}/><p>{t("settings.backupBody")}</p><p className="notice">{t("settings.backupWarning")}</p><div className="setting-actions"><button disabled={backupBusy} onClick={() => void exportSettings()}><Download/> {t("settings.export")}</button><button disabled={backupBusy} onClick={() => importInput.current?.click()}><Upload/> {t("settings.import")}</button><input ref={importInput} className="file-input" type="file" accept="application/json,.json" aria-label={t("settings.pickBackup")} onChange={(event) => void importSettings(event.target.files?.[0])}/></div></section>}
      {!restricted && <DiagnosticsSection build={build} onNotify={onNotify} onError={onError}/>}
    </div>
  </section>;
}


const LOG_LEVELS = [["", "diag.levelAll"], ["INFO", "diag.levelInfo"], ["WARN", "diag.levelWarn"], ["ERROR", "diag.levelError"]] as const satisfies ReadonlyArray<readonly [string, Key]>;
const PERIODS = [[1, "diag.periodHour"], [24, "diag.periodDay"], [168, "diag.periodWeek"], [0, "diag.periodAll"]] as const satisfies ReadonlyArray<readonly [number, Key]>;
const duration = (seconds: number) => seconds >= 86400 ? `${Math.floor(seconds / 86400)} d ${Math.floor((seconds % 86400) / 3600)} h`
  : seconds >= 3600 ? `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min` : `${Math.max(1, Math.round(seconds / 60))} min`;
const since = (at: string) => {
  const seconds = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
  return seconds < 90 ? t("diag.justNow") : t("diag.ago", { duration: duration(seconds) });
};
const clock = (at: string) => at ? new Date(at).toLocaleTimeString(localeTag()) : "";

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return <div className="fact"><dt>{term}</dt><dd>{children}</dd></div>;
}

/** One group of identical messages. It unfolds into the last occurrences with their
 * context, so the ordinary view stays short and the detail is at hand. */
function Issue({ group }: { group: LogGroup }) {
  const [open, setOpen] = useState(false);
  return <li className={`issue ${group.level.toLowerCase()}`}>
    <button className="issue-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className={`level-chip ${group.level.toLowerCase()}`}>{group.level}</span>
      <span className="issue-message">{group.message}</span>
      <span className="issue-count" title={t("diag.sinceCount", { count: group.count, time: clock(group.first) })}>{group.count}×</span>
      <span className="issue-when">{since(group.last)}</span>
      <ChevronDown className={open ? "rotated" : ""}/>
    </button>
    {open && <div className="issue-detail">
      {group.samples.map((sample, index) => <div key={`${sample.at}:${index}`}>
        <span>{clock(sample.at)}</span>
        {sample.context ? <code>{sample.context}</code> : <code className="empty">{t("diag.noContext")}</code>}
      </div>)}
    </div>}
  </li>;
}

/** Diagnostics should first answer "is something broken?" and only then offer the raw log.
 * That does not interest an ordinary user, so both the panel and the log stay hidden until asked for. */
function DiagnosticsSection({ build, onNotify, onError }: { build: BuildInfo | null; onNotify: (message: string) => void; onError: (error: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<Diagnostics | null>(null);
  const [issues, setIssues] = useState<LogGroup[]>([]);
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [hours, setHours] = useState(24);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("");
  const [tail, setTail] = useState(200);
  const [wrap, setWrap] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  // What the server writes down, as opposed to the level above, which only filters what it wrote.
  const [recording, setRecording] = useState("INFO");

  const changeRecording = async (level: string) => {
    const previous = recording;
    setRecording(level);
    try { await api.updateSettings({ logLevel: level as AppSettings["logLevel"] }); onNotify(t("diag.recordLevelSaved", { level })); }
    catch (error) { setRecording(previous); onError(error); }
  };

  const loadOverview = async () => {
    setBusy(true);
    try {
      const [diagnostics, text, saved] = await Promise.all([
        api.diagnostics(), api.logs({ tail: 500, level: "WARN", hours, search: query, inline: true }), api.settings(),
      ]);
      setInfo(diagnostics);
      setRecording(saved.logLevel ?? "INFO");
      setIssues(groupLog(parseLog(text)));
    } catch (error) { onError(error); }
    finally { setBusy(false); }
  };
  const loadLog = async () => {
    setBusy(true);
    try { setLines(parseLog(await api.logs({ tail, level, hours, search: query, inline: true }))); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  };
  // Typing in the search box should not hit the server on every letter.
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 400); return () => clearTimeout(timer); }, [search]);
  // The overview loads even while collapsed; otherwise the header chip would claim "no errors" without looking.
  useEffect(() => { void loadOverview(); }, [hours, query]);
  useEffect(() => { if (open && showLog) void loadLog(); }, [open, showLog, level, tail, hours, query]);

  const refresh = async () => { await loadOverview(); if (showLog) await loadLog(); };
  const copyLog = async () => { try { await copyText(await api.logs()); onNotify(t("diag.logCopied")); } catch (error) { onError(error); } };
  const clearLog = async () => {
    if (!confirm(t("diag.clearLogConfirm"))) return;
    try { await api.clearLogs(); onNotify(t("diag.logCleared")); setLines([]); await loadOverview(); }
    catch (error) { onError(error); }
  };

  const vaapi = info?.playback.vaapi;
  const sessions = info?.playback.sessions ?? [];
  const failed = info?.downloads.failed ?? [];
  const troubled = info?.outbound ?? [];
  const queue = Object.entries(info?.downloads.byStatus ?? {});
  const reports = issues.reduce((sum, issue) => sum + issue.count, 0);
  const worst = issues.some((issue) => issue.level === "ERROR") ? "error" : issues.length ? "warn" : "ok";

  return <section className="panel settings-section diagnostics-section">
    <button className="diagnostics-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      <SettingsSectionHead icon={<FileText/>} title={t("diag.title")} text={t("diag.subtitle")}/>
      {!open && info && <span className={`state-chip ${worst}`}>{worst === "ok" ? t("diag.noErrors") : t("diag.reportCount", { count: reports })}</span>}
      <ChevronDown className={open ? "rotated" : ""}/>
    </button>

    {open && <div className="diagnostics-body">
      <dl className="diagnostics-facts">
        <Fact term={t("diag.version")}>{info?.version ?? build?.version ?? "—"}{build?.commit ? <small> · {build.commit.slice(0, 7)}</small> : null}</Fact>
        <Fact term={t("diag.uptime")}>{info ? duration(info.uptimeSeconds) : "—"}</Fact>
        <Fact term={t("diag.conversion")}>{info?.playback.ffmpeg.version ? `FFmpeg ${info.playback.ffmpeg.version}` : "—"}<small>{vaapi?.device ? ` · GPU ${vaapi.device}` : ` · ${t("diag.software")}`}</small></Fact>
        <Fact term={t("diag.playback")}>{sessions.length ? t("diag.sessionCount", { count: sessions.length }) : t("diag.noSessions")}</Fact>
        <Fact term={t("diag.queue")}>{queue.length ? queue.map(([status, count]) => `${statusLabel(status as DownloadJob["status"])} ${count}`).join(", ") : t("diag.queueEmpty")}</Fact>
        {(info?.storage ?? []).map((disk) => <Fact key={disk.path} term={t("diag.freeSpace", { path: disk.path })}>{bytes(disk.freeBytes)}<small>{disk.totalBytes ? ` ${t("diag.ofTotal", { total: bytes(disk.totalBytes) })}` : ""}</small></Fact>)}
      </dl>

      {sessions.length > 0 && <ul className="diagnostics-list">{sessions.map((session) => <li key={session.id}>
        <strong>{session.title ?? session.id}</strong>
        <span>{session.mode}{session.hardware ? " · GPU" : ""} · {session.video ?? "?"}/{session.audio ?? "?"} · {t("diag.atSecond", { seconds: Math.round(session.offset) })} · {t("diag.idleFor", { seconds: session.idleSeconds })}</span>
      </li>)}</ul>}

      {info?.downloads.halt && <ul className="diagnostics-list"><li>
        <strong>{t("diag.queueHalted")}</strong><span>{serverText(info.downloads.halt.messageKey, info.downloads.halt.message)}</span>
      </li></ul>}

      {failed.length > 0 && <ul className="diagnostics-list">{failed.map((job) => <li key={job.id}>
        <strong>{job.title}</strong><span>{job.error ? serverText(job.errorKey, job.error) : t("diag.errorWithoutDetail")}</span>
      </li>)}</ul>}

      {troubled.length > 0 && <ul className="diagnostics-list">{troubled.map((host) => <li key={host.host}>
        <strong>{host.host}</strong>
        <span>{host.state === "open" ? t("diag.hostOpen", { seconds: host.opensInSeconds ?? 0 })
          : host.state === "half-open" ? t("diag.hostHalfOpen")
          : t("diag.hostFailures", { count: host.failures })}{host.rejected ? ` · ${t("diag.hostRejected", { count: host.rejected })}` : ""}</span>
      </li>)}</ul>}

      <div className="diagnostics-filters">
        <label><span>{t("stats.periodGroup")}</span><select aria-label={t("stats.periodGroup")} value={hours} onChange={(event) => setHours(Number(event.target.value))}>{PERIODS.map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}</select></label>
        <label className="grow"><span>{t("diag.searchMessages")}</span><input type="search" placeholder={t("diag.searchPlaceholder")} value={search} onChange={(event) => setSearch(event.target.value)}/></label>
        <button disabled={busy} onClick={() => void refresh()}><RefreshCw/> {t("common.refresh")}</button>
      </div>

      <div className="issues-head">
        <h4>{t("diag.recentIssues")}</h4>
        {issues.length > 0 && <span className={`state-chip ${worst}`}>{t("diag.reportCount", { count: reports })}</span>}
      </div>
      {issues.length ? <ul className="issues">{issues.slice(0, 12).map((issue) => <Issue key={issue.key} group={issue}/>)}</ul>
        : <p className="issues-empty">{t("diag.noIssues")}</p>}

      <div className="log-toggle">
        <button onClick={() => setShowLog(!showLog)} aria-expanded={showLog}><ChevronDown className={showLog ? "rotated" : ""}/> {t(showLog ? "diag.hideLog" : "diag.showLog")}</button>
        <a className="button" href={logDownloadUrl(showLog ? { tail, level, hours, search: query } : {})}
          title={showLog ? t("diag.downloadShown") : t("diag.downloadAll")} download="stremio-offline.log"><Download/> {t("common.download")}</a>
        <button onClick={() => void copyLog()}><Copy/> {t("common.copy")}</button>
        <button className="danger" onClick={() => void clearLog()}><Trash2/> {t("diag.clearLog")}</button>
      </div>

      {showLog && <div className="log-panel">
        <div className="log-filters">
          <label><span>{t("diag.level")}</span><select aria-label={t("diag.logLevel")} value={level} onChange={(event) => setLevel(event.target.value)}>{LOG_LEVELS.map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}</select></label>
          <label><span>{t("diag.lines")}</span><select aria-label={t("diag.lineCount")} value={tail} onChange={(event) => setTail(Number(event.target.value))}>{[100, 200, 500, 1000].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label><span>{t("diag.recordLevel")}</span><select aria-label={t("diag.recordLevelLabel")} value={recording} onChange={(event) => void changeRecording(event.target.value)}>
            {LOG_LEVELS.filter(([value]) => value).map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
          </select></label>
          <label className="log-wrap"><input type="checkbox" checked={wrap} onChange={(event) => setWrap(event.target.checked)}/><span>{t("diag.wrapLines")}</span></label>
        </div>
        <div className={`log-viewer${wrap ? " wrap" : ""}`} aria-label={t("diag.serverLog")}>
          {lines.length ? lines.map((line, index) => <div className={`log-line ${line.level.toLowerCase()}`} key={`${line.at}:${index}`}>
            <span className="log-time">{clock(line.at)}</span>
            <span className={`level-chip ${line.level.toLowerCase()}`}>{line.level || "—"}</span>
            <span className="log-message">{line.message}</span>
            {line.context && <span className="log-context">{line.context}</span>}
          </div>) : <div className="log-line">{busy ? t("common.loading") : t("diag.noLines")}</div>}
        </div>
        <p>{t("diag.logPrivacy")}{info?.logRetentionDays ? ` ${t("diag.logRetention", { days: info.logRetentionDays })}` : ""}</p>
      </div>}
    </div>}
  </section>;
}

function Addons({ addons, libraries = [], restricted = false, onChanged, onNotify, onError }: { addons: Addon[]; libraries?: LibraryView[]; restricted?: boolean; onChanged: () => Promise<void>; onNotify: (s:string)=>void; onError:(e:unknown)=>void }) {
  const [url, setUrl] = useState(""); const [role, setRole] = useState("both"); const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // A manifest is only read when the addon is added, so nothing here notices when the
  // provider adds a catalogue or stops serving a resource. This asks them all again.
  const refreshAll = async () => {
    setRefreshing(true);
    try {
      const { changed, failed } = await api.refreshAddons();
      await onChanged();
      const done = changed ? t("addons.refreshAllDone", { count: changed }) : t("addons.refreshAllNone");
      onNotify(failed ? `${done} ${t("addons.refreshAllFailed", { count: failed })}` : done);
    } catch (err) { onError(err); }
    finally { setRefreshing(false); }
  };
  const submit = async (e: FormEvent) => { e.preventDefault(); setBusy(true); try { await api.addAddon(url, role); setUrl(""); await onChanged(); onNotify(t("addons.added")); } catch (err) { onError(err); } finally { setBusy(false); } };
  return <section><Heading eyebrow={t("addons.eyebrow")} title={t("addons.title")}/><p className="lead">{t("addons.leadBefore")} <code>manifest.json</code>. {t("addons.leadAfter")}</p>
    {restricted && <p className="notice">{t("restricted.notice")}</p>}
    {!restricted && <form className="panel addon-form" onSubmit={submit}><label><span>{t("addons.manifestUrl")}</span><input value={url} onChange={(e)=>setUrl(e.target.value)} placeholder="https://…/manifest.json" required/></label><label><span>{t("addons.role")}</span><select value={role} onChange={(e)=>setRole(e.target.value)}><option value="both">{t("addons.roleBoth")}</option><option value="catalog">{t("addons.roleCatalog")}</option><option value="source">{t("addons.roleSource")}</option></select></label><button className="primary" disabled={busy}><Plus/> {t("common.add")}</button></form>}
    {!restricted && addons.length > 0 && <div className="addon-tools"><button disabled={refreshing} onClick={() => void refreshAll()}><RefreshCw/> {t(refreshing ? "common.loading" : "addons.refreshAll")}</button></div>}
    {[
      { key: "sources", title: t("addons.streamSources"), text: t("addons.streamSourcesText"), ordered: true, list: addons.filter((addon) => addon.role !== "catalog") },
      { key: "catalogs", title: t("addons.catalogsTitle"), text: t("addons.catalogsText"), ordered: false, list: addons.filter((addon) => addon.role === "catalog") },
    ].filter((group) => group.list.length > 0).map((group) => <div className="addon-group" key={group.key}>
      <div className="subhead"><h3>{group.title}</h3><span>{group.text}</span></div>
      <div className="addon-grid">{group.list.map((addon, index) => restricted
        ? <AddonCardReadOnly key={addon.key} addon={addon}/>
        : <AddonCard key={addon.key} addon={addon} libraries={libraries}
            index={group.ordered ? index : -1} total={group.list.length}
            onChanged={onChanged} onNotify={onNotify} onError={onError}/>)}</div>
    </div>)}
  </section>;
}

function AddonCardReadOnly({ addon }: { addon: Addon }) {
  return <article className="panel addon-card">
    {addon.manifest.logo ? <img src={addon.manifest.logo} alt=""/> : <div className="addon-logo"><PackagePlus/></div>}
    <div className="addon-body"><div className="addon-title"><h3>{addon.manifest.name}</h3>{addon.manifest.behaviorHints?.p2p && <span className="p2p">P2P</span>}</div><p>{addon.manifest.description}</p><small>{addon.manifest.version} · {t(addon.role === "catalog" ? "addons.isCatalog" : addon.role === "source" ? "addons.isSource" : "addons.isBoth")}</small></div>
    {addon.role !== "source" && <label className="switch" title={t("addons.globalSearchHint")}><input aria-label={t("addons.globalSearch")} type="checkbox" checked={addon.globalSearch} disabled readOnly/><span/></label>}
  </article>;
}

function AddonCard({ addon, libraries, index, total, onChanged, onNotify, onError }: { addon: Addon; libraries: LibraryView[]; index: number; total: number; onChanged: () => Promise<void>; onNotify: (s:string)=>void; onError:(e:unknown)=>void }) {
  const clone = (value: AddonDownloadSettings): AddonDownloadSettings => ({ movie: { ...value.movie }, series: { ...value.series } });
  const storedSettings = addon.downloadSettings ?? { movie: { subfolder: "", layout: "structured" }, series: { subfolder: "", layout: "structured" } };
  const [draft, setDraft] = useState<AddonDownloadSettings>(() => clone(storedSettings));
  const [saving, setSaving] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const [manifestOpen, setManifestOpen] = useState(false);
  const [manifestUrl, setManifestUrl] = useState("");
  const [manifestRole, setManifestRole] = useState(addon.role);
  const [manifestBusy, setManifestBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      const result = await api.refreshAddon(addon.key);
      await onChanged();
      onNotify(result.changed ? t("addons.refreshedTo", { addon: result.addon.manifest.name, version: result.version }) : t("addons.refreshUpToDate", { addon: addon.manifest.name }));
    } catch (error) { onError(error); }
    finally { setRefreshing(false); }
  };

  // The interface normally hides the real address because of the token; it is fetched on opening.
  const openManifest = async () => {
    const next = !manifestOpen;
    setManifestOpen(next);
    if (!next || manifestUrl) return;
    try {
      const full = await api.exportAddon(addon.key) as { manifestUrl: string; role: string };
      setManifestUrl(full.manifestUrl); setManifestRole(full.role as Addon["role"]);
    } catch (error) { onError(error); }
  };
  const saveManifest = async () => {
    setManifestBusy(true);
    try { await api.updateAddon(addon.key, { url: manifestUrl.trim(), role: manifestRole }); await onChanged(); onNotify(t("addons.updated")); }
    catch (error) { onError(error); }
    finally { setManifestBusy(false); }
  };
  const exportManifest = async () => {
    try {
      const full = await api.exportAddon(addon.key);
      const blob = new Blob([JSON.stringify(full, null, 2)], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href; link.download = `${addon.manifest.name.replace(/[^\w.-]+/g, "-")}.json`;
      link.click(); URL.revokeObjectURL(href);
      onNotify(t("addons.manifestSaved"));
    } catch (error) { onError(error); }
  };
  const providesStreams = (addon.manifest.resources ?? []).some((resource) => typeof resource === "string" ? resource === "stream" : resource.name === "stream");
  useEffect(() => { if (addon.downloadSettings) setDraft(clone(addon.downloadSettings)); }, [addon.downloadSettings]);
  const change = (kind: "movie" | "series", patch: Partial<AddonDownloadSettings["movie"]>) => setDraft((current) => ({ ...current, [kind]: { ...current[kind], ...patch } }));
  /** Where a rule may point: the same set the server accepts, in the same order, so the
   *  "Default" entry names the library the queue would fall back to. */
  const offered = (kind: "movie" | "series") => libraries
    .filter((library) => library.enabled && !library.unreachable && !library.readOnly && (library.type === kind || library.type === "mixed"))
    .sort((a, b) => a.order - b.order);
  const defaultLibrary = (kind: "movie" | "series") => {
    const available = offered(kind);
    return available.find((library) => (kind === "movie" ? library.defaultMovie : library.defaultSeries)) ?? available[0];
  };
  // A rule may name a library that is no longer offered (switched off, unplugged, removed).
  // It stays visible and stays selected: silently rewriting somebody's rule would be worse.
  const strayLibrary = (kind: "movie" | "series") => {
    const wanted = draft[kind].libraryId;
    return wanted && !offered(kind).some((library) => library.id === wanted) ? libraries.find((library) => library.id === wanted) : undefined;
  };
  const preview = (kind: "movie" | "series") => {
    const rule = draft[kind];
    const folder = rule.subfolder.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    const root = `${(libraries.find((library) => library.id === rule.libraryId) ?? defaultLibrary(kind))?.root ?? t("addons.noLibraryRoot")}${folder ? `/${folder}` : ""}`;
    if (kind === "movie") return rule.layout === "flat" ? `${root}/${t("addons.sampleMovie")}.mkv` : `${root}/${t("addons.sampleMovie")}/${t("addons.sampleMovie")}.mkv`;
    return rule.layout === "flat" ? `${root}/${t("addons.sampleShow")} - S01E01 - ${t("addons.sampleEpisode")}.mkv` : `${root}/${t("addons.sampleShow")}/01 ${t("addons.sampleSeasonFolder")}/01 - ${t("addons.sampleEpisode")}.mkv`;
  };
  const save = async () => { setSaving(true); try { const saved = await api.updateAddon(addon.key, { downloadSettings: draft }); if (saved.downloadSettings) setDraft(clone(saved.downloadSettings)); await onChanged(); onNotify(t("addons.storageSaved", { addon: addon.manifest.name })); } catch (error) { onError(error); } finally { setSaving(false); } };
  return <article className={`panel addon-card ${storageOpen ? "storage-expanded" : ""}`}>
    {addon.manifest.logo ? <img src={addon.manifest.logo} alt="" onError={hideBroken}/> : <div className="addon-logo"><PackagePlus/></div>}
    <div className="addon-body"><div className="addon-title"><h3>{addon.manifest.name}</h3>{addon.manifest.behaviorHints?.p2p && <span className="p2p">P2P</span>}</div><p>{addon.manifest.description || addon.displayUrl}</p><small>{addon.manifest.version} · {t(addon.role === "catalog" ? "addons.isCatalog" : addon.role === "source" ? "addons.isSource" : "addons.isBoth")}</small></div>
    <div className="addon-actions">{index >= 0 && <div className="addon-order">
      <button title={t("addons.higherPriority")} disabled={index === 0} onClick={async()=>{try { await api.moveAddon(addon.key, -1); await onChanged(); } catch (error) { onError(error); }}}><ArrowUp/></button>
      <button title={t("addons.lowerPriority")} disabled={index === total - 1} onClick={async()=>{try { await api.moveAddon(addon.key, 1); await onChanged(); } catch (error) { onError(error); }}}><ArrowDown/></button>
    </div>}<button className="icon-button" title={t("addons.refresh")} disabled={refreshing} onClick={() => void refresh()}><RefreshCw/></button><label className="switch" title={addon.essential ? t("addons.essential") : undefined}><input aria-label={t("addons.enabled")} type="checkbox" checked={addon.enabled} disabled={addon.essential} onChange={async (event)=>{try { await api.toggleAddon(addon.key,event.target.checked); await onChanged(); } catch (error) { onError(error); }}}/><span/></label>{addon.essential
      ? <span className="addon-essential" title={t("addons.essential")}><ShieldCheck/></span>
      : <button className="danger icon-button" title={t("common.remove")} onClick={async()=>{try { await api.deleteAddon(addon.key); await onChanged(); } catch (error) { onError(error); }}}><Trash2/></button>}</div>
    <button className={`storage-toggle ${manifestOpen ? "open" : ""}`} onClick={() => void openManifest()} aria-expanded={manifestOpen}><Link2/> <span>{t("addons.manifestAndExport")}</span><ChevronDown/></button>
    {manifestOpen && <div className="addon-download-settings">
      <div className="addon-download-head"><strong>{t("addons.manifestAddress")}</strong><small>{t("addons.manifestAddressHint")}</small></div>
      <label className="manifest-field"><span>URL</span>
        <input value={manifestUrl} onChange={(event) => setManifestUrl(event.target.value)} placeholder={t("common.loading")} spellCheck={false}/></label>
      <label className="manifest-field"><span>{t("addons.role")}</span>
        <select value={manifestRole} onChange={(event) => setManifestRole(event.target.value as Addon["role"])}>
          <option value="both">{t("addons.roleBoth")}</option><option value="catalog">{t("addons.roleCatalog")}</option><option value="source">{t("addons.roleSource")}</option>
        </select></label>
      {addon.role !== "source" && <div className="global-search-setting"><div><strong>{t("addons.globalSearch")}</strong><small>{t("addons.globalSearchHint")}</small></div><label className="switch"><input aria-label={t("addons.globalSearch")} type="checkbox" checked={addon.globalSearch} onChange={async (event) => { try { await api.updateAddon(addon.key, { globalSearch: event.target.checked }); await onChanged(); } catch (error) { onError(error); } }}/><span/></label></div>}
      <div className="manifest-actions">
        <button className="primary" disabled={manifestBusy || !manifestUrl.trim()} onClick={() => void saveManifest()}><Check/> {t("common.save")}</button>
        <button onClick={async () => { try { await copyText(manifestUrl); onNotify(t("addons.urlCopied")); } catch (error) { onError(error); } }}><Copy/> {t("addons.copyUrl")}</button>
        <button onClick={() => void exportManifest()}><FileJson/> {t("addons.exportJson")}</button>
      </div>
    </div>}
    {providesStreams && <button className={`storage-toggle ${storageOpen ? "open" : ""}`} onClick={() => setStorageOpen((value) => !value)} aria-expanded={storageOpen}><FolderCog/> <span>{t("addons.storageSettings")}</span><ChevronDown/></button>}
    {providesStreams && storageOpen && <div className="addon-download-settings"><div className="addon-download-head"><strong>{t("addons.whereToStore")}</strong><small>{t("addons.whereToStoreHint")}</small></div>
      <div className="download-rule-grid">{(["movie", "series"] as const).map((kind) => {
        const kindLabel = t(kind === "movie" ? "catalog.movies" : "catalog.series");
        const chosen = libraries.find((library) => library.id === draft[kind].libraryId);
        const stray = strayLibrary(kind);
        const fallback = defaultLibrary(kind);
        return <div className="download-rule" key={kind}><b>{kindLabel}</b>
          <label><span>{t("addons.saveTo")}</span>
            <select aria-label={t("addons.saveToLabel", { kind: kindLabel })} value={draft[kind].libraryId ?? ""}
              onChange={(event) => change(kind, { libraryId: event.target.value || undefined })}>
              <option value="">{fallback ? t("addons.saveToDefaultNamed", { name: fallback.name }) : t("addons.saveToDefault")}</option>
              {offered(kind).map((library) => <option key={library.id} value={library.id}>{library.name}</option>)}
              {stray && <option value={stray.id}>{t("addons.saveToUnavailable", { name: stray.name })}</option>}
            </select></label>
          <label className="folder-label"><span>{t("addons.subfolder")}</span><div className="folder-field"><code>{chosen?.root ?? fallback?.root ?? ""}/</code><input aria-label={t("addons.subfolderLabel", { kind: kindLabel })} value={draft[kind].subfolder} onChange={(event) => change(kind, { subfolder: event.target.value })} placeholder={t("addons.subfolderPlaceholder")}/></div></label>
          <label><span>{t("addons.layout")}</span><select aria-label={t("addons.layoutLabel", { kind: kindLabel })} value={draft[kind].layout} onChange={(event) => change(kind, { layout: event.target.value as "flat" | "structured" })}><option value="structured">{t("addons.layoutStructured")}</option><option value="flat">{t("addons.layoutFlat")}</option></select></label>
          <small className="path-preview">{t("addons.example")} <code>{preview(kind)}</code></small></div>;
      })}</div>
      <div className="download-settings-actions"><button onClick={() => { setDraft(clone(storedSettings)); setStorageOpen(false); }}>{t("common.cancel")}</button><button className="primary save-download-settings" disabled={saving} onClick={() => void save()}>{t(saving ? "common.saving" : "settings.saveSettings")}</button></div>
    </div>}
  </article>;
}

function Downloads({ jobs, libraries, halt, refresh, onError, onReveal }: { jobs: DownloadJob[]; libraries: LibraryView[]; halt: QueueHalt | null; refresh: () => Promise<void>; onError: (e: unknown) => void; onReveal: (target: string) => void }) {
  const [expandedJobs, setExpandedJobs] = useState<Record<string, boolean>>({});
  const [completedOpen, setCompletedOpen] = useState(false);
  const [pendingPage, setPendingPage] = useState(1);
  const [completedPage, setCompletedPage] = useState(1);

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("order");
  const [direction, setDirection] = useState("asc");
  const [dateField, setDateField] = useState<"createdAt" | "startedAt" | "completedAt">("createdAt");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [pageSize, setPageSize] = useState(20);
  useEffect(() => { setPendingPage(1); setCompletedPage(1); }, [query, status, sort, direction, dateField, from, to, pageSize]);
  useEffect(() => { if (query.trim() || status === "completed" || from || to) setCompletedOpen(true); }, [query, status, from, to]);
  const duration = (job: DownloadJob) => job.startedAt && job.completedAt ? Math.max(0, Date.parse(job.completedAt) - Date.parse(job.startedAt)) : undefined;
  const filtered = jobs.filter((job) => {
    const date = job[dateField] ? new Date(job[dateField]!) : undefined;
    const day = date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}` : "";
    return (!status || job.status === status) && `${job.title} ${job.target} ${queueDestination(job.target, libraries).library ?? ""}`.toLocaleLowerCase(localeTag()).includes(query.trim().toLocaleLowerCase(localeTag())) && (!from || !!day && day >= from) && (!to || !!day && day <= to);
  }).sort((a, b) => {
    const value = (job: DownloadJob) => sort === "duration" ? duration(job) : sort === "order" ? job.order : sort === "titleSort" ? job.title : job[sort as "createdAt" | "startedAt" | "completedAt"];
    const av = value(a), bv = value(b);
    if (av == null || bv == null) return av == null ? bv == null ? a.order - b.order : 1 : -1;
    const delta = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv), localeTag());
    return delta * (direction === "asc" ? 1 : -1) || a.order - b.order;
  });
  const activeFilters = [query.trim(), status, from, to].filter(Boolean).length;
  const formatDate = (value?: string) => value ? new Date(value).toLocaleString(localeTag(), { dateStyle: "short", timeStyle: "short" }) : "—";
  const active = jobs.filter((job) => job.status === "checking" || job.status === "downloading"); const totalSpeed = active.reduce((sum, job) => sum + job.speed, 0); const eta = (job: DownloadJob) => job.speed > 0 && job.total ? fmtEta((job.total - job.received) / job.speed) : "—";
  const action = async (operation: () => Promise<void>) => { try { await operation(); await refresh(); } catch (error) { onError(error); } };
  const groups = {
    active: filtered.filter((job) => job.status === "checking" || job.status === "downloading"),
    pending: filtered.filter((job) => job.status !== "checking" && job.status !== "downloading" && job.status !== "completed"),
    completed: filtered.filter((job) => job.status === "completed"),
  };
  useEffect(() => setPendingPage((page) => Math.min(page, Math.max(1, Math.ceil(groups.pending.length / pageSize)))), [groups.pending.length, pageSize]);
  useEffect(() => setCompletedPage((page) => Math.min(page, Math.max(1, Math.ceil(groups.completed.length / pageSize)))), [groups.completed.length, pageSize]);
  const renderJob = (job: DownloadJob) => <div className={`download-row ${expandedJobs[job.id] ? "details-expanded" : ""}`} data-status={job.status} key={job.id}><div className="download-job">{job.status === "completed" && job.target ? <button className="link-button job-link" title={t("downloads.showInLibrary")} onClick={() => onReveal(job.target)}><span>{job.title}</span></button> : <strong>{job.title}</strong>}<div id={`queue-details-${job.id}`} className="queue-job-details">{job.target ? <>{queueDestination(job.target, libraries).library && <small className="queue-job-library"><Library aria-hidden="true"/> {queueDestination(job.target, libraries).library}</small>}<small>{queueDestination(job.target, libraries).path}</small></> : <small>{job.pending ? t("downloads.sourcePickedLater") : ""}</small>}{job.resolution?.audioLanguage && <small>{t(job.resolution.fallbackUsed ? "downloads.checkedFallbackSource" : "downloads.checkedSource", { audio: label(job.resolution.audioLanguage), count: job.resolution.checkedCandidates })}{job.resolution.subtitleLanguage ? ` · ${t("downloads.subtitleReady", { language: label(job.resolution.subtitleLanguage) })}` : job.resolution.subtitleStatus === "missing" ? ` · ${t("downloads.subtitleMissing")}` : ""}</small>}<dl className="queue-times">{(["createdAt", "startedAt", "completedAt"] as const).map((field) => <div key={field}><dt>{t(`downloads.${field}`)}</dt><dd>{formatDate(job[field])}</dd></div>)}<div><dt>{t("downloads.duration")}</dt><dd>{duration(job) == null ? "—" : t("downloads.durationValue", { hours: Math.floor(duration(job)! / 3600000), minutes: Math.floor(duration(job)! / 60000) % 60, seconds: Math.floor(duration(job)! / 1000) % 60 })}</dd></div></dl></div>{job.pauseReason === "library" && <small className="queue-job-paused">{t("downloads.pausedLibrary")}</small>}{job.error && <small className="queue-job-error">{serverText(job.errorKey, job.error, job.errorVars)}</small>}</div><span className={`job-status ${job.status}`}>{statusLabel(job.status)}</span><div className="download-progress"><span>{job.status === "waiting" ? `${job.debridProgress ?? 0} %` : `${bytes(job.received)} / ${bytes(job.total)}`}</span><div className="progress"><i style={{width:`${job.status === "waiting" ? Math.min(100, job.debridProgress ?? 0) : job.total ? Math.min(100, job.received/job.total*100):0}%`}}/></div></div><span className="download-speed">{speed(job.speed)}{job.segments && job.segments > 1 ? <i className="segment-tag" title={t("downloads.segments", { count: job.segments })}>{`\u00d7${job.segments}`}</i> : null}<small>{eta(job)}</small></span><div className="queue-actions"><button className="queue-details-toggle" aria-expanded={!!expandedJobs[job.id]} aria-controls={`queue-details-${job.id}`} onClick={() => setExpandedJobs((current) => ({ ...current, [job.id]: !current[job.id] }))}>{t("downloads.details")}<ChevronDown aria-hidden="true"/></button>{job.status === "completed" && job.target && <button title={t("downloads.showInLibrary")} onClick={() => onReveal(job.target)}><HardDrive/></button>}{job.status !== "completed" && job.status !== "downloading" && job.status !== "checking" && <><button className="queue-priority" title={t("downloads.moveUp")} disabled={sort !== "order" || direction !== "asc" || job.order === 0} onClick={() => action(() => api.moveDownload(job.id, -1))}><ArrowUp/></button><button className="queue-priority" title={t("downloads.moveDown")} disabled={sort !== "order" || direction !== "asc" || job.order === jobs.length - 1} onClick={() => action(() => api.moveDownload(job.id, 1))}><ArrowDown/></button></>}{job.status === "checking" || job.status === "downloading" || job.status === "queued" || job.status === "waiting" ? <button title={t("player.pause")} onClick={() => action(() => api.downloadAction(job.id,"pause"))}><Pause/></button> : job.status === "paused" ? <button title={t("library.continue")} onClick={() => action(() => api.downloadAction(job.id,"resume"))}><Play/></button> : job.status === "failed" ? <button title={t("downloads.retry")} onClick={() => action(() => api.downloadAction(job.id,"retry"))}><RefreshCw/></button> : null}<button className="danger" title={t("downloads.removeFromQueue")} onClick={() => action(() => api.removeDownload(job.id))}><Trash2/></button></div></div>;
  return <section className="downloads-page"><div className="download-title"><Heading eyebrow={t("downloads.eyebrow")} title={t("downloads.title")}/><button disabled={!jobs.some((job) => job.status === "completed")} onClick={() => action(api.clearCompleted)}><Trash2/> {t("downloads.clearCompleted")}</button></div>{halt && <div className="queue-halt" role="status">{serverText(halt.messageKey, halt.message)} {t("downloads.haltResumes")}</div>}<details className="queue-filters"><summary>{t("downloads.filters")}<span>{activeFilters > 0 && t("downloads.activeFilters", { count: activeFilters })}{sort !== "order" || direction !== "asc" ? ` · ${t(`downloads.${sort}` as Key)} (${t(direction === "asc" ? "downloads.asc" : "downloads.desc")})` : ""}</span><ChevronDown aria-hidden="true"/></summary><div className="queue-tools">
    <label>{t("downloads.search")}<input value={query} onChange={(e) => setQuery(e.target.value)}/></label>
    <label>{t("downloads.filterStatus")}<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">{t("downloads.all")}</option>{(["queued", "waiting", "checking", "downloading", "paused", "completed", "failed"] as const).map((value) => <option key={value} value={value}>{statusLabel(value)}</option>)}</select></label>
    <label>{t("downloads.sort")}<select value={sort} onChange={(e) => setSort(e.target.value)}>{(["order", "titleSort", "createdAt", "startedAt", "completedAt", "duration"] as const).map((value) => <option key={value} value={value}>{t(`downloads.${value}`)}</option>)}</select></label>
    <label>{t("downloads.direction")}<select value={direction} onChange={(e) => setDirection(e.target.value)}><option value="asc">{t("downloads.asc")}</option><option value="desc">{t("downloads.desc")}</option></select></label>
    <label>{t("downloads.dateField")}<select value={dateField} onChange={(e) => setDateField(e.target.value as typeof dateField)}>{(["createdAt", "startedAt", "completedAt"] as const).map((value) => <option key={value} value={value}>{t(`downloads.${value}`)}</option>)}</select></label>
    <label className="queue-date">{t("downloads.from")}<input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)}/></label>
    <label className="queue-date">{t("downloads.to")}<input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)}/></label>
    <label>{t("downloads.pageSize")}<select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>{[20, 50, 100].map((size) => <option key={size}>{size}</option>)}</select></label>
    <button onClick={() => { setQuery(""); setStatus(""); setFrom(""); setTo(""); }}>{t("downloads.reset")}</button>
  </div></details>
    <div className="queue-blocks" role="region" aria-label={t("downloads.queueLabel")}>
      {(["active", "pending", "completed"] as const).map((group) => {
        const items = groups[group];
        const isHistory = group === "completed";
        const pages = Math.max(1, Math.ceil(items.length / pageSize));
        const page = Math.min(isHistory ? completedPage : pendingPage, pages);
        const open = !isHistory || completedOpen;
        const visible = group === "active" ? items : items.slice((page - 1) * pageSize, page * pageSize);
        const changePage = (value: number) => {
          (isHistory ? setCompletedPage : setPendingPage)(value);
          document.getElementById(`queue-${group}`)?.scrollIntoView({ block: "start" });
        };
        return <section key={group} id={`queue-${group}`} className={`queue-block queue-block-${group}`} aria-labelledby={`queue-heading-${group}`}>
          <div className="queue-block-head">
            <h3 id={`queue-heading-${group}`}>{isHistory ? <button className="queue-history-toggle" aria-expanded={completedOpen} aria-controls="queue-completed-content" onClick={() => setCompletedOpen((value) => !value)}><Check aria-hidden="true"/>{t("downloads.section.completed")}<span className="queue-count">{items.length}</span><ChevronDown aria-hidden="true"/></button> : <><span className="queue-state-dot" aria-hidden="true"/>{t(`downloads.section.${group}`)}<span className="queue-count">{items.length}</span></>}</h3>
            {group === "active" && active.length > 0 && <span className="queue-live-speed">{speed(totalSpeed)}</span>}
          </div>
          {group === "pending" && items.some((job) => job.status === "paused" || job.status === "failed") && <p className="queue-block-hint">{t("downloads.pendingHint")}</p>}
          <div id={`queue-${group}-content`} hidden={!open}>
            {items.length ? <div className="downloads queue-block-list">{visible.map(renderJob)}</div> : <p className="queue-block-empty">{t(activeFilters ? "downloads.noMatches" : `downloads.empty.${group}`)}</p>}
            {group !== "active" && items.length > pageSize && <div className="queue-pagination"><span role="status">{t("downloads.page", { page, pages, count: items.length })}</span><button disabled={page <= 1} onClick={() => changePage(page - 1)}>{t("downloads.previous")}</button><button disabled={page >= pages} onClick={() => changePage(page + 1)}>{t("downloads.next")}</button></div>}
          </div>
        </section>;
      })}
    </div>
  </section>;

}
const fmtEta = (seconds: number) => seconds < 60 ? `${Math.ceil(seconds)} s` : seconds < 3600 ? `${Math.ceil(seconds / 60)} min` : `${Math.floor(seconds / 3600)} h ${Math.ceil((seconds % 3600) / 60)} min`;
const statusLabel = (status: DownloadJob["status"]) => t(({ queued: "downloads.status.queued", waiting: "downloads.status.waiting", checking: "downloads.status.checking", downloading: "downloads.status.downloading", paused: "downloads.status.paused", completed: "downloads.status.completed", failed: "downloads.status.failed" } as const)[status]);
