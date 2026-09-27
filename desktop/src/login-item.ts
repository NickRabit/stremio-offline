import type { LoginItemStatus } from "./shell-api.js";

/** What a login launch passes on Windows, so the app opens in the notification area. */
export const LOGIN_ARGS = ["--hidden"];

/** What `getLoginItemSettings` needs: Windows matches the registry entry by path and arguments. */
export interface LoginItemQuery {
  args: string[];
}

/** What `setLoginItemSettings` takes. */
export interface LoginItemUpdate {
  openAtLogin: boolean;
  args?: string[];
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
  if (openAtLogin) return [{ openAtLogin, args: LOGIN_ARGS }];
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
  if (platform === "win32") {
    return settings.openAtLogin === true || settings.executableWillLaunchAtLogin === true ? "enabled" : "not-registered";
  }
  if (platform !== "darwin") return "unsupported";
  const status = settings.status;
  return typeof status === "string" && MACOS_STATUSES.has(status) ? status as LoginItemStatus : "unsupported";
}

export function launchedHidden(argv: readonly string[]): boolean {
  return argv.includes("--hidden");
}
