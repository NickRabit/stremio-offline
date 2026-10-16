import type { RemoteCapabilities } from "./media-server-types.js";

export type AddonRole = "catalog" | "source" | "both";
export type DownloadLayout = "flat" | "structured";
export interface DownloadTargetSettings {
  subfolder: string;
  layout: DownloadLayout;
  /** Library the finished file goes to. Absent or empty means the default for the kind. */
  libraryId?: string;
  /** Chosen by the user for this job; never redirected. */
  explicit?: true;
}
export interface AddonDownloadSettings { movie: DownloadTargetSettings; series: DownloadTargetSettings }

export interface AddonRecord {
  key: string;
  manifestUrl: string;
  role: AddonRole;
  enabled: boolean;
  globalSearch: boolean;
  /** Off keeps playback position but leaves catalogue titles from this addon out of Continue watching. */
  showInContinueWatching?: boolean;
  /** Off leaves this addon's catalogue titles off Home, in every shelf, while the stored data stays. */
  showOnHome?: boolean;
  /** Absent means every declared catalogue feed; a list opts into only these type/id pairs. */
  homeCatalogs?: string[];
  /** The users who may use this addon. Absent or empty means administrators
   *  only: an addon installed later is unavailable until somebody says
   *  otherwise, which is the safe direction for a list whose failure mode is
   *  disclosure. */
  allowedUsers?: string[];
  addedAt: string;
  manifest: StremioManifest;
  downloadSettings: AddonDownloadSettings;
}

export interface CatalogDefinition {
  type: string;
  id: string;
  name?: string;
  extra?: Array<{ name: string; isRequired?: boolean; options?: string[] }>;
  /** An older spelling of the same thing, which addons still send. */
  extraSupported?: string[];
  extraRequired?: string[];
}

export interface StremioManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  logo?: string;
  resources?: Array<string | { name: string; types?: string[]; idPrefixes?: string[] }>;
  types?: string[];
  idPrefixes?: string[];
  catalogs?: CatalogDefinition[];
  behaviorHints?: { configurable?: boolean; configurationRequired?: boolean; p2p?: boolean };
}

export interface MetaItem {
  id: string;
  type: string;
  name: string;
  /** The title in its original language, when the provider keeps one beside the localized
   *  name. Matching reads both, so a localized file still meets an English catalogue row. */
  originalTitle?: string;
  poster?: string;
  background?: string;
  description?: string;
  releaseInfo?: string;
  year?: string | number;
  /** How long the film runs, as the provider writes it: a number of minutes or "85 min".
   *  The scan reads only a movie's, to tell two namesakes of one name apart. */
  runtime?: string | number | null;
  genres?: string[];
  videos?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface StreamItem {
  url?: string;
  externalUrl?: string;
  infoHash?: string;
  fileIdx?: number;
  name?: string;
  title?: string;
  description?: string;
  subtitles?: SubtitleItem[];
  behaviorHints?: {
    notWebReady?: boolean;
    filename?: string;
    videoSize?: number;
    bingeGroup?: string;
    proxyHeaders?: { request?: Record<string, string>; response?: Record<string, string> };
  };
  addonKey?: string;
  addonName?: string;
  [key: string]: unknown;
}

export interface SubtitleItem {
  id?: string;
  url: string;
  lang?: string;
  title?: string;
  addonKey?: string;
  addonName?: string;
  [key: string]: unknown;
}

export interface PublicSubtitle { subtitleId: string; lang?: string; title?: string; addonName?: string }

/** The remote handles a client may use against authorized content and state routes. They are
 *  not addresses or secrets: the connection, account and owner stamps never appear here. */
export interface PublicRemoteItem { libraryId: string; itemId: string; mediaSourceId: string; progressKey: string }

export interface PublicStream {
  sourceId: string;
  /** The same source's handle in every session and for every account: a short hash of what the
   *  source is, never an address. A position stored with it resumes from that source again. */
  stableKey: string;
  kind: "remote" | "library" | "torrent" | "unsupported";
  playable: boolean;
  name?: string; title?: string; description?: string;
  addonKey?: string; addonName?: string;
  /** Set on a library copy: the file's wire path, the way the Library view speaks it. */
  localPath?: string;
  /** The display name of the library the copy sits in. */
  libraryName?: string;
  /** Preselected destination for a copy of this source, resolved from the remote library's
   *  stored setting or its kind's default. Absent when that target is unusable or invisible to
   *  the asking account; the server re-resolves it on the request and never trusts it. */
  downloadLibraryId?: string;
  /** The whole destination rule a copy of this source takes when the caller names no target:
   *  the library, its subfolder and the storage layout, all resolved from the remote library's
   *  stored rules. Absent when the concrete destination is unusable or invisible to the asking
   *  account; the server re-resolves it on the request and never trusts it. */
  downloadTarget?: DownloadTargetSettings;
  /** Present on a verified media-server source: which provider and which attached library.
   *  Derived from the sealed reference, never from caller-supplied stream fields. */
  provider?: "jellyfin" | "emby";
  libraryId?: string;
  /** What a remote item may still be used for. Always read-only in this stage. */
  capabilities?: RemoteCapabilities;
  remoteItem?: PublicRemoteItem;
  behaviorHints: { filename?: string; videoSize?: number; bingeGroup?: string };
  subtitles: PublicSubtitle[];
}
