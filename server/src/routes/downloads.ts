import { stat } from "node:fs/promises";
import type express from "express";
import { allowedAddons } from "../addons.js";
import { bulkEpisodeIsReleased, episodeKey, episodesInBulkScope, episodesInTarget } from "../bulk-target.js";
import type { DeviceTransfers } from "../device-transfers.js";
import { NoLibraryForKindError, REMOTE_ITEM_VIDEO_PREFIX, isRemoteDownloadSource, ownerMayDownload, remoteDownloadRefused, remoteDownloadStream, type DownloadQueue, type DownloadSelection } from "../downloads.js";
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
import { SourceAdmissionRejected, type SourceAdmissionSnapshotV1 } from "../source-admission.js";
import type { UserPrefs } from "../store.js";
import type { DownloadTargetSettings, MetaItem, StreamItem } from "../types.js";
import { asyncRoute, viewerOf, type RouteContext } from "./context.js";
import { admitsRemoteProviders, invalidSourceProfileReference, legacySelectionFromAdmission, materializeSourceProfileAdmission, profileSelectionReference } from "./source-profile-selection.js";

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
  now?: () => number;
}

type BulkEpisodeOutcome = "queued" | "alreadyQueued" | "presentLocally" | "unresolved" | "inTarget" | "invalid";

const bulkEpisodeNumber = (value: unknown): number | undefined => {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
};

/** The deps the body-validation of a lazy download selection needs, shared by the bulk route
 *  and the follow routes so both parse audio, subtitles and the pinned target the same way. */
type SelectionDeps = Pick<DownloadsDeps, "store" | "currentUser" | "cachedMeta" | "prefsOf" | "defaultDownloadLibrary">;

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

/** Absent or null keeps the legacy default. A present value outside the set this server can
 *  run is a newer rule, and is refused instead of being weakened into that default. */
const acceptedSelectionMode = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new AppError("This download rule needs a newer server.", "err.selectionUpgradeRequired", 400);
};

/** Parses the lazy download body of a series into a `DownloadSelection`: the addon keys the
 *  caller may use, the strategy, the audio and subtitle rules, the title language and a
 *  concrete target. Shared so the bulk route and a follow's automatic rule cannot drift. */
export function createSelectionParser(deps: SelectionDeps): (req: express.Request, input: { selection: unknown; target: unknown; metaType: string; parentId?: string; kind?: "movie" | "series"; remoteProviders?: boolean }) => Promise<DownloadSelection> {
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
    // A rule that reaches a remote library can be satisfied without any addon.
    if (!addonKeys.length && !input.remoteProviders) throw new AppError("Pick at least one stream addon.", "err.missingDownloadSources");
    const sourceStrategy = acceptedSelectionMode(rawSelection.sourceStrategy, ["largest", "priority"] as const, "priority");
    const audioLanguage = normalizeLanguage(String(rawSelection.audioLanguage ?? ""));
    if (!audioLanguage) throw new AppError("Pick an audio language.", "err.missingAudioLanguage");
    const fallbackAudioLanguage = normalizeLanguage(String(rawSelection.fallbackAudioLanguage ?? ""));
    const audioMode = acceptedSelectionMode(rawSelection.audioMode, ["listed", "strict", "preferred"] as const, "listed");
    const subtitleMode = acceptedSelectionMode(rawSelection.subtitleMode, ["off", "optional", "required"] as const, "off");
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
  const now = () => deps.now?.() ?? Date.now();

  const remoteAdmission = (
    owner: ReturnType<typeof currentUser>,
    reference: unknown,
    libraryId: string,
  ): SourceAdmissionSnapshotV1 => {
    try {
      const admission = materializeSourceProfileAdmission(deps, owner, reference, "episode", {
        onlyProviderKeys: [`remote:${libraryId}`],
      });
      if (admission.profile.template !== "rules") {
        throw new AppError(
          "The selected source profile cannot be used for this operation.",
          "err.sourceProfileOperationUnavailable",
          400,
        );
      }
      return admission;
    } catch (error) {
      if ((error instanceof SourceAdmissionRejected && error.code === "providerScopeUnavailable")
        || (error instanceof AppError && error.messageKey === "err.sourceProviderScopeUnavailable")) {
        throw new AppError(
          "Your download rules do not allow copying from this library.",
          "err.bulkRemoteNotInRules",
          400,
        );
      }
      throw error;
    }
  };

  const remoteTarget = async (req: express.Request, remote: RemoteLibraryRecord): Promise<DownloadTargetSettings> => {
    const chosen = await explicitTarget(req, req.body.target, "series");
    const settings = chosen ?? automaticTarget(req, remote, "series");
    const libraryId = settings.libraryId ?? defaultDownloadLibrary("series")?.id;
    if (!libraryId) throw new NoLibraryForKindError("series");
    assertMayQueue(req, { libraryId });
    return settings;
  };

  const remoteSelection = (
    admission: SourceAdmissionSnapshotV1,
    targetSettings: DownloadTargetSettings,
  ): DownloadSelection => ({
    ...legacySelectionFromAdmission(admission),
    targetSettings,
  });

  const targetLibraryForEpisodes = (settings: DownloadTargetSettings): {
    libraryId?: string;
    library?: LibraryRecord;
  } => {
    const libraryId = settings.libraryId ?? defaultDownloadLibrary("series")?.id;
    return {
      ...(libraryId === undefined ? {} : { libraryId }),
      ...(libraryId === undefined
        ? {}
        : { library: store.libraries().find((library) => library.id === libraryId) }),
    };
  };

  const requestAbort = (req: express.Request, res: express.Response): { signal: AbortSignal; close(): void } => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const closeOnAbort = () => {
      if (!res.writableEnded) abort();
    };
    req.on("aborted", abort);
    res.on("close", closeOnAbort);
    return {
      signal: controller.signal,
      close: () => {
        req.off("aborted", abort);
        res.off("close", closeOnAbort);
      },
    };
  };

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

  app.post("/api/downloads/:id/now", asyncRoute(async (req, res) => {
    await queue.startNow(requireOwnJob(req, String(req.params.id)));
    res.status(204).end();
  }));

  app.get("/api/downloads", asyncRoute(async (req, res) => {
    const viewer = viewerOf(currentUser(req));
    const snapshot = queue.snapshot();
    const jobs = snapshot.jobs.filter((job) => viewer.role === "admin" || job.ownerUserId === viewer.id);
    res.json({
      ...snapshot,
      jobs: await Promise.all(jobs.map((job) => jobView({ ...job, mine: job.ownerUserId === viewer.id }))),
      deviceTransfers: deviceTransfers.list(viewer),
      drain: queue.drainFor({ id: viewer.id, admin: viewer.role === "admin" }),
    });
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
  app.post("/api/downloads/bulk/prepare", asyncRoute(async (req, res) => {
    const owner = currentUser(req);
    const profileReference = profileSelectionReference(req.body.selection);
    const origin = req.body.origin && typeof req.body.origin === "object"
      ? req.body.origin as Record<string, unknown>
      : undefined;
    const originKind = origin?.kind;
    const scopeValue = req.body.scope;
    if (scopeValue !== "season" && scopeValue !== "series") {
      throw new AppError("Invalid download scope.", "err.invalidRequest");
    }
    const season = req.body.season;
    if (scopeValue === "season" && !(typeof season === "number" && Number.isSafeInteger(season))) {
      throw new AppError("Choose a season to download.", "err.bulkSeasonRequired");
    }
    const scope = {
      scope: scopeValue,
      ...(scopeValue === "season" ? { season: season as number } : {}),
      specials: req.body.specials === true,
    };

    if (originKind === "catalogue") {
      const catalogueOrigin = origin!;
      if (!profileReference.present) assertMayQueue(req);
      const rawEpisodes = Array.isArray(catalogueOrigin.episodes) ? catalogueOrigin.episodes as Array<Record<string, unknown>> : [];
      if (rawEpisodes.length > 5000) throw new AppError("At most 5000 episodes at a time.", "err.tooManyEpisodes");
      if (rawEpisodes.some((episode) => typeof episode.id !== "string" || !episode.id.trim())) {
        throw new AppError("Every catalogue episode needs an id.", "err.invalidRequest");
      }
      const sourceAdmission = !profileReference.present
        ? undefined
        : materializeSourceProfileAdmission(deps, owner, profileReference.reference, "episode");
      const parent = catalogueOrigin.media && typeof catalogueOrigin.media === "object"
        ? catalogueOrigin.media as Record<string, unknown>
        : {};
      const parentId = String(parent.id ?? "").trim() || undefined;
      const metaType = String(parent.metaType ?? "series").trim() || "series";
      const validatedSelection = await parseSelection(req, {
        selection: sourceAdmission === undefined ? req.body.selection : legacySelectionFromAdmission(sourceAdmission),
        remoteProviders: admitsRemoteProviders(sourceAdmission),
        target: req.body.target,
        metaType,
        parentId,
        kind: "series",
      });
      const title = String(req.body.title ?? "").trim() || "Show";
      const target = targetLibraryForEpisodes(validatedSelection.targetSettings);
      if (!target.libraryId || !target.library) throw new NoLibraryForKindError("series");
      const inTarget = await episodesInTarget({
        root: target.library.root,
        settings: validatedSelection.targetSettings,
        seriesTitle: title,
      });
      const episodes = rawEpisodes.map((episode) => ({
        id: String(episode.id).trim(),
        season: bulkEpisodeNumber(episode.season),
        episode: bulkEpisodeNumber(episode.episode),
        ...(typeof episode.title === "string" ? { title: episode.title } : {}),
        released: episode.released,
      })).filter((episode) => episodesInBulkScope([episode], scope).length === 1);
      res.json({
        origin: "catalogue",
        series: { title, ...(parentId === undefined ? {} : { catalogueId: parentId }) },
        target: { libraryId: target.libraryId, libraryName: target.library.name },
        episodes: episodes.map((episode) => {
          const numbered = episode.season !== undefined && episode.episode !== undefined;
          const status = !numbered ? "unnumbered"
            : !bulkEpisodeIsReleased(episode.released, now()) ? "unreleased"
              : inTarget.has(episodeKey(episode.season!, episode.episode!)) ? "inTarget"
                : queue.activeEpisodeIn(owner?.id, {
                  type: "series",
                  videoId: episode.id,
                  libraryId: target.libraryId!,
                  seriesFolder: title,
                  season: episode.season!,
                  episode: episode.episode!,
                }) ? "queued" : "ready";
          return {
            id: episode.id,
            ...(episode.season === undefined ? {} : { season: episode.season }),
            ...(episode.episode === undefined ? {} : { episode: episode.episode }),
            ...(episode.title === undefined ? {} : { title: episode.title }),
            status,
          };
        }),
        listing: { complete: true },
      });
      return;
    }

    if (originKind !== "remote") {
      throw new AppError("Invalid download origin.", "err.invalidRequest");
    }
    const remoteOriginBody = origin!;
    if (!profileReference.present) throw invalidSourceProfileReference();
    const libraryId = typeof remoteOriginBody.libraryId === "string" ? remoteOriginBody.libraryId.trim() : "";
    const seriesItemId = typeof remoteOriginBody.seriesItemId === "string" ? remoteOriginBody.seriesItemId.trim() : "";
    if (!libraryId || !seriesItemId) throw new AppError("Invalid download origin.", "err.invalidRequest");
    const remote = store.remoteLibraries().find((library) => library.id === libraryId);
    if (!remote) throw new AppError("The library was not found.", "err.libraryNotFound", 404);
    remoteAdmission(owner, profileReference.reference, libraryId);
    const targetSettings = await remoteTarget(req, remote);
    const target = targetLibraryForEpisodes(targetSettings);
    if (!target.libraryId || !target.library) throw new NoLibraryForKindError("series");
    const abort = requestAbort(req, res);
    let listed;
    try {
      listed = await mediaSources.seriesEpisodesForBulk({
        ownerUserId: owner!.id,
        libraryId,
        seriesItemId,
        signal: abort.signal,
      });
    } finally {
      abort.close();
    }
    if (!listed) throw new AppError("The library was not found.", "err.libraryNotFound", 404);
    if (!listed.complete && listed.errorKey === "err.tooManyEpisodes") {
      throw new AppError("At most 5000 episodes at a time.", "err.tooManyEpisodes");
    }
    const title = String(req.body.title ?? "").trim() || listed.name || "Show";
    const inTarget = await episodesInTarget({
      root: target.library.root,
      settings: targetSettings,
      seriesTitle: title,
    });
    const catalogueId = listed.catalogueId;
    const episodes = listed.episodes
      .map((episode) => ({
        ...episode,
        season: bulkEpisodeNumber(episode.season),
        episode: bulkEpisodeNumber(episode.episode),
      }))
      .filter((episode) => episodesInBulkScope([episode], scope).length === 1);
    res.json({
      origin: "remote",
      series: { title, ...(catalogueId === undefined ? {} : { catalogueId }) },
      target: { libraryId: target.libraryId, libraryName: target.library.name },
      episodes: episodes.map((episode) => {
        const numbered = episode.season !== undefined && episode.episode !== undefined;
        const videoId = numbered && catalogueId !== undefined
          ? `${catalogueId}:${episode.season}:${episode.episode}`
          : `${REMOTE_ITEM_VIDEO_PREFIX}${libraryId}:${episode.itemId}`;
        const status = !numbered ? "unnumbered"
          : !bulkEpisodeIsReleased(episode.premiereDate, now()) ? "unreleased"
            : inTarget.has(episodeKey(episode.season!, episode.episode!)) ? "inTarget"
              : queue.activeEpisodeIn(owner?.id, {
                type: "series",
                videoId,
                libraryId: target.libraryId!,
                seriesFolder: title,
                season: episode.season!,
                episode: episode.episode!,
              }) ? "queued" : "ready";
        return {
          id: videoId,
          ...(episode.season === undefined ? {} : { season: episode.season }),
          ...(episode.episode === undefined ? {} : { episode: episode.episode }),
          title: episode.name,
          remoteItemId: episode.itemId,
          status,
        };
      }),
      listing: listed.complete
        ? { complete: true }
        : { complete: false, errorKey: listed.errorKey ?? "err.bulkEpisodeListIncomplete" },
    });
  }));

  // Adding episodes in bulk: the jobs are lazy, streams are asked for at download time.
  app.post("/api/downloads/bulk", asyncRoute(async (req, res) => {
    const owner = currentUser(req);
    const profileReference = profileSelectionReference(req.body.selection);
    const type = String(req.body.type ?? "series");
    const movie = type === "movie";
    const origin = req.body.origin && typeof req.body.origin === "object"
      ? req.body.origin as Record<string, unknown>
      : undefined;
    const remoteOrigin = origin?.kind === "remote";
    if (origin !== undefined && !remoteOrigin) throw new AppError("Invalid download origin.", "err.invalidRequest");
    if (remoteOrigin && type !== "series") throw new AppError("Remote bulk downloads only support series.", "err.invalidRequest");
    if (!remoteOrigin && !profileReference.present) assertMayQueue(req);
    const explicit = remoteOrigin ? undefined : await explicitTarget(req, req.body.target, movie ? "movie" : "series");
    const parent = req.body.media && typeof req.body.media === "object" ? req.body.media as Record<string, unknown> : {};
    const parentId = String(parent.id ?? "").trim() || undefined;
    const poster = posterOf(parent.poster);
    const metaType = String(parent.metaType ?? type).trim() || type;
    const episodes = Array.isArray(req.body.episodes) ? req.body.episodes as Array<Record<string, unknown>> : [];
    if (!episodes.length) throw new AppError("Missing episode list.", "err.missingEpisodes");
    if (movie) {
      if (!profileReference.present) throw new AppError("A film can only be downloaded with download rules.", "err.missingDownloadSources");
      if (String(parent.metaType ?? "") !== "movie") throw new AppError("A film download must carry movie media.", "err.invalidRequest");
      if (episodes.length !== 1 || episodes.some((episode) => episode.season != null || episode.episode != null)) {
        throw new AppError("A film download must contain exactly one entry without episode numbering.", "err.invalidRequest");
      }
    }
    if (episodes.length > 500) throw new AppError("At most 500 episodes at a time.", "err.tooManyEpisodes");
    const kind = movie ? "movie" : "series";

    if (remoteOrigin) {
      if (!profileReference.present) throw invalidSourceProfileReference();
      const libraryId = typeof origin!.libraryId === "string" ? origin!.libraryId.trim() : "";
      const seriesItemId = typeof origin!.seriesItemId === "string" ? origin!.seriesItemId.trim() : "";
      if (!libraryId || !seriesItemId) throw new AppError("Invalid download origin.", "err.invalidRequest");
      const remote = store.remoteLibraries().find((library) => library.id === libraryId);
      if (!remote) throw new AppError("The library was not found.", "err.libraryNotFound", 404);
      remoteAdmission(owner, profileReference.reference, libraryId);
      const targetSettings = await remoteTarget(req, remote);
      const target = targetLibraryForEpisodes(targetSettings);
      if (!target.libraryId || !target.library) throw new NoLibraryForKindError("series");
      const abort = requestAbort(req, res);
      let listed;
      try {
        listed = await mediaSources.seriesForBulk({
          ownerUserId: owner!.id,
          libraryId,
          seriesItemId,
          signal: abort.signal,
        });
      } finally {
        abort.close();
      }
      if (!listed) throw new AppError("The library was not found.", "err.libraryNotFound", 404);
      const title = String(req.body.title ?? "").trim() || listed.name || "Show";
      const catalogueId = listed.catalogueId;
      const inTarget = await episodesInTarget({
        root: target.library.root,
        settings: targetSettings,
        seriesTitle: title,
      });
      const results: Array<{ id: string; outcome: BulkEpisodeOutcome }> = [];
      let added = 0;
      for (const episode of episodes) {
        const season = bulkEpisodeNumber(episode.season);
        const number = bulkEpisodeNumber(episode.episode);
        const remoteItemId = typeof episode.remoteItemId === "string" ? episode.remoteItemId.trim() : "";
        if (!remoteItemId || season === undefined || number === undefined) {
          results.push({ id: remoteItemId, outcome: "invalid" });
          continue;
        }
        const videoId = catalogueId === undefined
          ? `${REMOTE_ITEM_VIDEO_PREFIX}${libraryId}:${remoteItemId}`
          : `${catalogueId}:${season}:${number}`;
        if (inTarget.has(episodeKey(season, number))) {
          results.push({ id: videoId, outcome: "inTarget" });
          continue;
        }
        const admission = remoteAdmission(owner, profileReference.reference, libraryId);
        const episodeTitle = typeof episode.title === "string" && episode.title.trim() ? episode.title : undefined;
        const media: MediaInfo = {
          kind: "episode",
          title,
          season,
          episode: number,
          ...(episodeTitle === undefined ? {} : { episodeTitle }),
          ...(catalogueId === undefined ? {} : { id: catalogueId }),
          metaType: "series",
        };
        const jobTitle = `${title} · ${episodeTitle ?? `S${String(season).padStart(2, "0")}E${String(number).padStart(2, "0")}`}`;
        const admitted = await queue.admitPending(
          jobTitle,
          {
            type: "series",
            videoId,
            selection: remoteSelection(admission, targetSettings),
            remoteItem: { libraryId, connectionId: remote.connectionId, itemId: remoteItemId },
          },
          media,
          owner?.id,
          admission,
        );
        const outcome = admitted.outcome;
        results.push({ id: videoId, outcome });
        if (outcome === "queued") added += 1;
      }
      const skipped = results.length - added;
      log("INFO", "Bulk addition to the queue", { title, added, skipped, origin: "remote" });
      res.status(201).json({ added, skipped, results });
      return;
    }

    const sourceAdmission = !profileReference.present
      ? undefined
      : materializeSourceProfileAdmission(deps, owner, profileReference.reference, movie ? "movie" : "episode");
    const validatedSelection = await parseSelection(req, {
      selection: sourceAdmission === undefined ? req.body.selection : legacySelectionFromAdmission(sourceAdmission),
      remoteProviders: admitsRemoteProviders(sourceAdmission),
      target: req.body.target,
      metaType,
      parentId,
      kind,
    });
    const title = String(req.body.title ?? "").trim() || (movie ? "Movie" : "Show");
    if (movie) {
      const videoId = String(episodes[0]!.id ?? "").trim();
      if (!videoId) throw new AppError("The film entry has no id.", "err.invalidRequest");
      let jobSelection = validatedSelection;
      let jobAdmission = sourceAdmission;
      if (profileReference.present) {
        jobAdmission = materializeSourceProfileAdmission(deps, owner, profileReference.reference, "movie");
        jobSelection = {
          ...legacySelectionFromAdmission(jobAdmission),
          titleLanguage: validatedSelection.titleLanguage,
          targetSettings: validatedSelection.targetSettings,
        };
        assertMayQueue(req, { libraryId: jobSelection.targetSettings.libraryId ?? defaultDownloadLibrary("movie")?.id });
      }
      const rawYear = Number(parent.year);
      const year = Number.isFinite(rawYear) && rawYear >= 1900 && rawYear <= 2100 ? Math.trunc(rawYear) : undefined;
      const media: MediaInfo = {
        kind: "movie", title, id: parentId, metaType, poster,
        ...(year === undefined ? {} : { year }),
      };
      const admitted = await queue.admitPending(
        title,
        { type, videoId, selection: jobSelection },
        media,
        owner?.id,
        jobAdmission,
      );
      const results = [{ id: videoId, outcome: admitted.outcome }];
      const added = admitted.outcome === "queued" ? 1 : 0;
      const skipped = 1 - added;
      log("INFO", "Bulk addition to the queue", { title, added, skipped });
      res.status(201).json({ added, skipped, results });
      return;
    }

    const target = targetLibraryForEpisodes(validatedSelection.targetSettings);
    const inTarget = target.libraryId && target.library
      ? await episodesInTarget({
        root: target.library.root,
        settings: validatedSelection.targetSettings,
        seriesTitle: title,
      })
      : new Set<string>();
    const results: Array<{ id: string; outcome: BulkEpisodeOutcome }> = [];
    let added = 0;
    for (const episode of episodes) {
      const videoId = String(episode.id ?? "").trim();
      if (!videoId) {
        results.push({ id: "", outcome: "invalid" });
        continue;
      }
      const numberedSeason = bulkEpisodeNumber(episode.season);
      const numberedEpisode = bulkEpisodeNumber(episode.episode);
      if (numberedSeason !== undefined && numberedEpisode !== undefined && inTarget.has(episodeKey(numberedSeason, numberedEpisode))) {
        results.push({ id: videoId, outcome: "inTarget" });
        continue;
      }
      const season = episode.season == null ? undefined : Number(episode.season);
      const number = episode.episode == null ? undefined : Number(episode.episode);
      const episodeTitle = episode.title ? String(episode.title) : undefined;
      const jobTitle = `${title} · ${episodeTitle ?? (season != null ? `S${String(season).padStart(2, "0")}E${String(number ?? 0).padStart(2, "0")}` : `Episode ${number ?? "?"}`)}`;
      const media: MediaInfo = { kind: "episode", title, season, episode: number, episodeTitle, id: parentId, metaType, poster };
      let jobSelection = validatedSelection;
      let jobAdmission = sourceAdmission;
      if (profileReference.present) {
        jobAdmission = materializeSourceProfileAdmission(deps, owner, profileReference.reference, "episode");
        jobSelection = {
          ...legacySelectionFromAdmission(jobAdmission),
          titleLanguage: validatedSelection.titleLanguage,
          targetSettings: validatedSelection.targetSettings,
        };
        assertMayQueue(req, { libraryId: jobSelection.targetSettings.libraryId ?? defaultDownloadLibrary("series")?.id });
      }
      const admitted = await queue.admitPending(
        jobTitle,
        { type, videoId, selection: jobSelection },
        media,
        owner?.id,
        jobAdmission,
      );
      results.push({ id: videoId, outcome: admitted.outcome });
      if (admitted.outcome === "queued") added += 1;
    }
    const skipped = results.length - added;
    log("INFO", "Bulk addition to the queue", { title, added, skipped });
    res.status(201).json({ added, skipped, results });
  }));
  app.post("/api/downloads/:id/pause", asyncRoute(async (req, res) => { await queue.pause(requireOwnJob(req, String(req.params.id))); res.status(204).end(); }));
  app.post("/api/downloads/:id/resume", asyncRoute(async (req, res) => { await queue.resume(requireOwnJob(req, String(req.params.id))); res.status(204).end(); }));
  app.post("/api/downloads/:id/retry", asyncRoute(async (req, res) => { await queue.retry(requireOwnJob(req, String(req.params.id))); res.status(204).end(); }));
  app.post("/api/downloads/:id/move", asyncRoute(async (req, res) => { await queue.move(requireOwnJob(req, String(req.params.id)), Number(req.body.direction) < 0 ? -1 : 1); res.status(204).end(); }));
  app.delete("/api/downloads/:id", asyncRoute(async (req, res) => { await queue.remove(requireOwnJob(req, String(req.params.id))); res.status(204).end(); }));
  app.delete("/api/downloads", asyncRoute(async (_req, res) => { await queue.clearCompleted(); res.status(204).end(); }));
}
