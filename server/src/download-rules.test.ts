import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DownloadRulesValidationError,
  parseDownloadRules,
  rulesAudioMode,
  rulesFromPolicy,
  rulesPolicy,
  type DownloadRules,
} from "./download-rules.js";
import { RULE_PRESETS, rulesForPreset } from "./source-profiles.js";
import type { SourcePolicyV1 } from "./source-policy.js";

const rules = (overrides: Partial<DownloadRules> = {}): DownloadRules => ({
  addons: { scope: "all", order: "viewer" },
  torrents: true,
  resolution: { min: 720, max: 1080 },
  audio: { mode: "prefer", language: "mine", fallback: null },
  subtitles: "ifAvailable",
  sizeGb: {
    episode: { min: null, max: 4 },
    movie: { min: null, max: 15 },
  },
  skipCinema: true,
  preference: ["language", "resolutionHigher", "addonOrder", "smaller"],
  ...overrides,
});

const materialize = (policy: SourcePolicyV1): SourcePolicyV1 => {
  const preferred = "code" in policy.constraints.audio.preferred
    ? policy.constraints.audio.preferred.code
    : "en";
  const subtitle = policy.constraints.subtitles.preferred;
  const subtitleLanguage = subtitle && "code" in subtitle ? subtitle.code : undefined;
  const providerKeys = policy.scope.mode === "selected"
    ? policy.scope.providerKeys
    : ["addon:alpha", "addon:beta"];
  const audioFallback = policy.constraints.audio.fallback && "code" in policy.constraints.audio.fallback
    ? policy.constraints.audio.fallback.code
    : undefined;
  const subtitleFallback = policy.constraints.subtitles.fallback
    && "code" in policy.constraints.subtitles.fallback
    ? policy.constraints.subtitles.fallback.code
    : undefined;
  return {
    ...structuredClone(policy),
    scope: { mode: "selected", providerKeys },
    constraints: {
      ...structuredClone(policy.constraints),
      audio: {
        mode: policy.constraints.audio.mode,
        preferred: { code: preferred },
        ...(audioFallback === undefined ? {} : { fallback: { code: audioFallback } }),
      },
      ...(policy.constraints.subtitles.mode === "off" ? {} : {
        subtitles: {
          mode: policy.constraints.subtitles.mode,
          preferred: { code: subtitleLanguage ?? "en" },
          ...(subtitleFallback === undefined ? {} : { fallback: { code: subtitleFallback } }),
        },
      }),
    },
    criteria: policy.criteria.map((criterion) => criterion.kind === "providerOrder"
      ? { kind: "providerOrder", keys: providerKeys }
      : structuredClone(criterion)),
  };
};

test("each preset maps to the expected episode and movie policy", () => {
  assert.deepEqual(rulesPolicy(rulesForPreset("balanced"), "episode"), {
    schemaVersion: 1,
    scope: { mode: "allAvailable" },
    constraints: {
      sourceKinds: ["localFile", "mediaServerOriginal", "http", "torrent"],
      audio: { mode: "preferred", preferred: { preference: "audio" } },
      subtitles: { mode: "optional", preferred: { preference: "subtitle" } },
      heightPixels: { min: 720, max: 1080 },
      bytes: { max: 4_000_000_000 },
      excludeReleaseKinds: ["cam", "telesync", "screener"],
    },
    criteria: [
      { kind: "audioTier" },
      { kind: "resolution", direction: "desc" },
      { kind: "providerOrder", from: "viewer" },
      { kind: "size", direction: "asc" },
    ],
    nextEpisode: "profile",
    existingLocalCopy: "meetsRequirements",
  });
  assert.deepEqual(rulesPolicy(rulesForPreset("best"), "movie"), {
    schemaVersion: 1,
    scope: { mode: "allAvailable" },
    constraints: {
      sourceKinds: ["localFile", "mediaServerOriginal", "http", "torrent"],
      audio: { mode: "preferred", preferred: { preference: "audio" } },
      subtitles: { mode: "optional", preferred: { preference: "subtitle" } },
      heightPixels: { min: 1080, max: 2160 },
      excludeReleaseKinds: ["cam", "telesync", "screener"],
    },
    criteria: [
      { kind: "resolution", direction: "desc" },
      { kind: "audioTier" },
      { kind: "size", direction: "desc" },
      { kind: "providerOrder", from: "viewer" },
    ],
    nextEpisode: "profile",
    existingLocalCopy: "meetsRequirements",
  });
  assert.deepEqual(rulesPolicy(rulesForPreset("smaller"), "episode"), {
    schemaVersion: 1,
    scope: { mode: "allAvailable" },
    constraints: {
      sourceKinds: ["localFile", "mediaServerOriginal", "http", "torrent"],
      audio: { mode: "preferred", preferred: { preference: "audio" } },
      subtitles: { mode: "optional", preferred: { preference: "subtitle" } },
      heightPixels: { min: 480, max: 720 },
      bytes: { max: 1_500_000_000 },
      excludeReleaseKinds: ["cam", "telesync", "screener"],
    },
    criteria: [
      { kind: "audioTier" },
      { kind: "size", direction: "asc" },
      { kind: "providerOrder", from: "viewer" },
    ],
    nextEpisode: "profile",
    existingLocalCopy: "meetsRequirements",
  });
  assert.deepEqual(rulesPolicy(rulesForPreset("myLanguage"), "movie"), {
    schemaVersion: 1,
    scope: { mode: "allAvailable" },
    constraints: {
      sourceKinds: ["localFile", "mediaServerOriginal", "http", "torrent"],
      audio: { mode: "strict", preferred: { preference: "audio" } },
      subtitles: { mode: "optional", preferred: { preference: "subtitle" } },
      heightPixels: { min: 720, max: 1080 },
      bytes: { max: 15_000_000_000 },
      excludeReleaseKinds: ["cam", "telesync", "screener"],
    },
    criteria: [
      { kind: "resolution", direction: "desc" },
      { kind: "providerOrder", from: "viewer" },
      { kind: "size", direction: "asc" },
      { kind: "audioTier" },
    ],
    nextEpisode: "profile",
    existingLocalCopy: "meetsRequirements",
  });
  assert.deepEqual(RULE_PRESETS.map((preset) => preset.nameKey), [
    "rules.preset.balanced",
    "rules.preset.best",
    "rules.preset.smaller",
    "rules.preset.myLanguage",
  ]);
});

test("rulesFromPolicy maps materialized policies back to equivalent rules", () => {
  for (const preset of RULE_PRESETS) {
    for (const kind of ["episode", "movie"] as const) {
      const policy = materialize(rulesPolicy(preset.rules, kind));
      const extracted = parseDownloadRules(rulesFromPolicy(policy, kind));
      assert.deepEqual(materialize(rulesPolicy(extracted, kind)), policy);
    }
  }

  const selected = rules({
    addons: { scope: { selected: ["alpha", "beta"] }, order: { explicit: ["beta", "alpha"] } },
    torrents: false,
    resolution: { min: null, max: 720 },
    audio: { mode: "prefer", language: "mine", fallback: "cs" },
    subtitles: "required",
    sizeGb: {
      episode: { min: null, max: null },
      movie: { min: null, max: 5 },
    },
    skipCinema: false,
    preference: ["larger", "resolutionLower", "addonOrder", "language"],
  });
  const policy = materialize(rulesPolicy(selected, "movie"));
  const extracted = parseDownloadRules(rulesFromPolicy(policy, "movie"));
  assert.deepEqual(materialize(rulesPolicy(extracted, "movie")), policy);
});

test("rule validation is strict and rejects contradictory choices", () => {
  assert.throws(() => parseDownloadRules({ ...rules(), unexpected: true }), DownloadRulesValidationError);
  assert.throws(() => parseDownloadRules(rules({ resolution: { min: 1080, max: 720 } })), DownloadRulesValidationError);
  assert.throws(() => parseDownloadRules(rules({ preference: ["resolutionHigher", "resolutionLower"] })), DownloadRulesValidationError);
  assert.throws(() => parseDownloadRules(rules({ preference: ["smaller", "larger"] })), DownloadRulesValidationError);
  assert.throws(() => parseDownloadRules(rules({
    audio: { mode: "only", language: "mine", fallback: "cs" },
  })), DownloadRulesValidationError);
  assert.throws(() => parseDownloadRules(rules({
    sizeGb: { episode: { min: 0, max: null }, movie: { min: null, max: null } },
  })), DownloadRulesValidationError);
  assert.throws(() => parseDownloadRules(rules({
    sizeGb: { episode: { min: 1.25, max: null }, movie: { min: null, max: null } },
  })), DownloadRulesValidationError);
  assert.throws(() => parseDownloadRules(rules({
    audio: { mode: "prefer", language: "mine", fallback: "cze" },
  })), DownloadRulesValidationError);
  assert.throws(() => parseDownloadRules(rules({ preference: [] })), DownloadRulesValidationError);
  assert.throws(() => parseDownloadRules(rules({ preference: ["language", "language"] })), DownloadRulesValidationError);
  assert.throws(() => parseDownloadRules(rules({ addons: { scope: { selected: [] }, order: "viewer" } })), DownloadRulesValidationError);
});

test("v2 rules round-trip all audio modes with mine or an explicit language", () => {
  const variants: DownloadRules[] = [
    rules({ audio: { mode: "any", language: "mine", fallback: null }, preference: ["smaller"] }),
    rules({ audio: { mode: "prefer", language: "mine", fallback: "en" } }),
    rules({ audio: { mode: "prefer", language: "EN", fallback: "cs" } as DownloadRules["audio"] }),
    rules({ audio: { mode: "only", language: "en", fallback: null } }),
  ];
  for (const variant of variants) {
    const parsed = parseDownloadRules(variant);
    assert.deepEqual(parseDownloadRules(parsed), parsed);
    assert.equal(rulesAudioMode(rulesPolicy(parsed, "episode")), parsed.audio.mode);
  }
  assert.equal(parseDownloadRules(variants[2]).audio.language, "en");
});

test("v2 audio and size validation is strict", () => {
  for (const invalid of [
    rules({ audio: { mode: "any", language: "en", fallback: null }, preference: ["smaller"] }),
    rules({ audio: { mode: "any", language: "mine", fallback: "en" }, preference: ["smaller"] }),
    rules({ audio: { mode: "any", language: "mine", fallback: null }, preference: ["language"] }),
    rules({ audio: { mode: "prefer", language: "english", fallback: null } }),
    rules({ audio: { mode: "prefer", language: "en", fallback: "en" } }),
    rules({ sizeGb: { episode: { min: 2, max: 1 }, movie: { min: null, max: null } } }),
    rules({ sizeGb: { episode: { min: null, max: 201 }, movie: { min: null, max: null } } }),
  ]) {
    assert.throws(() => parseDownloadRules(invalid), DownloadRulesValidationError);
  }
});

test("legacy v1 rules normalize to v2 and mixed shapes are rejected", () => {
  const legacy = {
    addons: { scope: "all", order: "viewer" },
    torrents: true,
    resolution: { min: 720, max: 1080 },
    audio: { mode: "prefer", fallback: "cs" },
    subtitles: "ifAvailable",
    maxSizeGb: { episode: 4, movie: 15 },
    skipCinema: true,
    preference: ["language", "smaller"],
  };
  assert.deepEqual(parseDownloadRules(legacy), rules({
    audio: { mode: "prefer", language: "mine", fallback: "cs" },
    sizeGb: {
      episode: { min: null, max: 4 },
      movie: { min: null, max: 15 },
    },
    preference: ["language", "smaller"],
  }));
  assert.throws(() => parseDownloadRules({
    ...legacy,
    audio: { mode: "prefer", language: "mine", fallback: "cs" },
  }), DownloadRulesValidationError);
  assert.throws(() => parseDownloadRules({
    ...rules(),
    maxSizeGb: { episode: 4, movie: 15 },
  }), DownloadRulesValidationError);
});

test("any audio omits audioTier and size ranges map to byte bounds", () => {
  const any = rules({
    audio: { mode: "any", language: "mine", fallback: null },
    preference: ["resolutionHigher", "smaller"],
    sizeGb: {
      episode: { min: 1, max: 4 },
      movie: { min: null, max: null },
    },
  });
  const anyPolicy = rulesPolicy(any, "episode");
  assert.equal(anyPolicy.criteria.some((criterion) => criterion.kind === "audioTier"), false);
  assert.deepEqual(anyPolicy.constraints.audio.preferred, { preference: "audio" });
  assert.deepEqual(anyPolicy.constraints.bytes, {
    min: 1_000_000_000,
    max: 4_000_000_000,
  });

  const explicit = rules({
    audio: { mode: "only", language: "en", fallback: null },
    preference: ["language"],
  });
  assert.deepEqual(rulesPolicy(explicit, "movie").constraints.audio.preferred, { code: "en" });
});

test("rulesFromPolicy equals canonical v2 rules for the selected media kind", () => {
  const variants = [
    rules({
      audio: { mode: "any", language: "mine", fallback: null },
      preference: ["resolutionHigher", "smaller"],
      sizeGb: {
        episode: { min: 1, max: 4 },
        movie: { min: null, max: null },
      },
    }),
    rules({
      audio: { mode: "prefer", language: "mine", fallback: "cs" },
      sizeGb: {
        episode: { min: null, max: null },
        movie: { min: 2, max: 8 },
      },
    }),
    rules({
      audio: { mode: "only", language: "en", fallback: null },
      preference: ["resolutionHigher", "addonOrder", "smaller"],
      sizeGb: {
        episode: { min: 1, max: 3 },
        movie: { min: null, max: null },
      },
    }),
  ];
  for (const variant of variants) {
    const kind = variant.audio.mode === "prefer" ? "movie" : "episode";
    assert.deepEqual(rulesFromPolicy(rulesPolicy(variant, kind), kind), variant);
  }
});

test("non-canonical preferences round-trip through policy equivalence", () => {
  const variants = [
    rules({
      audio: { mode: "any", language: "mine", fallback: null },
      preference: ["resolutionHigher", "addonOrder"],
    }),
    rules({
      audio: { mode: "prefer", language: "mine", fallback: null },
      preference: ["resolutionHigher", "language"],
    }),
    rules({
      audio: { mode: "only", language: "mine", fallback: null },
      preference: ["resolutionHigher", "language"],
    }),
  ];
  for (const variant of variants) {
    for (const kind of ["episode", "movie"] as const) {
      const policy = rulesPolicy(variant, kind);
      assert.deepEqual(rulesPolicy(rulesFromPolicy(policy, kind), kind), policy);
    }
  }
});
