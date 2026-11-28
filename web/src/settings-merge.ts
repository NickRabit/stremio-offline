import type { Settings, SettingsPatch } from "./types";

/** Keys a patch clears by sending `null`; the settings hold them as absent. */
const CLEARABLE = ["homeLayout", "subtitleStyle", "subtitleStyleHdr"] as const;

/** `current` with `update` laid over it, minus every key the patch cleared. A plain spread
 *  would keep the old value, because the server answers a cleared key by leaving it out. */
export function mergeSettings(current: Settings, update: Partial<Settings>, patch: SettingsPatch): Settings {
  const next = { ...current, ...update };
  for (const key of CLEARABLE) if (patch[key] === null) delete next[key];
  return next;
}

/** Optional keys one account's settings carry only when that account set them. */
const ACCOUNT_OPTIONAL = ["subtitleStyle", "subtitleStyleHdr"] as const;

/** A full settings answer laid over `current`: an optional key the answer leaves out is the
 *  signed-in account's default, never a value kept from whoever was signed in before. */
export function loadedSettings(current: Settings, next: Partial<Settings>): Settings {
  const merged = { ...current, ...next };
  for (const key of ACCOUNT_OPTIONAL) if (!(key in next)) delete merged[key];
  return merged;
}

/** The settings with no account's optional keys, for a sign-in whose answer has not arrived
 *  or will not (a child account cannot read the settings). */
export function withoutAccountSettings(current: Settings): Settings {
  const next = { ...current };
  for (const key of ACCOUNT_OPTIONAL) delete next[key];
  return next;
}

/** After a failed save: put back what the patch replaced, but only where nothing newer has
 *  landed since, so a later edit is not undone by an earlier failure. */
export function revertSettings(current: Settings, before: Partial<Settings>, attempted: Partial<Settings>, keys: readonly (keyof Settings)[]): Settings {
  const next = { ...current };
  for (const key of keys) {
    if (next[key] !== attempted[key]) continue;
    if (before[key] === undefined) delete next[key];
    else (next as Record<string, unknown>)[key] = before[key];
  }
  return next;
}
