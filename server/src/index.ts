import express from "express";
import { once } from "node:events";
import { RangeCache } from "./range-cache.js";
import { nextVideoFile } from "./next-file.js";
import { isInternalMediaPath, mediaChildPath, mediaResources, openMediaUrl, ResourceError, safeSourceText, type ResourceOwner } from "./media-resources.js";
import { readMediaText, rewritePlaylist } from "./media-playlist.js";
import { AirPlayAccess } from "./airplay-access.js";
import { shiftVtt } from "./vtt.js";
import path from "node:path";
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, realpath, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { loadAddon, catalog, metadata, searchAll, searchableCatalogs, streamCandidates, streams, subtitles } from "./addons.js";
import { autoRefreshEnabled, manifestChanged, normalizeRefreshHours, refreshDue, refreshManifests, type RefreshOutcome } from "./addon-refresh.js";
import { rankStreams, titleLanguage } from "./ranking.js";
import { DownloadQueue, isPlaylist, type DownloadSelection, type SubtitleMode } from "./downloads.js";
import { selectDownloadSource } from "./download-selection.js";
import { StatsLog, type TrafficEvent, type TrafficMeta } from "./stats.js";
import { Throughput } from "./throughput.js";
import { build } from "./build.js";
import { PlaybackManager, sourceTitle } from "./playback.js";
import { essentialAddon, publicAddon, publicAddonRestricted, redirectedHeaders, safeFetch, validateRemoteUrl } from "./security.js";
import { RestrictedError, logoutDenied, restrictedMiddleware, restrictedMode } from "./restricted.js";
import { guardedFetch, outbound } from "./outbound.js";
import { images } from "./images.js";
import { configureSecureMode, secureMode, securityHeaders } from "./secure.js";
import { publicSettings, Store } from "./store.js";
import { advanceTorrent, normalizeToken, verifyRealDebridToken } from "./debrid.js";
import { clearLog, currentLevel, flushLog, initLogger, log, parseLevel, readLog, startLogMaintenance, setLevel } from "./logger.js";
import { browseDirectory, describePath, emptiedFolders, entryDirectory, isPathWithin, isVideo, listFolders, listVideos, moveDestination, orphanedCatalogKeys, pageFiles, remapPath, scanLibrary, sortFiles, summarize, type FoundFile, type LibraryEntry, type WalkBudget } from "./library.js";
import { browseMeta, cacheFieldsFromMeta, episodeKey, episodeNumberOf, episodesFromMeta, dropKeyed, knownTitleEntry, knownTitleOf, lookupSkipped, matchKeyFor, matchStatus, needsBackfill, needsEpisodes, scanMiss, suggestionFor, titleUnits, unmatchAt, type LibraryMetaRecord, type TitleKind, type TitleUnit } from "./library-match.js";
import { parseMediaPath } from "./library-parse.js";
import { LibraryScan } from "./library-scan.js";
import { createLibraryProbe, type LibraryHealth } from "./library-probe.js";
import { LibraryAutoScan } from "./library-autoscan.js";
import { watchLibrary } from "./library-watch.js";
import { ArtworkQueue, artworkBesideMedia, episodeArtName, fileMayUseFolderArtwork, findArtwork, framePosition, POSTER_OUTPUT, savePosterAs, saveFrame, type PosterOutcome } from "./artwork.js";
import { clearedCookie, createSession, DECOY_HASH, LoginThrottle, pruneRevoked, envCredentials, hashPassword, INTERNAL_TOKEN, parseCookies, readSession, secretEquals, REMEMBER_DAYS, SESSION_COOKIE, sessionCookie, verifyPassword } from "./auth.js";
import { randomBytes, randomUUID } from "node:crypto";
import type { ClientCapabilities, PlaybackOptions } from "./playback.js";
import type { MediaInfo } from "./naming.js";
import { defaultDownloadSettings, deviceFilename, normalizeDownloadSettings, safeName } from "./naming.js";
import { LANGUAGE_NAMES, isUiLanguage, normalizeLanguage } from "./language.js";
import { AppError, messageKeyOf } from "./errors.js";
import { activeDeparted, carveOuts, queuedArtworkKey, defaultLibrary, DEPARTED_MAX, departedIdFor, isInside, libraryFor, libraryPath, newLibraryId, parseLibraryPath, posixBase, posixDir, posixJoin, realAncestor, relativeWithin, resolveLibraryPath, sameFile, toFs, toPosix, type LibraryRecord, type LibraryType, type RootGrant } from "./libraries.js";
import { envGrants, grantView, grantingRoot, insideGrant, mergeGrants } from "./library-grants.js";
import { asLibraryType, checkLibraryRoot, libraryFlag } from "./library-admin.js";
import { migrateStateFile } from "./library-migrate.js";
import { LibraryMetaStore } from "./library-meta-store.js";
import { artworks } from "./artwork-cache.js";
import type { AddonRecord, AddonRole, MetaItem, StreamItem } from "./types.js";
import { createSettingsBackup, parseSettingsBackup, remapBackupLibraries } from "./backup.js";
import { LibraryOps, type LibraryOp } from "./library-ops.js";
import { transferLibraryPath, type TransferProgress } from "./library-transfer.js";

const STREAM_SORTS = new Set(["recommended", "size-desc", "size-asc", "addon"]);
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? "/downloads";
// Before anything reads the state: a v1 file gains its library and qualified keys.
const libraryMigration = await migrateStateFile(DATA_DIR, DOWNLOAD_DIR);
const app = express(); const store = new Store(DATA_DIR, DOWNLOAD_DIR);
/** The match history, kept per library instead of inside `state.json`. */
const metaStore = new LibraryMetaStore(DATA_DIR);
let markServerReady!: () => void;
const serverReady = new Promise<void>((resolve) => { markServerReady = resolve; });
await store.load();
await metaStore.load();
if (libraryMigration.migrated) log("INFO", "State migrated to libraries", { libraryId: libraryMigration.libraryId, paths: libraryMigration.paths, artwork: libraryMigration.artwork });
if (libraryMigration.metadata) log("INFO", "Library metadata moved out of the state", { rows: libraryMigration.metadata });
if (libraryMigration.artworkSetting) log("INFO", "The global artwork location was retired", { libraries: libraryMigration.artworkSetting });
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
    mediaResources.remove(owned.resourceId);
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
  const ranked = rankStreams(candidates, store.settings().audioLanguage, priority);
  const next = ranked.find((stream) => !source.tried.includes(stream.url!));
  if (!next) return undefined;
  const addon = store.addons().find((item) => item.key === next.addonKey);
  return { stream: next, settings: addon?.downloadSettings ?? defaultDownloadSettings() };
});
await playback.load();

// A default password would have to go straight away, so none is created: the first
// boot ends on the screen where the user creates the account. Installs still running
// on admin/admin lose it and go through the same setup.
if (store.auth()?.isDefault) {
  await store.update((state) => { state.auth = undefined; });
  log("WARN", "The default admin/admin sign-in was removed, create your own account on the next visit");
}
/** With no stored account and no fallback credentials from the environment, nothing can be done. */
const needsSetup = () => !store.auth() && !envCredentials();

const secret = () => store.auth()?.secret ?? "";
const isSecure = (req: express.Request) => req.headers["x-forwarded-proto"] === "https" || req.protocol === "https";
const knownUser = (name: string) => name === store.auth()?.username || name === envCredentials()?.username;
const currentSession = (req: express.Request) => {
  // With no account there is nothing to sign with, so no token can be valid.
  if (!store.auth()) return undefined;
  const info = readSession(secret(), parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  if (!info || !knownUser(info.username)) return undefined;
  // A signed-out session is invalid even with a signature that still verifies.
  return store.auth()?.revoked?.[info.sid] ? undefined : info;
};
const currentUser = (req: express.Request) => currentSession(req)?.username;

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
const airplayRequest = (req: express.Request) => airplayAccess.authorize(req.method, req.originalUrl.split("?")[0], req.query.airplay);
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
  if (!real) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
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

const asyncRoute = (fn: express.RequestHandler) => (req: express.Request, res: express.Response, next: express.NextFunction) => Promise.resolve(fn(req, res, next)).catch(next);

// Without a sign-in only the server status and the sign-in itself are open. /api/proxy
// especially must not be public, or anyone could pull foreign addresses through this server.
const OPEN_PATHS = new Set(["/status", "/auth/login", "/auth/me", "/auth/setup"]);
app.use("/api", (req, res, next) => {
  if (OPEN_PATHS.has(req.path)) return next();
  if (internalMediaRequest(req) || airplayRequest(req)) return next();
  if (!currentUser(req)) return res.status(401).json({ error: "Not signed in.", messageKey: "err.notSignedIn" });
  next();
});
app.use("/api", restrictedMiddleware({
  isOpen: (req) => OPEN_PATHS.has(req.path),
  isInternal: (req) => internalMediaRequest(req) || Boolean(airplayRequest(req)),
}));

setInterval(() => {
  for (const active of activeMedia) if (active.owner.expiresAt <= Date.now()) active.res.destroy();
  for (const [id, owned] of playbackOwners) if (owned.owner.expiresAt <= Date.now()) void playback.stop(id);
}, 1000).unref();

app.get("/api/auth/me", (req, res) => {
  // The language rides along on the one call the sign-in and setup screens can make
  // unauthenticated; without it they would render before knowing which one to use.
  const language = store.settings().uiLanguage;
  if (needsSetup()) return res.json({ setup: true, language });
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Not signed in.", messageKey: "err.notSignedIn", language });
  res.json({ username: user, language });
});

/** First-run account setup. Available only until an account exists. */
app.post("/api/auth/setup", asyncRoute(async (req, res) => {
  if (!needsSetup()) throw new AppError("An account already exists.", "err.setupDone");
  const username = String(req.body.username ?? "").trim();
  const password = String(req.body.password ?? "");
  if (username.length < 3) throw new AppError("The username needs at least 3 characters.", "auth.usernameTooShort");
  if (password.length < 6) throw new AppError("The password needs at least 6 characters.", "auth.passwordTooShort");
  const language = isUiLanguage(req.body.language) ? req.body.language : undefined;
  const passwordHash = await hashPassword(password);
  const nextSecret = randomBytes(32).toString("hex");
  await store.update((state) => {
    state.auth = { username, passwordHash, secret: nextSecret, isDefault: false, revoked: {} };
    // The first-run language choice is also the best guess at which audio and
    // subtitles this household wants. Both stay editable in Settings afterwards.
    // A client that sends no language leaves the interface where it is, and the
    // tracks still follow it -- otherwise they would keep the English default.
    const chosen = language ?? state.settings.uiLanguage;
    state.settings = { ...state.settings, uiLanguage: chosen, audioLanguage: chosen, subtitleLanguage: chosen };
  });
  res.setHeader("set-cookie", sessionCookie(createSession(nextSecret, username, Date.now() + REMEMBER_DAYS * 24 * 60 * 60 * 1000), true, isSecure(req)));
  log("INFO", "Account created on first run", { username, language });
  res.status(201).json({ username, language: store.settings().uiLanguage });
}));
const logins = new LoginThrottle();
app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const username = String(req.body.username ?? "");
  const password = String(req.body.password ?? "");
  const remember = Boolean(req.body.remember);
  const from = req.ip ?? "unknown";
  const wait = logins.retryAfterMs(from);
  if (wait > 0) {
    const seconds = Math.ceil(wait / 1000);
    log("WARN", "Sign-in refused after repeated failures", { username, from, waitSeconds: seconds });
    res.setHeader("retry-after", String(seconds));
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${seconds} s.`, messageKey: "err.tooManyAttempts", vars: { seconds } });
  }
  const stored = store.auth();
  const fromEnv = envCredentials();
  // The hash is always computed, even for a name nobody has: a short circuit here
  // would answer an unknown name faster and hand out the list of real ones.
  const passwordMatches = await verifyPassword(password, stored?.passwordHash ?? DECOY_HASH);
  const bySettings = passwordMatches && Boolean(stored) && secretEquals(username, stored?.username ?? "");
  const byEnv = Boolean(fromEnv) && secretEquals(username, fromEnv?.username ?? "") && secretEquals(password, fromEnv?.password ?? "");
  if (!bySettings && !byEnv) {
    logins.fail(from);
    log("WARN", "Failed sign-in", { username, from });
    return res.status(401).json({ error: "Wrong username or password.", messageKey: "err.badCredentials" });
  }
  logins.succeed(from);
  const expiresAt = Date.now() + (remember ? REMEMBER_DAYS : 1) * 24 * 60 * 60 * 1000;
  res.setHeader("set-cookie", sessionCookie(createSession(secret(), username, expiresAt), remember, isSecure(req)));
  log("INFO", "Sign-in", { username, remember, viaEnvCredentials: byEnv && !bySettings });
  res.json({ username });
}));
app.post("/api/auth/logout", asyncRoute(async (req, res) => {
  if (logoutDenied(req.body)) throw new RestrictedError();
  const info = currentSession(req);
  res.setHeader("set-cookie", clearedCookie());
  if (!info) return res.status(204).end();
  if (req.body?.everywhere) {
    // A new secret invalidates every token issued so far at once.
    const nextSecret = randomBytes(32).toString("hex");
    await store.update((state) => { if (state.auth) state.auth = { ...state.auth, secret: nextSecret, revoked: {} }; });
    log("INFO", "Signed out on all devices", { username: info.username });
  } else {
    await store.update((state) => {
      if (state.auth) state.auth = { ...state.auth, revoked: { ...pruneRevoked(state.auth.revoked), [info.sid]: info.expiresAt } };
    });
    log("INFO", "Sign-out", { username: info.username });
  }
  await stopOwnedPlayback(req.body?.everywhere ? undefined : info.sid);
  res.status(204).end();
}));
app.patch("/api/auth/password", asyncRoute(async (req, res) => {
  const stored = store.auth();
  if (!stored) throw new AppError("No account has been created yet.", "err.noAccount");
  const current = String(req.body.currentPassword ?? "");
  if (!await verifyPassword(current, stored.passwordHash)) throw new AppError("The current password is wrong.", "err.wrongCurrentPassword");
  const nextPassword = String(req.body.newPassword ?? "");
  if (nextPassword.length < 6) throw new AppError("The new password needs at least 6 characters.", "auth.newPasswordTooShort");
  const username = String(req.body.username ?? stored.username).trim() || stored.username;
  const passwordHash = await hashPassword(nextPassword);
  // A new secret invalidates every token issued so far, other devices included.
  const nextSecret = randomBytes(32).toString("hex");
  await store.update((state) => { state.auth = { username, passwordHash, secret: nextSecret, isDefault: false, revoked: {} }; });
  res.setHeader("set-cookie", sessionCookie(createSession(nextSecret, username, Date.now() + REMEMBER_DAYS * 24 * 60 * 60 * 1000), true, isSecure(req)));
  await stopOwnedPlayback();
  log("INFO", "Credentials changed", { username });
  res.json({ username });
}));

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
app.get("/api/addons", (_req, res) => res.json(store.addons().map(publicAddonView)));
app.post("/api/addons", asyncRoute(async (req, res) => {
  const role = (["catalog", "source", "both"].includes(req.body.role) ? req.body.role : "both") as AddonRole;
  const addon = await loadAddon(String(req.body.url ?? ""), role);
  if (store.addons().some((item) => item.manifest.id === addon.manifest.id && item.manifestUrl === addon.manifestUrl)) throw new AppError("This manifest is already added.", "err.manifestExists");
  await store.update((state) => state.addons.push(addon)); res.status(201).json(publicAddonView(addon));
}));
// The order of addons is also their priority when sources are ranked.
app.post("/api/addons/:key/move", asyncRoute(async (req, res) => {
  const direction = Number(req.body.direction) < 0 ? -1 : 1;
  await store.update((state) => {
    const index = state.addons.findIndex((addon) => addon.key === req.params.key);
    if (index < 0) throw new AppError("The addon was not found.", "err.addonNotFound");
    const next = Math.max(0, Math.min(state.addons.length - 1, index + direction));
    if (next === index) return;
    const [addon] = state.addons.splice(index, 1);
    state.addons.splice(next, 0, addon);
  });
  res.status(204).end();
}));
app.delete("/api/addons/:key", asyncRoute(async (req, res) => {
  const existing = store.addons().find((a) => a.key === req.params.key);
  if (existing && essentialAddon(existing)) throw new AppError("Cinemeta provides the library metadata and cannot be removed.", "err.essentialAddon");
  await store.update((state) => { state.addons = state.addons.filter((a) => a.key !== req.params.key); });
  res.status(204).end();
}));
// The full record including the token-bearing address. The interface hides it elsewhere; handing it out here is deliberate.
app.get("/api/addons/:key/export", asyncRoute(async (req, res) => {
  const addon = store.addons().find((a) => a.key === req.params.key);
  if (!addon) throw new AppError("The addon was not found.", "err.addonNotFound");
  res.json({ manifestUrl: addon.manifestUrl, role: addon.role, enabled: addon.enabled, globalSearch: addon.globalSearch, addedAt: addon.addedAt, downloadSettings: addon.downloadSettings, manifest: addon.manifest });
}));
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
app.post("/api/addons/refresh", asyncRoute(async (_req, res) => {
  const outcomes = await refreshManifests(store.addons(), loadAddon);
  await storeRefreshed(outcomes);
  res.json({
    changed: outcomes.filter((outcome) => outcome.changed).length,
    failed: outcomes.filter((outcome) => outcome.error).length,
    addons: store.addons().map(publicAddonView),
  });
}));
app.post("/api/addons/:key/refresh", asyncRoute(async (req, res) => {
  const existing = store.addons().find((a) => a.key === req.params.key);
  if (!existing) throw new AppError("The addon was not found.", "err.addonNotFound");
  // The error travels to the interface as it is: a single refresh was asked for by
  // hand, so whoever pressed the button wants to know why the addon did not answer.
  const loaded = await loadAddon(existing.manifestUrl, existing.role);
  // Read before the write: the store hands out the live record, so applying the
  // refresh replaces the manifest this variable points at.
  const previousVersion = existing.manifest.version;
  const changed = manifestChanged(existing.manifest, loaded.manifest);
  await storeRefreshed([{ key: existing.key, name: loaded.manifest.name, previousVersion, version: loaded.manifest.version, changed, manifest: loaded.manifest }]);
  res.json({ addon: publicAddonView(store.addons().find((a) => a.key === existing.key)!), changed, previousVersion, version: loaded.manifest.version });
}));
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
app.patch("/api/addons/:key", asyncRoute(async (req, res) => {
  const existing = store.addons().find((a) => a.key === req.params.key);
  if (!existing) throw new AppError("The addon was not found.", "err.addonNotFound");
  const role = ["catalog", "source", "both"].includes(req.body.role) ? req.body.role as AddonRole : existing.role;
  // Switching it off, or down to a stream-only role, would take the metadata with it.
  if (essentialAddon(existing) && (req.body.enabled === false || role === "source")) {
    throw new AppError("Cinemeta provides the library metadata and cannot be switched off.", "err.essentialAddon");
  }
  // A different address means reloading the manifest. The key, the order and the save
  // rules stay, so a reconfigured addon need not be removed and added again.
  const url = req.body.url === undefined ? undefined : String(req.body.url).trim();
  // The settings are validated before the write: the mutator changes state in place, so
  // an exception halfway through would leave changes in memory that are never persisted.
  // It also rejects a nonsensical request before fetching a manifest for it.
  const downloadSettings = req.body.downloadSettings === undefined ? undefined : normalizeDownloadSettings(req.body.downloadSettings, store.libraries());
  const reloaded = url && url !== existing.manifestUrl ? await loadAddon(url, role) : undefined;
  await store.update((state) => {
    const addon = state.addons.find((a) => a.key === req.params.key);
    if (!addon) throw new AppError("The addon was not found.", "err.addonNotFound");
    if (typeof req.body.enabled === "boolean") addon.enabled = req.body.enabled;
    if (typeof req.body.globalSearch === "boolean") addon.globalSearch = req.body.globalSearch;
    if (downloadSettings) addon.downloadSettings = downloadSettings;
    addon.role = role;
    if (reloaded) { addon.manifestUrl = reloaded.manifestUrl; addon.manifest = reloaded.manifest; }
  });
  if (reloaded) log("INFO", "Addon reconfigured", { name: reloaded.manifest.name, role });
  res.json(publicAddonView(store.addons().find((a) => a.key === req.params.key)!));
}));
app.get("/api/catalogs", (_req, res) => res.json(store.addons().filter((a) => a.enabled && a.role !== "source").flatMap((addon) => (addon.manifest.catalogs ?? []).map((item) => ({ ...item, addonKey: addon.key, addonName: addon.manifest.name })) )));
app.get("/api/catalog", asyncRoute(async (req, res) => {
  const addon = store.addons().find((a) => a.key === req.query.addon); if (!addon) throw new AppError("The addon was not found.", "err.addonNotFound");
  const items = await catalog(addon, String(req.query.type), String(req.query.id), req.query.search ? String(req.query.search) : undefined, Number(req.query.skip) || 0, req.query.genre ? String(req.query.genre) : undefined);
  res.json(items.map((item) => images.rewriteMeta(item)));
}));
app.get("/api/search", asyncRoute(async (req, res) => {
  const query = String(req.query.query ?? "").trim();
  if (!query) throw new AppError("Enter a search term.", "err.emptyQuery");
  const type = req.query.type ? String(req.query.type) : undefined;
  const addonKey = req.query.addon ? String(req.query.addon) : undefined;
  const found = await searchAll(store.addons(), query, type, req.query.cursor ? String(req.query.cursor) : undefined, {
    addonKey,
    catalogType: addonKey && req.query.catalogType ? String(req.query.catalogType) : undefined,
    catalogId: addonKey && req.query.catalogId ? String(req.query.catalogId) : undefined,
    respectGlobalSearch: !addonKey,
  });
  res.json({ ...found, items: found.items.map((item) => images.rewriteMeta(item)) });
}));
app.get("/api/searchable", (_req, res) => res.json(searchableCatalogs(store.addons()).map(({ addon, definition }) => ({ addonKey: addon.key, addonName: addon.manifest.name, globalSearch: addon.globalSearch, type: definition.type, id: definition.id, name: definition.name ?? definition.id }))));
app.get("/api/meta/:type/:id", asyncRoute(async (req, res) => { const meta = await metadata(store.addons(), String(req.params.type), String(req.params.id), normalizeLanguage(String(req.query.language ?? ""))); if (!meta) return res.status(404).json({ error: "Metadata nebyla nalezena." }); res.json(images.rewriteMeta(meta)); }));
/** Opaque id in, cached bytes out. An id we never handed out means nothing here. */
app.get("/api/image/:id", asyncRoute(async (req, res) => {
  const cached = await images.fetch(String(req.params.id));
  if (!cached) return res.status(404).end();
  res.setHeader("content-type", cached.type);
  res.setHeader("etag", cached.etag);
  res.setHeader("cache-control", "private, max-age=86400");
  if (req.headers["if-none-match"] === cached.etag) return res.status(304).end();
  // The path is ours, not the caller's, and a data directory may well sit inside a
  // dotted folder -- which sendFile refuses unless told otherwise.
  res.sendFile(cached.file, { dotfiles: "allow" }, (error) => { if (error && !res.headersSent) res.status(404).end(); });
}));
app.get("/api/stream-sources/:type/:id", (req, res) => res.json(
  streamCandidates(store.addons(), String(req.params.type), String(req.params.id)).map((addon) => ({ key: addon.key, name: addon.manifest.name }))));
app.get("/api/streams/:type/:id", asyncRoute(async (req, res) => {
  const owner = ownerOf(req);
  const items = await streams(store.addons(), String(req.params.type), String(req.params.id), req.query.addon ? String(req.query.addon) : undefined);
  if (ownerOf(req).sid !== owner.sid) throw new ResourceError(401, "AUTH_REQUIRED");
  res.setHeader("cache-control", "private, no-store").json(items.map((item) => mediaResources.publicStream(item, owner)));
}));
app.get("/api/subtitles/:type/:id", asyncRoute(async (req, res) => {
  const owner = ownerOf(req);
  const items = await subtitles(store.addons(), String(req.params.type), String(req.params.id));
  res.setHeader("cache-control", "private, no-store").json(items.map((item) => ({
    subtitleId: mediaResources.add({ url: item.url }, owner, "subtitle"),
    lang: safeSourceText(item.lang, { url: item.url }), addonName: safeSourceText(item.addonName, { url: item.url }),
  })));
}));
app.get("/api/subtitle/:subtitleId", asyncRoute(async (req, res) => {
  res.setHeader("cache-control", "private, no-store");
  if ("url" in req.query || "headers" in req.query) throw new ResourceError(400, "UNSAFE_SOURCE_INPUT");
  const owner = ownerOf(req);
  const resource = mediaResources.get(String(req.params.subtitleId), owner.sid, "subtitle");
  trackMedia(owner, res, resource.parent);
  const raw = resource.stream.url!;
  if (raw.startsWith("file://")) {
    const target = await libraryTarget(raw.slice(7));
    const text = await readFile(target, "utf8");
    const vtt = text.trimStart().startsWith("WEBVTT") ? text : `WEBVTT\n\n${text.replace(/^\ufeff/, "").replace(/\r/g, "").replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2").replace(/^\d+\n(?=\d{2}:\d{2}:\d{2}[.,]\d{3} -->)/gm, "")}`;
    return void res.type("text/vtt; charset=utf-8").send(vtt);
  }
  const controller = new AbortController();
  res.once("close", () => { if (!res.writableEnded) controller.abort(); });
  const response = await guardedFetch(raw, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
  if (!response.ok) { await response.body?.cancel(); throw new Error("Subtitle source unavailable."); }
  let text = await readMediaText(response); if (!text.trimStart().startsWith("WEBVTT")) text = `WEBVTT\n\n${text.replace(/^\ufeff/, "").replace(/\r/g, "").replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2").replace(/^\d+\n(?=\d{2}:\d{2}:\d{2}[.,]\d{3} -->)/gm, "")}`;
  const shift = (Number(req.query.offset) || 0) - subtitleDelay(req.query.delay);
  if (shift) text = shiftVtt(text, shift);
  res.type("text/vtt; charset=utf-8").setHeader("cache-control", "private, no-store").send(text);
}));
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
  if (libraries.length !== 1) throw new Error(`An unqualified path needs exactly one library, ${libraries.length} are configured`);
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
const cachedMeta = async (type: string, id: string) => {
  const key = `${type}:${id}`;
  const hit = metaCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 60 * 60_000) return hit.value;
  const value = await metadata(store.addons(), type, id).catch(() => null);
  if (metaCache.size > 300) metaCache.clear();
  metaCache.set(key, { value, at: Date.now() });
  return value;
};
// Walking the tree is expensive, so it is held in memory for a while. The queue invalidates it once a download finishes.
let libraryCache: { at: number; entries: Awaited<ReturnType<typeof scanLibrary>> } | undefined;
let videoCache: { at: number; files: Awaited<ReturnType<typeof listVideos>> } | undefined;
const invalidateLibrary = () => { libraryCache = undefined; videoCache = undefined; unitCache = undefined; };
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
    for (const entry of previewEntries) {
      const art = await locateArtwork(entry);
      if (!art) { scheduleArtwork(entry); pending = true; }
      const poster = await thumbUrl("key", wirePath(entry.key), art);
      if (poster) posters.add(poster);
      if (posters.size === 5) break;
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

const thumbUrl = async (param: "path" | "dir" | "key", value: string, art: string | undefined) =>
  (art ? `/api/library/thumb?${param}=${encodeURIComponent(value)}&v=${await artStamp(art)}` : undefined);

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

/** `saveArtwork` with the reason kept, for the posters the catalogue hands us: one of them not
 *  arriving used to be silent end to end, and a blank title nobody can explain is worse than a
 *  warning in the log. */
const savePosterReport = async (key: string, target: string, url: string, what: string) => {
  let refusal: Extract<PosterOutcome, { ok: false }> | undefined;
  const saved = await saveArtwork(key, target, async () => {
    const outcome = await savePosterAs(target, url);
    if (!outcome.ok) refusal = outcome;
    return outcome.ok;
  });
  if (!saved) log("WARN", `${what} could not be saved`, { key, host: hostOf(url), target, reason: refusal?.reason ?? "no-file", detail: refusal?.detail });
  return saved;
};

/** Someone else's picture in the folder always wins: nothing is overwritten or regenerated. */
async function locateArtwork(entry: Awaited<ReturnType<typeof scanLibrary>>[number]) {
  const directory = entryDirectory(entry);
  if (directory) {
    const folder = mediaPath(directory);
    const existing = await findArtwork(folder);
    if (existing) return path.join(folder, existing);
  }
  const own = dataArtworkFile(libraryKey(entry.key));
  return await fileExists(own) ? own : undefined;
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
  unreachable: health.unreachable, readOnly: health.readOnly,
  defaultMovie: store.settings().defaultMovieLibrary === library.id,
  defaultSeries: store.settings().defaultSeriesLibrary === library.id,
  titles: stats.titles, files: stats.files, bytes: stats.bytes,
});

/** The same check the module makes, raised as the failure the interface renders. */
async function requireLibraryRoot(value: unknown, opts: { create?: boolean; exceptId?: string } = {}): Promise<string> {
  const checked = await checkLibraryRoot({ grants: libraryGrants(), libraries: store.libraries(), root: value, ...opts });
  if (!checked.ok) throw new AppError(checked.message, checked.messageKey, checked.status);
  return checked.root;
}

app.get("/api/libraries", asyncRoute(async (_req, res) => {
  await refreshLibraryHealth();
  const stats = await libraryStats();
  const libraries = [...store.libraries()].sort((a, b) => a.order - b.order);
  res.json(libraries.map((library) => libraryView(library, healthOf(library), stats.get(library.id) ?? { titles: 0, files: 0, bytes: 0 })));
}));

app.post("/api/libraries", asyncRoute(async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) throw new AppError("Give the library a name.", "err.libraryNameRequired");
  const type = asLibraryType(req.body?.type);
  if (!type) throw new AppError("Unknown library type.", "err.libraryTypeUnknown");
  const root = await requireLibraryRoot(req.body?.root, { create: req.body?.create === true });
  // A fresh answer for the root as it is now: a deleted library's cached verdict must not
  // decide whether the new one is writable.
  libraryProbe.invalidate(root);
  const health = await libraryProbe.cached(root);
  // A folder that was a library before and was removed without forgetting takes its identity
  // back, so its match history, artwork and favourite rows are its own again.
  const departed = store.departed();
  const resumedId = await departedIdFor(departed, root);
  const library: LibraryRecord = {
    id: resumedId ?? newLibraryId(), name, type, root, enabled: true,
    order: store.libraries().reduce((next, item) => Math.max(next, item.order + 1), 0),
    addedAt: new Date().toISOString(),
    ...(health.unreachable ? { unreachable: true } : {}),
    ...(health.readOnly ? { readOnly: true } : {}),
    // Off unless asked for: a new library points at somebody's existing tree as often as
    // not, and writing poster.jpg into it is the one thing that cannot be taken back.
    writeArtwork: req.body?.writeArtwork === true && !health.readOnly,
  };
  await store.update((state) => {
    state.libraries = [...(state.libraries ?? []), library];
    if (resumedId) state.departed = (state.departed ?? []).filter((entry) => entry.id !== resumedId);
  });
  // The library's directory for generated thumbnails is created with the library, not left to
  // whichever writer happens to come first.
  await mkdir(artworks.dirOf(library.id), { recursive: true }).catch(() => undefined);
  invalidateLibrary();
  await refreshLibraryHealth();
  if (resumedId) log("INFO", "Library added again, it keeps what it remembered", { library: library.id, root: library.root, type });
  else log("INFO", "Library created", { library: library.id, root: library.root, type });
  res.status(201).json(libraryView(library, health, { titles: 0, files: 0, bytes: 0 }));
}));

app.get("/api/libraries/browse", asyncRoute(async (req, res) => {
  const requested = String(req.query.path ?? "").trim();
  const grants = libraryGrants();
  if (!requested) {
    const rows = (await grantRows()).map((grant) => ({
      name: posixBase(grant.path) || grant.path, path: grant.path, source: grant.source,
      writable: grant.writable, ...libraryFlag(store.libraries(), grant.path),
    }));
    res.json({ path: "", parent: null, entries: rows });
    return;
  }
  const inside = await grantingRoot(grants, requested);
  if (!inside) throw new AppError("That folder is outside every granted root.", "err.libraryRootNotGranted", 403);
  const dir = path.resolve(requested);
  if (!(await stat(dir).catch(() => undefined))?.isDirectory()) throw new AppError("The folder does not exist.", "err.pathMissing");
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    // A symlink out of the grant is not listed at all, rather than listed and then refused.
    if (!await insideGrant(grants, full)) continue;
    rows.push({
      name: entry.name, path: toPosix(full),
      writable: await access(full, constants.W_OK).then(() => true, () => false),
      ...libraryFlag(store.libraries(), full),
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, "cs"));
  const up = path.dirname(dir);
  res.json({ path: toPosix(dir), parent: up !== dir && await insideGrant(grants, up) ? toPosix(up) : null, entries: rows });
}));

app.get("/api/libraries/grants", asyncRoute(async (_req, res) => { res.json(await grantRows()); }));

app.post("/api/libraries/grants", asyncRoute(async (req, res) => {
  const raw = String(req.body?.path ?? "").trim();
  if (!raw) throw new AppError("Missing folder.", "err.missingFolder");
  if (!path.isAbsolute(raw)) throw new AppError("The path has to be absolute.", "err.libraryRootAbsolute");
  const root = path.resolve(raw);
  if (!(await stat(root).catch(() => undefined))?.isDirectory()) throw new AppError("The folder does not exist.", "err.pathMissing");
  // A grant is recorded, never inferred: the request names a folder that is already there.
  if (!store.grants().some((grant) => path.resolve(grant.path) === root)) {
    await store.update((state) => {
      state.grants = [...(state.grants ?? []), { path: root, source: "user", grantedAt: new Date().toISOString() }];
    });
    log("INFO", "Library root granted", { root });
  }
  res.status(201).json(await grantRows());
}));

app.delete("/api/libraries/grants", asyncRoute(async (req, res) => {
  const raw = String(req.body?.path ?? req.query.path ?? "").trim();
  if (!raw) throw new AppError("Missing folder.", "err.missingFolder");
  const root = path.resolve(raw);
  // An operator grant is rebuilt from the environment on the next boot, so only a grant
  // somebody made at the keyboard can be revoked.
  if (!store.grants().some((grant) => path.resolve(grant.path) === root)) {
    throw new AppError("That root was not granted here.", "err.grantNotFound", 404);
  }
  // Revoking disables the libraries under it. Nothing is deleted -- the media, the metadata
  // file and the artwork directory all stay, so granting the root again brings them back.
  const affected = store.libraries().filter((library) => isInside(path.resolve(library.root), root));
  await store.update((state) => {
    state.grants = (state.grants ?? []).filter((grant) => path.resolve(grant.path) !== root);
    state.libraries = (state.libraries ?? []).map((library) =>
      affected.some((item) => item.id === library.id) ? { ...library, enabled: false } : library);
  });
  invalidateLibrary();
  await refreshLibraryHealth();
  for (const library of affected) log("INFO", "Library disabled with its revoked grant", { library: library.id, root: library.root });
  res.json(await grantRows());
}));

/** How much of a candidate tree the estimate may touch. The walk is capped at depth 8
 *  already, but a folder with a hundred thousand files must not become a way to tie the
 *  server up with one request. */
const PREVIEW_MAX_FILES = 20_000;
const PREVIEW_DEADLINE_MS = 5_000;

app.post("/api/libraries/preview", asyncRoute(async (req, res) => {
  const raw = String(req.body?.root ?? "").trim();
  if (!path.isAbsolute(raw)) throw new AppError("The root has to be an absolute path.", "err.libraryRootAbsolute");
  const root = path.resolve(raw);
  if (!await insideGrant(libraryGrants(), root)) {
    throw new AppError("That folder is outside every granted root.", "err.libraryRootNotGranted", 403);
  }
  if (!(await stat(root).catch(() => undefined))?.isDirectory()) throw new AppError("The folder does not exist.", "err.pathMissing");
  const budget: WalkBudget = { files: PREVIEW_MAX_FILES, until: Date.now() + PREVIEW_DEADLINE_MS };
  const files = await listVideos(root, "", 0, undefined, budget);
  const type = asLibraryType(req.body?.type) ?? "mixed";
  const units = titleUnits(files, type);
  // No addon is asked anything: the estimate is the walk plus what the state already knows.
  const library = store.libraries().find((item) => path.resolve(item.root) === root);
  const records = metaStore.qualifiedMeta();
  const identified = library
    ? units.filter((unit) => Boolean(knownTitleOf(libraryPath(library.id, unit.relative), records)?.id)).length
    : 0;
  res.json({
    root: toPosix(root), type, titles: units.length, identified, files: files.length,
    truncated: budget.files <= 0 || Date.now() > budget.until,
  });
}));

// The item routes come after every literal `/api/libraries/...` route: Express matches in
// registration order, so a `:id` route above them would swallow `/libraries/grants`.
app.patch("/api/libraries/:id", asyncRoute(async (req, res) => {
  const target = store.libraries().find((library) => library.id === req.params.id);
  if (!target) throw new AppError("The library was not found.", "err.libraryNotFound", 404);
  const patch: Partial<LibraryRecord> = {};
  if (req.body?.name !== undefined) {
    const name = String(req.body?.name).trim();
    if (!name) throw new AppError("Give the library a name.", "err.libraryNameRequired");
    patch.name = name;
  }
  if (req.body?.type !== undefined) {
    const type = asLibraryType(req.body?.type);
    if (!type) throw new AppError("Unknown library type.", "err.libraryTypeUnknown");
    patch.type = type;
  }
  if (req.body?.enabled !== undefined) patch.enabled = req.body.enabled === true;
  if (req.body?.order !== undefined && Number.isFinite(Number(req.body.order))) patch.order = Number(req.body.order);
  if (req.body?.writeArtwork !== undefined) patch.writeArtwork = req.body.writeArtwork === true;
  if (req.body?.root !== undefined) patch.root = await requireLibraryRoot(req.body.root, { exceptId: target.id });

  const next = { ...target, ...patch };
  if (patch.root !== undefined) libraryProbe.invalidate(next.root);
  await refreshLibraryHealth();
  const health = await libraryProbe.cached(next.root);
  const record: LibraryRecord = { ...next, writeArtwork: next.writeArtwork && !health.readOnly };
  // The probe answers for the root as it is now; a stale `unreachable` on a disk that came
  // back would keep the library out of every walk.
  if (health.unreachable) record.unreachable = true; else delete record.unreachable;
  if (health.readOnly) record.readOnly = true; else delete record.readOnly;
  await store.update((state) => {
    state.libraries = (state.libraries ?? []).map((library) => library.id === record.id ? record : library);
    // The default pickers resolve at use, so a type change only strands the kinds the new
    // type no longer serves.
    if (state.settings) {
      const serves = (kind: "movie" | "series") => record.type === kind || record.type === "mixed";
      if (!serves("movie") && state.settings.defaultMovieLibrary === record.id) state.settings.defaultMovieLibrary = "";
      if (!serves("series") && state.settings.defaultSeriesLibrary === record.id) state.settings.defaultSeriesLibrary = "";
    }
  });
  invalidateLibrary();
  await refreshLibraryHealth();
  const stats = await libraryStats();
  log("INFO", "Library updated", { library: record.id, root: record.root, type: record.type, enabled: record.enabled });
  res.json(libraryView(record, health, stats.get(record.id) ?? { titles: 0, files: 0, bytes: 0 }));
}));

app.delete("/api/libraries/:id", asyncRoute(async (req, res) => {
  const target = store.libraries().find((library) => library.id === req.params.id);
  if (!target) throw new AppError("The library was not found.", "err.libraryNotFound", 404);
  // Only an explicit forget drops remembered data. The media is never touched either way.
  const forget = req.query.forget === "1";
  // Removing without forgetting leaves a note behind: the folder's identity, so that adding it
  // again is not a new library that has to be matched all over. The note is what makes the
  // dialog's promise true, and it is dropped with the rest when the user asks to forget.
  const realRoot = await realpath(path.resolve(target.root)).catch(() => path.resolve(target.root));
  await store.update((state) => {
    state.libraries = (state.libraries ?? []).filter((library) => library.id !== target.id);
    const kept = activeDeparted(state.departed ?? []).filter((entry) => entry.id !== target.id);
    state.departed = forget ? kept : [...kept, { id: target.id, root: realRoot, removedAt: new Date().toISOString() }].slice(-DEPARTED_MAX);
    if (state.settings) {
      if (state.settings.defaultMovieLibrary === target.id) state.settings.defaultMovieLibrary = "";
      if (state.settings.defaultSeriesLibrary === target.id) state.settings.defaultSeriesLibrary = "";
    }
    if (!forget) return;
    state.favorites = (state.favorites ?? []).filter((key) => parseLibraryPath(key)?.libraryId !== target.id);
    state.progress = Object.fromEntries(Object.entries(state.progress ?? {}).filter(([key, value]) => {
      const owner = key.startsWith("file:") ? key.slice(5) : value.path ?? "";
      return parseLibraryPath(owner)?.libraryId !== target.id;
    }));
  });
  if (forget) {
    await metaStore.forget(target.id);
    await rm(artworks.dirOf(target.id), { recursive: true, force: true });
    await artworks.removedTree(artworks.dirOf(target.id));
  }
  invalidateLibrary();
  await refreshLibraryHealth();
  log("INFO", "Library removed", { library: target.id, root: target.root, forget });
  res.status(204).end();
}));

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

/** Thumbnail of one video. Next to the video it is looked up by Jellyfin's naming convention. */
async function locateFileArtwork(key: string) {
  const media = path.join(posixDir(mediaPath(key)), episodeArtName(posixBase(key)));
  if (await fileExists(media)) return media;
  const own = dataArtworkFile(key);
  if (await fileExists(own)) return own;
  // The folder's picture belongs to a film only when the folder is the film's folder: a title
  // bound through that folder, not one bound on the file itself, which is what a film moved
  // into a shared folder becomes.
  const cover = knownTitleEntry(key, metaStore.qualifiedMeta());
  if (fileMayUseFolderArtwork(key, cover?.record.type, cover?.key)) return locateFolderArtwork(posixDir(key));
  return undefined;
}

const PLAYBACK_IDLE_SECONDS = 300;
const playbackBusy = () => playback.diagnostics().sessions.some((session) => session.idleSeconds < PLAYBACK_IDLE_SECONDS);
const metaBackfill = new ArtworkQueue();
// A title the catalogue answers without a description would otherwise be asked
// about on every single browse, so a finished attempt holds for a while.
const BACKFILL_RETRY_MS = 6 * 60 * 60_000;
const metaBackfillTried = new Map<string, number>();
const scheduleMetaBackfill = (type: string, id: string) => {
  const key = `${type}:${id}`;
  const tried = metaBackfillTried.get(key);
  if (!id || playbackBusy()) return false;
  if (tried != null && Date.now() - tried < BACKFILL_RETRY_MS) return false;
  metaBackfill.run(key, async () => {
    if (playbackBusy()) return;
    const meta = await cachedMeta(type, id);
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
const hashedArt = (key: string) => isFileKey(key) ? dataArtworkFile(key) : dataArtworkFile(`dir:${key}`);
const mediaPosterExists = async (key: string) => {
  const folder = isFileKey(key) ? posixDir(key) : key;
  if (!folder) return false;
  return Boolean(await findArtwork(mediaPath(folder)));
};
const writeCatalogPoster = async (key: string, url?: string) => {
  if (!url || !key || key === ".") return false;
  if (await mediaPosterExists(key)) {
    // Not a failure: a picture of the folder's own always wins, and it is worth being able to
    // see that this is why nothing was written.
    log("DEBUG", "The folder has its own picture, the catalogue poster was not written", { key });
    return false;
  }
  await removeArtwork(dataArtworkFile(key));
  await removeArtwork(dataArtworkFile(`dir:${key}`));
  const toMedia = artworkBesideMediaFor(key);
  const asFile = isFileKey(key);
  const target = toMedia
    ? (asFile
      ? path.join(posixDir(mediaPath(key)), episodeArtName(posixBase(key)))
      : path.join(mediaPath(key), POSTER_OUTPUT))
    : hashedArt(key);
  await mkdir(path.dirname(target), { recursive: true });
  return savePosterReport(key, target, url, "The catalogue poster");
};

/** The binding on this exact path, ignoring one inherited from a parent folder. */
const ownRecord = (relative: string, records: Record<string, LibraryMetaRecord>) =>
  (records[relative]?.id ? records[relative] : undefined);

/** Generated thumbnails of a path and everything under it. A changed binding makes
 *  them stale: the poster of the old title, or a frame grabbed while unmatched. */
const clearGeneratedArt = async (key: string) => {
  await removeArtwork(dataArtworkFile(key));
  await removeArtwork(dataArtworkFile(`dir:${key}`));
  for (const file of await libraryFiles()) {
    if (file.relative !== key && isPathWithin(file.relative, key)) await removeArtwork(dataArtworkFile(file.relative));
  }
};

const attachBrowseMeta = <T extends { path: string; kind: string; name?: string; label?: string }>(item: T) => {
  const records = metaStore.qualifiedMeta();
  const episodes = metaStore.episodes();
  const key = libraryKey(item.path);
  const label = item.kind === "folder" ? String(item.name ?? "") : String(item.label ?? "");
  const extra = browseMeta(key, label, records, metaStore.qualifiedSuggestions(), episodes);
  const known = knownTitleOf(key, records);
  const numbers = item.kind === "file" ? episodeNumberOf(key, ownRecord(key, records)) : undefined;
  const wanted = needsBackfill(known) || needsEpisodes(known, numbers, episodes);
  const backfill = wanted && scheduleMetaBackfill(known!.type, known!.id);
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

function scheduleFileArtwork(key: string) {
  // Same guard as scheduleArtwork: a page reload while the frame grab is still
  // running must not pile up another one behind it.
  if (artworkQueue.has(`file:${key}`)) return;
  artworkQueue.run(`file:${key}`, async () => {
    if (await locateFileArtwork(key)) return;
    const source = await realpath(mediaPath(key)).catch(() => undefined);
    if (!source) return;
    const target = artworkBesideMediaFor(key)
      ? path.join(posixDir(mediaPath(key)), episodeArtName(posixBase(key)))
      : dataArtworkFile(key);
    await mkdir(path.dirname(target), { recursive: true });
    if (await catalogPosterIfBound(key, target)) return;
    if (await locateFileArtwork(key)) return;
    if (await catalogPosterIfBound(key, target)) return;
    const info = await playback.inspect({ url: `file://${wirePath(key)}` }).catch(() => undefined);
    await saveArtwork(key, target, () => saveFrame(source, target, framePosition(info?.duration)));
  });
}

/** Folder thumbnail: its own picture, then the poster from metadata, otherwise a frame from the first video inside. */
async function locateFolderArtwork(key: string) {
  const folder = mediaPath(key);
  const existing = await findArtwork(folder);
  if (existing) return path.join(folder, existing);
  const own = dataArtworkFile(`dir:${key}`);
  return await fileExists(own) ? own : undefined;
}

function scheduleFolderArtwork(key: string) {
  if (artworkQueue.has(`dir:${key}`)) return;
  artworkQueue.run(`dir:${key}`, async () => {
    if (await locateFolderArtwork(key)) return;
    const target = artworkBesideMediaFor(key) ? path.join(mediaPath(key), POSTER_OUTPUT) : dataArtworkFile(`dir:${key}`);
    await mkdir(path.dirname(target), { recursive: true });
    if (await catalogPosterIfBound(key, target)) return;
    if (await locateFolderArtwork(key)) return;
    if (await catalogPosterIfBound(key, target)) return;
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
    const remember = (key: string) => {
      valid.add(path.basename(dataArtworkFile(key)));
      const parts = key.split("/");
      for (let depth = 1; depth < parts.length; depth += 1) {
        valid.add(path.basename(dataArtworkFile(`dir:${parts.slice(0, depth).join("/")}`)));
      }
    };
    for (const entry of await scanLibrary(library.root, carveOutsOf(library))) {
      valid.add(path.basename(dataArtworkFile(libraryPath(library.id, entry.key))));
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
const withFavorites = <T extends { path: string }>(items: T[]) => {
  const favorites = new Set(store.favorites());
  return items.map((item) => ({ ...item, favorite: favorites.has(libraryKey(item.path)) }));
};

// Starred catalogue titles. The key is type and id, because no file has to exist for them.
app.get("/api/watchlist", (_req, res) => {
  const all = store.watchlist();
  res.json(Object.entries(all)
    .map(([key, value]) => ({ key, ...value, poster: images.proxied(value.poster) }))
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt)));
});
app.post("/api/watchlist", asyncRoute(async (req, res) => {
  const type = String(req.body.type ?? "movie");
  const id = String(req.body.id ?? "").trim();
  if (!id) throw new AppError("Missing title id.", "err.missingTitleId");
  const key = `${type}:${id}`;
  const wanted = Boolean(req.body.favorite);
  await store.update((state) => {
    const all = { ...state.watchlist };
    if (wanted) all[key] = { type, id, name: String(req.body.name ?? id), poster: posterOf(req.body.poster), addedAt: new Date().toISOString() };
    else delete all[key];
    state.watchlist = all;
  });
  res.json({ key, favorite: wanted });
}));

// Resume list: the position is reported as it goes, and a finished title forgets itself.
const PROGRESS_DONE = 0.94;
/** The client speaks relative paths; a stored progress entry is keyed by the qualified
 *  one. A catalogue title key is not a path and travels untouched. */
const storedProgressKey = (key: string) => key.startsWith("file:") ? `file:${libraryKey(key.slice(5))}` : key;
const wireProgressKey = (key: string) => key.startsWith("file:") ? `file:${wirePath(key.slice(5))}` : key;
app.get("/api/progress", (_req, res) => {
  const all = store.progress();
  const items = Object.entries(all)
    .map(([key, value]) => ({ ...value, key: wireProgressKey(key), path: value.path ? wirePath(value.path) : value.path, poster: images.proxied(value.poster) }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 40);
  res.json(items);
});
app.get("/api/progress/:key", (req, res) => {
  const found = store.progress()[storedProgressKey(String(req.params.key))];
  res.json(found ? { ...found, poster: images.proxied(found.poster) } : null);
});
app.post("/api/progress", asyncRoute(async (req, res) => {
  // With tracking switched off the position is written nowhere.
  if (!store.settings().trackProgress) return res.status(204).end();
  const key = storedProgressKey(String(req.body.key ?? "").trim());
  const position = Number(req.body.position) || 0;
  const duration = Number(req.body.duration) || 0;
  if (!key) throw new AppError("Missing title key.", "err.missingTitleKey");
  await store.update((state) => {
    const all = { ...state.progress };
    // Neither an almost-finished title nor the very beginning is worth keeping.
    if (duration > 0 && (position / duration > PROGRESS_DONE || position < 30)) delete all[key];
    else all[key] = {
      position, duration,
      title: String(req.body.title ?? all[key]?.title ?? "Video"),
      path: req.body.path ? libraryKey(String(req.body.path)) : all[key]?.path,
      poster: posterOf(req.body.poster) ?? all[key]?.poster,
      updatedAt: new Date().toISOString(),
    };
    // The list must not grow without bound.
    const keys = Object.keys(all).sort((a, b) => all[b]!.updatedAt.localeCompare(all[a]!.updatedAt));
    state.progress = Object.fromEntries(keys.slice(0, 60).map((item) => [item, all[item]!]));
  });
  res.status(204).end();
}));
app.delete("/api/progress", asyncRoute(async (_req, res) => {
  await store.update((state) => { state.progress = {}; });
  log("INFO", "Watch history cleared");
  res.status(204).end();
}));
app.delete("/api/progress/:key", asyncRoute(async (req, res) => {
  await store.update((state) => { const all = { ...state.progress }; delete all[storedProgressKey(String(req.params.key))]; state.progress = all; });
  res.status(204).end();
}));

const setLibraryFavorite = async (relative: string, wanted: boolean) => {
  const resolved = relative ? await resolveLibraryPath(store.libraries(), relative) : undefined;
  if (!resolved) throw new AppError("Invalid path.", "err.invalidPath");
  await store.update((state) => {
    const current = new Set(state.favorites ?? []);
    if (wanted) current.add(resolved.key); else current.delete(resolved.key);
    state.favorites = [...current];
  });
};

app.post("/api/library/favorite", asyncRoute(async (req, res) => {
  const relative = String(req.body.path ?? "").trim();
  const wanted = Boolean(req.body.favorite);
  await setLibraryFavorite(relative, wanted);
  res.json({ path: relative, favorite: wanted });
}));

app.get("/api/library/resume", asyncRoute(async (req, res) => {
  const favorites = new Set(store.favorites());
  const query = String(req.query.query ?? "").trim().toLocaleLowerCase();
  const entries = Object.entries(store.progress()).filter(([key, entry]) => key.startsWith("file:") && entry.path);
  const described = await Promise.all(entries.map(async ([, entry]) => {
    const item = await describeLibraryPath(entry.path!);
    if (!item || item.kind !== "file") return [];
    // `describePath` answers library-relative, and the row already knows which library it
    // came from. Qualifying it through the single-library shim instead asks an install with
    // two of them a question it cannot answer, and the whole resume row returns 400.
    const key = libraryPath(libraryOfKey(entry.path!).library.id, item.path);
    return [{ ...item, path: wirePath(key), label: entry.title || item.label, modified: entry.updatedAt,
      progress: { position: entry.position, duration: entry.duration }, favorite: favorites.has(key) }];
  }));
  const items = described.flat().filter((item) => (!query || item.label.toLocaleLowerCase().includes(query)) && (req.query.favorites !== "1" || item.favorite));
  const sorts = new Set(["name", "added", "size", "random"]);
  const sort = sorts.has(String(req.query.sort)) ? String(req.query.sort) as "name" : "added";
  const ordered = sortFiles(items, sort, req.query.order !== "asc", String(req.query.seed ?? ""));
  const skip = Math.max(0, Number(req.query.skip) || 0);
  const limit = Math.max(1, Math.min(120, Number(req.query.limit) || 60));
  const page = await Promise.all(ordered.slice(skip, skip + limit).map(async (item) => {
    const art = await locateFileArtwork(libraryKey(item.path));
    if (!art) scheduleFileArtwork(libraryKey(item.path));
    const { item: withMeta, backfill } = attachBrowseMeta(item);
    return { ...withMeta, poster: await thumbUrl("path", item.path, art), backfill };
  }));
  res.json({ path: ":resume", items: page.map(({ backfill: _backfill, ...item }) => item), total: ordered.length, pending: page.some((item) => !item.poster || item.backfill) });
}));

app.get("/api/library/favorites", asyncRoute(async (req, res) => {
  const sorts = new Set(["name", "added", "size", "random"]);
  const sort = sorts.has(String(req.query.sort)) ? String(req.query.sort) as "name" : "name";
  const described = await Promise.all(store.favorites().map(async (stored) => {
    const item = await describeLibraryPath(stored);
    return item && { ...item, path: wirePath(libraryKey(stored)) };
  }));
  // Paths that disappeared meanwhile are skipped but not dropped from the list:
  // the disk may be temporarily unavailable, and losing favourites over that is worse.
  const present = described.filter(Boolean) as NonNullable<typeof described[number]>[];
  const mixed = present.map((item) => ({
    ...item, label: item.kind === "folder" ? item.name : item.label,
  }));
  const ordered = sortFiles(mixed, sort, req.query.order === "desc", String(req.query.seed ?? ""));
  const skip = Math.max(0, Number(req.query.skip) || 0);
  const limit = Math.max(1, Math.min(120, Number(req.query.limit) || 60));
  const page = await Promise.all(ordered.slice(skip, skip + limit).map(async (item) => {
    const key = libraryKey(item.path);
    const art = item.kind === "folder" ? await locateFolderArtwork(key) : await locateFileArtwork(key);
    if (!art) (item.kind === "folder" ? scheduleFolderArtwork : scheduleFileArtwork)(key);
    const poster = await thumbUrl(item.kind === "folder" ? "dir" : "path", item.path, art);
    const { item: withMeta, backfill } = attachBrowseMeta(item);
    return { ...withMeta, favorite: true, poster, backfill };
  }));
  res.json({ path: ":favorites", items: page.map(({ backfill: _backfill, ...item }) => item), total: ordered.length, pending: page.some((item) => !item.poster || item.backfill) });
}));

app.get("/api/library/browse", asyncRoute(async (req, res) => {
  const requested = String(req.query.path ?? "");
  const limit = Math.max(1, Math.min(120, Number(req.query.limit) || 60));
  const sorts = new Set(["name", "added", "size", "random"]);
  const sort = sorts.has(String(req.query.sort)) ? String(req.query.sort) as "name" : "name";
  const onlyFavorites = req.query.favorites === "1";
  void sweepArtwork();
  const libraries = store.libraries();
  // An empty path is the single library's root while that is the whole setup, and the list
  // of libraries once there are more. Configured is what counts, not enabled and not
  // reachable: a library switched off or on a disk that is away is still part of the setup,
  // and a browse root that changed shape when a drive spun down would be worse than a row
  // with a warning. The row says so instead of hiding it.
  if (!requested && libraries.length !== 1) {
    res.json(await libraryRootBrowse());
    return;
  }
  const resolved = requested ? await resolveLibraryPath(libraries, requested) : undefined;
  if (requested && !resolved) throw new AppError("Invalid path.", "err.invalidPath");
  const library = resolved?.library ?? singleLibrary();
  markBrowsed(library);
  const inLibrary = (path: string) => libraryPath(library.id, path);
  const favoritePaths = onlyFavorites
    ? new Set(store.favorites().map((key) => relativeKeyIn(library.id, key)).filter((value): value is string => value !== undefined))
    : undefined;
  const result = await browseDirectory(library.root, resolved?.relative ?? "", String(req.query.query ?? ""),
    Math.max(0, Number(req.query.skip) || 0), limit, sort, req.query.order === "desc", String(req.query.seed ?? ""), favoritePaths,
    carveOutsOf(library));
  // Missing thumbnails are produced in the background; the client asks for the page again shortly.
  const items = await Promise.all(result.items.map(async (item) => {
    const key = inLibrary(item.path);
    const path = wirePath(key);
    if (item.kind === "folder") {
      const art = await locateFolderArtwork(key);
      if (!art) scheduleFolderArtwork(key);
      const { item: withMeta, backfill } = attachBrowseMeta({ ...item, path });
      return { ...withMeta, path, poster: await thumbUrl("dir", path, art), backfill };
    }
    const art = await locateFileArtwork(key);
    if (!art) scheduleFileArtwork(key);
    const watched = store.progress()[`file:${key}`];
    const { item: withMeta, backfill } = attachBrowseMeta({ ...item, path });
    return {
      ...withMeta,
      path,
      poster: await thumbUrl("path", path, art),
      progress: watched ? { position: watched.position, duration: watched.duration } : undefined,
      backfill,
    };
  }));
  const marked = withFavorites(items);
  res.json({ ...result, path: wirePath(inLibrary(result.path)), items: marked.map(({ backfill: _backfill, ...item }) => item), pending: marked.some((item) => !item.poster || item.backfill) });
}));

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
  await store.update((state) => {
    state.favorites = (state.favorites ?? []).filter((item) => !isPathWithin(item, key));
    state.progress = Object.fromEntries(Object.entries(state.progress ?? {}).filter(([progressKey, value]) => {
      if (orphans.has(progressKey)) return false;
      const itemPath = progressKey.startsWith("file:") ? progressKey.slice(5) : value.path;
      return !itemPath || !isPathWithin(itemPath, key);
    }));
    state.watchlist = Object.fromEntries(Object.entries(state.watchlist ?? {}).filter(([watchKey]) => !orphans.has(watchKey)));
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
  await store.update((state) => {
    state.favorites = (state.favorites ?? []).map((item) => remapPath(item, key, nextKey));
    state.progress = Object.fromEntries(Object.entries(state.progress ?? {}).map(([progressKey, value]) => {
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
      const result = await artworks.moveKey(from!, to!);
      if (!result.carried && result.reason === "failed") {
        log("WARN", "A thumbnail could not follow its item", { from, to, detail: result.detail });
      }
    }
  }
};

/** The same for a copy: the item exists twice now and both halves deserve the picture. */
const duplicateArtwork = async (items: string[], relative: string, nextRelative: string) => {
  for (const item of items) {
    const next = remapPath(item, relative, nextRelative);
    for (const [from, to] of [[item, next], [`dir:${item}`, `dir:${next}`]]) {
      const result = await artworks.copyKey(from!, to!);
      if (!result.carried && result.reason === "failed") {
        log("WARN", "A thumbnail could not be copied to the item's new key", { from, to, detail: result.detail });
      }
    }
  }
};

/** A title bound through its folder keeps its picture under that folder's key. Moving the item
 *  out pins the binding on the item, so the picture has to follow it: without this the item
 *  shows up blank and the folder's copy is swept as an orphan an hour later. Copied rather than
 *  moved, because whatever stays in the folder is still that title's. */
const carryCoveringArtwork = async (cover: string, nextKey: string) => {
  const result = await artworks.copyKey(`dir:${cover}`, isFileKey(nextKey) ? nextKey : `dir:${nextKey}`);
  if (!result.carried && result.reason === "failed") {
    log("WARN", "The picture of the folder a title is bound through could not travel with it", { cover, next: nextKey, detail: result.detail });
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
    await removeArtwork(dataArtworkFile(folderKey));
    await removeArtwork(dataArtworkFile(`dir:${folderKey}`));
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
  await removeArtwork(dataArtworkFile(resolved.key));
  await removeArtwork(dataArtworkFile(`dir:${resolved.key}`));
  const orphans = await forgetLibraryPath(resolved.key);
  const pruned = await pruneEmptiedFolders(resolved.key);
  invalidateLibrary();
  log("INFO", "Deleted from the library", { path: relative, directory: info.isDirectory(), forgottenTitles: [...orphans], pruned });
};

app.delete("/api/library/item", asyncRoute(async (req, res) => {
  const relative = String(req.query.path ?? "").trim();
  await deleteLibraryItem(relative);
  res.status(204).end();
}));

app.post("/api/library/folder", asyncRoute(async (req, res) => {
  const parent = String(req.body?.path ?? "").trim();
  const resolved = await resolveLibraryPath(store.libraries(), parent);
  if (!resolved) throw new AppError("Invalid path.", "err.invalidPath");
  const info = await stat(resolved.absolute).catch(() => undefined);
  if (!info?.isDirectory()) throw new AppError("The destination folder does not exist.", "err.targetMissing");
  const rawName = String(req.body?.name ?? "").trim();
  if (!rawName || /^\.+$/.test(rawName)) throw new AppError("Invalid name.", "err.invalidName");
  const name = safeName(rawName);
  const relative = posixJoin(resolved.relative, name);
  const target = await resolveLibraryPath(store.libraries(), libraryPath(resolved.library.id, relative));
  if (!target) throw new AppError("Invalid path.", "err.invalidPath");
  if (await fileExists(target.absolute)) throw new AppError("A file with that name already exists.", "err.nameTaken");
  await mkdir(target.absolute);
  invalidateLibrary();
  res.status(201).json({ path: wirePath(target.key) });
}));

app.post("/api/library/rename", asyncRoute(async (req, res) => {
  const relative = String(req.body.path ?? "").trim();
  const resolved = relative ? await resolveLibraryPath(store.libraries(), relative) : undefined;
  if (!resolved || !resolved.relative) throw new AppError("Invalid path.", "err.invalidPath");
  const info = await stat(resolved.absolute).catch(() => undefined);
  if (!info) throw new AppError("The file or folder does not exist.", "err.pathMissing");

  const extension = info.isDirectory() ? "" : path.extname(relative);
  const wanted = safeName(String(req.body.name ?? "").replace(/\.[^.]+$/, ""));
  const nextRelative = posixJoin(posixDir(relative), `${wanted}${extension}`);
  const target = await resolveLibraryPath(store.libraries(), nextRelative);
  if (!target) throw new AppError("Invalid name.", "err.invalidName");
  // A rename that only changes the case of a name is a real rename where the filesystem folds
  // case; there the target is the same file, and `fileExists` must not be read as a clash.
  if (!sameFile(target.absolute, resolved.absolute) && await fileExists(target.absolute)) throw new AppError("A file with that name already exists.", "err.nameTaken");

  await rename(resolved.absolute, target.absolute);
  await relocateLibraryPath(resolved.key, target.key);
  invalidateLibrary();
  log("INFO", "Renamed in the library", { from: relative, to: nextRelative });
  res.json({ path: nextRelative });
}));

/** The destination picker. Browsing hides folders with no video in them; moving something
 *  into one of them is perfectly reasonable, so this lists them all. */
app.get("/api/library/folders", asyncRoute(async (req, res) => {
  const relative = String(req.query.path ?? "").trim();
  const resolved = await resolveLibraryPath(store.libraries(), relative);
  if (!resolved) throw new AppError("Invalid path.", "err.invalidPath");
  markBrowsed(resolved.library);
  const folders = await listFolders(resolved.library.root, resolved.relative, carveOutsOf(resolved.library));
  // A move destination travels back through resolveLibraryPath, so it is qualified too.
  res.json({ path: relative, folders: folders.map((folder) => ({ ...folder, path: wirePath(libraryPath(resolved.library.id, folder.path)) })) });
}));

/** The kind of the unit an item belongs to: its own binding first, the structure the source
 *  library gives it otherwise, because an unbound file carries no type of its own. */
const unitKindOf = async (key: string): Promise<TitleKind | undefined> => {
  const record = ownRecord(key, metaStore.qualifiedMeta());
  if (record?.type === "movie" || record?.type === "series") return record.type;
  const covering = (await libraryUnits()).filter((unit) => isPathWithin(key, unit.key));
  return covering.sort((a, b) => b.key.length - a.key.length)[0]?.kind;
};

/** A typed library is a promise about what is inside it, and a move must not break it.
 *  `mixed` takes anything, and so does a unit whose kind nobody can name -- refusing that
 *  would block a move over a guess. */
const assertMoveType = async (key: string, destination: LibraryRecord) => {
  if (destination.type === "mixed") return;
  const kind = await unitKindOf(key);
  if (kind && kind !== destination.type) {
    throw new AppError(`A ${destination.type} library does not take ${kind === "movie" ? "films" : "series"}.`, "err.libraryTypeMismatch");
  }
};

const transferLibraryItem = async (relative: string, folder: string, copy = false, progress?: TransferProgress) => {
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
  if (acrossLibraries) await assertMoveType(resolved.key, folderResolved.library);
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

app.post("/api/library/move", asyncRoute(async (req, res) => {
  // `copy` is honoured rather than ignored: the field was silently dropped before, so a client
  // that asked for a copy got a move -- the original deleted -- with a success in the response.
  const moved = await transferLibraryItem(String(req.body.path ?? "").trim(), String(req.body.folder ?? "").trim(), req.body.copy === true);
  res.json({ path: moved });
}));

app.get("/api/library/thumb", asyncRoute(async (req, res) => {
  const filePath = req.query.path ? libraryKey(String(req.query.path)) : undefined;
  const dirPath = req.query.dir ? libraryKey(String(req.query.dir)) : undefined;
  let art: string | undefined;
  if (filePath) art = await locateFileArtwork(filePath);
  else if (dirPath) art = await locateFolderArtwork(dirPath);
  else {
    const selected = String(req.query.key ?? "");
    const entry = (await libraryEntries()).find((item) => item.key === libraryKey(selected));
    art = entry && await locateArtwork(entry);
  }
  if (!art) return res.status(404).end();
  void artworks.served(art);
  res.setHeader("cache-control", "private, no-store");
  res.sendFile(art, { dotfiles: "allow" }, (error) => { if (error && !res.headersSent) res.status(404).end(); });
}));
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

/** The catalogue poster is saved as the job is queued, so it is in the library before the file
 *  is. `fallback` is the catalogue's own answer, tried only when the first address fails: the
 *  poster the client handed over is the one the viewer expects, but it may be a dead link. */
const saveCatalogPoster = (key: string, url?: string, fallback?: string) => {
  if (!key || key === "." || (!url && !fallback)) return;
  const queueKey = isFileKey(key) ? `file:${key}` : `dir:${key}`;
  artworkQueue.run(queueKey, async () => {
    if (url && await writeCatalogPoster(key, url)) {
      log("INFO", "Poster from the catalog saved", { key });
      return;
    }
    if (fallback && fallback !== url && await writeCatalogPoster(key, fallback)) {
      log("INFO", "Poster from the catalog saved", { key, source: "metadata" });
    }
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
  savePoster: (key, url) => saveCatalogPoster(key, url),
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
  saveCatalogPoster(key, media.poster, meta?.poster);
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

app.get("/api/library/identity", asyncRoute(async (req, res) => {
  const relative = String(req.query.path ?? "").trim();
  const resolved = relative ? await resolveLibraryPath(store.libraries(), relative) : undefined;
  if (!resolved) throw new AppError("Invalid path.", "err.invalidPath");
  const files = await libraryFiles();
  const unitKey = matchKeyFor(resolved.key, files);
  const unit = (await libraryUnits()).find((item) => item.key === unitKey);
  const records = metaStore.qualifiedMeta();
  const suggestions = metaStore.qualifiedSuggestions();
  const known = knownTitleOf(resolved.key, records);
  if (needsBackfill(known)) scheduleMetaBackfill(known!.type, known!.id);
  const suggestion = suggestionFor(unitKey, suggestions);
  const isFile = isVideo(posixBase(resolved.key));
  const numbers = episodeNumberOf(resolved.key, ownRecord(resolved.key, records));
  const bound = known ? { type: known.type, id: known.id, name: known.name, season: known.season, episode: known.episode } : undefined;
  res.json({
    path: relative,
    key: wirePath(unitKey),
    // What the user clicked can be one file of a whole bound title, so the dialog
    // has to be able to say which of the two it is about to rewrite.
    file: isFile,
    label: posixBase(relative),
    kind: unit?.kind ?? (isFile && numbers ? "series" : "movie"),
    parsed: { ...parseMediaPath(unitKey), ...(numbers ? { season: numbers.season, episode: numbers.episode } : {}) },
    match: matchStatus(resolved.key, records, suggestions),
    ...(bound?.id ? { bound } : {}),
    ...(suggestion ? { suggestion } : {}),
  });
}));

type LibraryMatchRequest = { path?: unknown; key?: unknown; id?: unknown; type?: unknown; scope?: unknown; season?: unknown; episode?: unknown; skipLookup?: unknown };

const matchLibraryItem = async (body: LibraryMatchRequest) => {
  const requested = String(body.path ?? body.key ?? "").trim();
  const resolved = requested ? await resolveLibraryPath(store.libraries(), requested) : undefined;
  if (!resolved) throw new AppError("Invalid path.", "err.invalidPath");
  const requestKey = resolved.key;
  const files = await libraryFiles();
  const unitKey = matchKeyFor(requestKey, files);
  if (typeof body.skipLookup === "boolean" && body.id === undefined) {
    const target = parseLibraryPath(requestKey);
    if (target) await metaStore.update(target.libraryId, (file) => {
      const current = file.meta[target.relative];
      if (body.skipLookup) {
        file.meta[target.relative] = {
          type: current?.type ?? "movie",
          id: current?.id ?? "",
          source: current?.source ?? "user",
          skipLookup: true,
          ...(current?.locked != null ? { locked: current.locked } : {}),
          ...(current?.name ? { name: current.name } : {}),
          ...(current?.year ? { year: current.year } : {}),
          ...(current?.description ? { description: current.description } : {}),
          ...(current?.matchedAt ? { matchedAt: current.matchedAt } : {}),
        };
      } else if (current?.id) {
        const { skipLookup: _skip, ...kept } = current;
        file.meta[target.relative] = kept;
      } else delete file.meta[target.relative];
    });
    invalidateLibrary();
    log("INFO", body.skipLookup ? "Library path excluded from matching" : "Library path included in matching", { path: requested });
    return { key: wirePath(requestKey), skipLookup: body.skipLookup === true };
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
  const meta = id ? await cachedMeta(type, id) : null;
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
  if (id) saveCatalogPoster(bindKey, episodeRow?.thumbnail ?? meta?.poster);
  log("INFO", "Library title matched", { key: bindKey, type, id: id || null, source: "user", ...(episode != null ? { season: season ?? 1, episode } : {}) });
  return { key: wirePath(bindKey), type, id: id || null };
};

app.post("/api/library/match", asyncRoute(async (req, res) => {
  res.json(await matchLibraryItem(req.body ?? {}));
}));

const parseLibraryOp = (value: unknown): LibraryOp => {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const op = String(body.op ?? "");
  const items = Array.isArray(body.items)
    ? [...new Set(body.items.map((item) => String(item).trim()).filter(Boolean))]
    : [];
  if (!items.length) throw new AppError("At least one library item is required.", "err.missingLibraryItems");
  if (items.length > 500) throw new AppError("A library operation may contain at most 500 items.", "err.tooManyItems");
  if (op === "move" || op === "copy") {
    const target = String(body.target ?? "").trim();
    if (!target) throw new AppError("A destination folder is required.", "err.targetMissing");
    return { op, items, target };
  }
  if (op === "delete" || op === "unmatch" || op === "artwork" || op === "forget") return { op, items };
  if (op === "favorite") return { op, items, favorite: Boolean(body.favorite) };
  if (op === "skipLookup") return { op, items, skipLookup: Boolean(body.skipLookup) };
  if (op === "match") {
    const id = String(body.id ?? "").trim();
    const type = String(body.type ?? "").trim();
    if (!id || !type) throw new AppError("A catalogue title is required.", "err.missingTitleKey");
    return { op, items, type, id };
  }
  throw new AppError("Unknown library operation.", "err.invalidLibraryOperation");
};

const libraryOps = new LibraryOps({
  file: path.join(DATA_DIR, "library-ops.json"),
  pause: async (operation, item) => {
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
    const resolved = await resolveLibraryPath(store.libraries(), item);
    if (!resolved || !resolved.relative) throw new AppError("Invalid path.", "err.invalidPath");
    libraryOpsWriting = operation.op === "move" || operation.op === "copy" || operation.op === "delete";
    try {
      if (operation.op === "move" || operation.op === "copy") {
        return { to: await transferLibraryItem(item, operation.target, operation.op === "copy", progress) };
      }
      if (operation.op === "delete") await deleteLibraryItem(item);
      else if (operation.op === "favorite") await setLibraryFavorite(item, operation.favorite);
      else if (operation.op === "match") await matchLibraryItem({ path: item, type: operation.type, id: operation.id });
      else if (operation.op === "unmatch") await matchLibraryItem({ path: item, type: "movie", id: "" });
      else if (operation.op === "skipLookup") await matchLibraryItem({ path: item, skipLookup: operation.skipLookup });
      else if (operation.op === "forget") {
        await store.update((state) => {
          state.progress = Object.fromEntries(Object.entries(state.progress ?? {}).filter(([key, record]) => {
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
});
await libraryOps.load();

app.get("/api/library/ops", (_req, res) => res.json(libraryOps.snapshot()));
app.post("/api/library/ops", asyncRoute(async (req, res) => {
  const job = await libraryOps.enqueue(parseLibraryOp(req.body));
  res.status(202).json({ id: job.id });
}));
app.delete("/api/library/ops/:id", asyncRoute(async (req, res) => {
  if (!await libraryOps.cancel(String(req.params.id))) throw new AppError("Library operation not found.", "err.libraryOperationMissing", 404);
  res.status(204).end();
}));

/** What the scan proposed and nobody has confirmed yet. */
app.get("/api/library/suggestions", asyncRoute(async (_req, res) => {
  const records = metaStore.qualifiedMeta();
  const items = Object.entries(metaStore.qualifiedSuggestions())
    .filter(([key, suggestion]) => suggestion.id && !knownTitleOf(key, records)?.id && !lookupSkipped(key, records))
    .map(([key, suggestion]) => ({ key: wirePath(key), label: posixBase(key), suggestion }))
    .sort((a, b) => b.suggestion.score - a.suggestion.score);
  res.json({ items, total: items.length });
}));
app.delete("/api/library/suggestion", asyncRoute(async (req, res) => {
  const requested = String(req.query.key ?? "").trim();
  const resolved = requested ? await resolveLibraryPath(store.libraries(), requested) : undefined;
  if (!resolved) throw new AppError("Invalid path.", "err.invalidPath");
  const key = resolved.key;
  const target = parseLibraryPath(key);
  if (target) await metaStore.update(target.libraryId, (file) => {
    const previous = file.suggestions[target.relative];
    // Kept as the memory of a searched unit, so the next scan walks past it.
    file.suggestions[target.relative] = scanMiss(previous?.type === "series" ? "series" : "movie");
  });
  invalidateLibrary();
  res.status(204).end();
}));
app.get("/api/library/scan", (_req, res) => res.json(libraryScan.snapshot()));
app.post("/api/library/scan", asyncRoute(async (req, res) => {
  const requested = String(req.body?.path ?? "").trim();
  const resolved = requested ? await resolveLibraryPath(store.libraries(), requested) : undefined;
  if (requested && !resolved) throw new AppError("Invalid path.", "err.invalidPath");
  const wanted = String(req.body?.libraryId ?? "").trim();
  const library = wanted ? libraryFor(store.libraries(), wanted) : undefined;
  if (wanted && !library) throw new AppError("Unknown library.", "err.unknownLibrary");
  await refreshLibraryHealth();
  // A run somebody asked for reads the tree as it is now: the walk behind it is held in
  // memory for half a minute, and "scan again" must not answer from a listing taken before
  // the file it is meant to find was copied in.
  invalidateLibrary();
  const state = await libraryScan.start({ force: req.body?.force === true, path: resolved?.key ?? "", libraryId: library?.id });
  // A manual run covers the same ground, so the automatic one starts from here too.
  void libraryAutoScan.remember();
  res.json(state);
}));
app.post("/api/library/scan/stop", asyncRoute(async (_req, res) => { await libraryScan.stop(); res.status(204).end(); }));
app.get(["/api/library/next/:sourceId", "/api/library/previous/:sourceId"], asyncRoute(async (req, res) => {
  const source = mediaResources.get(String(req.params.sourceId), ownerOf(req).sid, "source").stream;
  res.setHeader("cache-control", "private, no-store");
  if (!source.url?.startsWith("file://")) return void res.json(null);
  const relative = source.url.slice(7);
  const target = await libraryTarget(relative);
  const next = await nextVideoFile(target, req.path.startsWith("/api/library/previous/") ? -1 : 1);
  res.json(next ? { path: path.posix.join(path.posix.dirname(relative), next), title: next } : null);
}));

app.post("/api/library/source", asyncRoute(async (req, res) => {
  const requested = String(req.body.path ?? "").trim();
  const resolved = requested ? await resolveLibraryPath(store.libraries(), requested) : undefined;
  const target = resolved && await libraryTarget(requested).catch(() => undefined);
  if (!resolved || !target || !(await stat(target).catch(() => undefined))?.isFile()) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
  const relative = resolved.relative;
  const key = resolved.key;
  const directory = path.dirname(target);
  const stem = posixBase(relative).replace(/\.[^.]+$/, "");
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sidecars = (await readdir(directory, { withFileTypes: true })).flatMap((entry) => {
    if (!entry.isFile()) return [];
    const match = new RegExp(`^${escaped}(?:\\.([a-zA-Z]{2,3}))?\\.(?:srt|vtt)$`, "i").exec(entry.name);
    if (!match) return [];
    return [{ url: `file://${path.posix.join(path.posix.dirname(key), entry.name)}`, lang: normalizeLanguage(match[1]) }];
  });
  res.setHeader("cache-control", "private, no-store").json(mediaResources.publicStream({ url: `file://${key}`, subtitles: sidecars, behaviorHints: { filename: path.basename(relative) } }, ownerOf(req)));
}));

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
app.get("/api/downloads", (_req, res) => {
  const snapshot = queue.snapshot();
  res.json({ ...snapshot, jobs: snapshot.jobs.map(jobView) });
});
app.post("/api/downloads", asyncRoute(async (req, res) => {
  const stream = sourceOf(req);
  const media = mediaSource(req.body.media);
  const addon = store.addons().find((item) => item.key === stream.addonKey);
  const settings = addon?.downloadSettings ?? defaultDownloadSettings();
  const targetSettings = media?.kind === "episode" ? settings.series : settings.movie;
  const job = await queue.add(String(req.body.title ?? "video"), stream, media, targetSettings);
  await rememberTitle(job.target, media, targetSettings.layout === "flat");
  const posterKey = titleKey(job.target, media, targetSettings.layout === "flat");
  if (posterKey && posterKey !== ".") saveCatalogPoster(libraryKey(posterKey), media?.poster);
  res.status(201).json(jobView(job));
}));
// Adding episodes in bulk: the jobs are lazy, streams are asked for at download time.
app.post("/api/downloads/bulk", asyncRoute(async (req, res) => {
  const title = String(req.body.title ?? "").trim() || "Show";
  const type = String(req.body.type ?? "series");
  const parent = req.body.media && typeof req.body.media === "object" ? req.body.media as Record<string, unknown> : {};
  const parentId = String(parent.id ?? "").trim() || undefined;
  const poster = posterOf(parent.poster);
  const metaType = String(parent.metaType ?? type).trim() || type;
  const episodes = Array.isArray(req.body.episodes) ? req.body.episodes as Array<Record<string, unknown>> : [];
  if (!episodes.length) throw new AppError("Missing episode list.", "err.missingEpisodes");
  if (episodes.length > 500) throw new AppError("At most 500 episodes at a time.", "err.tooManyEpisodes");
  const rawSelection = req.body.selection && typeof req.body.selection === "object" ? req.body.selection as Record<string, unknown> : {};
  const addonKeys = Array.isArray(rawSelection.addonKeys)
    ? [...new Set(rawSelection.addonKeys.map(String))].filter((key) => store.addons().some((addon) => addon.key === key && addon.enabled && addon.role !== "catalog"))
    : [];
  if (!addonKeys.length) throw new AppError("Pick at least one stream addon.", "err.missingDownloadSources");
  const sourceStrategy = String(rawSelection.sourceStrategy) === "largest" ? "largest" : "priority";
  const audioLanguage = normalizeLanguage(String(rawSelection.audioLanguage ?? ""));
  if (!audioLanguage) throw new AppError("Pick an audio language.", "err.missingAudioLanguage");
  const fallbackAudioLanguage = normalizeLanguage(String(rawSelection.fallbackAudioLanguage ?? ""));
  const subtitleMode: SubtitleMode = ["optional", "required"].includes(String(rawSelection.subtitleMode)) ? String(rawSelection.subtitleMode) as SubtitleMode : "off";
  const subtitleLanguage = subtitleMode === "off" ? undefined : normalizeLanguage(String(rawSelection.subtitleLanguage ?? ""));
  if (subtitleMode !== "off" && !subtitleLanguage) throw new AppError("Pick a subtitle language.", "err.missingSubtitleLanguage");
  const fallbackSubtitleLanguage = subtitleMode === "off" ? undefined : normalizeLanguage(String(rawSelection.fallbackSubtitleLanguage ?? ""));
  const firstAddon = store.addons().find((addon) => addon.key === addonKeys[0]);
  // A source whose addon found no language falls back to the one the title's own metadata names.
  const metaLanguage = parentId ? titleLanguage((await cachedMeta(metaType, parentId))?.language) : undefined;
  const selection: DownloadSelection = {
    addonKeys, sourceStrategy, audioLanguage,
    fallbackAudioLanguage: fallbackAudioLanguage === audioLanguage ? undefined : fallbackAudioLanguage,
    titleLanguage: metaLanguage,
    subtitleMode, subtitleLanguage,
    fallbackSubtitleLanguage: fallbackSubtitleLanguage === subtitleLanguage ? undefined : fallbackSubtitleLanguage,
    targetSettings: firstAddon?.downloadSettings.series ?? defaultDownloadSettings().series,
  };
  let added = 0, skipped = 0;
  for (const episode of episodes) {
    const videoId = String(episode.id ?? "").trim();
    if (!videoId) { skipped += 1; continue; }
    const season = episode.season == null ? undefined : Number(episode.season);
    const number = episode.episode == null ? undefined : Number(episode.episode);
    const episodeTitle = episode.title ? String(episode.title) : undefined;
    const jobTitle = `${title} · ${episodeTitle ?? (season != null ? `S${String(season).padStart(2, "0")}E${String(number ?? 0).padStart(2, "0")}` : `Episode ${number ?? "?"}`)}`;
    const media: MediaInfo = { kind: "episode", title, season, episode: number, episodeTitle, id: parentId, metaType, poster };
    const job = await queue.addPending(jobTitle, { type, videoId, selection }, media);
    if (job) added += 1; else skipped += 1;
  }
  log("INFO", "Bulk addition to the queue", { title, added, skipped });
  res.status(201).json({ added, skipped });
}));
app.post("/api/downloads/:id/pause", asyncRoute(async (req, res) => { await queue.pause(String(req.params.id)); res.status(204).end(); }));
app.post("/api/downloads/:id/resume", asyncRoute(async (req, res) => { await queue.resume(String(req.params.id)); res.status(204).end(); }));
app.post("/api/downloads/:id/retry", asyncRoute(async (req, res) => { await queue.retry(String(req.params.id)); res.status(204).end(); }));
app.post("/api/downloads/:id/move", asyncRoute(async (req, res) => { await queue.move(String(req.params.id), Number(req.body.direction) < 0 ? -1 : 1); res.status(204).end(); }));
app.delete("/api/downloads/:id", asyncRoute(async (req, res) => { await queue.remove(String(req.params.id)); res.status(204).end(); }));
app.delete("/api/downloads", asyncRoute(async (_req, res) => { await queue.clearCompleted(); res.status(204).end(); }));
app.get("/api/settings", (_req, res) => res.json(publicSettings(store.settings())));
app.get("/api/stats", (req, res) => res.json(stats.summary(Number(req.query.hours) || 720)));
/** Playback running at this moment. The statistics otherwise look backwards; this is the
 * one view of what the line is carrying right now. */
app.get("/api/stats/streams", (_req, res) => res.json(playback.active().map((session) => {
  const meta = playbackMeta(session.stream);
  const { bytes, rate } = throughput.read(session.id);
  return {
    id: session.id,
    title: safeSourceText(sourceTitle(session.stream), session.stream) || meta.title,
    source: meta.source,
    provider: meta.source === "library" ? undefined : meta.provider,
    addonName: safeSourceText(session.stream.addonName, session.stream),
    mode: session.mode, hardware: session.hardware, quality: session.quality,
    duration: session.duration, startedAt: session.startedAt, idleSeconds: session.idleSeconds,
    bytes, rate,
  };
})));
app.get("/api/logs", asyncRoute(async (req, res) => {
  const tail = Math.max(0, Math.min(5000, Number(req.query.tail) || 0));
  const hours = Math.max(0, Math.min(24 * 365, Number(req.query.hours) || 0));
  const search = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  const text = await readLog({ tail: tail || undefined, level: parseLevel(req.query.level), hours: hours || undefined, search: search || undefined });
  res.type("text/plain; charset=utf-8");
  // Viewing in the interface wants text in the window; downloading wants a file.
  if (req.query.inline !== "1") res.setHeader("content-disposition", "attachment; filename=stremio-offline.log");
  res.send(text);
}));
app.delete("/api/logs", asyncRoute(async (req, res) => {
  await clearLog();
  log("INFO", "Log cleared from the interface", { user: currentUser(req) });
  res.status(204).end();
}));

/** The browser is the only place where playback failure is actually visible. Without this
 * channel hls.js and video element errors end up in a console the user never opens. */
const CLIENT_LOG_PER_MINUTE = 30;
const clientReports = new Map<string, { count: number; resetAt: number }>();
app.post("/api/client-log", (req, res) => {
  const now = Date.now();
  const who = currentUser(req) ?? req.ip ?? "anonymous";
  const bucket = clientReports.get(who);
  if (!bucket || bucket.resetAt <= now) clientReports.set(who, { count: 1, resetAt: now + 60_000 });
  // A looping player can report an error a hundred times a second; the excess is dropped quietly.
  else if (bucket.count >= CLIENT_LOG_PER_MINUTE) return void res.status(204).end();
  else bucket.count += 1;
  if (clientReports.size > 200) for (const [key, value] of clientReports) if (value.resetAt <= now) clientReports.delete(key);

  const level = parseLevel(req.body?.level) ?? "WARN";
  const message = String(req.body?.message ?? "").slice(0, 200) || "client report";
  const context = req.body?.context && typeof req.body.context === "object" && !Array.isArray(req.body.context)
    ? req.body.context as Record<string, unknown> : {};
  log(level, `[web] ${message}`, { ...context, req: req.id, user: currentUser(req), ua: String(req.headers["user-agent"] ?? "").slice(0, 160) });
  res.status(204).end();
});

const freeSpace = async (target: string) => {
  try { const info = await statfs(target); return { path: target, freeBytes: info.bavail * info.bsize, totalBytes: info.blocks * info.bsize }; }
  catch { return { path: target }; }
};
/** Server state for troubleshooting. It does not belong in /api/status, which needs no sign-in. */
app.get("/api/diagnostics", asyncRoute(async (_req, res) => {
  const jobs = queue.list();
  const byStatus: Record<string, number> = {};
  for (const job of jobs) byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
  res.json({
    ...build,
    node: process.version,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    logLevel: currentLevel(),
    logRetentionDays: Math.max(0, Number(process.env.LOG_RETENTION_DAYS ?? 7) || 0),
    playback: playback.diagnostics(),
    downloads: {
      total: jobs.length, byStatus,
      halt: queue.haltInfo(),
      failed: jobs.filter((job) => job.status === "failed").slice(0, 10).map((job) => ({ id: job.id, title: job.title, error: job.error, errorKey: job.errorKey })),
    },
    addons: store.addons().map((addon) => ({ name: addon.manifest.name, role: addon.role, enabled: addon.enabled })),
    outbound: outbound.diagnostics(),
    libraryScan: libraryScan.snapshot(),
    storage: [await freeSpace(DATA_DIR), ...await Promise.all(store.libraries().map((library) => freeSpace(library.root)))],
  });
}));

app.get("/api/settings/export", asyncRoute(async (_req, res) => {
  await metaStore.flush();
  res.setHeader("content-disposition", `attachment; filename=stremio-offline-settings-${new Date().toISOString().slice(0, 10)}.json`);
  res.json(createSettingsBackup(store.settings(), store.addons(), store.libraries()));
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
    state.settings = backup.settings;
    state.addons = loaded;
    state.defaultsInstalled = true;
  });
  streamCache.clear();
  queue.changed();
  log("INFO", "Settings backup imported", { addons: loaded.length, version: backup.version, remapped: parsed.remaps.length });
  res.json({ settings: publicSettings(store.settings()), addons: store.addons().map(publicAddon), remapped: parsed.remaps.length });
}));
app.patch("/api/settings", asyncRoute(async (req, res) => {
  let realDebridToken: string | undefined;
  if (req.body.realDebridToken !== undefined) {
    realDebridToken = normalizeToken(req.body.realDebridToken);
    if (realDebridToken) await verifyRealDebridToken(realDebridToken);
  }
  await store.update((state) => {
    if (req.body.concurrentDownloads !== undefined) state.settings.concurrentDownloads = Math.max(1, Math.min(8, Number(req.body.concurrentDownloads) || 1));
    if (req.body.parallelPerProvider !== undefined) state.settings.parallelPerProvider = Math.max(1, Math.min(8, Number(req.body.parallelPerProvider) || 1));
    if (req.body.downloadSegments !== undefined) state.settings.downloadSegments = Math.max(1, Math.min(8, Number(req.body.downloadSegments) || 1));
    if (req.body.uiLanguage !== undefined && isUiLanguage(req.body.uiLanguage)) state.settings.uiLanguage = req.body.uiLanguage;
    if (req.body.audioLanguage !== undefined) state.settings.audioLanguage = normalizeLanguage(String(req.body.audioLanguage)) ?? state.settings.audioLanguage;
    if (req.body.subtitleLanguage !== undefined) state.settings.subtitleLanguage = normalizeLanguage(String(req.body.subtitleLanguage)) ?? state.settings.subtitleLanguage;
    if (req.body.downloadTitleLanguage !== undefined) state.settings.downloadTitleLanguage = req.body.downloadTitleLanguage === "ui" ? "ui" : normalizeLanguage(String(req.body.downloadTitleLanguage)) ?? state.settings.downloadTitleLanguage;
    if (req.body.mergeByName !== undefined) state.settings.mergeByName = Boolean(req.body.mergeByName);
    if (req.body.trackProgress !== undefined) state.settings.trackProgress = Boolean(req.body.trackProgress);
    if (req.body.showResumeRow !== undefined) state.settings.showResumeRow = Boolean(req.body.showResumeRow);
    if (req.body.libraryAutoScan !== undefined) state.settings.libraryAutoScan = Boolean(req.body.libraryAutoScan);
    if (req.body.libraryScanPauseOnDownload !== undefined) state.settings.libraryScanPauseOnDownload = Boolean(req.body.libraryScanPauseOnDownload);
    // Detail has to be recorded before it can be read: a line the server never wrote is not
    // something the log view can filter back into sight.
    if (req.body.logLevel !== undefined) {
      const wanted = parseLevel(req.body.logLevel);
      state.settings.logLevel = wanted;
      setLevel(wanted ?? parseLevel(process.env.LOG_LEVEL) ?? "INFO");
      log("INFO", "The server log level was changed from the interface", { level: currentLevel(), user: currentUser(req) });
    }
    if (req.body.secureMode !== undefined) state.settings.secureMode = Boolean(req.body.secureMode);
    if (req.body.addonRefreshHours !== undefined) state.settings.addonRefreshHours = normalizeRefreshHours(req.body.addonRefreshHours);
    if (req.body.streamSort !== undefined) {
      const value = String(req.body.streamSort);
      state.settings.streamSort = STREAM_SORTS.has(value) ? value : "recommended";
    }
    if (req.body.catalogTileSize !== undefined) {
      const value = String(req.body.catalogTileSize);
      state.settings.catalogTileSize = value === "compact" || value === "small" || value === "large" ? value : "medium";
    }
    if (req.body.libraryTileSize !== undefined) {
      const value = String(req.body.libraryTileSize);
      state.settings.libraryTileSize = value === "compact" || value === "small" || value === "large" ? value : "medium";
    }
    if (realDebridToken !== undefined) state.settings.realDebridToken = realDebridToken;
  });
  queue.changed(); res.json(publicSettings(store.settings()));
}));
app.get("/api/languages", (_req, res) => res.json(Object.entries(LANGUAGE_NAMES).map(([code, name]) => ({ code, name }))));
app.post("/api/inspect", asyncRoute(async (req, res) => {
  const stream = await httpSourceOf(req);
  const info = await playback.inspect(stream);
  res.setHeader("cache-control", "private, no-store").json(safeInspection(info, stream));
}));
app.post("/api/playback", asyncRoute(async (req, res) => {
  const settings = store.settings();
  const options: PlaybackOptions = { audioLanguage: settings.audioLanguage, subtitleLanguage: settings.subtitleLanguage };
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
  log("INFO", "Playback session closed by the player", { id: String(req.params.id), user: currentSession(req)?.username });
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
      req: req.id, method: req.method, path: req.path, status: 403, user: currentUser(req),
    });
  } else {
    log("ERROR", "Request failed", {
      req: req.id, method: req.method, path: req.path, status,
      user: currentUser(req), reason: message,
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
  const mediaRoute = /^(?:\/api)?\/(?:media|playback|inspect|streams|subtitle|subtitles|device-download|library\/source)(?:\/|$)/.test(req.path);
  const hideDetails = mediaRoute && !(error instanceof ResourceError) && status >= 500;
  res.status(hideDetails ? 502 : status).json({
    error: hideDetails ? "Media source request failed." : message,
    code: error instanceof ResourceError ? error.code : undefined,
    messageKey: hideDetails ? undefined : messageKeyOf(error),
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
