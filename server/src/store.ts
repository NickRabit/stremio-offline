import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AddonRecord } from "./types.js";
import { hashPassword, type AuthState } from "./auth.js";
import { normalizeDownloadSettings } from "./naming.js";
import type { UiLanguage } from "./language.js";
import { newLibraryId, type DepartedLibrary, type LibraryRecord, type RootGrant } from "./libraries.js";
import { log } from "./logger.js";
import type { ProgressSeries } from "./progress-series.js";
import { emptyUserData, type EnvReset, envResetApplied, envResetPending, findUser, type MigratableState, migrateUsers, newUserId, type UserData, type UserRecord } from "./users.js";

/** `state.json` shape version. 2 is the libraries shape, 3 the accounts one; a state
 *  without a version predates both and is migrated on the way in. */
export const SCHEMA_VERSION = 3;

/** The shapes inside `UserData`. It keeps its maps opaque so the user model stays clear of
 *  the progress and library modules; they are pinned here, once, because both `index.ts` and
 *  the route modules read the same rows and two copies would drift apart in silence. */
export type WatchlistEntry = { type: string; id: string; name: string; poster?: string; addedAt: string };
export type StoredProgress = { position: number; duration: number; title: string; path?: string; poster?: string; addonKey?: string; series?: ProgressSeries; updatedAt: string };
export type WatchedMarker = { name: string; poster?: string; addonKey?: string; season: number; episode: number; updatedAt: string };


export type TileSize = "compact" | "small" | "medium" | "large";
export type TileShape = "poster" | "wide";
/** Settings that belong to the instance. Only an administrator changes these. */
export interface InstanceSettings {
  concurrentDownloads: number; parallelPerProvider: number;
  /** Connections one file is split across. Above one, each part is fetched over its own range request. */
  downloadSegments: number;
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
  /** Where a download lands when the addon rule names no library. An empty id falls
   *  back to the first enabled library of the kind, then to the first `mixed` one. */
  defaultMovieLibrary: string; defaultSeriesLibrary: string;
  /** Stored locally; never returned by GET /api/settings. */
  realDebridToken: string;
  /** Stored locally; never returned by GET /api/settings. */
  tmdbApiKey: string;
}

/** Settings that belong to the person. Each user has their own. The keys are the ones
 *  `PERSONAL_SETTINGS` names in `users.ts`; a test holds the two lists together. */
export interface UserPrefs {
  uiLanguage: UiLanguage; audioLanguage: string; subtitleLanguage: string; downloadTitleLanguage: "ui" | string;
  mergeByName: boolean; streamSort: string; trackProgress: boolean; showResumeRow: boolean;
  catalogTileSize: TileSize; libraryTileSize: TileSize;
  catalogTileShape: TileShape; libraryTileShape: TileShape;
}

/** The flat shape of the settings file and of the settings backup: the instance's half and
 *  one person's half in one object. GET /api/settings answers with it, and no part of the
 *  server stores it that way. */
export type Settings = InstanceSettings & UserPrefs;

export type PublicSettings = Omit<InstanceSettings, "realDebridToken" | "tmdbApiKey"> & { realDebridConfigured: boolean; tmdbConfigured: boolean };

export function publicSettings(settings: InstanceSettings): PublicSettings {
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
  addons: AddonRecord[];
  /** The instance's half of the settings; a person's half lives under `userData`. */
  settings: InstanceSettings;
  defaultsInstalled: boolean;
  /** The accounts. A migrated install has exactly one: the administrator. */
  users?: UserRecord[];
  /** One record per user: the personal settings and the four personal maps. */
  userData?: Record<string, UserData>;
  /** The `ADMIN_PASSWORD_RESET` value the server last acted on. */
  envReset?: EnvReset;
  /** The account object from before there was a list of accounts. `load()` migrates it
   *  away; the only one left behind is the default admin/admin, which boot throws out. */
  auth?: AuthState;
  /** When the addon manifests were last refreshed in the background. */
  addonsRefreshedAt?: string }
const baseInstanceSettings: InstanceSettings = { concurrentDownloads: 1, parallelPerProvider: 1, downloadSegments: 2, libraryAutoScan: true, libraryScanPauseOnDownload: false, secureMode: true, addonRefreshHours: 24, defaultMovieLibrary: "", defaultSeriesLibrary: "", realDebridToken: "", tmdbApiKey: "" };
const basePrefs: UserPrefs = { uiLanguage: "en", audioLanguage: "en", subtitleLanguage: "en", downloadTitleLanguage: "ui", mergeByName: true, streamSort: "recommended", trackProgress: true, showResumeRow: true, catalogTileSize: "medium", libraryTileSize: "medium", catalogTileShape: "poster", libraryTileShape: "poster" };

/** A fresh install starts with the one library the download directory has always been,
 *  so it never runs the migration an upgrade needs. */
const initialState = (downloadDir: string): State => ({
  schemaVersion: SCHEMA_VERSION,
  libraries: [{
    id: newLibraryId(), name: path.basename(downloadDir) || "Library", type: "mixed", root: downloadDir,
    enabled: true, order: 0, addedAt: new Date().toISOString(), writeArtwork: false,
  }],
  addons: [],
  settings: structuredClone(baseInstanceSettings),
  defaultsInstalled: false,
});

/** Settings written before the interface spoke anything but Czech. Defaulting them
 *  to the new English default would flip a running install on upgrade. */
function migrate(loaded?: Partial<Settings>): Partial<Settings> | undefined {
  if (!loaded || loaded.uiLanguage) return loaded;
  return { ...loaded, uiLanguage: "cs" };
}

export const defaultInstanceSettings = (): InstanceSettings => structuredClone(baseInstanceSettings);

export const defaultPrefs = (): UserPrefs => structuredClone(basePrefs);

/** The flat default the settings backup falls back to, both halves in one object. */
export const defaultSettings = (): Settings => ({ ...defaultInstanceSettings(), ...defaultPrefs() });

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
      // `migrate` answers Czech for a state written before the interface spoke anything else.
      // A state that already has users is past that point: the language is the person's and
      // the instance settings carry none, so reading them as a pre-i18n install would put a
      // stray personal key back on the instance on every boot.
      const storedSettings = loaded.users ? loaded.settings : migrate(loaded.settings);
      this.state = { ...fresh, ...loaded, settings: { ...fresh.settings, ...storedSettings } };
      if (!this.state.libraries?.length) this.state.libraries = fresh.libraries;
      this.state.addons = this.state.addons.map((addon) => ({ ...addon, globalSearch: addon.globalSearch !== false, downloadSettings: normalizeDownloadSettings(addon.downloadSettings) }));
      // After `migrate`, which still reads the personal keys off the flat settings object.
      // The cast is that moment: on disk the settings are both halves in one object.
      const migration = migrateUsers(this.state as unknown as MigratableState);
      if (migration.migrated) {
        log("INFO", "The account was moved into the list of users", { userId: migration.userId });
        // Written out now. The old shape stays readable for one release, and leaving it on
        // disk would mean the next boot migrating an account whose sessions are already
        // keyed by an id the file does not have.
        await this.update(() => {});
      }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  addons() { return this.state.addons; }
  settings() { return this.state.settings; }
  /** One person's settings over the defaults. A read with no request in hand -- a
   *  background refresh or the scan -- has no user to speak for and answers the defaults. */
  prefs(userId: string | undefined): UserPrefs {
    if (!userId) return defaultPrefs();
    return { ...defaultPrefs(), ...this.state.userData?.[userId]?.prefs as Partial<UserPrefs> | undefined };
  }
  /** One person's data. A user nothing was written for yet answers the empty shape. */
  userData(userId: string): UserData { return this.state.userData?.[userId] ?? emptyUserData(); }
  users() { return this.state.users ?? []; }
  envReset() { return this.state.envReset; }
  /** The operator's password reset, applied only when the environment names a user and the
   *  value differs from the one this state acted on last. Answers the account it reset, so
   *  a boot that has nothing to do stays quiet. */
  /** An install configured only with `ADMIN_USERNAME` / `ADMIN_PASSWORD` never created a
   *  stored account, so after accounts there is nobody for a session to name and nobody to
   *  own a row. It is a working install and must not be sent to the setup screen, so the
   *  credentials it already has become a real administrator on the first boot. From then on
   *  it is indistinguishable from any other install and the variables can be removed.
   *
   *  `envReset` is deliberately not written: it tracks `ADMIN_PASSWORD_RESET`, a different
   *  variable, and an explicit recovery must still fire against the account created here. */
  async adoptEnvCredentials(credentials: { username: string; password: string } | undefined): Promise<UserRecord | undefined> {
    if (!credentials || this.users().length) return undefined;
    const record: UserRecord = {
      id: newUserId(),
      username: credentials.username,
      passwordHash: await hashPassword(credentials.password),
      secret: randomBytes(32).toString("hex"),
      role: "admin",
      createdAt: new Date().toISOString(),
      permissions: { downloadToLibrary: true, downloadToDevice: true },
      permissionsVersion: 0,
    };
    await this.update((state) => { state.users = [record]; });
    return record;
  }
  async resetPasswordFromEnv(username: string | undefined, password: string): Promise<UserRecord | undefined> {
    const target = findUser(this.users(), username ?? "");
    if (!target || !await envResetPending(this.envReset(), target.id, password)) return undefined;
    const passwordHash = await hashPassword(password);
    await this.update((state) => {
      state.users = (state.users ?? []).map((user) => user.id === target.id
        ? { ...user, passwordHash, secret: randomBytes(32).toString("hex") }
        : user);
      state.envReset = envResetApplied(target.id, passwordHash);
    });
    return target;
  }
  defaultsInstalled() { return this.state.defaultsInstalled; }
  addonsRefreshedAt() { return this.state.addonsRefreshedAt; }
  /** The pre-accounts account object, read once at boot to throw it out. */
  auth() { return this.state.auth; }
  libraries() { return this.state.libraries ?? []; }
  grants() { return this.state.grants ?? []; }
  departed() { return this.state.departed ?? []; }
  private chain: Promise<void> = Promise.resolve();
  /** Writes run one after another, or two concurrent saves would fight over the same .tmp file. */
  async update(mutator: (state: State) => void) {
    mutator(this.state);
    const write = this.chain.then(async () => {
      const temp = `${this.filename}.tmp`;
      await writeFile(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      await rename(temp, this.filename);
    });
    // The queue continues past a failed write. Chaining onto the rejection itself would
    // skip every later save without a word, and the state would only live in memory until
    // the next restart threw it away. The caller still gets the rejection.
    this.chain = write.catch((error: unknown) => {
      // The state carries the account and the addon tokens, so only the reason is recorded.
      log("ERROR", "The state could not be saved", {
        file: path.basename(this.filename),
        code: (error as NodeJS.ErrnoException)?.code,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
    return write;
  }
}
