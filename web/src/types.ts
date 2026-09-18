import type { Locale } from "./i18n";
export type DownloadLayout = "flat" | "structured";
export interface DownloadTargetSettings {
  subfolder: string;
  layout: DownloadLayout;
  /** Library the finished file goes to; absent means the default for the kind. */
  libraryId?: string;
}
export interface AddonDownloadSettings { movie: DownloadTargetSettings; series: DownloadTargetSettings }
export interface Addon {
  key: string; role: "catalog" | "source" | "both"; enabled: boolean; globalSearch: boolean; displayUrl?: string;
  showInContinueWatching?: boolean;
  /** Cinemeta: the interface hides its remove and off switches. */
  essential?: boolean;
  configurable?: boolean; downloadSettings?: AddonDownloadSettings; manifest: { id: string; name: string; version: string; description?: string; logo?: string; resources?: Array<string | { name: string }>; catalogs?: Array<{ id: string; type: string; name?: string }>; behaviorHints?: { p2p?: boolean } };
}
export interface Catalog { addonKey: string; addonName: string; type: string; id: string; name?: string; extra?: Array<{ name: string; isRequired?: boolean; options?: string[] }> }
export interface SearchableCatalog { addonKey: string; addonName: string; globalSearch: boolean; type: string; id: string; name: string }
export interface Meta {
  id: string; type: string; name: string; poster?: string; background?: string; description?: string; releaseInfo?: string;
  nameLanguage?: string;
  year?: string | number; genres?: string[]; videos?: Video[];
  addonName?: string; sources?: string[]; [key: string]: unknown;
}
export interface SearchResult { items: Meta[]; cursor: string; hasMore: boolean; sources: number }
export interface Video { id?: string; title?: string; name?: string; season?: number; episode?: number; released?: string; overview?: string; thumbnail?: string; [key: string]: unknown }
export interface Subtitle { subtitleId: string; lang?: string; addonName?: string }
/** One site worth checking before watching, in the order the server sent it. */
export interface SiteLink { site: "csfd" | "tmdb" | "imdb"; url: string }
export interface Trailer { youtubeId: string; title?: string; provider: "cinemeta" | "tmdb" }
export interface Stream {
  sourceId: string; kind: "remote" | "library" | "torrent" | "unsupported"; playable: boolean; localPath?: string; name?: string; title?: string; description?: string;
  subtitles?: Subtitle[]; addonKey?: string; addonName?: string;
  behaviorHints?: { notWebReady?: boolean; filename?: string; videoSize?: number; bingeGroup?: string };
}
export interface QueueHalt { reason: "storage"; at: string; message: string; messageKey?: string }
export interface Download {
  id: string; title: string; status: "queued" | "waiting" | "checking" | "downloading" | "paused" | "completed" | "failed";
  target: string; received: number; total?: number; speed: number; order: number;
  error?: string; errorKey?: string; errorVars?: Record<string, string | number>;
  pauseReason?: "user" | "storage" | "library"; pending?: boolean; debridProgress?: number;
  /** How many connections the file is being split across; missing while it runs over one. */
  segments?: number;
  resolution?: { checkedCandidates: number; audioLanguage?: string; fallbackUsed?: boolean; audioEvidence?: "probe" | "listing" | "none"; subtitleLanguage?: string; subtitleSource?: "embedded" | "addon"; subtitleStatus?: "ready" | "missing" };
  createdAt: string; updatedAt: string; startedAt?: string; completedAt?: string;
}
export type SubtitleMode = "off" | "optional" | "required";
export type AudioMode = "strict" | "listed" | "preferred";
export type DownloadSourceStrategy = "priority" | "largest";
export interface DownloadSelection {
  addonKeys: string[];
  sourceStrategy: DownloadSourceStrategy;
  audioLanguage: string;
  fallbackAudioLanguage?: string;
  audioMode?: AudioMode;
  subtitleMode: SubtitleMode;
  subtitleLanguage?: string;
  fallbackSubtitleLanguage?: string;
}
export interface DownloadSnapshot { jobs: Download[]; halt: QueueHalt | null }

export type PlaybackMode = "direct" | "remux" | "transcode";
export type TileSize = "compact" | "small" | "medium" | "large";
export type TileShape = "poster" | "wide";
export interface Track { index: number; codec: string; language?: string; title?: string; channels?: number; default?: boolean; forced?: boolean }
export interface Inspection { duration?: number; video?: { codec: string; width?: number; height?: number }; audioTracks: Track[]; subtitleTracks: Track[] }
export interface BuildInfo { status: string; version: string; builtAt?: string; commit?: string; restricted?: boolean }
export interface DiagnosticsSession {
  id: string; mode: string; hardware: boolean; generation: number; title?: string;
  video?: string; audio?: string; audioTrack: number; subtitleTrack: number | null; quality: number | null;
  offset: number; idleSeconds: number;
}
export interface Diagnostics {
  version: string; builtAt?: string; commit?: string; node: string;
  uptimeSeconds: number; memoryMb: number; logLevel: string; logRetentionDays: number;
  playback: {
    ffmpeg: { version?: string; initialBurst: boolean };
    vaapi: { device?: string; scaling: boolean; bitrate: boolean; failures: number };
    sessions: DiagnosticsSession[];
  };
  downloads: { total: number; byStatus: Record<string, number>; halt: QueueHalt | null; failed: Array<{ id: string; title: string; error?: string; errorKey?: string }> };
  addons: Array<{ name: string; role: string; enabled: boolean }>;
  outbound: Array<{ host: string; state: "closed" | "open" | "half-open"; active: number; queued: number; failures: number; rejected: number; opened: number; opensInSeconds?: number }>;
  storage: Array<{ path: string; freeBytes?: number; totalBytes?: number }>;
}
export interface StatsWindow { bytes: number; count: number }
export interface StatsBucket { key: string; label: string; bytes: number; count: number }
export interface StatsSeries { key: string; label: string; points: number[] }
export interface StatsSummary {
  hour: StatsWindow; day: StatsWindow; week: StatsWindow; month: StatsWindow; total: StatsWindow;
  step: "minute" | "hour" | "day";
  points: Array<{ at: string; bytes: number; count: number }>;
  providers: StatsBucket[]; addons: StatsBucket[]; sources: StatsBucket[];
  byProvider: StatsSeries[]; byAddon: StatsSeries[]; bySource: StatsSeries[];
  since?: string;
}
/** One playback running at this moment; the statistics page polls these. */
export interface ActiveStream {
  id: string; title: string; source: "download" | "catalog" | "library";
  provider?: string; addonName?: string;
  mode: "direct" | "remux" | "transcode"; hardware: boolean; quality: number | null;
  duration?: number; startedAt: string; idleSeconds: number; bytes: number; rate: number;
}
export interface Settings {
  concurrentDownloads: number; parallelPerProvider: number; downloadSegments: number; uiLanguage: Locale; audioLanguage: string; subtitleLanguage: string; downloadTitleLanguage: "ui" | string;
  mergeByName: boolean; streamSort: string; trackProgress: boolean; showResumeRow: boolean; libraryAutoScan: boolean; libraryScanPauseOnDownload: boolean;
  secureMode: boolean;
  /** What the server writes down, as opposed to what the log view filters back out. */
  logLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR";
  addonRefreshHours: number;
  catalogTileSize: TileSize; libraryTileSize: TileSize;
  catalogTileShape: TileShape; libraryTileShape: TileShape;
  realDebridConfigured: boolean; tmdbConfigured: boolean;
}
export type SettingsPatch = Partial<Omit<Settings, "realDebridConfigured" | "tmdbConfigured">> & { realDebridToken?: string; tmdbApiKey?: string };
export interface SettingsBackup {
  format: "stremio-offline-settings"; version: 1; exportedAt: string; settings: Settings;
  addons: Array<{ manifestUrl: string; role: Addon["role"]; enabled: boolean; globalSearch: boolean; addedAt: string; downloadSettings: AddonDownloadSettings }>;
}
export interface Capabilities { h264: boolean; hevc: boolean; hevc10: boolean; vp8: boolean; vp9: boolean; av1: boolean; aac: boolean; mp3: boolean; opus: boolean; vorbis: boolean; ac3: boolean; eac3: boolean; flac: boolean }
export interface PlaybackSession {
  id: string; mode: PlaybackMode; url: string; offset: number; duration?: number; video?: string; audio?: string; hardware: boolean; acceleration: boolean;
  audioTracks: Track[]; subtitleTracks: Track[]; audioTrack: number; subtitleTrack: number | null;
  quality: number | null; sidecarUrl?: string; subtitleIds?: Record<string, string>;
  /** `url` addresses a playlist, so the element cannot simply be handed it. */
  playlist?: boolean;
}

export interface Session { username: string; language?: Locale }
/** A fresh install answers with the setup order instead of a session. Both carry the
 *  stored language: the sign-in and setup screens render before any other call. */
export type AuthStatus = (Session | { setup: true }) & { language?: Locale };

export interface LibraryFile { path: string; label: string; season: number | null; episode: number | null; size: number; modified: string }
export interface LibrarySummary {
  key: string; kind: "movie" | "series" | "collection"; title: string; fileCount: number; size: number; modified: string;
  poster?: string;
  meta?: { type: string; id: string; name?: string; poster?: string; background?: string; description?: string; year?: string };
}
export interface LibraryPage extends LibrarySummary { files: LibraryFile[]; total: number }
export type LibraryMatch = "unmatched" | "matched" | "suggested" | "rejected";
export interface MatchSuggestion { type: string; id: string; name: string; year?: number; score: number }
export interface BrowseMeta {
  year?: string; description?: string; catalogName?: string; match?: LibraryMatch; skipLookup?: boolean; skipMosaic?: boolean; suggestion?: MatchSuggestion;
  /** The kind of the title this row is bound to. Absent when nothing is bound, and the
   *  move dialog then offers every library rather than refusing on a guess. */
  titleType?: "movie" | "series";
}
export interface BrowseFolder extends BrowseMeta { path: string; name: string; fileCount: number; size: number; poster?: string; wide?: string }
export interface BrowseFile extends LibraryFile, BrowseMeta {
  poster?: string; wide?: string; progress?: { position: number; duration: number };
  /** The show this episode belongs to, on a Continue watching row only. */
  series?: { name: string };
}
export type LibraryType = "movie" | "series" | "mixed";
/** One configured library as a row of the browse root. Only shown while more than one is
 *  configured; a single-library install still opens straight into the tree. */
export interface BrowseLibrary {
  kind: "library"; libraryId: string; name: string; label: string; type: LibraryType;
  enabled: boolean; fileCount: number; titles: number; size: number;
  unreachable: boolean; readOnly: boolean; path: string; poster?: string; posters?: string[];
}
/** One library in `GET /api/libraries`. `root` is absent in restricted mode. */
export interface LibraryView {
  id: string; name: string; type: LibraryType; root?: string; enabled: boolean; order: number;
  addedAt: string; writeArtwork: boolean; mosaic?: boolean; showInContinueWatching?: boolean; unreachable: boolean; readOnly: boolean;
  defaultMovie: boolean; defaultSeries: boolean; titles: number; files: number; bytes: number;
}
export type BrowseItem =
  | ({ kind: "folder"; favorite?: boolean } & BrowseFolder)
  | ({ kind: "file"; favorite?: boolean } & BrowseFile)
  | BrowseLibrary;
/** One entry of the settings backup: ids do not travel, roots do. */
export interface LibraryGrant { path: string; source: "env" | "user"; grantedAt: string; writable: boolean }
/** One row of the root picker. `libraryRoot` marks the folder that is a library's root. */
export interface GrantEntry { name: string; path: string; writable: boolean; source?: "env" | "user"; libraryId?: string; libraryRoot?: boolean }
export interface GrantBrowse { path: string; parent: string | null; entries: GrantEntry[] }
export interface LibraryEstimate { root: string; type: LibraryType; titles: number; identified: number; files: number; truncated: boolean }
export interface IdentityPreview {
  path: string; key: string; kind: "movie" | "series"; file: boolean; label: string;
  parsed: { title: string; query: string; year?: number; season?: number; episode?: number };
  match: LibraryMatch;
  bound?: { type: string; id: string; name?: string; season?: number; episode?: number };
  suggestion?: MatchSuggestion;
}
export interface SuggestionRow { key: string; label: string; suggestion: MatchSuggestion }
export interface ScanState {
  status: "idle" | "running" | "paused" | "completed" | "failed";
  pauseReason?: "playback" | "download" | "breaker" | "operation";
  startedAt?: string; finishedAt?: string; updatedAt?: string;
  total: number; done: number; matched: number; skipped: number; failed: number;
  current?: string; remaining: string[]; error?: string;
}
export type LibraryOp =
  | { op: "move" | "copy"; items: string[]; target: string; confirmTypeMismatch?: boolean }
  | { op: "delete" | "unmatch" | "artwork" | "forget"; items: string[] }
  | { op: "favorite"; items: string[]; favorite: boolean }
  | { op: "match"; items: string[]; type: string; id: string }
  | { op: "skipLookup"; items: string[]; skipLookup: boolean }
  | { op: "mosaic"; items: string[]; mosaic: boolean }
  | { op: "reroot"; items: string[]; libraryId: string; from: string; to: string };
export interface LibraryOpsState {
  id: string; op: LibraryOp["op"];
  status: "running" | "paused" | "completed" | "failed" | "cancelled";
  pauseReason?: "queue" | "playback" | "download" | "library";
  total: number; done: number; failed: number; bytes: number; bytesTotal: number;
  current?: string; startedAt: string; finishedAt?: string;
  results: Array<{ path: string; ok: boolean; to?: string; error?: string; errorKey?: string }>;
}
/** One destination in the move dialog. Unlike a browsed folder it may hold no video at all. */
export interface LibraryFolder { path: string; name: string }

export interface BrowseResult { path: string; items: BrowseItem[]; total: number; pending: boolean }
export type LibrarySort = "name" | "added" | "size" | "random";
/** `pending` marks the row a finished episode left behind: the next episode of the show,
 *  not yet started. It carries no position and draws no progress bar. */
export interface ProgressEntry { key: string; position: number; duration: number; title: string; path?: string; poster?: string; addonKey?: string; series?: { id: string; name: string; season: number; episode: number }; pending?: true; updatedAt: string }
export interface WatchlistEntry { key: string; type: string; id: string; name: string; poster?: string; addedAt: string }
