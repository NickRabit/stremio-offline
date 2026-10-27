import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AddonRecord } from "./types.js";
import { hashPassword, type AuthState } from "./auth.js";
import { renameWithRetry } from "./fs-retry.js";
import { normalizeDownloadSettings } from "./naming.js";
import type { UiLanguage } from "./language.js";
import type { HomeLayout } from "./home.js";
import { newLibraryId, type DepartedLibrary, type LibraryRecord, type RootGrant } from "./libraries.js";
import { log } from "./logger.js";
import type { ProgressSeries } from "./progress-series.js";
import type { MediaConnectionRecord, RemoteLibraryRecord } from "./media-server-types.js";
import type { DownloadRules } from "./download-rules.js";
import {
  buildTemplatePolicy,
  parseTemplateParameters,
  RULE_PRESETS,
  rulesForLegacyVariant,
  SOURCE_PROFILE_IDS,
  type ProviderPriorityParameters,
  type SourceProfileTemplate,
  type TravelParameters,
} from "./source-profiles.js";
import { claimLegacyData, emptyUserData, type EnvReset, envResetApplied, envResetPending, findUser, type MigratableState, migrateUsers, newUserId, type UserData, type UserRecord } from "./users.js";

/** `state.json` shape version. 2 is the libraries shape, 3 the accounts one; a state
 *  without a version predates both and is migrated on the way in. */
export const SCHEMA_VERSION = 3;

/** The shapes inside `UserData`. It keeps its maps opaque so the user model stays clear of
 *  the progress and library modules; they are pinned here, once, because both `index.ts` and
 *  the route modules read the same rows and two copies would drift apart in silence. */
/** `addonKey` is the add-on the title was starred from; older entries carry none. */
export type WatchlistEntry = { type: string; id: string; name: string; poster?: string; addedAt: string; addonKey?: string };
/** The media-server version a title's position was played from, so the detail can name it. */
export type RemoteProgressWriter = { libraryId: string; itemId: string; mediaSourceId: string };
export type StoredProgress = { position: number; duration: number; title: string; path?: string; poster?: string; addonKey?: string; series?: ProgressSeries; remote?: RemoteProgressWriter; stableKey?: string; updatedAt: string };
export type WatchedMarker = { name: string; poster?: string; addonKey?: string; season: number; episode: number; updatedAt: string };


export type TileSize = "compact" | "small" | "medium" | "large";
export type TileShape = "poster" | "wide";
export type StartView = "catalog" | "home" | "library";
/** Which segment the library root's shelf shows. */
export type LibraryShelf = "resume" | "episodes" | "favorites";
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
  tileSize: TileSize;
  catalogTileShape: TileShape; libraryTileShape: TileShape; favoritesTileShape: TileShape;
  resumeTileShape: TileShape; followingTileShape: TileShape; homeTileShape: TileShape; searchTileShape: TileShape;
  /** The view the app opens on; the catalogue unless the person chose otherwise. */
  startView: StartView;
  /** The segment the library root's one shelf shows; Continue unless the person chose otherwise. */
  libraryShelf: LibraryShelf;
  /** One account's own Home: the row order it placed, the rows it hid and the extra feeds it
   *  added. Absent means the instance's default Home. */
  homeLayout?: HomeLayout;
  /** The source profile one account prefers for a new download. Absent means no default. */
  downloadSourceProfile?: string;
  /** The source profile one account prefers for a new follow. Absent means no default. */
  followSourceProfile?: string;
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

/** The instance half an ordinary account is answered with, and the only part of it the
 *  ordinary interface behaves on: `secureMode` decides whether a trailer is framed or opens
 *  in a new tab, and `realDebridConfigured` whether torrent sources are offered at all.
 *  Everything else -- how the instance downloads, what it scans and when, which providers it
 *  holds a token for, where a download lands -- is the operator's business and says more
 *  about the host than an account has any reason to learn. An allow-list on purpose: an
 *  instance key added later stays hidden until somebody decides otherwise. */
export type MemberSettings = Pick<PublicSettings, "secureMode" | "realDebridConfigured">;

export const memberSettings = (settings: PublicSettings): MemberSettings =>
  ({ secureMode: settings.secureMode, realDebridConfigured: settings.realDebridConfigured });

export interface StoredSourceProfile {
  id: string;
  revision: number;
  template: SourceProfileTemplate;
  nameKey?: string;
  name?: string;
  parameters?: DownloadRules | TravelParameters | ProviderPriorityParameters;
  createdAt: string;
  updatedAt: string;
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
  addonsRefreshedAt?: string;
  /** Remote media-server connections, stored apart from the filesystem libraries so every
   *  `libraries()` consumer keeps its local-only contract. */
  mediaConnections?: MediaConnectionRecord[];
  /** Remote libraries attached to those connections. */
  remoteLibraries?: RemoteLibraryRecord[];
  sourceProfiles?: StoredSourceProfile[];
  deletedSourceProfileIds?: string[];
  /** Secret-vault references whose ciphertext file is waiting to be deleted. Internal
   *  only: it never leaves the process except as a store write, and never names a token. */
  mediaSecretCleanup?: string[] }
const baseInstanceSettings: InstanceSettings = { concurrentDownloads: 1, parallelPerProvider: 1, downloadSegments: 2, libraryAutoScan: true, libraryScanPauseOnDownload: false, secureMode: true, addonRefreshHours: 24, defaultMovieLibrary: "", defaultSeriesLibrary: "", realDebridToken: "", tmdbApiKey: "" };
const basePrefs: UserPrefs = { uiLanguage: "en", audioLanguage: "en", subtitleLanguage: "en", downloadTitleLanguage: "ui", mergeByName: true, streamSort: "recommended", trackProgress: true, showResumeRow: true, tileSize: "medium", catalogTileShape: "poster", libraryTileShape: "poster", favoritesTileShape: "poster", resumeTileShape: "poster", followingTileShape: "poster", homeTileShape: "wide", searchTileShape: "poster", startView: "home", libraryShelf: "resume" };

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

/** The pieces a test replaces: the writer is here so one particular save can be made to fail
 *  while the writes around it still land. */
export interface StoreHooks {
  writeState?: (file: string, data: string) => Promise<void>;
}

export class Store {
  private state: State;
  /** Whether a real `state.json` has been read or written successfully in this process.
   *  Startup reconciliation that deletes files must not run off a swallowed ENOENT. */
  private persisted = false;
  /** Whether a loaded or saved state actually carried the media-server fields. A legacy
   *  state from before those existed must not authorize deleting a newer vault. */
  private mediaState = false;
  private readonly filename: string;
  private readonly downloadDir: string;
  private readonly writeState: (file: string, data: string) => Promise<void>;
  constructor(dataDir = process.env.DATA_DIR ?? "/data", downloadDir = process.env.DOWNLOAD_DIR ?? "/downloads", hooks: StoreHooks = {}) {
    this.filename = path.join(dataDir, "state.json");
    this.downloadDir = downloadDir;
    this.writeState = hooks.writeState ?? ((file, data) => writeFile(file, data, { mode: 0o600 }));
    this.state = initialState(downloadDir);
  }
  async load() {
    await mkdir(path.dirname(this.filename), { recursive: true });
    let stateRead = false;
    let sourceProfilesChanged = false;
    try {
      const loaded = JSON.parse(await readFile(this.filename, "utf8")) as Partial<State>;
      this.persisted = true;
      stateRead = true;
      this.mediaState = Object.prototype.hasOwnProperty.call(loaded, "mediaConnections")
        || Object.prototype.hasOwnProperty.call(loaded, "mediaSecretCleanup");
      const fresh = initialState(this.downloadDir);
      // `migrate` answers Czech for a state written before the interface spoke anything else.
      // A state that already has users is past that point: the language is the person's and
      // the instance settings carry none, so reading them as a pre-i18n install would put a
      // stray personal key back on the instance on every boot.
      const storedSettings = loaded.users ? loaded.settings : migrate(loaded.settings);
      this.state = { ...fresh, ...loaded, settings: { ...fresh.settings, ...storedSettings } };
      if (!this.state.libraries?.length) this.state.libraries = fresh.libraries;
      this.state.addons = this.state.addons.map((addon) => ({ ...addon, globalSearch: addon.globalSearch !== false, downloadSettings: normalizeDownloadSettings(addon.downloadSettings) }));
      sourceProfilesChanged = this.normalizeSourceProfiles();
      // After `migrate`, which still reads the personal keys off the flat settings object.
      // The cast is that moment: on disk the settings are both halves in one object.
      const migration = migrateUsers(this.state as unknown as MigratableState);
      if (migration.migrated || sourceProfilesChanged) {
        if (migration.migrated) {
          log("INFO", "The account was moved into the list of users", { userId: migration.userId });
        }
        // Written out now. The old shape stays readable for one release, and leaving it on
        // disk would mean the next boot migrating an account whose sessions are already
        // keyed by an id the file does not have.
        await this.update(() => {});
      }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!stateRead) this.normalizeSourceProfiles();
  }
  addons() { return this.state.addons; }
  settings() { return this.state.settings; }
  /** One person's settings over the defaults. A read with no request in hand -- a
   *  background refresh or the scan -- has no user to speak for and answers the defaults. */
  prefs(userId: string | undefined): UserPrefs {
    if (!userId) return defaultPrefs();
    const stored = this.state.userData?.[userId]?.prefs as Partial<UserPrefs> | undefined;
    const prefs = { ...defaultPrefs(), ...stored };
    if (stored?.tileSize === undefined) {
      const previous = (stored as Record<string, unknown> | undefined)?.libraryTileSize ?? (stored as Record<string, unknown> | undefined)?.catalogTileSize;
      if (previous === "compact" || previous === "small" || previous === "medium" || previous === "large") prefs.tileSize = previous;
    }
    delete (prefs as Record<string, unknown>).catalogTileSize;
    delete (prefs as Record<string, unknown>).libraryTileSize;
    delete (prefs as Record<string, unknown>).favoritesTileSize;
    delete (prefs as Record<string, unknown>).resumeTileSize;
    delete (prefs as Record<string, unknown>).followingTileSize;
    if (stored?.favoritesTileShape === undefined) prefs.favoritesTileShape = stored?.libraryTileShape ?? prefs.favoritesTileShape;
    if (stored?.resumeTileShape === undefined) prefs.resumeTileShape = stored?.libraryTileShape ?? prefs.resumeTileShape;
    if (stored?.followingTileShape === undefined) prefs.followingTileShape = stored?.libraryTileShape ?? prefs.followingTileShape;
    return prefs;
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
    // Whatever the install already had is this account's: an install running on the variables
    // alone has no `auth` block, so `migrateUsers` never ran and its favourites, history and
    // language are still at the top level in the shape that predates accounts.
    await this.update((state) => {
      state.users = [record];
      claimLegacyData(state as unknown as MigratableState, record.id);
      state.schemaVersion = 3;
    });
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
  mediaConnections(): MediaConnectionRecord[] { return structuredClone(this.state.mediaConnections ?? []); }
  remoteLibraries(): RemoteLibraryRecord[] { return structuredClone(this.state.remoteLibraries ?? []); }
  sourceProfiles(): readonly StoredSourceProfile[] { return this.state.sourceProfiles ?? []; }
  deletedSourceProfileIds(): readonly string[] { return this.state.deletedSourceProfileIds ?? []; }
  mediaSecretCleanup(): string[] { return [...(this.state.mediaSecretCleanup ?? [])]; }
  /** True once a state file has actually been read or written here. A missing or corrupt
   *  file leaves it false, so a reconciliation step must not treat an empty in-memory state
   *  as proof that the vault's files are orphans. */
  hasPersistedState(): boolean { return this.persisted; }
  /** True once a state that owned `mediaConnections` or `mediaSecretCleanup` was read or
   *  written. The in-memory default that has neither is not proof that the vault is orphaned. */
  hasMediaServerState(): boolean { return this.mediaState; }
  grants() { return this.state.grants ?? []; }
  departed() { return this.state.departed ?? []; }
  private normalizeSourceProfiles(): boolean {
    const rawProfiles: unknown = this.state.sourceProfiles;
    if (rawProfiles !== undefined && !Array.isArray(rawProfiles)) {
      log("ERROR", "The stored source profile catalogue is not a list", {
        file: path.basename(this.filename),
      });
    }
    const candidates = Array.isArray(rawProfiles) ? rawProfiles : [];
    const seen = new Set<string>();
    const profiles: StoredSourceProfile[] = [];
    const legacyIds = new Set<string>([
      SOURCE_PROFILE_IDS.recommended,
      SOURCE_PROFILE_IDS.providerPriority,
      SOURCE_PROFILE_IDS.travel,
    ]);
    let changed = false;
    const dropped = new Set<string>();
    for (const candidate of candidates) {
      try {
        let profile = this.parseStoredSourceProfile(candidate);
        if (legacyIds.has(profile.id)) {
          changed = true;
          continue;
        }
        if (profile.template === "travel" || profile.template === "providerPriority") {
          const template = profile.template;
          profile = {
            ...profile,
            revision: profile.revision + 1,
            template: "rules",
            parameters: rulesForLegacyVariant(
              template,
              profile.parameters as TravelParameters | ProviderPriorityParameters,
            ),
            updatedAt: new Date().toISOString(),
          };
          delete profile.nameKey;
          changed = true;
        }
        if (seen.has(profile.id)) {
          log("ERROR", "A stored source profile was dropped", {
            id: profile.id,
            reason: "duplicate id",
          });
          continue;
        }
        seen.add(profile.id);
        profiles.push(profile);
      } catch {
        const id = candidate !== null && typeof candidate === "object"
          && typeof (candidate as { id?: unknown }).id === "string"
          ? (candidate as { id: string }).id
          : undefined;
        if (id !== undefined) dropped.add(id);
        log("ERROR", "A stored source profile was dropped", {
          id,
          reason: "invalid record",
        });
      }
    }

    const deleted = new Set((this.state.deletedSourceProfileIds ?? [])
      .filter((id): id is string => typeof id === "string"));
    for (const id of legacyIds) {
      if (!deleted.has(id)) {
        deleted.add(id);
        changed = true;
      }
    }
    const remap = new Map<string, string>([
      [SOURCE_PROFILE_IDS.travel, SOURCE_PROFILE_IDS.smaller],
      [SOURCE_PROFILE_IDS.providerPriority, SOURCE_PROFILE_IDS.balanced],
      [SOURCE_PROFILE_IDS.recommended, SOURCE_PROFILE_IDS.balanced],
    ]);
    for (const data of Object.values(this.state.userData ?? {})) {
      for (const key of ["downloadSourceProfile", "followSourceProfile"] as const) {
        const selected = data.prefs[key];
        if (typeof selected === "string" && dropped.has(selected)) {
          delete data.prefs[key];
          changed = true;
          continue;
        }
        const mapped = typeof selected === "string" ? remap.get(selected) : undefined;
        if (mapped) {
          data.prefs[key] = mapped;
          changed = true;
        }
      }
    }
    for (const definition of RULE_PRESETS) {
      if (seen.has(definition.id) || deleted.has(definition.id)) continue;
      const now = new Date().toISOString();
      profiles.push({
        id: definition.id,
        revision: 1,
        template: "rules",
        nameKey: definition.nameKey,
        parameters: structuredClone(definition.rules),
        createdAt: now,
        updatedAt: now,
      });
      seen.add(definition.id);
    }
    this.state.sourceProfiles = profiles;
    this.state.deletedSourceProfileIds = [...deleted];
    return changed;
  }
  private parseStoredSourceProfile(input: unknown): StoredSourceProfile {
    if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid profile");
    const profile = input as Record<string, unknown>;
    const id = profile.id;
    const revision = profile.revision;
    const template = profile.template;
    const nameKey = profile.nameKey;
    const name = profile.name;
    const createdAt = profile.createdAt;
    const updatedAt = profile.updatedAt;
    if (typeof id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1
      || (template !== "recommended" && template !== "travel"
        && template !== "providerPriority" && template !== "rules")
      || typeof createdAt !== "string" || createdAt.length === 0
      || typeof updatedAt !== "string" || updatedAt.length === 0) {
      throw new Error("invalid profile");
    }

    const preset = RULE_PRESETS.find((candidate) => candidate.id === id);
    const builtInTemplate = id === SOURCE_PROFILE_IDS.recommended
      ? "recommended"
      : id === SOURCE_PROFILE_IDS.travel
        ? "travel"
        : id === SOURCE_PROFILE_IDS.providerPriority
          ? "providerPriority"
          : preset?.template;
    if (builtInTemplate !== undefined && (template !== builtInTemplate || typeof nameKey !== "string" || name !== undefined)) {
      throw new Error("invalid built-in profile");
    }
    if (preset !== undefined && nameKey !== preset.nameKey) throw new Error("invalid built-in profile");
    if (builtInTemplate === undefined && (template === "recommended"
      || typeof name !== "string" || name.trim().length === 0 || name.length > 60 || nameKey !== undefined)) {
      throw new Error("invalid custom profile");
    }

    let parameters: DownloadRules | TravelParameters | ProviderPriorityParameters | undefined;
    if (template === "recommended") {
      if (profile.parameters !== undefined) throw new Error("invalid recommended parameters");
      parseTemplateParameters(template, profile.parameters);
    } else {
      parameters = parseTemplateParameters(template, profile.parameters);
    }
    buildTemplatePolicy(template, parameters);
    return {
      id,
      revision,
      template,
      ...(typeof nameKey === "string" ? { nameKey } : {}),
      ...(typeof name === "string" ? { name } : {}),
      ...(parameters === undefined ? {} : { parameters: structuredClone(parameters) }),
      createdAt,
      updatedAt,
    };
  }
  private chain: Promise<void> = Promise.resolve();
  /** Writes run one after another, or two concurrent saves would fight over the same .tmp file.
   *
   *  The change is made only when this write's turn comes and taken back if the write fails,
   *  so a change nobody could save is not left in memory for a later write to carry to disk.
   *  The caller still gets the rejection and the chain carries on past it. */
  async update(mutator: (state: State) => void) {
    const write = this.chain.then(async () => {
      const before = structuredClone(this.state);
      try {
        mutator(this.state);
      } catch (error) {
        // A refusal is not a save failure: take the change back and let the caller hear it.
        this.state = before;
        throw error;
      }
      try {
        const temp = `${this.filename}.tmp`;
        await this.writeState(temp, JSON.stringify(this.state, null, 2));
        await renameWithRetry(temp, this.filename);
        this.persisted = true;
        if (!this.mediaState) {
          this.mediaState = Object.prototype.hasOwnProperty.call(this.state, "mediaConnections")
            || Object.prototype.hasOwnProperty.call(this.state, "mediaSecretCleanup");
        }
      } catch (error) {
        this.state = before;
        // The state carries the account and the addon tokens, so only the reason is recorded.
        log("ERROR", "The state could not be saved", {
          file: path.basename(this.filename),
          code: (error as NodeJS.ErrnoException)?.code,
          reason: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
    // Chaining onto the rejection itself would skip every later save without a word, and the
    // state would only live in memory until the next restart threw it away.
    this.chain = write.catch(() => undefined);
    return write;
  }
  /** Settles once every write queued so far has landed or failed. */
  flush(): Promise<void> {
    return this.chain;
  }
}
