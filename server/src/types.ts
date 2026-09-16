export type AddonRole = "catalog" | "source" | "both";
export type DownloadLayout = "flat" | "structured";
export interface DownloadTargetSettings {
  subfolder: string;
  layout: DownloadLayout;
  /** Library the finished file goes to. Absent or empty means the default for the kind. */
  libraryId?: string;
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
  poster?: string;
  background?: string;
  description?: string;
  releaseInfo?: string;
  year?: string | number;
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
  addonName?: string;
  [key: string]: unknown;
}

export interface PublicSubtitle { subtitleId: string; lang?: string; addonName?: string }
export interface PublicStream {
  sourceId: string;
  kind: "remote" | "library" | "torrent" | "unsupported";
  playable: boolean;
  name?: string; title?: string; description?: string;
  addonKey?: string; addonName?: string;
  behaviorHints: { filename?: string; videoSize?: number; bingeGroup?: string };
  subtitles: PublicSubtitle[];
}
