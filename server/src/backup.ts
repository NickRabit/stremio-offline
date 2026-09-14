import type { AddonDownloadSettings, AddonRecord, AddonRole } from "./types.js";
import { normalizeDownloadSettings } from "./naming.js";
import { defaultSettings, type Settings } from "./store.js";
import { isUiLanguage, normalizeLanguage } from "./language.js";
import { AppError } from "./errors.js";
import { normalizeRefreshHours } from "./addon-refresh.js";
import { toPosix, type LibraryRecord, type LibraryType } from "./libraries.js";

export const BACKUP_FORMAT = "stremio-offline-settings";
/** 2 adds the library roster, so a rule that names a library survives the trip to another
 *  instance by root and then by name. Version 1 files still import. */
export const BACKUP_VERSION = 2;
const READABLE_VERSIONS = [1, 2];
const ROLES = new Set<AddonRole>(["catalog", "source", "both"]);
const STREAM_SORTS = new Set(["recommended", "size-desc", "size-asc", "addon"]);
const TILE_SIZES = new Set(["compact", "small", "medium", "large"]);

export interface BackupAddon {
  manifestUrl: string;
  role: AddonRole;
  enabled: boolean;
  globalSearch: boolean;
  addedAt: string;
  downloadSettings: AddonDownloadSettings;
}

/** A library as the backup carries it. `id` is a key the rules in the same file refer to, not
 *  something the import installs: the id a library gets here is always this instance's own. */
export interface BackupLibrary { id: string; name: string; type: LibraryType; root: string }

/** What one library reference had to become on the way in. */
export interface LibraryRemap { what: string; addon?: string; from: string; to?: string }

export interface SettingsBackup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  settings: Settings;
  libraries: BackupLibrary[];
  addons: BackupAddon[];
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("The backup file has an invalid format.", "err.backupFormat");
  return value as Record<string, unknown>;
};

export function createSettingsBackup(settings: Settings, addons: AddonRecord[], libraries: LibraryRecord[] = []): SettingsBackup {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    settings: structuredClone(settings),
    libraries: libraries.map(({ id, name, type, root }) => ({ id, name, type, root: toPosix(root) })),
    addons: addons.map(({ manifestUrl, role, enabled, globalSearch, addedAt, downloadSettings }) => ({
      manifestUrl, role, enabled, globalSearch, addedAt, downloadSettings: structuredClone(downloadSettings),
    })),
  };
}

function parseSettings(value: unknown): Settings {
  const source = object(value);
  const fallback = defaultSettings();
  const number = (name: keyof Settings, maximum: number) => Math.max(1, Math.min(maximum, Number(source[name]) || fallback[name] as number));
  const boolean = (name: keyof Settings) => typeof source[name] === "boolean" ? source[name] as boolean : fallback[name] as boolean;
  // A backup taken before the interface was translated restores as Czech, the
  // only language it could have been written in.
  const uiLanguage = isUiLanguage(source.uiLanguage) ? source.uiLanguage : "cs";
  const audioLanguage = normalizeLanguage(String(source.audioLanguage ?? "")) ?? fallback.audioLanguage;
  const subtitleLanguage = normalizeLanguage(String(source.subtitleLanguage ?? "")) ?? fallback.subtitleLanguage;
  const downloadTitleLanguage = source.downloadTitleLanguage === "ui" ? "ui" : normalizeLanguage(String(source.downloadTitleLanguage ?? "")) ?? fallback.downloadTitleLanguage;
  const streamSort = String(source.streamSort ?? "");
  const catalogTileSize = String(source.catalogTileSize ?? "");
  const libraryTileSize = String(source.libraryTileSize ?? "");
  return {
    concurrentDownloads: number("concurrentDownloads", 8),
    parallelPerProvider: number("parallelPerProvider", 8),
    downloadSegments: number("downloadSegments", 8),
    uiLanguage, audioLanguage, subtitleLanguage, downloadTitleLanguage,
    mergeByName: boolean("mergeByName"),
    streamSort: STREAM_SORTS.has(streamSort) ? streamSort : fallback.streamSort,
    trackProgress: boolean("trackProgress"),
    showResumeRow: boolean("showResumeRow"),
    libraryAutoScan: boolean("libraryAutoScan"),
    libraryScanPauseOnDownload: boolean("libraryScanPauseOnDownload"),
    secureMode: boolean("secureMode"),
    addonRefreshHours: normalizeRefreshHours(source.addonRefreshHours ?? fallback.addonRefreshHours),
    catalogTileSize: TILE_SIZES.has(catalogTileSize) ? catalogTileSize as Settings["catalogTileSize"] : fallback.catalogTileSize,
    libraryTileSize: TILE_SIZES.has(libraryTileSize) ? libraryTileSize as Settings["libraryTileSize"] : fallback.libraryTileSize,
    // Whatever the backup names here is another instance's id; the import maps it onto a local
    // library by root or name, and falls back to the default when it cannot.
    defaultMovieLibrary: typeof source.defaultMovieLibrary === "string" ? source.defaultMovieLibrary : "",
    defaultSeriesLibrary: typeof source.defaultSeriesLibrary === "string" ? source.defaultSeriesLibrary : "",
    realDebridToken: typeof source.realDebridToken === "string" ? source.realDebridToken.trim() : fallback.realDebridToken,
  };
}

export function parseSettingsBackup(value: unknown): Omit<SettingsBackup, "exportedAt"> & { exportedAt?: string } {
  const root = object(value);
  const version = Number(root.version);
  if (root.format !== BACKUP_FORMAT || !READABLE_VERSIONS.includes(version)) throw new AppError("This is not a Stremio Offline settings backup.", "err.backupUnsupported");
  if (!Array.isArray(root.addons) || root.addons.length > 100) throw new AppError("The addon list in the backup is not valid.", "err.backupAddons");
  const addons = root.addons.map((raw, index): BackupAddon => {
    const item = object(raw);
    const manifestUrl = typeof item.manifestUrl === "string" ? item.manifestUrl.trim() : "";
    if (!manifestUrl) throw new AppError("An addon in the backup has no manifest URL.", "err.backupAddonUrl");
    const role = item.role as AddonRole;
    if (!ROLES.has(role)) throw new AppError("An addon in the backup has an invalid role.", "err.backupAddonRole");
    return {
      manifestUrl,
      role,
      enabled: typeof item.enabled === "boolean" ? item.enabled : true,
      globalSearch: item.globalSearch !== false,
      addedAt: typeof item.addedAt === "string" && !Number.isNaN(Date.parse(item.addedAt)) ? item.addedAt : new Date().toISOString(),
      downloadSettings: normalizeDownloadSettings(item.downloadSettings),
    };
  });
  return {
    format: BACKUP_FORMAT,
    version,
    exportedAt: typeof root.exportedAt === "string" ? root.exportedAt : undefined,
    settings: parseSettings(root.settings),
    libraries: Array.isArray(root.libraries) ? root.libraries.map(parseLibrary) : [],
    addons,
  };
}

/** A roster entry of a backup. A malformed one is dropped rather than failing the import:
 *  the rules that pointed at it fall back to the default. */
function parseLibrary(raw: unknown): BackupLibrary {
  const item = object(raw);
  const type = item.type;
  return {
    id: typeof item.id === "string" ? item.id : "",
    name: typeof item.name === "string" ? item.name : "",
    type: type === "movie" || type === "series" || type === "mixed" ? type : "mixed",
    root: typeof item.root === "string" ? item.root : "",
  };
}

/** Turns the backup's library references into this instance's. The same root wins, then the
 *  same name and type; a reference that matches nothing becomes the default, so a backup from
 *  another machine restores instead of failing. The list of what had to move is returned for
 *  the response and the log. */
export function remapBackupLibraries(
  backup: Omit<SettingsBackup, "exportedAt">,
  libraries: LibraryRecord[],
): Omit<SettingsBackup, "exportedAt"> & { remaps: LibraryRemap[] } {
  const local = new Map<string, LibraryRecord | undefined>();
  const resolve = (id: string) => {
    if (!local.has(id)) {
      const source = backup.libraries.find((item) => item.id === id);
      local.set(id, source
        ? libraries.find((library) => toPosix(library.root) === toPosix(source.root))
          ?? libraries.find((library) => library.name === source.name && library.type === source.type)
        : undefined);
    }
    return local.get(id);
  };

  const remaps: LibraryRemap[] = [];
  const settle = (id: string, what: string, addon?: string): string => {
    if (!id) return "";
    const match = resolve(id);
    // Restoring onto the instance the backup came from changes nothing, and nothing is reported.
    if (match?.id === id) return id;
    remaps.push({ what, ...(addon ? { addon } : {}), from: id, ...(match ? { to: match.id } : {}) });
    return match?.id ?? "";
  };

  const settings = structuredClone(backup.settings);
  settings.defaultMovieLibrary = settle(settings.defaultMovieLibrary, "defaultMovieLibrary");
  settings.defaultSeriesLibrary = settle(settings.defaultSeriesLibrary, "defaultSeriesLibrary");
  const addons = backup.addons.map((addon) => {
    const downloadSettings = structuredClone(addon.downloadSettings);
    for (const kind of ["movie", "series"] as const) {
      const wanted = downloadSettings[kind].libraryId;
      if (!wanted) continue;
      const to = settle(wanted, kind, manifestName(addon));
      if (to) downloadSettings[kind].libraryId = to;
      else delete downloadSettings[kind].libraryId;
    }
    return { ...addon, downloadSettings };
  });
  return { ...structuredClone(backup), settings, addons, remaps };
}

const manifestName = (addon: BackupAddon) => addon.manifestUrl.replace(/^https?:\/\//, "").split("/")[0] ?? addon.manifestUrl;
