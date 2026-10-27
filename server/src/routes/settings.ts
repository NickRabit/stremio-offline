import { randomUUID } from "node:crypto";
import type express from "express";
import { addonIdentity } from "../addon-identity.js";
import { normalizeRefreshHours } from "../addon-refresh.js";
import { allowedAddons, loadAddon } from "../addons.js";
import { createSettingsBackup, parseSettingsBackup, remapBackupLibraries } from "../backup.js";
import { normalizeToken, verifyRealDebridToken } from "../debrid.js";
import type { DownloadQueue } from "../downloads.js";
import { AppError } from "../errors.js";
import { MEDIA_SERVER_CONFIGURATION_MAX_BYTES } from "../media-server-store.js";
import type { MediaServerAuthority, MediaServerManager } from "../media-server-manager.js";
import { ResourceError } from "../media-resources.js";
import { homeCatalogOfferings } from "../home-catalogs.js";
import { HOME_LAYOUT_FEED_LIMIT, HOME_LAYOUT_ROW_LIMIT, homeCatalogRowId, homeFeedSelectionKey, homeRowOrder, parseHomeLayout } from "../home.js";
import { LANGUAGE_NAMES, isUiLanguage, normalizeLanguage } from "../language.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import { currentLevel, log, parseLevel, setLevel } from "../logger.js";
import { publicAddon } from "../security.js";
import { assertStillAdmin, ForbiddenError } from "../roles.js";
import {
  declaresStream,
  SOURCE_PROFILE_IDS,
  sourceProfilesForViewer,
  viewerOfProfileAccount,
  type ProviderPriorityParameters,
  type SourceProfileTemplate,
  type TravelParameters,
} from "../source-profiles.js";
import { memberSettings, publicSettings, type InstanceSettings, type Settings, type State, type StoredSourceProfile, type UserPrefs } from "../store.js";
import { verifyTmdbKey } from "../tmdb.js";
import { clearTrailerCache } from "../trailers.js";
import type { MetaItem } from "../types.js";
import { PERSONAL_SETTINGS, type UserData, type UserRecord } from "../users.js";
import { asyncRoute, type RouteContext } from "./context.js";

/** The instance settings, one person's own preferences and the backup that carries both. */
export interface SettingsDeps extends RouteContext {
  STREAM_SORTS: Set<string>;
  accountIdOf(req?: express.Request): string | undefined;
  invalidateLibrary(): void;
  /** The media-server configuration the backup carries. A settings export is an
   *  administrator's act like every other read of it. */
  mediaServers: MediaServerManager;
  metaCache: Map<string, { value: MetaItem | null; at: number }>;
  metaStore: LibraryMetaStore;
  mutateData(state: State, id: string, mutate: (data: UserData) => void): void;
  prefsOf(req?: express.Request): UserPrefs;
  queue: DownloadQueue;
  streamCache: { clear(): void };
}

interface SourceProfileImportSummary {
  imported: number;
  reused: number;
  renamed: number;
  dormant: string[];
}

const BUILT_IN_PROFILE_NAMES: Record<SourceProfileTemplate, string> = {
  recommended: "Recommended",
  providerPriority: "Addon order, verified",
  travel: "Travel (small files)",
};
const BUILT_IN_PROFILE_IDS = new Set<string>(Object.values(SOURCE_PROFILE_IDS));

const sameParameters = (
  left: StoredSourceProfile["parameters"],
  right: StoredSourceProfile["parameters"],
): boolean => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const sameProfileDefinition = (left: StoredSourceProfile, right: StoredSourceProfile): boolean =>
  left.template === right.template
  && left.revision === right.revision
  && sameParameters(left.parameters, right.parameters)
  && left.name === right.name
  && left.nameKey === right.nameKey;

const remapProfileAddonKeys = (
  profile: StoredSourceProfile,
  installedKeys: ReadonlySet<string>,
): StoredSourceProfile | undefined => {
  if (profile.parameters === undefined) return structuredClone(profile);
  const parameters = structuredClone(profile.parameters) as TravelParameters | ProviderPriorityParameters;
  if (parameters.scope.mode === "selected") {
    parameters.scope.addonKeys = parameters.scope.addonKeys.filter((key) => installedKeys.has(key));
    if (!parameters.scope.addonKeys.length) return undefined;
  }
  if ("addonKeys" in parameters.providerOrder) {
    parameters.providerOrder.addonKeys = parameters.providerOrder.addonKeys.filter((key) => installedKeys.has(key));
  }
  return { ...structuredClone(profile), parameters };
};

const importedProfileName = (
  base: string,
  forceSuffix: boolean,
  profiles: readonly StoredSourceProfile[],
): { name: string; renamed: boolean } => {
  for (let suffix = forceSuffix ? 1 : 0; ; suffix += 1) {
    const tail = suffix === 0 ? "" : ` (imported${suffix === 1 ? "" : ` ${suffix}`})`;
    const name = suffix === 0 ? base : `${base.slice(0, 60 - tail.length).trimEnd()}${tail}`;
    if (!profiles.some((profile) => profile.name?.toLowerCase() === name.toLowerCase())) {
      return { name, renamed: suffix > 0 };
    }
  }
};

const restoreSourceProfiles = (
  state: State,
  profiles: readonly StoredSourceProfile[],
  deletedIds: readonly string[],
): {
  idMap: Map<string, string>;
  summary: SourceProfileImportSummary;
} => {
  const localProfiles = [...(state.sourceProfiles ?? [])];
  const tombstones = new Set([...(state.deletedSourceProfileIds ?? []), ...deletedIds]);
  const installedKeys = new Set(state.addons.filter(declaresStream).map((addon) => addon.key));
  const idMap = new Map<string, string>();
  const summary: SourceProfileImportSummary = { imported: 0, reused: 0, renamed: 0, dormant: [] };

  for (const original of profiles) {
    const sourceName = original.name ?? BUILT_IN_PROFILE_NAMES[original.template];
    const mapped = remapProfileAddonKeys(original, installedKeys);
    if (mapped === undefined) {
      summary.dormant.push(sourceName);
      continue;
    }

    const collision = localProfiles.find((profile) => profile.id === mapped.id);
    const builtInId = BUILT_IN_PROFILE_IDS.has(mapped.id);
    const builtInEqual = builtInId && collision !== undefined
      && collision.revision === mapped.revision
      && sameParameters(collision.parameters, mapped.parameters);
    if (builtInEqual || (collision !== undefined && sameProfileDefinition(collision, mapped))) {
      idMap.set(original.id, collision.id);
      summary.reused += 1;
      continue;
    }

    const preserveId = collision === undefined && !tombstones.has(mapped.id);
    let id = preserveId ? mapped.id : randomUUID();
    const used = new Set([...localProfiles.map((profile) => profile.id), ...tombstones, ...idMap.values()]);
    while (used.has(id)) id = randomUUID();
    const builtInVariant = builtInId && !builtInEqual;
    const named = importedProfileName(
      builtInVariant ? BUILT_IN_PROFILE_NAMES[mapped.template] : mapped.name!,
      builtInVariant,
      localProfiles,
    );
    const imported: StoredSourceProfile = { ...structuredClone(mapped), id, name: named.name };
    if (builtInVariant) delete imported.nameKey;
    localProfiles.push(imported);
    idMap.set(original.id, id);
    summary.imported += 1;
    if (named.renamed) summary.renamed += 1;
  }

  const live = new Set(localProfiles.map((profile) => profile.id));
  state.sourceProfiles = localProfiles;
  state.deletedSourceProfileIds = [...tombstones].filter((id) => !live.has(id));
  return { idMap, summary };
};

export function registerSettingsRoutes(app: express.Application, deps: SettingsDeps): void {
  const { store, STREAM_SORTS, accountIdOf, currentUser, invalidateLibrary, mediaServers, metaCache, metaStore, mutateData, prefsOf, queue, requireAccess, stopContentAccess, streamCache } = deps;

  /** The acting account as the media-server surface reads it: the captured id and secret with
   *  the route's own access gate re-run on every check. */
  const authorityOf = (req: express.Request): MediaServerAuthority => {
    const user = currentUser(req);
    if (!user) throw new ResourceError(401, "AUTH_REQUIRED");
    return { actor: { id: user.id, secret: user.secret }, assertCurrent: () => requireAccess(req) };
  };

  /** The one flat object the interface reads: the instance's settings and the caller's own.
   *  An ordinary account is answered with its own half and the two instance flags the
   *  ordinary interface behaves on -- see `memberSettings`. Not rendering the instance
   *  panels was never enough on its own: a control the interface hides is still a value the
   *  endpoint handed out, and this is where it was read from. */
  const settingsView = (req: express.Request) => {
    const instance = publicSettings(store.settings());
    return { ...(currentUser(req)?.role === "admin" ? instance : memberSettings(instance)), ...prefsOf(req) };
  };
  const offeredDownloadProfiles = (state: State, actor: UserRecord | undefined) => actor
    ? sourceProfilesForViewer({
        viewer: viewerOfProfileAccount(actor),
        profiles: state.sourceProfiles ?? [],
        addons: state.addons,
        libraries: state.libraries ?? [],
        remoteLibraries: state.remoteLibraries ?? [],
        mediaConnections: state.mediaConnections ?? [],
      }).filter((profile) => profile.operations.includes("downloadToLibrary"))
    : [];
  app.get("/api/settings", (req, res) => res.json(settingsView(req)));

  /** The backup file carries both halves of the settings in one flat object, the way the
   *  interface reads them, so an import has to put every key back where it now belongs. The
   *  two halves are spelled out rather than looped over `PERSONAL_SETTINGS`, so a key added
   *  to one of them and forgotten here fails the build. */
  const splitSettings = (flat: Settings): { instance: InstanceSettings; prefs: Partial<UserPrefs> } => {
    const {
      uiLanguage, audioLanguage, subtitleLanguage, downloadTitleLanguage,
      mergeByName, streamSort, trackProgress, showResumeRow,
      tileSize, catalogTileShape, libraryTileShape, favoritesTileShape, resumeTileShape, followingTileShape, homeTileShape, searchTileShape, startView, libraryShelf,
      homeLayout, downloadSourceProfile,
      ...instance
    } = flat;
    return {
      instance,
      prefs: { uiLanguage, audioLanguage, subtitleLanguage, downloadTitleLanguage, mergeByName, streamSort, trackProgress, showResumeRow, tileSize, catalogTileShape, libraryTileShape, favoritesTileShape, resumeTileShape, followingTileShape, homeTileShape, searchTileShape, startView, libraryShelf, ...(homeLayout ? { homeLayout } : {}), ...(downloadSourceProfile ? { downloadSourceProfile } : {}) },
    };
  };

  app.get("/api/settings/export", asyncRoute(async (req, res) => {
    // Read before anything is awaited: the media-server half of the file is an administrator's
    // read, and an account signed out while the export waited must not be the one that lands in
    // it. The same captured identity answers the access gate and the configuration read.
    const authority = authorityOf(req);
    mediaServers.exportConfiguration(authority);
    await metaStore.flush();
    const mediaServersView = mediaServers.exportConfiguration(authority);
    res.setHeader("content-disposition", `attachment; filename=stremio-offline-settings-${new Date().toISOString().slice(0, 10)}.json`);
    res.json(createSettingsBackup(
      { ...store.settings(), ...prefsOf(req) },
      store.addons(),
      store.libraries(),
      mediaServersView,
      { profiles: store.sourceProfiles(), deletedIds: store.deletedSourceProfileIds() },
    ));
  }));
  app.post("/api/settings/import", asyncRoute(async (req, res) => {
    // Captured before the manifests are fetched: read again inside the mutator it would
    // answer `undefined` for an account switched off or signed out while this waited, and a
    // record compared against itself proves nothing.
    const actor = currentUser(req);
    // The libraries are this instance's, so a rule that names one from somewhere else is
    // remapped before anything is written: by root first, then by name.
    const parsed = remapBackupLibraries(parseSettingsBackup(req.body), store.libraries());
    for (const remap of parsed.remaps) {
      log("INFO", "A save rule named a library this instance does not have", { what: remap.what, addon: remap.addon, from: remap.from, to: remap.to ?? "default" });
    }
    const backup = { ...parsed, libraries: [] };
    // The remote setup a version 3 backup carries rides in the same write as the settings; a
    // file from before then leaves the current one exactly as it is. Its size is bounded like
    // the media-server import's own, so a file can never smuggle an unbounded roster in.
    const mediaServersToRestore = parsed.mediaServers;
    if (mediaServersToRestore !== undefined
      && Buffer.byteLength(JSON.stringify(mediaServersToRestore), "utf8") > MEDIA_SERVER_CONFIGURATION_MAX_BYTES) {
      throw new AppError("The media server configuration in the backup is too large.", "err.invalidRequest", 413);
    }
    // Manifests are loaded before a single write, so a broken backup changes no part of the configuration.
    const loaded = await Promise.all(backup.addons.map(async (saved, index) => {
      try {
        const addon = await loadAddon(saved.manifestUrl, saved.role);
        addon.enabled = saved.enabled;
        addon.globalSearch = saved.globalSearch;
        addon.showOnHome = saved.showOnHome !== false;
        if (saved.homeCatalogs !== undefined) {
          const known = new Set(addon.manifest.catalogs?.map((catalog) => `${encodeURIComponent(catalog.type)}:${encodeURIComponent(catalog.id)}`) ?? []);
          addon.homeCatalogs = saved.homeCatalogs.filter((key) => known.has(key));
        }
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
    // The list as it is on either side of the write, read from the state the write lands on:
    // the sweep below needs the transition that really happened, not an earlier read.
    let before: Array<{ key: string; enabled: boolean; identity: string }> = [];
    let sourceProfileSummary: SourceProfileImportSummary = { imported: 0, reused: 0, renamed: 0, dormant: [] };
    const applySettings = (state: State) => {
      // Every manifest was fetched before this point, which is ample time for the gate's
      // answer to go stale.
      assertStillAdmin(state.users ?? [], actor);
      before = state.addons.map((addon) => ({
        key: addon.key,
        enabled: addon.enabled,
        identity: addonIdentity(addon),
      }));
      // A backup carries the instance's configuration, not its accounts: the ids in a grant
      // list belong to this install and would mean nothing in a backup taken from another. So
      // the grants are not read from the file -- they are kept from the record this state holds
      // for the same manifest right now, which is what stops an import of one's own backup
      // quietly taking every addon away from every ordinary account, and what keeps a grant an
      // edit changed while the manifests were fetched. The key is kept for the same reason: it
      // is what a grant and a personal order both point at.
      const held = new Map(state.addons.map((addon) => [`${addon.manifest.id}\n${addon.manifestUrl}`, addon]));
      for (const addon of loaded) {
        const record = held.get(`${addon.manifest.id}\n${addon.manifestUrl}`);
        if (!record) continue;
        addon.key = record.key;
        if (record.allowedUsers) addon.allowedUsers = record.allowedUsers;
      }
      const split = splitSettings(backup.settings);
      state.settings = split.instance;
      state.addons = loaded;
      state.defaultsInstalled = true;
      let profileIdMap = new Map<string, string>();
      if (backup.sourceProfiles !== undefined) {
        const restored = restoreSourceProfiles(
          state,
          backup.sourceProfiles.profiles,
          backup.sourceProfiles.deletedIds,
        );
        profileIdMap = restored.idMap;
        sourceProfileSummary = restored.summary;
        const requested = split.prefs.downloadSourceProfile;
        if (requested !== undefined) {
          const mapped = profileIdMap.get(requested);
          if (mapped) split.prefs.downloadSourceProfile = mapped;
          else delete split.prefs.downloadSourceProfile;
        }
      }
      if (split.prefs.downloadSourceProfile && !offeredDownloadProfiles(state, actor).some((profile) => profile.id === split.prefs.downloadSourceProfile)) {
        delete split.prefs.downloadSourceProfile;
      }
      const userId = accountIdOf(req);
      if (userId) mutateData(state, userId, (data) => { data.prefs = { ...data.prefs, ...split.prefs }; });
      if (backup.sourceProfiles !== undefined) {
        const live = new Set((state.sourceProfiles ?? []).map((profile) => profile.id));
        for (const data of state.userData ? Object.values(state.userData) : []) {
          const selected = data.prefs.downloadSourceProfile;
          if (typeof selected === "string" && selected && !live.has(selected)) {
            delete data.prefs.downloadSourceProfile;
          }
        }
      }
    };
    if (mediaServersToRestore === undefined) {
      await store.update(applySettings);
    } else {
      // Both halves of the file land in one update: the settings and addons the route writes
      // and the remote configuration the manager replaces, so a refusal leaves neither behind.
      await mediaServers.restoreSettingsConfiguration(authorityOf(req), mediaServersToRestore, applySettings);
    }
    streamCache.clear();
    queue.changed();
    // An import is also a removal and a switch-off: an addon the backup does not carry is gone
    // for everybody, and one it carries switched off is unusable. Both have to reach what is
    // already running on them, which no counter records.
    for (const addon of before) {
      const after = store.addons().find((item) => item.key === addon.key);
      if (addon.enabled && (!after || !after.enabled || addon.identity !== addonIdentity(after))) {
        await stopContentAccess({ addonKey: addon.key });
      }
    }
    log("INFO", "Settings backup imported", {
      addons: loaded.length,
      version: backup.version,
      remapped: parsed.remaps.length,
      sourceProfiles: sourceProfileSummary,
    });
    res.json({
      settings: settingsView(req),
      addons: store.addons().map(publicAddon),
      remapped: parsed.remaps.length,
      sourceProfiles: sourceProfileSummary,
    });
  }));
  app.patch("/api/settings", asyncRoute(async (req, res) => {
    // The path is open to an ordinary user, the instance keys are not: a body that names
    // any of them is refused whole, rather than answered with a success that changed nothing.
    const body = (req.body ?? {}) as Record<string, unknown>;
    const touchesInstance = Object.keys(body).some((key) => !(PERSONAL_SETTINGS as readonly string[]).includes(key));
    // Captured here, before the token checks go out over the network: read again at the write
    // it would answer nobody for an account switched off or signed out while they ran.
    const actor = currentUser(req);
    if (actor?.role !== "admin" && touchesInstance) throw new ForbiddenError();
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
    // The shape is checked before the write so a malformed body is refused whole; a
    // well-formed one that names a feed the caller may not use has that feed dropped below.
    // A body whose arrays are larger than any account could arrange is refused too, so a
    // client cannot persist far more ids than there are rows.
    const postedLayout = req.body.homeLayout !== undefined && req.body.homeLayout !== null ? parseHomeLayout(req.body.homeLayout) : undefined;
    if (req.body.homeLayout !== undefined && req.body.homeLayout !== null
      && (!postedLayout || postedLayout.order.length > HOME_LAYOUT_ROW_LIMIT || postedLayout.hidden.length > HOME_LAYOUT_ROW_LIMIT || postedLayout.feeds.length > HOME_LAYOUT_FEED_LIMIT)) {
      throw new AppError("A Home layout must list an order, the hidden rows and the feeds.", "err.homeLayoutShape", 400);
    }
    const postedProfile = req.body.downloadSourceProfile;
    if (postedProfile !== undefined && postedProfile !== null && typeof postedProfile !== "string") {
      throw new AppError("This source profile is not available to this account.", "err.sourceProfileUnavailable", 400);
    }
    await store.update((state) => {
      // Only when the body reaches the instance half: an ordinary account writing its own
      // preferences is not making an administrator's change and must not be asked to be one.
      if (touchesInstance) assertStillAdmin(state.users ?? [], actor);
      // The body is one flat object; each key goes to the half that owns it. Only the keys the
      // body names are written, so a preference nobody touched keeps the value it had.
      const prefs: Record<string, unknown> = { ...(userId ? state.userData?.[userId]?.prefs : undefined) };
      if (postedProfile && !offeredDownloadProfiles(state, actor).some((profile) => profile.id === postedProfile)) {
        throw new AppError("This source profile is not available to this account.", "err.sourceProfileUnavailable", 400);
      }
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
      if (req.body.tileSize !== undefined) {
        const value = String(req.body.tileSize);
        prefs.tileSize = value === "compact" || value === "small" || value === "large" ? value : "medium";
      }
      if (req.body.catalogTileShape !== undefined) {
        prefs.catalogTileShape = String(req.body.catalogTileShape) === "wide" ? "wide" : "poster";
      }
      if (req.body.libraryTileShape !== undefined) {
        prefs.libraryTileShape = String(req.body.libraryTileShape) === "wide" ? "wide" : "poster";
      }
      for (const key of ["favoritesTileShape", "resumeTileShape", "followingTileShape", "searchTileShape"] as const) {
        if (req.body[key] !== undefined) prefs[key] = String(req.body[key]) === "wide" ? "wide" : "poster";
      }
      if (req.body.homeTileShape !== undefined) {
        prefs.homeTileShape = String(req.body.homeTileShape) === "wide" ? "wide" : "poster";
      }
      if (req.body.startView !== undefined) {
        const value = String(req.body.startView);
        prefs.startView = value === "catalog" || value === "library" ? value : "home";
      }
      if (req.body.libraryShelf !== undefined) {
        const value = String(req.body.libraryShelf);
        prefs.libraryShelf = value === "episodes" || value === "favorites" ? value : "resume";
      }
      if (req.body.homeLayout !== undefined) {
        if (req.body.homeLayout === null) {
          delete prefs.homeLayout;
        } else {
          const parsed = parseHomeLayout(req.body.homeLayout)!;
          const usable = actor ? allowedAddons(state.addons, { id: actor.id, role: actor.role }) : [];
          const offerings = homeCatalogOfferings(usable);
          const valid = new Set(offerings.map((target) => homeFeedSelectionKey(target.addon.key, target.definition.type, target.definition.id)));
          // Only ids the account could actually arrange are kept: the built-ins it may have and
          // every catalogue its usable addons offer (its own feeds are a subset of those).
          const arrangeable = new Set<string>([
            ...homeRowOrder(actor?.role === "admin", []).map((entry) => entry.id),
            ...offerings.map((target) => homeCatalogRowId(target.addon.key, target.definition.type, target.definition.id)),
          ]);
          const ids = (values: string[]) => [...new Set(values)].filter((id) => arrangeable.has(id)).slice(0, HOME_LAYOUT_ROW_LIMIT);
          prefs.homeLayout = {
            order: ids(parsed.order),
            hidden: ids(parsed.hidden),
            feeds: [...new Set(parsed.feeds.filter((key) => valid.has(key)))].slice(0, HOME_LAYOUT_FEED_LIMIT),
          };
        }
      }
      if (postedProfile !== undefined) {
        if (postedProfile) prefs.downloadSourceProfile = postedProfile;
        else delete prefs.downloadSourceProfile;
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
}
