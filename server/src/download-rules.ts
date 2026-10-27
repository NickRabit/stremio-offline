import { isDeepStrictEqual } from "node:util";
import { LANGUAGE_NAMES } from "./language.js";
import {
  parseSourcePolicyV1,
  type ReleaseKind,
  type SourcePolicyCriterion,
  type SourcePolicyV1,
} from "./source-policy.js";

export type RuleResolution = 360 | 480 | 720 | 1080 | 2160;
export type RuleAudioMode = "any" | "prefer" | "only";
export interface RuleSizeRange { min: number | null; max: number | null }
export type RulePreference =
  | "language"
  | "resolutionHigher"
  | "resolutionLower"
  | "smaller"
  | "larger"
  | "addonOrder";

export interface DownloadRules {
  addons: {
    scope: "all" | { selected: string[] };
    order: "viewer" | { explicit: string[] };
  };
  torrents: boolean;
  resolution: { min: RuleResolution | null; max: RuleResolution | null };
  audio: {
    mode: RuleAudioMode;
    language: "mine" | string;
    fallback: string | null;
  };
  subtitles: "off" | "ifAvailable" | "required";
  sizeGb: { episode: RuleSizeRange; movie: RuleSizeRange };
  skipCinema: boolean;
  preference: RulePreference[];
}

export class DownloadRulesValidationError extends Error {
  constructor() {
    super("Invalid download rules.");
    this.name = "DownloadRulesValidationError";
  }
}

const fail = (): never => {
  throw new DownloadRulesValidationError();
};

const dataProperty = (value: object, key: PropertyKey): PropertyDescriptor | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor && descriptor.enumerable ? descriptor : undefined;
};

const objectValue = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    return fail();
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key) || !dataProperty(value, key))
    || required.some((key) => !Object.hasOwn(value, key))) {
    return fail();
  }
  return value as Record<string, unknown>;
};

const arrayValue = (value: unknown, min: number, max: number): unknown[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < min || value.length > max) {
    return fail();
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!dataProperty(value, index) || !Object.hasOwn(value, index)) return fail();
  }
  if (Reflect.ownKeys(value).some((key) => key !== "length"
    && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
    return fail();
  }
  return Array.from(value);
};

const enumValue = <T extends string>(value: unknown, values: readonly T[]): T => {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) return fail();
  return value as T;
};

const addonKeys = (value: unknown, min: number, max: number): string[] => {
  const keys = arrayValue(value, min, max).map((key) => {
    if (typeof key !== "string" || key.trim().length === 0) return fail();
    return key;
  });
  if (new Set(keys).size !== keys.length) return fail();
  return keys;
};

const resolution = (value: unknown): RuleResolution | null => {
  if (value === null) return null;
  if (typeof value !== "number" || ![360, 480, 720, 1080, 2160].includes(value)) return fail();
  return value as RuleResolution;
};

const sizeGb = (value: unknown): number | null => {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0.1 || value > 200
    || Math.abs(value * 10 - Math.round(value * 10)) > 1e-9) {
    return fail();
  }
  return value;
};

const sizeRange = (value: unknown): RuleSizeRange => {
  const range = objectValue(value, ["min", "max"]);
  const min = sizeGb(range.min);
  const max = sizeGb(range.max);
  if (min !== null && max !== null && min > max) return fail();
  return { min, max };
};

const languageCode = (value: unknown): string | null => {
  if (value === null) return null;
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (!/^[a-z]{2}$/.test(normalized) || !Object.hasOwn(LANGUAGE_NAMES, normalized)) {
    return fail();
  }
  return normalized;
};

const parser = (value: unknown): DownloadRules => {
  const input = objectValue(
    value,
    ["addons", "torrents", "resolution", "audio", "subtitles", "skipCinema", "preference"],
    ["sizeGb", "maxSizeGb"],
  );
  const hasSizeRange = Object.hasOwn(input, "sizeGb");
  const hasLegacyMaximum = Object.hasOwn(input, "maxSizeGb");
  if (hasSizeRange === hasLegacyMaximum) return fail();
  const addons = objectValue(input.addons, ["scope", "order"]);
  let scope: DownloadRules["addons"]["scope"];
  if (addons.scope === "all") {
    scope = "all";
  } else {
    const selected = objectValue(addons.scope, ["selected"]);
    scope = { selected: addonKeys(selected.selected, 1, 50) };
  }
  let order: DownloadRules["addons"]["order"];
  if (addons.order === "viewer") {
    order = "viewer";
  } else {
    const explicit = objectValue(addons.order, ["explicit"]);
    order = { explicit: addonKeys(explicit.explicit, 0, 50) };
  }

  const bounds = objectValue(input.resolution, ["min", "max"]);
  const min = resolution(bounds.min);
  const max = resolution(bounds.max);
  if (min !== null && max !== null && min > max) return fail();

  const preferences = arrayValue(input.preference, 1, 4)
    .map((preference) => enumValue(preference, [
      "language",
      "resolutionHigher",
      "resolutionLower",
      "smaller",
      "larger",
      "addonOrder",
    ] as const));
  if (new Set(preferences).size !== preferences.length
    || (preferences.includes("resolutionHigher") && preferences.includes("resolutionLower"))
    || (preferences.includes("smaller") && preferences.includes("larger"))) {
    return fail();
  }
  if (typeof input.torrents !== "boolean" || typeof input.skipCinema !== "boolean") return fail();

  let mode: RuleAudioMode;
  let language: DownloadRules["audio"]["language"];
  let fallback: string | null;
  let sizes: DownloadRules["sizeGb"];
  if (hasLegacyMaximum) {
    const audio = objectValue(input.audio, ["mode", "fallback"]);
    mode = enumValue(audio.mode, ["prefer", "only"] as const);
    language = "mine";
    fallback = languageCode(audio.fallback);
    if (mode === "only" && fallback !== null) return fail();

    const legacySizes = objectValue(input.maxSizeGb, ["episode", "movie"]);
    sizes = {
      episode: { min: null, max: sizeGb(legacySizes.episode) },
      movie: { min: null, max: sizeGb(legacySizes.movie) },
    };
  } else {
    const audio = objectValue(input.audio, ["mode", "language", "fallback"]);
    mode = enumValue(audio.mode, ["any", "prefer", "only"] as const);
    const rawLanguage = audio.language;
    if (rawLanguage !== "mine" && typeof rawLanguage !== "string") return fail();
    language = rawLanguage === "mine" ? "mine" : languageCode(rawLanguage) ?? fail();
    fallback = languageCode(audio.fallback);
    if (mode === "any" && (language !== "mine" || fallback !== null
      || preferences.includes("language"))) {
      return fail();
    }
    if (mode === "only" && fallback !== null) return fail();
    if (language !== "mine" && fallback === language) return fail();

    const ranges = objectValue(input.sizeGb, ["episode", "movie"]);
    sizes = {
      episode: sizeRange(ranges.episode),
      movie: sizeRange(ranges.movie),
    };
  }

  const parsed: DownloadRules = {
    addons: { scope, order },
    torrents: input.torrents,
    resolution: { min, max },
    audio: { mode, language, fallback },
    subtitles: enumValue(input.subtitles, ["off", "ifAvailable", "required"] as const),
    sizeGb: sizes,
    skipCinema: input.skipCinema,
    preference: preferences,
  };
  return structuredClone(parsed);
};

export function parseDownloadRules(input: unknown): DownloadRules {
  try {
    return parser(input);
  } catch (error) {
    if (error instanceof DownloadRulesValidationError) throw error;
    throw new DownloadRulesValidationError();
  }
}

const criterionFor = (
  preference: RulePreference,
  order: DownloadRules["addons"]["order"],
): SourcePolicyCriterion => {
  switch (preference) {
    case "language": return { kind: "audioTier" };
    case "resolutionHigher": return { kind: "resolution", direction: "desc" };
    case "resolutionLower": return { kind: "resolution", direction: "asc" };
    case "smaller": return { kind: "size", direction: "asc" };
    case "larger": return { kind: "size", direction: "desc" };
    case "addonOrder":
      return order === "viewer"
        ? { kind: "providerOrder", from: "viewer" }
        : { kind: "providerOrder", keys: order.explicit.map((key) => `addon:${key}`) };
  }
};

export function rulesPolicy(
  input: DownloadRules,
  kind: "episode" | "movie",
): SourcePolicyV1 {
  const rules = parseDownloadRules(input);
  const criteria = rules.preference.map((preference) => criterionFor(preference, rules.addons.order));
  if (rules.audio.mode !== "any"
    && !criteria.some((criterion) => criterion.kind === "audioTier")) {
    criteria.push({ kind: "audioTier" });
  }
  if (!criteria.some((criterion) => criterion.kind === "providerOrder")) {
    criteria.push(criterionFor("addonOrder", rules.addons.order));
  }

  const height = rules.resolution.min === null && rules.resolution.max === null
    ? undefined
    : {
        ...(rules.resolution.min === null ? {} : { min: rules.resolution.min }),
        ...(rules.resolution.max === null ? {} : { max: rules.resolution.max }),
      };
  const size = rules.sizeGb[kind];
  const bytes = size.min === null && size.max === null
    ? undefined
    : {
        ...(size.min === null ? {} : { min: Math.round(size.min * 1_000_000_000) }),
        ...(size.max === null ? {} : { max: Math.round(size.max * 1_000_000_000) }),
      };
  return parseSourcePolicyV1({
    schemaVersion: 1,
    scope: rules.addons.scope === "all"
      ? { mode: "allAvailable" }
      : {
          mode: "selected",
          providerKeys: rules.addons.scope.selected.map((key) => `addon:${key}`),
        },
    constraints: {
      sourceKinds: [
        "localFile",
        "mediaServerOriginal",
        "http",
        ...(rules.torrents ? ["torrent" as const] : []),
      ],
      audio: {
        mode: rules.audio.mode === "only" ? "strict" : "preferred",
        preferred: rules.audio.language === "mine"
          ? { preference: "audio" }
          : { code: rules.audio.language },
        ...(rules.audio.fallback === null ? {} : { fallback: { code: rules.audio.fallback } }),
      },
      subtitles: rules.subtitles === "off"
        ? { mode: "off" }
        : {
            mode: rules.subtitles === "required" ? "required" : "optional",
            preferred: { preference: "subtitle" },
          },
      ...(height === undefined ? {} : { heightPixels: height }),
      ...(bytes === undefined ? {} : { bytes }),
      ...(rules.skipCinema
        ? { excludeReleaseKinds: ["cam", "telesync", "screener"] }
        : {}),
    },
    criteria,
    nextEpisode: "profile",
    existingLocalCopy: "meetsRequirements",
  });
}

const sameArray = <T>(left: readonly T[], right: readonly T[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const preferenceFor = (criterion: SourcePolicyCriterion): RulePreference | undefined => {
  switch (criterion.kind) {
    case "audioTier": return "language";
    case "providerOrder": return "addonOrder";
    case "resolution": return criterion.direction === "desc" ? "resolutionHigher" : "resolutionLower";
    case "size": return criterion.direction === "desc" ? "larger" : "smaller";
    default: return undefined;
  }
};

export function rulesAudioMode(policy: SourcePolicyV1): RuleAudioMode {
  if (policy.constraints.audio.mode === "strict") return "only";
  if (policy.constraints.audio.mode === "preferred"
    && !policy.criteria.some((criterion) => criterion.kind === "audioTier")) {
    return "any";
  }
  return "prefer";
}

const releaseKinds = (policy: SourcePolicyV1): ReleaseKind[] | undefined => {
  const kinds = policy.constraints.excludeReleaseKinds;
  if (kinds === undefined) return undefined;
  if (!sameArray(kinds, ["cam", "telesync", "screener"])) return fail();
  return kinds;
};

const materializeForComparison = (
  rules: DownloadRules,
  source: SourcePolicyV1,
  kind: "episode" | "movie",
): SourcePolicyV1 => {
  if (source.scope.mode !== "selected") return fail();
  const providerKeys = [...source.scope.providerKeys];
  const built = rulesPolicy(rules, kind);
  const selected = new Set(providerKeys);
  return {
    ...built,
    scope: { mode: "selected", providerKeys },
    constraints: {
      ...built.constraints,
      audio: {
        mode: built.constraints.audio.mode,
        preferred: structuredClone(source.constraints.audio.preferred),
        ...(built.constraints.audio.fallback === undefined
          ? {}
          : { fallback: structuredClone(built.constraints.audio.fallback) }),
      },
      ...(built.constraints.subtitles.mode === "off"
        ? { subtitles: { mode: "off" as const } }
        : {
            subtitles: {
              mode: built.constraints.subtitles.mode,
              preferred: structuredClone(source.constraints.subtitles.preferred!),
            },
          }),
    },
    criteria: built.criteria.map((criterion) => {
      if (criterion.kind !== "providerOrder") return criterion;
      const listed = ("keys" in criterion ? criterion.keys : providerKeys)
        .filter((key) => selected.has(key));
      const seen = new Set(listed);
      return {
        kind: "providerOrder",
        keys: [...listed, ...providerKeys.filter((key) => !seen.has(key))],
      };
    }),
  };
};

export function rulesFromPolicy(policy: SourcePolicyV1, kind: "episode" | "movie"): DownloadRules {
  const kinds: Array<SourcePolicyV1["constraints"]["sourceKinds"][number]> = [
    "localFile",
    "mediaServerOriginal",
    "http",
  ];
  if (policy.constraints.sourceKinds.includes("torrent")) kinds.push("torrent");
  if (!sameArray(policy.constraints.sourceKinds, kinds)
    || policy.nextEpisode !== "profile"
    || policy.existingLocalCopy !== "meetsRequirements"
    || policy.constraints.durationSeconds !== undefined
    || (policy.constraints.audio.mode !== "strict" && policy.constraints.audio.mode !== "preferred")
    || policy.constraints.subtitles.fallback !== undefined) {
    return fail();
  }

  let scope: DownloadRules["addons"]["scope"];
  if (policy.scope.mode === "allAvailable") {
    scope = "all";
  } else {
    if (policy.scope.providerKeys.some((key) => !key.startsWith("addon:"))) return fail();
    scope = {
      selected: policy.scope.providerKeys.map((key) => key.slice("addon:".length)),
    };
  }

  const providerOrder = policy.criteria.find((criterion) => criterion.kind === "providerOrder");
  let order: DownloadRules["addons"]["order"] = "viewer";
  if (providerOrder?.kind === "providerOrder") {
    if ("from" in providerOrder) {
      order = "viewer";
    } else {
      if (providerOrder.keys.some((key) => !key.startsWith("addon:"))) {
        order = "viewer";
      } else {
        order = {
          explicit: providerOrder.keys.map((key) => key.slice("addon:".length)),
        };
      }
    }
  }

  const criterionPreferences = [...policy.criteria];
  if (criterionPreferences.length > 1
    && criterionPreferences.at(-1)?.kind === "providerOrder") {
    criterionPreferences.pop();
  }
  if (criterionPreferences.length > 1
    && criterionPreferences.at(-1)?.kind === "audioTier") {
    criterionPreferences.pop();
  }
  const preference = criterionPreferences.map((criterion) => {
    const mapped = preferenceFor(criterion);
    if (!mapped) return fail();
    return mapped;
  });

  const audioFallback = policy.constraints.audio.fallback;
  if (audioFallback !== undefined && !("code" in audioFallback)) return fail();
  const height = policy.constraints.heightPixels;
  const bytes = policy.constraints.bytes;
  const sizeRange = (reported: boolean): RuleSizeRange => ({
    min: reported && bytes?.min !== undefined
      ? sizeGb(bytes.min / 1_000_000_000)
      : null,
    max: reported && bytes?.max !== undefined
      ? sizeGb(bytes.max / 1_000_000_000)
      : null,
  });
  releaseKinds(policy);
  const rules = parseDownloadRules({
    addons: { scope, order },
    torrents: policy.constraints.sourceKinds.includes("torrent"),
    resolution: {
      min: height?.min === undefined ? null : resolution(height.min),
      max: height?.max === undefined ? null : resolution(height.max),
    },
    audio: {
      mode: rulesAudioMode(policy),
      // A materialised policy always names a code; only an unmaterialised one can tell a chosen language from "mine".
      language: policy.scope.mode === "allAvailable" && "code" in policy.constraints.audio.preferred
        ? policy.constraints.audio.preferred.code
        : "mine",
      fallback: audioFallback && "code" in audioFallback ? audioFallback.code : null,
    },
    subtitles: policy.constraints.subtitles.mode === "off"
      ? "off"
      : policy.constraints.subtitles.mode === "required" ? "required" : "ifAvailable",
    sizeGb: {
      episode: sizeRange(kind === "episode"),
      movie: sizeRange(kind === "movie"),
    },
    skipCinema: policy.constraints.excludeReleaseKinds !== undefined,
    preference,
  });
  const comparison = policy.scope.mode === "allAvailable"
    ? rulesPolicy(rules, kind)
    : materializeForComparison(rules, policy, kind);
  if (!isDeepStrictEqual(comparison, policy)) return fail();
  return rules;
}
