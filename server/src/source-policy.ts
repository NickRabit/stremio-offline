import { LANGUAGE_NAMES, normalizeLanguage } from "./language.js";

export type SourceKind = "localFile" | "http" | "torrent" | "mediaServerOriginal";
export type ProviderClass = "local" | "remote" | "addon";
export type AudioMode = "strict" | "listed" | "preferred";
export type SubtitleMode = "off" | "optional" | "required";
export type NextEpisodePolicy = "profile" | "sameProviderThenNearestSize";
export type ExistingLocalCopyPolicy = "any" | "meetsRequirements";
export type ReleaseKind = "cam" | "telesync" | "screener";

export type LanguageRef =
  | { code: string }
  | { preference: "audio" | "subtitle" };

export type SourcePolicyScope =
  | { mode: "allAvailable" }
  | { mode: "selected"; providerKeys: string[] };

export interface SourcePolicyRange {
  min?: number;
  max?: number;
}

export interface AudioConstraint {
  mode: AudioMode;
  preferred: LanguageRef;
  fallback?: LanguageRef;
}

export interface SubtitleConstraint {
  mode: SubtitleMode;
  preferred?: LanguageRef;
  fallback?: LanguageRef;
}

export interface SourcePolicyConstraints {
  sourceKinds: SourceKind[];
  audio: AudioConstraint;
  subtitles: SubtitleConstraint;
  bytes?: SourcePolicyRange;
  durationSeconds?: SourcePolicyRange;
  heightPixels?: SourcePolicyRange;
  excludeReleaseKinds?: ReleaseKind[];
}

export type SourcePolicyCriterion =
  | { kind: "providerClass"; order: ProviderClass[] }
  | { kind: "audioTier" }
  | { kind: "providerOrder"; keys: string[] }
  | { kind: "providerOrder"; from: "viewer" }
  | { kind: "size"; direction: "asc" | "desc" }
  | { kind: "resolution"; direction: "asc" | "desc" }
  | { kind: "subtitleTier" };

export interface SourcePolicyV1 {
  schemaVersion: 1;
  scope: SourcePolicyScope;
  constraints: SourcePolicyConstraints;
  criteria: SourcePolicyCriterion[];
  nextEpisode: NextEpisodePolicy;
  existingLocalCopy: ExistingLocalCopyPolicy;
}

export class SourcePolicyValidationError extends Error {
  constructor() {
    super("Invalid source policy.");
    this.name = "SourcePolicyValidationError";
  }
}

const fail = (): never => {
  throw new SourcePolicyValidationError();
};

const isDataProperty = (value: object, key: PropertyKey): boolean => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor;
};

const objectValue = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return fail();
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key) || !isDataProperty(value, key))
    || required.some((key) => !Object.hasOwn(value, key))) {
    return fail();
  }
  return value as Record<string, unknown>;
};

const assertExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void => {
  objectValue(value, required, optional);
};

const arrayValue = (value: unknown, max: number): unknown[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) return fail();
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length
      || !isDataProperty(value, key)) {
      return fail();
    }
  }
  const copy: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return fail();
    copy.push(value[index]);
  }
  return copy;
};

const enumValue = <T extends string>(value: unknown, values: readonly T[]): T => {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) return fail();
  return value as T;
};

const providerKey = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) return fail();
  return value;
};

const uniqueProviderKeys = (value: unknown, min: number, max: number): string[] => {
  const values = arrayValue(value, max).map(providerKey);
  if (values.length < min || new Set(values).size !== values.length) return fail();
  return values;
};

const sourceKind = (value: unknown): SourceKind =>
  enumValue(value, ["localFile", "http", "torrent", "mediaServerOriginal"] as const);

const parseScope = (value: unknown): SourcePolicyScope => {
  const scope = objectValue(value, ["mode"], ["providerKeys"]);
  const mode = enumValue(scope.mode, ["allAvailable", "selected"] as const);
  if (mode === "allAvailable") {
    assertExactKeys(scope, ["mode"]);
    return { mode };
  }
  assertExactKeys(scope, ["mode", "providerKeys"]);
  return { mode, providerKeys: uniqueProviderKeys(scope.providerKeys, 1, 64) };
};

const parseLanguageRef = (
  value: unknown,
  preference: "audio" | "subtitle",
): LanguageRef => {
  const candidate = objectValue(value, [], ["code", "preference"]);
  if (Object.hasOwn(candidate, "code") && !Object.hasOwn(candidate, "preference")) {
    assertExactKeys(candidate, ["code"]);
    if (typeof candidate.code !== "string") return fail();
    const code = normalizeLanguage(candidate.code);
    if (!code || !Object.hasOwn(LANGUAGE_NAMES, code)) return fail();
    return { code };
  }
  assertExactKeys(candidate, ["preference"]);
  if (candidate.preference !== preference) return fail();
  return { preference };
};

const refIdentity = (ref: LanguageRef): string =>
  "code" in ref ? `code:${ref.code}` : `preference:${ref.preference}`;

const parseAudio = (value: unknown): AudioConstraint => {
  const audio = objectValue(value, ["mode", "preferred"], ["fallback"]);
  const mode = enumValue(audio.mode, ["strict", "listed", "preferred"] as const);
  const preferred = parseLanguageRef(audio.preferred, "audio");
  const fallback = Object.hasOwn(audio, "fallback")
    ? parseLanguageRef(audio.fallback, "audio")
    : undefined;
  if (fallback && refIdentity(preferred) === refIdentity(fallback)) return fail();
  return fallback ? { mode, preferred, fallback } : { mode, preferred };
};

const parseSubtitles = (value: unknown): SubtitleConstraint => {
  const subtitles = objectValue(value, ["mode"], ["preferred", "fallback"]);
  const mode = enumValue(subtitles.mode, ["off", "optional", "required"] as const);
  if (mode === "off") {
    assertExactKeys(subtitles, ["mode"]);
    return { mode };
  }
  assertExactKeys(subtitles, ["mode", "preferred"], ["fallback"]);
  const preferred = parseLanguageRef(subtitles.preferred, "subtitle");
  const fallback = Object.hasOwn(subtitles, "fallback")
    ? parseLanguageRef(subtitles.fallback, "subtitle")
    : undefined;
  if (fallback && refIdentity(preferred) === refIdentity(fallback)) return fail();
  return fallback ? { mode, preferred, fallback } : { mode, preferred };
};

const parseRange = (value: unknown, minimum: number): SourcePolicyRange => {
  const range = objectValue(value, [], ["min", "max"]);
  if (!Object.hasOwn(range, "min") && !Object.hasOwn(range, "max")) return fail();
  const parseEndpoint = (endpoint: unknown): number => {
    if (typeof endpoint !== "number" || !Number.isSafeInteger(endpoint) || endpoint < minimum) return fail();
    return endpoint;
  };
  const min = Object.hasOwn(range, "min") ? parseEndpoint(range.min) : undefined;
  const max = Object.hasOwn(range, "max") ? parseEndpoint(range.max) : undefined;
  if (min !== undefined && max !== undefined && min > max) return fail();
  if (min !== undefined && max !== undefined) return { min, max };
  return min !== undefined ? { min } : { max: max! };
};

const parseConstraints = (value: unknown): SourcePolicyConstraints => {
  const constraints = objectValue(
    value,
    ["sourceKinds", "audio", "subtitles"],
    ["bytes", "durationSeconds", "heightPixels", "excludeReleaseKinds"],
  );
  const kinds = arrayValue(constraints.sourceKinds, 4).map(sourceKind);
  if (kinds.length === 0 || new Set(kinds).size !== kinds.length) return fail();
  const parsed: SourcePolicyConstraints = {
    sourceKinds: kinds,
    audio: parseAudio(constraints.audio),
    subtitles: parseSubtitles(constraints.subtitles),
  };
  if (Object.hasOwn(constraints, "bytes")) parsed.bytes = parseRange(constraints.bytes, 0);
  if (Object.hasOwn(constraints, "durationSeconds")) {
    parsed.durationSeconds = parseRange(constraints.durationSeconds, 1);
  }
  if (Object.hasOwn(constraints, "heightPixels")) {
    parsed.heightPixels = parseRange(constraints.heightPixels, 1);
  }
  if (Object.hasOwn(constraints, "excludeReleaseKinds")) {
    const releaseKinds = arrayValue(constraints.excludeReleaseKinds, 3)
      .map((kind) => enumValue(kind, ["cam", "telesync", "screener"] as const));
    if (new Set(releaseKinds).size !== releaseKinds.length) return fail();
    parsed.excludeReleaseKinds = releaseKinds;
  }
  return parsed;
};

const parseCriterion = (value: unknown): SourcePolicyCriterion => {
  const criterion = objectValue(value, ["kind"], ["order", "keys", "from", "direction"]);
  const kind = enumValue(
    criterion.kind,
    ["providerClass", "audioTier", "providerOrder", "size", "resolution", "subtitleTier"] as const,
  );
  switch (kind) {
    case "providerClass": {
      assertExactKeys(criterion, ["kind", "order"]);
      const order = arrayValue(criterion.order, 3)
        .map((entry) => enumValue(entry, ["local", "remote", "addon"] as const));
      if (order.length !== 3 || new Set(order).size !== 3) return fail();
      return { kind, order };
    }
    case "providerOrder": {
      if (Object.hasOwn(criterion, "keys")) {
        assertExactKeys(criterion, ["kind", "keys"]);
        return { kind, keys: uniqueProviderKeys(criterion.keys, 0, 64) };
      }
      assertExactKeys(criterion, ["kind", "from"]);
      if (criterion.from !== "viewer") return fail();
      return { kind, from: "viewer" };
    }
    case "size":
    case "resolution": {
      assertExactKeys(criterion, ["kind", "direction"]);
      const direction = enumValue(criterion.direction, ["asc", "desc"] as const);
      return { kind, direction };
    }
    case "audioTier":
    case "subtitleTier":
      assertExactKeys(criterion, ["kind"]);
      return { kind };
  }
};

const parseCriteria = (value: unknown): SourcePolicyCriterion[] => {
  const criteria = arrayValue(value, 8).map(parseCriterion);
  if (new Set(criteria.map((criterion) => criterion.kind)).size !== criteria.length) return fail();
  return criteria;
};

const parsePolicy = (value: unknown): SourcePolicyV1 => {
  const policy = objectValue(
    value,
    ["schemaVersion", "scope", "constraints", "criteria", "nextEpisode", "existingLocalCopy"],
  );
  if (policy.schemaVersion !== 1) return fail();
  return {
    schemaVersion: 1,
    scope: parseScope(policy.scope),
    constraints: parseConstraints(policy.constraints),
    criteria: parseCriteria(policy.criteria),
    nextEpisode: enumValue(policy.nextEpisode, ["profile", "sameProviderThenNearestSize"] as const),
    existingLocalCopy: enumValue(policy.existingLocalCopy, ["any", "meetsRequirements"] as const),
  };
};

export function parseSourcePolicyV1(value: unknown): SourcePolicyV1 {
  try {
    return parsePolicy(value);
  } catch (error) {
    if (error instanceof SourcePolicyValidationError) throw error;
    throw new SourcePolicyValidationError();
  }
}
