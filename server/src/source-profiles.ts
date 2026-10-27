import { allowedAddons } from "./addons.js";
import {
  parseDownloadRules,
  rulesPolicy,
  type DownloadRules,
} from "./download-rules.js";
import { mayDownloadToDevice, mayDownloadToLibrary } from "./downloads.js";
import { visibleLibraries, type LibraryRecord, type Viewer } from "./libraries.js";
import { remoteLibraryVisibleTo } from "./media-server-access.js";
import type { MediaConnectionRecord, RemoteLibraryRecord } from "./media-server-types.js";
import { parseSourcePolicyV1, type SourcePolicyV1 } from "./source-policy.js";
import type { StoredSourceProfile } from "./store.js";
import type { AddonRecord } from "./types.js";
import type { UserRecord } from "./users.js";

export const SOURCE_PROFILE_IDS = Object.freeze({
  recommended: "39de76cc-0ca0-4a5e-95ad-08927fb45410",
  providerPriority: "390a8b1a-85f6-4ded-9d7e-701a299720bb",
  travel: "7e15d713-965c-4636-9ed3-3a112c521fe1",
  balanced: "88302ead-d701-4282-9059-777d47ed913c",
  best: "a02923f1-3457-478e-94b2-a0051f233de9",
  smaller: "2cb9cd41-d5dc-45cd-b765-a0f98149a5b1",
  myLanguage: "f57e4033-dafe-4d7c-88de-4def19014aac",
} as const);

export type SourceOperation = "play" | "downloadToLibrary" | "downloadToDevice";
export type SourceProfileTemplate = "recommended" | "travel" | "providerPriority" | "rules";

export interface TravelParameters {
  scope: { mode: "allAvailable" } | { mode: "selected"; addonKeys: string[] };
  providerOrder: { from: "viewer" } | { addonKeys: string[] };
  audioMode: "listed" | "preferred" | "strict";
  subtitleMode: "off" | "optional" | "required";
  heightPixels: { min: number; max?: number };
}

export interface ProviderPriorityParameters {
  scope: TravelParameters["scope"];
  providerOrder: TravelParameters["providerOrder"];
  sizeDirection: "asc" | "desc";
  transfer: Array<"http" | "torrent">;
  audioMode: "listed" | "preferred";
  subtitleMode: "off" | "optional";
}

interface TemplateParameters {
  recommended: undefined;
  travel: TravelParameters;
  providerPriority: ProviderPriorityParameters;
  rules: DownloadRules;
}

export interface SourceProfileDefinition {
  readonly id: string;
  readonly nameKey: string;
  readonly revision: 1;
  readonly operations: readonly SourceOperation[];
  readonly policy: SourcePolicyV1;
}

export interface PublicSourceProfile {
  id: string;
  nameKey?: string;
  name?: string;
  revision: number;
  template: SourceProfileTemplate;
  operations: SourceOperation[];
  sizeLimits?: {
    episodeBytes?: number;
    movieBytes?: number;
  };
  policy: SourcePolicyV1;
}

export interface SourceProfileViewer {
  id: string;
  role: UserRecord["role"];
  disabled?: boolean;
  permissions: UserRecord["permissions"];
}

export interface SourceProfileCatalogue {
  viewer: SourceProfileViewer;
  profiles: readonly StoredSourceProfile[];
  addons: readonly AddonRecord[];
  libraries: readonly LibraryRecord[];
  remoteLibraries: readonly RemoteLibraryRecord[];
  mediaConnections: readonly MediaConnectionRecord[];
}

const OPERATIONS: readonly SourceOperation[] = Object.freeze([
  "play",
  "downloadToLibrary",
  "downloadToDevice",
]);

const DEFAULT_TRAVEL_PARAMETERS: TravelParameters = {
  scope: { mode: "allAvailable" },
  providerOrder: { from: "viewer" },
  audioMode: "preferred",
  subtitleMode: "optional",
  heightPixels: { min: 480 },
};

const DEFAULT_PROVIDER_PRIORITY_PARAMETERS: ProviderPriorityParameters = {
  scope: { mode: "allAvailable" },
  providerOrder: { from: "viewer" },
  sizeDirection: "desc",
  transfer: ["http", "torrent"],
  audioMode: "preferred",
  subtitleMode: "optional",
};

const commonPresetRules = {
  addons: { scope: "all", order: "viewer" },
  torrents: true,
  subtitles: "ifAvailable",
  skipCinema: true,
} as const;

export interface RulePreset {
  readonly id: string;
  readonly nameKey: string;
  readonly template: "rules";
  readonly rules: DownloadRules;
}

const preset = (
  id: string,
  nameKey: string,
  rules: DownloadRules,
): RulePreset => deepFreeze({
  id,
  nameKey,
  template: "rules",
  rules: parseDownloadRules(rules),
});

export const RULE_PRESETS: readonly RulePreset[] = Object.freeze([
  preset(SOURCE_PROFILE_IDS.balanced, "rules.preset.balanced", {
    ...commonPresetRules,
    resolution: { min: 720, max: 1080 },
    audio: { mode: "prefer", fallback: null },
    maxSizeGb: { episode: 4, movie: 15 },
    preference: ["language", "resolutionHigher", "addonOrder", "smaller"],
  }),
  preset(SOURCE_PROFILE_IDS.best, "rules.preset.best", {
    ...commonPresetRules,
    resolution: { min: 1080, max: 2160 },
    audio: { mode: "prefer", fallback: null },
    maxSizeGb: { episode: null, movie: null },
    preference: ["resolutionHigher", "language", "larger", "addonOrder"],
  }),
  preset(SOURCE_PROFILE_IDS.smaller, "rules.preset.smaller", {
    ...commonPresetRules,
    resolution: { min: 480, max: 720 },
    audio: { mode: "prefer", fallback: null },
    maxSizeGb: { episode: 1.5, movie: 5 },
    preference: ["language", "smaller", "addonOrder"],
  }),
  preset(SOURCE_PROFILE_IDS.myLanguage, "rules.preset.myLanguage", {
    ...commonPresetRules,
    resolution: { min: 720, max: 1080 },
    audio: { mode: "only", fallback: null },
    maxSizeGb: { episode: 4, movie: 15 },
    preference: ["resolutionHigher", "addonOrder", "smaller"],
  }),
]);

export function rulesForPreset(id: keyof Pick<typeof SOURCE_PROFILE_IDS,
  "balanced" | "best" | "smaller" | "myLanguage">): DownloadRules {
  const found = RULE_PRESETS.find((candidate) => candidate.id === SOURCE_PROFILE_IDS[id]);
  if (!found) throw new Error(`Missing ${id} download rules preset.`);
  return structuredClone(found.rules);
}

type ParametersFor<T extends SourceProfileTemplate> = TemplateParameters[T];

export function defaultTemplateParameters(template: "recommended"): undefined;
export function defaultTemplateParameters(template: "travel"): TravelParameters;
export function defaultTemplateParameters(template: "providerPriority"): ProviderPriorityParameters;
export function defaultTemplateParameters(template: "rules"): DownloadRules;
export function defaultTemplateParameters(template: SourceProfileTemplate): ParametersFor<SourceProfileTemplate>;
export function defaultTemplateParameters(
  template: SourceProfileTemplate,
): DownloadRules | TravelParameters | ProviderPriorityParameters | undefined {
  if (template === "recommended") return undefined;
  if (template === "rules") return rulesForPreset("balanced");
  return structuredClone(template === "travel"
    ? DEFAULT_TRAVEL_PARAMETERS
    : DEFAULT_PROVIDER_PRIORITY_PARAMETERS);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const definition = (
  id: string,
  nameKey: string,
  policy: unknown,
): SourceProfileDefinition => deepFreeze({
  id,
  nameKey,
  revision: 1 as const,
  operations: [...OPERATIONS],
  policy: parseSourcePolicyV1(structuredClone(policy)),
});

export const SOURCE_PROFILE_DEFINITIONS: readonly SourceProfileDefinition[] = Object.freeze([
  definition(SOURCE_PROFILE_IDS.recommended, "sourceProfile.recommended", {
    schemaVersion: 1,
    scope: { mode: "allAvailable" },
    constraints: {
      sourceKinds: ["localFile", "mediaServerOriginal", "http", "torrent"],
      audio: { mode: "preferred", preferred: { preference: "audio" } },
      subtitles: { mode: "optional", preferred: { preference: "subtitle" } },
    },
    criteria: [
      { kind: "providerClass", order: ["local", "remote", "addon"] },
      { kind: "audioTier" },
      { kind: "providerOrder", from: "viewer" },
      { kind: "size", direction: "desc" },
    ],
    nextEpisode: "profile",
    existingLocalCopy: "meetsRequirements",
  }),
  definition(SOURCE_PROFILE_IDS.providerPriority, "sourceProfile.providerPriority", {
    schemaVersion: 1,
    scope: { mode: "allAvailable" },
    constraints: {
      sourceKinds: ["localFile", "mediaServerOriginal", "http", "torrent"],
      audio: { mode: "preferred", preferred: { preference: "audio" } },
      subtitles: { mode: "optional", preferred: { preference: "subtitle" } },
    },
    criteria: [
      { kind: "providerClass", order: ["local", "remote", "addon"] },
      { kind: "providerOrder", from: "viewer" },
      { kind: "audioTier" },
      { kind: "size", direction: "desc" },
    ],
    nextEpisode: "profile",
    existingLocalCopy: "meetsRequirements",
  }),
  definition(SOURCE_PROFILE_IDS.travel, "sourceProfile.travel", {
    schemaVersion: 1,
    scope: { mode: "allAvailable" },
    constraints: {
      sourceKinds: ["localFile", "http", "mediaServerOriginal"],
      audio: { mode: "preferred", preferred: { preference: "audio" } },
      subtitles: { mode: "optional", preferred: { preference: "subtitle" } },
      heightPixels: { min: 480 },
    },
    criteria: [
      { kind: "audioTier" },
      { kind: "size", direction: "asc" },
      { kind: "providerOrder", from: "viewer" },
    ],
    nextEpisode: "profile",
    existingLocalCopy: "meetsRequirements",
  }),
]);

export class SourceProfileParametersValidationError extends Error {
  constructor() {
    super("Invalid source profile parameters.");
    this.name = "SourceProfileParametersValidationError";
  }
}

const failParameters = (): never => {
  throw new SourceProfileParametersValidationError();
};

const parametersObject = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    return failParameters();
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key)
    || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
    || !("value" in Object.getOwnPropertyDescriptor(value, key)!))
    || required.some((key) => !Object.hasOwn(value, key))) {
    return failParameters();
  }
  return value as Record<string, unknown>;
};

const parametersArray = (value: unknown, min: number, max: number): unknown[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < min || value.length > max) {
    return failParameters();
  }
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !("value" in descriptor)) return failParameters();
  }
  if (Reflect.ownKeys(value).some((key) => key !== "length"
    && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
    return failParameters();
  }
  return Array.from(value);
};

const addonKeys = (
  value: unknown,
  min: number,
  max: number,
): string[] => {
  const keys = parametersArray(value, min, max).map((key) => {
    if (typeof key !== "string" || key.trim().length === 0) return failParameters();
    return key;
  });
  if (new Set(keys).size !== keys.length) return failParameters();
  return keys;
};

const parseScope = (value: unknown): TravelParameters["scope"] => {
  const scope = parametersObject(value, ["mode"], ["addonKeys"]);
  if (scope.mode === "allAvailable") {
    parametersObject(scope, ["mode"]);
    return { mode: "allAvailable" };
  }
  if (scope.mode !== "selected") return failParameters();
  parametersObject(scope, ["mode", "addonKeys"]);
  return { mode: "selected", addonKeys: addonKeys(scope.addonKeys, 1, 50) };
};

const parseProviderOrder = (value: unknown): TravelParameters["providerOrder"] => {
  const order = parametersObject(value, [], ["from", "addonKeys"]);
  if (Object.hasOwn(order, "from")) {
    parametersObject(order, ["from"]);
    if (order.from !== "viewer") return failParameters();
    return { from: "viewer" };
  }
  parametersObject(order, ["addonKeys"]);
  return { addonKeys: addonKeys(order.addonKeys, 0, 50) };
};

const parseTravelParameters = (value: unknown): TravelParameters => {
  const input = parametersObject(value, [
    "scope",
    "providerOrder",
    "audioMode",
    "subtitleMode",
    "heightPixels",
  ]);
  if (input.audioMode !== "listed" && input.audioMode !== "preferred" && input.audioMode !== "strict") {
    return failParameters();
  }
  if (input.subtitleMode !== "off" && input.subtitleMode !== "optional" && input.subtitleMode !== "required") {
    return failParameters();
  }
  const height = parametersObject(input.heightPixels, ["min"], ["max"]);
  const endpoint = (candidate: unknown): number => {
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate)
      || candidate < 144 || candidate > 4320) {
      return failParameters();
    }
    return candidate;
  };
  const min = endpoint(height.min);
  const max = Object.hasOwn(height, "max") ? endpoint(height.max) : undefined;
  if (max !== undefined && min > max) return failParameters();
  return {
    scope: parseScope(input.scope),
    providerOrder: parseProviderOrder(input.providerOrder),
    audioMode: input.audioMode,
    subtitleMode: input.subtitleMode,
    heightPixels: max === undefined ? { min } : { min, max },
  };
};

const parseProviderPriorityParameters = (value: unknown): ProviderPriorityParameters => {
  const input = parametersObject(value, [
    "scope",
    "providerOrder",
    "sizeDirection",
    "transfer",
    "audioMode",
    "subtitleMode",
  ]);
  if (input.sizeDirection !== "asc" && input.sizeDirection !== "desc") return failParameters();
  if (input.audioMode !== "listed" && input.audioMode !== "preferred") return failParameters();
  if (input.subtitleMode !== "off" && input.subtitleMode !== "optional") return failParameters();
  const transfer = parametersArray(input.transfer, 1, 2).map((kind) => {
    if (kind !== "http" && kind !== "torrent") return failParameters();
    return kind;
  });
  if (new Set(transfer).size !== transfer.length) return failParameters();
  return {
    scope: parseScope(input.scope),
    providerOrder: parseProviderOrder(input.providerOrder),
    sizeDirection: input.sizeDirection,
    transfer,
    audioMode: input.audioMode,
    subtitleMode: input.subtitleMode,
  };
};

export function parseTemplateParameters(
  template: "recommended",
  input: unknown,
): undefined;
export function parseTemplateParameters(
  template: "travel",
  input: unknown,
): TravelParameters;
export function parseTemplateParameters(
  template: "providerPriority",
  input: unknown,
): ProviderPriorityParameters;
export function parseTemplateParameters(
  template: "rules",
  input: unknown,
): DownloadRules;
export function parseTemplateParameters(
  template: SourceProfileTemplate,
  input: unknown,
): DownloadRules | TravelParameters | ProviderPriorityParameters | undefined;
export function parseTemplateParameters(
  template: SourceProfileTemplate,
  input: unknown,
): DownloadRules | TravelParameters | ProviderPriorityParameters | undefined {
  try {
    if (template === "recommended") {
      if (input !== undefined) return failParameters();
      return undefined;
    }
    if (template === "rules") return parseDownloadRules(input);
    return template === "travel"
      ? parseTravelParameters(input)
      : parseProviderPriorityParameters(input);
  } catch (error) {
    if (error instanceof SourceProfileParametersValidationError) throw error;
    if (error instanceof Error && error.name === "DownloadRulesValidationError") {
      throw new SourceProfileParametersValidationError();
    }
    throw new SourceProfileParametersValidationError();
  }
}

const recipeFor = (template: SourceProfileTemplate): SourceProfileDefinition => {
  if (template === "rules") throw new Error("The rules template has no fixed recipe.");
  const id = SOURCE_PROFILE_IDS[template];
  const recipe = SOURCE_PROFILE_DEFINITIONS.find((profile) => profile.id === id);
  if (!recipe) throw new Error(`Missing ${template} source profile recipe.`);
  return recipe;
};

export function buildTemplatePolicy(
  template: SourceProfileTemplate,
  parameters?: DownloadRules | TravelParameters | ProviderPriorityParameters,
  kind: "episode" | "movie" = "episode",
): SourcePolicyV1 {
  if (template === "rules") {
    return rulesPolicy(
      parseTemplateParameters(template, parameters ?? defaultTemplateParameters(template)),
      kind,
    );
  }
  const recipe = recipeFor(template);
  if (template === "recommended") {
    parseTemplateParameters(template, parameters);
    return parseSourcePolicyV1(structuredClone(recipe.policy));
  }

  const policy = structuredClone(recipe.policy);
  if (template === "travel") {
    const parsed = parseTemplateParameters(
      template,
      parameters ?? defaultTemplateParameters(template),
    );
    policy.scope = parsed.scope.mode === "allAvailable"
      ? { mode: "allAvailable" }
      : {
          mode: "selected",
          providerKeys: parsed.scope.addonKeys.map((key) => `addon:${key}`),
        };
    policy.constraints.audio = {
      mode: parsed.audioMode,
      preferred: { preference: "audio" },
    };
    policy.constraints.subtitles = {
      mode: parsed.subtitleMode,
      ...(parsed.subtitleMode === "off" ? {} : { preferred: { preference: "subtitle" as const } }),
    };
    policy.criteria = policy.criteria.map((criterion) => {
      if (criterion.kind !== "providerOrder") return criterion;
      return "from" in parsed.providerOrder
        ? { kind: "providerOrder", from: "viewer" }
        : {
            kind: "providerOrder",
            keys: parsed.providerOrder.addonKeys.map((key) => `addon:${key}`),
          };
    });
    policy.constraints.heightPixels = structuredClone(parsed.heightPixels);
  } else {
    const parsed = parseTemplateParameters(
      template,
      parameters ?? defaultTemplateParameters(template),
    );
    policy.scope = parsed.scope.mode === "allAvailable"
      ? { mode: "allAvailable" }
      : {
          mode: "selected",
          providerKeys: parsed.scope.addonKeys.map((key) => `addon:${key}`),
        };
    policy.constraints.audio = {
      mode: parsed.audioMode,
      preferred: { preference: "audio" },
    };
    policy.constraints.subtitles = {
      mode: parsed.subtitleMode,
      ...(parsed.subtitleMode === "off" ? {} : { preferred: { preference: "subtitle" as const } }),
    };
    policy.criteria = policy.criteria.map((criterion) => {
      if (criterion.kind === "providerOrder") {
        return "from" in parsed.providerOrder
          ? { kind: "providerOrder", from: "viewer" }
          : {
              kind: "providerOrder",
              keys: parsed.providerOrder.addonKeys.map((key) => `addon:${key}`),
            };
      }
      if (criterion.kind === "size") {
        return { kind: "size", direction: parsed.sizeDirection };
      }
      return criterion;
    });
    const transfer = new Set(parsed.transfer);
    policy.constraints.sourceKinds = recipe.policy.constraints.sourceKinds.filter((kind) =>
      kind !== "http" && kind !== "torrent" || transfer.has(kind));
  }
  return parseSourcePolicyV1(policy);
}

export const declaresStream = (addon: AddonRecord): boolean =>
  (addon.manifest.resources ?? []).some((resource) =>
    typeof resource === "string" ? resource === "stream" : resource.name === "stream");

export function rulesForLegacyVariant(
  template: Exclude<SourceProfileTemplate, "recommended" | "rules">,
  parameters: TravelParameters | ProviderPriorityParameters,
): DownloadRules {
  const parsed = template === "travel"
    ? parseTemplateParameters("travel", parameters)
    : parseTemplateParameters("providerPriority", parameters);
  const addons: DownloadRules["addons"] = {
    scope: parsed.scope.mode === "allAvailable"
      ? "all"
      : { selected: [...parsed.scope.addonKeys] },
    order: "from" in parsed.providerOrder
      ? "viewer"
      : { explicit: [...parsed.providerOrder.addonKeys] },
  };
  if (template === "travel") {
    const travel = parsed as TravelParameters;
    const nearest = (value: number): Exclude<DownloadRules["resolution"]["min"], null> =>
      [360, 480, 720, 1080, 2160].reduce<number>((best, candidate) =>
        Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best, 360) as
        Exclude<DownloadRules["resolution"]["min"], null>;
    return parseDownloadRules({
      addons,
      torrents: false,
      resolution: {
        min: nearest(travel.heightPixels.min),
        max: travel.heightPixels.max === undefined
          ? null
          : nearest(travel.heightPixels.max),
      },
      audio: { mode: travel.audioMode === "strict" ? "only" : "prefer", fallback: null },
      subtitles: travel.subtitleMode === "optional" ? "ifAvailable" : travel.subtitleMode,
      maxSizeGb: { episode: null, movie: null },
      skipCinema: false,
      preference: ["language", "smaller", "addonOrder"],
    });
  }
  const provider = parsed as ProviderPriorityParameters;
  return parseDownloadRules({
    addons,
    torrents: provider.transfer.includes("torrent"),
    resolution: { min: null, max: null },
    audio: { mode: "prefer", fallback: null },
    subtitles: provider.subtitleMode === "optional" ? "ifAvailable" : provider.subtitleMode,
    maxSizeGb: { episode: null, movie: null },
    skipCinema: false,
    preference: ["addonOrder", "language", provider.sizeDirection === "asc" ? "smaller" : "larger"],
  });
}

export const isExecutableDownloadProfile = (
  profile: { template: SourceProfileTemplate },
): boolean => profile.template === "travel"
  || profile.template === "providerPriority"
  || profile.template === "rules";

const copyPolicy = (policy: SourcePolicyV1): SourcePolicyV1 => structuredClone(policy);

export function sourceProfilesForViewer(catalogue: SourceProfileCatalogue): PublicSourceProfile[] {
  const { viewer } = catalogue;
  if (viewer.disabled) return [];

  const usableAddons = allowedAddons([...catalogue.addons], viewer)
    .filter((addon) => addon.enabled && addon.role !== "catalog" && declaresStream(addon));
  const usableAddonKeys = new Set(usableAddons.map((addon) => `addon:${addon.key}`));
  const hasAddonPath = usableAddons.length > 0;
  const hasLocalPath = visibleLibraries([...catalogue.libraries], viewer)
    .some((library) => library.enabled);
  const hasRemotePath = catalogue.remoteLibraries
    .some((library) => remoteLibraryVisibleTo(catalogue.mediaConnections, library, viewer));

  return catalogue.profiles.flatMap((profile) => {
    const storedPolicy = buildTemplatePolicy(profile.template, profile.parameters);
    let policy = copyPolicy(storedPolicy);
    let addonPath = hasAddonPath;
    if (policy.scope.mode === "selected") {
      const selected = policy.scope.providerKeys.filter((key) => usableAddonKeys.has(key));
      if (!selected.length) return [];
      const selectedSet = new Set(selected);
      policy.scope = { mode: "selected", providerKeys: selected };
      policy.criteria = policy.criteria.map((criterion) => {
        if (criterion.kind !== "providerOrder" || !("keys" in criterion)) return criterion;
        const ordered = criterion.keys.filter((key) => selectedSet.has(key));
        const seen = new Set(ordered);
        return { kind: "providerOrder", keys: [...ordered, ...selected.filter((key) => !seen.has(key))] };
      });
      addonPath = selected.length > 0;
    }
    policy.criteria = policy.criteria.map((criterion) =>
      criterion.kind === "providerOrder" && "keys" in criterion
        ? { kind: "providerOrder", keys: criterion.keys.filter((key) => usableAddonKeys.has(key)) }
        : criterion);

    const kinds = new Set(policy.constraints.sourceKinds);
    const addonDownloadPath = addonPath && (kinds.has("http") || kinds.has("torrent"));
    const localPath = policy.scope.mode === "allAvailable" && hasLocalPath && kinds.has("localFile");
    const remotePath = policy.scope.mode === "allAvailable" && hasRemotePath && kinds.has("mediaServerOriginal");
    const playPath = addonPath || localPath || remotePath;

    const operations = OPERATIONS.filter((operation) => {
      if (operation === "play") return playPath;
      if (operation === "downloadToLibrary") {
        return mayDownloadToLibrary(viewer) && addonDownloadPath && isExecutableDownloadProfile(profile);
      }
      return mayDownloadToDevice(viewer) && (addonDownloadPath || localPath || remotePath);
    });
    if (!operations.length) return [];

    const sizeLimits = profile.template === "rules"
      ? (() => {
          const rules = parseDownloadRules(profile.parameters);
          return {
            ...(rules.maxSizeGb.episode === null ? {} : { episodeBytes: rules.maxSizeGb.episode * 1_000_000_000 }),
            ...(rules.maxSizeGb.movie === null ? {} : { movieBytes: rules.maxSizeGb.movie * 1_000_000_000 }),
          };
        })()
      : undefined;
    return [{
      id: profile.id,
      ...(profile.nameKey === undefined ? {} : { nameKey: profile.nameKey }),
      ...(profile.name === undefined ? {} : { name: profile.name }),
      revision: profile.revision,
      template: profile.template,
      operations,
      ...(sizeLimits === undefined ? {} : { sizeLimits }),
      policy,
    }];
  });
}

export const viewerOfProfileAccount = (user: Pick<UserRecord, "id" | "role" | "permissions" | "disabled">): SourceProfileViewer => ({
  id: user.id,
  role: user.role,
  permissions: { ...user.permissions },
  ...(user.disabled === undefined ? {} : { disabled: user.disabled }),
});
