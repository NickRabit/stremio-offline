import type { Locale } from "./i18n";
import type { DownloadSnapshot as ServerDownloadSnapshot, PublicDownload } from "../../server/src/api-types";
import type { HomeLayout } from "../../server/src/home";
import type { MediaServerConfigurationExport } from "../../server/src/media-server-store";
import type { DownloadRules as ServerDownloadRules, RulePreference, RuleResolution } from "../../server/src/download-rules";
import type { SourcePolicyV1 } from "../../server/src/source-policy";
export type { FavoriteCatalogItem, FavoriteItem, FavoriteLibraryItem, FavoriteRemoteItem } from "../../server/src/favorites";
export type { RemoteHomeCard, ResumeCard } from "../../server/src/home";
/** What the interface offers: the kind of title. The server keeps answering the card kinds an
 *  older TV build asks for, and the web app never sends them. */
export type FavoriteFilter = "all" | "movies" | "series";
export type ResumeFilter = "all" | "movies" | "series";
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
  showOnHome?: boolean;
  homeCatalogs?: string[];
  /** The accounts this addon is granted to. Absent or empty means administrators only:
   *  there is no sentinel for "everybody", so a grant is always a list of ids. */
  allowedUsers?: string[];
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
export interface TitlePerson {
  name: string;
  role: "cast" | "director" | "creator" | "writer" | "novel";
  character?: string;
  photo?: string;
}
export interface RelatedTitle {
  type: "movie" | "series";
  id: string;
  name: string;
  year?: string;
  poster?: string;
  inLibrary?: boolean;
}
export interface TitleRatings {
  imdb?: string;
  tmdb?: number;
  tmdbVotes?: number;
}
export interface TitleVideo {
  key: string;
  name: string;
  kind: "trailer" | "teaser" | "clip" | "featurette" | "behindTheScenes";
  thumbnail: string;
  language?: string;
}
export interface TitleExtras {
  people: TitlePerson[];
  related: RelatedTitle[];
  ageRating?: string;
  /** The region the age rating was issued for, as an ISO region code. */
  ageRatingRegion?: string;
  originalTitle?: string;
  originalLanguage?: string;
  nextEpisode?: { season: number; episode: number; name?: string; released: string };
  /** Absent on an answer from a server that predates the ratings row. */
  ratings?: TitleRatings;
  /** Absent on an answer from a server that predates the trailers row. */
  videos?: TitleVideo[];
  source: "tmdb" | "addon";
}
export interface SearchResult { items: Meta[]; cursor: string; hasMore: boolean; sources: number }
export interface CatalogSearchRequest {
  query: string;
  type?: "movie" | "series";
  scope?: { addonKey: string; catalogType?: string; catalogId?: string };
  slotId: string;
  generation: number;
}
export interface CatalogSearchSnapshot {
  revision: number;
  state: "partial" | "complete";
  items: Meta[];
  sources: number;
  pending: number;
  failed: number;
  hasMore: boolean;
}
export type CatalogSearchPollResult =
  | { changed: false; revision: number }
  | { changed: true; revision?: number; snapshot: CatalogSearchSnapshot };
export type SearchSourceClass = "catalog" | "local" | "remote";
export type SearchKind = "movie" | "series" | "episode" | "season" | "folder" | "file";
export type SearchKindFilter = "all" | "movie" | "series";
export type SearchSourceState =
  | "queued"
  | "loading"
  | "ready"
  | "exhausted"
  | "stalled"
  | "failed"
  | "timedOut"
  | "indexing"
  | "unavailable";
export interface SearchStartBody {
  query: string;
  kind: SearchKindFilter;
  sources: SearchSourceClass[];
  slotId: string;
  generation: number;
  scope?: { addonKey: string; catalogType?: string; catalogId?: string };
  library?: { libraryId: string; path?: string } | { libraryId: string; parentId?: string };
}
export type SearchLocator =
  | { kind: "catalog"; addonKey: string; type: string; id: string; catalogId?: string }
  | { kind: "local"; key: string; libraryId: string; itemKind: "file" | "folder" }
  | { kind: "remote"; libraryId: string; itemId: string; itemType: string; provider?: "jellyfin" | "emby" };
export interface SearchSourceView {
  id: string;
  sourceClass: SearchSourceClass;
  label: string;
  state: SearchSourceState;
  loaded: number;
  hasMore: boolean;
  continuation: "supported" | "unsupported" | "blocked";
  stale?: boolean;
  retryable: boolean;
  errorCode?: string;
  dropped?: number;
}
export interface SearchClusterView {
  key: string;
  kind: SearchKind;
  title: string;
  originalTitle?: string;
  year?: number;
  poster?: string;
  background?: string;
  sourceLabels: string[];
  hasLocal: boolean;
  hasRemote: boolean;
  memberCount: number;
  primaryMemberKey: string;
  memberKeys: string[];
  rank: number;
  score: number;
  rating?: number;
  episodeCount?: number;
  itemCount?: number;
}
export interface SearchSnapshot {
  revision: number;
  state: "partial" | "complete" | "failed";
  sources: SearchSourceView[];
  clusters: SearchClusterView[];
  unidentified: SearchClusterView[];
  aliases: Array<{ retired: string; current: string }>;
  limitReached: boolean;
}
export type SearchPollResult =
  | { changed: false; revision: number }
  | { changed: true; snapshot: SearchSnapshot };
export interface SearchMember {
  memberKey: string;
  sourceId: string;
  sourceClass: SearchSourceClass;
  sourceLabel: string;
  kind: SearchKind;
  title: string;
  year?: number;
  poster?: string;
  description?: string;
  parentIds?: { imdb?: string; tmdb?: string; tvdb?: string };
  season?: number;
  episode?: number;
  episodeEnd?: number;
  conflict?: boolean;
  locator: SearchLocator;
}
export interface SearchMemberPage {
  clusterKey: string;
  members: SearchMember[];
  nextFrom?: number;
  truncated: boolean;
  canonical?: { type: "movie" | "series"; id: string; name: string; poster?: string };
}
export interface Video { id?: string; title?: string; name?: string; season?: number; episode?: number; released?: string; overview?: string; thumbnail?: string; [key: string]: unknown }
export interface Subtitle { subtitleId: string; lang?: string; addonName?: string }
/** One site worth checking before watching; the interface draws them in its own fixed order. */
export interface SiteLink { site: "csfd" | "tmdb" | "imdb"; url: string }
export interface Trailer { youtubeId: string; title?: string; provider: "cinemeta" | "tmdb" }
export type SourceRuleReason =
  | "language"
  | "resolutionLow"
  | "resolutionHigh"
  | "cinema"
  | "subtitles"
  | "sample"
  | "size"
  | "provider"
  | "torrent"
  | "codec"
  | "hdr";
export interface SourceRuleVerdict {
  profileId: string;
  status: "meets" | "unverified" | "breaks";
  reasons: SourceRuleReason[];
  rank: number[];
}
export interface VideoFacts {
  heightPixels?: number;
  codec?: "h264" | "hevc" | "av1";
  range?: "hdr" | "dolbyVision";
}
export interface Stream {
  sourceId: string; kind: "remote" | "library" | "torrent" | "unsupported"; playable: boolean; localPath?: string; libraryName?: string; name?: string; title?: string; description?: string;
  subtitles?: Subtitle[]; audioLanguages?: string[]; subtitleLanguages?: string[]; audioLanguagesGuessed?: boolean; addonKey?: string; addonName?: string;
  behaviorHints?: { notWebReady?: boolean; filename?: string; videoSize?: number; bingeGroup?: string };
  /** The same source's handle in every session, minted by the server: a position stored with it
   *  resumes from this source again. */
  stableKey?: string;
  /** Set on a source that belongs to a remote Jellyfin/Emby library, never on an addon stream. */
  provider?: MediaServerProvider;
  libraryId?: string;
  /** Preselected destination for a copy of this source, resolved by the server from the remote
   *  library's own setting or its kind's default. Only a preselection: the queue call re-resolves
   *  it and every admission is proved again. */
  downloadLibraryId?: string;
  /** The whole destination rule a copy of this source takes when the caller names no target: the
   *  library, its subfolder and the storage layout, all resolved by the server. Only a
   *  preselection; the queue call re-resolves it and every admission is proved again. */
  downloadTarget?: DownloadTargetSettings;
  /** What this source may be used for. Absent on every non-remote stream. */
  capabilities?: RemoteCapabilities;
  /** The remote identity a player reports position and favorites against; only a remote source carries one. */
  remoteItem?: RemoteStreamContext;
  videoFacts?: VideoFacts;
  rules?: Record<string, SourceRuleVerdict>;
}

export type MediaServerProvider = "jellyfin" | "emby";
export type MediaServerStatus = "disabled" | "available" | "unavailable" | "reauthentication-required" | "identity-changed";
/** How a native remote listing walks the upstream tree. `folders` keeps the provider's own
 *  hierarchy; `titles` flattens one directory and hides folders. */
export type RemoteBrowseMode = "folders" | "titles";
export type RemoteBrowseSort = "name" | "added" | "size";
export type RemoteBrowseOrder = "asc" | "desc";
/** One connection as the administrator list answers it, runtime status included. */
export interface MediaServerConnection {
  id: string; provider: MediaServerProvider; name: string; baseUrl: string;
  allowLan: boolean; allowLoopback: boolean;
  serverId?: string; accountId?: string; enabled: boolean; generation: number; configured: boolean;
  status: MediaServerStatus;
}
/** One library the stored account can currently see, from a discovery call. */
export interface ProviderLibrary { id: string; name: string; type: LibraryType }
/** One attached remote library as the administrator list answers it. */
export interface AdminRemoteLibrary {
  id: string; connectionId: string; remoteId: string; name: string; type: LibraryType;
  enabled: boolean; order: number; showOnHome: boolean; showInContinueWatching: boolean;
  /** The accounts granted this library. Empty means administrators only. */
  allowedUsers: string[];
  /** The provider behind the library's connection. Absent on a record whose connection was
   *  already removed, and on a PATCH response that omits it, so the client keeps the value it
   *  had. */
  provider?: MediaServerProvider;
  connectionName?: string;
  /** Display-only settings. Absent means the effective default: mixed libraries browse
   *  folders, movie/series libraries browse titles, and both mosaic and Favourites are on. */
  browseMode?: RemoteBrowseMode; mosaic?: boolean; showInFavorites?: boolean; showInSearch?: boolean;
  /** The local library this remote library's copies are saved into. Absent means the default for
   *  the kind; a stored handle that is no longer usable stays stored. */
  downloadLibraryId?: string;
  /** The storage rules for automatic copies, the same two per-kind rules an addon carries. */
  downloadSettings?: AddonDownloadSettings;
}
/** What a remote library or source may be used for. Every flag is false in this stage. */
export interface RemoteCapabilities {
  rename: boolean; move: boolean; delete: boolean; identify: boolean;
  writeArtwork: boolean; downloadToLibrary: boolean; downloadToDevice: boolean;
}
/** The member projection of one attached library: no address, no account, no grants. */
export interface RemoteLibrary {
  id: string; connectionId: string; remoteId: string; name: string; type: LibraryType;
  enabled: boolean; order: number; showOnHome: boolean; showInContinueWatching: boolean;
  provider: MediaServerProvider; capabilities: RemoteCapabilities;
  /** Effective display settings as the member projection answers them; absent on records
   *  written before these existed, so the client keeps the defaults. */
  browseMode?: RemoteBrowseMode; mosaic?: boolean; showInFavorites?: boolean; showInSearch?: boolean;
  /** The stored copy destination, when one is configured. */
  downloadLibraryId?: string;
  /** The stored storage rules for automatic copies, when this library has its own. */
  downloadSettings?: AddonDownloadSettings;
  /** The library root's own same-origin poster, when the provider has one. With mosaics on it is
   *  only the empty-preview fallback; with mosaics off the tile draws it as its picture. */
  poster?: string;
}
export type RemoteItemType = "movie" | "series" | "season" | "episode" | "folder";
export interface RemoteItem {
  id: string; name: string; type: RemoteItemType; parentId?: string; seriesId?: string;
  season?: number; episode?: number;
  providerIds: { imdb?: string; tmdb?: string; tvdb?: string };
  durationTicks?: number;
  /** Normalized, bounded metadata the server projects from the provider. Absent when the
   *  provider does not say it; never an upstream file path. */
  overview?: string; year?: number; genres?: string[]; size?: number; addedAt?: string;
  /** Same-origin, content-authorized artwork; never an upstream address. `wide` is the tile's
   *  landscape slot -- the provider's Thumb when it has one -- and `fanart` is the full-bleed
   *  backdrop a hero reads. */
  poster?: string; wide?: string; fanart?: string;
}
/** One page of a remote listing, cursor included and always opaque to the caller. */
export interface RemoteItemPage {
  items: RemoteItem[]; total: number; asOf: string; stale: boolean;
  cursor?: string; capabilities: RemoteCapabilities;
}
/** The locally stored playback state of one remote item. */
export interface RemoteItemState {
  key: string; position: number; duration: number; favorite: boolean; watched: boolean;
  mediaSourceId?: string; updatedAt?: string;
}
/** The remote identity a remote stream is played and reported under. */
export interface RemoteStreamContext { libraryId: string; itemId: string; mediaSourceId: string; progressKey: string }
export interface QueueHalt { reason: "storage"; at: string; message: string; messageKey?: string }
/** One queued job as the server hands it out; the shape lives with the queue it describes. */
export type Download = PublicDownload;
export type DownloadRules = ServerDownloadRules;
export type { RulePreference, RuleResolution };
export type SubtitleMode = "off" | "optional" | "required";
export type AudioMode = "strict" | "listed" | "preferred";
export type DownloadSourceStrategy = "priority" | "largest";
export interface SourceProfile {
  id: string;
  nameKey?: string;
  name?: string;
  template: SourceProfileTemplate;
  revision: number;
  operations: Array<"play" | "downloadToLibrary" | "downloadToDevice">;
  sizeLimits?: {
    episodeBytes?: number; movieBytes?: number;
    episodeMinBytes?: number; movieMinBytes?: number;
  };
  policy: SourcePolicyV1;
}
export type SourceProfileTemplate = "recommended" | "travel" | "providerPriority" | "rules";
export type SourceProfileScope = { mode: "allAvailable" } | { mode: "selected"; addonKeys: string[] };
export type SourceProfileProviderOrder = { from: "viewer" } | { addonKeys: string[] };
export interface TravelParameters {
  scope: SourceProfileScope;
  providerOrder: SourceProfileProviderOrder;
  audioMode: "listed" | "preferred" | "strict";
  subtitleMode: "off" | "optional" | "required";
  heightPixels: { min: number; max?: number };
}
export interface ProviderPriorityParameters {
  scope: SourceProfileScope;
  providerOrder: SourceProfileProviderOrder;
  sizeDirection: "asc" | "desc";
  transfer: Array<"http" | "torrent">;
  audioMode: "listed" | "preferred";
  subtitleMode: "off" | "optional";
}
/** An administrator's stored profile, including variants the public catalogue hides behind a name. */
export interface AdminSourceProfile {
  id: string;
  revision: number;
  template: SourceProfileTemplate;
  nameKey?: string;
  name?: string;
  parameters?: DownloadRules;
  createdAt: string;
  updatedAt: string;
}
export interface SourceProfileReference {
  profileId: string;
  revision: number;
}
export interface ProfileSelection {
  profile: SourceProfileReference;
}
export interface DownloadSelection {
  addonKeys: string[];
  sourceStrategy: DownloadSourceStrategy;
  audioLanguage: string;
  fallbackAudioLanguage?: string;
  audioMode?: AudioMode;
  /** The language of the title itself, where its metadata names one. */
  titleLanguage?: string;
  subtitleMode: SubtitleMode;
  subtitleLanguage?: string;
  fallbackSubtitleLanguage?: string;
  /** The pinned destination of a stored rule. Absent on a selection the interface submits. */
  targetSettings?: DownloadTargetSettings;
}
export interface DeviceTransfer {
  id: string; userId: string; username?: string; filename: string;
  source: "library" | "addon" | "hls"; addonName?: string;
  state: "running" | "completed" | "interrupted";
  sent: number; total?: number; speed: number;
  startedAt: string; finishedAt?: string;
}
export type DownloadSnapshot = ServerDownloadSnapshot;

export type PlaybackMode = "direct" | "remux" | "transcode";
export type TileSize = "compact" | "small" | "medium" | "large";
export type TileShape = "poster" | "wide";
export type StartView = "catalog" | "home" | "library";
export type LibraryShelf = "resume" | "episodes" | "favorites";
export interface Track { index: number; codec: string; language?: string; title?: string; channels?: number; default?: boolean; forced?: boolean }
export interface Inspection { duration?: number; video?: { codec: string; width?: number; height?: number }; audioTracks: Track[]; subtitleTracks: Track[] }
export interface BuildInfo { status: string; version: string; builtAt?: string; commit?: string; restricted?: boolean; searchEverywhere?: boolean }
export interface DiagnosticsSession {
  id: string; mode: string; hardware: boolean; generation: number; title?: string;
  video?: string; audio?: string; audioTrack: number; subtitleTrack: number | null; quality: number | null;
  offset: number; idleSeconds: number;
}
export interface Diagnostics {
  version: string; builtAt?: string; commit?: string; node: string;
  uptimeSeconds: number; memoryMb: number; logLevel: string; logRetentionDays: number;
  playback: {
    ffmpeg: { version?: string; initialBurst: boolean; softwareEncoder?: boolean };
    vaapi: { device?: string; scaling: boolean; bitrate: boolean; failures: number };
    nvenc?: { available: boolean; failures: number };
    videotoolbox?: { available: boolean; constantQuality: boolean; failures: number };
    mediafoundation?: { available: boolean; hardware: boolean; constantQuality: boolean; failures: number };
    sessions: DiagnosticsSession[];
  };
  downloads: { total: number; byStatus: Record<string, number>; halt: QueueHalt | null; failed: Array<{ id: string; title: string; error?: string; errorKey?: string }> };
  addons: Array<{ name: string; role: string; enabled: boolean }>;
  outbound: Array<{ host: string; state: "closed" | "open" | "half-open"; active: number; queued: number; failures: number; rejected: number; opened: number; opensInSeconds?: number }>;
  storage: Array<{ path: string; freeBytes?: number; totalBytes?: number }>;
}
/** One line of a log bundle a client sent back. */
export interface ClientLogLine { t: string; level: string; message: string; context?: Record<string, unknown> }
/** A bundle as the admin list shows it: `lines` is how many it holds, not the payload. */
export interface ClientLogSummary {
  id: string; user: string; client: "web" | "tv"; app: string; device: string;
  note?: string; time: string; lines: number;
}
export interface ClientLogBundle extends Omit<ClientLogSummary, "lines"> { lines: ClientLogLine[] }
export interface StatsWindow { bytes: number; count: number }
/** One host a grouped row stands for; `items` counts the finished transfers on that host. */
export interface StatsBucketHost { key: string; label: string; bytes: number; items: number }
export interface StatsBucket {
  key: string; label: string; bytes: number; count: number;
  /** The hosts a provider row groups, largest first. Absent on other rows and on a row
   *  that groups exactly one host. */
  hosts?: StatsBucketHost[];
}
export interface StatsSeries { key: string; label: string; points: number[] }
export interface ImageCounts { memory: number; disk: number; upstream: number }
/** The calls that left for an Emby or Jellyfin server, by the operation that was asked for. */
export type ProviderCallKind =
  | "info" | "login" | "user" | "views" | "items" | "directory" | "match"
  | "detail" | "ancestors" | "versions"
  | "artwork" | "subtitle" | "original" | "playback";
export interface StatsSummary {
  hour: StatsWindow; day: StatsWindow; week: StatsWindow; month: StatsWindow; total: StatsWindow;
  step: "minute" | "hour" | "day";
  /** `day`, on a day bar: the server's calendar date for it. Absent from an older server. */
  points: Array<{ at: string; day?: string; bytes: number; count: number }>;
  providers: StatsBucket[]; addons: StatsBucket[]; sources: StatsBucket[];
  byProvider: StatsSeries[]; byAddon: StatsSeries[]; bySource: StatsSeries[];
  since?: string;
  /** Served posters in the selected period. Absent on a server that does not count them. */
  images?: { catalog: ImageCounts; library: ImageCounts; remote: ImageCounts; home: ImageCounts };
  /** Calls made to the media servers in the selected period, by kind. Absent on a server that does
   *  not count them. */
  provider?: Record<ProviderCallKind, number>;
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
  mergeByName: boolean; streamSort: string; defaultRulesProfileId?: string; trackProgress: boolean; showResumeRow: boolean; libraryAutoScan: boolean; libraryScanPauseOnDownload: boolean;
  secureMode: boolean;
  /** What the server writes down, as opposed to what the log view filters back out. */
  logLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR";
  addonRefreshHours: number;
  tileSize: TileSize;
  catalogTileShape: TileShape; libraryTileShape: TileShape; favoritesTileShape: TileShape;
  resumeTileShape: TileShape; followingTileShape: TileShape; homeTileShape: TileShape; searchTileShape: TileShape;
  startView: StartView;
  libraryShelf: LibraryShelf;
  /** This account's own Home arrangement. Absent means it has never arranged one. */
  homeLayout?: HomeLayout;
  /** This account's default download rules for a new manual download. */
  downloadSourceProfile?: string;
  /** This account's default download rules for a new follow. */
  followSourceProfile?: string;
  realDebridConfigured: boolean; tmdbConfigured: boolean;
}
/** The instance keys the settings endpoints leave out for an ordinary account, which is told
 *  only what the ordinary interface behaves on: `secureMode` and `realDebridConfigured`. */
type AdminOnlySetting =
  | "concurrentDownloads" | "parallelPerProvider" | "downloadSegments"
  | "libraryAutoScan" | "libraryScanPauseOnDownload" | "logLevel"
  | "addonRefreshHours" | "tmdbConfigured";
/** What GET and PATCH /api/settings answer. An administrator receives every key; everybody
 *  else is missing the ones above, and the interface keeps its own defaults for them. */
export type SettingsView = Omit<Settings, AdminOnlySetting> & Partial<Pick<Settings, AdminOnlySetting>>;
export type SettingsPatch = Partial<Omit<Settings, "realDebridConfigured" | "tmdbConfigured" | "homeLayout" | "downloadSourceProfile" | "followSourceProfile">> & { homeLayout?: HomeLayout | null; downloadSourceProfile?: string | null; followSourceProfile?: string | null; realDebridToken?: string; tmdbApiKey?: string };
/** The media-server metadata a version 3 backup adds: the server's own metadata-only export,
 *  reused so a credential, generation or grant can never reach a settings file. */
export type SettingsBackupMediaServers = MediaServerConfigurationExport;
export interface SettingsBackup {
  format: "stremio-offline-settings"; version: number; exportedAt: string; settings: Settings;
  libraries?: Array<{ id: string; name: string; type: LibraryType; root: string }>;
  mediaServers?: SettingsBackupMediaServers;
  addons: Array<{ manifestUrl: string; role: Addon["role"]; enabled: boolean; globalSearch: boolean; showOnHome?: boolean; homeCatalogs?: string[]; addedAt: string; downloadSettings: AddonDownloadSettings }>;
}
export interface Capabilities { h264: boolean; hevc: boolean; hevc10: boolean; vp8: boolean; vp9: boolean; av1: boolean; aac: boolean; mp3: boolean; opus: boolean; vorbis: boolean; ac3: boolean; eac3: boolean; flac: boolean }
export interface PlaybackSession {
  seekRestored?: boolean;
  id: string; mode: PlaybackMode; url: string; offset: number; duration?: number; video?: string; audio?: string; hardware: boolean; acceleration: boolean;
  audioTracks: Track[]; subtitleTracks: Track[]; audioTrack: number; subtitleTrack: number | null;
  quality: number | null; sidecarUrl?: string; subtitleIds?: Record<string, string>;
  /** `url` addresses a playlist, so the element cannot simply be handed it. */
  playlist?: boolean;
}

export type UserRole = "admin" | "user";
export interface UserPermissions {
  /** May queue a download onto the server. */
  downloadToLibrary: boolean;
  /** May save allowed content to the device at the keyboard. */
  downloadToDevice: boolean;
}
/** One account as `GET /api/users` sends it: the public fields and the grant counts. */
export interface UserAccount {
  id: string; username: string; role: UserRole; disabled: boolean; mustChangePassword: boolean;
  createdAt: string; lastSeenAt?: string; permissions: UserPermissions;
  libraries: number; addons: number; remoteLibraries?: number;
}
/** `mustChangePassword` is set when an administrator chose the password this session signed
 *  in with. The server refuses everything but the change itself while it stands. */
export interface Session { username: string; role: UserRole; language?: Locale; mustChangePassword?: boolean }
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
/** Why a proposal wants a second look before it is confirmed. */
export type SuggestionReason = "ambiguous" | "year" | "part" | "correction";
/** One competing candidate of a proposal: enough to tell the rows apart, and never a
 *  provider payload or an image address. */
export interface SuggestionAlternative {
  type: string; id: string; name: string; year?: number; score: number; titleSimilarity: number;
}
export interface MatchSuggestion {
  type: string; id: string; name: string; year?: number; score: number;
  /** Name-only similarity as a percentage; absent on suggestions saved by older versions. */
  titleSimilarity?: number;
  /** Why a high score still wants a look. Absent when nothing needs explaining. */
  reason?: SuggestionReason;
  /** The competing candidates behind an ambiguous or part-conflicted proposal. */
  alternatives?: SuggestionAlternative[];
  /** The proposed candidate's own poster, already through the server's image proxy. */
  poster?: string;
  /** Set on a correction: the automatic binding this proposal would replace. */
  replacesId?: string; replacesName?: string; replacesYear?: number;
}
export interface BrowseMeta {
  /** How many pictures the title's stored gallery holds; absent where it holds none. */
  gallery?: number;
  year?: string; description?: string; catalogName?: string; match?: LibraryMatch; skipLookup?: boolean; skipMosaic?: boolean; suggestion?: MatchSuggestion;
  /** The kind of the title this row is bound to. Absent when nothing is bound, and the
   *  move dialog then offers every library rather than refusing on a guess. */
  titleType?: "movie" | "series";
}
export interface BrowseFolder extends BrowseMeta {
  path: string; name: string; fileCount: number; size: number; poster?: string; wide?: string;
  /** The distinct films this folder holds, when it is a collection of more than one: a poster
   *  mosaic instead of the folder's own picture. Absent on a folder that is one title. */
  posters?: string[];
  /** The one address the server composes that mosaic at, when it composes one. */
  mosaic?: string;
}
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
  unreachable: boolean; readOnly: boolean; path: string; poster?: string; posters?: string[]; mosaic?: string;
}
/** One library in `GET /api/libraries`. `root` is absent in restricted mode. */
export interface LibraryView {
  id: string; name: string; type: LibraryType; root?: string; enabled: boolean; order: number;
  addedAt: string; writeArtwork: boolean; autoScanMetadata: boolean; mosaic?: boolean; showInContinueWatching?: boolean; showOnHome?: boolean; showInFavorites?: boolean; showInSearch?: boolean; unreachable: boolean; readOnly: boolean;
  /** Whether this account may save a download here: visible, switched on, writable and reachable. */
  writable: boolean;
  defaultMovie: boolean; defaultSeries: boolean; titles: number; files: number; bytes: number;
  /** The accounts this library is granted to. Absent or empty means administrators only:
   *  there is no sentinel for "everybody", so a grant is always a list of ids. */
  visibleTo?: string[];
  /** The folder a re-root moved the content into while another library took it, so this
   *  library still points at its old folder. Administrators only. */
  rerootStranded?: string;
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
/** One row of the "Suggested matches" dialog. The library name and the relative path are
 *  absent only on an answer from a server that predates them. */
export interface SuggestionRow {
  key: string;
  label: string;
  libraryId?: string;
  library?: string;
  path?: string;
  suggestion: MatchSuggestion;
}
/** One row of the trusted manual search. `source` names the provider that offered it. */
export interface LibraryMatchResult {
  id: string; type: string; name: string; source: "tmdb" | "cinemeta"; releaseInfo?: string; poster?: string;
}
export interface ScanState {
  status: "idle" | "running" | "paused" | "completed" | "failed";
  pauseReason?: "playback" | "download" | "breaker" | "operation";
  startedAt?: string; finishedAt?: string; updatedAt?: string;
  total: number; done: number; matched: number; skipped: number; failed: number;
  current?: string; remaining: string[]; error?: string;
  /** Set when the run rechecks existing automatic bindings instead of looking for new ones. */
  recheck?: boolean;
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
  /** Why a job whose items all went through still failed, such as a re-root that could not switch. */
  error?: string; errorKey?: string; errorVars?: Record<string, string | number>;
}
/** One destination in the move dialog. Unlike a browsed folder it may hold no video at all. */
export interface LibraryFolder { path: string; name: string }

export interface BrowseResult { path: string; items: BrowseItem[]; total: number; pending: boolean }
export type LibrarySort = "name" | "added" | "size" | "random";
export type LibraryOrder = "asc" | "desc";
export type LibraryLayout = "grid" | "list";
export type ExtraView = ":favorites";
export type DownloadSort = "order" | "titleSort" | "createdAt" | "startedAt" | "completedAt" | "duration";
export type DownloadStatusFilter = "" | "queued" | "waiting" | "checking" | "downloading" | "paused" | "completed" | "failed";
export type DownloadDateField = "createdAt" | "startedAt" | "completedAt";
export type DownloadPageSize = 20 | 50 | 100;
/** The browsing chrome one library or one extra folder was left in. Mirrors `LibraryViewPrefs`
 *  in `server/src/views.ts`; the two workspaces cannot share a module. */
export interface LibraryViewPrefs { sort: LibrarySort; order: LibraryOrder; favoritesOnly: boolean; view: LibraryLayout }
export interface DownloadsViewPrefs {
  sort: DownloadSort; direction: LibraryOrder; status: DownloadStatusFilter;
  dateField: DownloadDateField; pageSize: DownloadPageSize;
}
export type SearchOrder = "source" | "titleMatch";
/** Per-account search history and preferences; `recent` is empty while saving is off. */
export interface SearchState {
  saveHistory: boolean;
  liveSearch: boolean;
  defaultOrder: SearchOrder;
  recent: Array<{ query: string; usedAt: string }>;
}
export type SearchPreferences = Pick<SearchState, "saveHistory" | "liveSearch" | "defaultOrder">;

export interface UserViews {
  libraries: Record<string, LibraryViewPrefs>;
  extras: Partial<Record<ExtraView, LibraryViewPrefs>>;
  downloads: DownloadsViewPrefs;
}
/** `pending` marks the row a finished episode left behind: the next episode of the show,
 *  not yet started. It carries no position and draws no progress bar. */
export interface ProgressEntry { key: string; position: number; duration: number; title: string; path?: string; poster?: string; addonKey?: string; stableKey?: string; remote?: { libraryId: string; itemId: string; mediaSourceId: string }; series?: { id: string; name: string; season: number; episode: number }; pending?: true; updatedAt: string }
export interface WatchlistEntry { key: string; type: string; id: string; name: string; poster?: string; addedAt: string }

/** One episode of a followed series as the follow route names it: the slot on either side of now. */
export interface FollowEpisodeView { season: number; episode: number; title?: string; released?: string; releasedSource?: "addon" | "tmdb"; dateUncertain?: boolean }
export type FollowStartMode = "new" | "from" | "ahead";
/** The wizard choices carried over from the last follow, as `GET /api/follows/defaults` answers them. */
export interface FollowDefaults {
  mode: "notify" | "download";
  startMode?: FollowStartMode;
  aheadCount?: number;
  graceDays?: number;
  selection?: {
    addonKeys: string[];
    sourceStrategy: DownloadSourceStrategy;
    audioLanguage: string;
    fallbackAudioLanguage?: string;
    audioMode: AudioMode;
    subtitleMode: SubtitleMode;
    subtitleLanguage?: string;
    fallbackSubtitleLanguage?: string;
  };
  target?: { libraryId: string; subfolder?: string; layout: DownloadLayout };
}
/** The rule a follow queues new episodes by. Mirrors `FollowAutoDownload` on the server. */
export interface FollowAutoDownload {
  enabledAt: string;
  startMode: FollowStartMode;
  startSeason?: number;
  startEpisode?: number;
  aheadCount?: number;
  selection: DownloadSelection;
  sourceProfile?: SourceProfileReference;
  /** Days after release during which only the preferred audio is accepted. */
  graceDays?: number;
  /** Delete downloaded episodes this long after the owner watched past them; absent keeps them. */
  retention?: { afterWatchedDays: 1 | 7 | 30 };
  /** Catalogue key of the reason nothing is admitted while the account may not download. */
  blockedKey?: string;
}
export type FollowDownloadState = "reserved" | "queued" | "waiting" | "completed" | "skipped" | "attention";
/** The queue's own verdict on one followed episode. */
export interface FollowEpisodeDownload {
  state: FollowDownloadState;
  intent: string;
  generation: number;
  jobId?: string;
  attempts: number;
  nextAttemptAt?: string;
  /** ISO instant the preferred-audio window closes, while the row is waiting inside it. */
  graceUntil?: string;
  /** ISO instant the file was deleted by retention; the state stays completed. */
  removedAt?: string;
  removedReason?: "retention";
  reasonKey?: string;
  reasonVars?: Record<string, string | number>;
  messageKey?: string;
  params?: Record<string, string | number>;
  updatedAt: string;
}
export type FollowEligibility = "eligible" | "upcoming" | "outside" | "attention-no-date" | "attention-ambiguous";
/** One row of `GET /api/follows/:id/episodes`. */
export interface FollowEpisodeRow {
  key: string; season: number; episode: number; title?: string; released?: string; ambiguous?: boolean;
  releasedSource?: "addon" | "tmdb"; dateUncertain?: boolean;
  eligibility: FollowEligibility;
  download?: FollowEpisodeDownload;
}
export interface FollowDownloads { queued: number; waiting: number; completed: number; skipped: number; attention: number }
/** One followed series as the follow routes answer it. */
/** A followed film's single record, as the follow view carries it. */
export interface FollowMovie {
  released?: string; releaseKind?: "digital" | "physical" | "theatrical" | "catalog"; theatricalAt?: string; dateUncertain?: boolean;
  state?: CalendarEpisodeState; reasonKey?: string; reasonVars?: Record<string, string | number>; messageKey?: string; params?: Record<string, string | number>; nextAttemptAt?: string; graceUntil?: string;
}
export interface FollowView {
  movie?: FollowMovie;
  id: string; ownerUserId: string; type: string; metaId: string; name: string; poster?: string;
  createdAt: string; updatedAt: string; enabled: boolean; revision: number;
  lastCheckedAt?: string; lastSuccessfulCheckAt?: string; nextCheckAt: string; failures: number; lastErrorKey?: string;
  episodeCount: number;
  nextEpisode?: FollowEpisodeView;
  latestEpisode?: FollowEpisodeView;
  autoDownload?: FollowAutoDownload;
  downloads: FollowDownloads;
}
/** One episode of a followed series released recently and not yet watched. */
export interface NewEpisode {
  followId: string; type: string; metaId: string; name: string; poster?: string;
  videoId: string; season: number; episode: number; title?: string; released: string;
}
/** One episode in the calendar window; the state adds the released/upcoming verdict to the queue's own. */
export type CalendarEpisodeState = "upcoming" | "released" | FollowDownloadState;
export interface CalendarItem {
  followId: string; type: string; metaId: string; name: string; poster?: string;
  videoId: string; season: number; episode: number; title?: string; released: string;
  state: CalendarEpisodeState; reasonKey?: string; reasonVars?: Record<string, string | number>; nextAttemptAt?: string; ambiguous?: boolean;
  dateUncertain?: boolean; releasedSource?: "addon" | "tmdb";
}
/** A calendar item with no date: the calendar lists these apart, under its grid. */
export type UndatedCalendarItem = Omit<CalendarItem, "released">;
/** One episode the download service has touched, as `GET /api/follows/activity` answers it. */
export interface ActivityItem {
  followId: string; type: string; metaId: string; name: string; poster?: string;
  season: number; episode: number; title?: string; state: FollowDownloadState;
  reasonKey?: string; reasonVars?: Record<string, string | number>; nextAttemptAt?: string; jobId?: string; updatedAt: string;
}
/** How many episodes a proposed start rule would queue right now. */
export interface FollowPreview { count: number; episodes: Array<{ key: string; season: number; episode: number; title?: string }> }

export interface StatsActivity {
  id: number; at: string; kind: "playback" | "library" | "device";
  title: string; filename?: string; userId?: string; username?: string; bytes?: number; partial?: boolean;
}
export interface StatsActivityPage {
  items: StatsActivity[]; total: number; next?: number; users: Array<{ id: string; username: string }>;
}
