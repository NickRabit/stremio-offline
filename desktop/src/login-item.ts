import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LoginItemStatus } from "./shell-api.js";

/** What a login launch passes on Windows, so the app opens in the notification area. */
export const LOGIN_ARGS = ["--hidden"];

/** Electron has no login items on Linux, so the app writes the XDG autostart entry itself. */
export const AUTOSTART_NAME = "stremio-offline.desktop";

/** What `getLoginItemSettings` needs: Windows matches the registry entry by path and arguments. */
export interface LoginItemQuery {
  args: string[];
}

/** What `setLoginItemSettings` takes. */
export interface LoginItemUpdate {
  openAtLogin: boolean;
  args?: string[];
  /** Windows only: switches the entry back on where Task Manager's Startup tab turned it off. */
  enabled?: boolean;
}

/** The readings the decision needs out of `getLoginItemSettings()`. */
export interface LoginItemReadings {
  openAtLogin?: boolean;
  /** macOS only. */
  status?: string | null;
  /** Windows only; it ignores the arguments, so it also sees an entry registered without them. */
  executableWillLaunchAtLogin?: boolean;
}

const MACOS_STATUSES = new Set<string>(["enabled", "not-registered", "requires-approval", "not-found"]);

export function loginItemQuery(platform: NodeJS.Platform = process.platform): LoginItemQuery | undefined {
  return platform === "win32" ? { args: LOGIN_ARGS } : undefined;
}

export function loginItemUpdate(openAtLogin: boolean, platform: NodeJS.Platform = process.platform): LoginItemUpdate[] {
  if (platform !== "win32") return [{ openAtLogin }];
  if (openAtLogin) return [{ openAtLogin, args: LOGIN_ARGS, enabled: true }];
  // An entry registered before the arguments were added must go too, and the registry entry is
  // matched by path and arguments: removing it means clearing both spellings.
  return [{ openAtLogin, args: LOGIN_ARGS }, { openAtLogin }];
}

/** Windows registers the login item at once; macOS may hold it back until the user allows it. */
export function loginItemStatus(
  settings: LoginItemReadings,
  platform: NodeJS.Platform = process.platform,
  isPackaged: boolean,
): LoginItemStatus {
  if (!isPackaged) return "unsupported";
  if (platform === "win32" || platform === "linux") return loginItemOn(settings, platform) ? "enabled" : "not-registered";
  if (platform !== "darwin") return "unsupported";
  const status = settings.status;
  return typeof status === "string" && MACOS_STATUSES.has(status) ? status as LoginItemStatus : "unsupported";
}

/** Whether the app will really start at login. On Windows an entry that Task Manager's Startup tab
 *  switched off is still registered, so `openAtLogin` alone says yes where Windows says no;
 *  `executableWillLaunchAtLogin` answers for the entry as Windows will run it. */
export function loginItemOn(settings: LoginItemReadings, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return (settings.executableWillLaunchAtLogin ?? settings.openAtLogin) === true;
  return settings.openAtLogin === true;
}

export function launchedHidden(argv: readonly string[]): boolean {
  return argv.includes("--hidden");
}

/** The file operations the autostart entry needs, so a test can stand in for the disk. */
export interface AutostartFs {
  readFile(file: string, encoding: "utf8"): Promise<string>;
  mkdir(dir: string, options: { recursive: true }): Promise<unknown>;
  writeFile(file: string, data: string, options: { encoding: "utf8" }): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  rm(file: string, options: { force: true }): Promise<unknown>;
}

const nodeAutostartFs: AutostartFs = { readFile, mkdir, writeFile, rename, rm };

/** `$XDG_CONFIG_HOME/autostart/stremio-offline.desktop`, or `~/.config/autostart/...` when the
 *  variable is unset or empty, as the XDG spec reads it. */
export function autostartFile(home: string, env: NodeJS.ProcessEnv): string {
  const configHome = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim().length > 0
    ? env.XDG_CONFIG_HOME
    : path.join(home, ".config");
  return path.join(configHome, "autostart", AUTOSTART_NAME);
}

/** A Desktop Entry `Exec` value, escaped at both levels the spec reads it at: the quoting level
 *  puts a backslash before `"`, `` ` ``, `$` and `\`, and the key-file string level then doubles
 *  every backslash. The field-code `%` is doubled too. */
const quotedExec = (exec: string): string => {
  const quoted = `"${exec.replace(/(["`$\\])/g, "\\$1").replace(/%/g, "%%")}"`;
  return quoted.replace(/\\/g, "\\\\");
};

/** The key-file string level: `\s`, `\n`, `\t`, `\r` and `\\`. */
const unescapeString = (value: string): string =>
  value.replace(/\\([sntr\\])/g, (_, code: string) =>
    code === "s" ? " " : code === "n" ? "\n" : code === "t" ? "\t" : code === "r" ? "\r" : "\\");

export function autostartEntry(exec: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Stremio Offline",
    `Exec=${quotedExec(exec)} --hidden`,
    "X-GNOME-Autostart-enabled=true",
    "Hidden=false",
    "NoDisplay=false",
    "",
  ].join("\n");
}

/** The program an entry's `Exec` line runs: its first argument, unescaped, or null when there is
 *  none. Used to spot an entry a renamed or replaced AppImage left pointing at an old file. */
export function autostartExecutable(text: string): string | null {
  const line = text.split("\n").find((candidate) => /^exec=/i.test(candidate.trim()));
  if (line === undefined) return null;
  const value = unescapeString(line.slice(line.indexOf("=") + 1).trim());
  if (value.length === 0) return null;
  if (!value.startsWith("\"")) return value.split(/\s+/)[0] ?? null;
  let exec = "";
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\") { exec += value[index + 1] ?? ""; index += 1; continue; }
    if (char === "\"") break;
    exec += char;
  }
  return exec.replace(/%%/g, "%");
}

/** The AppImage file is the stable path; its mount changes on every run, so `$APPIMAGE` wins --
 *  but only when this process runs from that AppImage's mount (`$APPDIR`). A .deb build started
 *  from a terminal inside another AppImage inherits that one's variables, and must not register
 *  it to start at login. */
export function launchExecutable(env: NodeJS.ProcessEnv, execPath: string): string {
  const appDir = env.APPDIR;
  if (!env.APPIMAGE || !appDir) return execPath;
  const relative = path.posix.relative(path.posix.resolve(appDir), path.posix.resolve(execPath));
  const fromMount = relative.length > 0 && !relative.startsWith("..") && !path.posix.isAbsolute(relative);
  return fromMount ? env.APPIMAGE : execPath;
}

export interface AutostartState {
  enabled: boolean;
}

export async function readAutostart(file: string, fsImpl: AutostartFs = nodeAutostartFs): Promise<AutostartState> {
  let text: string;
  try {
    text = await fsImpl.readFile(file, "utf8");
  } catch {
    return { enabled: false };
  }
  const entries = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("[")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    entries.set(trimmed.slice(0, separator).trim().toLowerCase(), trimmed.slice(separator + 1).trim().toLowerCase());
  }
  return { enabled: entries.get("hidden") !== "true" && entries.get("x-gnome-autostart-enabled") !== "false" };
}

export async function writeAutostart(file: string, exec: string, fsImpl: AutostartFs = nodeAutostartFs): Promise<void> {
  await fsImpl.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}`;
  await fsImpl.writeFile(temporary, autostartEntry(exec), { encoding: "utf8" });
  try {
    await fsImpl.rename(temporary, file);
  } catch (error) {
    await fsImpl.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function removeAutostart(file: string, fsImpl: AutostartFs = nodeAutostartFs): Promise<void> {
  await fsImpl.rm(file, { force: true });
}
