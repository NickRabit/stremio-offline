import { inlineLanguageName, localeTag, t, type Key } from "./i18n";
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

const audioSummary = (mode: DownloadRules["audio"]["mode"], language: string | undefined) => {
  if (mode === "any") return t("rules.summary.anyLanguage");
  if (language === undefined) {
    return lowerFirst(t(mode === "prefer" ? "rules.audioPrefer" : "rules.audioOnly"));
  }
  return t(mode === "prefer" ? "rules.summary.preferLanguage" : "rules.summary.onlyLanguage", {
    language: inlineLanguageName(language),
  });
};

const sizeSummary = (
  min: number | null | undefined,
  max: number | null | undefined,
  kind: "episode" | "movie",
) => {
  if (min != null && max != null) {
    return t(kind === "episode" ? "rules.summary.rangeEpisode" : "rules.summary.rangeMovie", {
      min: number(min), max: number(max),
    });
  }
  if (max != null) {
    return t(kind === "episode" ? "rules.summary.upToEpisode" : "rules.summary.upToMovie", {
      size: number(max),
    });
  }
  if (min != null) {
    return t(kind === "episode" ? "rules.summary.fromEpisode" : "rules.summary.fromMovie", {
      size: number(min),
    });
  }
  return "";
};

const subtitleSummary = (language: string | undefined) => language === undefined
  ? ""
  : t("rules.summary.subtitlesLanguage", { language: inlineLanguageName(language) });

const summary = (
  min: number | null | undefined,
  max: number | null | undefined,
  audio: DownloadRules["audio"]["mode"],
  language: string | undefined,
  sizeMin: number | null | undefined,
  sizeMax: number | null | undefined,
  kind: "episode" | "movie",
  subtitleLanguage: string | undefined,
) => [
  resolutionSummary(min, max),
  audioSummary(audio, language),
  sizeSummary(sizeMin, sizeMax, kind),
  subtitleSummary(subtitleLanguage),
].filter(Boolean).join(" · ");

export const rulesSummary = (rules: DownloadRules, kind: "episode" | "movie" = "episode") =>
  summary(
    rules.resolution.min,
    rules.resolution.max,
    rules.audio.mode,
    rules.audio.language === "mine" ? undefined : rules.audio.language,
    rules.sizeGb[kind].min,
    rules.sizeGb[kind].max,
    kind,
    rules.subtitles === "off" || rules.subtitleLanguage === "mine"
      ? undefined
      : rules.subtitleLanguage,
  );

export const profileAudioMode = (profile: SourceProfile): DownloadRules["audio"]["mode"] => {
  if (profile.policy.constraints.audio.mode === "strict") return "only";
  return profile.policy.criteria.some((criterion) => criterion.kind === "audioTier") ? "prefer" : "any";
};

export const profileAudioLanguage = (profile: SourceProfile): string | undefined => {
  const preferred = profile.policy.constraints.audio.preferred;
  return "code" in preferred ? preferred.code : undefined;
};

export const profileSubtitleLanguage = (profile: SourceProfile): string | undefined => {
  const preferred = profile.policy.constraints.subtitles.preferred;
  return profile.policy.constraints.subtitles.mode !== "off"
    && preferred !== undefined && "code" in preferred ? preferred.code : undefined;
};

export const profileSummary = (profile: SourceProfile, kind: "episode" | "movie") => {
  const height = profile.policy.constraints.heightPixels;
  const limits = profile.sizeLimits;
  const bytes = limits === undefined
    ? profile.policy.constraints.bytes
    : kind === "episode"
      ? { min: limits.episodeMinBytes, max: limits.episodeBytes }
      : { min: limits.movieMinBytes, max: limits.movieBytes };
  return summary(height?.min, height?.max,
    profileAudioMode(profile), profileAudioLanguage(profile),
    bytes?.min == null ? null : bytes.min / 1_000_000_000,
    bytes?.max == null ? null : bytes.max / 1_000_000_000, kind,
    profileSubtitleLanguage(profile));
};
