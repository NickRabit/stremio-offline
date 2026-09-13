import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AddonRecord } from "./types.js";
import type { AuthState } from "./auth.js";
import { normalizeDownloadSettings } from "./naming.js";
import type { UiLanguage } from "./language.js";
import type { LibraryEpisodeRecord, LibraryMetaRecord, LibrarySuggestion } from "./library-match.js";

export type { LibraryEpisodeRecord, LibraryMetaRecord, LibrarySuggestion };

export type TileSize = "compact" | "small" | "medium" | "large";
export interface Settings {
  concurrentDownloads: number; parallelPerProvider: number;
  /** Connections one file is split across. Above one, each part is fetched over its own range request. */
  downloadSegments: number; uiLanguage: UiLanguage; audioLanguage: string; subtitleLanguage: string; downloadTitleLanguage: "ui" | string;
  mergeByName: boolean; streamSort: string; artworkLocation: "data" | "media"; trackProgress: boolean; showResumeRow: boolean;
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
  /** Stored locally; never returned by GET /api/settings. */
  realDebridToken: string;
}
export type PublicSettings = Omit<Settings, "realDebridToken"> & { realDebridConfigured: boolean };

export function publicSettings(settings: Settings): PublicSettings {
  const { realDebridToken: token, ...rest } = settings;
  return { ...rest, realDebridConfigured: Boolean(token) };
}
interface State { addons: AddonRecord[]; settings: Settings; defaultsInstalled: boolean; auth?: AuthState;
  /** When the addon manifests were last refreshed in the background. */
  addonsRefreshedAt?: string;
  libraryMeta?: Record<string, LibraryMetaRecord>;
  librarySuggestions?: Record<string, LibrarySuggestion>;
  /** Episode texts of bound series, keyed by title and numbering, not by path. */
  libraryEpisodes?: Record<string, LibraryEpisodeRecord>;
  /** Paths marked as favourites. Nothing is moved; it is only a flag. */
  favorites?: string[];
  /** Starred catalogue titles. Kept apart from library paths, because a title need not have
   *  a file at all. */
  watchlist?: Record<string, { type: string; id: string; name: string; poster?: string; addedAt: string }>;
  /** The resume list: a title key against a position in seconds. */
  progress?: Record<string, { position: number; duration: number; title: string; path?: string; poster?: string; updatedAt: string }> }
const initialState: State = { addons: [], settings: { concurrentDownloads: 1, parallelPerProvider: 1, downloadSegments: 2, uiLanguage: "en", audioLanguage: "en", subtitleLanguage: "en", downloadTitleLanguage: "ui", mergeByName: true, streamSort: "recommended", artworkLocation: "data", trackProgress: true, showResumeRow: true, libraryAutoScan: true, libraryScanPauseOnDownload: false, secureMode: true, addonRefreshHours: 24, catalogTileSize: "medium", libraryTileSize: "medium", realDebridToken: "" }, defaultsInstalled: false };

/** Settings written before the interface spoke anything but Czech. Defaulting them
 *  to the new English default would flip a running install on upgrade. */
function migrate(loaded?: Partial<Settings>): Partial<Settings> | undefined {
  if (!loaded || loaded.uiLanguage) return loaded;
  return { ...loaded, uiLanguage: "cs" };
}

export const defaultSettings = (): Settings => structuredClone(initialState.settings);

export class Store {
  private state: State = structuredClone(initialState);
  private readonly filename: string;
  constructor(dataDir = process.env.DATA_DIR ?? "/data") { this.filename = path.join(dataDir, "state.json"); }
  async load() {
    await mkdir(path.dirname(this.filename), { recursive: true });
    try {
      const loaded = JSON.parse(await readFile(this.filename, "utf8")) as Partial<State>;
      this.state = { ...structuredClone(initialState), ...loaded, settings: { ...initialState.settings, ...migrate(loaded.settings) } };
      this.state.addons = this.state.addons.map((addon) => ({ ...addon, globalSearch: addon.globalSearch !== false, downloadSettings: normalizeDownloadSettings(addon.downloadSettings) }));
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  addons() { return this.state.addons; }
  settings() { return this.state.settings; }
  defaultsInstalled() { return this.state.defaultsInstalled; }
  addonsRefreshedAt() { return this.state.addonsRefreshedAt; }
  auth() { return this.state.auth; }
  libraryMeta() { return this.state.libraryMeta ?? {}; }
  librarySuggestions() { return this.state.librarySuggestions ?? {}; }
  libraryEpisodes() { return this.state.libraryEpisodes ?? {}; }
  favorites() { return this.state.favorites ?? []; }
  progress() { return this.state.progress ?? {}; }
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
