import express from "express";
import { once } from "node:events";
import { RangeCache } from "./range-cache.js";
import { isInternalMediaPath, mediaChildPath, mediaResources, openMediaUrl, ResourceError, safeSourceText, type ResourceOwner } from "./media-resources.js";
import { readMediaText, rewritePlaylist } from "./media-playlist.js";
import { AirPlayAccess } from "./airplay-access.js";
import path from "node:path";
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, realpath, rm, stat, statfs, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { loadAddon, metadata, searchAll, searchableCatalogs, streams, subtitles, type MetaProvider } from "./addons.js";
import { autoRefreshEnabled, normalizeRefreshHours, refreshDue, refreshManifests, type RefreshOutcome } from "./addon-refresh.js";
import { rankStreams } from "./ranking.js";
import { DownloadQueue, isPlaylist } from "./downloads.js";
import { selectDownloadSource } from "./download-selection.js";
import { StatsLog, type TrafficEvent, type TrafficMeta } from "./stats.js";
import { Throughput } from "./throughput.js";
import { build } from "./build.js";
import { PlaybackManager, sourceTitle } from "./playback.js";
import { publicAddon, publicAddonRestricted, redirectedHeaders, safeFetch, validateRemoteUrl } from "./security.js";
import { RestrictedError, restrictedMiddleware, restrictedMode } from "./restricted.js";
import { outbound } from "./outbound.js";
import { images } from "./images.js";
import { configureSecureMode, secureMode, securityHeaders } from "./secure.js";
import { publicSettings, Store, type InstanceSettings, type Settings, type State, type UserPrefs, type WatchlistEntry, type StoredProgress, type WatchedMarker } from "./store.js";
import { emptyUserData, findUserById, PERSONAL_SETTINGS, type UserData } from "./users.js";
import type { ProgressSeries } from "./progress-series.js";
import { advanceTorrent, normalizeToken, verifyRealDebridToken } from "./debrid.js";
import { tmdbMeta, verifyTmdbKey } from "./tmdb.js";
import { clearTrailerCache } from "./trailers.js";
import { ExternalIdStore } from "./external-ids.js";
import { currentLevel, flushLog, initLogger, log, parseLevel, startLogMaintenance, setLevel } from "./logger.js";
import { browseDirectory, describePath, emptiedFolders, entryDirectory, isPathWithin, isVideo, listVideos, moveDestination, orphanedCatalogKeys, pageFiles, remapPath, scanLibrary, summarize, type FoundFile, type LibraryEntry } from "./library.js";
import { browseMeta, cacheFieldsFromMeta, episodeKey, episodeNumberOf, episodesFromMeta, dropKeyed, knownTitleEntry, knownTitleOf, matchKeyFor, mosaicSkipped, needsBackfill, needsEpisodes, titleUnits, unmatchAt, type LibraryMetaRecord, type TitleKind, type TitleUnit } from "./library-match.js";
import { LibraryScan } from "./library-scan.js";
import { createLibraryProbe, type LibraryHealth } from "./library-probe.js";
import { LibraryAutoScan } from "./library-autoscan.js";
import { watchLibrary } from "./library-watch.js";
import { ArtworkQueue, artNames, artOutput, artVariantKey, artworkBesideMedia, BACKDROP_OUTPUT, episodeArtName, fileMayUseFolderArtwork, findArtwork, type FolderListing, framePosition, pickArtwork, readFolderListing, POSTER_OUTPUT, saveBackdropAs, saveFrame, savePosterAs, type ArtShape, type PosterOutcome } from "./artwork.js";
import { envCredentials, INTERNAL_TOKEN, parseCookies, readSession, sessionUserId, SESSION_COOKIE, type SessionInfo } from "./auth.js";
import { RepeatFilter } from "./access-log.js";
import { randomBytes, randomUUID } from "node:crypto";
import type { ClientCapabilities, PlaybackOptions } from "./playback.js";
import type { MediaInfo } from "./naming.js";
import { defaultDownloadSettings, deviceFilename } from "./naming.js";
import { LANGUAGE_NAMES, isUiLanguage, normalizeLanguage } from "./language.js";
import { AppError, messageKeyOf } from "./errors.js";
import { carveOuts, queuedArtworkKey, defaultLibrary, isInside, libraryFor, libraryPath, parseLibraryPath, posixBase, posixDir, posixJoin, realAncestor, relativeWithin, resolveLibraryPath, toFs, toPosix, type LibraryRecord, type LibraryType, type RootGrant } from "./libraries.js";
import { envGrants, grantView, mergeGrants } from "./library-grants.js";
import { migrateStateFile } from "./library-migrate.js";
import { LibraryMetaStore } from "./library-meta-store.js";
import { artworks } from "./artwork-cache.js";
import type { AddonRecord, MetaItem, StreamItem } from "./types.js";
import { createSettingsBackup, parseSettingsBackup, remapBackupLibraries } from "./backup.js";
import { LibraryOps } from "./library-ops.js";
import { transferLibraryPath, type TransferProgress } from "./library-transfer.js";
import { registerAddonsRoutes } from "./routes/addons.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerCatalogRoutes } from "./routes/catalog.js";
import { registerContentRoutes } from "./routes/content.js";
import { asyncRoute, type RouteContext } from "./routes/context.js";
import { registerCurateRoutes } from "./routes/curate.js";
import { registerDiagnosticsRoutes } from "./routes/diagnostics.js";
import { registerDownloadRoutes } from "./routes/downloads.js";
import { registerLibrariesRoutes } from "./routes/libraries.js";
import { registerPersonalRoutes } from "./routes/personal.js";

const STREAM_SORTS = new Set(["recommended", "size-desc", "size-asc", "addon"]);
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? "/downloads";
// Before anything reads the state: a v1 file gains its library and qualified keys.
const libraryMigration = await migrateStateFile(DATA_DIR, DOWNLOAD_DIR);
const app = express(); const store = new Store(DATA_DIR, DOWNLOAD_DIR);
/** The match history, kept per library instead of inside `state.json`. */
const metaStore = new LibraryMetaStore(DATA_DIR);
/** The Wikidata ids behind the site links, one answer per title and kept on disk. */
const externalIds = new ExternalIdStore(DATA_DIR);
let markServerReady!: () => void;
const serverReady = new Promise<void>((resolve) => { markServerReady = resolve; });
await store.load();
await metaStore.load();
await externalIds.load();
if (libraryMigration.migrated) log("INFO", "State migrated to libraries", { libraryId: libraryMigration.libraryId, paths: libraryMigration.paths, artwork: libraryMigration.artwork });
if (libraryMigration.metadata) log("INFO", "Library metadata moved out of the state", { rows: libraryMigration.metadata });
if (libraryMigration.artworkSetting) log("INFO", "The global artwork location was retired", { libraries: libraryMigration.artworkSetting });
// Before anything reads the state. A default password would have to go straight away, so
// none is created: the first boot ends on the screen where the user creates the account.
// Installs still running on admin/admin lose it and go through the same setup: the
// migration refuses to carry them over, so what is left is an object nothing reads.
const preAccountsAccount = store.auth();
if (preAccountsAccount) {
  await store.update((state) => { state.auth = undefined; });
  if (preAccountsAccount.isDefault) log("WARN", "The default admin/admin sign-in was removed, create your own account on the next visit");
}
// An install that only ever had ADMIN_USERNAME / ADMIN_PASSWORD has no stored account,
// and after accounts a session has to name one. It is a working install, so it gets a real
// administrator from the credentials it already carries rather than the setup screen.
const adopted = await store.adoptEnvCredentials(envCredentials());
if (adopted) log("WARN", "An administrator was created from the environment credentials, they can now be removed", { username: adopted.username });
// The operator's recovery. The store answers against the value it acted on last, so a
// variable left in the container configuration does nothing on the next boot.
const resetValue = process.env.ADMIN_PASSWORD_RESET;
if (resetValue) {
  const reset = await store.resetPasswordFromEnv(process.env.ADMIN_USERNAME, resetValue);
  if (reset) log("WARN", "The account password was reset from the environment", { username: reset.username });
}
// A level chosen in the interface outlives the container it was chosen in.
const savedLevel = parseLevel(store.settings().logLevel);
if (savedLevel) setLevel(savedLevel);
log("INFO", "Server starting", { ...build, logLevel: currentLevel() });
configureSecureMode(() => store.settings().secureMode !== false);
await initLogger(); startLogMaintenance();
if (restrictedMode()) log("INFO", "Restricted mode enabled");
await images.load();
await artworks.load();
const playbackOwners = new Map<string, { owner: ResourceOwner; resourceId: string }>();
const airplayAccess = new AirPlayAccess(mediaResources);
/** Where a download with no library of its own goes: the default for the kind. A read-only
 *  library is never a destination, so it is left out of the choice. */
const downloadDefaultLibrary = (kind: "movie" | "series") =>
  defaultLibrary(store.libraries().filter((library) => !library.readOnly), store.settings(), kind === "series" ? "episode" : "movie");
const queue = new DownloadQueue(() => store.settings().concurrentDownloads, () => store.settings().parallelPerProvider ?? 1, undefined, undefined, {
  segments: () => store.settings().downloadSegments ?? 1,
  libraries: () => store.libraries(),
  defaultLibrary: downloadDefaultLibrary,
  // A job paused for a library asks whether it is back; the probe is refreshed first so a
  // disk that was plugged in is seen within the queue's own retry, not the cache's.
  libraryState: async (libraryId) => { await refreshLibraryHealth(); return libraryFor(store.libraries(), libraryId); },
}); const playback = new PlaybackManager(undefined, (id) => {
  const owned = playbackOwners.get(id);
  if (owned) {
    // The tombstone matters: a player that has just been closed still has range requests in
    // the air, and a 404 invites it to try them again. 410 says the resource is gone for good.
    mediaResources.remove(owned.resourceId, true);
    // Destroyed, not ended. The proxy aborts its upstream only for a response that was cut
    // (`!res.writableEnded`) -- see the note at the media route. Ending these politely would
    // leave the connection to the source reading on.
    for (const active of activeMedia) if (active.resourceId === owned.resourceId) active.res.destroy();
  }
  if (owned) rangeCache.forget(owned.resourceId);
  playbackOwners.delete(id);
  airplayAccess.remove(id);
  throughput.forget(id);
});
const stats = new StatsLog();
let libraryOpsWriting = false;
/** How fast each running playback is transferring right now. */
const throughput = new Throughput();

/** The provider comes from the source address; an addon may use a different one per stream. */
const providerOf = (url?: string) => { try { return url ? new URL(url).hostname : "unknown"; } catch { return "unknown"; } };

const statMeta = (job: { source?: TrafficMeta["source"]; url?: string; addonKey?: string; addonName?: string; title: string; kind?: string }): TrafficMeta => ({
  source: job.source ?? "download",
  provider: providerOf(job.url),
  addonKey: job.addonKey,
  addonName: job.addonName,
  title: job.title,
  kind: job.kind === "movie" || job.kind === "episode" ? job.kind : "other",
});

const statEvent = (job: { at: string; bytes: number; url?: string; addonKey?: string; addonName?: string; title: string; kind?: string }): TrafficEvent =>
  ({ ...statMeta(job), at: job.at, bytes: job.bytes, items: 1 });
if (!store.defaultsInstalled()) {
  const defaults = [
    { url: "https://v3-cinemeta.strem.io/manifest.json", role: "catalog" as const },
    { url: "https://opensubtitles-v3.strem.io/manifest.json", role: "source" as const },
  ];
  const loaded = await Promise.allSettled(defaults.filter((item) => !store.addons().some((addon) => addon.manifestUrl === item.url)).map((item) => loadAddon(item.url, item.role)));
  await store.update((state) => {
    for (const result of loaded) if (result.status === "fulfilled") state.addons.push(result.value);
    state.defaultsInstalled = defaults.every((item) => state.addons.some((addon) => addon.manifestUrl === item.url));
  });
}
// Source pick for lazy queue jobs: the addons are asked at download time and the
// answer is held for a while, so repeated attempts at one episode do not hammer them.
const streamCache = new Map<string, { at: number; items: StreamItem[] }>();
const cachedStreams = async (type: string, id: string) => {
  const key = `${type}:${id}`;
  const hit = streamCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.items;
  const items = await streams(store.addons(), type, id);
  if (streamCache.size > 100) streamCache.clear();
  streamCache.set(key, { at: Date.now(), items });
  return items;
};
queue.setResolver(async (source) => {
  const priority = new Map(store.addons().map((addon, index) => [addon.key, index]));
  const candidates = (await cachedStreams(source.type, source.videoId)).filter((stream) => stream.url);
  if (source.selection) {
    await serverReady;
    const external = source.selection.subtitleMode === "off" ? [] : await subtitles(store.addons(), source.type, source.videoId);
    const selected = await selectDownloadSource({ candidates, subtitles: external, selection: source.selection, tried: source.tried, inspect: (stream) => playback.inspect(stream) });
    if (!selected) return undefined;
    const addon = store.addons().find((item) => item.key === selected.stream.addonKey);
    return { ...selected, settings: addon?.downloadSettings ?? defaultDownloadSettings() };
  }
  // The queue picks a source with no request in hand: the one account's language is the
  // one to pick it in.
  const ranked = rankStreams(candidates, prefsOf().audioLanguage, priority);
  const next = ranked.find((stream) => !source.tried.includes(stream.url!));
  if (!next) return undefined;
  const addon = store.addons().find((item) => item.key === next.addonKey);
  return { stream: next, settings: addon?.downloadSettings ?? defaultDownloadSettings() };
});
await playback.load();

/** With no account at all and no fallback credentials, nothing can be done. */
const needsSetup = () => !store.users().length && !envCredentials();

const isSecure = (req: express.Request) => req.headers["x-forwarded-proto"] === "https" || req.protocol === "https";
const currentSession = (req: express.Request): SessionInfo | undefined => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  // The token names a user, and the secret that checks it belongs to that user: an id that
  // resolves to nobody, or to an account that may not sign in, is not a session.
  const id = sessionUserId(token);
  const user = id ? findUserById(store.users(), id) : undefined;
  if (!user || user.disabled) return undefined;
  const info = readSession(user.secret, token);
  if (!info || info.userId !== user.id) return undefined;
  // A signed-out session is invalid even with a signature that still verifies.
  return user.revoked?.[info.sid] ? undefined : info;
};
const currentUser = (req: express.Request) => {
  const session = currentSession(req);
  return session ? findUserById(store.users(), session.userId) : undefined;
};

/** Which account a call speaks for. A request answers with the account its session names;
 *  work with no request in hand -- a library job resumed from disk, the artwork queue --
 *  belongs to the one account this release has. */
const accountIdOf = (req?: express.Request): string | undefined =>
  req ? currentUser(req)?.id : store.users()[0]?.id;
/** That person's settings, over the built-in defaults while the instance has no account. */
const prefsOf = (req?: express.Request): UserPrefs => store.prefs(accountIdOf(req));
/** The four personal maps of the state, read. A request with no usable session must not
 *  read somebody else's rows. */
const dataOf = (req: express.Request): UserData => {
  const id = accountIdOf(req);
  if (!id) throw new ResourceError(401, "AUTH_REQUIRED");
  return store.userData(id);
};
/** Applies the mutation inside a state mutator the caller already has open. */
const mutateData = (state: State, id: string, mutate: (data: UserData) => void) => {
  const data = state.userData?.[id] ?? emptyUserData();
  mutate(data);
  state.userData = { ...(state.userData ?? {}), [id]: data };
};
const updateData = async (req: express.Request | undefined, mutate: (data: UserData) => void): Promise<void> => {
  const id = accountIdOf(req);
  if (!id) throw new ResourceError(401, "AUTH_REQUIRED");
  await store.update((state) => mutateData(state, id, mutate));
};
/** What the four personal maps hold. `UserData` keeps them opaque, so that the user model
 *  stays clear of the library and progress modules; the server is where they are pinned. */
const watchlistOf = (data: UserData) => data.watchlist as Record<string, WatchlistEntry>;
const progressOf = (data: UserData) => data.progress as Record<string, StoredProgress>;
const markersOf = (data: UserData) => data.watchedSeries as Record<string, WatchedMarker>;

const ownerOf = (req: express.Request): ResourceOwner => {
  const session = currentSession(req);
  if (!session) throw new ResourceError(401, "AUTH_REQUIRED");
  return { sid: session.sid, expiresAt: session.expiresAt };
};
const sourceOf = (req: express.Request): StreamItem => {
  if (["stream", "url", "headers", "path"].some((key) => key in (req.body ?? {}))) throw new ResourceError(400, "UNSAFE_SOURCE_INPUT");
  return mediaResources.get(String(req.body?.sourceId ?? ""), ownerOf(req).sid, "source").stream;
};
const httpSourceOf = async (req: express.Request): Promise<StreamItem> => {
  const stream = sourceOf(req);
  if (stream.url) return stream;
  throw new AppError("A torrent cannot be played directly. Add it with To library.", "err.torrentNotPlayable", 409);
};
const internalMediaRequest = (req: express.Request) =>
  isInternalMediaPath(req.path) &&
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "") &&
  req.query.token === INTERNAL_TOKEN;
// Memoised: the authentication gate and the restricted-mode gate both ask, and a refusal
// that is written down twice reads like two separate attempts.
const airplayGrants = new WeakMap<express.Request, ReturnType<typeof airplayAccess.authorize>>();
const airplayRequest = (req: express.Request) => {
  if (airplayGrants.has(req)) return airplayGrants.get(req);
  const grant = airplayAccess.authorize(req.method, req.originalUrl.split("?")[0], req.query.airplay);
  airplayGrants.set(req, grant);
  return grant;
};
const playbackResponse = <T extends { id: string; url: string }>(value: T): T => ({ ...value, url: airplayAccess.url(value.id, value.url) });
const activeMedia = new Set<{ owner: ResourceOwner; res: express.Response; resourceId?: string }>();
const trackMedia = (owner: ResourceOwner, res: express.Response, resourceId?: string) => {
  const active = { owner, res, resourceId };
  activeMedia.add(active);
  res.once("close", () => activeMedia.delete(active));
};
/** The one guard every library file read goes through: it refuses a dot segment, a
 *  traversal and a symlink that leaves the root, whether the client sent a relative
 *  path or a qualified key. */
const libraryTarget = async (value: string) => {
  const resolved = await resolveLibraryPath(store.libraries(), value);
  if (!resolved) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
  const real = await realpath(resolved.absolute).catch(() => undefined);
  if (!real) {
    // The resource was found; the file behind it was not. "Select the source again" would
    // send the viewer back to a list that hands them the same missing file.
    log("WARN", "A library file is no longer where the library says it is", { path: resolved.key });
    throw new AppError("The file was not found in the library.", "err.libraryFileMissing", 404);
  }
  return real;
};
const safeInspection = (info: Awaited<ReturnType<PlaybackManager["inspect"]>>, stream: StreamItem) => ({
  duration: info?.duration,
  video: info?.video ? { codec: safeSourceText(info.video.codec, stream), width: info.video.width, height: info.video.height } : undefined,
  audioTracks: (info?.audioTracks ?? []).map((track) => ({ ...track, title: safeSourceText(track.title, stream), language: safeSourceText(track.language, stream), codec: safeSourceText(track.codec, stream) })),
  subtitleTracks: (info?.subtitleTracks ?? []).map((track) => ({ ...track, title: safeSourceText(track.title, stream), language: safeSourceText(track.language, stream), codec: safeSourceText(track.codec, stream) })),
});
const stopOwnedPlayback = async (sid?: string) => {
  mediaResources.revoke(sid);
  for (const active of activeMedia) if (!sid || active.owner.sid === sid) active.res.destroy();
  for (const [id, owned] of playbackOwners) if (!sid || owned.owner.sid === sid) await playback.stop(id);
  for (const [id, ticket] of deviceDownloadTickets) if (!sid || ticket.owner.sid === sid) deviceDownloadTickets.delete(id);
};

app.use(securityHeaders());
app.use(express.json({ limit: "256kb" }));

// Every request gets a short tag, so an error reported from the browser and its cause
// on the server can be tied together without hunting through the log by timestamp.
declare global { namespace Express { interface Request { id?: string } } }
app.use("/api", (req, res, next) => {
  const id = randomUUID().slice(0, 8);
  req.id = id;
  res.setHeader("x-request-id", id);
  const startedAt = Date.now();
  // Playback segments arrive by the hundred, hence debug level only.
  res.on("finish", () => log("DEBUG", "API request", { req: id, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - startedAt }));
  next();
});
/** Measures how much the response actually sends and reports it to the statistics.
 * It counts at write time, so what the client asked for and then abandoned by closing
 * playback never reaches the total. */
const countBytes = (res: express.Response, meta: TrafficMeta, session?: string) => {
  const measure = (chunk: unknown) => {
    if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) return;
    const bytes = Buffer.byteLength(chunk);
    stats.add(meta, bytes);
    if (session) throughput.add(session, bytes);
  };
  const write = res.write.bind(res) as (...args: unknown[]) => boolean;
  const end = res.end.bind(res) as (...args: unknown[]) => express.Response;
  res.write = ((...args: unknown[]) => { measure(args[0]); return write(...args); }) as typeof res.write;
  res.end = ((...args: unknown[]) => { measure(args[0]); return end(...args); }) as typeof res.end;
};

/** Library playback reads a file from disk; catalogue playback goes out through the proxy. */
const playbackMeta = (stream: StreamItem): TrafficMeta => stream.url?.startsWith("file://")
  ? { source: "library", provider: "knihovna", title: path.basename(stream.url.slice(7)), kind: "other" }
  : statMeta({ source: "catalog", url: stream.url, title: sourceTitle(stream) || providerOf(stream.url), addonKey: stream.addonKey, addonName: stream.addonName });

// Without a sign-in only the server status and the sign-in itself are open. /api/proxy
// especially must not be public, or anyone could pull foreign addresses through this server.
const OPEN_PATHS = new Set(["/status", "/auth/login", "/auth/me", "/auth/setup"]);
const unauthorized = new RepeatFilter();
app.use("/api", (req, res, next) => {
  if (OPEN_PATHS.has(req.path)) return next();
  if (internalMediaRequest(req) || airplayRequest(req)) return next();
  if (!currentUser(req)) {
    // This one never reaches the error handler, so without a line here a run of refused
    // requests -- an expired session, or somebody trying the API from outside -- leaves no
    // trace above DEBUG. Only whether a session cookie came along is recorded, never its value.
    const session = SESSION_COOKIE in parseCookies(req.headers.cookie) ? "expired or invalid" : "none";
    // The session state is part of the key: a browser whose sign-in ran out says something
    // a stream of requests carrying no cookie at all does not, and it must not be swallowed
    // by whichever of the two knocked first.
    const repeat = unauthorized.record(`${req.ip ?? "unknown"} ${req.path} ${session}`);
    if (repeat) log("WARN", "Request without a valid session", {
      req: req.id, method: req.method, path: req.path, from: req.ip ?? "unknown", session,
      ...(repeat.suppressed ? { alsoRefused: repeat.suppressed } : {}),
    });
    return res.status(401).json({ error: "Not signed in.", messageKey: "err.notSignedIn" });
  }
  next();
});
app.use("/api", restrictedMiddleware({
  isOpen: (req) => OPEN_PATHS.has(req.path),
  isInternal: (req) => internalMediaRequest(req) || Boolean(airplayRequest(req)),
}));

setInterval(() => {
  for (const active of activeMedia) if (active.owner.expiresAt <= Date.now()) active.res.destroy();
  for (const [id, owned] of playbackOwners) if (owned.owner.expiresAt <= Date.now()) {
    // Playback outliving the sign-in that started it is the one teardown nobody asked for.
    // Its late reads answer 410 like any other closed session, so said here or not at all.
    log("INFO", "Playback stopped, the viewer's session had expired", { id });
    void playback.stop(id);
  }
}, 1000).unref();

const routeContext: RouteContext = { store, needsSetup, currentSession, currentUser, isSecure, stopOwnedPlayback };
registerAuthRoutes(app, routeContext);

/** The page only ever holds our own id, so anything it hands back is turned into the
 *  real address again before it is stored or downloaded. */
const posterOf = (value: unknown): string | undefined => {
  const raw = value ? String(value) : "";
  return raw ? images.original(raw) : undefined;
};

const mediaSource = (value: unknown): MediaInfo | undefined => {
  const media = value as MediaInfo | undefined;
  return media ? { ...media, poster: posterOf(media.poster) } : undefined;
};

/** The catalogue poster travels with the queued job and with library metadata as well. */
const mediaView = (media: MediaInfo) => ({ ...media, poster: images.proxied(media.poster) });
/** A job's target is stored qualified, like every other key; the client gets the wire form,
 *  which stays relative while one library is configured. */
const jobView = <T extends { media?: MediaInfo; target?: string }>(job: T): T => ({
  ...job,
  ...(job.target ? { target: wirePath(job.target) } : {}),
  ...(job.media ? { media: mediaView(job.media) } : {}),
});

/** An addon logo sits on the provider's server as well, so it takes the same detour. */
const withProxiedLogo = <T extends { manifest: { logo?: string } }>(view: T): T =>
  (images.proxied(view.manifest.logo) === view.manifest.logo
    ? view
    : { ...view, manifest: { ...view.manifest, logo: images.proxied(view.manifest.logo) } });
const publicAddonView = (addon: AddonRecord) =>
  (restrictedMode() ? withProxiedLogo(publicAddonRestricted(addon)) : withProxiedLogo(publicAddon(addon)));

app.get("/api/status", (_req, res) => res.json({ status: "ok", ...build, restricted: restrictedMode(), secure: secureMode() }));
// A manifest is a snapshot from the moment the addon was added: its catalogues,
// resources and id prefixes decide what the addon is asked for, so a stale copy
// quietly hides catalogues and skips sources. Refreshing rewrites the manifest and
// nothing else -- the key, the order, the role and the save rules are ours.
const storeRefreshed = async (outcomes: RefreshOutcome[]) => {
  const updated = outcomes.filter((outcome) => outcome.changed && outcome.manifest);
  if (!updated.length) return;
  await store.update((state) => {
    for (const outcome of updated) {
      const addon = state.addons.find((a) => a.key === outcome.key);
      if (addon && outcome.manifest) addon.manifest = outcome.manifest;
    }
  });
  for (const outcome of updated) log("INFO", "Addon manifest updated", { name: outcome.name, from: outcome.previousVersion, to: outcome.version });
};
// The automatic round is a background chore: it never blocks the boot, it asks only
// the addons actually in use, and a provider that is down costs a log line. The
// interval lives in Settings, so the tick only asks whether a round is due -- a
// changed interval takes effect without rescheduling anything.
const AUTO_REFRESH_FIRST_MS = 30_000;
const AUTO_REFRESH_CHECK_MS = 15 * 60_000;
const autoRefresh = async () => {
  if (!autoRefreshEnabled() || !refreshDue(store.addonsRefreshedAt(), store.settings().addonRefreshHours)) return;
  const targets = store.addons().filter((addon) => addon.enabled);
  const outcomes = await refreshManifests(targets, loadAddon);
  await storeRefreshed(outcomes);
  await store.update((state) => { state.addonsRefreshedAt = new Date().toISOString(); });
};
if (autoRefreshEnabled()) {
  setTimeout(() => {
    void autoRefresh();
    setInterval(() => void autoRefresh(), AUTO_REFRESH_CHECK_MS).unref();
  }, AUTO_REFRESH_FIRST_MS).unref();
}
registerAddonsRoutes(app, { ...routeContext, storeRefreshed, publicAddonView });
const tmdbProvider = (language: string): MetaProvider | undefined => {
  const apiKey = store.settings().tmdbApiKey;
  return apiKey ? (type, id) => tmdbMeta(type, id, { apiKey, language }) : undefined;
};
/** The viewer's own correction for subtitles that run ahead of the picture or behind it. */
const SUBTITLE_DELAY_LIMIT_S = 30;
const subtitleDelay = (value: unknown) => {
  const delay = Number(value);
  return Number.isFinite(delay) ? Math.max(-SUBTITLE_DELAY_LIMIT_S, Math.min(SUBTITLE_DELAY_LIMIT_S, delay)) : 0;
};

/** How many times a dropped source request is repeated, and how long between the tries. */
const SOURCE_ATTEMPTS = 3;
const SOURCE_RETRY_MS = 400;
/** A source that has just gone quiet gets one short chance instead of three long ones. Somebody
 *  is waiting on a seek, and a minute of retries against a host that is not answering reads as a
 *  player that has stopped taking clicks. */
/** How many times a broken transfer is picked up again before the viewer is told. */
const SOURCE_RESUMES = 5;
const SOURCE_QUIET_MS = 20_000;
const SOURCE_QUIET_HEADER_MS = 6_000;
const SOURCE_HEADER_MS = 30_000;
/** What a cached answer has to repeat to be the same answer. */
const answerHeaders = (upstream: Response) => Object.fromEntries(
  ["content-type", "content-length", "content-range", "accept-ranges"]
    .map((name) => [name, upstream.headers.get(name)])
    .filter((pair): pair is [string, string] => pair[1] !== null));

/** The header and the index of a film, kept so the next FFmpeg does not fetch them again. */
const rangeCache = new RangeCache();
const quietSources = new Map<string, number>();
const sourceIsQuiet = (key: string) => (quietSources.get(key) ?? 0) > Date.now() - SOURCE_QUIET_MS;
const noteSourceQuiet = (key: string) => {
  quietSources.set(key, Date.now());
  while (quietSources.size > 200) quietSources.delete(quietSources.keys().next().value!);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const DEVICE_TICKET_TTL = 24 * 60 * 60_000;
type DeviceDownloadTicket = {
  owner: ResourceOwner;
  expiresAt: number;
  filename: string;
  source: { kind: "local"; path: string } | { kind: "remote"; stream: StreamItem; title: string; media?: MediaInfo };
};
const deviceDownloadTickets = new Map<string, DeviceDownloadTicket>();
const pruneDeviceDownloadTickets = () => {
  const now = Date.now();
  for (const [key, ticket] of deviceDownloadTickets) if (ticket.expiresAt <= now) deviceDownloadTickets.delete(key);
  // Bound memory use on long-running servers; expired links can be recreated with another click.
  while (deviceDownloadTickets.size > 500) deviceDownloadTickets.delete(deviceDownloadTickets.keys().next().value!);
};
/** Every path inside the server is a qualified key; the client speaks relative paths
 *  while one library is configured, and `wirePath` is the single place that turns one
 *  back into the other. */
const singleLibrary = () => {
  const libraries = store.libraries();
  // An unqualified path cannot say which library it belongs to, so with more than one
  // configured the pass-through has no answer. Throwing beats a call site that forgot to
  // qualify a key and silently wrote into the first library instead.
  // A client that still holds a bare path from a single-library install -- a bookmark, a
  // remembered browse path -- must get the same refusal as any other invalid path, not a
  // developer's sentence. The message still names the count, for the log.
  if (libraries.length !== 1) {
    throw new AppError(`Invalid path: it names no library, and ${libraries.length} are configured.`, "err.invalidPath");
  }
  return libraries[0]!;
};
/** Folders inside this library that another library owns. The walk, the pickers and
 *  the prune all stop at them, or a delete would take the other library with it. */
const carveOutsOf = (library: LibraryRecord) => new Set(carveOuts(store.libraries(), library));
/** The library a key names, with the key's part below it. A key without a library id is
 *  the single-library pass-through; `singleLibrary` throws if there is no such library. */
const libraryOfKey = (key: string) => {
  const parsed = parseLibraryPath(key);
  if (!parsed) return { library: singleLibrary(), relative: key };
  return { library: libraryFor(store.libraries(), parsed.libraryId) ?? singleLibrary(), relative: parsed.relative };
};
/** Qualifies a wire path; a path that already names a library is left alone. */
const libraryKey = (value: string) => {
  const parsed = parseLibraryPath(value);
  return parsed ? libraryPath(parsed.libraryId, parsed.relative) : libraryPath(singleLibrary().id, value);
};
/** The wire form of a key: relative while one library is configured, qualified as soon as
 *  the interface has to tell several apart. Dropping a prefix it cannot attribute would
 *  hand the client a path that names the wrong library, so it never guesses. */
const wirePath = (key: string) => {
  const libraries = store.libraries();
  return libraries.length === 1 ? relativeWithin(libraries[0]!.id, key) : key;
};
const mediaPath = (key: string, ...rest: string[]) => {
  const { library, relative } = libraryOfKey(key);
  return path.join(library.root, toFs(posixJoin(relative, ...rest)));
};

const libraryProbe = createLibraryProbe();
const libraryHealth = new Map<string, LibraryHealth>();
/** Probes are cached for half a minute, and a library whose answer changed drops the walks. */
const refreshLibraryHealth = async () => {
  let changed = false;
  for (const library of store.libraries()) {
    const before = libraryHealth.get(library.id);
    const health = await libraryProbe.cached(library.root);
    if (before && (before.unreachable !== health.unreachable || before.readOnly !== health.readOnly)) changed = true;
    libraryHealth.set(library.id, health);
  }
  if (changed) invalidateLibrary();
  return libraryHealth;
};
/** Skipped by the walk, the scan and the sweep; never removed, its metadata stays. */
const walkableLibraries = () =>
  store.libraries().filter((library) => library.enabled && !libraryHealth.get(library.id)?.unreachable);
/** The key as a library file stores it. Keys of another library are not ours to write. */
const relativeKeyIn = (libraryId: string, key: string) => {
  const parsed = parseLibraryPath(key);
  return parsed?.libraryId === libraryId ? parsed.relative : undefined;
};

const metaCache = new Map<string, { value: MetaItem | null; at: number }>();
/** A lookup with no request in hand -- the artwork queue, a backfill, a job that has just
 *  finished -- reads the language of the one account. A caller that knows which person is
 *  asking passes that person's language. */
const cachedMeta = async (type: string, id: string, language: string = prefsOf().uiLanguage) => {
  const key = `${type}:${id}:${language}`;
  const hit = metaCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 60 * 60_000) return hit.value;
  const value = await metadata(store.addons(), type, id, language, tmdbProvider(language)).catch(() => null);
  if (metaCache.size > 300) metaCache.clear();
  // A failed lookup is not an answer: caching it would hold a title empty for six hours.
  if (value) metaCache.set(key, { value, at: Date.now() });
  return value;
};
// Walking the tree is expensive, so it is held in memory for a while. The queue invalidates it once a download finishes.
let libraryCache: { at: number; entries: Awaited<ReturnType<typeof scanLibrary>> } | undefined;
let videoCache: { at: number; files: Awaited<ReturnType<typeof listVideos>> } | undefined;
const invalidateLibrary = () => { libraryCache = undefined; videoCache = undefined; unitCache = undefined; };
registerCatalogRoutes(app, { ...routeContext, tmdbProvider, cachedMeta, prefsOf, libraryTarget, ownerOf, trackMedia, libraryKey, metaStore, externalIds, subtitleDelay });
const libraryFiles = async () => {
  if (videoCache && Date.now() - videoCache.at < 30_000) return videoCache.files;
  const files: FoundFile[] = [];
  for (const library of walkableLibraries()) {
    for (const file of await listVideos(library.root, "", 0, carveOutsOf(library))) {
      files.push({ ...file, relative: libraryPath(library.id, file.relative) });
    }
  }
  videoCache = { at: Date.now(), files };
  return files;
};
const libraryFilesIn = async (library: LibraryRecord) =>
  (await libraryFiles()).filter((file) => relativeKeyIn(library.id, file.relative) !== undefined);
/** Title units of every library, the type of each one applied. Cached with the walk
 *  it derives from, because a catalogue-sized tree is expensive to index. */
let unitCache: { at: number; units: TitleUnit[] } | undefined;
const libraryUnits = async (): Promise<TitleUnit[]> => {
  if (unitCache && Date.now() - unitCache.at < 30_000) return unitCache.units;
  const files = await libraryFiles();
  const units = walkableLibraries().flatMap((library) =>
    titleUnits(files.filter((file) => relativeKeyIn(library.id, file.relative) !== undefined), library.type));
  unitCache = { at: Date.now(), units };
  return units;
};
const libraryEntries = async () => {
  if (libraryCache && Date.now() - libraryCache.at < 30_000) return libraryCache.entries;
  const known = metaStore.qualifiedMeta();
  const entries: LibraryEntry[] = [];
  for (const library of walkableLibraries()) {
    for (const entry of await scanLibrary(library.root, carveOutsOf(library))) {
      const key = libraryPath(library.id, entry.key);
      const qualified: LibraryEntry = {
        ...entry, key,
        files: entry.files.map((file) => ({ ...file, path: libraryPath(library.id, file.path) })),
      };
      const record = knownTitleOf(key, known);
      if (record) {
        qualified.meta = {
          type: record.type, id: record.id, name: record.name,
          description: record.description, year: record.year,
        };
      }
      entries.push(qualified);
    }
  }
  entries.sort((a, b) => b.modified.localeCompare(a.modified));
  libraryCache = { at: Date.now(), entries };
  return entries;
};

/** The address of a thumbnail never changes, so without a stamp the browser keeps
 *  showing the frame it loaded before the title was matched. */
const artStamp = async (file: string) => {
  const info = await stat(file).catch(() => undefined);
  return info ? Math.round(info.mtimeMs).toString(36) : "0";
};
/** The libraries as browse rows, for an empty path while more than one is configured.
 *  Counts come from the walks the library listing already holds, so opening the root does
 *  not walk the tree again. */
const libraryRootBrowse = async () => {
  await refreshLibraryHealth();
  const [stats, entries] = await Promise.all([libraryStats(), libraryEntries()]);
  let pending = false;
  const items = await Promise.all([...store.libraries()].sort((a, b) => a.order - b.order).map(async (library) => {
    const counts = stats.get(library.id) ?? { titles: 0, files: 0, bytes: 0 };
    const key = libraryPath(library.id, "");
    const path = wirePath(key);
    const posters = new Set<string>();
    const previewEntries = entries.filter((entry) => parseLibraryPath(entry.key)?.libraryId === library.id);
    if (library.mosaic !== false) {
      const records = metaStore.meta(library.id);
      for (const entry of previewEntries) {
        const relative = relativeKeyIn(library.id, entry.key);
        if (relative === undefined || mosaicSkipped(relative, records)) continue;
        const art = await locateArtwork(entry);
        if (!art) { scheduleArtwork(entry); pending = true; }
        const poster = await thumbUrl("key", wirePath(entry.key), art);
        if (poster) posters.add(poster);
        if (posters.size === 5) break;
      }
    }
    return {
      kind: "library" as const, libraryId: library.id, name: library.name, label: library.name,
      type: library.type, enabled: library.enabled,
      fileCount: counts.files, titles: counts.titles, size: counts.bytes,
      unreachable: healthOf(library).unreachable, readOnly: healthOf(library).readOnly,
      path, posters: [...posters], poster: await thumbUrl("dir", path, await locateFolderArtwork(key)),
    };
  }));
  return { path: "", items, total: items.length, pending };
};

/** The address of one shape's variant. The poster address is the one the interface already
 *  holds, so the shape is named only for a backdrop. */
const thumbUrl = async (param: "path" | "dir" | "key", value: string, art: string | undefined, shape: ArtShape = "poster") =>
  (art
    ? `/api/library/thumb?${param}=${encodeURIComponent(value)}${shape === "wide" ? "&shape=wide" : ""}&v=${await artStamp(art)}`
    : undefined);

const artworkQueue = new ArtworkQueue();
const fileExists = async (file: string) => { try { await access(file); return true; } catch { return false; } };
const dataArtworkFile = (key: string) => artworks.file(key);

/** Every removal of a generated thumbnail goes through here: the cache counts bytes it wrote,
 *  and an entry left behind after its file is gone makes the next eviction drop a live picture. */
const removeArtwork = async (file: string) => {
  await rm(file, { force: true });
  await artworks.removed(file);
};

/** A generated thumbnail is counted against the cache ceiling; the same picture written
 *  next to the media is the folder's own and is neither counted nor evicted. */
const saveGenerated = async (target: string, write: () => Promise<boolean>) => {
  const saved = await write();
  if (saved) await artworks.written(target);
  return saved;
};

/** A write next to the media that failed is a better signal than the next scheduled probe:
 *  the mount may have turned read-only, filled up or gone. The probe is forgotten, so the
 *  next `GET /api/libraries` asks the disk again, and the failure is said out loud once. */
const saveArtwork = async (key: string, target: string, write: () => Promise<boolean>) => {
  const saved = await saveGenerated(target, write);
  if (!saved && artworkBesideMediaFor(key)) {
    const { library } = libraryOfKey(key);
    libraryProbe.invalidate(library.root);
    log("WARN", "Artwork could not be written next to the media", { key, library: library.id, root: library.root });
  }
  return saved;
};

/** `saveArtwork` with the reason kept, for the pictures the catalogue hands us: one of them not
 *  arriving used to be silent end to end, and a blank title nobody can explain is worse than a
 *  warning in the log. */
const saveArtworkReport = async (
  key: string, target: string, url: string, what: string,
  save: (target: string, url: string) => Promise<PosterOutcome>,
) => {
  let refusal: Extract<PosterOutcome, { ok: false }> | undefined;
  const saved = await saveArtwork(key, target, async () => {
    const outcome = await save(target, url);
    if (!outcome.ok) refusal = outcome;
    return outcome.ok;
  });
  if (!saved) log("WARN", `${what} could not be saved`, { key, host: hostOf(url), target, reason: refusal?.reason ?? "no-file", detail: refusal?.detail });
  return saved;
};
const savePosterReport = (key: string, target: string, url: string, what: string) =>
  saveArtworkReport(key, target, url, what, savePosterAs);
/** The wide variant is narrowed on the way in, which is why it has a writer of its own. */
const saveBackdropReport = (key: string, target: string, url: string) =>
  saveArtworkReport(key, target, url, "The catalogue backdrop", saveBackdropAs);

/** Someone else's picture in the folder always wins: nothing is overwritten or regenerated. */
async function locateArtwork(entry: Awaited<ReturnType<typeof scanLibrary>>[number], shape: ArtShape = "poster") {
  const directory = entryDirectory(entry);
  if (directory) {
    const folder = mediaPath(directory);
    const existing = await findArtwork(folder, artNames(shape));
    if (existing) return path.join(folder, existing);
  }
  const own = storeArt(libraryKey(entry.key), shape);
  return own && await fileExists(own) ? own : undefined;
}

/** Fills a missing thumbnail: the poster from metadata first, otherwise a representative frame from the video. */
function scheduleArtwork(entry: Awaited<ReturnType<typeof scanLibrary>>[number]) {
  // Repeated polling asks for the same missing thumbnail before the first attempt
  // finishes; without this it would queue the same expensive job over and over.
  if (artworkQueue.has(entry.key)) return;
  artworkQueue.run(entry.key, async () => {
    if (await locateArtwork(entry)) return;
    const directory = entryDirectory(entry);
    const target = directory && artworkBesideMediaFor(entry.key) ? path.join(mediaPath(directory), POSTER_OUTPUT) : dataArtworkFile(libraryKey(entry.key));
    await mkdir(path.dirname(target), { recursive: true });
    if (await catalogPosterIfBound(libraryKey(entry.key), target)) return;
    if (await locateArtwork(entry)) return;
    if (await catalogPosterIfBound(libraryKey(entry.key), target)) return;
    const source = entry.files[0];
    if (!source) return;
    const info = await playback.inspect({ url: `file://${source.path}` }).catch(() => undefined);
    if (await saveArtwork(entry.key, target, () => saveFrame(mediaPath(source.path), target, framePosition(info?.duration)))) {
      log("INFO", "Thumbnail generated from the video", { key: entry.key });
    }
  });
}

/** The roots this process honours: the operator's, rebuilt from the environment on every
 *  boot, plus the ones granted from the interface. */
const libraryGrants = () => mergeGrants(envGrants(process.env.LIBRARY_ROOTS, DOWNLOAD_DIR), store.grants());

/** A granted root as the picker renders it: where it came from and whether this process
 *  may write into it. */
const grantRows = async () => Promise.all(libraryGrants().map(async (grant) => ({
  ...grantView(grant),
  writable: await access(grant.path, constants.W_OK).then(() => true, () => false),
})));

/** Titles, files and bytes per library, taken from the walks the listing already caches. */
const libraryStats = async () => {
  const [entries, files] = await Promise.all([libraryEntries(), libraryFiles()]);
  const stats = new Map<string, { titles: number; files: number; bytes: number }>();
  for (const library of store.libraries()) stats.set(library.id, { titles: 0, files: 0, bytes: 0 });
  for (const entry of entries) {
    const stat = stats.get(parseLibraryPath(entry.key)?.libraryId ?? "");
    if (stat) { stat.titles += 1; stat.bytes += entry.size; }
  }
  for (const file of files) {
    const stat = stats.get(parseLibraryPath(file.relative)?.libraryId ?? "");
    if (stat) stat.files += 1;
  }
  return stats;
};

const healthOf = (library: LibraryRecord): LibraryHealth =>
  libraryHealth.get(library.id) ?? { unreachable: false, readOnly: false };

/** Whether a poster for this key may be written next to the media. The library of the key
 *  decides, alone: an added archive, a read-only mount and one that is away all keep their
 *  folder, and a curated library says no for its own tree. */
const artworkBesideMediaFor = (key: string) => {
  const { library } = libraryOfKey(key);
  return artworkBesideMedia(library, healthOf(library));
};

/** The wire view of a library. Restricted mode withholds `root`: the picker discloses host
 *  layout to somebody at the keyboard, and a shared instance renders names and counts only. */
const libraryView = (library: LibraryRecord, health: LibraryHealth, stats: { titles: number; files: number; bytes: number }) => ({
  id: library.id, name: library.name, type: library.type,
  ...(restrictedMode() ? {} : { root: toPosix(library.root) }),
  enabled: library.enabled, order: library.order, addedAt: library.addedAt,
  writeArtwork: library.writeArtwork,
  mosaic: library.mosaic !== false,
  showInContinueWatching: library.showInContinueWatching !== false,
  unreachable: health.unreachable, readOnly: health.readOnly,
  defaultMovie: store.settings().defaultMovieLibrary === library.id,
  defaultSeries: store.settings().defaultSeriesLibrary === library.id,
  titles: stats.titles, files: stats.files, bytes: stats.bytes,
});

/** The folder picker. It exists for deployments without a native dialog -- a desktop build
 *  uses the OS dialog instead and never calls it. Which is also why both of its reads are
 *  denied in restricted mode: they are the one place that names directories on the host. */

app.get("/api/library", asyncRoute(async (_req, res) => {
  const entries = await libraryEntries();
  const summaries = await Promise.all(entries.map(async (entry) => {
    const art = await locateArtwork(entry);
    if (!art) scheduleArtwork(entry);
    const summary = summarize(entry);
    return { ...summary, key: wirePath(entry.key), meta: summary.meta && { ...summary.meta, poster: images.proxied(summary.meta.poster), background: images.proxied(summary.meta.background) },
      poster: await thumbUrl("key", entry.key, art) };
  }));
  res.json(summaries);
}));

/** The binding may sit on the file or on any parent folder. An id-less sentinel is ignored. */
const knownTitle = (key: string) => knownTitleOf(key, metaStore.qualifiedMeta());

/** One item named by a stored key, from the library that owns it. Favourites and the
 *  resume list span libraries, so neither can go through the first library's root. */
const describeLibraryPath = async (key: string) => {
  const { library, relative } = libraryOfKey(key);
  return describePath(library.root, relative, carveOutsOf(library));
};

/** Thumbnail of one video. Next to the video it is looked up by Jellyfin's naming convention.
 *  An episode still is a landscape frame, so it serves the wide shape as it is; the portrait
 *  one keeps its own slot. */
async function locateFileArtwork(key: string, shape: ArtShape = "poster") {
  const media = path.join(posixDir(mediaPath(key)), episodeArtName(posixBase(key)));
  if (await fileExists(media)) return media;
  const own = storeArt(key, shape);
  if (own && await fileExists(own)) return own;
  // The folder's picture belongs to a film only when the folder is the film's folder: a title
  // bound through that folder, not one bound on the file itself, which is what a film moved
  // into a shared folder becomes.
  const cover = knownTitleEntry(key, metaStore.qualifiedMeta());
  if (fileMayUseFolderArtwork(key, cover?.record.type, cover?.key)) return locateFolderArtwork(posixDir(key), shape);
  return undefined;
}

const PLAYBACK_IDLE_SECONDS = 300;
const playbackBusy = () => playback.diagnostics().sessions.some((session) => session.idleSeconds < PLAYBACK_IDLE_SECONDS);
const metaBackfill = new ArtworkQueue();
// A title the catalogue answers without a description would otherwise be asked
// about on every single browse, so a finished attempt holds for a while.
const BACKFILL_RETRY_MS = 6 * 60 * 60_000;
const metaBackfillTried = new Map<string, number>();
/** The language travels with the work: the row that asked for it knows whose settings
 *  saw it, and the fetch that runs later has no request to read them from. */
const scheduleMetaBackfill = (type: string, id: string, language: string) => {
  const key = `${type}:${id}`;
  const tried = metaBackfillTried.get(key);
  if (!id || playbackBusy()) return false;
  if (tried != null && Date.now() - tried < BACKFILL_RETRY_MS) return false;
  metaBackfill.run(key, async () => {
    if (playbackBusy()) return;
    const meta = await cachedMeta(type, id, language);
    metaBackfillTried.set(key, Date.now());
    for (const [seen, at] of metaBackfillTried) if (Date.now() - at > BACKFILL_RETRY_MS) metaBackfillTried.delete(seen);
    if (!meta) return;
    const fields = cacheFieldsFromMeta(meta);
    const episodeRows = episodesFromMeta(meta);
    const at = new Date().toISOString();
    // The binding is found by catalogue identity, so every library is walked; only the
    // ones holding a row for this title are written.
    await metaStore.updateAll((file, _libraryId, episodes) => {
      let bound = false;
      for (const [key, record] of Object.entries(file.meta)) {
        if (record.type !== type || record.id !== id) continue;
        file.meta[key] = { ...record, ...fields, backfilledAt: at };
        bound = true;
      }
      if (bound) Object.assign(episodes, episodeRows);
    });
    invalidateLibrary();
  });
  return true;
};

const isFileKey = (key: string) => isVideo(posixBase(key));
const ART_SHAPES: ArtShape[] = ["poster", "wide"];
/** Where one variant of a key sits in the generated store, or nothing where the store cannot
 *  place it: a `#wide` suffix on a library's own key would land on the library id, which the
 *  store refuses. Such a key keeps the poster it has always had and gets no wide variant. */
const storeArt = (key: string, shape: ArtShape = "poster") => {
  const variant = artVariantKey(key, shape);
  const parsed = parseLibraryPath(variant.startsWith("dir:") ? variant.slice(4) : variant);
  return parsed ? dataArtworkFile(variant) : undefined;
};
/** Both files of one shape, because a key can name a file or a folder and the caller does not
 *  always know which. */
const generatedArtFiles = (key: string, shape: ArtShape) =>
  [storeArt(key, shape), storeArt(`dir:${key}`, shape)].filter((file): file is string => file !== undefined);
/** Where a folder's variant sits: the `dir:` prefix keeps a file and a folder of the same name
 *  apart. */
const hashedArt = (key: string, shape: ArtShape = "poster") =>
  isFileKey(key) ? storeArt(key, shape) : storeArt(`dir:${key}`, shape);
const removeGeneratedArt = async (key: string) => {
  for (const shape of ART_SHAPES) for (const file of generatedArtFiles(key, shape)) await removeArtwork(file);
  // Artwork deleted on purpose may be asked for again: the retry window is for titles that have
  // none, not for a picture somebody just removed.
  backdropTried.delete(artworkQueueKey(key, "wide"));
};
/** Where a shape's variant goes when the library allows writing next to the media. The poster
 *  keeps the name it has always had; the wide one is the backdrop Jellyfin and Emby read. */
const besideMediaTarget = (key: string, shape: ArtShape) =>
  isFileKey(key)
    ? path.join(posixDir(mediaPath(key)), shape === "wide" ? BACKDROP_OUTPUT : episodeArtName(posixBase(key)))
    : path.join(mediaPath(key), artOutput(shape));
/** Whether a file's backdrop may be dropped next to the media. The backdrop of a folder is a
 *  title's picture only where the folder is the film's own -- the same gate the poster goes
 *  through -- so an episode keeps its wide variant in the store, where it is looked up again. */
const wideBesideMedia = (key: string) => {
  if (!artworkBesideMediaFor(key)) return false;
  if (!isFileKey(key)) return true;
  const cover = knownTitleEntry(key, metaStore.qualifiedMeta());
  return fileMayUseFolderArtwork(key, cover?.record.type, cover?.key);
};
/** Where one variant of an item's artwork is written: next to the media where the library allows
 *  it, in the generated store otherwise, and nowhere where the store cannot place it. */
const artworkTarget = (key: string, shape: ArtShape) =>
  (shape === "wide" ? wideBesideMedia(key) : artworkBesideMediaFor(key)) ? besideMediaTarget(key, shape) : hashedArt(key, shape);
/** The queue key of one shape's job for an item. The two shapes never share a key, so a
 *  backdrop is queued while the poster job for the same item is still running. */
const artworkQueueKey = (key: string, shape: ArtShape) =>
  artVariantKey(isFileKey(key) ? `file:${key}` : `dir:${key}`, shape);
const mediaArtExists = async (key: string, shape: ArtShape) => {
  const folder = isFileKey(key) ? posixDir(key) : key;
  if (!folder) return false;
  return Boolean(await findArtwork(mediaPath(folder), artNames(shape)));
};

/** One shape of the catalogue artwork. A picture of the folder's own always wins for that
 *  shape, and the stale copy in the generated store goes either way. */
const writeCatalogArt = async (key: string, url: string | undefined, shape: ArtShape) => {
  if (!url) return false;
  if (await mediaArtExists(key, shape)) {
    // Not a failure: a picture of the folder's own always wins, and it is worth being able to
    // see that this is why nothing was written.
    log("DEBUG", "The folder has its own picture, the catalogue artwork was not written", { key, shape });
    return false;
  }
  for (const file of generatedArtFiles(key, shape)) await removeArtwork(file);
  const target = artworkTarget(key, shape);
  if (!target) return false;
  await mkdir(path.dirname(target), { recursive: true });
  return shape === "wide"
    ? saveBackdropReport(key, target, url)
    : savePosterReport(key, target, url, "The catalogue poster");
};

/** Both variants in one pass, from the poster and the background the metadata carries side by
 *  side. Every match writes through here, so a newly matched title has both pictures at once. */
const writeCatalogPoster = async (key: string, url?: string, backdrop?: string) => {
  if (!key || key === ".") return false;
  const poster = await writeCatalogArt(key, url, "poster");
  await writeCatalogArt(key, backdrop, "wide");
  return poster;
};

/** The binding on this exact path, ignoring one inherited from a parent folder. */
const ownRecord = (relative: string, records: Record<string, LibraryMetaRecord>) =>
  (records[relative]?.id ? records[relative] : undefined);

/** Generated thumbnails of a path and everything under it. A changed binding makes
 *  them stale: the poster of the old title, or a frame grabbed while unmatched. */
const clearGeneratedArt = async (key: string) => {
  await removeGeneratedArt(key);
  for (const file of await libraryFiles()) {
    if (file.relative !== key && isPathWithin(file.relative, key)) await removeGeneratedArt(file.relative);
  }
};

const attachBrowseMeta = <T extends { path: string; kind: string; name?: string; label?: string }>(item: T, language: string) => {
  const records = metaStore.qualifiedMeta();
  const episodes = metaStore.episodes();
  const key = libraryKey(item.path);
  const label = item.kind === "folder" ? String(item.name ?? "") : String(item.label ?? "");
  const extra = browseMeta(key, label, records, metaStore.qualifiedSuggestions(), episodes);
  const known = knownTitleOf(key, records);
  const numbers = item.kind === "file" ? episodeNumberOf(key, ownRecord(key, records)) : undefined;
  // Only a key can answer with a better language; without one every record stays wanted as it is.
  const wantedLanguage = store.settings().tmdbApiKey ? language : undefined;
  const wanted = needsBackfill(known, undefined, wantedLanguage) || needsEpisodes(known, numbers, episodes);
  const backfill = wanted && scheduleMetaBackfill(known!.type, known!.id, language);
  // The move dialog offers only the libraries that take what it is about to hand them,
  // and a row without a binding has no kind to compare -- the server stays the backstop.
  const titled = known && (known.type === "movie" || known.type === "series") ? { titleType: known.type } : {};
  return { item: { ...item, ...extra, ...titled }, backfill };
};

/** An episode gets its own still. Falling back to the series poster would paint
 *  the same picture on every row, so it is left to the frame grabber instead. */
async function catalogPosterIfBound(key: string, target: string) {
  const records = metaStore.qualifiedMeta();
  const known = knownTitleOf(key, records);
  if (!known) return false;
  if (known.type === "series" && isVideo(posixBase(key))) {
    const numbers = episodeNumberOf(key, ownRecord(key, records));
    const row = numbers ? metaStore.episodes()[episodeKey(known.type, known.id, numbers.season, numbers.episode)] : undefined;
    if (!row?.thumbnail) return false;
    if (await savePosterReport(key, target, row.thumbnail, "The episode still")) {
      log("INFO", "Episode still filled in from metadata", { path: key });
      return true;
    }
    return false;
  }
  const meta = await cachedMeta(known.type, known.id);
  if (!meta?.poster) return false;
  if (await savePosterReport(key, target, meta.poster, "The metadata poster")) {
    log("INFO", "Poster filled in from metadata", { path: key });
    return true;
  }
  return false;
}

// A title the catalogue has no backdrop for would be asked again on every single browse, so a
// finished attempt holds it back for the same six hours the metadata backfill waits.
const backdropTried = new Map<string, number>();
const backdropDue = (key: string) => {
  const tried = backdropTried.get(key);
  return tried == null || Date.now() - tried >= BACKFILL_RETRY_MS;
};
const rememberBackdropAttempt = (key: string) => {
  backdropTried.set(key, Date.now());
  for (const [seen, at] of backdropTried) if (Date.now() - at > BACKFILL_RETRY_MS) backdropTried.delete(seen);
};
/** Nobody is waiting for a frame grab while a video plays, and one that was tried lately is
 *  left alone: this is the most expensive picture the server makes. */
const backdropWanted = (queueKey: string) => backdropDue(queueKey) && !playbackBusy();

/** The wide variant of a bound title, taken from the catalogue. An episode still is not a
 *  backdrop: the still next to the file is landscape already and was found before this runs. */
async function catalogBackdropIfBound(key: string, target: string) {
  const known = knownTitleOf(key, metaStore.qualifiedMeta());
  if (!known) return false;
  const meta = await cachedMeta(known.type, known.id);
  if (!meta?.background) return false;
  if (await saveBackdropReport(key, target, meta.background)) {
    log("INFO", "Backdrop filled in from metadata", { path: key });
    return true;
  }
  return false;
}

function scheduleFileArtwork(key: string, shape: ArtShape = "poster") {
  const queueKey = artworkQueueKey(key, shape);
  // Same guard as scheduleArtwork: a page reload while the frame grab is still
  // running must not pile up another one behind it.
  if (artworkQueue.has(queueKey)) return;
  if (shape === "wide" && !backdropWanted(queueKey)) return;
  artworkQueue.run(queueKey, async () => {
    if (shape === "wide" && playbackBusy()) return;
    if (await locateFileArtwork(key, shape)) return;
    // The attempt starts here: one that finds nothing is not repeated on the next browse.
    if (shape === "wide") rememberBackdropAttempt(queueKey);
    const source = await realpath(mediaPath(key)).catch(() => undefined);
    if (!source) return;
    const target = artworkTarget(key, shape);
    if (!target) return;
    await mkdir(path.dirname(target), { recursive: true });
    if (shape === "wide") {
      if (await catalogBackdropIfBound(key, target)) return;
      if (await locateFileArtwork(key, "wide")) return;
    }
    else {
      if (await catalogPosterIfBound(key, target)) return;
      if (await locateFileArtwork(key)) return;
      if (await catalogPosterIfBound(key, target)) return;
    }
    const info = await playback.inspect({ url: `file://${wirePath(key)}` }).catch(() => undefined);
    await saveArtwork(key, target, () => saveFrame(source, target, framePosition(info?.duration)));
  });
}

const folderArtworkIn = (key: string, listing: FolderListing | undefined) => async (shape: ArtShape) => {
  const existing = pickArtwork(listing, artNames(shape));
  if (existing) return path.join(mediaPath(key), existing);
  const own = storeArt(`dir:${key}`, shape);
  return own && await fileExists(own) ? own : undefined;
};

/** Folder thumbnail: its own picture, then the one from metadata, otherwise a frame from the first video inside. */
async function locateFolderArtwork(key: string, shape: ArtShape = "poster") {
  return folderArtworkIn(key, await readFolderListing(mediaPath(key)))(shape);
}

/** Both shapes out of one listing, for the rows that draw a poster and a backdrop side by side. */
async function locateFolderArtworkPair(key: string) {
  const shaped = folderArtworkIn(key, await readFolderListing(mediaPath(key)));
  return { poster: await shaped("poster"), wide: await shaped("wide") };
}

function scheduleFolderArtwork(key: string, shape: ArtShape = "poster") {
  const queueKey = artworkQueueKey(key, shape);
  if (artworkQueue.has(queueKey)) return;
  if (shape === "wide" && !backdropWanted(queueKey)) return;
  artworkQueue.run(queueKey, async () => {
    if (shape === "wide" && playbackBusy()) return;
    if (await locateFolderArtwork(key, shape)) return;
    // The attempt starts here: one that finds nothing is not repeated on the next browse.
    if (shape === "wide") rememberBackdropAttempt(queueKey);
    const target = artworkTarget(key, shape);
    if (!target) return;
    await mkdir(path.dirname(target), { recursive: true });
    if (shape === "wide") {
      if (await catalogBackdropIfBound(key, target)) return;
      if (await locateFolderArtwork(key, "wide")) return;
    }
    else {
      if (await catalogPosterIfBound(key, target)) return;
      if (await locateFolderArtwork(key)) return;
      if (await catalogPosterIfBound(key, target)) return;
    }
    const { library, relative } = libraryOfKey(key);
    const inside = await browseDirectory(library.root, relative, "", 0, 20,
      "name", false, "", undefined, carveOutsOf(library));
    let first = inside.items.find((item) => item.kind === "file");
    if (!first) {
      const sub = inside.items.find((item) => item.kind === "folder");
      if (sub) first = (await browseDirectory(library.root, sub.path, "", 0, 20, "name", false, "", undefined, carveOutsOf(library))).items.find((item) => item.kind === "file");
    }
    if (!first) return;
    const source = mediaPath(libraryPath(library.id, first.path));
    const info = await playback.inspect({ url: `file://${source}` }).catch(() => undefined);
    await saveArtwork(key, target, () => saveFrame(source, target, framePosition(info?.duration)));
  });
}

/** Thumbnails in the data directory outlive the video. After a scan the ones whose source
 *  is gone are removed. Saving next to the video has no such problem: the picture goes with
 *  the folder. Each library is swept on its own, and only while its root can actually be
 *  read: a mount that is down must never cost the user the thumbnails stored on it.
 *  A read-only root is readable, so the valid set is computable and the sweep runs: the
 *  thumbnails it deletes live in `data/artwork/<libraryId>/`, which is writable anyway. */
let lastArtworkSweep = 0;
async function sweepArtwork() {
  if (Date.now() - lastArtworkSweep < 10 * 60_000) return;
  lastArtworkSweep = Date.now();
  // The poster is saved when the job is queued, while the source does not exist yet.
  // Without this the sweep would delete it before the download finishes.
  const queued = queue.list().flatMap((job) => {
    const key = queuedArtworkKey(job);
    return key ? [key] : [];
  });
  const rootReadable = async (root: string) => { try { await access(root, constants.R_OK); return true; } catch { return false; } };
  await refreshLibraryHealth();
  const health = (library: LibraryRecord) => libraryHealth.get(library.id);
  let removed = 0;
  for (const library of store.libraries()) {
    if (!library.enabled || health(library)?.unreachable) continue;
    if (!await rootReadable(library.root)) {
      log("WARN", "The library root could not be read, its thumbnails are left alone", { library: library.name, root: library.root });
      continue;
    }
    const valid = new Set<string>();
    // The ancestor rows matter: a folder is keyed `dir:<path>` for paths that appear in
    // no file and in no binding, because a folder is not a file.
    const rememberArt = (key: string) => {
      for (const shape of ART_SHAPES) {
        const file = storeArt(key, shape);
        if (file) valid.add(path.basename(file));
      }
    };
    const remember = (key: string) => {
      rememberArt(key);
      const parts = key.split("/");
      for (let depth = 1; depth < parts.length; depth += 1) {
        rememberArt(`dir:${parts.slice(0, depth).join("/")}`);
      }
    };
    for (const entry of await scanLibrary(library.root, carveOutsOf(library))) {
      rememberArt(libraryPath(library.id, entry.key));
      for (const file of entry.files) remember(libraryPath(library.id, file.path));
    }
    for (const key of queued) if (parseLibraryPath(key)?.libraryId === library.id) remember(key);

    const dir = artworks.dirOf(library.id);
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (valid.has(name)) continue;
      const file = path.join(dir, name);
      // Second safeguard: anything fresh is kept. Its source may still be on its way.
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile() || Date.now() - info.mtimeMs < 60 * 60_000) continue;
      await removeArtwork(file);
      removed += 1;
    }
  }
  if (removed) log("INFO", "Orphaned thumbnails deleted", { removed });
}

// A favourite is only a flag on a path. Nothing is moved anywhere.
const withFavorites = <T extends { path: string }>(items: T[], data: UserData) => {
  const favorites = new Set(data.favorites);
  return items.map((item) => ({ ...item, favorite: favorites.has(libraryKey(item.path)) }));
};

/** Called from the route and from a library job, which runs with no request: the one
 *  account this release has owns the flag either way. */
const setLibraryFavorite = async (relative: string, wanted: boolean) => {
  const resolved = relative ? await resolveLibraryPath(store.libraries(), relative) : undefined;
  if (!resolved) throw new AppError("Invalid path.", "err.invalidPath");
  await updateData(undefined, (data) => {
    const current = new Set(data.favorites);
    if (wanted) current.add(resolved.key); else current.delete(resolved.key);
    data.favorites = [...current];
  });
};

registerPersonalRoutes(app, { ...routeContext, attachBrowseMeta, cachedMeta, dataOf, describeLibraryPath, libraryKey, libraryOfKey, locateFileArtwork, locateFolderArtworkPair, markersOf, metaStore, posterOf, prefsOf, progressOf, scheduleFileArtwork, scheduleFolderArtwork, setLibraryFavorite, thumbUrl, updateData, watchlistOf, wirePath });

// Deleting, renaming and moving touch real files, hence the path and root checks.

/** Everything the store remembers about a path, dropped in one go. Returns the catalogue
 *  titles that nothing points at any more, for the log. */
const forgetLibraryPath = async (key: string) => {
  // The resume list and the watchlist are keyed by catalogue title, not by path, so a
  // deleted file would leave the title hanging in both, offering to continue something
  // that is no longer on disk. The match history knows the catalogue binding -- it is
  // read before this cleanup deletes it.
  const orphans = orphanedCatalogKeys(metaStore.qualifiedMeta(), key);
  const target = parseLibraryPath(key);
  if (target) await metaStore.update(target.libraryId, (file) => {
    file.meta = dropKeyed(file.meta, target.relative);
    file.suggestions = dropKeyed(file.suggestions, target.relative);
  });
  // Also reached from a library job, which has no request: the one account owns the rows.
  await updateData(undefined, (data) => {
    data.favorites = data.favorites.filter((item) => !isPathWithin(item, key));
    data.progress = Object.fromEntries(Object.entries(progressOf(data)).filter(([progressKey, value]) => {
      if (orphans.has(progressKey)) return false;
      const itemPath = progressKey.startsWith("file:") ? progressKey.slice(5) : value.path;
      return !itemPath || !isPathWithin(itemPath, key);
    }));
    data.watchlist = Object.fromEntries(Object.entries(watchlistOf(data)).filter(([watchKey]) => !orphans.has(watchKey)));
  });
  return orphans;
};

/** Every stored binding uses the relative path, so a move has to keep them all consistent.
 *  `pin` is for a move into another folder: the identity an item inherited from the folder
 *  it is leaving has to become its own, or the destination's title would take over. */
const relocateLibraryPath = async (key: string, nextKey: string, pin = false) => {
  // The bindings live in one file per library, so a move into another library rewrites two
  // of them and the store is the only place that can do both.
  await metaStore.relocate(key, nextKey, pin);
  await updateData(undefined, (data) => {
    data.favorites = data.favorites.map((item) => remapPath(item, key, nextKey));
    data.progress = Object.fromEntries(Object.entries(progressOf(data)).map(([progressKey, value]) => {
      const filePath = progressKey.startsWith("file:") ? progressKey.slice(5) : undefined;
      const nextProgressKey = filePath ? `file:${remapPath(filePath, key, nextKey)}` : progressKey;
      const nextPath = value.path ? remapPath(value.path, key, nextKey) : value.path;
      return [nextProgressKey, { ...value, path: nextPath }];
    }));
  });
};

/** Moves the hashed thumbnails of an item and of everything under it to their new keys. The
 *  cache creates the destination library's directory: `data/artwork/<libraryId>/` is made on a
 *  library's first thumbnail, so a move *between* libraries used to fail with `ENOENT` and lose
 *  the picture to the orphan sweep an hour later. */
const relocateArtwork = async (items: string[], relative: string, nextRelative: string) => {
  for (const item of items) {
    const next = remapPath(item, relative, nextRelative);
    for (const [from, to] of [[item, next], [`dir:${item}`, `dir:${next}`]]) {
      for (const shape of ART_SHAPES) {
        const moved = artVariantKey(from!, shape), target = artVariantKey(to!, shape);
        const result = await artworks.moveKey(moved, target);
        if (!result.carried && result.reason === "failed") {
          log("WARN", "A thumbnail could not follow its item", { from: moved, to: target, detail: result.detail });
        }
      }
    }
  }
};

/** The same for a copy: the item exists twice now and both halves deserve the picture. */
const duplicateArtwork = async (items: string[], relative: string, nextRelative: string) => {
  for (const item of items) {
    const next = remapPath(item, relative, nextRelative);
    for (const [from, to] of [[item, next], [`dir:${item}`, `dir:${next}`]]) {
      for (const shape of ART_SHAPES) {
        const copied = artVariantKey(from!, shape), target = artVariantKey(to!, shape);
        const result = await artworks.copyKey(copied, target);
        if (!result.carried && result.reason === "failed") {
          log("WARN", "A thumbnail could not be copied to the item's new key", { from: copied, to: target, detail: result.detail });
        }
      }
    }
  }
};

/** A title bound through its folder keeps its picture under that folder's key. Moving the item
 *  out pins the binding on the item, so the picture has to follow it: without this the item
 *  shows up blank and the folder's copy is swept as an orphan an hour later. Copied rather than
 *  moved, because whatever stays in the folder is still that title's. */
const carryCoveringArtwork = async (cover: string, nextKey: string) => {
  const to = isFileKey(nextKey) ? nextKey : `dir:${nextKey}`;
  for (const shape of ART_SHAPES) {
    const result = await artworks.copyKey(artVariantKey(`dir:${cover}`, shape), artVariantKey(to, shape));
    if (!result.carried && result.reason === "failed") {
      log("WARN", "The picture of the folder a title is bound through could not travel with it", { cover, next: nextKey, shape, detail: result.detail });
    }
  }
};

/** The folder the last video just left is litter, so it goes too -- up the tree for as long
 *  as the parent holds nothing to watch either. */
const pruneEmptiedFolders = async (key: string) => {
  const { library, relative } = libraryOfKey(key);
  const gone = await emptiedFolders(library.root, relative, carveOutsOf(library));
  for (const folder of gone) {
    const folderKey = libraryPath(library.id, folder);
    await rm(mediaPath(folderKey), { recursive: true, force: true });
    await removeGeneratedArt(folderKey);
    await forgetLibraryPath(folderKey);
  }
  if (gone.length) log("INFO", "Emptied folders removed", { folders: gone });
  return gone;
};

const deleteLibraryItem = async (relative: string) => {
  const resolved = relative ? await resolveLibraryPath(store.libraries(), relative) : undefined;
  if (!resolved || !resolved.relative) throw new AppError("Invalid path.", "err.invalidPath");
  const info = await stat(resolved.absolute).catch(() => undefined);
  if (!info) throw new AppError("The file or folder does not exist.", "err.pathMissing");
  await rm(resolved.absolute, { recursive: true, force: true });
  await removeGeneratedArt(resolved.key);
  const orphans = await forgetLibraryPath(resolved.key);
  const pruned = await pruneEmptiedFolders(resolved.key);
  invalidateLibrary();
  log("INFO", "Deleted from the library", { path: relative, directory: info.isDirectory(), forgottenTitles: [...orphans], pruned });
};

/** The kind of the unit an item belongs to: its own binding first, the structure the source
 *  library gives it otherwise, because an unbound file carries no type of its own. */
const unitKindOf = async (key: string): Promise<TitleKind | undefined> => {
  const record = ownRecord(key, metaStore.qualifiedMeta());
  if (record?.type === "movie" || record?.type === "series") return record.type;
  const covering = (await libraryUnits()).filter((unit) => isPathWithin(key, unit.key));
  return covering.sort((a, b) => b.key.length - a.key.length)[0]?.kind;
};

/** A typed library is a promise about what is inside it, and a move must not break it
 *  without being asked. `mixed` takes anything, and so does a unit whose kind nobody can
 *  name -- refusing that would block a move over a guess. Confirming is the owner's to
 *  do: nothing renders differently afterwards, only a later scan reads the item as the
 *  library's kind. */
const assertMoveType = async (key: string, destination: LibraryRecord, confirmed = false) => {
  if (destination.type === "mixed") return;
  const kind = await unitKindOf(key);
  if (kind && kind !== destination.type) {
    if (!confirmed) {
      throw new AppError(`A ${destination.type} library does not take ${kind === "movie" ? "films" : "series"}.`,
        "err.libraryTypeMismatch", undefined, { type: destination.type, kind });
    }
    log("INFO", "A move into a library of another type was confirmed", { key, library: destination.id, type: destination.type, kind });
  }
};

const transferLibraryItem = async (relative: string, folder: string, copy = false, progress?: TransferProgress, confirmTypeMismatch = false) => {
  const resolved = relative ? await resolveLibraryPath(store.libraries(), relative) : undefined;
  if (!resolved || !resolved.relative) throw new AppError("Invalid path.", "err.invalidPath");
  const info = await stat(resolved.absolute).catch(() => undefined);
  if (!info) throw new AppError("The file or folder does not exist.", "err.pathMissing");

  const folderResolved = await resolveLibraryPath(store.libraries(), folder);
  if (!folderResolved) throw new AppError("Invalid path.", "err.invalidPath");
  const folderInfo = await stat(folderResolved.absolute).catch(() => undefined);
  if (!folderInfo?.isDirectory()) throw new AppError("The destination folder does not exist.", "err.targetMissing");

  // Into another library the item simply keeps its name: the two folders have nothing to
  // do with one another, so the checks that guard a move inside one do not apply.
  const acrossLibraries = folderResolved.library.id !== resolved.library.id;
  if (acrossLibraries) await assertMoveType(resolved.key, folderResolved.library, confirmTypeMismatch);
  const destination = acrossLibraries
    ? { path: posixJoin(folderResolved.relative, posixBase(resolved.relative)) }
    : moveDestination(resolved.relative, folderResolved.relative);
  if ("error" in destination) {
    throw destination.error === "sameFolder"
      ? new AppError("The item is already in that folder.", "err.sameFolder")
      : new AppError("A folder cannot be moved into itself.", "err.moveIntoItself");
  }
  // Qualified, so a destination in another library resolves under its own root.
  const target = await resolveLibraryPath(store.libraries(), libraryPath(folderResolved.library.id, destination.path));
  if (!target) throw new AppError("Invalid path.", "err.invalidPath");
  if (await fileExists(target.absolute)) throw new AppError("A file with that name already exists.", "err.nameTaken");

  // The thumbnails are keyed by path, so they are carried over rather than dropped:
  // the item is the same item and would otherwise lose its poster until a rescan.
  const carried = [resolved.key, ...(await libraryFiles())
    .map((file) => file.relative).filter((item) => item !== resolved.key && isPathWithin(item, resolved.key))];
  // The folder a title is bound through, when the item does not carry the binding itself: its
  // picture is the title's and has to travel with it.
  const cover = knownTitleEntry(resolved.key, metaStore.qualifiedMeta());
  const transferred = await transferLibraryPath(resolved.absolute, target.absolute, !copy, progress);
  if (copy) {
    await metaStore.copy(resolved.key, target.key);
    // Both halves of a copy keep the picture: the item exists twice now.
    await duplicateArtwork(carried, resolved.key, target.key);
  }
  else {
    await relocateArtwork(carried, resolved.key, target.key);
    if (cover && cover.key !== resolved.key && isPathWithin(resolved.key, cover.key)) await carryCoveringArtwork(cover.key, target.key);
    await relocateLibraryPath(resolved.key, target.key, true);
  }
  // Only the library the item left: the destination gained a folder, it did not lose one.
  const pruned = copy ? [] : await pruneEmptiedFolders(resolved.key);
  invalidateLibrary();
  const moved = wirePath(target.key);
  log("INFO", copy ? "Copied in the library" : "Moved in the library",
    { from: relative, to: moved, library: resolved.library.id, pruned, ...(transferred.sourceLeft ? { sourceLeft: transferred.sourceLeft } : {}) });
  return moved;
};

// Manual binding of a title to a folder, for a file that did not arrive through the queue.
/** Binds the folder the file will land in to a catalogue title, so metadata need not be guessed. */
/** A title is represented by its folder. A flat layout has none, so the file stands for itself.
 *  The prefix folder from the save rules is not a title, hence the first path segment will not do. */
const titleKey = (target: string, media: MediaInfo | undefined, flat: boolean) => {
  if (flat) return target;
  const directory = path.dirname(target);
  if (directory === ".") return target;
  return media?.kind === "episode" && media.season != null ? path.dirname(directory) : directory;
};

/** The catalogue artwork is saved as the job is queued, so it is in the library before the file
 *  is. `fallback` is the catalogue's own answer, tried only when the first address fails: the
 *  poster the client handed over is the one the viewer expects, but it may be a dead link.
 *  `backdrop` rides along, so both variants of a newly matched title arrive together. */
const saveCatalogPoster = (key: string, url?: string, fallback?: string, backdrop?: string) => {
  if (!key || key === "." || (!url && !fallback && !backdrop)) return;
  const queueKey = isFileKey(key) ? `file:${key}` : `dir:${key}`;
  artworkQueue.run(queueKey, async () => {
    if (url && await writeCatalogPoster(key, url, backdrop)) {
      log("INFO", "Poster from the catalog saved", { key });
      return;
    }
    if (fallback && fallback !== url && await writeCatalogPoster(key, fallback, backdrop)) {
      log("INFO", "Poster from the catalog saved", { key, source: "metadata" });
      return;
    }
    // A title the catalogue has only a background for still gets that.
    if (!url && !fallback) await writeCatalogPoster(key, undefined, backdrop);
  });
};

const hostOf = (url: string) => { try { return new URL(url).host; } catch { return ""; } };
const scanGapMs = Number(process.env.LIBRARY_SCAN_GAP_MS);
/** Age at which the scan re-reads a bound series. `0` switches the pass off. */
const metaTtlMs = () => {
  const days = Number(process.env.LIBRARY_META_TTL_DAYS);
  return Number.isFinite(days) && days >= 0 ? days * 24 * 60 * 60_000 : 14 * 24 * 60 * 60_000;
};
const browsedLibraries = new Set<string>();
/** A library the interface opened is worth keeping current: the walk of a library nobody
 *  looked at is what the freshness pass is allowed to skip. */
const markBrowsed = (library: LibraryRecord) => { browsedLibraries.add(library.id); };
registerContentRoutes(app, { ...routeContext, attachBrowseMeta, carveOutsOf, dataOf, deleteLibraryItem, fileExists, invalidateLibrary, libraryEntries, libraryKey, libraryRootBrowse, locateArtwork, locateFileArtwork, locateFolderArtwork, locateFolderArtworkPair, markBrowsed, prefsOf, progressOf, relativeKeyIn, relocateLibraryPath, scheduleFileArtwork, scheduleFolderArtwork, singleLibrary, sweepArtwork, thumbUrl, transferLibraryItem, wirePath, withFavorites });
const libraryScan = new LibraryScan({
  dataDir: DATA_DIR,
  // The scan works on keys, so the walk it injects is the qualified one.
  pathExists: async (key: string) => { try { await access(mediaPath(key)); return true; } catch { return false; } },
  units: async () => { await refreshLibraryHealth(); return libraryUnits(); },
  // The freshness pass is a courtesy to what the user actually looks at: only the
  // libraries the interface touched since the last run pay for it.
  browsed: () => new Set(browsedLibraries),
  metaTtlMs: metaTtlMs(),
  searchAll, metadata,
  addons: () => store.addons(),
  libraryMeta: () => metaStore.qualifiedMeta(),
  librarySuggestions: () => metaStore.qualifiedSuggestions(),
  // The scan thinks in qualified keys; the store turns them into per-library writes.
  updateMeta: async (mutator) => {
    await metaStore.updateQualified(mutator);
    invalidateLibrary();
  },
  savePoster: (key, url, backdrop) => saveCatalogPoster(key, url, undefined, backdrop),
  // The scan walks every entry anyway, so a missing wide variant is filled from here as well:
  // "scan again" backfills the library instead of leaving it to the first landscape browse.
  fillWideArtwork: (key) => {
    if (isFileKey(key)) scheduleFileArtwork(key, "wide");
    else scheduleFolderArtwork(key, "wide");
  },
  deleteGeneratedArt: (key) => clearGeneratedArt(key),
  busy: () => {
    if (libraryOpsWriting) return "operation";
    if (playback.diagnostics().sessions.some((session) => session.idleSeconds < PLAYBACK_IDLE_SECONDS)) return "playback";
    if (store.settings().libraryScanPauseOnDownload && queue.list().some((job) => job.status === "downloading")) return "download";
    const searchHosts = new Set(searchableCatalogs(store.addons()).map(({ addon }) => hostOf(addon.manifestUrl)));
    if (outbound.diagnostics().some((row) => row.state === "open" && searchHosts.has(row.host))) return "breaker";
    return undefined;
  },
  gapMs: Number.isFinite(scanGapMs) ? scanGapMs : 3_000,
});

const autoScanIntervalMs = Number(process.env.LIBRARY_AUTO_SCAN_INTERVAL_MS);
// The switch in Settings is the user's; this one keeps a whole install (or a test
// run) from ever reaching out on its own.
const autoScanAllowed = process.env.LIBRARY_AUTO_SCAN !== "0";
const libraryAutoScan = new LibraryAutoScan({
  enabled: () => autoScanAllowed && store.settings().libraryAutoScan,
  // One fingerprint per library, and an unreachable root is not in the list at all:
  // an unplugged disk must not read as a tree that lost every file.
  libraries: async () => {
    await refreshLibraryHealth();
    return walkableLibraries().map((library) => ({ id: library.id, files: () => libraryFilesIn(library) }));
  },
  status: () => libraryScan.snapshot(),
  start: (libraryId?: string) => libraryScan.start(libraryId ? { libraryId } : {}),
  busy: () => playbackBusy() || libraryOpsWriting || (store.settings().libraryScanPauseOnDownload && queue.list().some((job) => job.status === "checking" || job.status === "downloading")),
  watch: (onChange) => {
    const watches = walkableLibraries().map((library) => watchLibrary(library.root, () => { invalidateLibrary(); onChange(); }));
    return { active: watches.some((watch) => watch.active), close: () => { for (const watch of watches) watch.close(); } };
  },
  ...(Number.isFinite(autoScanIntervalMs) ? { intervalMs: autoScanIntervalMs } : {}),
});

const rememberTitle = async (target: string, media: MediaInfo | undefined, flat: boolean) => {
  if (!media?.id) return;
  const relative = titleKey(target, media, flat);
  if (!relative || relative === ".") return;
  const key = libraryKey(relative);
  const type = media.metaType ?? (media.kind === "episode" ? "series" : "movie");
  const meta = await cachedMeta(type, media.id);
  const fields = cacheFieldsFromMeta(meta);
  const episodeRows = episodesFromMeta(meta);
  const at = new Date().toISOString();
  const destination = parseLibraryPath(key);
  if (destination) await metaStore.update(destination.libraryId, (file, episodes) => {
    file.meta[destination.relative] = { type, id: media.id!, source: "download", locked: true, matchedAt: at, backfilledAt: at, ...fields };
    delete file.suggestions[destination.relative];
    Object.assign(episodes, episodeRows);
  });
  // The poster the client was looking at when it pressed download is the one to save: it needs
  // no round trip, and for an addon that answers `metadata()` with nothing it is the only one
  // there will ever be. The catalogue's own poster is the second chance, not the first.
  saveCatalogPoster(key, media.poster, meta?.poster, meta?.background);
};

// Completion invalidates the scan at once. For a lazy job the target path is known
// here for the first time, so only now can the catalogue binding and poster be saved.
// Bytes are written to the statistics as they flow; completion only adds that a whole
// item came of it. An interrupted download therefore stays in the statistics -- the data
// went through the line even though no file was kept.
queue.onProgress = (job, bytes) => stats.add(statMeta({ url: job.stream?.url, addonKey: job.stream?.addonKey, addonName: job.stream?.addonName, title: job.title, kind: job.media?.kind }), bytes);
queue.onCompleted = async (job) => {
  invalidateLibrary();
  await stats.complete(statMeta({ url: job.stream?.url, addonKey: job.stream?.addonKey, addonName: job.stream?.addonName, title: job.title, kind: job.media?.kind }));
  if (!job.source || !job.target || !job.media) return;
  const addon = store.addons().find((item) => item.key === job.stream?.addonKey);
  const settings = addon?.downloadSettings ?? defaultDownloadSettings();
  const targetSettings = job.source.selection?.targetSettings ?? (job.media.kind === "episode" ? settings.series : settings.movie);
  await rememberTitle(job.target, job.media, targetSettings.layout === "flat");
};
queue.setDebrid({
  configured: () => Boolean(store.settings().realDebridToken),
  advance: (input) => advanceTorrent(store.settings().realDebridToken, input.infoHash, input.fileIdx, input.torrentId),
});
await queue.load();
await libraryScan.load();
if (autoScanAllowed) libraryAutoScan.start();
await stats.load();
// History comes from the queue so the statistics do not start empty; finished jobs can
// be deleted, though, so from now on a record of our own is kept. Only what predates that
// record is filled in -- anything newer is already in it.
await stats.seed(queue.history().map(statEvent));

type LibraryMatchRequest = { path?: unknown; key?: unknown; id?: unknown; type?: unknown; scope?: unknown; season?: unknown; episode?: unknown; skipLookup?: unknown; skipMosaic?: unknown };

/** A library job matches with no request in hand, so the language of the one account is
 *  the one to bind the metadata in; the dialog passes the caller's own. */
const matchLibraryItem = async (body: LibraryMatchRequest, language = prefsOf().uiLanguage) => {
  const requested = String(body.path ?? body.key ?? "").trim();
  const resolved = requested ? await resolveLibraryPath(store.libraries(), requested) : undefined;
  if (!resolved) throw new AppError("Invalid path.", "err.invalidPath");
  const requestKey = resolved.key;
  const files = await libraryFiles();
  const unitKey = matchKeyFor(requestKey, files);
  const flag = typeof body.skipLookup === "boolean" ? { name: "skipLookup" as const, value: body.skipLookup }
    : typeof body.skipMosaic === "boolean" ? { name: "skipMosaic" as const, value: body.skipMosaic }
    : undefined;
  if (flag && body.id === undefined) {
    const target = parseLibraryPath(requestKey);
    if (target) await metaStore.update(target.libraryId, (file) => {
      const current = file.meta[target.relative];
      if (flag.value) {
        const record: LibraryMetaRecord = {
          type: current?.type ?? "movie",
          id: current?.id ?? "",
          source: current?.source ?? "user",
          ...(current?.locked != null ? { locked: current.locked } : {}),
          ...(current?.name ? { name: current.name } : {}),
          ...(current?.year ? { year: current.year } : {}),
          ...(current?.description ? { description: current.description } : {}),
          ...(current?.matchedAt ? { matchedAt: current.matchedAt } : {}),
          ...(current?.skipLookup ? { skipLookup: true } : {}),
          ...(current?.skipMosaic ? { skipMosaic: true } : {}),
        };
        if (flag.name === "skipLookup") record.skipLookup = true; else record.skipMosaic = true;
        file.meta[target.relative] = record;
      } else if (current) {
        const kept: LibraryMetaRecord = { ...current };
        if (flag.name === "skipLookup") delete kept.skipLookup; else delete kept.skipMosaic;
        if (kept.id || kept.skipLookup || kept.skipMosaic) file.meta[target.relative] = kept;
        else delete file.meta[target.relative];
      }
    });
    invalidateLibrary();
    const what = flag.name === "skipLookup" ? "matching" : "the mosaic";
    log("INFO", flag.value ? `Library path excluded from ${what}` : `Library path included in ${what}`, { path: requested });
    return flag.name === "skipLookup"
      ? { key: wirePath(requestKey), skipLookup: flag.value }
      : { key: wirePath(requestKey), skipMosaic: flag.value };
  }
  const id = String(body.id ?? "");
  const type = String(body.type ?? "movie");
  const number = (value: unknown) => {
    const parsed = Number(value);
    return value === undefined || value === null || value === "" || !Number.isFinite(parsed) ? undefined : parsed;
  };
  const episode = number(body.episode);
  const season = number(body.season);
  // "file" binds the one video the user clicked, "unit" the whole title it belongs to.
  const bindKey = body.scope === "file" ? requestKey : unitKey;
  const meta = id ? await cachedMeta(type, id, language) : null;
  const fields = cacheFieldsFromMeta(meta);
  const episodeRows = episodesFromMeta(meta);
  const at = new Date().toISOString();
  const episodeRow = type === "series" && episode != null
    ? episodeRows[episodeKey(type, id, season ?? 1, episode)] : undefined;
  const target = parseLibraryPath(bindKey);
  if (target) await metaStore.update(target.libraryId, (file, episodes) => {
    const request = relativeKeyIn(target.libraryId, requestKey);
    const unit = relativeKeyIn(target.libraryId, unitKey);
    if (!id) file.meta = unmatchAt(file.meta, request ?? target.relative);
    else {
      file.meta[target.relative] = {
        type, id, source: "user", locked: true, skipLookup: false,
        matchedAt: at, backfilledAt: at,
        ...fields,
        ...(type === "series" && episode != null ? { season: season ?? 1, episode } : {}),
      };
      if (request && request !== target.relative) delete file.meta[request];
    }
    for (const key of [target.relative, request, unit]) if (key) delete file.suggestions[key];
    Object.assign(episodes, episodeRows);
  });
  invalidateLibrary();
  await clearGeneratedArt(bindKey);
  if (requestKey !== bindKey) await clearGeneratedArt(requestKey);
  if (id) saveCatalogPoster(bindKey, episodeRow?.thumbnail ?? meta?.poster, undefined, meta?.background);
  log("INFO", "Library title matched", { key: bindKey, type, id: id || null, source: "user", ...(episode != null ? { season: season ?? 1, episode } : {}) });
  return { key: wirePath(bindKey), type, id: id || null };
};

const libraryOps = new LibraryOps({
  file: path.join(DATA_DIR, "library-ops.json"),
  pause: async (operation, item) => {
    // A `reroot` item is a bare name, so it resolves to no library path at all and every
    // guard below would be skipped. The two blockers that still apply are the same ones:
    // a disk that is away, and a file a session or a download is using right now.
    if (operation.op === "reroot") {
      await refreshLibraryHealth();
      if (libraryHealth.get(operation.libraryId)?.unreachable) return "library";
      const source = path.join(operation.from, item);
      if (playback.active().some((session) => {
        if (!session.stream.url?.startsWith("file:")) return false;
        try { return isInside(fileURLToPath(session.stream.url), source); } catch { return false; }
      })) return "playback";
      const writing = queue.list().filter((job) => job.target && (job.status === "checking" || job.status === "downloading"));
      if (writing.length) {
        const targets = await Promise.all(writing.map((job) => resolveLibraryPath(store.libraries(), job.target)));
        if (targets.some((target) => target && (isInside(target.absolute, operation.to) || isInside(target.absolute, operation.from)))) return "download";
      }
      return undefined;
    }
    const parsed = parseLibraryPath(item);
    const resolved = await resolveLibraryPath(store.libraries(), item);
    const library = parsed ? libraryFor(store.libraries(), parsed.libraryId) : resolved?.library;
    if (library) {
      await refreshLibraryHealth();
      if (libraryHealth.get(library.id)?.unreachable) return "library";
    }
    if (resolved && playback.active().some((session) => {
      if (!session.stream.url?.startsWith("file:")) return false;
      try { return isInside(fileURLToPath(session.stream.url), resolved.absolute); } catch { return false; }
    })) return "playback";
    if ((operation.op === "move" || operation.op === "copy") && queue.list().some((job) => job.status === "checking" || job.status === "downloading")) {
      const target = await resolveLibraryPath(store.libraries(), operation.target);
      const writing = await Promise.all(queue.list().filter((job) => job.target && (job.status === "checking" || job.status === "downloading")).map((job) => resolveLibraryPath(store.libraries(), job.target)));
      if (target && writing.some((job) => job && isInside(job.absolute, target.absolute))) return "download";
    }
    return undefined;
  },
  execute: async (operation, item, progress) => {
    // A `reroot` item is a bare name of the old root, not a library path: it is joined onto
    // both roots here, and resolving it as a key would throw before it ever moved.
    if (operation.op === "reroot") {
      libraryOpsWriting = true;
      try {
        const source = path.join(operation.from, item);
        const target = path.join(operation.to, item);
        await transferLibraryPath(source, target, true, progress);
        return { to: toPosix(target) };
      } finally { libraryOpsWriting = false; }
    }
    const resolved = await resolveLibraryPath(store.libraries(), item);
    if (!resolved || !resolved.relative) throw new AppError("Invalid path.", "err.invalidPath");
    libraryOpsWriting = operation.op === "move" || operation.op === "copy" || operation.op === "delete";
    try {
      if (operation.op === "move" || operation.op === "copy") {
        return {
          to: await transferLibraryItem(item, operation.target, operation.op === "copy", progress, operation.confirmTypeMismatch === true),
        };
      }
      if (operation.op === "delete") await deleteLibraryItem(item);
      else if (operation.op === "favorite") await setLibraryFavorite(item, operation.favorite);
      else if (operation.op === "match") await matchLibraryItem({ path: item, type: operation.type, id: operation.id });
      else if (operation.op === "unmatch") await matchLibraryItem({ path: item, type: "movie", id: "" });
      else if (operation.op === "skipLookup") await matchLibraryItem({ path: item, skipLookup: operation.skipLookup });
      else if (operation.op === "mosaic") await matchLibraryItem({ path: item, skipMosaic: !operation.mosaic });
      else if (operation.op === "forget") {
        // A library job, no request: the one account owns the rows it is dropping.
        await updateData(undefined, (data) => {
          data.progress = Object.fromEntries(Object.entries(progressOf(data)).filter(([key, record]) => {
            const stored = key.startsWith("file:") ? key.slice(5) : record.path;
            return !stored || !isPathWithin(stored, resolved.key);
          }));
        });
      } else {
        await clearGeneratedArt(resolved.key);
        const info = await stat(resolved.absolute);
        (info.isDirectory() ? scheduleFolderArtwork : scheduleFileArtwork)(resolved.key);
      }
      invalidateLibrary();
      return {};
    } finally { libraryOpsWriting = false; }
  },
  // The root follows the content, and only once all of it is across: a run that failed or
  // was cancelled left items behind, and those items are still under the old root. This
  // hangs off the job reaching its terminal state, so a job restored from disk after a
  // restart switches the root the same way.
  finished: async (job, operation) => {
    if (operation.op !== "reroot") return;
    if (job.status !== "completed" || job.failed > 0) return;
    await store.update((state) => {
      state.libraries = (state.libraries ?? []).map((library) => library.id === operation.libraryId ? { ...library, root: operation.to } : library);
    });
    invalidateLibrary();
    await refreshLibraryHealth();
    log("INFO", "Library re-rooted, the content came along", {
      library: operation.libraryId, from: operation.from, root: operation.to, items: operation.items.length,
    });
  },
});
await libraryOps.load();

registerLibrariesRoutes(app, { ...routeContext, accountIdOf, grantRows, healthOf, invalidateLibrary, libraryGrants, libraryStats, libraryView, mutateData, progressOf, refreshLibraryHealth, libraryProbe, metaStore, libraryOps });

registerCurateRoutes(app, { ...routeContext, invalidateLibrary, libraryAutoScan, libraryFiles, libraryOps, libraryScan, libraryTarget, libraryUnits, matchLibraryItem, metaStore, ownRecord, ownerOf, prefsOf, refreshLibraryHealth, scheduleMetaBackfill, wirePath });

/** Keep the external address out of the download link by exchanging it for a short-lived ticket. */
app.post("/api/device-download", asyncRoute(async (req, res) => {
  pruneDeviceDownloadTickets();
  let ticket: DeviceDownloadTicket;
  const owner = ownerOf(req);
  const stream = await httpSourceOf(req);
  if (stream.url?.startsWith("file://")) {
    const relative = stream.url.slice(7);
    const target = relative ? await libraryTarget(relative).catch(() => undefined) : undefined;
    const info = target ? await stat(target).catch(() => undefined) : undefined;
    if (!target || !info?.isFile()) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
    ticket = {
      owner, expiresAt: Math.min(owner.expiresAt, Date.now() + DEVICE_TICKET_TTL),
      filename: posixBase(relative),
      source: { kind: "local", path: relative },
    };
  } else {
    if (!stream?.url || stream.url.startsWith("file://")) throw new AppError("Only a direct HTTP stream can be saved to a device.", "err.deviceNeedsHttp");
    await validateRemoteUrl(stream.url);
    const title = String(req.body.title ?? "video");
    const media = mediaSource(req.body.media);
    const addon = store.addons().find((item) => item.key === stream.addonKey);
    const settings = addon?.downloadSettings ?? defaultDownloadSettings();
    const targetSettings = media?.kind === "episode" ? settings.series : settings.movie;
    ticket = {
      owner, expiresAt: Math.min(owner.expiresAt, Date.now() + DEVICE_TICKET_TTL),
      filename: deviceFilename(stream, media, title, targetSettings),
      source: { kind: "remote", stream, title, media },
    };
  }
  const id = randomBytes(24).toString("base64url");
  deviceDownloadTickets.set(id, ticket);
  res.status(201).json({ url: `/api/device-download/${id}`, filename: ticket.filename });
}));

app.get("/api/device-download/:id", asyncRoute(async (req, res) => {
  pruneDeviceDownloadTickets();
  const ticket = deviceDownloadTickets.get(String(req.params.id));
  if (!ticket || ticket.owner.sid !== ownerOf(req).sid) return res.status(404).json({ error: "The download link expired. Start the download again.", messageKey: "err.downloadTicketExpired" });

  res.setHeader("cache-control", "private, no-store");
  trackMedia(ticket.owner, res);
  if (ticket.source.kind === "local") {
    const target = await libraryTarget(ticket.source.path);
    if (!target) return res.status(404).json({ error: "The file was not found in the library.", messageKey: "err.libraryFileMissing" });
    countBytes(res, { source: "library", provider: "knihovna", title: ticket.filename, kind: "other" });
    return void res.download(path.basename(target), ticket.filename, { root: path.dirname(target), acceptRanges: true, dotfiles: "deny" }, (error) => {
      if (error && !res.headersSent) res.status(404).json({ error: "The file was not found in the library.", messageKey: "err.libraryFileMissing" });
    });
  }

  const { stream, title, media } = ticket.source;
  // The client only requests the ticket URL; the server handles debrid headers and ranges from its own IP.
  const headers: Record<string, string> = { ...(stream.behaviorHints?.proxyHeaders?.request ?? {}) };
  if (req.headers.range) headers.range = req.headers.range;

  // A playlist is not the media, it is a list of it. Passed on as-is the browser saves a few
  // hundred bytes of text named like a film -- which is what an HLS addon's download did. The
  // queue already assembles these with FFmpeg; so does this, except that the output goes
  // straight down the response, which cannot be seeked back into. That rules out the index at
  // the front (+faststart) and calls for a fragmented file instead.
  if (isPlaylist(stream.url!)) {
    const { spawn } = await import("node:child_process");
    const { playlistArgs } = await import("./probe.js");
    const headerLines = Object.entries(headers)
      .filter(([name]) => name.toLowerCase() !== "range")
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join("");

    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
      ...(await playlistArgs("ffmpeg")),
      ...(headerLines ? ["-headers", headerLines] : []),
      "-i", stream.url!,
      "-c", "copy",
      // ADTS frames out of a transport stream need this to be legal inside MP4.
      "-bsf:a", "aac_adtstoasc",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof",
      "-f", "mp4", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-2000); });
    res.on("close", () => { if (!res.writableEnded) child.kill("SIGKILL"); });

    countBytes(res, statMeta({ source: "download", url: stream.url, title, addonKey: stream.addonKey, addonName: stream.addonName, kind: media?.kind }));
    // No length is known ahead of an assembly, so the browser shows no progress bar.
    res.status(200).attachment(ticket.filename).setHeader("content-type", "video/mp4");

    child.on("error", () => { if (!res.headersSent) res.status(502).end(); else res.destroy(); });
    child.on("close", (code) => {
      if (code !== 0) log("WARN", "Assembling a playlist for a device failed", { filename: ticket.filename, code, stderr: stderr.slice(-400) });
      if (!res.writableEnded) res.end();
    });
    return void child.stdout!.pipe(res);
  }
  const controller = new AbortController();
  const headerTimeout = setTimeout(() => controller.abort(), 30_000);
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  let upstream: Response;
  try { upstream = await safeFetch(stream.url!, { method: req.method === "HEAD" ? "HEAD" : "GET", headers, signal: controller.signal }); }
  finally { clearTimeout(headerTimeout); }
  if (!upstream.ok) { await upstream.body?.cancel(); throw new Error("Download source unavailable."); }

  countBytes(res, statMeta({ source: "download", url: stream.url, title, addonKey: stream.addonKey, addonName: stream.addonName, kind: media?.kind }));
  res.status(upstream.status).attachment(ticket.filename).setHeader("cache-control", "private, no-store");
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(name); if (value) res.setHeader(name, value);
  }
  if (!upstream.body) return void res.end();
  const { Readable } = await import("node:stream");
  try { await pipeline(Readable.fromWeb(upstream.body as never), res, { signal: controller.signal }); }
  catch (error) { if (!res.destroyed && !res.writableEnded) throw error; }
}));
registerDownloadRoutes(app, { ...routeContext, queue, jobView, sourceOf, mediaSource, posterOf, rememberTitle, titleKey, saveCatalogPoster, libraryKey, cachedMeta, prefsOf });
/** The one flat object the interface reads: the instance's settings and the caller's own. */
const settingsView = (req: express.Request) => ({ ...publicSettings(store.settings()), ...prefsOf(req) });
app.get("/api/settings", (req, res) => res.json(settingsView(req)));
const freeSpace = async (target: string) => {
  try { const info = await statfs(target); return { path: target, freeBytes: info.bavail * info.bsize, totalBytes: info.blocks * info.bsize }; }
  catch { return { path: target }; }
};
registerDiagnosticsRoutes(app, { ...routeContext, stats, playback, throughput, queue, libraryScan, playbackMeta, freeSpace, dataDir: DATA_DIR });

/** The backup file carries both halves of the settings in one flat object, the way the
 *  interface reads them, so an import has to put every key back where it now belongs. The
 *  two halves are spelled out rather than looped over `PERSONAL_SETTINGS`, so a key added
 *  to one of them and forgotten here fails the build. */
const splitSettings = (flat: Settings): { instance: InstanceSettings; prefs: Partial<UserPrefs> } => {
  const {
    uiLanguage, audioLanguage, subtitleLanguage, downloadTitleLanguage,
    mergeByName, streamSort, trackProgress, showResumeRow,
    catalogTileSize, libraryTileSize, catalogTileShape, libraryTileShape,
    ...instance
  } = flat;
  return {
    instance,
    prefs: { uiLanguage, audioLanguage, subtitleLanguage, downloadTitleLanguage, mergeByName, streamSort, trackProgress, showResumeRow, catalogTileSize, libraryTileSize, catalogTileShape, libraryTileShape },
  };
};

app.get("/api/settings/export", asyncRoute(async (req, res) => {
  await metaStore.flush();
  res.setHeader("content-disposition", `attachment; filename=stremio-offline-settings-${new Date().toISOString().slice(0, 10)}.json`);
  res.json(createSettingsBackup({ ...store.settings(), ...prefsOf(req) }, store.addons(), store.libraries()));
}));
app.post("/api/settings/import", asyncRoute(async (req, res) => {
  // The libraries are this instance's, so a rule that names one from somewhere else is
  // remapped before anything is written: by root first, then by name.
  const parsed = remapBackupLibraries(parseSettingsBackup(req.body), store.libraries());
  for (const remap of parsed.remaps) {
    log("INFO", "A save rule named a library this instance does not have", { what: remap.what, addon: remap.addon, from: remap.from, to: remap.to ?? "default" });
  }
  const backup = { ...parsed, libraries: [] };
  // Manifests are loaded before a single write, so a broken backup changes no part of the configuration.
  const loaded = await Promise.all(backup.addons.map(async (saved, index) => {
    try {
      const addon = await loadAddon(saved.manifestUrl, saved.role);
      addon.enabled = saved.enabled;
      addon.globalSearch = saved.globalSearch;
      addon.addedAt = saved.addedAt;
      addon.downloadSettings = saved.downloadSettings;
      return addon;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Addon ${index + 1} could not be loaded: ${reason}`);
    }
  }));
  const identities = new Set<string>();
  for (const addon of loaded) {
    const identity = `${addon.manifest.id}\n${addon.manifestUrl}`;
    if (identities.has(identity)) throw new Error(`The backup holds the addon "${addon.manifest.name}" more than once.`);
    identities.add(identity);
  }
  await store.update((state) => {
    const split = splitSettings(backup.settings);
    state.settings = split.instance;
    state.addons = loaded;
    state.defaultsInstalled = true;
    const userId = accountIdOf(req);
    if (userId) mutateData(state, userId, (data) => { data.prefs = { ...data.prefs, ...split.prefs }; });
  });
  streamCache.clear();
  queue.changed();
  log("INFO", "Settings backup imported", { addons: loaded.length, version: backup.version, remapped: parsed.remaps.length });
  res.json({ settings: settingsView(req), addons: store.addons().map(publicAddon), remapped: parsed.remaps.length });
}));
app.patch("/api/settings", asyncRoute(async (req, res) => {
  let realDebridToken: string | undefined;
  if (req.body.realDebridToken !== undefined) {
    realDebridToken = normalizeToken(req.body.realDebridToken);
    if (realDebridToken) await verifyRealDebridToken(realDebridToken);
  }
  let tmdbApiKey: string | undefined;
  if (req.body.tmdbApiKey !== undefined) {
    tmdbApiKey = String(req.body.tmdbApiKey).trim();
    if (tmdbApiKey) await verifyTmdbKey(tmdbApiKey);
  }
  const languageBefore = prefsOf(req).uiLanguage;
  const userId = accountIdOf(req);
  const touchesPrefs = PERSONAL_SETTINGS.some((key) => req.body[key] !== undefined);
  await store.update((state) => {
    // The body is one flat object; each key goes to the half that owns it. Only the keys the
    // body names are written, so a preference nobody touched keeps the value it had.
    const prefs: Record<string, unknown> = { ...(userId ? state.userData?.[userId]?.prefs : undefined) };
    if (req.body.concurrentDownloads !== undefined) state.settings.concurrentDownloads = Math.max(1, Math.min(8, Number(req.body.concurrentDownloads) || 1));
    if (req.body.parallelPerProvider !== undefined) state.settings.parallelPerProvider = Math.max(1, Math.min(8, Number(req.body.parallelPerProvider) || 1));
    if (req.body.downloadSegments !== undefined) state.settings.downloadSegments = Math.max(1, Math.min(8, Number(req.body.downloadSegments) || 1));
    if (req.body.uiLanguage !== undefined && isUiLanguage(req.body.uiLanguage)) prefs.uiLanguage = req.body.uiLanguage;
    if (req.body.audioLanguage !== undefined) prefs.audioLanguage = normalizeLanguage(String(req.body.audioLanguage)) ?? prefs.audioLanguage;
    if (req.body.subtitleLanguage !== undefined) prefs.subtitleLanguage = normalizeLanguage(String(req.body.subtitleLanguage)) ?? prefs.subtitleLanguage;
    if (req.body.downloadTitleLanguage !== undefined) prefs.downloadTitleLanguage = req.body.downloadTitleLanguage === "ui" ? "ui" : normalizeLanguage(String(req.body.downloadTitleLanguage)) ?? prefs.downloadTitleLanguage;
    if (req.body.mergeByName !== undefined) prefs.mergeByName = Boolean(req.body.mergeByName);
    if (req.body.trackProgress !== undefined) prefs.trackProgress = Boolean(req.body.trackProgress);
    if (req.body.showResumeRow !== undefined) prefs.showResumeRow = Boolean(req.body.showResumeRow);
    if (req.body.libraryAutoScan !== undefined) state.settings.libraryAutoScan = Boolean(req.body.libraryAutoScan);
    if (req.body.libraryScanPauseOnDownload !== undefined) state.settings.libraryScanPauseOnDownload = Boolean(req.body.libraryScanPauseOnDownload);
    // Detail has to be recorded before it can be read: a line the server never wrote is not
    // something the log view can filter back into sight.
    if (req.body.logLevel !== undefined) {
      const wanted = parseLevel(req.body.logLevel);
      state.settings.logLevel = wanted;
      setLevel(wanted ?? parseLevel(process.env.LOG_LEVEL) ?? "INFO");
      log("INFO", "The server log level was changed from the interface", { level: currentLevel(), user: currentUser(req)?.username });
    }
    if (req.body.secureMode !== undefined) state.settings.secureMode = Boolean(req.body.secureMode);
    if (req.body.addonRefreshHours !== undefined) state.settings.addonRefreshHours = normalizeRefreshHours(req.body.addonRefreshHours);
    if (req.body.streamSort !== undefined) {
      const value = String(req.body.streamSort);
      prefs.streamSort = STREAM_SORTS.has(value) ? value : "recommended";
    }
    if (req.body.catalogTileSize !== undefined) {
      const value = String(req.body.catalogTileSize);
      prefs.catalogTileSize = value === "compact" || value === "small" || value === "large" ? value : "medium";
    }
    if (req.body.libraryTileSize !== undefined) {
      const value = String(req.body.libraryTileSize);
      prefs.libraryTileSize = value === "compact" || value === "small" || value === "large" ? value : "medium";
    }
    if (req.body.catalogTileShape !== undefined) {
      prefs.catalogTileShape = String(req.body.catalogTileShape) === "wide" ? "wide" : "poster";
    }
    if (req.body.libraryTileShape !== undefined) {
      prefs.libraryTileShape = String(req.body.libraryTileShape) === "wide" ? "wide" : "poster";
    }
    if (realDebridToken !== undefined) state.settings.realDebridToken = realDebridToken;
    if (tmdbApiKey !== undefined) state.settings.tmdbApiKey = tmdbApiKey;
    if (userId && touchesPrefs) mutateData(state, userId, (data) => { data.prefs = prefs; });
  });
  const languageChanged = prefsOf(req).uiLanguage !== languageBefore;
  if (tmdbApiKey !== undefined || languageChanged) {
    // The metadata cache key cannot see a TMDB key change on its own.
    metaCache.clear();
    clearTrailerCache();
    // The seven-day backfill floor is measured from the last lookup, and neither a new key
    // nor a new language is visible to it. Clearing the stamps is what lets the next browse
    // ask again; needsBackfill then decides on the language, as it already does.
    await metaStore.updateAll((file) => {
      for (const [key, record] of Object.entries(file.meta)) {
        if (!record.backfilledAt) continue;
        const { backfilledAt: _dropped, ...rest } = record;
        file.meta[key] = rest;
      }
    });
    invalidateLibrary();
  }
  queue.changed(); res.json(settingsView(req));
}));
app.get("/api/languages", (_req, res) => res.json(Object.entries(LANGUAGE_NAMES).map(([code, name]) => ({ code, name }))));
app.post("/api/inspect", asyncRoute(async (req, res) => {
  const stream = await httpSourceOf(req);
  const info = await playback.inspect(stream);
  res.setHeader("cache-control", "private, no-store").json(safeInspection(info, stream));
}));
app.post("/api/playback", asyncRoute(async (req, res) => {
  const settings = prefsOf(req);
  const options: PlaybackOptions = { audioLanguage: settings.audioLanguage, subtitleLanguage: settings.subtitleLanguage };
  if (req.body.audioLanguage !== undefined) options.audioLanguage = normalizeLanguage(String(req.body.audioLanguage)) ?? settings.audioLanguage;
  if (req.body.subtitleLanguage !== undefined) {
    if (req.body.subtitleLanguage === null) options.subtitleTrack = null;
    else options.subtitleLanguage = normalizeLanguage(String(req.body.subtitleLanguage)) ?? settings.subtitleLanguage;
  }
  if (req.body.audioTrack !== undefined) options.audioTrack = Number(req.body.audioTrack);
  if (req.body.subtitleTrack !== undefined) options.subtitleTrack = req.body.subtitleTrack === null ? null : Number(req.body.subtitleTrack);
  if (req.body.time !== undefined) options.startTime = Math.max(0, Number(req.body.time) || 0);
  if (req.body.quality !== undefined) options.quality = req.body.quality === null ? null : Number(req.body.quality);
  const owner = ownerOf(req);
  const prepared = mediaResources.mediaStream(await httpSourceOf(req), owner);
  let started;
  const subtitleIds: Record<string, string> = {};
  try {
    if (req.body.subtitleIds !== undefined && (!Array.isArray(req.body.subtitleIds) || req.body.subtitleIds.length > 100)) throw new ResourceError(400, "INVALID_SUBTITLES");
    for (const id of req.body.subtitleIds ?? []) {
      if (typeof id !== "string") throw new ResourceError(400, "INVALID_SUBTITLES");
      const subtitle = mediaResources.get(id, owner.sid, "subtitle");
      subtitleIds[id] = mediaResources.add(subtitle.stream, owner, "subtitle", prepared.resourceId);
    }
    started = await playback.start(prepared.stream, req.body.capabilities as ClientCapabilities, options);
    if (currentSession(req)?.sid !== owner.sid) {
      await playback.stop(started.id);
      throw new ResourceError(401, "AUTH_REQUIRED");
    }
    playbackOwners.set(started.id, { owner, resourceId: prepared.resourceId });
    if (req.body.capabilities?.airplay === true) airplayAccess.create(started.id, owner, prepared.resourceId);
  } catch (error) { mediaResources.remove(prepared.resourceId); throw error; }
  // Bytes are counted by the proxy or by the library; only the item itself is added here,
  // so that "how much there was" is not limited to downloads.
  void stats.complete(playbackMeta(prepared.stream));
  res.status(201).setHeader("cache-control", "private, no-store").json({ ...playbackResponse(started), subtitleIds });
}));
app.use("/api/playback/:id", (req, res, next) => {
  const owned = playbackOwners.get(String(req.params.id));
  if (!owned || owned.owner.sid !== (airplayRequest(req)?.owner.sid ?? currentSession(req)?.sid)) return res.status(404).json({ error: "Playback session unavailable.", code: "RESOURCE_NOT_FOUND" });
  res.setHeader("cache-control", "private, no-store");
  playback.attended(String(req.params.id));
  next();
});
app.get("/api/playback/:id/preview", asyncRoute(async (req, res) => {
  const controller = new AbortController();
  res.once("close", () => { if (!res.writableEnded) controller.abort(); });
  const image = await playback.preview(String(req.params.id), Number(req.query.time), controller.signal);
  if (res.destroyed) return;
  if (!image) return void res.status(204).end();
  res.type("image/jpeg").setHeader("cache-control", "private, no-store").send(image);
}));
app.post("/api/playback/:id/ping", (_req, res) => res.status(204).end());
app.post("/api/playback/:id/seek", asyncRoute(async (req, res) => res.json(playbackResponse(await playback.seek(String(req.params.id), Number(req.body.time) || 0)))));
app.post("/api/playback/:id/escalate", asyncRoute(async (req, res) => res.json(playbackResponse(await playback.escalate(String(req.params.id), Number(req.body.time) || 0)))));
app.post("/api/playback/:id/track", asyncRoute(async (req, res) => res.json(playbackResponse(await playback.track(String(req.params.id), {
  audio: req.body.audio === undefined ? undefined : Number(req.body.audio),
  subtitle: req.body.subtitle === undefined ? undefined : (req.body.subtitle === null ? null : Number(req.body.subtitle)),
  quality: req.body.quality === undefined ? undefined : (req.body.quality === null ? null : Number(req.body.quality)),
  time: Number(req.body.time) || 0,
})))));
app.delete("/api/playback/:id", asyncRoute(async (req, res) => {
  // Who closed a session is the difference between a viewer leaving and the server giving up.
  log("INFO", "Playback session closed by the player", { id: String(req.params.id), user: currentUser(req)?.username });
  await playback.stop(String(req.params.id));
  res.status(204).end();
}));
app.get("/api/playback/:id/sidecar.vtt", asyncRoute(async (req, res) => {
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const requestedPosition = Number(req.query.position);
  const position = Number.isFinite(requestedPosition) ? Math.max(offset, requestedPosition) : null;
  const cues = await playback.sidecar(
    String(req.params.id),
    typeof req.query.revision === "string" ? req.query.revision : undefined,
    offset,
    subtitleDelay(req.query.delay),
    position,
  );
  if (!cues) return res.status(404).end();
  // Until the reader has the whole track the player keeps asking, so it is told which it has.
  // How far the cues reach: the player re-reads before the picture catches up with them.
  res.type("text/vtt; charset=utf-8").setHeader("cache-control", "private, no-store")
    .setHeader("x-sidecar-complete", cues.complete ? "1" : "0")
    .setHeader("x-sidecar-coverage", Number.isFinite(cues.coverage) ? String(Math.round(cues.coverage)) : "")
    .send(cues.text);
}));
app.get("/api/playback/:id/:generation/:file", asyncRoute(async (req, res) => {
  const directory = playback.directory(String(req.params.id), String(req.params.generation));
  // After a transcode restart the client asks for the old generation for a while; a 404 is fine
  // for that, but repeated 404s on a live session mean playback has fallen apart.
  if (!directory) { log("DEBUG", "Segment from an unknown session or generation", { req: req.id, id: req.params.id, generation: req.params.generation, file: req.params.file }); return res.status(404).end(); }
  const file = String(req.params.file);
  const grant = airplayRequest(req);
  const receiverPlaylist = (text: string) => grant ? rewritePlaylist(text, (uri) => {
    if (!/^[A-Za-z0-9_-]{1,64}\.(m3u8|mp4|m4s|vtt)$/.test(uri)) throw new Error("Unsupported AirPlay playlist resource.");
    return airplayAccess.url(grant.playbackId, uri);
  }) : text;
  // With no slashes and no dots the name cannot escape the session directory.
  if (!/^[A-Za-z0-9_-]{1,64}\.(m3u8|mp4|m4s|vtt)$/.test(file)) return res.status(400).end();
  if (file === "master.m3u8") {
    // FFmpeg writes the variant line only when it exits, so while it runs the master playlist
    // is just a header and hls.js fails on it with manifestParsingError. We assemble it ourselves.
    // FFmpeg also writes HEVC as hvc1.1.4.L120.B01, while browsers accept only the B0 form and
    // would refuse the stream before trying it; with no attribute they read the codecs from the init segment.
    const playlist = await readFile(path.join(directory, file), "utf8").catch(() => "");
    if (playlist.includes("#EXT-X-STREAM-INF")) {
      return void res.type("application/vnd.apple.mpegurl").setHeader("cache-control", "private, no-store")
        .send(receiverPlaylist(playlist.replace(/CODECS="[^"]*"/g, "").replace(/:,+/g, ":").replace(/,{2,}/g, ",").replace(/,\s*$/gm, "")));
    }
    const hasSubtitles = await readFile(path.join(directory, "index-0_vtt.m3u8"), "utf8").then(() => true, () => false);
    const lines = ["#EXTM3U", "#EXT-X-VERSION:7"];
    if (hasSubtitles) lines.push('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Titulky",DEFAULT=YES,AUTOSELECT=YES,URI="index-0_vtt.m3u8"');
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=8000000${hasSubtitles ? ',SUBTITLES="subs"' : ""}`, "index-0.m3u8");
    return void res.type("application/vnd.apple.mpegurl").setHeader("cache-control", "private, no-store").send(receiverPlaylist(`${lines.join("\n")}\n`));
  }
  if (file.endsWith(".m3u8")) {
    res.type("application/vnd.apple.mpegurl").setHeader("cache-control", "private, no-store");
    if (grant) {
      const playlist = await readFile(path.join(directory, file), "utf8").catch(() => undefined);
      return void (playlist === undefined ? res.status(404).end() : res.send(receiverPlaylist(playlist)));
    }
  }
  else { if (file.endsWith(".vtt")) res.type("text/vtt; charset=utf-8"); res.setHeader("cache-control", "private, no-store"); }
  res.sendFile(file, { root: directory, dotfiles: "deny" }, (error) => { if (error && !res.headersSent) res.status(404).end(); });
}));

app.get(["/api/media/:resourceId", "/api/media/:resourceId/u/:signed"], asyncRoute(async (req, res) => {
  res.setHeader("cache-control", "private, no-store");
  if ("url" in req.query || "headers" in req.query) throw new ResourceError(400, "UNSAFE_SOURCE_INPUT");
  const internal = internalMediaRequest(req);
  const grant = airplayRequest(req);
  const resource = mediaResources.get(String(req.params.resourceId), grant?.owner.sid ?? currentSession(req)?.sid, "media", internal);
  trackMedia(grant ? { ...resource.owner, expiresAt: grant.expiresAt } : resource.owner, res, resource.parent ?? resource.id);
  let stream = resource.stream;
  if (typeof req.params.signed === "string") {
    const url = openMediaUrl(resource.id, req.params.signed);
    if (!url) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
    const child = new URL(url);
    if (!["http:", "https:"].includes(child.protocol) || child.username || child.password) throw new Error("Unsupported playlist resource.");
    const headers = redirectedHeaders(stream.behaviorHints?.proxyHeaders?.request ?? {}, new URL(stream.url!), child);
    stream = { ...stream, url: child.toString(), behaviorHints: { ...stream.behaviorHints, proxyHeaders: { request: Object.fromEntries(headers) } } };
  }
  const raw = stream.url!;
  const ownedSession = [...playbackOwners].find(([, value]) => value.resourceId === (resource.parent ?? resource.id))?.[0];
  if (ownedSession) {
    playback.touch(ownedSession);
    const heartbeat = setInterval(() => playback.touch(ownedSession), 30_000);
    res.once("close", () => clearInterval(heartbeat));
  }
  if (raw.startsWith("file://")) {
    const relative = raw.slice(7);
    const target = await libraryTarget(relative);
    countBytes(res, { source: "library", provider: "knihovna", title: path.basename(relative), kind: "other" }, ownedSession);
    return void res.sendFile(path.basename(target), { root: path.dirname(target), acceptRanges: true, dotfiles: "deny" }, (error) => {
      if (error && !res.headersSent) res.status(404).end();
    });
  }
  await validateRemoteUrl(raw);
  countBytes(res, playbackMeta(stream), ownedSession);
  const cacheKey = `${resource.parent ?? resource.id}:${typeof req.params.signed === "string" ? req.params.signed : ""}`;
  const askedRange = String(req.headers.range ?? "");
  const held = req.method === "HEAD" ? undefined : rangeCache.get(cacheKey, askedRange);
  let alreadySent = 0;
  if (held) {
    // A reader that opens a film reads its header and stops; what it needs is here, and the
    // source hears nothing. Only a reader that keeps going is handed on to it, from where this
    // leaves off.
    res.status(held.status);
    for (const [name, value] of Object.entries(held.headers)) res.setHeader(name, value);
    if (!res.write(held.bytes)) await once(res, "drain");
    alreadySent = held.bytes.length;
    log("DEBUG", "Served a read the source had already answered", { req: req.id, range: askedRange || "whole file", bytes: alreadySent, whole: held.complete });
    if (held.complete) return void res.end();
    // The moment's grace is what tells a header probe from a reader that wants the film.
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (res.destroyed || res.writableEnded) return;
  }
  const headers: Record<string, string> = { ...stream.behaviorHints?.proxyHeaders?.request };
  if (req.headers.range) headers.range = req.headers.range;
  // Handed on from where the cached start left off, so the source is asked only for the rest.
  if (alreadySent) headers.range = `bytes=${Number(/bytes=(\d*)-/.exec(askedRange)?.[1] || 0) + alreadySent}-${/bytes=\d*-(\d+)/.exec(askedRange)?.[1] ?? ""}`;
  const controller = new AbortController();
  let headerTimedOut = false;
  const quiet = sourceIsQuiet(resource.parent ?? resource.id);
  const headerTimeout = setTimeout(() => { headerTimedOut = true; controller.abort(); }, quiet ? SOURCE_QUIET_HEADER_MS : SOURCE_HEADER_MS);
  // Seek and stop close the previous Range. Without aborting here the old
  // upstream keeps downloading from the debrid host and starves the new one.
  //
  // `!res.writableEnded` is the whole point: this fires for a response that was cut, not one
  // that finished. Whoever tears a transfer down must therefore destroy it. `res.end()` sets
  // `writableEnded`, the abort never runs, and the source reads on until it times out -- which
  // shows up as a seek that buffers forever under load, not as an error anyone can find.
  // Callers that rely on this: the PlaybackManager release hook, and stopOwnedPlayback.
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  // These hosts drop a connection now and then, on a range deep into a large file as
  // readily as on the first byte. Handing that straight to FFmpeg ends the conversion and
  // the viewer's seek with it, so a dropped request is asked again before it is given up on.
  let upstream: Response;
  for (let attempt = 1; ; attempt += 1) {
    try { upstream = await safeFetch(raw, { method: req.method === "HEAD" ? "HEAD" : "GET", headers, signal: controller.signal }); break; }
    catch (error) {
      if (res.destroyed || res.writableEnded) {
        clearTimeout(headerTimeout);
        log("DEBUG", "The client closed the transfer", { req: req.id, url: raw, range: req.headers.range });
        return;
      }
      const reason = headerTimedOut ? "no response within 30 s" : (error instanceof Error ? error.message : String(error));
      // A timeout or a viewer who left is not worth repeating; a dropped connection is.
      if (attempt >= (quiet ? 1 : SOURCE_ATTEMPTS) || headerTimedOut || controller.signal.aborted) {
        clearTimeout(headerTimeout);
        noteSourceQuiet(resource.parent ?? resource.id);
        log("WARN", "The source did not respond", { req: req.id, url: raw, range: req.headers.range, reason, attempts: attempt, quiet });
        throw error;
      }
      log("WARN", "The source dropped the request, asking again", { req: req.id, url: raw, range: req.headers.range, reason, attempt });
      await sleep(SOURCE_RETRY_MS * attempt);
    }
  }
  clearTimeout(headerTimeout);
  // It answered, so it is not the host that has stopped talking to us.
  quietSources.delete(resource.parent ?? resource.id);
  if (res.destroyed || res.writableEnded) {
    await upstream.body?.cancel().catch(() => undefined);
    return;
  }
  if (upstream.status >= 400) log("WARN", "The source refused the request", { req: req.id, url: raw, status: upstream.status, range: req.headers.range });
  if (![200, 206].includes(upstream.status)) {
    await upstream.body?.cancel().catch(() => undefined);
    if (upstream.status === 416) {
      const range = upstream.headers.get("content-range");
      if (range && /^bytes \*\/\d+$/.test(range)) res.setHeader("content-range", range);
      return void res.status(416).end();
    }
    return void res.status(502).json({ error: "Media source request failed." });
  }
  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("dash+xml") || new URL(upstream.url).pathname.toLowerCase().endsWith(".mpd")) {
    await upstream.body?.cancel();
    throw new Error("DASH playlists are not supported by the media proxy.");
  }
  if (req.method !== "HEAD" && (contentType.includes("mpegurl") || new URL(upstream.url).pathname.toLowerCase().endsWith(".m3u8"))) {
    const proxied = (value: string) => {
      const child = new URL(value, upstream.url);
      if (!["http:", "https:"].includes(child.protocol) || child.username || child.password) throw new Error("Unsupported playlist resource.");
      const path = mediaChildPath(resource.parent ?? resource.id, child.toString());
      const url = `${path}${internal ? `?token=${INTERNAL_TOKEN}` : ""}`;
      return grant ? airplayAccess.url(grant.playbackId, url) : url;
    };
    const playlist = rewritePlaylist(await readMediaText(upstream), proxied, (text) => safeSourceText(text, stream) ?? "");
    if (res.destroyed || res.writableEnded) return;
    res.status(upstream.status).type("application/vnd.apple.mpegurl").setHeader("cache-control", "private, no-store").send(playlist);
    return;
  }
  if (!alreadySent) {
    res.status(upstream.status);
    for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) { const value = upstream.headers.get(name); if (value) res.setHeader(name, value); }
  }
  if (!upstream.body) return res.end();
  const { Readable } = await import("node:stream");
  // These hosts hand over a few seconds and then cut the stream. FFmpeg answers that by
  // reconnecting on its own -- another connection into a host that is counting them, and one
  // it usually refuses. The transfer is picked up here instead, from the byte it stopped at,
  // so what FFmpeg reads is one unbroken response.
  const asked = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  const from = Number(asked?.[1] || 0) + alreadySent;
  const until = asked?.[2] ? Number(asked[2]) : undefined;
  const expected = Number(upstream.headers.get("content-length") ?? "") || undefined;
  let delivered = 0;
  // Worth keeping only while it is still short: a longer read is the picture going by.
  let keep: Buffer[] | undefined = req.method === "GET" ? [] : undefined;
  let kept = 0;
  let body: ReadableStream | null = upstream.body;
  for (let resumed = 0; ; ) {
    let broke: unknown;
    try {
      for await (const chunk of Readable.fromWeb(body as never)) {
        // Never more than was asked for: a source picking the transfer up runs to the end of the
        // file, and a body longer than the length already promised breaks the response itself.
        const piece = expected === undefined ? chunk as Buffer : (chunk as Buffer).subarray(0, expected - delivered);
        delivered += piece.length;
        if (keep) {
          kept += piece.length;
          if (kept > rangeCache.limit) keep = undefined; else keep.push(Buffer.from(piece));
        }
        if (piece.length && !res.write(piece)) await once(res, "drain");
        if (expected !== undefined && delivered >= expected) break;
      }
    } catch (error) { broke = error; }
    if (res.destroyed || res.writableEnded || controller.signal.aborted) {
      // What it read before it left is what the next one will ask for first.
      if (keep && !alreadySent && delivered) {
        rangeCache.put(cacheKey, askedRange, { status: upstream.status, headers: answerHeaders(upstream), bytes: Buffer.concat(keep), complete: false });
      }
      log("DEBUG", "The client closed the transfer", { req: req.id, url: raw, range: req.headers.range });
      return;
    }
    const short = expected !== undefined && delivered < expected;
    if (!broke && !short) {
      if (keep && !alreadySent && expected !== undefined && delivered === expected) {
        rangeCache.put(cacheKey, askedRange, { status: upstream.status, headers: answerHeaders(upstream), bytes: Buffer.concat(keep), complete: true });
      }
      break;
    }
    if (resumed >= SOURCE_RESUMES || expected === undefined || !short) {
      noteSourceQuiet(resource.parent ?? resource.id);
      log("WARN", "The transfer from the source broke off", {
        req: req.id, url: raw, range: req.headers.range, delivered, expected, resumed,
        reason: broke instanceof Error ? broke.message : broke === undefined ? "it ended early" : String(broke),
      });
      throw broke ?? new Error("The source ended the transfer early.");
    }
    resumed += 1;
    log("WARN", "The transfer broke off, picking it up where it stopped", { req: req.id, url: raw, at: from + delivered, delivered, expected, resumed });
    await sleep(SOURCE_RETRY_MS * resumed);
    const resumeRange = `bytes=${from + delivered}-${until !== undefined ? until : ""}`;
    const next = await safeFetch(raw, { headers: { ...headers, range: resumeRange }, signal: controller.signal }).catch(() => undefined);
    if (!next || ![200, 206].includes(next.status) || !next.body) {
      await next?.body?.cancel().catch(() => undefined);
      noteSourceQuiet(resource.parent ?? resource.id);
      log("WARN", "The source would not pick the transfer up", { req: req.id, url: raw, at: from + delivered, status: next?.status });
      throw broke ?? new Error("The source ended the transfer early.");
    }
    body = next.body;
  }
  res.end();
}));

app.all(["/api/proxy", "/api/subtitle", "/api/library/file"], (_req, res) => {
  res.status(410).setHeader("cache-control", "private, no-store").json({ error: "This media API has been retired.", code: "UNSAFE_SOURCE_INPUT" });
});

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
app.use(express.static(webRoot, { setHeaders: (res, file) => { if (file.endsWith("index.html")) res.setHeader("Cache-Control", "no-store"); } }));
app.get("/{*path}", (_req, res) => { res.setHeader("Cache-Control", "no-store"); res.sendFile(path.join(webRoot, "index.html")); });
app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // The 400 default is deliberate: the interface treats anything but a 401 the same way,
  // and changing that now would be a behaviour change, not a diagnostic one.
  const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RestrictedError || messageKeyOf(error) === "err.restricted") {
    log("INFO", "Rejected a restricted-mode mutation", {
      req: req.id, method: req.method, path: req.path, status: 403, user: currentUser(req)?.username,
    });
  } else if (error instanceof ResourceError && error.status === 410 && /^(?:\/api)?\/media\//.test(req.path)) {
    // A player that has just been closed is still reading the ranges it had open. The
    // session is gone, the answer is correct, and it is not a fault worth an ERROR.
    log("DEBUG", "A closed session was still being read", { req: req.id, path: req.path, user: currentUser(req)?.username });
  } else {
    log("ERROR", "Request failed", {
      req: req.id, method: req.method, path: req.path, status,
      user: currentUser(req)?.username, reason: message,
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
  const mediaRoute = /^(?:\/api)?\/(?:media|playback|inspect|streams|subtitle|subtitles|device-download|library\/source)(?:\/|$)/.test(req.path);
  const hideDetails = mediaRoute && !(error instanceof ResourceError) && status >= 500;
  const vars = error instanceof AppError ? error.vars : undefined;
  res.status(hideDetails ? 502 : status).json({
    error: hideDetails ? "Media source request failed." : message,
    code: error instanceof ResourceError ? error.code : undefined,
    messageKey: hideDetails ? undefined : messageKeyOf(error),
    ...(vars ? { vars } : {}),
  });
});
process.on("unhandledRejection", (reason) => {
  log("ERROR", "Unhandled promise rejection", { reason: reason instanceof Error ? reason.stack ?? reason.message : String(reason) });
});
// A source that closes its connection in an unusual way can trip an assertion deep inside
// Node's own HTTP client (undici), asynchronously, after our download loop's try/catch has
// already returned control -- so nothing in this codebase can catch it directly. Without this
// handler that one bad response takes the whole server down: every active download, every open
// playback session, the web UI itself, until Docker restarts the container. A single flaky
// source shouldn't cost everyone else their evening.
process.on("uncaughtException", (error) => {
  log("ERROR", "Unhandled exception, the server keeps running", { reason: error instanceof Error ? error.stack ?? error.message : String(error) });
});
const port = Number(process.env.PORT ?? 8080);
app.listen(port, "0.0.0.0", () => { markServerReady(); log("INFO", "Stremio Offline is listening", { port }); });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    log("INFO", "Shutting down", { signal });
    void Promise.allSettled([images.flush(), artworks.flush(), metaStore.flush(), libraryOps.flush()]).then(flushLog).finally(() => process.exit(0));
  });
}
