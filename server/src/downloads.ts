import { AppError, messageKeyOf } from "./errors.js";
import { spawn } from "node:child_process";
import { createWriteStream as fsCreateWriteStream } from "node:fs";
import { mkdir, open, rename, stat, statfs, unlink, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { addonAllowed } from "./addons.js";
import { addonIdentity, isAddonIdentity } from "./addon-identity.js";
import type { AddonDownloadSettings, AddonRecord, StreamItem, SubtitleItem } from "./types.js";
import { defaultDownloadSettings, fitTargetName, joinTarget, nameExtension, streamExtension, targetPath, type MediaInfo } from "./naming.js";
import { torrentKey } from "./download-selection.js";
import { episodeTag } from "./library.js";
import type { DownloadTargetSettings } from "./types.js";
import { safeFetch } from "./security.js";
import { renameWithRetry } from "./fs-retry.js";
import { log } from "./logger.js";
import { ffmpegPath, mediaStopping, trackMedia } from "./media-tools.js";
import { retryAfterMs } from "./outbound.js";
import {
  classifyFailure, expectedSize, HttpSourceError, IncompleteDownloadError, parseContentRange,
  retryDelayMs, SourceError, StorageError, storageHeadroom, storageMessage, storageResumeNeed,
} from "./download-policy.js";
import { isRetryableDebridFailure, type DebridAdvance } from "./debrid.js";
import { isRemoteMediaStream, openRemoteContent } from "./media-server-reference.js";
import { isMediaServerError, REMOTE_LIBRARY_ID } from "./media-server-types.js";
import type { RemoteAccessSource } from "./media-server-access.js";
import {
  canonicalRemoteDownloadReference, canonicalRemoteDownloadSubtitles, isRemoteDownloadReference,
  remoteDownloadAccessible, remoteDownloadKey, type RemoteDownloadReference, type RemoteDownloadSubtitle,
} from "./media-server-download.js";
import { playlistArgs } from "./probe.js";
import { defaultLibrary, libraryPath, libraryVisible, parseLibraryPath, relativeWithin, type DefaultLibrarySettings, type LibraryRecord, type Viewer } from "./libraries.js";
import type { UserRecord } from "./users.js";
import {
  planSegments, segmentCount, segmentedBytes, segmentSize, usableSegments, type Segment,
} from "./download-segments.js";
import { readMediaBytes } from "./media-playlist.js";
import { preserveDamaged, readStateFile } from "./state-file.js";
import { subtitleVtt } from "./subtitle-text.js";
import type { DownloadSnapshot, DownloadStatus, PauseReason, PublicDownload, QueueHalt } from "./api-types.js";
import type { ExistingLocalCopyReference } from "./local-copy-admission.js";
import {
  parseDownloadSourceAdmissionSnapshotV1,
  SourceAdmissionValidationError,
  type SourceAdmissionSnapshotV1,
} from "./source-admission.js";
import {
  parseTravelContinuationCursorV1,
  type TravelContinuationCursorV1,
} from "./source-travel.js";
import {
  parseRulesContinuationCursorV1,
  type RulesContinuationCursorV1,
} from "./source-rules.js";
import { isExecutableDownloadProfile } from "./source-profiles.js";
import type {
  ProviderPriorityProfileResolution,
  ProviderPriorityProfileResolverInput,
  RulesProfileResolution,
  RulesProfileResolverInput,
  TravelProfileResolution,
  TravelProfileResolverInput,
} from "./source-profile-resolver.js";

export type { DownloadStatus, PauseReason, QueueHalt };
export type SubtitleMode = "off" | "optional" | "required";
/** How hard the requested audio language is. `strict` trusts only what ffprobe reads out of the
 *  file; `listed` lets the addon's own listing say so, for files that carry no language tag at
 *  all; `preferred` never rules a source out over the language, only ranks by it. */
export type AudioMode = "strict" | "listed" | "preferred";
export type DownloadSourceStrategy = "priority" | "largest";
export interface DownloadSelection {
  addonKeys: string[];
  sourceStrategy: DownloadSourceStrategy;
  audioLanguage: string;
  fallbackAudioLanguage?: string;
  /** Absent on a job queued before this existed, which was promised `strict`. */
  audioMode?: AudioMode;
  /** The language of the title itself, where its metadata names one. */
  titleLanguage?: string;
  subtitleMode: SubtitleMode;
  subtitleLanguage?: string;
  fallbackSubtitleLanguage?: string;
  targetSettings: DownloadTargetSettings;
}
export interface DownloadResolution {
  checkedCandidates: number;
  audioLanguage?: string;
  audioTrack?: number;
  fallbackUsed?: boolean;
  /** What established `audioLanguage`: the file's own tags, the addon listing, or nothing. */
  audioEvidence?: "probe" | "listing" | "metadata" | "none";
  subtitleLanguage?: string;
  subtitleTrack?: number;
  subtitleSource?: "embedded" | "addon";
  subtitleStatus?: "ready" | "missing";
}
/** A job without `stream` is lazy: the resolver picks a source for it only when the queue
 *  reaches it. `tried` guards against repeating addresses that already failed. */
export interface DownloadJob {
  id: string; title: string; stream?: StreamItem; media?: MediaInfo;
  /** Who asked for this job. A job queued before ownership existed belongs to
   *  the administrator the state migrated into. */
  ownerUserId?: string;
  source?: { type: string; videoId: string; tried: string[]; selection?: DownloadSelection };
  sourceAdmission?: SourceAdmissionSnapshotV1;
  travelCursor?: TravelContinuationCursorV1;
  rulesCursor?: RulesContinuationCursorV1;
  /** Hashes of the addon records that supplied the selected stream and subtitle. */
  sourceStreamAddonIdentity?: string;
  sourceSubtitleAddonIdentity?: string;
  sourceFallbackAttempts?: number;
  travelTemporaryFailures?: number;
  travelBudgetAttempts?: number;
  rulesTemporaryFailures?: number;
  rulesBudgetAttempts?: number;
  /** Present when a followed series queued the job, so the follow can be reconciled
   *  with the queue across restarts. */
  follow?: { followId: string; episodeKey: string; intent: string };
  /** Present only when the job copies one explicitly chosen remote original into a local
   *  library. The durable, session-free handle is what the transfer is re-proved against; the
   *  stream carries no address, so nothing sealed is ever persisted. */
  remoteDownload?: RemoteDownloadReference;
  subtitle?: SubtitleItem;
  resolution?: DownloadResolution;
  status: DownloadStatus; target: string; received: number; total?: number; speed: number;
  /** The library `target` lives in. Absent on a job queued before libraries existed, which
   *  belongs to the download directory. */
  libraryId?: string;
  /** When the job last started waiting for a library, and whether that library is one whose
   *  record is gone rather than one that is merely unreachable. */
  pausedAt?: string;
  libraryGone?: boolean;
  /** The rule that placed it, so the target can be chosen again when a library comes back. */
  targetSettings?: DownloadTargetSettings;
  error?: string;
  /** Catalogue key for `error`, so the interface can show it in the reader's language.
   *  A failure whose text is built from a source's own words carries none. */
  errorKey?: string;
  errorVars?: Record<string, string | number>;
  retryCount?: number; pauseReason?: PauseReason; notBefore?: number;
  debrid?: { torrentId?: string; progress?: number; status?: string };
  /** When Real-Debrid was first asked to fetch this source; the timeout counts from here so a
   *  job that waits a long time in the queue is not failed before its torrent even started. */
  debridStartedAt?: string;
  /** Present only while a segmented transfer is unfinished; it is what lets each connection
   *  pick up at its own offset after a restart. */
  segments?: Segment[];
  /** The source advertised byte ranges and then ignored them. Segmenting it again would
   *  fail the same way, so every further attempt runs over one stream. */
  rangesIgnored?: boolean;
  createdAt: string; updatedAt: string; startedAt?: string; completedAt?: string;
  /** Set only when a queued profile job finishes by pointing at an adequate existing file. */
  reusedLocalCopy?: true;
}

/** Queueing onto the NAS is a right an administrator hands out. The role is what grants an
 *  administrator, never the flags: those are for ordinary users, and a migrated
 *  administrator's may say anything. */
export const mayDownloadToLibrary = (user: Pick<UserRecord, "role" | "permissions">): boolean =>
  user.role === "admin" || user.permissions.downloadToLibrary;

/** The same rule for saving to the device at the keyboard, which is on by default. */
export const mayDownloadToDevice = (user: Pick<UserRecord, "role" | "permissions">): boolean =>
  user.role === "admin" || user.permissions.downloadToDevice;

/** Detect native provenance without trusting public capability fields. */
export const isRemoteDownloadSource = (stream: Pick<StreamItem, "url"> | undefined): boolean =>
  isRemoteMediaStream(stream ?? {});

export const remoteDownloadRefused = (): AppError =>
  new AppError("This library is read-only.", "library.readOnly", 403);

/** The address a remote job persists in place of the sealed source it was queued with. It is
 *  never fetched and never leaves the server: it exists so the naming, extension and file
 *  bookkeeping the queue already does keep working. */
export const REMOTE_DOWNLOAD_MARKER = "remote-download:original";

/** The stream a remote job keeps: the safe name and size, and the marker in place of the sealed
 *  address. Nothing sealed, ephemeral or credential-bearing survives into the queue file. */
export const remoteDownloadStream = (stream: StreamItem): StreamItem => ({
  ...(stream.name === undefined ? {} : { name: stream.name }),
  ...(stream.title === undefined ? {} : { title: stream.title }),
  url: REMOTE_DOWNLOAD_MARKER,
  behaviorHints: {
    ...(stream.behaviorHints?.filename ? { filename: stream.behaviorHints.filename } : (stream.name ? { filename: stream.name } : {})),
    ...(stream.behaviorHints?.videoSize === undefined ? {} : { videoSize: stream.behaviorHints.videoSize }),
  },
});

/** What the owner-bound check reads: the account that asked for the job, the addons and the
 *  libraries as they stand at this moment. Structural, so this module stays free of the store. */
export interface DownloadOwnerScope {
  owner?: Pick<UserRecord, "id" | "role" | "disabled" | "permissions">;
  addons: AddonRecord[];
  libraries: LibraryRecord[];
  /** The remote-side records a queued remote copy is checked against. Absent means every
   *  remote job is refused, so a caller that has not been taught about them cannot admit one. */
  remoteAccess?: RemoteAccessSource;
}

const isTravelSnapshot = (
  snapshot: SourceAdmissionSnapshotV1 | undefined,
): snapshot is SourceAdmissionSnapshotV1 =>
  snapshot?.profile.template === "travel";

export const isExecutableDownloadSnapshot = (
  snapshot: SourceAdmissionSnapshotV1 | undefined,
): snapshot is SourceAdmissionSnapshotV1 =>
  snapshot?.operation === "downloadToLibrary" && isExecutableDownloadProfile(snapshot.profile);

export const isSelectedProfileJob = (
  job: Pick<DownloadJob, "sourceAdmission" | "stream">,
): boolean => isExecutableDownloadSnapshot(job.sourceAdmission) && job.stream !== undefined;

/** The library a job writes into, where it is named. A resolved job carries it on `libraryId`;
 *  an unresolved one names it in its qualified target, in the rule it was queued with, or --
 *  for a lazy job that has not picked a source yet -- only in the selection it will resolve
 *  against. */
export const jobLibraryId = (job: Pick<DownloadJob, "libraryId" | "target" | "targetSettings" | "source">): string | undefined =>
  job.libraryId ?? (job.target ? parseLibraryPath(job.target)?.libraryId : undefined)
    ?? job.targetSettings?.libraryId ?? job.source?.selection?.targetSettings.libraryId;

const knownKindOf = (
  job: Pick<DownloadJob, "media" | "source">,
): "movie" | "series" | undefined => {
  if (job.media?.kind === "episode") return "series";
  if (job.media?.kind === "movie") return "movie";
  if (job.source?.type === "series") return "series";
  if (job.source?.type === "movie") return "movie";
  return undefined;
};

const libraryAcceptsKind = (library: LibraryRecord, kind: "movie" | "series"): boolean =>
  library.type === "mixed" || library.type === kind;

/** The library a rule that names no library lands in. The door, a follow's automatic rule and
 *  the queue all resolve it through this one function, so all three name the same library:
 *  the default for the kind, with read-only libraries left out because a download is never
 *  written to one. */
export const defaultDownloadLibrary = (libraries: LibraryRecord[], settings: DefaultLibrarySettings, kind: "movie" | "series"): LibraryRecord | undefined =>
  defaultLibrary(libraries.filter((library) => !library.readOnly), settings, kind === "series" ? "episode" : "movie");

/**
 * The owner-bound check, answered from the current state every time it is asked because a
 * queued job outlives the request that queued it: the account must still exist and may queue,
 * the source addon must be allowed to it and enabled, and the target library must be visible
 * to it, enabled, writable and accepting the job's kind. A part whose subject is not chosen yet
 * is left to the moment it is known -- a lazy job has no source until the resolver picks one,
 * and a library that has been removed is waited for -- so the check is asked again once they are.
 */
export function ownerMayDownload(scope: DownloadOwnerScope, job: { stream?: StreamItem; subtitle?: SubtitleItem; remoteDownload?: RemoteDownloadReference; media?: MediaInfo; libraryId?: string; target?: string; targetSettings?: DownloadTargetSettings; source?: DownloadJob["source"]; sourceAdmission?: SourceAdmissionSnapshotV1; sourceStreamAddonIdentity?: string; sourceSubtitleAddonIdentity?: string }): boolean {
  const owner = scope.owner;
  if (!owner || owner.disabled || !mayDownloadToLibrary(owner)) return false;
  // A raw sealed address is never a queued source: a remote copy is identified by its own
  // reference, never by the session-bound seal it was captured from.
  if (isRemoteDownloadSource(job.stream)) return false;
  if (job.subtitle && isRemoteMediaStream({ url: job.subtitle.url })) return false;
  if (job.remoteDownload !== undefined) {
    if (!isRemoteDownloadReference(job.remoteDownload) || job.remoteDownload.ownerUserId !== owner.id) return false;
    const remote = scope.remoteAccess;
    if (!remote || !remoteDownloadAccessible(remote, job.remoteDownload, owner.id)) return false;
  }
  const viewer: Viewer = { id: owner.id, role: owner.role };
  // Both resolved addons, or every selected source while a lazy job is still unresolved.
  const addonKeys = job.stream || !job.source?.selection
    ? [job.stream?.addonKey, job.subtitle?.addonKey]
    : [...job.source.selection.addonKeys, job.subtitle?.addonKey];
  for (const addonKey of new Set(addonKeys)) {
    if (!addonKey) continue;
    const addon = scope.addons.find((item) => item.key === addonKey);
    if (!addon?.enabled || !addonAllowed(addon, viewer)) return false;
  }
  if (isExecutableDownloadSnapshot(job.sourceAdmission) && job.stream && !job.remoteDownload) {
    const streamAddon = job.stream.addonKey
      ? scope.addons.find((item) => item.key === job.stream!.addonKey)
      : undefined;
    if (!streamAddon
      || !isAddonIdentity(job.sourceStreamAddonIdentity)
      || addonIdentity(streamAddon) !== job.sourceStreamAddonIdentity) return false;
    const subtitleKey = job.subtitle?.addonKey;
    if (subtitleKey === undefined) {
      if (job.sourceSubtitleAddonIdentity !== undefined) return false;
    } else {
      const subtitleAddon = scope.addons.find((item) => item.key === subtitleKey);
      if (!subtitleAddon
        || !isAddonIdentity(job.sourceSubtitleAddonIdentity)
        || addonIdentity(subtitleAddon) !== job.sourceSubtitleAddonIdentity) return false;
    }
  }
  const libraryId = jobLibraryId({ libraryId: job.libraryId, target: job.target ?? "", targetSettings: job.targetSettings, source: job.source });
  if (libraryId !== undefined && REMOTE_LIBRARY_ID.test(libraryId)) return false;
  const library = libraryId ? scope.libraries.find((item) => item.id === libraryId) : undefined;
  if (job.remoteDownload && !library) return false;
  if (library && (!libraryVisible(library, viewer) || !library.enabled || Boolean(library.readOnly))) return false;
  const kind = knownKindOf({ media: job.media, source: job.source });
  if (library && kind && !libraryAcceptsKind(library, kind)) return false;
  return true;
}

/** The owner travels with the source: a job is picked up long after the request that queued
 *  it, and choosing between candidates means asking addons. Which addons may be asked is the
 *  owner's business, so the resolver cannot be given the source alone. */
export type StreamResolver = (source: NonNullable<DownloadJob["source"]>, ownerUserId: string | undefined, signal: AbortSignal) => Promise<{
  stream: StreamItem;
  settings: AddonDownloadSettings;
  subtitle?: SubtitleItem;
  resolution?: DownloadResolution;
} | undefined>;
export type TravelProfileResolver = (
  input: TravelProfileResolverInput,
) => Promise<TravelProfileResolution>;
export type ProviderPriorityProfileResolver = (
  input: ProviderPriorityProfileResolverInput,
) => Promise<ProviderPriorityProfileResolution>;
export type RulesProfileResolver = (
  input: RulesProfileResolverInput,
) => Promise<RulesProfileResolution>;
export interface DebridEngine {
  configured: () => boolean;
  advance: (input: { infoHash: string; fileIdx?: number; torrentId?: string; exactFile?: boolean }) => Promise<DebridAdvance>;
}

/** The backend a queued remote copy runs on. It is the only way such a job may open bytes or
 *  re-prove its original, so the queue never reaches an upstream address itself. `current` is a
 *  synchronous local check of the owner, its grant, the connection generation and the target; a
 *  false answer pauses the job before any byte or commit. */
export interface RemoteDownloadBackend {
  current(job: DownloadJob): boolean;
  open(job: DownloadJob, args: { method: "GET" | "HEAD"; range?: string }, signal: AbortSignal): Promise<Response>;
  revalidate(job: DownloadJob, signal: AbortSignal): Promise<void>;
  readSubtitle(job: DownloadJob, subtitle: RemoteDownloadSubtitle, signal: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string }>;
}

export interface ExistingLocalCopyAdmission {
  ownerUserId: string | undefined;
  source: Pick<NonNullable<DownloadJob["source"]>, "type" | "videoId" | "selection">;
  media: MediaInfo | undefined;
  sourceAdmission: SourceAdmissionSnapshotV1;
}

export interface QueuedExistingLocalCopyLookup {
  ownerUserId: string | undefined;
  source: Pick<NonNullable<DownloadJob["source"]>, "type" | "videoId" | "selection">;
  media: MediaInfo | undefined;
  sourceAdmission: SourceAdmissionSnapshotV1;
}

export interface QueueHooks {
  now?: () => number;
  /** Every configured library, so a qualified target can be turned back into a root. */
  libraries?: () => LibraryRecord[];
  /** Where a rule that names no library goes: the default for the kind. */
  defaultLibrary?: (kind: "movie" | "series") => LibraryRecord | undefined;
  /** One library by id with its reachability refreshed -- what a paused job waits for. */
  libraryState?: (libraryId: string) => Promise<LibraryRecord | undefined>;
  /** How long a job waits for a library whose record is gone -- a folder removed without
   *  forgetting comes back with the same id when it is added again -- before it takes the
   *  default instead. A library that is merely away is waited for without a deadline. */
  libraryWaitMs?: number;
  /** How often a job paused for a library asks whether it is back. */
  libraryRetryMs?: number;
  freeSpace?: (dir: string) => Promise<{ freeBytes?: number; totalBytes?: number }>;
  createWriteStream?: (file: string, options: { flags: string }) => NodeJS.WritableStream;
  /** Replaces only the final video rename, so tests can hold publication open. */
  renamePublication?: (from: string, to: string) => Promise<void>;
  /** Writes the queue's own state file; tests use it to fail one particular write. */
  writeState?: (file: string, data: string) => Promise<void>;
  stallInitialMs?: number;
  stallTransferMs?: number;
  spaceCheckMs?: number;
  /** How many connections one file is split across. */
  segments?: () => number;
  /** The backend a remote original copy runs on. Absent means no remote copy can be admitted
   *  or run, which is what every queue built before this feature had. */
  remoteDownload?: RemoteDownloadBackend;
  /** How often a running remote copy re-proves its original upstream, and how long one cycle may
   *  take. Never more aggressive than the playback cadence: the values are clamped below. */
  remoteRevalidateMs?: number;
  remoteRevalidateTimeoutMs?: number;
  retryDelay?: (retryCount: number, retryAfterMs?: number) => number;
  debrid?: DebridEngine;
  debridPollMs?: number;
  debridRetryMs?: number;
  debridTimeoutMs?: number;
  /** Who owns a job queued before ownership existed: the administrator the single-account
   *  state migrated into. Read at every use rather than migrated into the queue file. */
  legacyOwnerId?: () => string | undefined;
  /** The owner-bound check, with the account, the addons and the libraries as they are now.
   *  A refusal pauses the job instead of failing it, so its place is kept for when the
   *  permission comes back. Absent in a queue built without accounts: nothing gates it. */
  ownerAllowed?: (job: DownloadJob) => boolean | Promise<boolean>;
  /** A profile admission may skip a bulk download when an acceptable local copy already exists. */
  existingLocalCopy?: (input: ExistingLocalCopyAdmission) => boolean | Promise<boolean>;
  /** A queued profile job may finish by reference when an adequate local copy appeared while it waited. */
  existingLocalCopyForQueue?: (
    input: QueuedExistingLocalCopyLookup,
  ) => ExistingLocalCopyReference | undefined | Promise<ExistingLocalCopyReference | undefined>;
  /** Whether an account can see a library. Lets a duplicate in another account's finished
   *  job be reported only when the asker could find that file anyway. */
  ownerSeesLibrary?: (ownerUserId: string | undefined, libraryId: string) => boolean;
  /** A job is about to be dropped. A throw refuses the removal, so a follow can record the
   *  skip before the row is touched. */
  beforeRemove?: (job: Readonly<DownloadJob>, reason: "user" | "account") => Promise<void>;
  /** The finished rows that `clearCompleted` is about to drop, before they go. */
  beforeClearCompleted?: (jobs: ReadonlyArray<Readonly<DownloadJob>>) => Promise<void>;
}

const exists = async (file: string) => { try { await stat(file); return true; } catch { return false; } };
const MiB = 1024 ** 2;

const SOURCE_ADMISSION_RUNTIME_UNAVAILABLE = {
  message: "The admitted source profile cannot run in the legacy download runtime.",
  key: "err.noMatchingSource",
};

class SourceAdmissionRuntimeUnavailable extends SourceError {
  constructor() {
    super(SOURCE_ADMISSION_RUNTIME_UNAVAILABLE.message, SOURCE_ADMISSION_RUNTIME_UNAVAILABLE.key);
    this.name = "SourceAdmissionRuntimeUnavailable";
  }
}

class RuleSizeError extends SourceError {
  constructor() {
    super("The source is outside the rule's size range.");
    this.name = "RuleSizeError";
  }
}

const supportsTravelCursor = (
  job: Pick<DownloadJob, "sourceAdmission" | "stream" | "source">,
  snapshot: SourceAdmissionSnapshotV1 | undefined = job.sourceAdmission,
): boolean => isTravelSnapshot(snapshot) && job.stream === undefined && Boolean(job.source);

const supportsRulesCursor = (
  job: Pick<DownloadJob, "sourceAdmission" | "stream" | "source">,
  snapshot: SourceAdmissionSnapshotV1 | undefined = job.sourceAdmission,
): boolean => snapshot?.profile.template === "rules" && job.stream === undefined && Boolean(job.source);

const PRIVATE_STATE_ALIASES = [
  ["sourceStreamAddonIdentity", "travelStreamAddonIdentity"],
  ["sourceSubtitleAddonIdentity", "travelSubtitleAddonIdentity"],
  ["sourceFallbackAttempts", "travelSourceFallbackAttempts"],
] as const;

const normalizePrivateStateAliases = (
  rawJob: Record<string, unknown>,
  snapshot: SourceAdmissionSnapshotV1 | undefined,
): void => {
  for (const [canonical, legacy] of PRIVATE_STATE_ALIASES) {
    const hasCanonical = Object.hasOwn(rawJob, canonical);
    const hasLegacy = Object.hasOwn(rawJob, legacy);
    if (hasCanonical && hasLegacy) throw new Error(`The ${canonical} state is ambiguous.`);
    if (!hasLegacy) continue;
    if (!isTravelSnapshot(snapshot)) throw new Error(`The ${legacy} state is Travel-only.`);
    rawJob[canonical] = rawJob[legacy];
    delete rawJob[legacy];
  }
};

const validateSelectedAddonIdentities = (
  rawJob: Record<string, unknown>,
  snapshot: SourceAdmissionSnapshotV1 | undefined,
): void => {
  const hasStreamIdentity = Object.hasOwn(rawJob, "sourceStreamAddonIdentity");
  const hasSubtitleIdentity = Object.hasOwn(rawJob, "sourceSubtitleAddonIdentity");
  if (!hasStreamIdentity && !hasSubtitleIdentity) return;

  const stream = rawJob.stream;
  const subtitle = rawJob.subtitle;
  if (!isExecutableDownloadSnapshot(snapshot)
    || stream === null
    || typeof stream !== "object"
    || typeof (stream as { addonKey?: unknown }).addonKey !== "string"
    || !isAddonIdentity(rawJob.sourceStreamAddonIdentity)) {
    throw new Error("The selected addon identity is misplaced or malformed.");
  }

  const subtitleAddonKey = subtitle !== null && typeof subtitle === "object"
    ? (subtitle as { addonKey?: unknown }).addonKey
    : undefined;
  if (subtitleAddonKey === undefined) {
    if (hasSubtitleIdentity) throw new Error("The selected subtitle addon identity is misplaced.");
    return;
  }
  if (typeof subtitleAddonKey !== "string" || !isAddonIdentity(rawJob.sourceSubtitleAddonIdentity)) {
    throw new Error("The selected subtitle addon identity is misplaced or malformed.");
  }
};

const isHttpDownloadUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

/** What a job paused on a missing permission carries: the interface translates the key, and
 *  the English text is the fallback for a client that does not know it. */
const PERMISSION_PAUSE = {
  message: "Paused: the permission for this download is gone.",
  key: "download.pausedNoPermission",
};

/** The rule's library is not there to be written to right now. Not a failure: the job waits,
 *  because sending one title to a fallback root would scatter a season across two libraries.
 *  `gone` marks the stricter case, a library whose record is not there at all. */
export class LibraryUnavailableError extends Error {
  constructor(readonly libraryId: string, readonly gone = false) {
    super(`The library ${libraryId} is not available.`);
    this.name = "LibraryUnavailableError";
  }
}

const libraryUsable = (library: LibraryRecord) => library.enabled && !library.readOnly && !library.unreachable;

/** No usable library accepts this kind, so the download has nowhere to go. It is refused
 *  rather than dropped into the download directory, which is a place nobody chose. The queue
 *  entry points let this reach the caller; a job already mid-pump fails on it instead. */
export class NoLibraryForKindError extends AppError {
  constructor(kind: "movie" | "series") {
    super(
      kind === "series" ? "No library takes series." : "No library takes films.",
      kind === "series" ? "err.noLibraryForSeries" : "err.noLibraryForMovies",
    );
    this.name = "NoLibraryForKindError";
  }
}

/** An explicitly chosen library went away and its deadline passed. Unlike a rule, the user's
 *  choice is not redirected to the default: the job fails rather than lands somewhere else. */
class ChosenLibraryGoneError extends AppError {
  constructor() {
    super("The library chosen for this download is gone.", "err.chosenLibraryGone");
    this.name = "ChosenLibraryGoneError";
  }
}

/** How long a job waits for a library whose record has gone before taking the default. A folder
 *  removed without forgetting comes back with the same id when it is added again, which is
 *  usually a matter of a minute; half an hour of patience covers a mistake, and after that a
 *  queue that never moves is worse than a file in the default library. */
export const LIBRARY_WAIT_MS = 30 * 60_000;

/** The cadence a running remote copy re-proves its original, matching the playback guard so a
 *  download is never re-checked harder than a remote film being watched. */
const REMOTE_REVALIDATE_MS = 30_000;
const REMOTE_REVALIDATE_TIMEOUT_MS = 5_000;
export const SOURCE_FALLBACK_ATTEMPT_LIMIT = 8;
const TRAVEL_TEMPORARY_FAILURE_LIMIT = 3;
const TRAVEL_BUDGET_ATTEMPT_LIMIT = 1_000;
const RULES_TEMPORARY_FAILURE_LIMIT = 3;
const RULES_BUDGET_ATTEMPT_LIMIT = 1_000;

const boundedMs = (value: number | undefined, fallback: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), max) : fallback;

/** Raised when the owner, its grant or the target is no longer there mid-transfer. The work is
 *  right, only the right behind it is gone, so the job pauses with its partial file kept. */
class RemotePermissionLost extends Error {
  constructor() {
    super("The permission for this download is gone.");
    this.name = "RemotePermissionLost";
  }
}

class PublicationWithdrawalError extends Error {
  constructor(readonly cleanupError: unknown) {
    super(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
    this.name = "PublicationWithdrawalError";
  }
}

type PublicationGate =
  | { status: "allowed" }
  | { status: "permission" }
  | { status: "stopped" }
  | { status: "library"; error: LibraryUnavailableError };

type OwnerRefusal =
  | { reason: "permission" }
  | { reason: "library"; error: LibraryUnavailableError };

export async function volumeSpace(target: string) {
  try {
    const info = await statfs(target);
    return { freeBytes: info.bavail * info.bsize, totalBytes: info.blocks * info.bsize };
  } catch {
    return {};
  }
}

interface QueueWriteChange {
  apply: () => void | Promise<void>;
  revert: () => void;
}

export class DownloadQueue {
  private jobs: DownloadJob[] = [];
  private active = new Map<string, AbortController>();
  /** The transfers still in flight, so stop() can wait for their last state write. */
  private running = new Set<Promise<void>>();
  /** The transfer for each job, so a targeted pause can wait for exactly the work it aborts. */
  private runningById = new Map<string, Promise<void>>();
  private stopped = false;
  private pauseRequested = new Set<string>();
  private pumpScheduled = false;
  private saveTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private spaceWatch?: NodeJS.Timeout;
  private saveChain: Promise<void> = Promise.resolve();
  /** Set when the state file could not be read: the queue refuses new work rather than
   *  overwriting a file the owner may still be able to fix. */
  private unreadable = false;
  /** Admissions run one after another, so two clicks cannot both pass a duplicate check. */
  private admission: Promise<unknown> = Promise.resolve();
  /** Targets chosen but not yet covered by the job list, so a name is never handed out twice. */
  private targetsInFlight = new Set<string>();
  /** Jobs pushed but not yet written: the pump leaves them alone, so a job whose write fails
   *  is taken back out before anything started transferring it. */
  private admitting = new Set<string>();
  private resolver?: StreamResolver;
  private travelResolver?: TravelProfileResolver;
  private providerPriorityResolver?: ProviderPriorityProfileResolver;
  private rulesResolver?: RulesProfileResolver;
  private retrySourceHook?: (source: { type: string; videoId: string }) => void;
  private halt?: QueueHalt;
  private readonly stateFile: string;
  private readonly downloadDir: string;
  private readonly libraries: () => LibraryRecord[];
  private readonly defaultLibrary: (kind: "movie" | "series") => LibraryRecord | undefined;
  private readonly libraryState?: (libraryId: string) => Promise<LibraryRecord | undefined>;
  private readonly libraryWaitMs: number;
  private readonly libraryRetryMs: number;
  private libraryWatch?: NodeJS.Timeout;
  private readonly now: () => number;
  private readonly freeSpace: (dir: string) => Promise<{ freeBytes?: number; totalBytes?: number }>;
  private readonly createWriteStream: (file: string, options: { flags: string }) => NodeJS.WritableStream;
  private readonly renamePublication: (from: string, to: string) => Promise<void>;
  private readonly writeState: (file: string, data: string) => Promise<void>;
  private readonly stallInitialMs: number;
  private readonly stallTransferMs: number;
  private readonly spaceCheckMs: number;
  private readonly segments: () => number;
  private readonly retryDelay: (retryCount: number, retryAfterMs?: number) => number;
  private debrid?: DebridEngine;
  private readonly debridPollMs: number;
  private readonly debridRetryMs: number;
  private readonly debridTimeoutMs: number;
  private readonly legacyOwnerId?: () => string | undefined;
  private readonly ownerAllowed?: (job: DownloadJob) => boolean | Promise<boolean>;
  private readonly existingLocalCopy?: QueueHooks["existingLocalCopy"];
  private readonly existingLocalCopyForQueue?: QueueHooks["existingLocalCopyForQueue"];
  private readonly ownerSeesLibrary?: (ownerUserId: string | undefined, libraryId: string) => boolean;
  private readonly remoteDownload?: RemoteDownloadBackend;
  private readonly remoteRevalidateMs: number;
  private readonly remoteRevalidateTimeoutMs: number;
  private beforeRemove?: (job: Readonly<DownloadJob>, reason: "user" | "account") => Promise<void>;
  private beforeClearCompleted?: (jobs: ReadonlyArray<Readonly<DownloadJob>>) => Promise<void>;
  private debridTimers = new Map<string, NodeJS.Timeout>();
  private debridBusy = new Set<string>();
  /** Called after a successful finish, so the library can produce a thumbnail straight away. */
  onCompleted?: (job: Readonly<DownloadJob>) => void | Promise<void>;
  /** Transferred bytes as they flow. The statistics stamp them with the time the traffic
   * really ran and count what was downloaded before a failure or a cancellation too. */
  onProgress?: (job: Readonly<DownloadJob>, bytes: number) => void;

  constructor(
    private concurrency: () => number = () => 1,
    private perProvider: () => number = () => 1,
    dataDir = process.env.DATA_DIR ?? "/data",
    downloadDir = process.env.DOWNLOAD_DIR ?? "/downloads",
    hooks: QueueHooks = {},
  ) {
    this.stateFile = path.join(dataDir, "downloads.json");
    this.downloadDir = downloadDir;
    this.libraries = hooks.libraries ?? (() => []);
    this.defaultLibrary = hooks.defaultLibrary ?? (() => undefined);
    this.libraryState = hooks.libraryState;
    this.libraryWaitMs = hooks.libraryWaitMs ?? LIBRARY_WAIT_MS;
    this.libraryRetryMs = hooks.libraryRetryMs ?? 15_000;
    this.now = hooks.now ?? Date.now;
    this.freeSpace = hooks.freeSpace ?? volumeSpace;
    this.createWriteStream = hooks.createWriteStream ?? fsCreateWriteStream;
    this.renamePublication = hooks.renamePublication ?? rename;
    this.writeState = hooks.writeState ?? ((file, data) => writeFile(file, data, { mode: 0o600 }));
    this.stallInitialMs = hooks.stallInitialMs ?? 15_000;
    this.stallTransferMs = hooks.stallTransferMs ?? 30_000;
    this.spaceCheckMs = hooks.spaceCheckMs ?? 30_000;
    this.segments = hooks.segments ?? (() => 1);
    this.retryDelay = hooks.retryDelay ?? retryDelayMs;
    this.debrid = hooks.debrid;
    this.debridPollMs = hooks.debridPollMs ?? 15_000;
    this.debridRetryMs = hooks.debridRetryMs ?? 30_000;
    this.debridTimeoutMs = hooks.debridTimeoutMs ?? 72 * 60 * 60_000;
    this.legacyOwnerId = hooks.legacyOwnerId;
    this.ownerAllowed = hooks.ownerAllowed;
    this.existingLocalCopy = hooks.existingLocalCopy;
    this.existingLocalCopyForQueue = hooks.existingLocalCopyForQueue;
    this.ownerSeesLibrary = hooks.ownerSeesLibrary;
    this.remoteDownload = hooks.remoteDownload;
    this.remoteRevalidateMs = boundedMs(hooks.remoteRevalidateMs, REMOTE_REVALIDATE_MS, REMOTE_REVALIDATE_MS);
    this.remoteRevalidateTimeoutMs = boundedMs(hooks.remoteRevalidateTimeoutMs, REMOTE_REVALIDATE_TIMEOUT_MS, REMOTE_REVALIDATE_TIMEOUT_MS);
    this.beforeRemove = hooks.beforeRemove;
    this.beforeClearCompleted = hooks.beforeClearCompleted;
  }

  /** index.ts owns source selection for lazy jobs, because it needs the addons and the settings. */
  setResolver(resolver: StreamResolver) { this.resolver = resolver; }
  setTravelResolver(resolver: TravelProfileResolver) { this.travelResolver = resolver; }
  setProviderPriorityResolver(resolver: ProviderPriorityProfileResolver) { this.providerPriorityResolver = resolver; }
  setRulesResolver(resolver: RulesProfileResolver) { this.rulesResolver = resolver; }
  setRetrySourceHook(hook: (source: { type: string; videoId: string }) => void) { this.retrySourceHook = hook; }
  setDebrid(engine: DebridEngine) { this.debrid = engine; }
  /** Wired after construction because the follow service that answers these is built later. */
  setRemovalGuard(guard: (job: Readonly<DownloadJob>, reason: "user" | "account") => Promise<void>) { this.beforeRemove = guard; }
  setClearCompletedGuard(guard: (jobs: ReadonlyArray<Readonly<DownloadJob>>) => Promise<void>) { this.beforeClearCompleted = guard; }
  haltInfo() { return this.halt ? { ...this.halt } : null; }
  /** Aborts everything and resolves once the transfers have written their last state.
   *  Callers that delete the data directory afterwards have to await it, or a straggling
   *  save recreates the file underneath them. */
  async stop() {
    this.stopped = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.spaceWatch) clearInterval(this.spaceWatch);
    if (this.libraryWatch) clearInterval(this.libraryWatch);
    this.saveTimer = undefined; this.retryTimer = undefined; this.spaceWatch = undefined; this.libraryWatch = undefined;
    for (const timer of this.debridTimers.values()) clearTimeout(timer);
    this.debridTimers.clear();
    for (const controller of this.active.values()) controller.abort();
    await Promise.all([...this.running]);
    await this.saveChain;
  }

  async load() {
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    await mkdir(this.downloadDir, { recursive: true });
    const state = await readStateFile(this.stateFile);
    if (state.kind === "unreadable") {
      this.unreadable = true;
      log("ERROR", "The queue state could not be read, it is left as it is", { file: this.stateFile, reason: state.error instanceof Error ? state.error.message : String(state.error) });
      return;
    }
    if (state.kind === "read") {
      let parsed: unknown = undefined;
      let isList = false;
      try {
        parsed = JSON.parse(state.raw);
        isList = Array.isArray(parsed);
      } catch { isList = false; }
      if (isList) {
        const canonicalSnapshots: Array<{ index: number; snapshot: SourceAdmissionSnapshotV1 }> = [];
        const canonicalCursors: Array<{ index: number; cursor: TravelContinuationCursorV1 }> = [];
        const canonicalRulesCursors: Array<{ index: number; cursor: RulesContinuationCursorV1 }> = [];
        const canonicalSourceFallbackAttempts: Array<{ index: number; attempts: number }> = [];
        const canonicalTemporaryFailures: Array<{ index: number; failures: number }> = [];
        const canonicalBudgetAttempts: Array<{ index: number; attempts: number }> = [];
        const canonicalRulesTemporaryFailures: Array<{ index: number; failures: number }> = [];
        const canonicalRulesBudgetAttempts: Array<{ index: number; attempts: number }> = [];
        try {
          for (const [index, rawJob] of (parsed as unknown[]).entries()) {
            if (rawJob === null || typeof rawJob !== "object") continue;
            const row = rawJob as Record<string, unknown>;
            const snapshot = Object.hasOwn(rawJob, "sourceAdmission")
              ? parseDownloadSourceAdmissionSnapshotV1((rawJob as { sourceAdmission: unknown }).sourceAdmission)
              : undefined;
            normalizePrivateStateAliases(row, snapshot);
            if (snapshot) canonicalSnapshots.push({ index, snapshot });
            validateSelectedAddonIdentities(row, snapshot);
            const cursor = Object.hasOwn(rawJob, "travelCursor")
              ? parseTravelContinuationCursorV1((rawJob as { travelCursor: unknown }).travelCursor)
              : undefined;
            if (cursor !== undefined) {
              if (!supportsTravelCursor(rawJob as DownloadJob, snapshot)) {
                throw new Error("The Travel continuation cursor is misplaced.");
              }
              canonicalCursors.push({ index, cursor });
            }
            const rulesCursor = Object.hasOwn(rawJob, "rulesCursor")
              ? parseRulesContinuationCursorV1((rawJob as { rulesCursor: unknown }).rulesCursor)
              : undefined;
            if (rulesCursor !== undefined) {
              if (!supportsRulesCursor(rawJob as DownloadJob, snapshot)) {
                throw new Error("The rules continuation cursor is misplaced.");
              }
              canonicalRulesCursors.push({ index, cursor: rulesCursor });
            }
            if (Object.hasOwn(rawJob, "sourceFallbackAttempts")) {
              const attempts = (rawJob as { sourceFallbackAttempts: unknown }).sourceFallbackAttempts;
              if (!isExecutableDownloadSnapshot(snapshot) || typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts < 0
                || attempts > SOURCE_FALLBACK_ATTEMPT_LIMIT) {
                throw new Error("The selected source fallback count is invalid.");
              }
              canonicalSourceFallbackAttempts.push({ index, attempts });
            }
            if (Object.hasOwn(rawJob, "travelTemporaryFailures")) {
              const failures = (rawJob as { travelTemporaryFailures: unknown }).travelTemporaryFailures;
              if (cursor === undefined || typeof failures !== "number" || !Number.isSafeInteger(failures) || failures < 0
                || failures > TRAVEL_TEMPORARY_FAILURE_LIMIT) {
                throw new Error("The Travel temporary-failure count is invalid.");
              }
              canonicalTemporaryFailures.push({ index, failures });
            }
            if (Object.hasOwn(rawJob, "travelBudgetAttempts")) {
              const attempts = (rawJob as { travelBudgetAttempts: unknown }).travelBudgetAttempts;
              if (cursor === undefined || typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts < 0
                || attempts > TRAVEL_BUDGET_ATTEMPT_LIMIT) {
                throw new Error("The Travel budget-attempt count is invalid.");
              }
              canonicalBudgetAttempts.push({ index, attempts });
            }
            if (Object.hasOwn(rawJob, "rulesTemporaryFailures")) {
              const failures = (rawJob as { rulesTemporaryFailures: unknown }).rulesTemporaryFailures;
              if (rulesCursor === undefined || typeof failures !== "number" || !Number.isSafeInteger(failures) || failures < 0
                || failures > RULES_TEMPORARY_FAILURE_LIMIT) {
                throw new Error("The rules temporary-failure count is invalid.");
              }
              canonicalRulesTemporaryFailures.push({ index, failures });
            }
            if (Object.hasOwn(rawJob, "rulesBudgetAttempts")) {
              const attempts = (rawJob as { rulesBudgetAttempts: unknown }).rulesBudgetAttempts;
              if (rulesCursor === undefined || typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts < 0
                || attempts > RULES_BUDGET_ATTEMPT_LIMIT) {
                throw new Error("The rules budget-attempt count is invalid.");
              }
              canonicalRulesBudgetAttempts.push({ index, attempts });
            }
            if (Object.hasOwn(rawJob, "reusedLocalCopy")) {
              const row = rawJob as Record<string, unknown>;
              const source = row.source as Record<string, unknown> | undefined;
              const target = typeof row.target === "string" ? parseLibraryPath(row.target) : undefined;
              if (row.reusedLocalCopy !== true || row.status !== "completed"
                || !Object.hasOwn(row, "sourceAdmission")
                || !source || typeof source !== "object" || Array.isArray(source)
                || typeof source.type !== "string" || typeof source.videoId !== "string"
                || Object.hasOwn(row, "stream")
                || !target || typeof row.libraryId !== "string" || target.libraryId !== row.libraryId) {
                throw new Error("The reused local-copy marker is misplaced.");
              }
            }
          }
        } catch (error) {
          this.unreadable = true;
          log("ERROR", "The queue contains an invalid private source state", {
            file: this.stateFile,
            reason: error instanceof SourceAdmissionValidationError
              ? "invalid source admission snapshot"
              : "private source state could not be validated",
          });
          return;
        }
        const jobs = parsed as DownloadJob[];
        for (const { index, snapshot } of canonicalSnapshots) jobs[index]!.sourceAdmission = snapshot;
        for (const { index, cursor } of canonicalCursors) jobs[index]!.travelCursor = cursor;
        for (const { index, cursor } of canonicalRulesCursors) jobs[index]!.rulesCursor = cursor;
        for (const { index, attempts } of canonicalSourceFallbackAttempts) jobs[index]!.sourceFallbackAttempts = attempts;
        for (const { index, failures } of canonicalTemporaryFailures) jobs[index]!.travelTemporaryFailures = failures;
        for (const { index, attempts } of canonicalBudgetAttempts) jobs[index]!.travelBudgetAttempts = attempts;
        for (const { index, failures } of canonicalRulesTemporaryFailures) jobs[index]!.rulesTemporaryFailures = failures;
        for (const { index, attempts } of canonicalRulesBudgetAttempts) jobs[index]!.rulesBudgetAttempts = attempts;
        this.jobs = jobs;
      } else {
        try {
          const preserved = await preserveDamaged(this.stateFile, state.raw);
          log("ERROR", "The queue state was damaged, it was copied aside and the queue starts empty", { file: path.basename(preserved) });
          this.jobs = [];
        } catch (error) {
          this.unreadable = true;
          log("ERROR", "The queue state could not be read, it is left as it is", { file: this.stateFile, reason: error instanceof Error ? error.message : String(error) });
          return;
        }
      }
    }
    for (const job of this.jobs) {
      if (job.status === "downloading" || job.status === "checking") job.status = "queued";
      job.updatedAt ??= job.createdAt;
      job.speed = 0;
      job.notBefore = undefined;
    }
    // A remote copy is restored from its durable reference alone, and a sealed address never
    // survives a restart because the registry and its key are gone with the process. A job that
    // still carries one -- or a malformed or foreign reference -- is refused rather than run
    // against an address that no longer means anything.
    const refused: DownloadJob[] = [];
    for (const job of this.jobs) {
      if (job.remoteDownload !== undefined) {
        // Only the durable reference and the internal marker may be restored. A seal is refused
        // even next to a valid reference: nothing the queue writes ever stores one, so one here
        // is a state that cannot be re-proved.
        if (!isRemoteDownloadReference(job.remoteDownload) || job.remoteDownload.ownerUserId !== this.ownerOf(job)
          || job.stream?.url !== REMOTE_DOWNLOAD_MARKER) {
          refused.push(job);
          continue;
        }
        job.remoteDownload = canonicalRemoteDownloadReference(job.remoteDownload);
        // A remote transfer never uses a segment plan; a restored one would issue doomed
        // segment GETs, so it is dropped with whatever the plan wrote.
        if (job.segments?.length) {
          const abandoned = job.target ? this.jobPath(job) : undefined;
          if (abandoned) await unlink(`${abandoned}.part`).catch(() => undefined);
          job.segments = undefined; job.received = 0; job.total = undefined; job.rangesIgnored = undefined;
        }
      } else if (job.stream?.url === REMOTE_DOWNLOAD_MARKER || isRemoteDownloadSource(job.stream) || (job.subtitle && isRemoteMediaStream({ url: job.subtitle.url }))) {
        refused.push(job);
      }
    }
    if (refused.length) {
      this.jobs = this.jobs.filter((job) => !refused.includes(job));
      log("WARN", "Remote downloads that could not be re-proved were refused", { count: refused.length, ids: refused.map((job) => job.id) });
    }
    for (const job of this.jobs) {
      if (job.status === "completed") continue;
      if (isExecutableDownloadSnapshot(job.sourceAdmission) && job.stream) {
        await this.discardProfileSelection(job, false);
        if (job.status !== "paused" && job.status !== "failed") job.status = "queued";
      }
      if (job.sourceAdmission && job.stream) this.failSourceAdmission(job);
    }
    if (this.jobs.some((job) => job.status === "paused" && job.pauseReason === "storage")) {
      this.halt = { reason: "storage", at: new Date().toISOString(), message: "No space left on the disk.", messageKey: "err.noSpace" };
      this.ensureSpaceWatch();
    }
    await this.save();
    this.pump();
    for (const job of this.jobs) if (job.status === "waiting") this.scheduleDebrid(job.id);
    if (this.jobs.some((job) => job.status === "paused" && job.pauseReason === "library")) this.watchLibraries();
  }

  list(): PublicDownload[] { return this.jobs.map((job, index) => ({ ...this.publicJob(job), order: index })); }
  snapshot(): DownloadSnapshot { return { jobs: this.list(), halt: this.haltInfo() }; }
  /** Whether any job is moving bytes right now, so the desktop shell can keep the Mac awake. */
  transferring(): boolean {
    return this.jobs.some((job) => job.status === "downloading" || job.status === "checking");
  }

  /** Who asked for a job. A job queued before ownership existed belongs to the administrator
   *  the single-account state migrated into: the answer is resolved here, on reading the job,
   *  and lands in the queue file only when something else writes it. */
  ownerOf(job: Pick<DownloadJob, "ownerUserId">): string | undefined {
    if (!job.ownerUserId) job.ownerUserId = this.legacyOwnerId?.();
    return job.ownerUserId;
  }

  /** Whether a queued job belongs to the account now asking. A job from before ownership
   *  existed belongs to the migrated administrator, the same as `ownerOf` says. */
  private ownedBy(job: DownloadJob, ownerUserId: string | undefined): boolean {
    return this.ownerOf(job) === (ownerUserId ?? this.legacyOwnerId?.());
  }

  /** The library a new job writes into. A rule that names a library nobody can write to right
   *  now -- removed, switched off, read-only or on a disk that is away -- falls back to the
   *  default for the kind: a download that can land somewhere sensible must not fail, and
   *  nothing on disk is ever the price of a mount that is not there. */
  /** The library a new job writes into. A rule that names one which is switched off,
   *  read-only or away is not redirected: the caller pauses the job, because scattering one
   *  title across two roots is worse than waiting.
   *
   *  A library that has been *removed* pauses too, with a deadline: the folder keeps its
   *  identity, so re-adding it brings the same library back and the job continues there. The
   *  deadline is the `libraryWaitMs` in `wakeLibraries`; past it the job takes the default,
   *  because a library that never comes back must not strand a queue for ever. */
  private async resolveLibrary(kind: "movie" | "series", settings: DownloadTargetSettings) {
    const wanted = settings.libraryId;
    if (!wanted) {
      const fallback = this.defaultLibrary(kind);
      return fallback && libraryAcceptsKind(fallback, kind) ? fallback : undefined;
    }
    const named = (await this.libraryState?.(wanted)) ?? this.libraries().find((library) => library.id === wanted);
    if (!named) throw new LibraryUnavailableError(wanted, true);
    if (!libraryUsable(named) || !libraryAcceptsKind(named, kind)) throw new LibraryUnavailableError(named.id);
    return named;
  }

  private kindOf(job: DownloadJob): "movie" | "series" {
    return knownKindOf(job) ?? "movie";
  }

  /** The file name is chosen when the download can actually start, so a name picked while a
   *  disk was away cannot collide with what came back. */
  private async ensureTarget(job: DownloadJob, library: LibraryRecord | undefined) {
    if (job.target || !job.stream) return;
    const extension = streamExtension(job.stream);
    const { directory, base } = targetPath(job.media, job.title, extension, job.targetSettings ?? defaultDownloadSettings().movie);
    job.target = await this.uniqueTarget(library, directory, base, extension);
    // The job list covers this name once the job is in it; a name chosen for a job that is
    // still being admitted stays reserved until that admission releases it.
    if (this.jobs.includes(job)) this.targetsInFlight.delete(job.target);
  }

  private pauseForLibrary(job: DownloadJob, error: LibraryUnavailableError) {
    job.status = "paused";
    job.pauseReason = "library";
    job.libraryId = error.libraryId;
    job.libraryGone = error.gone || undefined;
    job.pausedAt = new Date().toISOString();
    job.speed = 0;
    job.updatedAt = job.pausedAt;
    log("INFO", "Download paused, the library it goes to is not available", { id: job.id, title: job.title, library: error.libraryId, removed: error.gone || undefined });
    this.watchLibraries();
  }

  private async currentLibrary(libraryId: string): Promise<LibraryRecord | undefined> {
    return (await this.libraryState?.(libraryId)) ?? this.libraries().find((library) => library.id === libraryId);
  }

  private async libraryKindRefusal(job: DownloadJob): Promise<LibraryUnavailableError | undefined> {
    const libraryId = jobLibraryId(job);
    if (!libraryId) return undefined;
    const library = await this.currentLibrary(libraryId);
    if (!library || libraryAcceptsKind(library, this.kindOf(job))) return undefined;
    return new LibraryUnavailableError(library.id);
  }

  /** The owner-bound check as the queue asks it: the answer comes from the account, the
   *  addons and the libraries as they are now, never from the request that queued the job.
   *  A refusal pauses the job rather than failing it, because the work is not wrong and the
   *  queue position is worth keeping for when the permission comes back. */
  private async ownerRefusal(job: DownloadJob): Promise<OwnerRefusal | undefined> {
    const libraryRefusal = await this.libraryKindRefusal(job);
    if (libraryRefusal) return { reason: "library", error: libraryRefusal };
    return this.ownerAllowed && !await this.ownerAllowed(job) ? { reason: "permission" } : undefined;
  }

  private pauseForRefusal(job: DownloadJob, refusal: OwnerRefusal) {
    if (refusal.reason === "library") this.pauseForLibrary(job, refusal.error);
    else this.pauseForPermission(job);
  }

  private async permissionStillHeld(job: DownloadJob, signal: AbortSignal): Promise<boolean> {
    const refusal = await this.ownerRefusal(job);
    signal.throwIfAborted();
    if (!refusal) return true;
    this.pauseForRefusal(job, refusal);
    return false;
  }

  private clearLazyChoice(job: DownloadJob) {
    if (job.target) this.targetsInFlight.delete(job.target);
    job.stream = undefined;
    job.subtitle = undefined;
    job.resolution = undefined;
    delete job.remoteDownload;
    delete job.sourceStreamAddonIdentity;
    delete job.sourceSubtitleAddonIdentity;
    job.target = "";
    job.targetSettings = undefined;
    job.libraryId = undefined;
  }

  private async discardProfileSelection(job: DownloadJob, markTried: boolean) {
    const abandoned = job.target ? this.jobPath(job) : undefined;
    const subtitleFiles = this.subtitleFiles(job);
    const failedUrl = markTried && !job.remoteDownload ? job.stream?.url : undefined;
    const failedTorrent = markTried && job.stream?.infoHash ? torrentKey(job.stream) : undefined;
    const failedRemote = markTried && job.remoteDownload
      ? `remote:${remoteDownloadKey(job.remoteDownload)}`
      : undefined;
    this.clearLazyChoice(job);
    if (failedUrl && job.source && !job.source.tried.includes(failedUrl)) job.source.tried.push(failedUrl);
    if (failedTorrent && job.source && !job.source.tried.includes(failedTorrent)) job.source.tried.push(failedTorrent);
    if (failedRemote && job.source && !job.source.tried.includes(failedRemote)) job.source.tried.push(failedRemote);
    delete job.travelCursor;
    delete job.travelTemporaryFailures;
    delete job.travelBudgetAttempts;
    delete job.rulesCursor;
    delete job.rulesTemporaryFailures;
    delete job.rulesBudgetAttempts;
    job.received = 0;
    job.total = undefined;
    job.segments = undefined;
    job.rangesIgnored = undefined;
    job.retryCount = undefined;
    job.notBefore = undefined;
    job.debrid = undefined;
    job.debridStartedAt = undefined;
    if (abandoned) await unlink(`${abandoned}.part`).catch(() => undefined);
    if (subtitleFiles) await unlink(subtitleFiles.partial).catch(() => undefined);
  }

  private pauseForPermission(job: DownloadJob) {
    const clearChoice = job.status === "checking" && Boolean(job.source);
    job.status = "paused";
    job.pauseReason = "permission";
    if (clearChoice) this.clearLazyChoice(job);
    job.speed = 0;
    this.setError(job, PERMISSION_PAUSE.message, PERMISSION_PAUSE.key);
    job.updatedAt = new Date().toISOString();
    log("INFO", "Download paused, the account behind it may no longer queue it", { id: job.id, title: job.title });
  }

  /** Jobs waiting for a library ask again on a timer, and go back to the queue by themselves
   *  when it returns. Nothing else in the queue is held up by them. */
  private watchLibraries() {
    if (this.libraryWatch) return;
    this.libraryWatch = setInterval(() => { void this.wakeLibraries(); }, this.libraryRetryMs);
    this.libraryWatch.unref();
  }

  private async wakeLibraries() {
    const waiting = this.jobs.filter((job) => job.status === "paused" && job.pauseReason === "library" && job.libraryId);
    if (!waiting.length) {
      if (this.libraryWatch) { clearInterval(this.libraryWatch); this.libraryWatch = undefined; }
      return;
    }
    let woke = false;
    for (const job of waiting) {
      const waited = job.libraryId!;
      const kind = this.kindOf(job);
      const named = await this.currentLibrary(waited);
      if (named && (!libraryUsable(named) || !libraryAcceptsKind(named, kind))) continue;
      // A library whose record is gone gets a deadline: the folder keeps its identity, so a
      // re-add brings this same library back and the job continues there. Past the deadline
      // nothing is coming, and a queue that waits for ever is not honest either.
      const expired = !named && job.libraryGone && this.now() - Date.parse(job.pausedAt ?? "") >= this.libraryWaitMs;
      if (!named && !expired) continue;
      // A library the user picked is never swapped for the default: once the deadline for a
      // removed one passes, the job fails where it is instead of landing somewhere unasked for.
      if (!named && (job.targetSettings?.explicit || job.remoteDownload)) {
        const refusal = new ChosenLibraryGoneError();
        log("WARN", "The chosen library is gone, the download fails", { id: job.id, title: job.title, library: waited });
        job.status = "failed";
        this.setError(job, refusal.message, refusal.messageKey);
        job.pauseReason = undefined;
        job.pausedAt = undefined;
        job.libraryGone = undefined;
        job.speed = 0;
        job.updatedAt = new Date(this.now()).toISOString();
        woke = true;
        continue;
      }
      const fallback = named ?? this.defaultLibrary(kind);
      const library = fallback && libraryAcceptsKind(fallback, kind) ? fallback : undefined;
      // The deadline passed and no library takes this kind either: the job has nowhere to go,
      // so it fails instead of landing in the download directory. The rest of the queue carries on.
      if (!library) {
        const refusal = new NoLibraryForKindError(kind);
        log("WARN", "The library a download waited for did not come back, and no library takes its kind", { id: job.id, title: job.title, library: waited, kind });
        job.status = "failed";
        this.setError(job, refusal.message, refusal.messageKey);
        job.pauseReason = undefined;
        job.pausedAt = undefined;
        job.libraryGone = undefined;
        job.speed = 0;
        job.updatedAt = new Date(this.now()).toISOString();
        woke = true;
        continue;
      }
      if (!named) log("WARN", "The library a download waited for did not come back, using the default", { id: job.id, title: job.title, library: waited });
      if (job.sourceAdmission && job.stream) await this.discardProfileSelection(job, false);
      await this.ensureTarget(job, library);
      job.libraryId = library.id;
      job.libraryGone = undefined;
      job.pauseReason = undefined;
      job.pausedAt = undefined;
      job.status = job.debrid && !job.stream?.url ? "waiting" : "queued";
      job.updatedAt = new Date().toISOString();
      if (job.status === "waiting") this.scheduleDebrid(job.id);
      if (named) log("INFO", "The library is back, the download continues", { id: job.id, title: job.title, library: named.id });
      woke = true;
    }
    if (!woke) return;
    await this.save();
    this.pump();
  }

  /** Where a job's file lives: the root of the library its target names, and the path below
   *  it. A job queued before libraries existed carries a bare relative target and belongs to
   *  the download directory. A target that names a library which is gone resolves to nothing:
   *  the download directory is only ever the answer for a target that names no library. */
  private locate(job: Pick<DownloadJob, "target" | "libraryId">) {
    const named = job.libraryId ?? parseLibraryPath(job.target)?.libraryId;
    const library = named ? this.libraries().find((item) => item.id === named) : undefined;
    if (library) return { root: library.root, relative: relativeWithin(library.id, job.target) };
    if (parseLibraryPath(job.target)) return undefined;
    return { root: this.downloadDir, relative: job.target };
  }

  /** Nothing when the target names a library this instance no longer has: there is no path to make. */
  private jobPath(job: Pick<DownloadJob, "target" | "libraryId">) {
    const located = this.locate(job);
    return located ? path.join(located.root, located.relative) : undefined;
  }

  async add(title: string, stream: StreamItem, media?: MediaInfo, targetSettings: DownloadTargetSettings = defaultDownloadSettings().movie, ownerUserId?: string, remoteDownload?: RemoteDownloadReference) {
    if (this.unreadable) throw new AppError("The download queue file could not be read.", "err.queueUnreadable", 503);
    if (isRemoteDownloadSource(stream) && remoteDownload === undefined) throw remoteDownloadRefused();
    return this.admit(() => this.admitDirect(title, stream, media, targetSettings, ownerUserId, remoteDownload));
  }

  /** The stream and reference a remote admission persists, or a refusal. A sealed address is
   *  accepted only with a validated reference for the same owner and the same identity, and only
   *  when a remote backend is wired; the seal is replaced by the internal marker and never
   *  stored. The reference can never come from a request body: the route derives it from the
   *  sealed source through the manager. */
  private remoteAdmission(
    stream: StreamItem,
    remoteDownload: RemoteDownloadReference | undefined,
    ownerUserId: string | undefined,
    subtitleLanguage?: string,
  ): { stream: StreamItem; reference?: RemoteDownloadReference } {
    const sealed = isRemoteDownloadSource(stream);
    const marker = stream.url === REMOTE_DOWNLOAD_MARKER;
    if (!sealed && !marker) {
      if (remoteDownload === undefined) return { stream };
      if (stream.url !== undefined && stream.url !== "") throw remoteDownloadRefused();
    }
    if (!remoteDownload || !isRemoteDownloadReference(remoteDownload) || !this.remoteDownload) throw remoteDownloadRefused();
    if (remoteDownload.ownerUserId !== ownerUserId) throw remoteDownloadRefused();
    const subtitles = subtitleLanguage === undefined
      ? remoteDownload.subtitles
      : canonicalRemoteDownloadSubtitles(remoteDownload.subtitles)?.filter((subtitle) => subtitle.language === subtitleLanguage);
    const reference = canonicalRemoteDownloadReference({ ...remoteDownload, subtitles });
    if (sealed) {
      const opened = openRemoteContent(stream.url);
      if (!opened || opened.subtitleIndex !== undefined) throw remoteDownloadRefused();
      if (opened.owner.userId !== reference.ownerUserId || opened.connectionId !== reference.connectionId
        || opened.libraryId !== reference.libraryId || opened.generation !== reference.generation
        || opened.provider !== reference.provider || opened.serverId !== reference.serverId
        || opened.accountId !== reference.accountId || opened.itemId !== reference.itemId
        || opened.mediaSourceId !== reference.mediaSourceId) throw remoteDownloadRefused();
    }
    if (!nameExtension(stream.behaviorHints?.filename ?? stream.name)) {
      throw new AppError("The media server did not provide a supported original file format.", "err.mediaServerFormatUnknown", 422);
    }
    return { stream: remoteDownloadStream(stream), reference };
  }

  /** The identity a queued source is deduplicated by: an exact address for a local source, and
   *  the exact version for a remote copy, whose persisted address is only the shared marker. */
  private sourceKey(job: Pick<DownloadJob, "stream" | "remoteDownload">): string | undefined {
    return job.remoteDownload ? `remote:${remoteDownloadKey(job.remoteDownload)}` : job.stream?.url;
  }

  /** The concrete place a remote copy lands: the library it writes into and the folder and base
   *  name the naming rules give it. Because one original may be explicitly saved to a different
   *  library or folder, a copy is a duplicate only when this destination matches exactly. */
  private remoteDestination(libraryId: string | undefined, settings: DownloadTargetSettings, media: MediaInfo | undefined, title: string, stream: StreamItem | undefined, kind: "movie" | "series"): string {
    const library = libraryId ?? this.defaultLibrary(kind)?.id ?? "";
    const extension = stream ? streamExtension(stream) : "";
    const { directory, base } = targetPath(media, title, extension, settings);
    return `${library}\u0000${directory}\u0000${base}`;
  }

  /** The destination of an already-queued remote copy, resolved the way admission resolved it. */
  private remoteJobDestination(job: DownloadJob): string {
    const kind = this.kindOf(job);
    return this.remoteDestination(jobLibraryId(job), job.targetSettings ?? defaultDownloadSettings()[kind], job.media, job.title, job.stream, kind);
  }

  /** The body of `add`, run under the admission lock so two clicks cannot both pass the
   *  duplicate check or the free-name search. A debrid source is delegated as it always was. */
  private async admitDirect(title: string, incoming: StreamItem, media: MediaInfo | undefined, targetSettings: DownloadTargetSettings, ownerUserId?: string, remoteDownload?: RemoteDownloadReference) {
    const { stream, reference } = this.remoteAdmission(incoming, remoteDownload, ownerUserId);
    if (!stream.url && stream.infoHash) return this.addDebrid(title, stream, media, targetSettings, ownerUserId);
    if (!stream.url) throw new AppError("Only a direct HTTP stream can be downloaded.", "err.downloadNeedsHttp");
    const kind = media?.kind === "episode" ? "series" : "movie";
    const key = reference ? `remote:${remoteDownloadKey(reference)}` : stream.url;
    // A remote copy is deduplicated by the save it performs, not by the source alone: the same
    // original may be explicitly saved to another library or folder, which is a different
    // request. A second click onto the same destination still matches the same key and is refused.
    const destination = reference ? this.remoteDestination(targetSettings.libraryId, targetSettings, media, title, stream, kind) : undefined;
    // Without this check a double click on Download yields the same film twice, because
    // uniqueTarget happily hands the second job a name with "(2)".
    if (this.jobs.some((job) => this.sourceKey(job) === key
      && (destination === undefined || this.remoteJobDestination(job) === destination)
      && job.status !== "failed" && job.status !== "completed" && this.ownedBy(job, ownerUserId)))
      throw new AppError("This source is already in the queue.", "err.sourceQueued");
    // Another account's finished file refuses only when the asker can see its library anyway;
    // otherwise the refusal would tell them what someone else downloaded.
    for (const job of this.jobs) {
      if (this.sourceKey(job) !== key || job.status !== "completed") continue;
      if (destination !== undefined && this.remoteJobDestination(job) !== destination) continue;
      const libraryId = jobLibraryId(job);
      const reachable = this.ownedBy(job, ownerUserId)
        || (libraryId !== undefined && (this.ownerSeesLibrary?.(ownerUserId ?? this.legacyOwnerId?.(), libraryId) ?? false));
      if (!reachable) continue;
      const duplicatePath = this.jobPath(job);
      if (duplicatePath && await exists(duplicatePath)) throw new AppError("This source is already in the library.", "err.sourceDownloaded");
    }
    const extension = streamExtension(stream);
    const now = new Date().toISOString();
    const job: DownloadJob = { id: crypto.randomUUID(), ownerUserId, title, stream, media, ...(reference === undefined ? {} : { remoteDownload: reference }), status: "queued", target: "", received: 0, speed: 0, targetSettings, createdAt: now, updatedAt: now };
    try {
      try {
        const library = await this.resolveLibrary(kind, targetSettings);
        if (!library) throw new NoLibraryForKindError(kind);
        await this.ensureTarget(job, library);
        job.libraryId = library.id;
      } catch (error) {
        if (!(error instanceof LibraryUnavailableError)) throw error;
        this.pauseForLibrary(job, error);
      }
      await this.admitJob(job);
      if (job.status === "paused") return this.publicJob(job);
      this.pump();
      return this.publicJob(job);
    } finally {
      this.targetsInFlight.delete(job.target);
    }
  }

  private sameTorrent(left: StreamItem | undefined, right: StreamItem) {
    return Boolean(left?.infoHash && left.infoHash === right.infoHash && (left.fileIdx ?? 0) === (right.fileIdx ?? 0));
  }

  private async addDebrid(title: string, stream: StreamItem, media: MediaInfo | undefined, targetSettings: DownloadTargetSettings, ownerUserId?: string) {
    if (!this.debrid?.configured()) throw new AppError("Set up Real-Debrid in Settings first.", "err.debridNotConfigured");
    if (this.jobs.some((job) => this.sameTorrent(job.stream, stream) && job.status !== "failed" && job.status !== "completed" && this.ownedBy(job, ownerUserId)))
      throw new AppError("This torrent is already in the queue.", "err.torrentQueued");
    const now = new Date().toISOString();
    const job: DownloadJob = {
      id: crypto.randomUUID(), ownerUserId, title, stream, media, status: "waiting", target: "", received: 0, speed: 0,
      debrid: {}, targetSettings, createdAt: now, updatedAt: now,
    };
    try {
      try {
        const kind = media?.kind === "episode" ? "series" : "movie";
        const library = await this.resolveLibrary(kind, targetSettings);
        if (!library) throw new NoLibraryForKindError(kind);
        await this.ensureTarget(job, library);
        job.libraryId = library.id;
      } catch (error) {
        if (!(error instanceof LibraryUnavailableError)) throw error;
        this.pauseForLibrary(job, error);
      }
      await this.admitJob(job);
      if (job.status === "paused") return this.publicJob(job);
      log("INFO", "Waiting for Real-Debrid", { id: job.id, title: job.title, infoHash: stream.infoHash });
      this.scheduleDebrid(job.id);
      return this.publicJob(job);
    } finally {
      this.targetsInFlight.delete(job.target);
    }
  }

  /** A lazy job: both target and source are filled in when the download starts. A duplicate episode is not added. */
  async addPending(
    title: string,
    source: { type: string; videoId: string; selection?: DownloadSelection },
    media?: MediaInfo,
    ownerUserId?: string,
    follow?: DownloadJob["follow"],
    sourceAdmissionInput?: unknown,
  ) {
    if (this.unreadable) throw new AppError("The download queue file could not be read.", "err.queueUnreadable", 503);
    const sourceAdmission = sourceAdmissionInput === undefined
      ? undefined
      : parseDownloadSourceAdmissionSnapshotV1(sourceAdmissionInput);
    // A remote library id is not a local target: it cannot be smuggled in as the pinned library.
    const pinned = source.selection?.targetSettings?.libraryId;
    if (pinned !== undefined && REMOTE_LIBRARY_ID.test(pinned)) throw remoteDownloadRefused();
    return this.admit(async () => {
      if (this.jobs.some((job) => job.source?.videoId === source.videoId && job.source?.type === source.type && job.status !== "completed" && job.status !== "failed" && this.ownedBy(job, ownerUserId))) return undefined;
      if (sourceAdmission !== undefined) {
        let adequate = false;
        try {
          adequate = await this.existingLocalCopy?.({
            ownerUserId,
            source,
            media,
            sourceAdmission,
          }) === true;
        } catch {
          // A lookup that cannot prove a local copy adequate must not block the download.
        }
        if (adequate) return undefined;
      }
      const now = new Date().toISOString();
      const job: DownloadJob = {
        id: crypto.randomUUID(),
        ownerUserId,
        title,
        media,
        source: { ...source, tried: [] },
        ...(follow ? { follow } : {}),
        ...(sourceAdmission === undefined ? {} : { sourceAdmission }),
        status: "queued",
        target: "",
        received: 0,
        speed: 0,
        createdAt: now,
        updatedAt: now,
      };
      await this.admitJob(job);
      this.pump();
      return this.publicJob(job);
    });
  }

  /** The caller's own unfinished lazy job for a source, or nothing. A job from another account
   *  or one that already failed or finished does not answer. */
  findActiveEpisode(ownerUserId: string | undefined, type: string, videoId: string) {
    const job = this.jobs.find((job) => job.source?.type === type && job.source?.videoId === videoId
      && job.status !== "completed" && job.status !== "failed" && this.ownedBy(job, ownerUserId));
    return job ? this.publicJob(job) : undefined;
  }

  /** Ties a job the owner queued by hand to the follow that now wants the same episode. */
  async adopt(id: string, follow: NonNullable<DownloadJob["follow"]>) {
    if (this.unreadable) throw new AppError("The download queue file could not be read.", "err.queueUnreadable", 503);
    const job = this.jobs.find((item) => item.id === id);
    if (!job) return;
    const previous = job.follow;
    await this.persist({
      apply: () => { job.follow = follow; },
      revert: () => { if (previous === undefined) delete job.follow; else job.follow = previous; },
    });
  }

  /** The public shape of the jobs that carry a follow, for reconciliation. */
  followJobs() {
    return this.jobs.filter((job) => job.follow).map((job) => this.publicJob(job));
  }

  /** One job by id, in the shape the interface sees, or nothing. */
  get(id: string) {
    const job = this.jobs.find((item) => item.id === id);
    return job ? this.publicJob(job) : undefined;
  }

  /** History can be cleared, but the files stay. A free name therefore has to be looked for on
   *  disk as well, or a finished film would be quietly overwritten by downloading the same title. */
  private async uniqueTarget(library: LibraryRecord | undefined, directory: string, base: string, extension: string) {
    const root = library?.root ?? this.downloadDir;
    for (let copy = 1; copy <= 999; copy += 1) {
      const relative = joinTarget(directory, fitTargetName(root, directory, base, extension, copy), extension, copy);
      const target = library ? libraryPath(library.id, relative) : relative;
      if (this.jobs.some((job) => job.target === target)) continue;
      if (this.targetsInFlight.has(target)) continue;
      this.targetsInFlight.add(target);
      const full = path.join(root, relative);
      if (await exists(full) || await exists(`${full}.part`)) { this.targetsInFlight.delete(target); continue; }
      return target;
    }
    throw new AppError("Could not find a free file name.", "err.noFreeName");
  }

  async pause(id: string) {
    const job = this.require(id);
    if (job.status === "completed") throw new AppError("A finished download cannot be paused.", "err.cannotPauseCompleted");
    this.clearDebrid(id);
    if (this.active.has(id)) this.pauseRequested.add(id);
    job.status = "paused";
    job.pauseReason = "user";
    job.speed = 0;
    job.updatedAt = new Date().toISOString();
    this.active.get(id)?.abort();
    log("INFO", "Download paused", { id, title: job.title, received: job.received });
    await this.save();
    for (let attempt = 0; attempt < 100 && this.active.has(id); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  /** Pauses the queued and running jobs a named cause takes away. A transfer in flight is
   *  aborted rather than left running behind a paused row: the sweep that calls this is the
   *  answer to work that keeps going on its own. A job already paused, failed or finished is
   *  left as it is -- it is not running, and its own reason is a different statement. */
  async pauseMatching(match: (job: DownloadJob) => boolean): Promise<number> {
    const running: DownloadStatus[] = ["queued", "waiting", "checking", "downloading"];
    const hit = this.jobs.filter((job) => running.includes(job.status) && match(job));
    for (const job of hit) {
      this.clearDebrid(job.id);
      if (this.active.has(job.id)) this.pauseRequested.add(job.id);
      this.pauseForPermission(job);
      this.active.get(job.id)?.abort();
    }
    if (!hit.length) return 0;
    await this.save();
    this.pump();
    for (const job of hit) {
      for (let attempt = 0; attempt < 100 && this.active.has(job.id); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return hit.length;
  }

  /** Pauses queued and running jobs whose kind the library no longer accepts. The current
   *  library record decides, and compatible jobs keep their place and continue. */
  async pauseIncompatibleLibraryJobs(libraryId: string): Promise<number> {
    const library = await this.currentLibrary(libraryId);
    if (!library || library.type === "mixed") return 0;
    const incompatible = library.type === "movie" ? "series" : "movie";
    const running: DownloadStatus[] = ["queued", "waiting", "checking", "downloading"];
    const hit = this.jobs.filter((job) => running.includes(job.status)
      && jobLibraryId(job) === library.id
      && this.kindOf(job) === incompatible);
    for (const job of hit) {
      this.clearDebrid(job.id);
      if (this.active.has(job.id)) this.pauseRequested.add(job.id);
      this.pauseForLibrary(job, new LibraryUnavailableError(library.id));
      this.active.get(job.id)?.abort();
    }
    if (!hit.length) return 0;
    await this.save();
    this.pump();
    await Promise.all(hit.map((job) => this.runningById.get(job.id)).filter((run): run is Promise<void> => run !== undefined));
    return hit.length;
  }

  /** Drops every unfinished job the predicate names, its partial file with it. What is
   *  completed stays: it is in the library and belongs to nobody's access any more. */
  async removeMatching(match: (job: DownloadJob) => boolean): Promise<number> {
    const jobs = this.jobs.filter((job) => job.status !== "completed" && match(job));
    for (const job of jobs) {
      this.clearDebrid(job.id);
      if (this.active.has(job.id)) this.pauseRequested.add(job.id);
      this.pauseForPermission(job);
      this.active.get(job.id)?.abort();
    }
    if (!jobs.length) return 0;
    await this.save();
    for (const job of jobs) await this.remove(job.id, "account");
    return jobs.length;
  }

  async resume(id: string) {
    const job = this.require(id);
    if (!(["paused", "failed"] as DownloadStatus[]).includes(job.status)) throw new AppError("This item cannot be resumed.", "err.cannotResume");
    const pausedLibraryId = job.libraryId;
    const storageRoot = this.locate(job)?.root;
    if (job.sourceAdmission && job.stream) await this.discardProfileSelection(job, job.status === "failed");
    // Read again here rather than trusted from when the job was paused: the right may have
    // gone while it waited, and the answer is what decides.
    const refusal = await this.ownerRefusal(job);
    if (refusal) {
      this.pauseForRefusal(job, refusal);
      await this.save();
      return;
    }
    if (job.pauseReason === "library" && pausedLibraryId) {
      const library = await this.currentLibrary(pausedLibraryId);
      if (!library || !libraryUsable(library) || !libraryAcceptsKind(library, this.kindOf(job))) {
        throw new AppError("The library this download goes to is not available right now.", "err.libraryNotWritable");
      }
      await this.ensureTarget(job, library);
    } else if (!job.target && job.stream) {
      // A direct job that failed before it had anywhere to go, because no library took its kind.
      // Asking again either names the file or refuses the same way; it never falls to the
      // download directory, which is not where the rule asked for it.
      const kind = this.kindOf(job);
      const library = await this.resolveLibrary(kind, job.targetSettings ?? defaultDownloadSettings().movie);
      if (!library) throw new NoLibraryForKindError(kind);
      await this.ensureTarget(job, library);
      job.libraryId = library.id;
    }
    if (this.halt || job.pauseReason === "storage") {
      const space = storageRoot ? await this.freeSpace(storageRoot) : {};
      if (!this.hasRoom(space)) throw new AppError(this.halt?.message ?? "No space left on the disk.", this.halt?.messageKey ?? "err.noSpace");
      this.releaseStorageHalt();
    }
    this.pauseRequested.delete(id);
    if (job.status === "paused" || job.status === "failed") {
      const waiting = Boolean(job.stream?.infoHash && !job.stream.url);
      job.status = waiting ? "waiting" : "queued";
      this.setError(job);
      job.pauseReason = undefined;
      job.notBefore = undefined;
      job.updatedAt = new Date().toISOString();
      if (waiting) this.scheduleDebrid(job.id);
    }
    await this.save();
    this.pump();
  }

  /** A lazy job may be retried under new rules: the selection is swapped before the next
   *  resolve, so a follow whose settings changed does not leave a stale failed copy behind. */
  async retry(
    id: string,
    selection?: DownloadSelection,
    sourceAdmission?: SourceAdmissionSnapshotV1,
  ) {
    const job = this.require(id);
    if (job.status !== "failed") throw new AppError("Only a failed download can be retried.", "err.retryOnlyFailed");
    const rulesAdmission = sourceAdmission === undefined
      ? undefined
      : parseDownloadSourceAdmissionSnapshotV1(sourceAdmission);
    if (rulesAdmission !== undefined
      && (rulesAdmission.profile.template !== "rules"
        || job.sourceAdmission?.profile.template !== "rules")) {
      throw new SourceAdmissionValidationError();
    }
    const pinned = job.sourceAdmission === undefined ? selection?.targetSettings?.libraryId : undefined;
    if (pinned !== undefined && REMOTE_LIBRARY_ID.test(pinned)) throw remoteDownloadRefused();
    if (job.sourceAdmission && job.stream) await this.discardProfileSelection(job, true);
    delete job.travelCursor;
    delete job.sourceFallbackAttempts;
    delete job.travelTemporaryFailures;
    delete job.travelBudgetAttempts;
    delete job.rulesCursor;
    delete job.rulesTemporaryFailures;
    delete job.rulesBudgetAttempts;
    job.retryCount = 0;
    job.notBefore = undefined;
    if (job.source) {
      if (selection && !job.stream && job.sourceAdmission === undefined) job.source.selection = selection;
      job.source.tried = [];
      if (!job.stream) { job.target = ""; job.received = 0; job.total = undefined; }
    }
    if (job.source && !job.stream) this.retrySourceHook?.({ type: job.source.type, videoId: job.source.videoId });
    if (rulesAdmission !== undefined) job.sourceAdmission = rulesAdmission;
    return this.resume(id);
  }

  private clearDebrid(id: string) {
    const timer = this.debridTimers.get(id);
    if (timer) clearTimeout(timer);
    this.debridTimers.delete(id);
  }

  private scheduleDebrid(id: string, delay = 0) {
    this.clearDebrid(id);
    const timer = setTimeout(() => { this.debridTimers.delete(id); void this.pollDebrid(id); }, delay);
    timer.unref?.();
    this.debridTimers.set(id, timer);
  }

  /** The torrent Real-Debrid could not deliver. A lazy job has other sources left, so it goes
   *  back to the queue and the next resolve picks one; a manual job was queued for this very
   *  torrent and fails, as it always has. */
  private async debridSourceFailed(job: DownloadJob, message: string, key?: string) {
    if (!job.source) {
      job.status = "failed";
      this.setError(job, message, key);
      job.updatedAt = new Date(this.now()).toISOString();
      log("ERROR", "Real-Debrid job failed", { id: job.id, title: job.title, reason: message });
      await this.save();
      return;
    }
    if (isExecutableDownloadSnapshot(job.sourceAdmission) && job.stream) {
      job.sourceFallbackAttempts = (job.sourceFallbackAttempts ?? 0) + 1;
      if (job.sourceFallbackAttempts >= SOURCE_FALLBACK_ATTEMPT_LIMIT) {
        await this.failProfileSourceFallback(job, true);
        log("ERROR", "The selected torrent exhausted its source fallback budget", {
          id: job.id, title: job.title, reason: message, tried: job.source.tried.length,
        });
        await this.save();
        return;
      }
      await this.discardProfileSelection(job, true);
      job.status = "queued";
      this.setError(job, `Source failed (${message}), trying the next one\u2026`, "err.sourceFailedTryingNext", { reason: message });
      job.updatedAt = new Date(this.now()).toISOString();
      log("WARN", "The selected torrent failed, trying the next source", {
        id: job.id, title: job.title, reason: message, tried: job.source.tried.length,
        fallback: job.sourceFallbackAttempts,
      });
      await this.save();
      this.pump();
      return;
    }
    if (job.stream) job.source.tried.push(torrentKey(job.stream));
    job.stream = undefined;
    job.subtitle = undefined;
    job.resolution = undefined;
    delete job.sourceStreamAddonIdentity;
    delete job.sourceSubtitleAddonIdentity;
    job.target = "";
    job.debrid = undefined;
    job.debridStartedAt = undefined;
    job.received = 0; job.total = undefined; job.segments = undefined; job.rangesIgnored = undefined; job.retryCount = 0; job.notBefore = undefined;
    job.status = "queued";
    this.setError(job, `Source failed (${message}), trying the next one\u2026`, "err.sourceFailedTryingNext", { reason: message });
    job.updatedAt = new Date(this.now()).toISOString();
    log("WARN", "The torrent failed, trying the next source", { id: job.id, title: job.title, reason: message, tried: job.source.tried.length });
    await this.save();
    this.pump();
  }

  /** The file Real-Debrid resolved has to be the episode the job asked for. A season pack lists
   *  every episode, and a wrong pick would save one episode under another's name. */
  private debridWrongEpisode(job: DownloadJob, filename: string | undefined): boolean {
    if (job.media?.kind !== "episode" || !filename) return false;
    const marker = episodeTag(filename);
    if (!marker) return false;
    const media = job.media;
    return (media.episode != null && marker.episode !== media.episode)
      || (media.season != null && marker.season != null && marker.season !== media.season);
  }

  private async debridMayContinue(job: DownloadJob): Promise<boolean> {
    if (!this.jobs.includes(job) || job.status !== "waiting") return false;
    const refusal = await this.ownerRefusal(job);
    if (!refusal) return this.jobs.includes(job) && job.status === "waiting";
    this.clearDebrid(job.id);
    if (this.jobs.includes(job) && job.status === "waiting") {
      this.pauseForRefusal(job, refusal);
      await this.save();
    }
    return false;
  }

  private async pollDebrid(id: string) {
    const job = this.jobs.find((item) => item.id === id);
    if (!job || job.status !== "waiting" || this.debridBusy.has(id)) return;
    this.debridBusy.add(id);
    try {
      if (!await this.debridMayContinue(job)) return;
      if (this.now() - Date.parse(job.debridStartedAt ?? job.createdAt) > this.debridTimeoutMs) {
        await this.debridSourceFailed(job, "Real-Debrid did not finish the torrent in time.", "err.debridTimeout");
        return;
      }
      if (!this.debrid?.configured()) {
        job.status = "failed"; this.setError(job, "The Real-Debrid token is missing.", "err.debridTokenMissing"); job.updatedAt = new Date().toISOString();
        await this.save();
        return;
      }
      const infoHash = job.stream?.infoHash;
      if (!infoHash) {
        job.status = "failed"; this.setError(job, "The torrent has no infoHash.", "err.jobNoInfoHash"); job.updatedAt = new Date().toISOString();
        await this.save();
        return;
      }
      const exactFile = isExecutableDownloadSnapshot(job.sourceAdmission) && typeof job.stream?.fileIdx === "number";
      const result = await this.debrid.advance({
        infoHash,
        fileIdx: job.stream?.fileIdx,
        torrentId: job.debrid?.torrentId,
        ...(exactFile ? { exactFile: true } : {}),
      });
      if (!await this.debridMayContinue(job)) return;
      job.debrid = { torrentId: result.torrentId, progress: result.ready ? 100 : result.progress, status: result.ready ? "downloaded" : result.status };
      job.updatedAt = new Date().toISOString();
      if (result.ready) {
        const filename = result.filename ?? job.stream?.behaviorHints?.filename;
        if (this.debridWrongEpisode(job, filename)) {
          await this.debridSourceFailed(job, "Real-Debrid resolved a different episode.", "err.debridWrongEpisode");
          return;
        }
        if (isExecutableDownloadSnapshot(job.sourceAdmission) && !isHttpDownloadUrl(result.url)) {
          await this.debridSourceFailed(job, "Real-Debrid returned an invalid download URL.", "err.noMatchingSource");
          return;
        }
        job.stream = {
          ...job.stream,
          url: result.url,
          behaviorHints: { ...job.stream?.behaviorHints, filename: result.filename ?? job.stream?.behaviorHints?.filename },
        };
        job.status = "queued";
        this.setError(job);
        log("INFO", "Real-Debrid finished, HTTP download will start", { id: job.id, title: job.title });
        await this.save();
        this.pump();
        return;
      }
      await this.saveSoon();
      this.scheduleDebrid(job.id, this.debridPollMs);
    } catch (error) {
      if (!await this.debridMayContinue(job)) return;
      this.setError(job, error instanceof Error ? error.message : String(error));
      job.updatedAt = new Date().toISOString();
      if (isRetryableDebridFailure(error)) {
        log("WARN", "Real-Debrid is busy, will retry", { id: job.id, title: job.title, reason: job.error });
        await this.save();
        this.scheduleDebrid(job.id, Math.max(this.debridPollMs, this.debridRetryMs));
        return;
      }
      await this.debridSourceFailed(job, error instanceof Error ? error.message : String(error));
    } finally {
      this.debridBusy.delete(id);
    }
  }

  async remove(id: string, reason: "user" | "account" = "user") {
    const index = this.jobs.findIndex((job) => job.id === id);
    if (index < 0) throw new AppError("The item was not found.", "err.itemNotFound");
    // A guard that throws refuses the removal: the row is left as it was.
    await this.beforeRemove?.(this.jobs[index], reason);
    const job = this.jobs.find((item) => item.id === id);
    if (!job) return;
    // The row leaves the file before its partial leaves the disk: a removal whose write fails
    // keeps both, rather than coming back after a restart with nothing to resume from.
    let at = -1;
    await this.persist({
      apply: () => { at = this.jobs.indexOf(job); if (at >= 0) this.jobs.splice(at, 1); },
      revert: () => { if (at >= 0 && !this.jobs.includes(job)) this.jobs.splice(Math.min(at, this.jobs.length), 0, job); },
    });
    if (at < 0) return;
    this.active.get(id)?.abort();
    if (job.status !== "completed" && job.target) {
      const partial = this.jobPath(job);
      if (partial) await unlink(`${partial}.part`).catch(() => undefined);
      const subtitleFiles = this.subtitleFiles(job);
      if (subtitleFiles) await unlink(subtitleFiles.partial).catch(() => undefined);
    }
    this.pump();
  }

  async move(id: string, direction: -1 | 1) {
    const index = this.jobs.findIndex((job) => job.id === id);
    if (index < 0) throw new AppError("The item was not found.", "err.itemNotFound");
    const next = Math.max(0, Math.min(this.jobs.length - 1, index + direction));
    if (next !== index) { const [job] = this.jobs.splice(index, 1); this.jobs.splice(next, 0, job); await this.save(); }
    this.pump();
  }

  /** Finished jobs, for seeding the statistics from the queue. */
  history() {
    return this.jobs.filter((job) => job.status === "completed" && !job.reusedLocalCopy).map((job) => ({
      // A remote copy has no meaningful address, and its marker is not one: only a local
      // source's URL is reported.
      at: job.updatedAt, bytes: job.received, url: job.remoteDownload ? undefined : job.stream?.url, addonKey: job.stream?.addonKey,
      addonName: job.stream?.addonName, title: job.title, kind: job.media?.kind,
    }));
  }
  async clearCompleted() {
    const completed = this.jobs.filter((job) => job.status === "completed");
    await this.beforeClearCompleted?.(completed);
    let before: DownloadJob[] = [];
    await this.persist({
      apply: () => { before = this.jobs; this.jobs = this.jobs.filter((job) => !completed.includes(job)); },
      revert: () => { this.jobs = before.filter((job) => completed.includes(job) || this.jobs.includes(job)); },
    });
  }
  changed() { this.pump(); }

  async setTravelCursor(id: string, cursor?: TravelContinuationCursorV1): Promise<void> {
    const job = this.require(id);
    const canonical = cursor === undefined ? undefined : parseTravelContinuationCursorV1(cursor);
    if ((job.status !== "queued" && job.status !== "checking") || !supportsTravelCursor(job)) {
      throw new Error("A Travel continuation cursor requires a queued Travel snapshot job.");
    }
    const previous = job.travelCursor;
    const previousBudgetAttempts = job.travelBudgetAttempts;
    await this.persist({
      apply: () => {
        if (canonical === undefined) delete job.travelCursor;
        else job.travelCursor = canonical;
        delete job.travelBudgetAttempts;
      },
      revert: () => {
        if (previous === undefined) delete job.travelCursor;
        else job.travelCursor = previous;
        if (previousBudgetAttempts === undefined) delete job.travelBudgetAttempts;
        else job.travelBudgetAttempts = previousBudgetAttempts;
      },
    });
  }

  async setRulesCursor(id: string, cursor?: RulesContinuationCursorV1): Promise<void> {
    const job = this.require(id);
    const canonical = cursor === undefined ? undefined : parseRulesContinuationCursorV1(cursor);
    if ((job.status !== "queued" && job.status !== "checking") || !supportsRulesCursor(job)) {
      throw new Error("A rules continuation cursor requires a queued rules snapshot job.");
    }
    const previous = job.rulesCursor;
    const previousBudgetAttempts = job.rulesBudgetAttempts;
    await this.persist({
      apply: () => {
        if (canonical === undefined) delete job.rulesCursor;
        else job.rulesCursor = canonical;
        delete job.rulesBudgetAttempts;
      },
      revert: () => {
        if (previous === undefined) delete job.rulesCursor;
        else job.rulesCursor = previous;
        if (previousBudgetAttempts === undefined) delete job.rulesBudgetAttempts;
        else job.rulesBudgetAttempts = previousBudgetAttempts;
      },
    });
  }

  /** The key travels with the text so the interface can render a stored failure in
   *  whatever language is set now, not the one that was set when it failed. */
  private setError(job: DownloadJob, message?: string, key?: string, vars?: Record<string, string | number>) {
    job.error = message; job.errorKey = key; job.errorVars = vars;
  }

  private failSourceAdmission(job: DownloadJob) {
    job.status = "failed";
    job.speed = 0;
    this.setError(job, SOURCE_ADMISSION_RUNTIME_UNAVAILABLE.message, SOURCE_ADMISSION_RUNTIME_UNAVAILABLE.key);
    job.updatedAt = new Date(this.now()).toISOString();
  }

  private async failProfileSourceFallback(job: DownloadJob, markTried: boolean) {
    await this.discardProfileSelection(job, markTried);
    job.status = "failed";
    job.speed = 0;
    this.setError(job, "No matching source was found.", "err.noMatchingSource");
  }

  private require(id: string) { const job = this.jobs.find((item) => item.id === id); if (!job) throw new AppError("The item was not found.", "err.itemNotFound"); return job; }
  /** Source addresses (often carrying tokens) must not reach the interface; only the lazy flag goes out. */
  private publicJob(job: DownloadJob): Omit<PublicDownload, "order"> {
    const {
      stream, source, subtitle: _subtitle, remoteDownload: _remoteDownload, notBefore: _notBefore,
      debrid, segments, sourceAdmission: _sourceAdmission, travelCursor: _travelCursor,
      rulesCursor: _rulesCursor,
      sourceStreamAddonIdentity: _sourceStreamAddonIdentity,
      sourceSubtitleAddonIdentity: _sourceSubtitleAddonIdentity,
      sourceFallbackAttempts: _sourceFallbackAttempts,
      travelTemporaryFailures: _travelTemporaryFailures, travelBudgetAttempts: _travelBudgetAttempts,
      rulesTemporaryFailures: _rulesTemporaryFailures, rulesBudgetAttempts: _rulesBudgetAttempts, ...rest
    } = job;
    return {
      ...rest,
      ownerUserId: this.ownerOf(job),
      pending: job.status !== "completed" && !stream && Boolean(source),
      debridProgress: debrid?.progress,
      segments: segments?.length,
    };
  }
  /** Saves have to run one after another: concurrent writes share one .tmp and the second
   *  rename then has nothing to move. Each write reports its own failure, while the chain
   *  itself swallows it so stop() and later writes carry on. A change handed in is made only
   *  when this write's turn comes and undone before the next write runs, so no other write
   *  ever stores a change whose own write failed. */
  private write(change?: QueueWriteChange): Promise<void> {
    const run = this.saveChain.then(async () => {
      if (this.unreadable) return;
      await change?.apply();
      try {
        const tmp = `${this.stateFile}.tmp`;
        await this.writeState(tmp, JSON.stringify(this.jobs, null, 2));
        await renameWithRetry(tmp, this.stateFile);
      } catch (error) {
        change?.revert();
        throw error;
      }
    });
    this.saveChain = run.catch(() => undefined);
    return run;
  }

  /** A best-effort save: it logs and never rejects, so the many callers that do not wait for
   *  it keep working and a failed write never brings the server down. */
  private save(): Promise<void> {
    return this.write().catch((error) => { log("ERROR", "The queue state could not be saved", { reason: error instanceof Error ? error.message : String(error) }); });
  }

  /** A save an admission waits on: the change lands with its own write or not at all, and
   *  the caller hears the failure. */
  private async persist(change: QueueWriteChange): Promise<void> {
    try {
      await this.write(change);
    } catch (error) {
      log("ERROR", "The queue state could not be saved", { reason: error instanceof Error ? error.message : String(error) });
      throw new AppError("The download queue could not be saved.", "err.queueNotSaved", 503);
    }
  }

  /** Runs each admission after the previous one has settled, so two clicks cannot both pass a
   *  duplicate check or a free-name search. A failure reaches its own caller and does not
   *  block the next admission. */
  private admit<T>(work: () => Promise<T>): Promise<T> {
    const run = this.admission.then(work, work);
    this.admission = run.catch(() => undefined);
    return run;
  }

  /** Adds the job with its own write. A failed write takes it straight back out, so nothing
   *  is left only in memory, or only on disk, to surprise the next start. */
  private async admitJob(job: DownloadJob): Promise<void> {
    this.admitting.add(job.id);
    try {
      await this.persist({
        apply: () => { this.jobs.push(job); },
        revert: () => { const at = this.jobs.indexOf(job); if (at >= 0) this.jobs.splice(at, 1); },
      });
    } finally {
      this.admitting.delete(job.id);
    }
  }
  private saveSoon() { if (this.saveTimer) return; this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.save(); }, 1500); }
  /** The bucket a job's transfer is limited within. A remote copy is bucketed by its actual
   *  provider and server -- across connections and accounts -- never by the sealed address it
   *  was queued with. Every other job keeps the source hostname, and one whose source is not
   *  picked yet shares "?": a series added in bulk thus queues up behind itself. */
  private provider(job: DownloadJob) {
    if (job.remoteDownload) return `remote:${job.remoteDownload.provider}:${job.remoteDownload.serverId}`;
    const url = job.stream?.url; if (!url) return "?"; try { return new URL(url).hostname; } catch { return "?"; }
  }

  /** How many transfers one bucket admits at once. A remote original is always one at a time,
   *  whatever the account's own per-provider preference says. */
  private providerLimit(job: DownloadJob, perProvider: number) {
    return job.remoteDownload ? 1 : (this.provider(job) === "?" ? 1 : perProvider);
  }

  private busy(provider: string, except?: string) {
    let count = 0;
    for (const job of this.jobs) if (this.active.has(job.id) && job.id !== except && this.provider(job) === provider) count += 1;
    return count;
  }

  private storageRemaining() {
    return this.jobs
      .filter((job) => job.status === "paused" && job.pauseReason === "storage")
      .reduce((sum, job) => sum + Math.max(0, (job.total ?? 0) - job.received), 0);
  }

  private hasRoom(space: { freeBytes?: number; totalBytes?: number }, remaining = this.storageRemaining()) {
    if (space.freeBytes == null) return true;
    return space.freeBytes >= storageResumeNeed(space.totalBytes, remaining);
  }

  /** The disk that matters is the one the job writes to, which is not always the download
   *  directory once a save rule names another library. */
  private async admitStorage(needed: number, root = this.downloadDir) {
    const space = await this.freeSpace(root);
    if (space.freeBytes == null) return;
    if (space.freeBytes < needed + storageHeadroom(space.totalBytes)) {
      throw new StorageError("No space left on the disk.", "ENOSPC");
    }
  }

  private releaseStorageHalt() {
    this.halt = undefined;
    if (this.spaceWatch) { clearInterval(this.spaceWatch); this.spaceWatch = undefined; }
    for (const job of this.jobs) {
      if (job.status === "paused" && job.pauseReason === "storage") {
        job.status = "queued";
        job.pauseReason = undefined;
        this.setError(job);
        job.notBefore = undefined;
        job.updatedAt = new Date().toISOString();
      }
    }
  }

  private async haltForStorage(reason: { message: string; key: string }) {
    this.halt = { reason: "storage", at: new Date().toISOString(), message: reason.message, messageKey: reason.key };
    for (const job of this.jobs) {
      if (!this.active.has(job.id) && job.status !== "downloading") continue;
      this.pauseRequested.add(job.id);
      job.status = "paused";
      job.pauseReason = "storage";
      this.setError(job, reason.message, reason.key);
      job.speed = 0;
      this.active.get(job.id)?.abort();
    }
    this.ensureSpaceWatch();
    log("ERROR", "The download queue halted because storage is unavailable", { reason: reason.message });
  }

  private ensureSpaceWatch() {
    if (this.spaceWatch) return;
    this.spaceWatch = setInterval(() => { void this.checkSpace(); }, this.spaceCheckMs);
  }

  private async checkSpace() {
    if (!this.halt) { if (this.spaceWatch) { clearInterval(this.spaceWatch); this.spaceWatch = undefined; } return; }
    try {
      // Every disk a halted job writes to has to have room again, not just the download
      // directory: a save rule may have sent one of them to another mount.
      const roots = new Set(this.jobs.filter((job) => job.pauseReason === "storage")
        .map((job) => this.locate(job)?.root)
        .filter((root): root is string => root != null));
      if (!roots.size) roots.add(this.downloadDir);
      let freeBytes: number | undefined;
      for (const root of roots) {
        const space = await this.freeSpace(root);
        if (space.freeBytes == null) return;
        if (!this.hasRoom(space, 0)) return;
        freeBytes = space.freeBytes;
      }
      log("INFO", "Storage has space again, the queue will continue", { freeBytes });
      this.releaseStorageHalt();
      await this.save();
      this.pump();
    } catch (error) {
      log("WARN", "Free space could not be checked", { reason: error instanceof Error ? error.message : String(error) });
    }
  }

  private pump() {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      if (this.halt || this.stopped) return;
      const limit = Math.max(1, Math.min(8, this.concurrency()));
      const perProvider = Math.max(1, Math.min(8, this.perProvider()));
      const taken = new Map<string, number>();
      const now = this.now();
      for (const job of this.jobs) if (this.active.has(job.id)) { const key = this.provider(job); taken.set(key, (taken.get(key) ?? 0) + 1); }
      while (this.active.size < limit) {
        const job = this.jobs.find((item) => {
          const provider = this.provider(item);
          const providerLimit = this.providerLimit(item, perProvider);
          return item.status === "queued" && !this.active.has(item.id) && !this.admitting.has(item.id) && (item.notBefore ?? 0) <= now && (taken.get(provider) ?? 0) < providerLimit;
        });
        if (!job) break;
        const key = this.provider(job); taken.set(key, (taken.get(key) ?? 0) + 1);
        const run = this.download(job);
        this.running.add(run);
        this.runningById.set(job.id, run);
        const done = () => {
          this.running.delete(run);
          if (this.runningById.get(job.id) === run) this.runningById.delete(job.id);
        };
        void run.then(done, done);
      }
      const waiting = this.jobs.filter((item) => item.status === "queued" && !this.active.has(item.id) && (item.notBefore ?? 0) > now);
      if (waiting.length) {
        const nextAt = Math.min(...waiting.map((item) => item.notBefore!));
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.pump(); }, Math.max(0, nextAt - this.now()));
      }
    });
  }

  /** The addons are asked for streams only here, right before one particular episode is downloaded,
   *  so adding a whole season in bulk does not set off an avalanche of requests at once. */
  private async stageSelectedProfileSource(
    job: DownloadJob,
    outcome: Extract<TravelProfileResolution | ProviderPriorityProfileResolution | RulesProfileResolution, { status: "selected" }>,
    controller: AbortController,
    startedAt: number,
  ): Promise<boolean> {
    if (!job.source || !job.sourceAdmission) {
      throw new SourceError("The job has neither a source nor a rule for finding one.");
    }
    const snapshot = job.sourceAdmission;
    const remote = "remoteDownload" in outcome;
    let selectedStream: StreamItem;
    let remoteDownload: RemoteDownloadReference | undefined;
    let subtitle: SubtitleItem | undefined;
    let streamAddonIdentity: string | undefined;
    let subtitleAddonIdentity: string | undefined;
    if (remote) {
      const admitted = this.remoteAdmission(
        outcome.stream,
        outcome.remoteDownload,
        this.ownerOf(job),
        outcome.resolution.subtitleLanguage,
      );
      selectedStream = admitted.stream;
      remoteDownload = admitted.reference;
    } else {
      selectedStream = outcome.stream;
      subtitle = outcome.subtitle;
      streamAddonIdentity = outcome.streamAddonIdentity;
      subtitleAddonIdentity = outcome.subtitleAddonIdentity;
      const hasUrl = selectedStream.url !== undefined && selectedStream.url !== "";
      if (isTravelSnapshot(snapshot) && selectedStream.infoHash !== undefined) {
        throw new SourceError("No matching source was found.", "err.noMatchingSource");
      }
      if (hasUrl) {
        if (!isHttpDownloadUrl(selectedStream.url)) {
          throw new SourceError("No matching source was found.", "err.noMatchingSource");
        }
      } else if (typeof selectedStream.infoHash !== "string"
        || selectedStream.infoHash.trim() === "") {
        throw new SourceError("No matching source was found.", "err.noMatchingSource");
      }
      if (!hasUrl && this.kindOf(job) === "series"
        && (typeof selectedStream.fileIdx !== "number"
          || !Number.isSafeInteger(selectedStream.fileIdx)
          || selectedStream.fileIdx < 0)) {
        throw new SourceError("No matching source was found.", "err.noMatchingSource");
      }
      if (subtitle !== undefined && !isHttpDownloadUrl(subtitle.url)) {
        throw new SourceError("No matching source was found.", "err.noMatchingSource");
      }
      if (isRemoteDownloadSource(selectedStream)
        || (subtitle && isRemoteMediaStream({ url: subtitle.url }))) {
        throw new SourceError("This library is read-only.", "library.readOnly");
      }
    }

    const settings = job.source.selection?.targetSettings;
    if (!settings) throw new SourceError("No matching source was found.", "err.noMatchingSource");
    const kind = this.kindOf(job);
    const staged: DownloadJob = {
      ...job,
      stream: selectedStream,
      ...(subtitle === undefined ? {} : { subtitle }),
      ...(remoteDownload === undefined ? {} : { remoteDownload }),
      resolution: outcome.resolution,
      ...(streamAddonIdentity === undefined ? {} : { sourceStreamAddonIdentity: streamAddonIdentity }),
      ...(subtitleAddonIdentity === undefined ? {} : { sourceSubtitleAddonIdentity: subtitleAddonIdentity }),
      targetSettings: settings,
    };
    const library = await this.resolveLibrary(kind, settings);
    controller.signal.throwIfAborted();
    if (!library) throw new NoLibraryForKindError(kind);
    staged.libraryId = library.id;
    try {
      await this.ensureTarget(staged, library);
      controller.signal.throwIfAborted();
    } catch (error) {
      if (staged.target) this.targetsInFlight.delete(staged.target);
      throw error;
    }

    const refused = await this.ownerRefusal(staged);
    controller.signal.throwIfAborted();
    if (refused) {
      if (staged.target) this.targetsInFlight.delete(staged.target);
      this.pauseForRefusal(job, refused);
      return false;
    }

    const previous = {
      stream: job.stream,
      subtitle: job.subtitle,
      remoteDownload: job.remoteDownload,
      resolution: job.resolution,
      streamIdentity: job.sourceStreamAddonIdentity,
      subtitleIdentity: job.sourceSubtitleAddonIdentity,
      targetSettings: job.targetSettings,
      target: job.target,
      libraryId: job.libraryId,
      cursor: job.travelCursor,
      temporaryFailures: job.travelTemporaryFailures,
      budgetAttempts: job.travelBudgetAttempts,
      rulesCursor: job.rulesCursor,
      rulesTemporaryFailures: job.rulesTemporaryFailures,
      rulesBudgetAttempts: job.rulesBudgetAttempts,
    };
    try {
      await this.persist({
        apply: () => {
          job.stream = staged.stream;
          if (staged.subtitle === undefined) delete job.subtitle;
          else job.subtitle = staged.subtitle;
          if (staged.remoteDownload === undefined) delete job.remoteDownload;
          else job.remoteDownload = staged.remoteDownload;
          job.resolution = staged.resolution;
          if (staged.sourceStreamAddonIdentity === undefined) delete job.sourceStreamAddonIdentity;
          else job.sourceStreamAddonIdentity = staged.sourceStreamAddonIdentity;
          if (staged.sourceSubtitleAddonIdentity === undefined) delete job.sourceSubtitleAddonIdentity;
          else job.sourceSubtitleAddonIdentity = staged.sourceSubtitleAddonIdentity;
          job.targetSettings = staged.targetSettings;
          job.target = staged.target;
          job.libraryId = staged.libraryId;
          delete job.travelCursor;
          delete job.travelTemporaryFailures;
          delete job.travelBudgetAttempts;
          delete job.rulesCursor;
          delete job.rulesTemporaryFailures;
          delete job.rulesBudgetAttempts;
        },
        revert: () => {
          job.stream = previous.stream;
          job.subtitle = previous.subtitle;
          if (previous.remoteDownload === undefined) delete job.remoteDownload;
          else job.remoteDownload = previous.remoteDownload;
          job.resolution = previous.resolution;
          if (previous.streamIdentity === undefined) delete job.sourceStreamAddonIdentity;
          else job.sourceStreamAddonIdentity = previous.streamIdentity;
          if (previous.subtitleIdentity === undefined) delete job.sourceSubtitleAddonIdentity;
          else job.sourceSubtitleAddonIdentity = previous.subtitleIdentity;
          job.targetSettings = previous.targetSettings;
          job.target = previous.target;
          job.libraryId = previous.libraryId;
          if (previous.cursor === undefined) delete job.travelCursor;
          else job.travelCursor = previous.cursor;
          if (previous.temporaryFailures === undefined) delete job.travelTemporaryFailures;
          else job.travelTemporaryFailures = previous.temporaryFailures;
          if (previous.budgetAttempts === undefined) delete job.travelBudgetAttempts;
          else job.travelBudgetAttempts = previous.budgetAttempts;
          if (previous.rulesCursor === undefined) delete job.rulesCursor;
          else job.rulesCursor = previous.rulesCursor;
          if (previous.rulesTemporaryFailures === undefined) delete job.rulesTemporaryFailures;
          else job.rulesTemporaryFailures = previous.rulesTemporaryFailures;
          if (previous.rulesBudgetAttempts === undefined) delete job.rulesBudgetAttempts;
          else job.rulesBudgetAttempts = previous.rulesBudgetAttempts;
        },
      });
    } catch (error) {
      if (staged.target) this.targetsInFlight.delete(staged.target);
      throw error;
    }
    if (job.target) this.targetsInFlight.delete(job.target);

    const refusedAfterSave = await this.ownerRefusal(job);
    if (controller.signal.aborted || refusedAfterSave) {
      await this.discardProfileSelection(job, false);
      if (refusedAfterSave) this.pauseForRefusal(job, refusedAfterSave);
      await this.save();
      return false;
    }
    log("INFO", "Download source selected", {
      id: job.id, title: job.title, addon: selectedStream.addonName, target: job.target,
      ...(remoteDownload === undefined ? {} : { provider: remoteDownload.provider }),
      library: library.id, attempt: job.source.tried.length + 1, selectionMs: this.now() - startedAt,
      checkedCandidates: outcome.resolution.checkedCandidates, audioLanguage: outcome.resolution.audioLanguage,
      fallbackAudio: outcome.resolution.fallbackUsed, subtitleStatus: outcome.resolution.subtitleStatus,
      searchStatus: outcome.searchStatus,
    });
    return true;
  }

  private async resolveProfile(job: DownloadJob, controller: AbortController): Promise<boolean> {
    if (!job.source) throw new SourceError("The job has neither a source nor a rule for finding one.");
    const snapshot = job.sourceAdmission;
    if (!isExecutableDownloadSnapshot(snapshot)) throw new SourceAdmissionRuntimeUnavailable();
    const startedAt = this.now();

    if (snapshot.profile.template === "travel") {
      if (!this.travelResolver) throw new SourceAdmissionRuntimeUnavailable();
      const outcome = await this.travelResolver({
        source: job.source,
        snapshot,
        ownerUserId: this.ownerOf(job),
        signal: controller.signal,
        ...(job.travelCursor === undefined ? {} : { cursor: job.travelCursor }),
      });
      controller.signal.throwIfAborted();

      if (outcome.status === "accessDenied" || outcome.status === "cancelled") {
        this.pauseForPermission(job);
        return false;
      }
      if (outcome.status === "noMatch") {
        delete job.travelCursor;
        delete job.travelTemporaryFailures;
        delete job.travelBudgetAttempts;
        job.status = "failed";
        job.speed = 0;
        this.setError(job, "No matching source was found.", "err.noMatchingSource");
        return false;
      }
      if (outcome.status === "budgetExhausted" || outcome.status === "temporaryFailure") {
        const temporaryFailure = outcome.status === "temporaryFailure";
        const failures = temporaryFailure ? (job.travelTemporaryFailures ?? 0) + 1 : undefined;
        const budgetAttempts = temporaryFailure ? job.travelBudgetAttempts : (job.travelBudgetAttempts ?? 0) + 1;
        if ((failures !== undefined && failures > TRAVEL_TEMPORARY_FAILURE_LIMIT)
          || (budgetAttempts !== undefined && budgetAttempts > TRAVEL_BUDGET_ATTEMPT_LIMIT)) {
          delete job.travelCursor;
          delete job.travelTemporaryFailures;
          delete job.travelBudgetAttempts;
          job.status = "failed";
          job.speed = 0;
          this.setError(job, "No matching source was found.", "err.noMatchingSource");
          await this.save();
          return false;
        }
        const previousCursor = job.travelCursor;
        const previousFailures = job.travelTemporaryFailures;
        const previousBudgetAttempts = job.travelBudgetAttempts;
        const previousStatus = job.status;
        const previousNotBefore = job.notBefore;
        const wait = this.retryDelay(failures ?? 1);
        await this.persist({
          apply: () => {
            job.travelCursor = outcome.cursor;
            if (failures === undefined) delete job.travelTemporaryFailures;
            else job.travelTemporaryFailures = failures;
            if (budgetAttempts === undefined) delete job.travelBudgetAttempts;
            else job.travelBudgetAttempts = budgetAttempts;
            job.status = "queued";
            job.notBefore = this.now() + wait;
            this.setError(job);
          },
          revert: () => {
            if (previousCursor === undefined) delete job.travelCursor;
            else job.travelCursor = previousCursor;
            if (previousFailures === undefined) delete job.travelTemporaryFailures;
            else job.travelTemporaryFailures = previousFailures;
            if (previousBudgetAttempts === undefined) delete job.travelBudgetAttempts;
            else job.travelBudgetAttempts = previousBudgetAttempts;
            job.status = previousStatus;
            job.notBefore = previousNotBefore;
          },
        });
        return false;
      }
      return this.stageSelectedProfileSource(job, outcome, controller, startedAt);
    }

    if (snapshot.profile.template === "rules") {
      if (!this.rulesResolver) throw new SourceAdmissionRuntimeUnavailable();
      const outcome = await this.rulesResolver({
        source: job.source,
        snapshot,
        ownerUserId: this.ownerOf(job),
        signal: controller.signal,
        ...(job.rulesCursor === undefined ? {} : { cursor: job.rulesCursor }),
        ...((job.rulesTemporaryFailures ?? 0) >= RULES_TEMPORARY_FAILURE_LIMIT
          ? { finalTemporaryAttempt: true }
          : {}),
      });
      controller.signal.throwIfAborted();

      if (outcome.status === "accessDenied" || outcome.status === "cancelled") {
        this.pauseForPermission(job);
        return false;
      }
      if (outcome.status === "noMatch") {
        delete job.rulesCursor;
        delete job.rulesTemporaryFailures;
        delete job.rulesBudgetAttempts;
        job.status = "failed";
        job.speed = 0;
        if (outcome.observations.probesUsed > 0) {
          this.setError(
            job,
            `Checked ${outcome.observations.probesUsed} sources, none matched yet`,
            "err.checkedSources",
            { count: outcome.observations.probesUsed },
          );
        } else {
          this.setError(job, "No matching source was found.", "err.noMatchingSource");
        }
        return false;
      }
      if (outcome.status === "budgetExhausted" || outcome.status === "temporaryFailure") {
        const temporaryFailure = outcome.status === "temporaryFailure";
        const failures = temporaryFailure ? (job.rulesTemporaryFailures ?? 0) + 1 : undefined;
        const budgetAttempts = temporaryFailure ? job.rulesBudgetAttempts : (job.rulesBudgetAttempts ?? 0) + 1;
        if ((failures !== undefined && failures > RULES_TEMPORARY_FAILURE_LIMIT)
          || (budgetAttempts !== undefined && budgetAttempts > RULES_BUDGET_ATTEMPT_LIMIT)) {
          delete job.rulesCursor;
          delete job.rulesTemporaryFailures;
          delete job.rulesBudgetAttempts;
          job.status = "failed";
          job.speed = 0;
          if (budgetAttempts !== undefined) {
            this.setError(
              job,
              `Checked ${outcome.observations.probesUsed} sources, none matched yet`,
              "err.checkedSources",
              { count: outcome.observations.probesUsed },
            );
          } else {
            this.setError(job, "No matching source was found.", "err.noMatchingSource");
          }
          await this.save();
          return false;
        }
        const previousCursor = job.rulesCursor;
        const previousFailures = job.rulesTemporaryFailures;
        const previousBudgetAttempts = job.rulesBudgetAttempts;
        const previousStatus = job.status;
        const previousNotBefore = job.notBefore;
        const wait = this.retryDelay(failures ?? 1);
        await this.persist({
          apply: () => {
            job.rulesCursor = outcome.cursor;
            if (failures === undefined) delete job.rulesTemporaryFailures;
            else job.rulesTemporaryFailures = failures;
            if (budgetAttempts === undefined) delete job.rulesBudgetAttempts;
            else job.rulesBudgetAttempts = budgetAttempts;
            job.status = "queued";
            job.notBefore = this.now() + wait;
            this.setError(job);
          },
          revert: () => {
            if (previousCursor === undefined) delete job.rulesCursor;
            else job.rulesCursor = previousCursor;
            if (previousFailures === undefined) delete job.rulesTemporaryFailures;
            else job.rulesTemporaryFailures = previousFailures;
            if (previousBudgetAttempts === undefined) delete job.rulesBudgetAttempts;
            else job.rulesBudgetAttempts = previousBudgetAttempts;
            job.status = previousStatus;
            job.notBefore = previousNotBefore;
          },
        });
        return false;
      }
      return this.stageSelectedProfileSource(job, outcome, controller, startedAt);
    }

    if (snapshot.profile.template !== "providerPriority" || !this.providerPriorityResolver) {
      throw new SourceAdmissionRuntimeUnavailable();
    }
    const outcome = await this.providerPriorityResolver({
      source: job.source,
      snapshot,
      ownerUserId: this.ownerOf(job),
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    if (outcome.status === "accessDenied" || outcome.status === "cancelled") {
      this.pauseForPermission(job);
      return false;
    }
    if (outcome.status === "noMatch") {
      if (outcome.temporaryFailures > 0) {
        throw new AppError("No matching source was found.", "err.noMatchingSource", 503);
      }
      job.status = "failed";
      job.speed = 0;
      this.setError(job, "No matching source was found.", "err.noMatchingSource");
      return false;
    }
    return this.stageSelectedProfileSource(job, outcome, controller, startedAt);
  }

  private async resolve(job: DownloadJob, controller: AbortController): Promise<boolean> {
    if (!job.source) throw new SourceError("The job has neither a source nor a rule for finding one.");
    if (job.sourceAdmission) {
      return this.resolveProfile(job, controller);
    }
    if (!this.resolver) throw new SourceError("Source selection is unavailable.");
    const startedAt = this.now();
    const resolved = await this.resolver(job.source, this.ownerOf(job), controller.signal);
    controller.signal.throwIfAborted();
    const selectionMs = this.now() - startedAt;
    // A torrent is a resolved source too: it has an infoHash and no URL yet, and the queue turns
    // it into a Real-Debrid wait. Only a stream with neither -- or none at all -- means nothing
    // was found.
    if (!resolved?.stream || (!resolved.stream.url && !resolved.stream.infoHash)) {
      const refused = await this.ownerRefusal(job);
      controller.signal.throwIfAborted();
      if (refused) {
        this.pauseForRefusal(job, refused);
        return false;
      }
      const selection = job.source.selection;
      const requested = selection
        ? selection.audioMode === "preferred"
          ? `No usable source was found${selection.subtitleMode === "required" ? " with the required subtitles" : ""}.`
          : `No source contains ${selection.audioLanguage}${selection.fallbackAudioLanguage ? ` or ${selection.fallbackAudioLanguage}` : ""} audio${selection.subtitleMode === "required" ? " and the required subtitles" : ""}.`
        : "No directly downloadable source was found.";
      log("WARN", "No download source could be resolved", { id: job.id, title: job.title, selectionMs, previouslyTried: job.source.tried.length });
      throw new SourceError(job.source.tried.length
        ? `Every available source failed (${job.source.tried.length}).`
        : requested, "err.noMatchingSource");
    }
    if (isRemoteDownloadSource(resolved.stream) || (resolved.subtitle && isRemoteMediaStream({ url: resolved.subtitle.url }))) {
      throw new SourceError("This library is read-only.", "library.readOnly");
    }
    const settings = job.source.selection?.targetSettings ?? (job.media?.kind === "episode" ? resolved.settings.series : resolved.settings.movie);
    const kind = this.kindOf(job);
    const staged: DownloadJob = {
      ...job,
      stream: resolved.stream,
      subtitle: resolved.subtitle,
      resolution: resolved.resolution,
      targetSettings: settings,
    };
    const library = await this.resolveLibrary(kind, settings);
    controller.signal.throwIfAborted();
    // No library takes this kind, so there is nowhere to put the file. The job is already
    // mid-pump, so it fails rather than reaching ensureTarget with nowhere to write.
    if (!library) throw new NoLibraryForKindError(kind);
    try {
      await this.ensureTarget(staged, library);
      controller.signal.throwIfAborted();
    } catch (error) {
      if (staged.target) this.targetsInFlight.delete(staged.target);
      throw error;
    }
    const refused = await this.ownerRefusal(staged);
    controller.signal.throwIfAborted();
    if (refused) {
      if (staged.target) this.targetsInFlight.delete(staged.target);
      this.pauseForRefusal(job, refused);
      return false;
    }
    job.stream = staged.stream;
    job.subtitle = staged.subtitle;
    delete job.sourceSubtitleAddonIdentity;
    job.resolution = staged.resolution;
    job.targetSettings = settings;
    job.target = staged.target;
    job.libraryId = library.id;
    if (job.target) this.targetsInFlight.delete(job.target);
    await this.save();
    const refusedAfterSave = await this.ownerRefusal(job);
    if (controller.signal.aborted || refusedAfterSave) {
      this.clearLazyChoice(job);
      if (refusedAfterSave) this.pauseForRefusal(job, refusedAfterSave);
      await this.save();
      return false;
    }
    log("INFO", "Download source selected", {
      id: job.id, title: job.title, addon: resolved.stream.addonName, target: job.target, library: library?.id, attempt: job.source.tried.length + 1,
      selectionMs, checkedCandidates: resolved.resolution?.checkedCandidates,
      audioLanguage: resolved.resolution?.audioLanguage, fallbackAudio: resolved.resolution?.fallbackUsed,
      subtitleStatus: resolved.resolution?.subtitleStatus,
    });
    return true;
  }

  private subtitleFiles(job: DownloadJob) {
    if (!job.target || !job.resolution?.subtitleLanguage || job.resolution.subtitleSource !== "addon") return undefined;
    const located = this.locate(job);
    if (!located) return undefined;
    const base = located.relative.slice(0, -path.extname(located.relative).length);
    const target = path.join(located.root, `${base}.${job.resolution.subtitleLanguage}.vtt`);
    return { target, partial: `${target}.part` };
  }

  private async remoteSubtitleTarget(
    root: string,
    directory: string,
    base: string,
    language: string | undefined,
    used: Set<string>,
  ): Promise<string> {
    const stem = language === undefined ? base : `${base}.${language}`;
    for (let copy = 1; copy <= 999; copy += 1) {
      const fitted = fitTargetName(root, directory, stem, ".srt", copy);
      const relative = joinTarget(directory, fitted, ".srt", copy);
      const target = path.join(root, relative);
      if (used.has(target)) continue;
      if (await exists(target) || await exists(`${target}.part`)) continue;
      used.add(target);
      return target;
    }
    throw new SourceError("Could not find a free subtitle file name.");
  }

  /** External subtitles are copied only after the video is published, through the same
   *  owner-bound remote backend. The video stays complete when any subtitle or permission
   *  prevents a sidecar. */
  private async publishRemoteSubtitles(job: DownloadJob, signal: AbortSignal) {
    const subtitles = job.remoteDownload?.subtitles;
    const backend = this.remoteDownload;
    const located = this.locate(job);
    if (!subtitles?.length || !backend || !located) return;
    if (this.remoteRefused(job)) {
      log("WARN", "Media-server subtitles were not copied because the original is no longer permitted", {
        id: job.id, title: job.title,
      });
      return;
    }
    const extension = path.extname(located.relative);
    const stem = extension ? located.relative.slice(0, -extension.length) : located.relative;
    const directory = path.dirname(stem);
    const base = path.basename(stem);
    const used = new Set<string>();
    for (const subtitle of subtitles) {
      try {
        if (this.remoteRefused(job)) {
          log("WARN", "Media-server subtitles were not copied because the original is no longer permitted", {
            id: job.id, title: job.title,
          });
          return;
        }
        const asset = await backend.readSubtitle(job, subtitle, signal);
        const target = await this.remoteSubtitleTarget(located.root, directory, base, subtitle.language, used);
        const partial = `${target}.part`;
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(partial, asset.bytes, { mode: 0o600 });
        try {
          await rename(partial, target);
        } catch (error) {
          await unlink(partial).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        log("WARN", "A media-server subtitle could not be copied", {
          id: job.id,
          title: job.title,
          index: subtitle.index,
          language: subtitle.language,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async prepareSubtitle(job: DownloadJob, controller: AbortController) {
    const files = this.subtitleFiles(job);
    if (!files || !job.subtitle?.url) return;
    if (await exists(files.partial)) return;
    try {
      const response = await safeFetch(job.subtitle.url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
      if (!response.ok) { await response.body?.cancel(); throw new SourceError(`The subtitle source answered HTTP ${response.status}.`); }
      // Written out as UTF-8 whatever it arrived in, so the player never has to guess again.
      const text = subtitleVtt(await readMediaBytes(response), job.resolution?.subtitleLanguage);
      if (!text.includes(" --> ")) throw new SourceError("The subtitle file contains no cues.");
      await mkdir(path.dirname(files.partial), { recursive: true });
      await writeFile(files.partial, text, { mode: 0o600 });
      if (job.resolution) job.resolution.subtitleStatus = "ready";
    } catch (error) {
      if (controller.signal.aborted) throw error;
      if (job.source?.selection?.subtitleMode === "required") throw error;
      job.subtitle = undefined;
      delete job.sourceSubtitleAddonIdentity;
      if (job.resolution) job.resolution.subtitleStatus = "missing";
      log("WARN", "Optional subtitles could not be downloaded", { id: job.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  /** A finished download never replaces what took its name while it was in flight: the final
   *  name is claimed with an exclusive create, and a name already taken sends the file to the
   *  next free one -- the same `(2)` naming a fresh download gets. The empty file this leaves
   *  is what the rename below replaces, so nothing that was already there is ever lost. */
  private async reserveTarget(job: DownloadJob, target: string): Promise<string> {
    const libraryId = job.libraryId ?? parseLibraryPath(job.target)?.libraryId;
    const library = libraryId ? this.libraries().find((item) => item.id === libraryId) : undefined;
    const extension = job.stream ? streamExtension(job.stream) : path.extname(target);
    const { directory, base } = targetPath(job.media, job.title, extension, job.targetSettings ?? defaultDownloadSettings().movie);
    let reserved = target;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const handle = await open(reserved, "wx");
        await handle.close();
        return reserved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // An empty file is this call's own placeholder from a run a crash stopped before the
        // rename: taking it back replaces nothing.
        const held = await stat(reserved).catch(() => undefined);
        if (held?.isFile() && held.size === 0) return reserved;
        job.target = await this.uniqueTarget(library, directory, base, extension);
        this.targetsInFlight.delete(job.target);
        reserved = this.jobPath(job) ?? target;
        log("INFO", "The download's name was taken meanwhile, it was published under another", { id: job.id, title: job.title, target: job.target });
      }
    }
    throw new AppError("Could not find a free file name.", "err.noFreeName");
  }

  /** The empty file `commit` made to claim the name. It goes only while nothing took its place. */
  private async dropPlaceholder(file: string) {
    try {
      if ((await stat(file)).size === 0) await unlink(file);
    } catch { /* already gone */ }
  }

  private publicationLive(job: DownloadJob, signal: AbortSignal): boolean {
    return !signal.aborted
      && this.jobs.includes(job)
      && job.status === "downloading"
      && !this.pauseRequested.has(job.id);
  }

  private async publicationGate(job: DownloadJob, signal: AbortSignal): Promise<PublicationGate> {
    if (!this.publicationLive(job, signal)) return { status: "stopped" };
    const libraryRefusal = await this.libraryKindRefusal(job);
    if (!this.publicationLive(job, signal)) return { status: "stopped" };
    if (libraryRefusal) return { status: "library", error: libraryRefusal };
    if (!isExecutableDownloadSnapshot(job.sourceAdmission) || !job.stream) return { status: "allowed" };
    const refusal = await this.ownerRefusal(job);
    if (!this.publicationLive(job, signal)) return { status: "stopped" };
    if (refusal?.reason === "library") return { status: "library", error: refusal.error };
    if (refusal) return { status: "permission" };
    return { status: "allowed" };
  }

  private failPublicationWithdrawal(job: DownloadJob) {
    if (job.status !== "paused") job.status = "failed";
  }

  private async unlinkIfPresent(file: string): Promise<void> {
    try {
      await unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async clearEmptyReservation(file: string | undefined): Promise<void> {
    if (!file) return;
    try {
      if ((await stat(file)).size === 0) await unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async withdrawPublication(
    reserved: string | undefined,
    subtitleTarget: string | undefined,
    videoPublished: boolean,
    subtitlePublished: boolean,
  ): Promise<void> {
    let cleanupError: unknown;
    const attempt = async (work: () => Promise<void>) => {
      try {
        await work();
      } catch (error) {
        cleanupError ??= error;
      }
    };
    if (videoPublished && reserved) await attempt(() => this.unlinkIfPresent(reserved));
    if (subtitlePublished && subtitleTarget) await attempt(() => this.unlinkIfPresent(subtitleTarget));
    if (!videoPublished) await attempt(() => this.clearEmptyReservation(reserved));
    if (cleanupError !== undefined) throw new PublicationWithdrawalError(cleanupError);
  }

  private async commit(
    job: DownloadJob,
    partial: string,
    target: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    // A remote copy re-checks the owner and the grant one last time before the file is published.
    if (job.remoteDownload && this.remoteRefused(job)) throw new RemotePermissionLost();
    let reserved: string | undefined;
    let subtitleTarget: string | undefined;
    let videoPublished = false;
    let subtitlePublished = false;
    const continuePublication = async (): Promise<boolean> => {
      const gate = await this.publicationGate(job, signal);
      if (gate.status === "allowed") return true;
      await this.withdrawPublication(reserved, subtitleTarget, videoPublished, subtitlePublished);
      if (gate.status === "library" && this.publicationLive(job, signal)) this.pauseForLibrary(job, gate.error);
      if (gate.status === "permission" && this.publicationLive(job, signal)) this.pauseForPermission(job);
      return false;
    };
    if (!await continuePublication()) return false;
    // The partial subtitle was written beside the name the episode had while it downloaded;
    // the reservation may move the episode to "(2)", and the subtitle follows it there.
    const written = this.subtitleFiles(job);
    reserved = await this.reserveTarget(job, target);
    if (!await continuePublication()) return false;
    try {
      const published = this.subtitleFiles(job);
      const files = written && published ? { partial: written.partial, target: published.target } : undefined;
      subtitleTarget = files?.target;
      const moveSubtitle = Boolean(files && await exists(files.partial));
      if (!await continuePublication()) return false;
      if (moveSubtitle && files) {
        await rename(files.partial, files.target);
        subtitlePublished = true;
        if (!await continuePublication()) return false;
      }
      try {
        await this.renamePublication(partial, reserved);
        videoPublished = true;
      } catch (error) {
        if (moveSubtitle && files) await rename(files.target, files.partial).catch(() => undefined);
        throw error;
      }
      if (!await continuePublication()) return false;
    } catch (error) {
      await this.dropPlaceholder(reserved);
      throw error;
    }
    await this.publishRemoteSubtitles(job, signal);
    job.status = "completed"; job.completedAt = new Date(this.now()).toISOString(); job.speed = 0; job.retryCount = 0; job.segments = undefined;
    delete job.sourceFallbackAttempts;
    this.setError(job);
    log("INFO", "Download finished", { id: job.id, received: job.received, target: job.target, audioLanguage: job.resolution?.audioLanguage, subtitleLanguage: job.resolution?.subtitleLanguage });
    try { await this.onCompleted?.(job); }
    catch (error) { log("WARN", "The library could not be refreshed after completion", { id: job.id, reason: error instanceof Error ? error.message : String(error) }); }
    return true;
  }

  /** A file is split only when the source serves byte ranges and the whole size is known.
   *  Anything less and the transfer runs over one stream, exactly as it always did. */
  private async segmentPlan(job: DownloadJob, stream: StreamItem, partSize: number, controller: AbortController) {
    // A source caught ignoring its ranges is not asked about them again: the probe would say
    // 206 and the very plan that cannot work would come back.
    if (job.rangesIgnored) return undefined;
    // A plan already on disk is finished as a plan: its parts sit at their own offsets, so a
    // linear resume would append the rest over the top of them.
    const restored = usableSegments(job.segments, job.total);
    if (restored && partSize === job.total) return restored;
    if (partSize > 0) return undefined;
    const wanted = segmentCount(this.segments());
    if (wanted < 2) return undefined;
    const total = await this.probeRanges(job, stream, controller);
    const plan = total ? planSegments(total, wanted) : [];
    if (plan.length < 2) return undefined;
    job.total = total;
    log("INFO", "The file will be downloaded in segments", { id: job.id, segments: plan.length, total });
    return plan;
  }

  /** One byte is enough to learn both answers: a source that serves ranges says 206 and names
   *  the full size in Content-Range. */
  private async probeRanges(job: DownloadJob, stream: StreamItem, controller: AbortController) {
    const headers: Record<string, string> = { ...(stream.behaviorHints?.proxyHeaders?.request ?? {}), range: "bytes=0-0" };
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await safeFetch(stream.url!, { headers, signal: controller.signal });
      const range = parseContentRange(response.headers.get("content-range"));
      await response.body?.cancel().catch(() => undefined);
      if (response.status !== 206 || !range?.total) {
        log("INFO", "The source does not serve ranges, one stream will be used", { id: job.id, httpStatus: response.status });
        return undefined;
      }
      this.requireRuleSize(job, range.total);
      return range.total;
    } catch (error) {
      if (error instanceof RuleSizeError) throw error;
      if (controller.signal.aborted) throw error;
      log("WARN", "The source could not be asked about ranges", { id: job.id, reason: error instanceof Error ? error.message : String(error) });
      return undefined;
    } finally { clearTimeout(timer); }
  }

  private violatedRuleSizeRange(job: DownloadJob, size: number): { min?: number; max?: number } | undefined {
    if (job.sourceAdmission?.profile.template !== "rules") return undefined;
    const range = job.sourceAdmission.policy.constraints.bytes;
    if (!range || (range.min === undefined || size >= range.min) && (range.max === undefined || size <= range.max)) return undefined;
    return range;
  }

  private requireRuleSize(job: DownloadJob, size: number) {
    const range = this.violatedRuleSizeRange(job, size);
    if (!range) return;
    log("INFO", "Source outside the rule's size range", { id: job.id, size, range });
    throw new RuleSizeError();
  }

  private async transferSegment(stream: StreamItem, handle: FileHandle, segment: Segment, controller: AbortController, note: (bytes: number) => void) {
    const size = segmentSize(segment);
    if (segment.received >= size) return;
    const from = segment.start + segment.received;
    const headers: Record<string, string> = { ...(stream.behaviorHints?.proxyHeaders?.request ?? {}), range: `bytes=${from}-${segment.end}` };
    const timer = setTimeout(() => controller.abort(), 30_000);
    let response: Response;
    try { response = await safeFetch(stream.url!, { headers, signal: controller.signal }); } finally { clearTimeout(timer); }
    if (response.status !== 206 || !response.body) {
      const wait = retryAfterMs(response.headers.get("retry-after"), this.now());
      await response.body?.cancel().catch(() => undefined);
      throw new HttpSourceError(response.status, `The source answered HTTP ${response.status} to a range request.`, wait);
    }
    const range = parseContentRange(response.headers.get("content-range"));
    if (range && range.start !== from) throw new IncompleteDownloadError(segment.received, size);
    const body = Readable.fromWeb(response.body as never);
    let position = from;
    try {
      for await (const chunk of body as AsyncIterable<Buffer>) {
        // A source that ignores the end of the range would otherwise write over the next segment.
        const room = segment.end + 1 - position;
        const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
        await handle.write(piece, 0, piece.length, position);
        position += piece.length; segment.received += piece.length;
        note(piece.length);
        if (position > segment.end) break;
      }
    } finally { body.destroy(); }
    if (segment.received < size) throw new IncompleteDownloadError(segment.received, size);
  }

  /**
   * Assembles a playlist into one file with ffmpeg, copying the streams rather
   * than re-encoding, and renames it in when ffmpeg is done. There is no
   * resuming and no expected size: a playlist states neither, so progress is
   * the size of the file as it grows.
   */
  private async downloadPlaylist(job: DownloadJob, stream: StreamItem, partial: string, target: string, controller: AbortController) {
    await unlink(partial).catch(() => undefined);
    job.received = 0; job.total = undefined; job.segments = undefined;

    const headers = Object.entries(stream.behaviorHints?.proxyHeaders?.request ?? {})
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join("");

    const args = [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
      ...await playlistArgs("ffmpeg"),
      ...(headers ? ["-headers", headers] : []),
      "-i", stream.url!,
      ...(job.resolution?.audioTrack != null
        ? ["-map", "0:v:0?", "-map", `0:a:${job.resolution.audioTrack}?`,
          ...(job.resolution.subtitleTrack != null ? ["-map", `0:s:${job.resolution.subtitleTrack}?`] : []),
          "-c:v", "copy", "-c:a", "copy",
          ...(job.resolution.subtitleTrack != null ? ["-c:s", "mov_text"] : [])]
        : ["-c", "copy"]),
      // ADTS frames out of a transport stream need this to be legal inside MP4.
      "-bsf:a", "aac_adtstoasc",
      "-movflags", "+faststart",
      // The file being written is a .part, so the container cannot be inferred
      // from its name.
      "-f", "mp4", "-y", partial,
    ];

    log("INFO", "Assembling a playlist", { id: job.id, target: job.target });
    const child = trackMedia(spawn(ffmpegPath(), args, { stdio: ["ignore", "ignore", "pipe"] }));

    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4000); });

    let lastSize = 0; let lastAt = this.now();
    const progress = setInterval(() => {
      void stat(partial).then((info) => {
        const grown = info.size - lastSize;
        if (grown <= 0) return;
        job.received = info.size;
        const now = this.now();
        job.speed = grown / Math.max(0.001, (now - lastAt) / 1000);
        lastSize = info.size; lastAt = now; job.updatedAt = new Date().toISOString();
        this.onProgress?.(job, grown);
        this.saveSoon();
      }, () => undefined);
    }, 1000);

    const abort = () => child.kill("SIGKILL");
    controller.signal.addEventListener("abort", abort);

    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      if (controller.signal.aborted) throw new Error("The assembly was stopped.");
      // Killed by the shutdown: nothing is recorded, so the job is still downloading on disk and
      // the next start queues it again, as it did before the shutdown took FFmpeg with it.
      if (code !== 0 && mediaStopping()) await new Promise<never>(() => {});
      if (code !== 0) throw new SourceError(`The playlist could not be assembled. ${stderr.trim().split("\n").pop() ?? ""}`.trim());
    } finally {
      clearInterval(progress);
      controller.signal.removeEventListener("abort", abort);
    }

    const written = await stat(partial).then((info) => info.size, () => 0);
    if (!written) throw new IncompleteDownloadError(0, undefined);

    job.received = written; job.total = written;
    if (!await this.commit(job, partial, target, controller.signal)) return;
    await this.save();
  }

  /** Whether the remote backend currently refuses this job. A queue with no remote backend
   *  refuses every remote job, so one restored where the backend is gone never runs. */
  private remoteRefused(job: DownloadJob): boolean {
    return !this.remoteDownload || !this.remoteDownload.current(job);
  }

  /** Opens the original behind a remote job through the backend alone: never a generic fetch to
   *  an upstream address, and the only place a remote byte read starts. */
  private async openRemote(job: DownloadJob, offset: number, signal: AbortSignal): Promise<Response> {
    if (!this.remoteDownload) throw new SourceError("The media-server download backend is unavailable.");
    return this.remoteDownload.open(job, { method: "GET", ...(offset > 0 ? { range: `bytes=${offset}-` } : {}) }, signal);
  }

  /** Re-proves a running remote copy on the playback cadence: one bounded cycle at a time, a
   *  single timer for the transfer, and no positive fallback. A denial or a cycle that outlives
   *  its deadline aborts the outer read and pauses the job, whether or not the proof honours the
   *  abort. The returned stop function ends the guard and cancels any proof still in flight, so a
   *  finished or cancelled transfer is never touched by an answer that arrives late. */
  private startRemoteGuard(job: DownloadJob, controller: AbortController, onDenied: () => void): (() => void) | undefined {
    const backend = this.remoteDownload;
    if (!job.remoteDownload || !backend) return undefined;
    let cleared = false;
    let proof: AbortController | undefined;
    let deadline: NodeJS.Timeout | undefined;
    const clear = () => {
      if (cleared) return;
      cleared = true;
      clearInterval(timer);
      if (deadline) { clearTimeout(deadline); deadline = undefined; }
      const running = proof;
      proof = undefined;
      running?.abort();
    };
    const deny = () => { if (cleared) return; onDenied(); controller.abort(); };
    const timer = setInterval(() => {
      if (cleared || proof || controller.signal.aborted) return;
      const current = new AbortController();
      proof = current;
      const signal = AbortSignal.any([controller.signal, current.signal]);
      deadline = setTimeout(() => {
        // The deadline is a denial of its own: the proof's transport is aborted, and the outer
        // transfer stops even when the proof ignores the signal and never settles.
        current.abort();
        deny();
      }, this.remoteRevalidateTimeoutMs);
      void backend.revalidate(job, signal).then(
        () => undefined,
        () => deny(),
      ).finally(() => {
        if (deadline) { clearTimeout(deadline); deadline = undefined; }
        if (proof === current) proof = undefined;
      });
    }, this.remoteRevalidateMs);
    timer.unref?.();
    return clear;
  }

  private localCopyCompletionLive(job: DownloadJob, controller: AbortController): boolean {
    return !this.stopped
      && !controller.signal.aborted
      && this.active.get(job.id) === controller
      && this.jobs.includes(job)
      && job.status === "checking"
      && !this.pauseRequested.has(job.id);
  }

  private async completeFromExistingLocalCopy(
    job: DownloadJob,
    copy: ExistingLocalCopyReference,
    controller: AbortController,
    prove: () => ExistingLocalCopyReference | undefined | Promise<ExistingLocalCopyReference | undefined>,
  ): Promise<boolean> {
    const qualified = parseLibraryPath(copy.key);
    if (!qualified || qualified.libraryId !== copy.libraryId
      || !Number.isSafeInteger(copy.actualSize) || copy.actualSize <= 0) return false;

    let completed = false;
    let previous: {
      target: string;
      libraryId: string | undefined;
      status: DownloadStatus;
      completedAt: string | undefined;
      updatedAt: string;
      received: number;
      total: number | undefined;
      speed: number;
      reusedLocalCopy: true | undefined;
      retryCount: number | undefined;
      pauseReason: PauseReason | undefined;
      pausedAt: string | undefined;
      libraryGone: boolean | undefined;
      notBefore: number | undefined;
      error: string | undefined;
      errorKey: string | undefined;
      errorVars: Record<string, string | number> | undefined;
      travelCursor: TravelContinuationCursorV1 | undefined;
      sourceFallbackAttempts: number | undefined;
      travelTemporaryFailures: number | undefined;
      travelBudgetAttempts: number | undefined;
    } | undefined;

    await this.persist({
      apply: async () => {
        if (!this.localCopyCompletionLive(job, controller)) return;
        let fresh: ExistingLocalCopyReference | undefined;
        try {
          fresh = await prove();
        } catch {
          return;
        }
        if (!fresh || fresh.key !== copy.key || fresh.libraryId !== copy.libraryId
          || fresh.actualSize !== copy.actualSize) return;
        if (!this.localCopyCompletionLive(job, controller)) return;
        previous = {
          target: job.target,
          libraryId: job.libraryId,
          status: job.status,
          completedAt: job.completedAt,
          updatedAt: job.updatedAt,
          received: job.received,
          total: job.total,
          speed: job.speed,
          reusedLocalCopy: job.reusedLocalCopy,
          retryCount: job.retryCount,
          pauseReason: job.pauseReason,
          pausedAt: job.pausedAt,
          libraryGone: job.libraryGone,
          notBefore: job.notBefore,
          error: job.error,
          errorKey: job.errorKey,
          errorVars: job.errorVars,
          travelCursor: job.travelCursor,
          sourceFallbackAttempts: job.sourceFallbackAttempts,
          travelTemporaryFailures: job.travelTemporaryFailures,
          travelBudgetAttempts: job.travelBudgetAttempts,
        };
        const at = new Date(this.now()).toISOString();
        job.target = copy.key;
        job.libraryId = copy.libraryId;
        job.status = "completed";
        job.completedAt = at;
        job.updatedAt = at;
        job.received = 0;
        job.total = copy.actualSize;
        job.speed = 0;
        job.reusedLocalCopy = true;
        job.retryCount = undefined;
        job.pauseReason = undefined;
        job.pausedAt = undefined;
        job.libraryGone = undefined;
        job.notBefore = undefined;
        this.setError(job);
        job.travelCursor = undefined;
        job.sourceFallbackAttempts = undefined;
        job.travelTemporaryFailures = undefined;
        job.travelBudgetAttempts = undefined;
        completed = true;
      },
      revert: () => {
        if (!previous) return;
        job.target = previous.target;
        job.libraryId = previous.libraryId;
        job.status = previous.status;
        job.completedAt = previous.completedAt;
        job.updatedAt = previous.updatedAt;
        job.received = previous.received;
        job.total = previous.total;
        job.speed = previous.speed;
        job.reusedLocalCopy = previous.reusedLocalCopy;
        job.retryCount = previous.retryCount;
        job.pauseReason = previous.pauseReason;
        job.pausedAt = previous.pausedAt;
        job.libraryGone = previous.libraryGone;
        job.notBefore = previous.notBefore;
        job.error = previous.error;
        job.errorKey = previous.errorKey;
        job.errorVars = previous.errorVars;
        job.travelCursor = previous.travelCursor;
        job.sourceFallbackAttempts = previous.sourceFallbackAttempts;
        job.travelTemporaryFailures = previous.travelTemporaryFailures;
        job.travelBudgetAttempts = previous.travelBudgetAttempts;
      },
    });
    if (!completed) return false;

    log("INFO", "Download finished from an existing library file", {
      id: job.id, title: job.title, target: job.target, libraryId: job.libraryId, size: job.total,
    });
    try { await this.onCompleted?.(job); }
    catch (error) { log("WARN", "The library could not be refreshed after completion", { id: job.id, reason: error instanceof Error ? error.message : String(error) }); }
    return true;
  }

  private async download(job: DownloadJob) {
    const controller = new AbortController(); this.active.set(job.id, controller); job.status = job.stream ? "downloading" : "checking"; job.startedAt ??= new Date(this.now()).toISOString(); this.setError(job); job.pauseReason = undefined; job.updatedAt = new Date().toISOString(); log("INFO", "Download started", { id: job.id, title: job.title, target: job.target || "(to be chosen)", previousBytes: job.received }); await this.save();
    let retryScheduled = false;
    let inactivity: NodeJS.Timeout | undefined;
    let stalled = false;
    let remoteStopped = false;
    try {
      // The owner is read afresh before any work: the right to queue may be gone since the
      // job was added, and nothing about the request that added it can speak for it now.
      const refused = await this.ownerRefusal(job);
      controller.signal.throwIfAborted();
      if (refused) {
        this.pauseForRefusal(job, refused);
        return;
      }
      // A remote copy has no session to fall back on: the durable reference is re-checked
      // against the live records before a single byte, and a refusal pauses rather than fails.
      if (job.remoteDownload && this.remoteRefused(job)) {
        this.pauseForPermission(job);
        return;
      }
      if (job.sourceAdmission && job.source && !job.stream && this.existingLocalCopyForQueue) {
        const lookup = this.existingLocalCopyForQueue;
        const input: QueuedExistingLocalCopyLookup = {
          ownerUserId: this.ownerOf(job),
          source: job.source,
          media: job.media,
          sourceAdmission: job.sourceAdmission,
        };
        let copy: ExistingLocalCopyReference | undefined;
        try {
          copy = await lookup(input);
        } catch {
          // A local-copy lookup failure leaves the normal resolver path available.
        }
        if (!this.localCopyCompletionLive(job, controller)) return;
        if (copy && await this.completeFromExistingLocalCopy(job, copy, controller, () => lookup(input))) return;
        if (!this.localCopyCompletionLive(job, controller)) return;
        // A permission refusal remains a pause even when the lookup could not establish a copy.
        const refusedAfterLookup = await this.ownerRefusal(job);
        controller.signal.throwIfAborted();
        if (refusedAfterLookup) {
          this.pauseForRefusal(job, refusedAfterLookup);
          return;
        }
      }
      if (job.sourceAdmission && job.sourceFallbackAttempts === SOURCE_FALLBACK_ATTEMPT_LIMIT) {
        await this.failProfileSourceFallback(job, false);
        return;
      }
      if (!job.stream) {
        if (!await this.resolve(job, controller)) return;
        if (controller.signal.aborted) throw new Error("The download was stopped.");
        // The lazy resolve is where this matters most: the enqueue validated a selection, not
        // the addon the resolver eventually picks, and the owner may have lost that one.
        const refused = await this.ownerRefusal(job);
        controller.signal.throwIfAborted();
        if (refused) {
          this.pauseForRefusal(job, refused);
          return;
        }
      }
      // A lazy job whose chosen source is a torrent has nothing to download yet: the magnet has
      // to be fetched by Real-Debrid first, and the resulting HTTP link arrives later. This is
      // the same wait a manual torrent job goes through, entered from the resolve instead of
      // from `add`. The `finally` releases the slot and saves exactly as any other early return.
      if (job.stream && job.stream.infoHash && !job.stream.url) {
        const startedAt = new Date(this.now()).toISOString();
        job.status = "waiting";
        job.debrid = {};
        job.debridStartedAt = startedAt;
        job.updatedAt = startedAt;
        await this.save();
        this.scheduleDebrid(job.id);
        return;
      }
      if (controller.signal.aborted) throw new Error("The download was stopped.");
      job.status = "downloading";
      // The provider is known only after a source is picked. If it is busy, the job goes back to
      // the queue; the next pump puts it in the right bucket and leaves it alone until that frees up.
      if (this.busy(this.provider(job), job.id) >= this.providerLimit(job, Math.max(1, Math.min(8, this.perProvider())))) {
        if (job.sourceAdmission) await this.discardProfileSelection(job, false);
        job.status = "queued";
        log("INFO", "The provider is busy, the job will wait", { id: job.id, title: job.title, provider: this.provider(job) });
        return;
      }
      const stream = job.stream!;
      if (!stream.url) throw new SourceError("Only a direct HTTP stream can be downloaded.");
      // The library this job's target names is not here any more: wait for it rather than
      // writing the file into the download directory, where nobody asked for it.
      const located = this.locate(job);
      if (!located) throw new LibraryUnavailableError(job.libraryId ?? parseLibraryPath(job.target)!.libraryId, true);
      const target = path.join(located.root, located.relative);
      const partial = `${target}.part`;
      await mkdir(path.dirname(target), { recursive: true });
      if (job.sourceAdmission) await unlink(partial).catch(() => undefined);
      if (job.sourceAdmission && !await this.permissionStillHeld(job, controller.signal)) return;
      await this.prepareSubtitle(job, controller);
      if (job.sourceAdmission && !await this.permissionStillHeld(job, controller.signal)) return;

      // A playlist is a list of segments, not a file. Transferring it byte for
      // byte saves the list; the video has to be assembled instead.
      if (isPlaylist(stream.url)) { await this.downloadPlaylist(job, stream, partial, target, controller); return; }

      let offset = 0; try { offset = (await stat(partial)).size; } catch { /* new download */ }
      // A segmented file is written at its full size from the first byte. If the part file no
      // longer has that size, the plan describes something that is not there any more.
      if (job.segments && offset !== job.total) {
        await unlink(partial).catch(() => undefined);
        job.segments = undefined; job.received = 0; offset = 0;
      }
      const hinted = Number(stream.behaviorHints?.videoSize) || undefined;
      // Three attempts should mean "it failed three times in a row", not "three times ever".
      // Once a resumed transfer is properly under way the earlier drop is settled and the budget
      // comes back; otherwise a large file would die of a few hiccups an hour.
      const recoveredAt = 50 * MiB; let recovered = false; let firstByte = false;
      let base = 0; let received = 0; let lastProgressAt = this.now(); let lastSpeedAt = lastProgressAt; let lastBytes = 0; let lastLog = 0;
      const note = (bytes: number) => {
        received += bytes; job.received = received; firstByte = true; lastProgressAt = this.now();
        this.onProgress?.(job, bytes);
        if (!recovered && received - base >= recoveredAt) { recovered = true; job.retryCount = 0; }
        const now = this.now();
        if (now - lastSpeedAt > 800) {
          job.speed = (received - lastBytes) / ((now - lastSpeedAt) / 1000);
          lastSpeedAt = now; lastBytes = received; job.updatedAt = new Date().toISOString(); this.saveSoon();
        }
        if (received - lastLog >= 50 * MiB) {
          log("INFO", "Download progress", { id: job.id, received, total: job.total, speed: Math.round(job.speed) });
          lastLog = received;
        }
      };
      const watchStall = (idleSince: () => number) => {
        const stallPollMs = Math.min(5_000, Math.max(200, Math.min(this.stallInitialMs, this.stallTransferMs) / 2));
        inactivity = setInterval(() => {
          const limit = firstByte ? this.stallTransferMs : this.stallInitialMs;
          if (this.now() - idleSince() > limit) {
            stalled = true;
            log("WARN", "The transfer has not moved", { id: job.id, received, idleMs: this.now() - idleSince() });
            controller.abort();
          }
        }, stallPollMs);
      };
      const start = (bytes: number) => { base = bytes; received = bytes; lastBytes = bytes; lastLog = bytes; job.received = bytes; };

      // A remote original is fetched over one authenticated sequential stream: no range probe
      // and no segment plan, whatever the account's segment preference says.
      const plan = job.remoteDownload ? undefined : await this.segmentPlan(job, stream, offset, controller);
      if (job.total) this.requireRuleSize(job, job.total);
      if (job.sourceAdmission && !await this.permissionStillHeld(job, controller.signal)) return;
      if (plan) {
        job.segments = plan;
        start(segmentedBytes(plan));
        if (job.total) await this.admitStorage(job.total - base, located.root);
        const resumed = offset === job.total;
        const handle = await open(partial, resumed ? "r+" : "w+");
        try {
          if (!resumed) await handle.truncate(job.total!);
          // A connection that dies quietly must not hold the others up, so every segment is
          // watched on its own; a finished one is out of the running.
          const touched = plan.map(() => this.now());
          let failure: unknown;
          watchStall(() => Math.min(...touched));
          await Promise.all(plan.map((segment, index) => this
            .transferSegment(stream, handle, segment, controller, (bytes) => { touched[index] = this.now(); note(bytes); })
            .then(() => { touched[index] = Number.POSITIVE_INFINITY; })
            .catch((error: unknown) => { touched[index] = Number.POSITIVE_INFINITY; failure ??= error; controller.abort(); })));
          if (failure) throw failure;
          await handle.sync();
        } finally { await handle.close(); }
        clearInterval(inactivity); inactivity = undefined;
      } else {
        const headerTimer = setTimeout(() => controller.abort(), 30_000); let response: Response;
        try {
          if (job.remoteDownload) {
            response = await this.openRemote(job, offset, controller.signal);
          } else {
            const headers: Record<string, string> = { ...(stream.behaviorHints?.proxyHeaders?.request ?? {}) }; if (offset) headers.range = `bytes=${offset}-`;
            response = await safeFetch(stream.url, { headers, signal: controller.signal });
          }
        } finally { clearTimeout(headerTimer); }
        if (!response.ok || !response.body) {
          const wait = retryAfterMs(response.headers.get("retry-after"), this.now());
          await response.body?.cancel().catch(() => undefined);
          throw new HttpSourceError(response.status, `The source answered HTTP ${response.status}.`, wait);
        }
        if (job.sourceAdmission && !await this.permissionStillHeld(job, controller.signal)) {
          await response.body.cancel().catch(() => undefined);
          return;
        }
        log("INFO", "Source connected", { id: job.id, httpStatus: response.status, contentLength: response.headers.get("content-length"), contentRange: response.headers.get("content-range") });
        const range = parseContentRange(response.headers.get("content-range"));
        let resumed = false;
        if (offset > 0 && response.status === 206) {
          if (range?.start === offset) resumed = true;
          else if (range?.start === 0 || !range) offset = 0;
          else throw new IncompleteDownloadError(offset, range.total);
        } else if (offset > 0) {
          offset = 0;
        }
        const sourceSize = expectedSize(range?.total, (Number(response.headers.get("content-length")) || 0) + offset || undefined);
        if (sourceSize) {
          if (this.violatedRuleSizeRange(job, sourceSize)) await response.body.cancel().catch(() => undefined);
          this.requireRuleSize(job, sourceSize);
        }
        job.total = expectedSize(sourceSize, hinted);
        start(offset);
        if (job.total) await this.admitStorage(job.total - offset, located.root);
        lastProgressAt = this.now();
        watchStall(() => lastProgressAt);
        const guard = this.startRemoteGuard(job, controller, () => { remoteStopped = true; });
        const monitor = new TransformStream<Uint8Array, Uint8Array>({ transform: (chunk, output) => {
          // A remote copy re-checks the owner, the grant and the target before every chunk, so a
          // revocation that lands mid-transfer stops the bytes rather than finishing the file.
          if (job.remoteDownload && this.remoteRefused(job)) throw new RemotePermissionLost();
          note(chunk.byteLength);
          output.enqueue(chunk);
        } });
        try {
          await pipeline(Readable.fromWeb(response.body.pipeThrough(monitor) as never), this.createWriteStream(partial, { flags: resumed ? "a" : "w" }), { signal: controller.signal });
        } finally { guard?.(); }
        clearInterval(inactivity); inactivity = undefined;
        const handle = await open(partial, "r+");
        try { await handle.sync(); } finally { await handle.close(); }
      }
      const expected = expectedSize(job.total, hinted);
      if (!expected || job.received !== expected) throw new IncompleteDownloadError(job.received, expected);
      if (job.remoteDownload && this.remoteRefused(job)) throw new RemotePermissionLost();
      if (job.sourceAdmission) {
        const refusedAtCommit = await this.ownerRefusal(job);
        controller.signal.throwIfAborted();
        if (refusedAtCommit) {
          this.pauseForRefusal(job, refusedAtCommit);
          return;
        }
      }
      if (!await this.commit(job, partial, target, controller.signal)) return;
    } catch (error) {
      if (error instanceof SourceAdmissionRuntimeUnavailable) {
        this.failSourceAdmission(job);
        log("ERROR", "Download failed", { id: job.id, reason: SOURCE_ADMISSION_RUNTIME_UNAVAILABLE.message });
        return;
      }
      job.speed = 0;
      if (error instanceof PublicationWithdrawalError) {
        if (this.jobs.includes(job)) this.failPublicationWithdrawal(job);
        this.setError(job, "The revoked download could not be removed from the library.", "err.revokedDownloadCleanupFailed");
        log("ERROR", "A revoked download could not withdraw its published files", {
          id: job.id, title: job.title, reason: error.message,
        });
        return;
      }
      const nativeDenied = isMediaServerError(error) && (error.code === "forbidden" || error.code === "unsupported-policy");
      if (isMediaServerError(error) && typeof error.status === "number") error = new HttpSourceError(error.status, error.message, error.retryAfterMs);
      // The rule's library went away while the job waited for its source, or is gone now.
      // Nothing is redirected and nothing fails: the job waits for the library to come back.
      if (error instanceof LibraryUnavailableError) {
        this.pauseForLibrary(job, error);
        await this.save();
        return;
      }
      // No library takes this kind, so no source and no retry would change the answer. The job
      // fails here, mid-pump, rather than being thrown past the caller that started the pump.
      if (error instanceof NoLibraryForKindError) {
        job.status = "failed";
        this.setError(job, error.message, error.messageKey);
        log("ERROR", "Download failed", { id: job.id, title: job.title, reason: error.message });
        return;
      }
      const libraryRefusal = await this.libraryKindRefusal(job);
      if (libraryRefusal) {
        this.pauseForLibrary(job, libraryRefusal);
        return;
      }
      if (job.sourceAdmission) {
        const refusal = await this.ownerRefusal(job);
        if (refusal) {
          this.pauseForRefusal(job, refusal);
          return;
        }
      }
      // A remote copy whose owner, grant or target went away mid-transfer pauses with its
      // partial file kept: the work is not wrong, only the right behind it is gone. A native
      // download-policy refusal counts too -- it is a denial to obey, not a source to retry.
      if (job.remoteDownload && (error instanceof RemotePermissionLost || remoteStopped || this.remoteRefused(job)
        || nativeDenied)) {
        this.pauseForPermission(job);
        return;
      }
      const message = stalled ? "The transfer carried no data." : (error instanceof Error ? error.message : String(error));
      const kind = this.pauseRequested.has(job.id) ? "pause" as const : classifyFailure(error, { stalled });
      if (kind === "pause") {
        job.status = "paused";
        job.pauseReason ??= "user";
      } else if (kind === "storage") {
        if (job.sourceAdmission && job.stream) await this.discardProfileSelection(job, false);
        await this.haltForStorage(storageMessage(error));
      } else if (job.sourceAdmission && job.stream) {
        job.sourceFallbackAttempts = (job.sourceFallbackAttempts ?? 0) + 1;
        if (job.sourceFallbackAttempts >= SOURCE_FALLBACK_ATTEMPT_LIMIT) {
          await this.failProfileSourceFallback(job, true);
          log("ERROR", "Download failed", {
            id: job.id, title: job.title, reason: message, received: job.received, total: job.total,
          });
        } else {
          await this.discardProfileSelection(job, true);
          job.status = "queued";
          const wait = this.retryDelay(1);
          job.notBefore = this.now() + wait;
          this.setError(job, `Source failed (${message}), trying the next one\u2026`, "err.sourceFailedTryingNext", { reason: message });
          retryScheduled = true;
          log("WARN", "The profile source failed, trying the next one", {
            id: job.id, title: job.title, reason: message, tried: job.source?.tried.length,
          });
          if (this.retryTimer) clearTimeout(this.retryTimer);
          this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.pump(); }, wait);
        }
      } else if (kind === "transient" && error instanceof HttpSourceError && error.httpStatus === 200 && job.segments) {
        // The source promised ranges and then answered one with the whole file. The plan cannot
        // work, so it is dropped rather than retried; what is left is a single stream, which this
        // source has just shown it can serve. That is a different plan, not a lost connection, so
        // it does not spend the retry budget and it happens even when that budget is used up.
        job.rangesIgnored = true;
        // The segments wrote at offsets a single stream will not reproduce; resuming onto that
        // file would append over them and leave it silently corrupt.
        const abandoned = this.jobPath(job);
        if (abandoned) await unlink(`${abandoned}.part`).catch(() => undefined);
        job.received = 0; job.total = undefined; job.segments = undefined;
        job.status = "queued"; job.notBefore = undefined;
        retryScheduled = true;
        log("INFO", "The source ignored byte ranges, the segment plan was abandoned", { id: job.id });
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.pump(); }, 2000);
      } else if (kind === "transient" && (job.retryCount ?? 0) < 3) {
        if (error instanceof HttpSourceError && error.httpStatus === 416 && job.target) {
          const stale = this.jobPath(job);
          if (stale) await unlink(`${stale}.part`).catch(() => undefined);
          job.received = 0; job.total = undefined; job.segments = undefined;
        }
        job.retryCount = (job.retryCount ?? 0) + 1;
        const wait = this.retryDelay(job.retryCount, error instanceof HttpSourceError ? error.retryAfterMs : undefined);
        job.notBefore = this.now() + wait;
        job.status = "queued";
        this.setError(job, `Connection dropped, retry ${job.retryCount}/3\u2026`, "err.retryingAfterDrop", { attempt: job.retryCount, of: 3 });
        retryScheduled = true;
        log("WARN", "The transfer broke off, it will be retried", { id: job.id, reason: message, retry: job.retryCount, waitMs: wait });
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.pump(); }, wait);
      } else if (job.source && job.stream?.url) {
        // A lazy job tries the next source in order; the address of the failed one is never used again.
        job.source.tried.push(job.stream.url);
        // A link Real-Debrid produced keeps its torrent identity; without it the same torrent
        // would be chosen again on the next resolve.
        if (job.stream.infoHash) job.source.tried.push(torrentKey(job.stream));
        const abandoned = this.jobPath(job);
        if (job.target && abandoned) await unlink(`${abandoned}.part`).catch(() => undefined);
        const subtitleFiles = this.subtitleFiles(job);
        if (subtitleFiles) await unlink(subtitleFiles.partial).catch(() => undefined);
        job.stream = undefined; job.subtitle = undefined; job.resolution = undefined; delete job.sourceStreamAddonIdentity; delete job.sourceSubtitleAddonIdentity; job.target = ""; job.received = 0; job.total = undefined; job.segments = undefined; job.rangesIgnored = undefined; job.retryCount = 0; job.notBefore = undefined;
        job.status = "queued"; this.setError(job, `Source failed (${message}), trying the next one\u2026`, "err.sourceFailedTryingNext", { reason: message });
        retryScheduled = true; log("WARN", "The source failed, trying the next one", { id: job.id, title: job.title, reason: message, tried: job.source.tried.length });
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.pump(); }, 2000);
      } else {
        job.status = "failed"; this.setError(job, message, messageKeyOf(error));
        log("ERROR", "Download failed", { id: job.id, reason: message, received: job.received, total: job.total });
      }
    } finally {
      if (inactivity) clearInterval(inactivity);
      this.pauseRequested.delete(job.id);
      job.updatedAt = new Date().toISOString();
      this.active.delete(job.id);
      await this.save();
      if (!retryScheduled) this.pump();
    }
  }
}

/** A source that lists segments rather than being the video itself. */
export function isPlaylist(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".m3u8");
  } catch {
    return false;
  }
}
