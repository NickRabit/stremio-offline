import { t as translate, type Key, type Vars } from "../i18n";
import type { ShellPlatform } from "./bridge";

let platform: ShellPlatform = "darwin";

/** Set once from the shell's first state: the platform never changes while a page lives. */
export function setShellPlatform(next: ShellPlatform) {
  platform = next;
}

/** `t` for the shell's pages: on Windows a key with a `.win` twin says "This PC" and "Recycle Bin"
 *  where the macOS text says "This Mac" and "Trash". */
export function t(key: Key, vars?: Vars): string {
  if (platform === "win32") {
    const twin = `${key}.win` as Key;
    const text = translate(twin, vars);
    if (text !== twin) return text;
  }
  return translate(key, vars);
}
