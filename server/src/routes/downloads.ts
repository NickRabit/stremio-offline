import { stat } from "node:fs/promises";
import type express from "express";
import { allowedAddons } from "../addons.js";
import type { DeviceTransfers } from "../device-transfers.js";
import { NoLibraryForKindError, isRemoteDownloadSource, ownerMayDownload, remoteDownloadRefused, remoteDownloadStream, type AudioMode, type DownloadQueue, type DownloadSelection, type SubtitleMode } from "../downloads.js";
import { AppError } from "../errors.js";
import { normalizeLanguage } from "../language.js";
import { log } from "../logger.js";
import { libraryVisible, resolveLibraryPath, type LibraryRecord, type Viewer } from "../libraries.js";
import { defaultDownloadSettings, exactSubfolder, targetLibrary, type MediaInfo } from "../naming.js";
import { defaultRemoteCopyTarget, takesRemoteTarget, type RemoteDownloadReference } from "../media-server-download.js";
import type { MediaServerSources } from "../media-server-sources.js";
import { openRemoteContent } from "../media-server-reference.js";
import { REMOTE_LIBRARY_ID, type RemoteLibraryRecord } from "../media-server-types.js";
import { titleLanguage } from "../ranking.js";
import type { ResourceOwner } from "../media-resources.js";
import { materializeSourceAdmission, parseSourceProfileReference, SourceAdmissionRejected, SourceAdmissionValidationError, type SourceAdmissionRejectionCode, type SourceAdmissionSnapshotV1 } from "../source-admission.js";
import { viewerOfProfileAccount } from "../source-profiles.js";
import type { UserPrefs } from "../store.js";
import type { DownloadTargetSettings, MetaItem, StreamItem } from "../types.js";
import { asyncRoute, viewerOf, type RouteContext } from "./context.js";

export interface DownloadsDeps extends RouteContext {
  queue: DownloadQueue;
  /** The verified original-file sources: the only place a durable remote download reference is
   *  minted, and only for a sealed source this session actually resolved. */
  mediaSources: MediaServerSources;
  deviceTransfers: DeviceTransfers;
  jobView: <T extends { media?: MediaInfo; target?: string }>(job: T) => Promise<T>;
  sourceOf(req: express.Request): StreamItem;
  /** The session the request speaks for, as a media resource owner. */
  ownerOf(req: express.Request): ResourceOwner;
  mediaSource(value: unknown): MediaInfo | undefined;
  posterOf(value: unknown): string | undefined;
  rememberTitle(target: string, media: MediaInfo | undefined, flat: boolean): Promise<void>;
  titleKey(target: string, media: MediaInfo | undefined, flat: boolean): string;
  saveCatalogPoster(key: string, url?: string, fallback?: string, backdrop?: string): void;
  libraryKey(value: string): string;
  /** Where a download whose rule names no library goes, resolved the way the queue resolves
   *  it, so the guard at the door and the queue's own check agree on the same library. */
  defaultDownloadLibrary(kind: "movie" | "series"): LibraryRecord | undefined;
  cachedMeta(type: string, id: string, language?: string, viewer?: Viewer): Promise<MetaItem | null>;
  prefsOf(req?: express.Request): UserPrefs;
}

/** The deps the body-validation of a lazy download selection needs, shared by the bulk route
 *  and the follow routes so both parse audio, subtitles and the pinned target the same way. */
type SelectionDeps = Pick<DownloadsDeps, "store" | "currentUser" | "cachedMeta" | "prefsOf" | "defaultDownloadLibrary">;

const invalidSourceProfileReference = () =>
  new AppError("The source profile selection is invalid.", "err.invalidSourceProfileReference", 400);

const sourceAdmissionError = (code: SourceAdmissionRejectionCode): AppError => {
  switch (code) {
    case "profileUnknown":
      return new AppError("That source profile is unavailable.", "err.sourceProfileUnavailable", 400);
    case "profileRevisionStale":
      return new AppError("This source profile revision is no longer available.", "err.sourceProfileRevisionStale", 409);
    case "operationUnsupported":
      return new AppError("This source profile cannot be used for this operation.", "err.sourceProfileOperationUnavailable", 400);
    case "operationForbidden":
      return new AppError("This account may not use this source profile for downloads.", "err.sourceProfileOperationForbidden", 403);
    case "providerScopeUnavailable":
      return new AppError("No authorized source is available for this profile.", "err.sourceProviderScopeUnavailable", 400);
    case "languagePreferenceUnavailable":
      return new AppError("The source language preferences are not available.", "err.sourceLanguagePreferenceUnavailable", 400);
    case "languagePreferenceDuplicate":
      return new AppError("The source language preferences cannot be used together.", "err.sourceLanguagePreferenceConflict", 400);
  }
};

const materializeBulkSourceAdmission = (
  deps: SelectionDeps,
  req: express.Request,
  referenceInput: unknown,
): SourceAdmissionSnapshotV1 => {
  const owner = deps.currentUser(req);
  if (!owner) throw new AppError("This account may not download to the library.", "err.downloadLibraryNotAllowed", 403);
  try {
    const reference = parseSourceProfileReference(referenceInput);
    const preferences = deps.prefsOf(req);
    return materializeSourceAdmission(reference, {
      viewer: viewerOfProfileAccount(owner),
      addons: deps.store.addons(),
      libraries: deps.store.libraries(),
      remoteLibraries: deps.store.remoteLibraries(),
      mediaConnections: deps.store.mediaConnections(),
      addonOrder: deps.store.userData(owner.id).addonOrder,
      preferences: {
        audioLanguage: preferences.audioLanguage,
        subtitleLanguage: preferences.subtitleLanguage,
      },
      operation: "downloadToLibrary",
    });
  } catch (error) {
    if (error instanceof SourceAdmissionValidationError) throw invalidSourceProfileReference();
    if (error instanceof SourceAdmissionRejected) throw sourceAdmissionError(error.code);
    throw error;
  }
};

const profileSelectionReference = (selection: unknown): { present: false } | { present: true; reference: unknown } => {
  if (selection === null || typeof selection !== "object" || Array.isArray(selection)
    || !Object.hasOwn(selection, "profile")) return { present: false };
  const keys = Reflect.ownKeys(selection);
  if (keys.length !== 1 || keys[0] !== "profile") throw invalidSourceProfileReference();
  return { present: true, reference: (selection as Record<string, unknown>).profile };
};

const legacySelectionFromAdmission = (snapshot: SourceAdmissionSnapshotV1) => {
  const { audio, subtitles } = snapshot.policy.constraints;
  const audioFallback = audio.fallback && "code" in audio.fallback ? audio.fallback.code : undefined;
  const subtitleLanguage = subtitles.mode === "off" ? undefined : subtitles.preferred && "code" in subtitles.preferred ? subtitles.preferred.code : undefined;
  const subtitleFallback = subtitles.mode === "off" || !subtitles.fallback || !("code" in subtitles.fallback) ? undefined : subtitles.fallback.code;
  return {
    addonKeys: snapshot.providerKeys.map((key) => key.slice("addon:".length)),
    sourceStrategy: "priority" as const,
    audioLanguage: "code" in audio.preferred ? audio.preferred.code : "",
    ...(audioFallback === undefined ? {} : { fallbackAudioLanguage: audioFallback }),
    audioMode: audio.mode,
    subtitleMode: subtitles.mode,
    ...(subtitleLanguage === undefined ? {} : { subtitleLanguage }),
    ...(subtitleFallback === undefined ? {} : { fallbackSubtitleLanguage: subtitleFallback }),
  };
};

/** The owner-bound check where a failure reaches the caller instead of pausing a job. The
 *  rights are asked before the body is read; the source and the library the rule names are
 *  asked again once they are known. */
const mayQueueGuard = (deps: SelectionDeps) => (req: express.Request, job: { stream?: StreamItem; remoteDownload?: RemoteDownloadReference; libraryId?: string } = {}) => {
  const owner = deps.currentUser(req);
  const remoteAccess = {
    users: () => deps.store.users(),
    mediaConnections: () => deps.store.mediaConnections(),
    remoteLibraries: () => deps.store.remoteLibraries(),
  };
  if (owner && ownerMayDownload({ owner, addons: deps.store.addons(), libraries: deps.store.libraries(), remoteAccess }, job)) return;
  throw new AppError("This account may not download to the library.", "err.downloadLibraryNotAllowed", 403);
};

/** The library the caller picked, checked here so an unusable one is refused rather than
 *  queued. A missing library and one the caller may not see answer the same, so the route
 *  gives nothing away about libraries that are not theirs. */
const explicitTargetFor = (deps: SelectionDeps) => async (req: express.Request, value: unknown, kind: "movie" | "series"): Promise<DownloadTargetSettings | undefined> => {
  if (value === undefined || value === null) return undefined;
  const item = typeof value === "object" ? value as Record<string, unknown> : undefined;
  const libraryId = typeof item?.libraryId === "string" ? item.libraryId.trim() : "";
  if (!libraryId) throw new AppError("Invalid download destination.", "err.invalidDownloadTarget");
  if (REMOTE_LIBRARY_ID.test(libraryId)) throw remoteDownloadRefused();
  const libraries = deps.store.libraries();
  const library = libraries.find((entry) => entry.id === libraryId);
  if (!library || !libraryVisible(library, viewerOf(deps.currentUser(req)))) {
    throw new AppError("That library does not exist.", "err.libraryNotFound");
  }
  targetLibrary(libraryId, kind, libraries);
  // The folder was picked from the library, so it is checked as it is and has to be there:
  // tidying its name would put the title in a folder next to the one the user chose.
  const subfolder = exactSubfolder(item!.subfolder);
  if (subfolder) {
    const resolved = await resolveLibraryPath([library], subfolder);
    const info = resolved ? await stat(resolved.absolute).catch(() => undefined) : undefined;
    if (!info?.isDirectory()) throw new AppError("That folder is not in the library.", "err.targetFolderMissing");
  }
  return {
    subfolder,
    layout: item!.layout === "flat" ? "flat" : "structured",
    libraryId,
    explicit: true,
  };
};

/** The automatic destination of a native copy, resolved from the remote library's stored rules.
 *  The library is proved here -- it exists, the account may see it, it takes the content and it
 *  is writable -- but the configured subfolder is NOT treated as an already-existing picked
 *  directory: the stored subfolder and layout are kept as they stand, and the queue's own naming
 *  and creation makes the folder, exactly as it makes an addon rule's folder. */
const automaticRemoteTargetFor = (deps: SelectionDeps) =>
  (req: express.Request, remote: RemoteLibraryRecord, kind: "movie" | "series"): DownloadTargetSettings => {
    const libraries = deps.store.libraries();
    const target = defaultRemoteCopyTarget(remote, libraries, deps.store.settings(), kind);
    if (target.libraryId === undefined) return target;
    const library = libraries.find((candidate) => candidate.id === target.libraryId);
    if (!library || !libraryVisible(library, viewerOf(deps.currentUser(req)))) {
      throw new AppError("That library does not exist.", "err.libraryNotFound");
    }
    if (!takesRemoteTarget(remote, kind, library)) {
      throw new AppError("That library does not take this kind of title.", "err.libraryTypeMismatch");
    }
    return target;
  };

/** Parses the lazy download body of a series into a `DownloadSelection`: the addon keys the
 *  caller may use, the strategy, the audio and subtitle rules, the title language and a
 *  concrete target. Shared so the bulk route and a follow's automatic rule cannot drift. */
export function createSelectionParser(deps: SelectionDeps): (req: express.Request, input: { selection: unknown; target: unknown; metaType: string; parentId?: string; kind?: "movie" | "series" }) => Promise<DownloadSelection> {
  const { store, currentUser, cachedMeta, prefsOf, defaultDownloadLibrary } = deps;
  const assertMayQueue = mayQueueGuard(deps);
  const explicitTarget = explicitTargetFor(deps);
  return async (req, input) => {
    // The rights are asked before the body is read, so an account that may not queue is
    // refused with 403 rather than a body-validation error it could never satisfy.
    assertMayQueue(req);
    // A followed film is saved by the film rules; everything else this parses is a series.
    // The caller may name the kind from the job it will actually add, because the queue reads
    // the kind off that job's media and the two must not be answered by two different inputs.
    const kind = input.kind ?? (input.metaType === "movie" ? "movie" : "series");
    const explicit = await explicitTarget(req, input.target, kind);
    const rawSelection = input.selection && typeof input.selection === "object" ? input.selection as Record<string, unknown> : {};
    // The caller's own addons, so a disallowed key cannot be smuggled in by naming it here.
    const usable = allowedAddons(store.addons(), viewerOf(currentUser(req)));
    const addonKeys = Array.isArray(rawSelection.addonKeys)
      ? [...new Set(rawSelection.addonKeys.map(String))].filter((key) => usable.some((addon) => addon.key === key && addon.enabled && addon.role !== "catalog"))
      : [];
    if (!addonKeys.length) throw new AppError("Pick at least one stream addon.", "err.missingDownloadSources");
    const sourceStrategy = String(rawSelection.sourceStrategy) === "largest" ? "largest" : "priority";
    const audioLanguage = normalizeLanguage(String(rawSelection.audioLanguage ?? ""));
    if (!audioLanguage) throw new AppError("Pick an audio language.", "err.missingAudioLanguage");
    const fallbackAudioLanguage = normalizeLanguage(String(rawSelection.fallbackAudioLanguage ?? ""));
    const audioMode: AudioMode = ["strict", "preferred"].includes(String(rawSelection.audioMode)) ? String(rawSelection.audioMode) as AudioMode : "listed";
    const subtitleMode: SubtitleMode = ["optional", "required"].includes(String(rawSelection.subtitleMode)) ? String(rawSelection.subtitleMode) as SubtitleMode : "off";
    const subtitleLanguage = subtitleMode === "off" ? undefined : normalizeLanguage(String(rawSelection.subtitleLanguage ?? ""));
    if (subtitleMode !== "off" && !subtitleLanguage) throw new AppError("Pick a subtitle language.", "err.missingSubtitleLanguage");
    const fallbackSubtitleLanguage = subtitleMode === "off" ? undefined : normalizeLanguage(String(rawSelection.fallbackSubtitleLanguage ?? ""));
    const firstAddon = store.addons().find((addon) => addon.key === addonKeys[0]);
    // A source whose addon found no language falls back to the one the title's own metadata
    // names. The viewer is the caller: what they may see decides what that metadata says.
    const metaLanguage = input.parentId ? titleLanguage((await cachedMeta(input.metaType, input.parentId, prefsOf(req).uiLanguage, viewerOf(currentUser(req))))?.language) : undefined;
    const selection: DownloadSelection = {
      addonKeys, sourceStrategy, audioLanguage,
      fallbackAudioLanguage: fallbackAudioLanguage === audioLanguage ? undefined : fallbackAudioLanguage,
      audioMode,
      titleLanguage: metaLanguage,
      subtitleMode, subtitleLanguage,
      fallbackSubtitleLanguage: fallbackSubtitleLanguage === subtitleLanguage ? undefined : fallbackSubtitleLanguage,
      targetSettings: explicit ?? (firstAddon?.downloadSettings[kind] ?? defaultDownloadSettings()[kind]),
    };
    // The rule names a library or leaves the choice to the default for the kind. The queue
    // resolves that same default, so the guard has to resolve it here too or an unavailable
    // account would be let past the door and paused by the queue a moment later.
    assertMayQueue(req, { libraryId: selection.targetSettings.libraryId ?? defaultDownloadLibrary(kind)?.id });
    return selection;
  };
}

export function registerDownloadRoutes(app: express.Application, deps: DownloadsDeps): void {
  const { store, currentUser, queue, mediaSources, deviceTransfers, jobView, sourceOf, ownerOf, mediaSource, posterOf, rememberTitle, titleKey, saveCatalogPoster, libraryKey, defaultDownloadLibrary } = deps;

  const assertMayQueue = mayQueueGuard(deps);
  const explicitTarget = explicitTargetFor(deps);
  const automaticTarget = automaticRemoteTargetFor(deps);
  const parseSelection = createSelectionParser(deps);

  /** A job the caller does not own is answered exactly like one that is not there: 403 would
   *  tell the caller that the id exists. */
  const requireOwnJob = (req: express.Request, id: string): string => {
    const viewer = viewerOf(currentUser(req));
    const job = queue.list().find((item) => item.id === id);
    if (!job || (viewer.role !== "admin" && job.ownerUserId !== viewer.id)) {
      throw new AppError("The item was not found.", "err.itemNotFound", 404);
    }
    return id;
  };

  app.get("/api/downloads", asyncRoute(async (req, res) => {
    const viewer = viewerOf(currentUser(req));
    const snapshot = queue.snapshot();
    const jobs = snapshot.jobs.filter((job) => viewer.role === "admin" || job.ownerUserId === viewer.id);
    res.json({ ...snapshot, jobs: await Promise.all(jobs.map((job) => jobView({ ...job, mine: job.ownerUserId === viewer.id }))), deviceTransfers: deviceTransfers.list(viewer) });
  }));
  app.post("/api/downloads", asyncRoute(async (req, res) => {
    const owner = currentUser(req);
    assertMayQueue(req);
    const stream = sourceOf(req);
    const native = isRemoteDownloadSource(stream);
    if (native) mediaSources.assertCurrent(stream, ownerOf(req));
    const nativeRef = native ? openRemoteContent(stream.url) : undefined;
    const remote = nativeRef ? store.remoteLibraries().find((library) => library.id === nativeRef.libraryId) : undefined;
    const suppliedMedia = mediaSource(req.body.media);
    // Mixed libraries use the signed item kind; old seals retain their body-based fallback.
    const provedKind: "movie" | "series" | undefined = remote === undefined ? undefined
      : remote.type === "mixed" ? nativeRef?.copyKind : remote.type;
    const media = provedKind === "series"
      ? { ...suppliedMedia, kind: "episode" as const, title: suppliedMedia?.title ?? String(req.body.title ?? "video") }
      : provedKind === "movie" && suppliedMedia?.kind === "episode" ? { ...suppliedMedia, kind: "movie" as const } : suppliedMedia;
    const addon = store.addons().find((item) => item.key === stream.addonKey);
    const settings = addon?.downloadSettings ?? defaultDownloadSettings();
    const kind = provedKind ?? (media?.kind === "episode" ? "series" : "movie");
    // The requested local destination and its rights are resolved first, so a bad, hidden,
    // read-only or remote target is refused here without any provider contact for a copy.
    const chosen = await explicitTarget(req, req.body.target, kind);
    // A native original queued without a target of its own takes the full destination its remote
    // library stores -- library, subfolder and layout. The library is read from the sealed address
    // the session actually resolved, never from the body, and a stored handle that names no usable
    // library is refused here rather than redirected to another one.
    const derived = chosen === undefined && native && remote ? automaticTarget(req, remote, kind) : undefined;
    const targetSettings = chosen ?? derived ?? (kind === "series" ? settings.series : settings.movie);
    // The queue turns a rule that names no library into the default for the kind; the guard
    // has to name that same library or the job would be let in and paused at once.
    if (isRemoteDownloadSource(stream) && !(targetSettings.libraryId ?? defaultDownloadLibrary(kind)?.id)) throw new NoLibraryForKindError(kind);
    assertMayQueue(req, { libraryId: targetSettings.libraryId ?? defaultDownloadLibrary(kind)?.id });
    // A remote original is copied from a verified sealed source only: the durable handle is
    // derived here from that source through the manager, never read from the request body.
    let queuedStream = stream;
    let remoteDownload: RemoteDownloadReference | undefined;
    if (isRemoteDownloadSource(stream)) {
      remoteDownload = await mediaSources.downloadReference(stream, ownerOf(req));
      queuedStream = remoteDownloadStream(stream);
    }
    // Asked again after the asynchronous source proof and target read, so a revocation that
    // landed meanwhile is seen before anything is queued.
    assertMayQueue(req, { stream: queuedStream, remoteDownload, libraryId: targetSettings.libraryId ?? defaultDownloadLibrary(kind)?.id });
    const job = await queue.add(String(req.body.title ?? "video"), stream, media, targetSettings, owner?.id, remoteDownload);
    // The queue's own await is one more window; the rights are read again before any metadata is
    // written, so a withdrawal that landed during admission leaves no trace on disk.
    assertMayQueue(req, { stream: queuedStream, remoteDownload, libraryId: targetSettings.libraryId ?? defaultDownloadLibrary(kind)?.id });
    await rememberTitle(job.target, media, targetSettings.layout === "flat");
    // Only for a source the catalogue has no title for: `rememberTitle` already saved the
    // artwork of one that has, and it knows the background as well. Repeating the write here
    // with the poster alone put the picture back that the pair had just corrected.
    if (!media?.id) {
      const posterKey = titleKey(job.target, media, targetSettings.layout === "flat");
      if (posterKey && posterKey !== ".") saveCatalogPoster(libraryKey(posterKey), media?.poster);
    }
    res.status(201).json(await jobView(job));
  }));
  // Adding episodes in bulk: the jobs are lazy, streams are asked for at download time.
  app.post("/api/downloads/bulk", asyncRoute(async (req, res) => {
    const owner = currentUser(req);
    const profileReference = profileSelectionReference(req.body.selection);
    // A profile admission answers its own operation check, including a distinct 403.
    if (!profileReference.present) assertMayQueue(req);
    const explicit = await explicitTarget(req, req.body.target, "series");
    const title = String(req.body.title ?? "").trim() || "Show";
    const type = String(req.body.type ?? "series");
    const parent = req.body.media && typeof req.body.media === "object" ? req.body.media as Record<string, unknown> : {};
    const parentId = String(parent.id ?? "").trim() || undefined;
    const poster = posterOf(parent.poster);
    const metaType = String(parent.metaType ?? type).trim() || type;
    const episodes = Array.isArray(req.body.episodes) ? req.body.episodes as Array<Record<string, unknown>> : [];
    if (!episodes.length) throw new AppError("Missing episode list.", "err.missingEpisodes");
    if (episodes.length > 500) throw new AppError("At most 500 episodes at a time.", "err.tooManyEpisodes");
    // Every job this route adds carries `media.kind: "episode"`, so the queue reads it as a
    // series whatever `metaType` the body claims for the title; the door has to agree.
    const sourceAdmission = !profileReference.present
      ? undefined
      : materializeBulkSourceAdmission(deps, req, profileReference.reference);
    const validatedSelection = await parseSelection(req, {
      selection: sourceAdmission === undefined ? req.body.selection : legacySelectionFromAdmission(sourceAdmission),
      target: req.body.target,
      metaType,
      parentId,
      kind: "series",
    });
    let added = 0, skipped = 0;
    for (const episode of episodes) {
      const videoId = String(episode.id ?? "").trim();
      if (!videoId) { skipped += 1; continue; }
      const season = episode.season == null ? undefined : Number(episode.season);
      const number = episode.episode == null ? undefined : Number(episode.episode);
      const episodeTitle = episode.title ? String(episode.title) : undefined;
      const jobTitle = `${title} · ${episodeTitle ?? (season != null ? `S${String(season).padStart(2, "0")}E${String(number ?? 0).padStart(2, "0")}` : `Episode ${number ?? "?"}`)}`;
      const media: MediaInfo = { kind: "episode", title, season, episode: number, episodeTitle, id: parentId, metaType, poster };
      let jobSelection = validatedSelection;
      let jobAdmission = sourceAdmission;
      if (profileReference.present) {
        jobAdmission = materializeBulkSourceAdmission(deps, req, profileReference.reference);
        jobSelection = {
          ...legacySelectionFromAdmission(jobAdmission),
          titleLanguage: validatedSelection.titleLanguage,
          targetSettings: validatedSelection.targetSettings,
        };
        assertMayQueue(req, { libraryId: jobSelection.targetSettings.libraryId ?? defaultDownloadLibrary("series")?.id });
      }
      const job = await queue.addPending(jobTitle, { type, videoId, selection: jobSelection }, media, owner?.id, undefined, jobAdmission);
      if (job) added += 1; else skipped += 1;
    }
    log("INFO", "Bulk addition to the queue", { title, added, skipped });
    res.status(201).json({ added, skipped });
  }));
  app.post("/api/downloads/:id/pause", asyncRoute(async (req, res) => { await queue.pause(requireOwnJob(req, String(req.params.id))); res.status(204).end(); }));
  app.post("/api/downloads/:id/resume", asyncRoute(async (req, res) => { await queue.resume(requireOwnJob(req, String(req.params.id))); res.status(204).end(); }));
  app.post("/api/downloads/:id/retry", asyncRoute(async (req, res) => { await queue.retry(requireOwnJob(req, String(req.params.id))); res.status(204).end(); }));
  app.post("/api/downloads/:id/move", asyncRoute(async (req, res) => { await queue.move(requireOwnJob(req, String(req.params.id)), Number(req.body.direction) < 0 ? -1 : 1); res.status(204).end(); }));
  app.delete("/api/downloads/:id", asyncRoute(async (req, res) => { await queue.remove(requireOwnJob(req, String(req.params.id))); res.status(204).end(); }));
  app.delete("/api/downloads", asyncRoute(async (_req, res) => { await queue.clearCompleted(); res.status(204).end(); }));
}
