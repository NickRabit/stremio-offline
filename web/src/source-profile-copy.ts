import { localeTag, t, type Key } from "./i18n";
import type { DownloadRules, SourceProfile } from "./types";

const PRESET_NAMES = {
  "rules.preset.balanced": "rules.preset.balanced",
  "rules.preset.best": "rules.preset.best",
  "rules.preset.smaller": "rules.preset.smaller",
  "rules.preset.myLanguage": "rules.preset.myLanguage",
} as const satisfies Record<string, Key>;

export type SourceProfileNameKey = keyof typeof PRESET_NAMES;

export const sourceProfileName = (nameKey: string | undefined, name?: string): string =>
  nameKey && nameKey in PRESET_NAMES
    ? t(PRESET_NAMES[nameKey as SourceProfileNameKey])
    : name?.trim() || "";

const number = (value: number) => new Intl.NumberFormat(localeTag(), { maximumFractionDigits: 1 }).format(value);
const lowerFirst = (value: string) => value.charAt(0).toLocaleLowerCase(localeTag()) + value.slice(1);

const resolutionSummary = (min: number | null | undefined, max: number | null | undefined) => {
  if (min != null && max != null) return min === max
    ? t("rules.resolutionValue", { height: min })
    : `${t("rules.resolutionValue", { height: min })}–${t("rules.resolutionValue", { height: max })}`;
  if (min != null) return `${t("rules.resolutionValue", { height: min })}+`;
  if (max != null) return `≤${t("rules.resolutionValue", { height: max })}`;
  return t("rules.summary.anyResolution");
};

const summary = (min: number | null | undefined, max: number | null | undefined,
  audio: "prefer" | "only", maxGb: number | null | undefined, kind: "episode" | "movie") => [
  resolutionSummary(min, max),
  lowerFirst(t(audio === "prefer" ? "rules.audioPrefer" : "rules.audioOnly")),
  maxGb == null ? "" : t(kind === "episode" ? "rules.summary.upToEpisode" : "rules.summary.upToMovie", { size: number(maxGb) }),
].filter(Boolean).join(" · ");

export const rulesSummary = (rules: DownloadRules, kind: "episode" | "movie" = "episode") =>
  summary(rules.resolution.min, rules.resolution.max, rules.audio.mode, rules.maxSizeGb[kind], kind);

export const profileSummary = (profile: SourceProfile, kind: "episode" | "movie") => {
  const height = profile.policy.constraints.heightPixels;
  const bytes = profile.policy.constraints.bytes?.max;
  return summary(height?.min, height?.max,
    profile.policy.constraints.audio.mode === "strict" ? "only" : "prefer",
    bytes == null ? null : bytes / 1_000_000_000, kind);
};

export const profilePrefersAudio = (profile: SourceProfile) =>
  profile.policy.constraints.audio.mode === "preferred";
