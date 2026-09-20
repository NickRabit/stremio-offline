import { AppError } from "./errors.js";
import { spawn } from "node:child_process";
import { createWriteStream as fsCreateWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, stat, statfs, unlink, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { addonAllowed } from "./addons.js";
import type { AddonDownloadSettings, AddonRecord, StreamItem, SubtitleItem } from "./types.js";
import { defaultDownloadSettings, joinTarget, streamExtension, targetPath, type MediaInfo } from "./naming.js";
import type { DownloadTargetSettings } from "./types.js";
import { safeFetch } from "./security.js";
import { log } from "./logger.js";
import { retryAfterMs } from "./outbound.js";
import {
  classifyFailure, expectedSize, HttpSourceError, IncompleteDownloadError, parseContentRange,
  retryDelayMs, SourceError, StorageError, storageHeadroom, storageMessage, storageResumeNeed,
  type QueueHalt,
} from "./download-policy.js";
import { isRetryableDebridFailure, type DebridAdvance } from "./debrid.js";
import { playlistArgs } from "./probe.js";
import { libraryPath, libraryVisible, parseLibraryPath, relativeWithin, type LibraryRecord, type Viewer } from "./libraries.js";
import type { UserRecord } from "./users.js";
import {
  planSegments, segmentCount, segmentedBytes, segmentSize, usableSegments, type Segment,
} from "./download-segments.js";
import { readMediaText } from "./media-playlist.js";

export type { QueueHalt };
export type DownloadStatus = "queued" | "waiting" | "checking" | "downloading" | "paused" | "completed" | "failed";
/** `library` is not a fault: the rule's library is switched off, read-only or away, and the job
 *  waits for it rather than landing somewhere the user did not ask for. `permission` is not a
 *  fault either: the account behind the job may no longer queue it, and the job keeps its
 *  place until the right is back. */
export type PauseReason = "user" | "storage" | "library" | "permission";
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
  audioEvidence?: "probe" | "listing" | "none";
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
  /** Present only while a segmented transfer is unfinished; it is what lets each connection
   *  pick up at its own offset after a restart. */
  segments?: Segment[];
  /** The source advertised byte ranges and then ignored them. Segmenting it again would
   *  fail the same way, so every further attempt runs over one stream. */
  rangesIgnored?: boolean;
  createdAt: string; updatedAt: string; startedAt?: string; completedAt?: string;
}

/** Queueing onto the NAS is a right an administrator hands out. The role is what grants an
 *  administrator, never the flags: those are for ordinary users, and a migrated
 *  administrator's may say anything. */
export const mayDownloadToLibrary = (user: Pick<UserRecord, "role" | "permissions">): boolean =>
  user.role === "admin" || user.permissions.downloadToLibrary;

/** The same rule for saving to the device at the keyboard, which is on by default. */
export const mayDownloadToDevice = (user: Pick<UserRecord, "role" | "permissions">): boolean =>
  user.role === "admin" || user.permissions.downloadToDevice;

/** What the owner-bound check reads: the account that asked for the job, the addons and the
 *  libraries as they stand at this moment. Structural, so this module stays free of the store. */
export interface DownloadOwnerScope {
  owner?: Pick<UserRecord, "id" | "role" | "disabled" | "permissions">;
  addons: AddonRecord[];
  libraries: LibraryRecord[];
}

/**
 * The owner-bound check, answered from the current state every time it is asked because a
 * queued job outlives the request that queued it: the account must still exist and may queue,
 * the source addon must be allowed to it and enabled, and the target library must be visible
 * to it, enabled and writable. A part whose subject is not chosen yet is left to the moment it
 * is known -- a lazy job has no source until the resolver picks one, and a library that has
 * been removed is waited for -- so the check is asked again once they are.
 */
export function ownerMayDownload(scope: DownloadOwnerScope, job: { stream?: StreamItem; subtitle?: SubtitleItem; libraryId?: string; target?: string }): boolean {
  const owner = scope.owner;
  if (!owner || owner.disabled || !mayDownloadToLibrary(owner)) return false;
  const viewer: Viewer = { id: owner.id, role: owner.role };
  // Both addons, not only the video's: an external subtitle is commonly chosen from a
  // different one, and it is fetched on resume -- arbitrarily long after a withdrawal.
  for (const addonKey of [job.stream?.addonKey, job.subtitle?.addonKey]) {
    if (!addonKey) continue;
    const addon = scope.addons.find((item) => item.key === addonKey);
    if (!addon?.enabled || !addonAllowed(addon, viewer)) return false;
  }
  const libraryId = job.libraryId ?? (job.target ? parseLibraryPath(job.target)?.libraryId : undefined);
  const library = libraryId ? scope.libraries.find((item) => item.id === libraryId) : undefined;
  if (library && (!libraryVisible(library, viewer) || !library.enabled || Boolean(library.readOnly))) return false;
  return true;
}

/** The owner travels with the source: a job is picked up long after the request that queued
 *  it, and choosing between candidates means asking addons. Which addons may be asked is the
 *  owner's business, so the resolver cannot be given the source alone. */
export type StreamResolver = (source: NonNullable<DownloadJob["source"]>, ownerUserId: string | undefined) => Promise<{
  stream: StreamItem;
  settings: AddonDownloadSettings;
  subtitle?: SubtitleItem;
  resolution?: DownloadResolution;
} | undefined>;
export interface DebridEngine {
  configured: () => boolean;
  advance: (input: { infoHash: string; fileIdx?: number; torrentId?: string }) => Promise<DebridAdvance>;
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
  stallInitialMs?: number;
  stallTransferMs?: number;
  spaceCheckMs?: number;
  /** How many connections one file is split across. */
  segments?: () => number;
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
}

const exists = async (file: string) => { try { await stat(file); return true; } catch { return false; } };
const MiB = 1024 ** 2;

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
class NoLibraryForKindError extends AppError {
  constructor(kind: "movie" | "series") {
    super(
      kind === "series" ? "No library takes series." : "No library takes films.",
      kind === "series" ? "err.noLibraryForSeries" : "err.noLibraryForMovies",
    );
    this.name = "NoLibraryForKindError";
  }
}

/** How long a job waits for a library whose record has gone before taking the default. A folder
 *  removed without forgetting comes back with the same id when it is added again, which is
 *  usually a matter of a minute; half an hour of patience covers a mistake, and after that a
 *  queue that never moves is worse than a file in the default library. */
export const LIBRARY_WAIT_MS = 30 * 60_000;

export async function volumeSpace(target: string) {
  try {
    const info = await statfs(target);
    return { freeBytes: info.bavail * info.bsize, totalBytes: info.blocks * info.bsize };
  } catch {
    return {};
  }
}

export class DownloadQueue {
  private jobs: DownloadJob[] = [];
  private active = new Map<string, AbortController>();
  /** The transfers still in flight, so stop() can wait for their last state write. */
  private running = new Set<Promise<void>>();
  private stopped = false;
  private pauseRequested = new Set<string>();
  private pumpScheduled = false;
  private saveTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private spaceWatch?: NodeJS.Timeout;
  private saveChain: Promise<void> = Promise.resolve();
  private resolver?: StreamResolver;
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
  }

  /** index.ts owns source selection for lazy jobs, because it needs the addons and the settings. */
  setResolver(resolver: StreamResolver) { this.resolver = resolver; }
  setDebrid(engine: DebridEngine) { this.debrid = engine; }
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
    try {
      const parsed: unknown = JSON.parse(await readFile(this.stateFile, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("Queue state is not a list.");
      this.jobs = parsed as DownloadJob[];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        log("ERROR", "The queue state was unreadable, starting empty", { reason: e instanceof Error ? e.message : String(e) });
        await rename(this.stateFile, `${this.stateFile}.bak`).catch(() => undefined);
        this.jobs = [];
      }
    }
    for (const job of this.jobs) {
      if (job.status === "downloading" || job.status === "checking") job.status = "queued";
      job.updatedAt ??= job.createdAt;
      job.speed = 0;
      job.notBefore = undefined;
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

  list() { return this.jobs.map((job, index) => ({ ...this.publicJob(job), order: index })); }
  snapshot() { return { jobs: this.list(), halt: this.haltInfo() }; }

  /** Who asked for a job. A job queued before ownership existed belongs to the administrator
   *  the single-account state migrated into: the answer is resolved here, on reading the job,
   *  and lands in the queue file only when something else writes it. */
  ownerOf(job: Pick<DownloadJob, "ownerUserId">): string | undefined {
    if (!job.ownerUserId) job.ownerUserId = this.legacyOwnerId?.();
    return job.ownerUserId;
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
    if (!wanted) return this.defaultLibrary(kind);
    const named = (await this.libraryState?.(wanted)) ?? this.libraries().find((library) => library.id === wanted);
    if (!named) throw new LibraryUnavailableError(wanted, true);
    if (!libraryUsable(named)) throw new LibraryUnavailableError(named.id);
    return named;
  }

  private kindOf(job: DownloadJob): "movie" | "series" {
    return job.media?.kind === "episode" ? "series" : "movie";
  }

  /** The file name is chosen when the download can actually start, so a name picked while a
   *  disk was away cannot collide with what came back. */
  private async ensureTarget(job: DownloadJob, library: LibraryRecord | undefined) {
    if (job.target || !job.stream) return;
    const extension = streamExtension(job.stream);
    const { directory, base } = targetPath(job.media, job.title, extension, job.targetSettings ?? defaultDownloadSettings().movie);
    job.target = await this.uniqueTarget(library, directory, base, extension);
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

  /** The owner-bound check as the queue asks it: the answer comes from the account, the
   *  addons and the libraries as they are now, never from the request that queued the job.
   *  A refusal pauses the job rather than failing it, because the work is not wrong and the
   *  queue position is worth keeping for when the permission comes back. */
  private async ownerRefused(job: DownloadJob): Promise<boolean> {
    return this.ownerAllowed ? !await this.ownerAllowed(job) : false;
  }

  private pauseForPermission(job: DownloadJob) {
    job.status = "paused";
    job.pauseReason = "permission";
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
      const named = (await this.libraryState?.(waited)) ?? this.libraries().find((item) => item.id === waited);
      if (named && !libraryUsable(named)) continue;
      // A library whose record is gone gets a deadline: the folder keeps its identity, so a
      // re-add brings this same library back and the job continues there. Past the deadline
      // nothing is coming, and a queue that waits for ever is not honest either.
      const expired = !named && job.libraryGone && this.now() - Date.parse(job.pausedAt ?? "") >= this.libraryWaitMs;
      if (!named && !expired) continue;
      const kind = this.kindOf(job);
      const library = named ?? this.defaultLibrary(kind);
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

  async add(title: string, stream: StreamItem, media?: MediaInfo, targetSettings: DownloadTargetSettings = defaultDownloadSettings().movie, ownerUserId?: string) {
    if (!stream.url && stream.infoHash) return this.addDebrid(title, stream, media, targetSettings, ownerUserId);
    if (!stream.url) throw new AppError("Only a direct HTTP stream can be downloaded.", "err.downloadNeedsHttp");
    // Without this check a double click on Download yields the same film twice, because
    // uniqueTarget happily hands the second job a name with "(2)".
    const duplicate = this.jobs.find((job) => job.stream?.url === stream.url && job.status !== "failed");
    if (duplicate && duplicate.status !== "completed") throw new AppError("This source is already in the queue.", "err.sourceQueued");
    const duplicatePath = duplicate ? this.jobPath(duplicate) : undefined;
    if (duplicatePath && await exists(duplicatePath)) throw new AppError("This source is already in the library.", "err.sourceDownloaded");
    const extension = streamExtension(stream);
    const kind = media?.kind === "episode" ? "series" : "movie";
    const now = new Date().toISOString();
    const job: DownloadJob = { id: crypto.randomUUID(), ownerUserId, title, stream, media, status: "queued", target: "", received: 0, speed: 0, targetSettings, createdAt: now, updatedAt: now };
    try {
      const library = await this.resolveLibrary(kind, targetSettings);
      if (!library) throw new NoLibraryForKindError(kind);
      await this.ensureTarget(job, library);
      job.libraryId = library.id;
    } catch (error) {
      if (!(error instanceof LibraryUnavailableError)) throw error;
      this.pauseForLibrary(job, error);
    }
    this.jobs.push(job); await this.save();
    if (job.status === "paused") return this.publicJob(job);
    this.pump();
    return this.publicJob(job);
  }

  private sameTorrent(left: StreamItem | undefined, right: StreamItem) {
    return Boolean(left?.infoHash && left.infoHash === right.infoHash && (left.fileIdx ?? 0) === (right.fileIdx ?? 0));
  }

  private async addDebrid(title: string, stream: StreamItem, media: MediaInfo | undefined, targetSettings: DownloadTargetSettings, ownerUserId?: string) {
    if (!this.debrid?.configured()) throw new AppError("Set up Real-Debrid in Settings first.", "err.debridNotConfigured");
    const duplicate = this.jobs.find((job) => this.sameTorrent(job.stream, stream) && job.status !== "failed");
    if (duplicate && duplicate.status !== "completed") throw new AppError("This torrent is already in the queue.", "err.torrentQueued");
    const now = new Date().toISOString();
    const job: DownloadJob = {
      id: crypto.randomUUID(), ownerUserId, title, stream, media, status: "waiting", target: "", received: 0, speed: 0,
      debrid: {}, targetSettings, createdAt: now, updatedAt: now,
    };
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
    this.jobs.push(job); await this.save();
    if (job.status === "paused") return this.publicJob(job);
    log("INFO", "Waiting for Real-Debrid", { id: job.id, title: job.title, infoHash: stream.infoHash });
    this.scheduleDebrid(job.id);
    return this.publicJob(job);
  }

  /** A lazy job: both target and source are filled in when the download starts. A duplicate episode is not added. */
  async addPending(title: string, source: { type: string; videoId: string; selection?: DownloadSelection }, media?: MediaInfo, ownerUserId?: string) {
    if (this.jobs.some((job) => job.source?.videoId === source.videoId && job.status !== "completed" && job.status !== "failed")) return undefined;
    const now = new Date().toISOString();
    const job: DownloadJob = { id: crypto.randomUUID(), ownerUserId, title, media, source: { ...source, tried: [] }, status: "queued", target: "", received: 0, speed: 0, createdAt: now, updatedAt: now };
    this.jobs.push(job); await this.save(); this.pump(); return this.publicJob(job);
  }

  /** History can be cleared, but the files stay. A free name therefore has to be looked for on
   *  disk as well, or a finished film would be quietly overwritten by downloading the same title. */
  private async uniqueTarget(library: LibraryRecord | undefined, directory: string, base: string, extension: string) {
    for (let copy = 1; copy <= 999; copy += 1) {
      const relative = joinTarget(directory, base, extension, copy);
      const target = library ? libraryPath(library.id, relative) : relative;
      if (this.jobs.some((job) => job.target === target)) continue;
      const full = path.join(library?.root ?? this.downloadDir, relative);
      if (await exists(full) || await exists(`${full}.part`)) continue;
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

  /** Drops every unfinished job the predicate names, its partial file with it. What is
   *  completed stays: it is in the library and belongs to nobody's access any more. */
  async removeMatching(match: (job: DownloadJob) => boolean): Promise<number> {
    const ids = this.jobs.filter((job) => job.status !== "completed" && match(job)).map((job) => job.id);
    for (const id of ids) await this.remove(id);
    return ids.length;
  }

  async resume(id: string) {
    const job = this.require(id);
    if (!(["paused", "failed"] as DownloadStatus[]).includes(job.status)) throw new AppError("This item cannot be resumed.", "err.cannotResume");
    // Read again here rather than trusted from when the job was paused: the right may have
    // gone while it waited, and the answer is what decides.
    if (await this.ownerRefused(job)) {
      this.pauseForPermission(job);
      await this.save();
      return;
    }
    if (job.pauseReason === "library" && job.libraryId) {
      const library = (await this.libraryState?.(job.libraryId)) ?? this.libraries().find((item) => item.id === job.libraryId);
      if (!library || !libraryUsable(library)) throw new AppError("The library this download goes to is not available right now.", "err.libraryNotWritable");
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
      const root = this.locate(job)?.root;
      const space = root ? await this.freeSpace(root) : {};
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

  async retry(id: string) {
    const job = this.require(id);
    if (job.status !== "failed") throw new AppError("Only a failed download can be retried.", "err.retryOnlyFailed");
    job.retryCount = 0;
    job.notBefore = undefined;
    if (job.source) {
      job.source.tried = [];
      if (!job.stream) { job.target = ""; job.received = 0; job.total = undefined; }
    }
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

  private async pollDebrid(id: string) {
    const job = this.jobs.find((item) => item.id === id);
    if (!job || job.status !== "waiting" || this.debridBusy.has(id)) return;
    this.debridBusy.add(id);
    try {
      if (this.now() - Date.parse(job.createdAt) > this.debridTimeoutMs) {
        job.status = "failed"; this.setError(job, "Real-Debrid did not finish the torrent in time.", "err.debridTimeout"); job.updatedAt = new Date().toISOString();
        await this.save();
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
      const result = await this.debrid.advance({ infoHash, fileIdx: job.stream?.fileIdx, torrentId: job.debrid?.torrentId });
      job.debrid = { torrentId: result.torrentId, progress: result.ready ? 100 : result.progress, status: result.ready ? "downloaded" : result.status };
      job.updatedAt = new Date().toISOString();
      if (result.ready) {
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
      this.setError(job, error instanceof Error ? error.message : String(error));
      job.updatedAt = new Date().toISOString();
      if (isRetryableDebridFailure(error)) {
        log("WARN", "Real-Debrid is busy, will retry", { id: job.id, title: job.title, reason: job.error });
        await this.save();
        this.scheduleDebrid(job.id, Math.max(this.debridPollMs, this.debridRetryMs));
        return;
      }
      job.status = "failed";
      log("ERROR", "Real-Debrid job failed", { id: job.id, title: job.title, reason: job.error });
      await this.save();
    } finally {
      this.debridBusy.delete(id);
    }
  }

  async remove(id: string) {
    const index = this.jobs.findIndex((job) => job.id === id);
    if (index < 0) throw new AppError("The item was not found.", "err.itemNotFound");
    const [job] = this.jobs.splice(index, 1);
    this.active.get(id)?.abort();
    if (job.status !== "completed" && job.target) {
      const partial = this.jobPath(job);
      if (partial) await unlink(`${partial}.part`).catch(() => undefined);
      const subtitleFiles = this.subtitleFiles(job);
      if (subtitleFiles) await unlink(subtitleFiles.partial).catch(() => undefined);
    }
    await this.save();
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
    return this.jobs.filter((job) => job.status === "completed").map((job) => ({
      at: job.updatedAt, bytes: job.received, url: job.stream?.url, addonKey: job.stream?.addonKey,
      addonName: job.stream?.addonName, title: job.title, kind: job.media?.kind,
    }));
  }
  async clearCompleted() { this.jobs = this.jobs.filter((job) => job.status !== "completed"); await this.save(); }
  changed() { this.pump(); }
  /** The key travels with the text so the interface can render a stored failure in
   *  whatever language is set now, not the one that was set when it failed. */
  private setError(job: DownloadJob, message?: string, key?: string, vars?: Record<string, string | number>) {
    job.error = message; job.errorKey = key; job.errorVars = vars;
  }

  private require(id: string) { const job = this.jobs.find((item) => item.id === id); if (!job) throw new AppError("The item was not found.", "err.itemNotFound"); return job; }
  /** Source addresses (often carrying tokens) must not reach the interface; only the lazy flag goes out. */
  private publicJob(job: DownloadJob) {
    const { stream, source, subtitle: _subtitle, notBefore: _notBefore, debrid, segments, ...rest } = job;
    return { ...rest, ownerUserId: this.ownerOf(job), pending: !stream && Boolean(source), debridProgress: debrid?.progress, segments: segments?.length };
  }
  /** Saves have to run one after another: concurrent writes share one .tmp and the second
   *  rename then has nothing to move. A failed state write must not bring the server down either. */
  private save() {
    this.saveChain = this.saveChain.then(async () => {
      const tmp = `${this.stateFile}.tmp`;
      await writeFile(tmp, JSON.stringify(this.jobs, null, 2), { mode: 0o600 });
      await rename(tmp, this.stateFile);
    }).catch((error) => { log("ERROR", "The queue state could not be saved", { reason: error instanceof Error ? error.message : String(error) }); });
    return this.saveChain;
  }
  private saveSoon() { if (this.saveTimer) return; this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.save(); }, 1500); }
  /** The provider from the source address. Until a source is picked every job shares one
   * bucket -- a series added in bulk thus queues up behind itself instead of arriving all at once. */
  private provider(job: DownloadJob) { const url = job.stream?.url; if (!url) return "?"; try { return new URL(url).hostname; } catch { return "?"; } }

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
          const providerLimit = provider === "?" ? 1 : perProvider;
          return item.status === "queued" && !this.active.has(item.id) && (item.notBefore ?? 0) <= now && (taken.get(provider) ?? 0) < providerLimit;
        });
        if (!job) break;
        const key = this.provider(job); taken.set(key, (taken.get(key) ?? 0) + 1);
        const run = this.download(job);
        this.running.add(run);
        void run.then(() => this.running.delete(run), () => this.running.delete(run));
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
  private async resolve(job: DownloadJob) {
    if (!job.source) throw new SourceError("The job has neither a source nor a rule for finding one.");
    if (!this.resolver) throw new SourceError("Source selection is unavailable.");
    const startedAt = this.now();
    const resolved = await this.resolver(job.source, this.ownerOf(job));
    const selectionMs = this.now() - startedAt;
    if (!resolved?.stream.url) {
      const selection = job.source.selection;
      const requested = selection
        ? selection.audioMode === "preferred"
          ? `No usable source was found${selection.subtitleMode === "required" ? " with the required subtitles" : ""}.`
          : `No source contains ${selection.audioLanguage}${selection.fallbackAudioLanguage ? ` or ${selection.fallbackAudioLanguage}` : ""} audio${selection.subtitleMode === "required" ? " and the required subtitles" : ""}.`
        : "No directly downloadable source was found.";
      log("WARN", "No download source could be resolved", { id: job.id, title: job.title, selectionMs, previouslyTried: job.source.tried.length });
      throw new SourceError(job.source.tried.length
        ? `Every available source failed (${job.source.tried.length}).`
        : requested);
    }
    job.stream = resolved.stream;
    job.subtitle = resolved.subtitle;
    job.resolution = resolved.resolution;
    const settings = job.source.selection?.targetSettings ?? (job.media?.kind === "episode" ? resolved.settings.series : resolved.settings.movie);
    job.targetSettings = settings;
    const kind = this.kindOf(job);
    const library = await this.resolveLibrary(kind, settings);
    // No library takes this kind, so there is nowhere to put the file. The job is already
    // mid-pump, so it fails rather than reaching ensureTarget with nowhere to write.
    if (!library) throw new NoLibraryForKindError(kind);
    await this.ensureTarget(job, library);
    job.libraryId = library.id;
    await this.save();
    log("INFO", "Download source selected", {
      id: job.id, title: job.title, addon: resolved.stream.addonName, target: job.target, library: library?.id, attempt: job.source.tried.length + 1,
      selectionMs, checkedCandidates: resolved.resolution?.checkedCandidates,
      audioLanguage: resolved.resolution?.audioLanguage, fallbackAudio: resolved.resolution?.fallbackUsed,
      subtitleStatus: resolved.resolution?.subtitleStatus,
    });
  }

  private subtitleFiles(job: DownloadJob) {
    if (!job.target || !job.resolution?.subtitleLanguage || job.resolution.subtitleSource !== "addon") return undefined;
    const located = this.locate(job);
    if (!located) return undefined;
    const base = located.relative.slice(0, -path.extname(located.relative).length);
    const target = path.join(located.root, `${base}.${job.resolution.subtitleLanguage}.vtt`);
    return { target, partial: `${target}.part` };
  }

  private async prepareSubtitle(job: DownloadJob, controller: AbortController) {
    const files = this.subtitleFiles(job);
    if (!files || !job.subtitle?.url) return;
    if (await exists(files.partial)) return;
    try {
      const response = await safeFetch(job.subtitle.url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
      if (!response.ok) { await response.body?.cancel(); throw new SourceError(`The subtitle source answered HTTP ${response.status}.`); }
      let text = await readMediaText(response);
      if (!text.trimStart().startsWith("WEBVTT")) text = `WEBVTT\n\n${text.replace(/^\ufeff/, "").replace(/\r/g, "").replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2").replace(/^\d+\n(?=\d{2}:\d{2}:\d{2}[.,]\d{3} -->)/gm, "")}`;
      if (!text.includes(" --> ")) throw new SourceError("The subtitle file contains no cues.");
      await mkdir(path.dirname(files.partial), { recursive: true });
      await writeFile(files.partial, text, { mode: 0o600 });
      if (job.resolution) job.resolution.subtitleStatus = "ready";
    } catch (error) {
      if (controller.signal.aborted) throw error;
      if (job.source?.selection?.subtitleMode === "required") throw error;
      job.subtitle = undefined;
      if (job.resolution) job.resolution.subtitleStatus = "missing";
      log("WARN", "Optional subtitles could not be downloaded", { id: job.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  private async commit(job: DownloadJob, partial: string, target: string) {
    const files = this.subtitleFiles(job);
    const moveSubtitle = Boolean(files && await exists(files.partial));
    if (moveSubtitle && files) await rename(files.partial, files.target);
    try {
      await rename(partial, target);
    } catch (error) {
      if (moveSubtitle && files) await rename(files.target, files.partial).catch(() => undefined);
      throw error;
    }
    job.status = "completed"; job.completedAt = new Date(this.now()).toISOString(); job.speed = 0; job.retryCount = 0; job.segments = undefined; this.setError(job);
    log("INFO", "Download finished", { id: job.id, received: job.received, target: job.target, audioLanguage: job.resolution?.audioLanguage, subtitleLanguage: job.resolution?.subtitleLanguage });
    try { await this.onCompleted?.(job); }
    catch (error) { log("WARN", "The library could not be refreshed after completion", { id: job.id, reason: error instanceof Error ? error.message : String(error) }); }
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
      return range.total;
    } catch (error) {
      if (controller.signal.aborted) throw error;
      log("WARN", "The source could not be asked about ranges", { id: job.id, reason: error instanceof Error ? error.message : String(error) });
      return undefined;
    } finally { clearTimeout(timer); }
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
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });

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
      if (code !== 0) throw new SourceError(`The playlist could not be assembled. ${stderr.trim().split("\n").pop() ?? ""}`.trim());
    } finally {
      clearInterval(progress);
      controller.signal.removeEventListener("abort", abort);
    }

    const written = await stat(partial).then((info) => info.size, () => 0);
    if (!written) throw new IncompleteDownloadError(0, undefined);

    job.received = written; job.total = written;
    await this.commit(job, partial, target);
    await this.save();
  }

  private async download(job: DownloadJob) {
    const controller = new AbortController(); this.active.set(job.id, controller); job.status = job.stream ? "downloading" : "checking"; job.startedAt ??= new Date(this.now()).toISOString(); this.setError(job); job.pauseReason = undefined; job.updatedAt = new Date().toISOString(); log("INFO", "Download started", { id: job.id, title: job.title, target: job.target || "(to be chosen)", previousBytes: job.received }); await this.save();
    let retryScheduled = false;
    let inactivity: NodeJS.Timeout | undefined;
    let stalled = false;
    try {
      // The owner is read afresh before any work: the right to queue may be gone since the
      // job was added, and nothing about the request that added it can speak for it now.
      if (await this.ownerRefused(job)) {
        this.pauseForPermission(job);
        return;
      }
      if (!job.stream) {
        await this.resolve(job);
        if (controller.signal.aborted) throw new Error("The download was stopped.");
        // The lazy resolve is where this matters most: the enqueue validated a selection, not
        // the addon the resolver eventually picks, and the owner may have lost that one.
        if (await this.ownerRefused(job)) {
          this.pauseForPermission(job);
          return;
        }
      }
      if (controller.signal.aborted) throw new Error("The download was stopped.");
      job.status = "downloading";
      // The provider is known only after a source is picked. If it is busy, the job goes back to
      // the queue; the next pump puts it in the right bucket and leaves it alone until that frees up.
      if (this.busy(this.provider(job), job.id) >= Math.max(1, Math.min(8, this.perProvider()))) {
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
      await this.prepareSubtitle(job, controller);

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

      const plan = await this.segmentPlan(job, stream, offset, controller);
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
        const headers: Record<string, string> = { ...(stream.behaviorHints?.proxyHeaders?.request ?? {}) }; if (offset) headers.range = `bytes=${offset}-`;
        const headerTimer = setTimeout(() => controller.abort(), 30_000); let response: Response;
        try { response = await safeFetch(stream.url, { headers, signal: controller.signal }); } finally { clearTimeout(headerTimer); }
        if (!response.ok || !response.body) {
          const wait = retryAfterMs(response.headers.get("retry-after"), this.now());
          await response.body?.cancel().catch(() => undefined);
          throw new HttpSourceError(response.status, `The source answered HTTP ${response.status}.`, wait);
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
        job.total = expectedSize(range?.total, (Number(response.headers.get("content-length")) || 0) + offset || undefined, hinted);
        start(offset);
        if (job.total) await this.admitStorage(job.total - offset, located.root);
        lastProgressAt = this.now();
        watchStall(() => lastProgressAt);
        const monitor = new TransformStream<Uint8Array, Uint8Array>({ transform: (chunk, output) => {
          note(chunk.byteLength);
          output.enqueue(chunk);
        } });
        await pipeline(Readable.fromWeb(response.body.pipeThrough(monitor) as never), this.createWriteStream(partial, { flags: resumed ? "a" : "w" }), { signal: controller.signal });
        clearInterval(inactivity); inactivity = undefined;
        const handle = await open(partial, "r+");
        try { await handle.sync(); } finally { await handle.close(); }
      }
      const expected = expectedSize(job.total, hinted);
      if (!expected || job.received !== expected) throw new IncompleteDownloadError(job.received, expected);
      await this.commit(job, partial, target);
    } catch (error) {
      job.speed = 0;
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
      const message = stalled ? "The transfer carried no data." : (error instanceof Error ? error.message : String(error));
      const kind = this.pauseRequested.has(job.id) ? "pause" as const : classifyFailure(error, { stalled });
      if (kind === "pause") {
        job.status = "paused";
        job.pauseReason ??= "user";
      } else if (kind === "storage") {
        await this.haltForStorage(storageMessage(error));
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
        const abandoned = this.jobPath(job);
        if (job.target && abandoned) await unlink(`${abandoned}.part`).catch(() => undefined);
        const subtitleFiles = this.subtitleFiles(job);
        if (subtitleFiles) await unlink(subtitleFiles.partial).catch(() => undefined);
        job.stream = undefined; job.subtitle = undefined; job.resolution = undefined; job.target = ""; job.received = 0; job.total = undefined; job.segments = undefined; job.rangesIgnored = undefined; job.retryCount = 0; job.notBefore = undefined;
        job.status = "queued"; this.setError(job, `Source failed (${message}), trying the next one\u2026`, "err.sourceFailedTryingNext", { reason: message });
        retryScheduled = true; log("WARN", "The source failed, trying the next one", { id: job.id, title: job.title, reason: message, tried: job.source.tried.length });
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.pump(); }, 2000);
      } else {
        job.status = "failed"; this.setError(job, message);
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
