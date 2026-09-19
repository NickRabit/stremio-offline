import type express from "express";
import { normalizeRefreshHours } from "../addon-refresh.js";
import { loadAddon } from "../addons.js";
import { createSettingsBackup, parseSettingsBackup, remapBackupLibraries } from "../backup.js";
import { normalizeToken, verifyRealDebridToken } from "../debrid.js";
import type { DownloadQueue } from "../downloads.js";
import { LANGUAGE_NAMES, isUiLanguage, normalizeLanguage } from "../language.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import { currentLevel, log, parseLevel, setLevel } from "../logger.js";
import { publicAddon } from "../security.js";
import { publicSettings, type InstanceSettings, type Settings, type State, type UserPrefs } from "../store.js";
import { verifyTmdbKey } from "../tmdb.js";
import { clearTrailerCache } from "../trailers.js";
import type { MetaItem, StreamItem } from "../types.js";
import { PERSONAL_SETTINGS, type UserData } from "../users.js";
import { asyncRoute, type RouteContext } from "./context.js";

/** The instance settings, one person's own preferences and the backup that carries both. */
export interface SettingsDeps extends RouteContext {
  STREAM_SORTS: Set<string>;
  accountIdOf(req?: express.Request): string | undefined;
  invalidateLibrary(): void;
  metaCache: Map<string, { value: MetaItem | null; at: number }>;
  metaStore: LibraryMetaStore;
  mutateData(state: State, id: string, mutate: (data: UserData) => void): void;
  prefsOf(req?: express.Request): UserPrefs;
  queue: DownloadQueue;
  streamCache: Map<string, { at: number; items: StreamItem[] }>;
}

export function registerSettingsRoutes(app: express.Application, deps: SettingsDeps): void {
  const { store, STREAM_SORTS, accountIdOf, currentUser, invalidateLibrary, metaCache, metaStore, mutateData, prefsOf, queue, streamCache } = deps;

  /** The one flat object the interface reads: the instance's settings and the caller's own. */
  const settingsView = (req: express.Request) => ({ ...publicSettings(store.settings()), ...prefsOf(req) });
  app.get("/api/settings", (req, res) => res.json(settingsView(req)));

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
}
