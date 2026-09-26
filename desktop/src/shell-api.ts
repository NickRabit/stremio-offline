// The contract between the desktop shell's main process and its own pages (welcome, splash,
// error, settings window, toast). Copied verbatim into desktop/src/shell-api.ts (main side) and
// web/src/desktop/bridge.ts (page side); both copies must stay identical in shape.
// Exposed to shell-owned pages only, as `window.stremioShell`, by desktop/src/shell-preload.ts.
// Server pages never get it.

export const SHELL_API_VERSION = 1;

/** What the app connects to: the backend it runs itself, or a saved server profile. */
export type Target = { kind: "local" } | { kind: "profile"; id: string };

export interface ServerProfile { id: string; name: string; origin: string }

export interface LocalSettings {
  allowPrivateAddons: boolean;
  publish: boolean;
  publishPort: number;
  /** Where the local backend downloads to (its first library). null = the pre-setup default,
   *  `<userData>/downloads`, which installs from before this setting keep. */
  downloadDir: string | null;
}

export type ShellView = "main" | "settings" | "toast";

export type ProbeFailure = "invalid" | "insecure-transport" | "unreachable" | "not-status";
export type FailureReason = ProbeFailure | "local-startup" | "port-busy";

/** What the main window shows. "connected" means the server page is on screen and the shell's
 *  own page is hidden. `name` is the profile name, or "" for the local backend (the page shows
 *  its own "This Mac" label). */
export type MainScreen =
  | { kind: "welcome" }
  | { kind: "connecting"; target: Target; name: string; origin: string | null }
  | { kind: "connected" }
  | { kind: "error"; target: Target; name: string; origin: string | null; reason: FailureReason; port: number | null };

export interface Connection {
  target: Target;
  name: string;
  origin: string;
  version: string;
  restricted: boolean;
  secure: boolean;
  /** The profile name the local backend is standing in for after a fallback, else null. */
  fallbackFrom: string | null;
}

/** Texts are rendered by the page from these kinds; `server`/`file` are plain data. */
export type Toast =
  | { id: number; kind: "fallback"; server: string }
  | { id: number; kind: "server-back"; server: string }
  | { id: number; kind: "download-done"; file: string }
  | { id: number; kind: "download-failed"; file: string }
  | { id: number; kind: "local-restarted" };

export interface LocalState {
  settings: LocalSettings;
  running: boolean;
  /** URLs to type on other devices while published, else []. */
  addresses: string[];
  /** First line of the bundled FFmpeg's BUILDINFO.txt, or null in a development run. */
  ffmpeg: string | null;
  /** Something is playing or downloading through the local backend. */
  busy: boolean;
  /** The folder downloads go to, as the backend uses it (never null). */
  downloadDir: string;
  /** What the setup step proposes: ~/Movies/Stremio Offline. */
  suggestedDownloadDir: string;
  /** The local backend has an instance directory already; its download folder is then fixed. */
  initialized: boolean;
  /** The app created the download folder (or found it empty) and it is no system folder, so a
   *  reset may move it to the Trash. Otherwise it is the user's and never goes. */
  downloadDirOwned: boolean;
}

export type ShellLocale = "cs" | "en";

export interface ShellState {
  /** The language the shell speaks now. */
  locale: ShellLocale;
  /** The user's explicit choice, or null to follow macOS (Czech when the system is Czech, else English). */
  localeChoice: ShellLocale | null;
  appVersion: string;
  screen: MainScreen;
  connection: Connection | null;
  /** The remembered choice (what the app opens next launch). */
  chosen: Target | null;
  profiles: ServerProfile[];
  local: LocalState;
  toast: Toast | null;
}

export type ProfileResult =
  | { ok: true; profile: ServerProfile }
  | { ok: false; reason: "invalid-name" | "invalid-data" | "save-failed" | "not-found" };

export type ProbeResult =
  | { ok: true; version: string; restricted: boolean; secure: boolean }
  | { ok: false; reason: ProbeFailure };

export interface ShellBridge {
  version: 1;
  /** Which page this is; fixed per window/view. */
  view: ShellView;
  getState(): Promise<ShellState>;
  /** Pushed on every change; returns an unsubscribe function. */
  onState(listener: (state: ShellState) => void): () => void;
  /** Connect the main window (last request wins); remembers the target once connected. */
  connect(target: Target): Promise<void>;
  saveProfile(input: { id: string | null; name: string; origin: string }): Promise<ProfileResult>;
  deleteProfile(id: string): Promise<{ ok: boolean }>;
  /** Reachability check for a typed or saved origin, 4 s budget. */
  probe(origin: string): Promise<ProbeResult>;
  /** Stores the settings; `restartNeeded` when the running local backend was started with others. */
  setLocalSettings(settings: LocalSettings): Promise<{ ok: boolean; restartNeeded: boolean }>;
  /** Restarts the local backend with the stored settings (and reconnects the main window if it
   *  showed it). The page asks for confirmation first when `local.busy`. */
  restartLocal(): Promise<{ ok: boolean }>;
  /** Stores the language choice (null = follow the system); menus and pages switch at once. */
  setLocale(locale: ShellLocale | null): Promise<void>;
  openSettings(): void;
  /** The toast's own action: "fallback" retries the chosen server, "server-back" switches to it. */
  toastAction(id: number): void;
  dismissToast(id: number): void;
  copyText(text: string): void;
  /** The system folder dialog, opened on the calling window; null when cancelled. */
  pickFolder(defaultPath: string | null): Promise<string | null>;
  /** Creates the folder when missing and checks it can be written to. */
  prepareDownloadDir(dir: string): Promise<{ ok: true; dir: string } | { ok: false; reason: "not-absolute" | "not-folder" | "not-writable" | "reserved" }>;
  /** Asks in a native dialog, then stops the local backend, moves its data (and, when asked, the
   *  download folder) to the Trash, forgets the app's settings (and, when asked, the saved servers)
   *  and shows the welcome screen. `cancelled` when the user said no in the dialog. */
  resetLocal(options: { deleteDownloads: boolean; forgetServers: boolean }): Promise<{ ok: boolean; cancelled: boolean; downloadsKept: boolean }>;
}
