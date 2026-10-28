import { beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "./i18n";
import {
  profileAudioLanguage,
  profileAudioMode,
  profileSubtitleLanguage,
  profileSummary,
  rulesSummary,
} from "./source-profile-copy";
import type { DownloadRules, SourceProfile } from "./types";

type AudioPreference = { preference: "audio" } | { code: string };
type SubtitlePreference = { preference: "subtitle" } | { code: string };

const rules = (over: Partial<DownloadRules> = {}): DownloadRules => ({
  addons: { scope: "all", order: "viewer" }, torrents: true,
  resolution: { min: 720, max: 1080 }, audio: { mode: "prefer", language: "mine", fallback: null },
  subtitles: "ifAvailable", subtitleLanguage: "mine", sizeGb: {
    episode: { min: null, max: null }, movie: { min: null, max: null },
  }, skipCinema: true,
  preference: ["language", "addonOrder"], ...over,
});

const profile = ({
  mode = "preferred",
  preferred = { preference: "audio" },
  audioTier = true,
  subtitleMode = "off",
  subtitlePreferred,
  sizeLimits,
  bytes,
}: {
  mode?: "preferred" | "strict";
  preferred?: AudioPreference;
  audioTier?: boolean;
  subtitleMode?: "off" | "optional" | "required";
  subtitlePreferred?: SubtitlePreference;
  sizeLimits?: SourceProfile["sizeLimits"];
  bytes?: { min?: number; max?: number };
} = {}): SourceProfile => ({
  id: "profile", nameKey: "rules.preset.balanced", template: "rules", revision: 1,
  operations: ["downloadToLibrary"], ...(sizeLimits === undefined ? {} : { sizeLimits }),
  policy: {
    schemaVersion: 1, scope: { mode: "allAvailable" },
    constraints: {
      sourceKinds: ["localFile", "mediaServerOriginal", "http"], audio: { mode, preferred },
      subtitles: subtitleMode === "off"
        ? { mode: "off" }
        : { mode: subtitleMode, preferred: subtitlePreferred ?? { preference: "subtitle" } },
      heightPixels: { min: 720, max: 1080 },
      ...(bytes === undefined ? {} : { bytes }),
    },
    criteria: [
      ...(audioTier ? [{ kind: "audioTier" as const }] : []),
      { kind: "providerOrder", from: "viewer" },
    ],
    nextEpisode: "profile", existingLocalCopy: "meetsRequirements",
  },
});

beforeEach(() => setLocale("en"));

describe("rulesSummary", () => {
  it.each([
    ["any", { mode: "any", language: "mine", fallback: null }, "any language"],
    ["prefer mine", { mode: "prefer", language: "mine", fallback: null }, "prefer my language"],
    ["only mine", { mode: "only", language: "mine", fallback: null }, "my language only"],
    ["prefer code", { mode: "prefer", language: "en", fallback: null }, "prefer English"],
    ["only code", { mode: "only", language: "en", fallback: null }, "English only"],
  ] as const)("summarizes %s audio", (_label, audio, text) => {
    expect(rulesSummary(rules({ audio }))).toBe(`720p–1080p · ${text}`);
  });

  it.each(["episode", "movie"] as const)("summarizes every %s size branch", (kind) => {
    const label = kind === "episode" ? "episode" : "film";
    const withSize = (min: number | null, max: number | null) => rulesSummary(rules({
      audio: { mode: "any", language: "mine", fallback: null },
      sizeGb: { ...rules().sizeGb, [kind]: { min, max } },
    }), kind);
    expect(withSize(1.2, 3.4)).toBe(`720p–1080p · any language · ~1.2–3.4 GB per ${label}`);
    expect(withSize(null, 3.4)).toBe(`720p–1080p · any language · up to ~3.4 GB per ${label}`);
    expect(withSize(1.2, null)).toBe(`720p–1080p · any language · from ~1.2 GB per ${label}`);
    expect(withSize(null, null)).toBe("720p–1080p · any language");
  });
  it("writes a chosen language in lower case where the locale does", () => {
    setLocale("cs");
    expect(rulesSummary(rules({ audio: { mode: "prefer", language: "en", fallback: null } })))
      .toBe("720p–1080p · přednost: angličtina");
    expect(rulesSummary(rules({ audio: { mode: "only", language: "de", fallback: null } })))
      .toBe("720p–1080p · jen němčina");
  });

  it("appends only a chosen subtitle language", () => {
    expect(rulesSummary(rules({ subtitles: "required", subtitleLanguage: "cs" })))
      .toBe("720p–1080p · prefer my language · subtitles: Czech");
    expect(rulesSummary(rules())).toBe("720p–1080p · prefer my language");
    expect(rulesSummary(rules({ subtitles: "off" }))).toBe("720p–1080p · prefer my language");
  });
});

describe("profile summaries", () => {
  it.each([
    ["any", { audioTier: false }, "any language"],
    ["prefer mine", {}, "prefer my language"],
    ["only mine", { mode: "strict" as const }, "my language only"],
    ["prefer code", { preferred: { code: "en" } }, "prefer English"],
    ["only code", { mode: "strict" as const, preferred: { code: "en" } }, "English only"],
  ] as const)("derives %s audio from policy", (_label, options, text) => {
    expect(profileSummary(profile(options), "episode")).toBe(`720p–1080p · ${text}`);
  });

  it.each(["episode", "movie"] as const)("summarizes every %s size branch", (kind) => {
    const label = kind === "episode" ? "episode" : "film";
    const limits = (min: number | undefined, max: number | undefined) => kind === "episode"
      ? { episodeMinBytes: min, episodeBytes: max }
      : { movieMinBytes: min, movieBytes: max };
    const withSize = (min: number | undefined, max: number | undefined) =>
      profileSummary(profile({ audioTier: false, sizeLimits: limits(min, max) }), kind);
    expect(withSize(1_200_000_000, 3_400_000_000))
      .toBe(`720p–1080p · any language · ~1.2–3.4 GB per ${label}`);
    expect(withSize(undefined, 3_400_000_000))
      .toBe(`720p–1080p · any language · up to ~3.4 GB per ${label}`);
    expect(withSize(1_200_000_000, undefined))
      .toBe(`720p–1080p · any language · from ~1.2 GB per ${label}`);
    expect(withSize(undefined, undefined)).toBe("720p–1080p · any language");
  });

  it("falls back to policy byte constraints when sizeLimits is absent", () => {
    expect(profileSummary(profile({
      audioTier: false, bytes: { min: 1_200_000_000, max: 3_400_000_000 },
    }), "movie")).toBe("720p–1080p · any language · ~1.2–3.4 GB per film");
  });

  it("appends only a chosen profile subtitle language", () => {
    expect(profileSummary(profile({
      subtitleMode: "required",
      subtitlePreferred: { code: "cs" },
    }), "episode")).toBe("720p–1080p · prefer my language · subtitles: Czech");
    expect(profileSummary(profile(), "episode")).toBe("720p–1080p · prefer my language");
    expect(profileSummary(profile({
      subtitleMode: "optional",
      subtitlePreferred: { preference: "subtitle" },
    }), "episode")).toBe("720p–1080p · prefer my language");
  });

  it("exports the public audio mode and explicit languages", () => {
    expect(profileAudioMode(profile({ audioTier: false }))).toBe("any");
    expect(profileAudioMode(profile())).toBe("prefer");
    expect(profileAudioMode(profile({ mode: "strict" }))).toBe("only");
    expect(profileAudioLanguage(profile())).toBeUndefined();
    expect(profileAudioLanguage(profile({ preferred: { code: "en" } }))).toBe("en");
    expect(profileSubtitleLanguage(profile())).toBeUndefined();
    expect(profileSubtitleLanguage(profile({
      subtitleMode: "optional",
      subtitlePreferred: { code: "cs" },
    }))).toBe("cs");
  });
});
