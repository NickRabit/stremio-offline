import { isDeepStrictEqual } from "node:util";
import { LANGUAGE_NAMES } from "./language.js";
import {
  parseSourcePolicyV1,
  type ReleaseKind,
  type SourcePolicyCriterion,
  type SourcePolicyV1,
} from "./source-policy.js";

export type RuleResolution = 360 | 480 | 720 | 1080 | 2160;
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
  audio: { mode: "prefer" | "only"; fallback: string | null };
  subtitles: "off" | "ifAvailable" | "required";
  maxSizeGb: { episode: number | null; movie: number | null };
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

const parser = (value: unknown): DownloadRules => {
  const input = objectValue(value, [
    "addons",
    "torrents",
    "resolution",
    "audio",
    "subtitles",
    "maxSizeGb",
    "skipCinema",
    "preference",
  ]);
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

  const audio = objectValue(input.audio, ["mode", "fallback"]);
  const mode = enumValue(audio.mode, ["prefer", "only"] as const);
  let fallback: string | null = null;
  if (audio.fallback !== null) {
    const normalized = typeof audio.fallback === "string"
      ? audio.fallback.toLowerCase()
      : "";
    if (!/^[a-z]{2}$/.test(normalized) || !Object.hasOwn(LANGUAGE_NAMES, normalized)) {
      return fail();
    }
    fallback = normalized;
  }
  if (mode === "only" && fallback !== null) return fail();

  const sizes = objectValue(input.maxSizeGb, ["episode", "movie"]);
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

  const parsed: DownloadRules = {
    addons: { scope, order },
    torrents: input.torrents,
    resolution: { min, max },
    audio: { mode, fallback },
    subtitles: enumValue(input.subtitles, ["off", "ifAvailable", "required"] as const),
    maxSizeGb: {
      episode: sizeGb(sizes.episode),
      movie: sizeGb(sizes.movie),
    },
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
  if (!criteria.some((criterion) => criterion.kind === "audioTier")) {
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
  const maximum = rules.maxSizeGb[kind];
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
        preferred: { preference: "audio" },
        ...(rules.audio.fallback === null ? {} : { fallback: { code: rules.audio.fallback } }),
      },
      subtitles: rules.subtitles === "off"
        ? { mode: "off" }
        : {
            mode: rules.subtitles === "required" ? "required" : "optional",
            preferred: { preference: "subtitle" },
          },
      ...(height === undefined ? {} : { heightPixels: height }),
      ...(maximum === null ? {} : { bytes: { max: Math.round(maximum * 1_000_000_000) } }),
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
  const maximum = policy.constraints.bytes;
  if (maximum?.min !== undefined) return fail();
  const maximumGb = maximum?.max === undefined ? null : maximum.max / 1_000_000_000;
  const audioMode = policy.constraints.audio.mode === "strict" ? "only" : "prefer";
  releaseKinds(policy);
  const rules = parseDownloadRules({
    addons: { scope, order },
    torrents: policy.constraints.sourceKinds.includes("torrent"),
    resolution: {
      min: height?.min === undefined ? null : resolution(height.min),
      max: height?.max === undefined ? null : resolution(height.max),
    },
    audio: {
      mode: audioMode,
      fallback: audioFallback && "code" in audioFallback ? audioFallback.code : null,
    },
    subtitles: policy.constraints.subtitles.mode === "off"
      ? "off"
      : policy.constraints.subtitles.mode === "required" ? "required" : "ifAvailable",
    maxSizeGb: {
      episode: kind === "episode" ? sizeGb(maximumGb) : null,
      movie: kind === "movie" ? sizeGb(maximumGb) : null,
    },
    skipCinema: policy.constraints.excludeReleaseKinds !== undefined,
    preference,
  });
  if (!isDeepStrictEqual(materializeForComparison(rules, policy, kind), policy)) return fail();
  return rules;
}
