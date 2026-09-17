import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AddonRecord } from "./types.js";
import type { AuthState } from "./auth.js";
import { normalizeDownloadSettings } from "./naming.js";
import type { UiLanguage } from "./language.js";
import { newLibraryId, type DepartedLibrary, type LibraryRecord, type RootGrant } from "./libraries.js";
import type { ProgressSeries } from "./progress-series.js";

/** `state.json` shape version. A state without it predates libraries and migrates once. */
export const SCHEMA_VERSION = 2;

export type TileSize = "compact" | "small" | "medium" | "large";
export interface Settings {
  concurrentDownloads: number; parallelPerProvider: number;
  /** Connections one file is split across. Above one, each part is fetched over its own range request. */
  downloadSegments: number; uiLanguage: UiLanguage; audioLanguage: string; subtitleLanguage: string; downloadTitleLanguage: "ui" | string;
  mergeByName: boolean; streamSort: string; trackProgress: boolean; showResumeRow: boolean;
  /** Look up metadata for titles copied into the download folder without asking. */
  libraryAutoScan: boolean;
  /** Hold the library scan back while a file is downloading. Off by default: the scan
   *  only makes a few small addon calls, which no transfer notices. */
  libraryScanPauseOnDownload: boolean;
  /** Artwork is fetched by the server, so no provider ever sees the browser. */
  secureMode: boolean;
  /** What the server records. Left out, the container's LOG_LEVEL decides. */
  logLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR";
  /** Hours between automatic addon manifest refreshes; 0 leaves it to the buttons. */
  addonRefreshHours: number;
  catalogTileSize: TileSize; libraryTileSize: TileSize;
  /** Where a download lands when the addon rule names no library. An empty id falls
   *  back to the first enabled library of the kind, then to the first `mixed` one. */
  defaultMovieLibrary: string; defaultSeriesLibrary: string;
  /** Stored locally; never returned by GET /api/settings. */
  realDebridToken: string;
  /** Stored locally; never returned by GET /api/settings. */
  tmdbApiKey: string;
}
export type PublicSettings = Omit<Settings, "realDebridToken" | "tmdbApiKey"> & { realDebridConfigured: boolean; tmdbConfigured: boolean };

export function publicSettings(settings: Settings): PublicSettings {
  const { realDebridToken: token, tmdbApiKey: apiKey, ...rest } = settings;
  return { ...rest, realDebridConfigured: Boolean(token), tmdbConfigured: Boolean(apiKey) };
}
export interface State { schemaVersion?: number;
  /** The configured libraries, in display order. A migrated install has exactly one. */
  libraries?: LibraryRecord[];
  /** Roots the person at the keyboard granted. The operator's `LIBRARY_ROOTS` are rebuilt
   *  from the environment on every boot and never stored. */
  grants?: RootGrant[];
  /** Libraries removed without forgetting, so a folder added again keeps what it remembers. */
  departed?: DepartedLibrary[];
  addons: AddonRecord[]; settings: Settings; defaultsInstalled: boolean; auth?: AuthState;
  /** When the addon manifests were last refreshed in the background. */
  addonsRefreshedAt?: string;
  /** Paths marked as favourites. Nothing is moved; it is only a flag. */
  favorites?: string[];
  /** Starred catalogue titles. Kept apart from library paths, because a title need not have
   *  a file at all. */
  watchlist?: Record<string, { type: string; id: string; name: string; poster?: string; addedAt: string }>;
  /** The resume list: a title key against a position in seconds. */
  progress?: Record<string, { position: number; duration: number; title: string; path?: string; poster?: string; addonKey?: string; series?: ProgressSeries; updatedAt: string }>;
  /** The last episode of a show that ran to the end, per series id. What turns a
   *  finished episode into the next one in Continue watching. */
  watchedSeries?: Record<string, { name: string; poster?: string; addonKey?: string; season: number; episode: number; updatedAt: string }> }
const baseSettings: Settings = { concurrentDownloads: 1, parallelPerProvider: 1, downloadSegments: 2, uiLanguage: "en", audioLanguage: "en", subtitleLanguage: "en", downloadTitleLanguage: "ui", mergeByName: true, streamSort: "recommended", trackProgress: true, showResumeRow: true, libraryAutoScan: true, libraryScanPauseOnDownload: false, secureMode: true, addonRefreshHours: 24, catalogTileSize: "medium", libraryTileSize: "medium", defaultMovieLibrary: "", defaultSeriesLibrary: "", realDebridToken: "", tmdbApiKey: "" };

/** A fresh install starts with the one library the download directory has always been,
 *  so it never runs the migration an upgrade needs. */
const initialState = (downloadDir: string): State => ({
  schemaVersion: SCHEMA_VERSION,
  libraries: [{
    id: newLibraryId(), name: path.basename(downloadDir) || "Library", type: "mixed", root: downloadDir,
    enabled: true, order: 0, addedAt: new Date().toISOString(), writeArtwork: false,
  }],
  addons: [],
  settings: structuredClone(baseSettings),
  defaultsInstalled: false,
});

/** Settings written before the interface spoke anything but Czech. Defaulting them
 *  to the new English default would flip a running install on upgrade. */
function migrate(loaded?: Partial<Settings>): Partial<Settings> | undefined {
  if (!loaded || loaded.uiLanguage) return loaded;
  return { ...loaded, uiLanguage: "cs" };
}

export const defaultSettings = (): Settings => structuredClone(baseSettings);

export class Store {
  private state: State;
  private readonly filename: string;
  private readonly downloadDir: string;
  constructor(dataDir = process.env.DATA_DIR ?? "/data", downloadDir = process.env.DOWNLOAD_DIR ?? "/downloads") {
    this.filename = path.join(dataDir, "state.json");
    this.downloadDir = downloadDir;
    this.state = initialState(downloadDir);
  }
  async load() {
    await mkdir(path.dirname(this.filename), { recursive: true });
    try {
      const loaded = JSON.parse(await readFile(this.filename, "utf8")) as Partial<State>;
      const fresh = initialState(this.downloadDir);
      this.state = { ...fresh, ...loaded, settings: { ...fresh.settings, ...migrate(loaded.settings) } };
      if (!this.state.libraries?.length) this.state.libraries = fresh.libraries;
      this.state.addons = this.state.addons.map((addon) => ({ ...addon, globalSearch: addon.globalSearch !== false, downloadSettings: normalizeDownloadSettings(addon.downloadSettings) }));
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  addons() { return this.state.addons; }
  settings() { return this.state.settings; }
  defaultsInstalled() { return this.state.defaultsInstalled; }
  addonsRefreshedAt() { return this.state.addonsRefreshedAt; }
  auth() { return this.state.auth; }
  libraries() { return this.state.libraries ?? []; }
  grants() { return this.state.grants ?? []; }
  departed() { return this.state.departed ?? []; }
  favorites() { return this.state.favorites ?? []; }
  progress() { return this.state.progress ?? {}; }
  watchedSeries() { return this.state.watchedSeries ?? {}; }
  watchlist() { return this.state.watchlist ?? {}; }
  private chain: Promise<void> = Promise.resolve();
  /** Writes run one after another, or two concurrent saves would fight over the same .tmp file. */
  async update(mutator: (state: State) => void) {
    mutator(this.state);
    this.chain = this.chain.then(async () => {
      const temp = `${this.filename}.tmp`;
      await writeFile(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      await rename(temp, this.filename);
    });
    return this.chain;
  }
}
