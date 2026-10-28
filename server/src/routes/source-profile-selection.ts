import { AppError } from "../errors.js";
import {
  materializeSourceAdmission,
  materializeSourceAdmissionDefinition,
  parseSourceProfileReference,
  SourceAdmissionRejected,
  SourceAdmissionValidationError,
  type SourceAdmissionRejectionCode,
  type SourceAdmissionSnapshotV1,
  type SourceProfileSnapshot,
} from "../source-admission.js";
import { viewerOfProfileAccount } from "../source-profiles.js";
import type { Store, StoredSourceProfile } from "../store.js";
import type { UserRecord } from "../users.js";

type SourceProfileSelectionStore = Pick<
  Store,
  "addons" | "libraries" | "remoteLibraries" | "mediaConnections" | "prefs" | "sourceProfiles" | "userData"
>;

export interface SourceProfileSelectionDeps {
  store: SourceProfileSelectionStore;
}

export const invalidSourceProfileReference = (): AppError =>
  new AppError("The source profile selection is invalid.", "err.invalidSourceProfileReference", 400);

export const sourceAdmissionError = (code: SourceAdmissionRejectionCode): AppError => {
  switch (code) {
    case "profileUnknown":
      return new AppError("That source profile is unavailable.", "err.sourceProfileUnavailable", 400);
    case "profileRevisionStale":
      return new AppError("This source profile revision is no longer available.", "err.sourceProfileRevisionStale", 409);
    case "operationUnsupported":
      return new AppError("This source profile cannot be used for this operation.", "err.sourceProfileOperationUnavailable", 400);
    case "operationForbidden":
      return new AppError("This account may not use this source profile for downloads.", "err.sourceProfileOperationForbidden", 403);
    case "providerScopeUnavailable":
      return new AppError("No authorized source is available for this profile.", "err.sourceProviderScopeUnavailable", 400);
    case "languagePreferenceUnavailable":
      return new AppError("The source language preferences are not available.", "err.sourceLanguagePreferenceUnavailable", 400);
    case "languagePreferenceDuplicate":
      return new AppError("The source language preferences cannot be used together.", "err.sourceLanguagePreferenceConflict", 400);
  }
};

export function materializeOwnerSourceAdmission(
  deps: SourceProfileSelectionDeps,
  owner: Pick<UserRecord, "id" | "role" | "permissions" | "disabled">,
  referenceInput: unknown,
  mediaKind: "episode" | "movie",
): SourceAdmissionSnapshotV1 {
  const reference = parseSourceProfileReference(referenceInput);
  const preferences = deps.store.prefs(owner.id);
  return materializeSourceAdmission(reference, {
    viewer: viewerOfProfileAccount(owner),
    profiles: deps.store.sourceProfiles(),
    addons: deps.store.addons(),
    libraries: deps.store.libraries(),
    remoteLibraries: deps.store.remoteLibraries(),
    mediaConnections: deps.store.mediaConnections(),
    addonOrder: deps.store.userData(owner.id).addonOrder,
    preferences: {
      audioLanguage: preferences.audioLanguage,
      subtitleLanguage: preferences.subtitleLanguage,
    },
    operation: "downloadToLibrary",
    mediaKind,
  });
}

export function materializeOwnerSourceProfileAdmission(
  deps: SourceProfileSelectionDeps,
  owner: Pick<UserRecord, "id" | "role" | "permissions" | "disabled">,
  definition: unknown,
  mediaKind: "episode" | "movie",
): SourceAdmissionSnapshotV1 {
  const preferences = deps.store.prefs(owner.id);
  return materializeSourceAdmissionDefinition(definition, {
    viewer: viewerOfProfileAccount(owner),
    profiles: deps.store.sourceProfiles(),
    addons: deps.store.addons(),
    libraries: deps.store.libraries(),
    remoteLibraries: deps.store.remoteLibraries(),
    mediaConnections: deps.store.mediaConnections(),
    addonOrder: deps.store.userData(owner.id).addonOrder,
    preferences: {
      audioLanguage: preferences.audioLanguage,
      subtitleLanguage: preferences.subtitleLanguage,
    },
    operation: "downloadToLibrary",
    mediaKind,
  });
}

export function sourceProfileSnapshotForAdmission(
  profiles: readonly StoredSourceProfile[],
  profile: SourceAdmissionSnapshotV1["profile"],
): SourceProfileSnapshot {
  const stored = profiles.find((candidate) => candidate.id === profile.id);
  if (!stored) throw new SourceAdmissionRejected("profileUnknown");
  if (stored.revision !== profile.revision) throw new SourceAdmissionRejected("profileRevisionStale");
  return {
    profileId: stored.id,
    revision: stored.revision,
    template: stored.template,
    ...(stored.parameters === undefined ? {} : { parameters: structuredClone(stored.parameters) }),
  };
}

export function materializeSourceProfileAdmission(
  deps: SourceProfileSelectionDeps,
  owner: Pick<UserRecord, "id" | "role" | "permissions" | "disabled"> | undefined,
  referenceInput: unknown,
  mediaKind: "episode" | "movie",
): SourceAdmissionSnapshotV1 {
  if (!owner) throw new AppError("This account may not download to the library.", "err.downloadLibraryNotAllowed", 403);
  try {
    return materializeOwnerSourceAdmission(deps, owner, referenceInput, mediaKind);
  } catch (error) {
    if (error instanceof SourceAdmissionValidationError) throw invalidSourceProfileReference();
    if (error instanceof SourceAdmissionRejected) throw sourceAdmissionError(error.code);
    throw error;
  }
}

/** Whether an admission may reach a remote library, so it needs no addon to be queued. */
export const admitsRemoteProviders = (snapshot: SourceAdmissionSnapshotV1 | undefined): boolean =>
  snapshot !== undefined && snapshot.providerKeys.some((key) => key.startsWith("remote:"));

export const profileSelectionReference = (
  selection: unknown,
): { present: false } | { present: true; reference: unknown } => {
  if (selection === null || typeof selection !== "object" || Array.isArray(selection)
    || !Object.hasOwn(selection, "profile")) return { present: false };
  const keys = Reflect.ownKeys(selection);
  if (keys.length !== 1 || keys[0] !== "profile") throw invalidSourceProfileReference();
  return { present: true, reference: (selection as Record<string, unknown>).profile };
};

export const legacySelectionFromAdmission = (snapshot: SourceAdmissionSnapshotV1) => {
  const { audio, subtitles } = snapshot.policy.constraints;
  const audioFallback = audio.fallback && "code" in audio.fallback ? audio.fallback.code : undefined;
  const subtitleLanguage = subtitles.mode === "off"
    ? undefined
    : subtitles.preferred && "code" in subtitles.preferred ? subtitles.preferred.code : undefined;
  const subtitleFallback = subtitles.mode === "off" || !subtitles.fallback || !("code" in subtitles.fallback)
    ? undefined
    : subtitles.fallback.code;
  return {
    // Only addons travel as legacy keys; remote libraries stay in the admission snapshot alone.
    addonKeys: snapshot.providerKeys
      .filter((key) => key.startsWith("addon:"))
      .map((key) => key.slice("addon:".length)),
    sourceStrategy: "priority" as const,
    audioLanguage: "code" in audio.preferred ? audio.preferred.code : "",
    ...(audioFallback === undefined ? {} : { fallbackAudioLanguage: audioFallback }),
    audioMode: audio.mode,
    subtitleMode: subtitles.mode,
    ...(subtitleLanguage === undefined ? {} : { subtitleLanguage }),
    ...(subtitleFallback === undefined ? {} : { fallbackSubtitleLanguage: subtitleFallback }),
  };
};
