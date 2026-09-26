// Page side of the desktop shell contract. Keep identical in shape to desktop/src/shell-api.ts.
export const SHELL_API_VERSION = 1;

/** What the app connects to: the backend it runs itself, or a saved server profile. */
export type Target = { kind: "local" } | { kind: "profile"; id: string };

export interface ServerProfile { id: string; name: string; origin: string }

export interface LocalSettings { allowPrivateAddons: boolean; publish: boolean; publishPort: number }

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
}

export interface ShellState {
  locale: "cs" | "en";
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
  openSettings(): void;
  /** The toast's own action: "fallback" retries the chosen server, "server-back" switches to it. */
  toastAction(id: number): void;
  dismissToast(id: number): void;
  copyText(text: string): void;
}

declare global {
  interface Window { stremioShell?: ShellBridge }
}

/** The bridge the desktop app gives its own pages, or null anywhere else. */
export function shellBridge(host: { stremioShell?: unknown } = window): ShellBridge | null {
  const bridge = host.stremioShell as Partial<ShellBridge> | undefined;
  return bridge && bridge.version === SHELL_API_VERSION && typeof bridge.getState === "function" ? bridge as ShellBridge : null;
}
