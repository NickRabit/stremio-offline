/** The wire shapes of the download queue. Types only, and no imports: the web's TypeScript
 *  compiles this file too, and it has no Node types. The queue annotates `publicJob`, `list`
 *  and `snapshot` with these, so a change to the wire shape has to reach this file as well. */

export type DownloadStatus = "queued" | "waiting" | "checking" | "downloading" | "paused" | "completed" | "failed";
/** `library` is not a fault: the rule's library is switched off, read-only or away, and the job
 *  waits for it rather than landing somewhere the user did not ask for. `permission` is not a
 *  fault either: the account behind the job may no longer queue it, and the job keeps its
 *  place until the right is back. */
export type PauseReason = "user" | "storage" | "library" | "permission";

export type DownloadLayout = "flat" | "structured";
export interface DownloadTargetSettings {
  subfolder: string;
  layout: DownloadLayout;
  /** Library the finished file goes to; absent means the default for the kind. */
  libraryId?: string;
  /** Chosen by the user for this job; never redirected. */
  explicit?: true;
}

export interface MediaInfo {
  id?: string;
  metaType?: string;
  poster?: string;
  background?: string;
  gallery?: Array<{ url: string; kind: "poster" | "background" | "logo" | "still" }>;
  kind?: "movie" | "episode";
  title?: string;
  year?: number;
  season?: number;
  episode?: number;
  episodeTitle?: string;
}

export interface DownloadResolution {
  checkedCandidates: number;
  audioLanguage?: string;
  audioTrack?: number;
  fallbackUsed?: boolean;
  /** What established `audioLanguage`: the file's own tags, the addon listing, or nothing. */
  audioEvidence?: "probe" | "listing" | "none";
  subtitleLanguage?: string;
  subtitleTrack?: number;
  subtitleSource?: "embedded" | "addon";
  subtitleStatus?: "ready" | "missing";
}

export interface QueueHalt {
  reason: "storage";
  at: string;
  message: string;
  /** Catalogue key for `message`; the interface renders it in the reader's language. */
  messageKey?: string;
}

/** One queued job as the queue hands it out: the persisted job without the private source
 *  fields, with `segments` flattened to a count, and with `order` added by `list()`. */
export interface PublicDownload {
  id: string;
  title: string;
  media?: MediaInfo;
  ownerUserId?: string;
  follow?: { followId: string; episodeKey: string; intent: string };
  resolution?: DownloadResolution;
  status: DownloadStatus;
  target: string;
  received: number;
  total?: number;
  speed: number;
  libraryId?: string;
  pausedAt?: string;
  libraryGone?: boolean;
  targetSettings?: DownloadTargetSettings;
  error?: string;
  errorKey?: string;
  errorVars?: Record<string, string | number>;
  retryCount?: number;
  pauseReason?: PauseReason;
  debridStartedAt?: string;
  rangesIgnored?: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  /** A lazy job whose source is picked only when the queue reaches it. */
  pending: boolean;
  debridProgress?: number;
  /** How many connections the file is split across; missing while it runs over one. */
  segments?: number;
  order: number;
}

export interface DownloadSnapshot {
  jobs: PublicDownload[];
  halt: QueueHalt | null;
}
