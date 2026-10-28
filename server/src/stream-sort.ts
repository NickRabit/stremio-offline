import { SOURCE_PROFILE_IDS } from "./source-profiles.js";
import type { StoredSourceProfile } from "./store.js";

export const STREAM_SORTS = new Set(["size-desc", "size-asc", "addon"]);

const ruleIds = (profiles: readonly StoredSourceProfile[]): Set<string> =>
  new Set(profiles.filter((profile) => profile.template === "rules").map((profile) => profile.id));

export function normalizeStreamSort(
  value: string,
  profiles: readonly StoredSourceProfile[],
  defaultRulesProfileId?: string,
): string {
  if (STREAM_SORTS.has(value)) return value;
  const ids = ruleIds(profiles);
  const requested = value.startsWith("rule:") ? value.slice("rule:".length) : "";
  if (requested && ids.has(requested)) return value;
  const fallback = defaultRulesProfileId && ids.has(defaultRulesProfileId)
    ? defaultRulesProfileId
    : SOURCE_PROFILE_IDS.balanced;
  return `rule:${fallback}`;
}
