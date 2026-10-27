import { isDeepStrictEqual } from "node:util";
import { allowedAddons, orderedForUser } from "./addons.js";
import { mayDownloadToDevice, mayDownloadToLibrary } from "./downloads.js";
import { LANGUAGE_NAMES, normalizeLanguage } from "./language.js";
import { visibleLibraries, type LibraryRecord } from "./libraries.js";
import { remoteLibraryVisibleTo } from "./media-server-access.js";
import type { MediaConnectionRecord, RemoteLibraryRecord } from "./media-server-types.js";
import {
  isExecutableDownloadProfile,
  SOURCE_PROFILE_DEFINITIONS,
  type SourceOperation,
  type SourceProfileDefinition,
  type SourceProfileViewer,
} from "./source-profiles.js";
import {
  parseSourcePolicyV1,
  type LanguageRef,
  type SourcePolicyCriterion,
  type SourcePolicyV1,
} from "./source-policy.js";
import type { AddonRecord } from "./types.js";

export interface SourceProfileReference {
  profileId: string;
  revision: number;
}

export interface SourceAdmissionPreferences {
  audioLanguage?: string;
  subtitleLanguage?: string;
}

export interface SourceAdmissionContext {
  viewer: SourceProfileViewer;
  addons: readonly AddonRecord[];
  libraries: readonly LibraryRecord[];
  remoteLibraries: readonly RemoteLibraryRecord[];
  mediaConnections: readonly MediaConnectionRecord[];
  addonOrder?: readonly string[];
  preferences: SourceAdmissionPreferences;
  operation: SourceOperation;
}

export interface SourceAdmissionSnapshotV1 {
  schemaVersion: 1;
  profile: { id: string; revision: number };
  operation: SourceOperation;
  providerKeys: string[];
  policy: SourcePolicyV1;
}

export type SourceAdmissionRejectionCode =
  | "profileUnknown"
  | "profileRevisionStale"
  | "operationUnsupported"
  | "operationForbidden"
  | "providerScopeUnavailable"
  | "languagePreferenceUnavailable"
  | "languagePreferenceDuplicate";

const REJECTION_MESSAGES: Record<SourceAdmissionRejectionCode, string> = {
  profileUnknown: "The source profile is unavailable.",
  profileRevisionStale: "The source profile revision is unavailable.",
  operationUnsupported: "The source profile does not support this operation.",
  operationForbidden: "This account may not use this source profile operation.",
  providerScopeUnavailable: "No authorized source provider is available for this operation.",
  languagePreferenceUnavailable: "The source language preference is unavailable.",
  languagePreferenceDuplicate: "The source language preferences conflict.",
};

export class SourceAdmissionRejected extends Error {
  readonly code: SourceAdmissionRejectionCode;

  constructor(code: SourceAdmissionRejectionCode) {
    super(REJECTION_MESSAGES[code]);
    this.name = "SourceAdmissionRejected";
    this.code = code;
  }
}

export class SourceAdmissionValidationError extends Error {
  constructor() {
    super("Invalid source admission data.");
    this.name = "SourceAdmissionValidationError";
  }
}

const failValidation = (): never => {
  throw new SourceAdmissionValidationError();
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
    return failValidation();
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key) || !dataProperty(value, key))
    || required.some((key) => !Object.hasOwn(value, key))) {
    return failValidation();
  }
  return value as Record<string, unknown>;
};

const arrayValue = (value: unknown, min: number, max: number): unknown[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < min || value.length > max) {
    return failValidation();
  }
  for (let index = 0; index < value.length; index++) {
    if (!dataProperty(value, index) || !Object.hasOwn(value, index)) return failValidation();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => key !== "length"
    && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
    return failValidation();
  }
  return Array.from(value);
};

const providerKey = (value: unknown): string => {
  if (typeof value !== "string") return failValidation();
  if (value === "local") return value;
  for (const prefix of ["remote:", "addon:"]) {
    if (value.startsWith(prefix) && value.length > prefix.length) return value;
  }
  return failValidation();
};

const providerKeys = (value: unknown): string[] => {
  const keys = arrayValue(value, 1, 64).map(providerKey);
  if (new Set(keys).size !== keys.length) return failValidation();
  return keys;
};

const sameKeys = (left: readonly string[], right: readonly string[]): boolean => {
  const wanted = new Set(left);
  return left.length === right.length && right.every((key) => wanted.has(key));
};

const operation = (value: unknown): SourceOperation => {
  if (value === "play" || value === "downloadToLibrary" || value === "downloadToDevice") return value;
  return failValidation();
};

const referenceValue = (value: unknown): SourceProfileReference => {
  const reference = objectValue(value, ["profileId", "revision"]);
  const profileId = dataProperty(reference, "profileId")?.value;
  const revision = dataProperty(reference, "revision")?.value;
  if (typeof profileId !== "string" || profileId.length === 0
    || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision <= 0) {
    return failValidation();
  }
  return { profileId, revision };
};

export function parseSourceProfileReference(input: unknown): SourceProfileReference {
  try {
    return referenceValue(input);
  } catch (error) {
    if (error instanceof SourceAdmissionValidationError) throw error;
    throw new SourceAdmissionValidationError();
  }
}

export function sourceAdmissionProviderScope(
  scope: SourcePolicyV1["scope"],
  availableProviderKeys: readonly string[],
): string[] {
  if (scope.mode === "allAvailable") return [...availableProviderKeys];
  const selected = new Set(scope.providerKeys);
  return availableProviderKeys.filter((key) => selected.has(key));
}

const resolveLanguage = (
  reference: LanguageRef,
  preference: string | undefined,
): LanguageRef => {
  const raw = "code" in reference ? reference.code : preference;
  const code = normalizeLanguage(raw);
  if (!code || !Object.hasOwn(LANGUAGE_NAMES, code)) {
    throw new SourceAdmissionRejected("languagePreferenceUnavailable");
  }
  return { code };
};

const noDuplicateLanguage = (preferred: LanguageRef, fallback: LanguageRef | undefined): void => {
  if (fallback && "code" in preferred && "code" in fallback && preferred.code === fallback.code) {
    throw new SourceAdmissionRejected("languagePreferenceDuplicate");
  }
};

export function materializeSourceAdmissionPolicy(
  policy: SourcePolicyV1,
  selectedProviderKeys: readonly string[],
  preferences: SourceAdmissionPreferences,
): SourcePolicyV1 {
  if (selectedProviderKeys.length === 0 || selectedProviderKeys.length > 64) {
    throw new SourceAdmissionRejected("providerScopeUnavailable");
  }

  const concreteProviderKeys = [...selectedProviderKeys];
  const providerSet = new Set(concreteProviderKeys);
  const concreteCriteria = policy.criteria.map((criterion): SourcePolicyCriterion => {
    if (criterion.kind !== "providerOrder") return structuredClone(criterion);
    const listed = "keys" in criterion ? criterion.keys.filter((key) => providerSet.has(key)) : concreteProviderKeys;
    const seen = new Set(listed);
    return {
      kind: "providerOrder",
      keys: [...listed, ...concreteProviderKeys.filter((key) => !seen.has(key))],
    };
  });

  const audioPreferred = resolveLanguage(policy.constraints.audio.preferred, preferences.audioLanguage);
  const audioFallback = policy.constraints.audio.fallback === undefined
    ? undefined
    : resolveLanguage(policy.constraints.audio.fallback, preferences.audioLanguage);
  noDuplicateLanguage(audioPreferred, audioFallback);

  let subtitles: SourcePolicyV1["constraints"]["subtitles"];
  if (policy.constraints.subtitles.mode === "off") {
    subtitles = { mode: "off" };
  } else {
    const preferred = resolveLanguage(policy.constraints.subtitles.preferred!, preferences.subtitleLanguage);
    const fallback = policy.constraints.subtitles.fallback === undefined
      ? undefined
      : resolveLanguage(policy.constraints.subtitles.fallback, preferences.subtitleLanguage);
    noDuplicateLanguage(preferred, fallback);
    subtitles = {
      mode: policy.constraints.subtitles.mode,
      preferred,
      ...(fallback === undefined ? {} : { fallback }),
    };
  }

  return parseSourcePolicyV1({
    schemaVersion: 1,
    scope: { mode: "selected", providerKeys: concreteProviderKeys },
    constraints: {
      ...structuredClone(policy.constraints),
      audio: {
        mode: policy.constraints.audio.mode,
        preferred: audioPreferred,
        ...(audioFallback === undefined ? {} : { fallback: audioFallback }),
      },
      subtitles,
    },
    criteria: concreteCriteria,
    nextEpisode: policy.nextEpisode,
    existingLocalCopy: policy.existingLocalCopy,
  });
}

const validateFixedPolicy = (
  profileId: string,
  profileRevision: number,
  operation: SourceOperation,
  selectedProviderKeys: readonly string[],
  policy: SourcePolicyV1,
): void => {
  const definition = SOURCE_PROFILE_DEFINITIONS.find((candidate) =>
    candidate.id === profileId);
  if (!definition) return;
  if (definition.revision !== profileRevision || !definition.operations.includes(operation)) {
    return failValidation();
  }

  const languageCode = (definitionRef: LanguageRef, snapshotRef: LanguageRef): string | undefined => {
    if (!("preference" in definitionRef)) return undefined;
    return "code" in snapshotRef ? snapshotRef.code : failValidation();
  };
  const audioLanguage = languageCode(
    definition.policy.constraints.audio.preferred,
    policy.constraints.audio.preferred,
  );
  const definitionSubtitles = definition.policy.constraints.subtitles;
  let subtitleLanguage: string | undefined;
  if (definitionSubtitles.mode !== "off") {
    const snapshotPreferred = policy.constraints.subtitles.preferred;
    if (definitionSubtitles.preferred === undefined
      || policy.constraints.subtitles.mode === "off"
      || snapshotPreferred === undefined) {
      return failValidation();
    }
    subtitleLanguage = languageCode(definitionSubtitles.preferred, snapshotPreferred);
  }

  const expected = materializeSourceAdmissionPolicy(
    definition.policy,
    selectedProviderKeys,
    {
      ...(audioLanguage === undefined ? {} : { audioLanguage }),
      ...(subtitleLanguage === undefined ? {} : { subtitleLanguage }),
    },
  );
  if (!isDeepStrictEqual(policy, expected)) return failValidation();
};

const declaresStream = (addon: AddonRecord): boolean =>
  (addon.manifest.resources ?? []).some((resource) =>
    typeof resource === "string" ? resource === "stream" : resource.name === "stream");

const availableProviderKeys = (
  definition: SourceProfileDefinition,
  context: SourceAdmissionContext,
  operation: SourceOperation,
): string[] => {
  const kinds = new Set(definition.policy.constraints.sourceKinds);
  const viewer = { id: context.viewer.id, role: context.viewer.role };
  const keys: string[] = [];

  if (kinds.has("localFile") && (operation === "play" || operation === "downloadToDevice")
    && visibleLibraries([...context.libraries], viewer).some((library) => library.enabled)) {
    keys.push("local");
  }

  if (kinds.has("mediaServerOriginal") && (operation === "play" || operation === "downloadToDevice")) {
    for (const library of [...context.remoteLibraries].sort((left, right) => left.order - right.order)) {
      if (remoteLibraryVisibleTo(context.mediaConnections, library, viewer)) {
        keys.push(`remote:${library.id}`);
      }
    }
  }

  if (kinds.has("http") || kinds.has("torrent")) {
    const addons = allowedAddons([...context.addons], viewer)
      .filter((addon) => addon.enabled && addon.role !== "catalog" && declaresStream(addon));
    const order = context.viewer.role === "admin" || context.addonOrder === undefined
      ? undefined
      : [...context.addonOrder];
    for (const addon of orderedForUser(addons, order)) {
      keys.push(`addon:${addon.key}`);
    }
  }

  return operation === "downloadToLibrary" ? keys.filter((key) => key.startsWith("addon:")) : keys;
};

const definitionFor = (reference: SourceProfileReference): SourceProfileDefinition => {
  const definition = SOURCE_PROFILE_DEFINITIONS.find((candidate) => candidate.id === reference.profileId);
  if (!definition) throw new SourceAdmissionRejected("profileUnknown");
  if (definition.revision !== reference.revision) throw new SourceAdmissionRejected("profileRevisionStale");
  return definition;
};

const supportsOperation = (
  definition: SourceProfileDefinition,
  context: SourceAdmissionContext,
): SourceOperation => {
  if (!definition.operations.includes(context.operation)) {
    throw new SourceAdmissionRejected("operationUnsupported");
  }
  if (context.operation === "downloadToLibrary" && !isExecutableDownloadProfile(definition)) {
    throw new SourceAdmissionRejected("operationUnsupported");
  }
  if (context.viewer.disabled) throw new SourceAdmissionRejected("operationForbidden");
  if (context.operation === "downloadToLibrary" && !mayDownloadToLibrary(context.viewer)) {
    throw new SourceAdmissionRejected("operationForbidden");
  }
  if (context.operation === "downloadToDevice" && !mayDownloadToDevice(context.viewer)) {
    throw new SourceAdmissionRejected("operationForbidden");
  }
  return context.operation;
};

export function materializeSourceAdmission(
  referenceInput: SourceProfileReference,
  context: SourceAdmissionContext,
): SourceAdmissionSnapshotV1 {
  const reference = parseSourceProfileReference(referenceInput);
  const definition = definitionFor(reference);
  const operation = supportsOperation(definition, context);
  const available = availableProviderKeys(definition, context, operation);
  const selected = sourceAdmissionProviderScope(definition.policy.scope, available);
  if (selected.length === 0) throw new SourceAdmissionRejected("providerScopeUnavailable");

  const policy = materializeSourceAdmissionPolicy(definition.policy, selected, context.preferences);
  return parseSourceAdmissionSnapshotV1({
    schemaVersion: 1,
    profile: { id: reference.profileId, revision: reference.revision },
    operation,
    providerKeys: selected,
    policy,
  });
}

export function parseSourceAdmissionSnapshotV1(input: unknown): SourceAdmissionSnapshotV1 {
  try {
    const snapshot = objectValue(input, ["schemaVersion", "profile", "operation", "providerKeys", "policy"]);
    if (snapshot.schemaVersion !== 1) return failValidation();

    const profile = objectValue(snapshot.profile, ["id", "revision"]);
    const profileId = dataProperty(profile, "id")?.value;
    const profileRevision = dataProperty(profile, "revision")?.value;
    if (typeof profileId !== "string" || profileId.length === 0
      || typeof profileRevision !== "number" || !Number.isSafeInteger(profileRevision) || profileRevision <= 0) {
      return failValidation();
    }
    const parsedOperation = operation(snapshot.operation);
    const selectedProviderKeys = providerKeys(snapshot.providerKeys);
    const policy = parseSourcePolicyV1(snapshot.policy);
    if (policy.scope.mode !== "selected"
      || policy.scope.providerKeys.length !== selectedProviderKeys.length
      || policy.scope.providerKeys.some((key, index) => key !== selectedProviderKeys[index])) {
      return failValidation();
    }

    for (const reference of [
      policy.constraints.audio.preferred,
      policy.constraints.audio.fallback,
      policy.constraints.subtitles.preferred,
      policy.constraints.subtitles.fallback,
    ]) {
      if (reference && "preference" in reference) return failValidation();
    }
    for (const criterion of policy.criteria) {
      if (criterion.kind === "providerOrder") {
        if ("from" in criterion || !sameKeys(selectedProviderKeys, criterion.keys)) return failValidation();
      }
    }
    validateFixedPolicy(profileId, profileRevision, parsedOperation, selectedProviderKeys, policy);

    return {
      schemaVersion: 1,
      profile: { id: profileId, revision: profileRevision },
      operation: parsedOperation,
      providerKeys: selectedProviderKeys,
      policy,
    };
  } catch (error) {
    if (error instanceof SourceAdmissionValidationError) throw error;
    throw new SourceAdmissionValidationError();
  }
}

export function parseDownloadSourceAdmissionSnapshotV1(input: unknown): SourceAdmissionSnapshotV1 {
  const snapshot = parseSourceAdmissionSnapshotV1(input);
  if (snapshot.operation !== "downloadToLibrary") {
    throw new SourceAdmissionValidationError();
  }
  return snapshot;
}
