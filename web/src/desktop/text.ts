import { t as translate, type Key, type Vars } from "../i18n";
import type { ShellPlatform } from "./bridge";

let platform: ShellPlatform = "darwin";

/** Set once from the shell's first state: the platform never changes while a page lives. */
export function setShellPlatform(next: ShellPlatform) {
  platform = next;
}

/** Keys whose Windows twin speaks of Windows itself (its firewall, its login, the Recycle Bin's
 *  quota): on Linux the macOS wording is the closer one when there is no Linux twin. */
const WINDOWS_ONLY = new Set(["desktop.shareText", "desktop.openAtLoginText", "desktop.loginItemFailed",
  "desktop.resetWhat", "desktop.resetDownloadsProtected"]);

const twin = (key: Key, suffix: string, vars?: Vars): string | undefined => {
  const name = `${key}.${suffix}` as Key;
  const text = translate(name, vars);
  return text === name ? undefined : text;
};

/** `t` for the shell's pages. On Windows a key with a `.win` twin says "This PC" and "Recycle Bin"
 *  where the macOS text says "This Mac" and "Trash". On Linux a `.linux` twin wins, then the
 *  Windows wording for "this computer", except where that one is about Windows itself. */
export function t(key: Key, vars?: Vars): string {
  if (platform === "win32") return twin(key, "win", vars) ?? translate(key, vars);
  if (platform === "linux") {
    return twin(key, "linux", vars) ?? (WINDOWS_ONLY.has(key) ? undefined : twin(key, "win", vars)) ?? translate(key, vars);
  }
  return translate(key, vars);
}
