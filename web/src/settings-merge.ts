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
