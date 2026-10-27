import { allowedAddons } from "./addons.js";
import { mayDownloadToDevice, mayDownloadToLibrary } from "./downloads.js";
import { visibleLibraries, type LibraryRecord, type Viewer } from "./libraries.js";
import { remoteLibraryVisibleTo } from "./media-server-access.js";
import type { MediaConnectionRecord, RemoteLibraryRecord } from "./media-server-types.js";
import { parseSourcePolicyV1, type SourcePolicyV1 } from "./source-policy.js";
import type { AddonRecord } from "./types.js";
import type { UserRecord } from "./users.js";

export const SOURCE_PROFILE_IDS = Object.freeze({
  recommended: "39de76cc-0ca0-4a5e-95ad-08927fb45410",
  providerPriority: "390a8b1a-85f6-4ded-9d7e-701a299720bb",
  travel: "7e15d713-965c-4636-9ed3-3a112c521fe1",
} as const);

export type SourceOperation = "play" | "downloadToLibrary" | "downloadToDevice";

export interface SourceProfileDefinition {
  readonly id: string;
  readonly nameKey: string;
  readonly revision: 1;
  readonly operations: readonly SourceOperation[];
  readonly policy: SourcePolicyV1;
}

export interface PublicSourceProfile {
  id: string;
  nameKey: string;
  revision: 1;
  operations: SourceOperation[];
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

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

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

export const declaresStream = (addon: AddonRecord): boolean =>
  (addon.manifest.resources ?? []).some((resource) =>
    typeof resource === "string" ? resource === "stream" : resource.name === "stream");

export const isExecutableDownloadProfile = (
  profile: { id: string; revision: number },
): boolean => profile.revision === 1
  && (profile.id === SOURCE_PROFILE_IDS.travel || profile.id === SOURCE_PROFILE_IDS.providerPriority);

const copyPolicy = (policy: SourcePolicyV1): SourcePolicyV1 => structuredClone(policy);

export function sourceProfilesForViewer(catalogue: SourceProfileCatalogue): PublicSourceProfile[] {
  const { viewer } = catalogue;
  if (viewer.disabled) return [];

  const hasAddonPath = allowedAddons([...catalogue.addons], viewer)
    .some((addon) => addon.enabled && addon.role !== "catalog" && declaresStream(addon));
  const hasLocalPath = visibleLibraries([...catalogue.libraries], viewer)
    .some((library) => library.enabled);
  const hasRemotePath = catalogue.remoteLibraries
    .some((library) => remoteLibraryVisibleTo(catalogue.mediaConnections, library, viewer));

  return SOURCE_PROFILE_DEFINITIONS.flatMap((profile) => {
    if (profile.policy.scope.mode !== "allAvailable") return [];

    const kinds = new Set(profile.policy.constraints.sourceKinds);
    const addonDownloadPath = hasAddonPath && (kinds.has("http") || kinds.has("torrent"));
    const localPath = hasLocalPath && kinds.has("localFile");
    const remotePath = hasRemotePath && kinds.has("mediaServerOriginal");
    const playPath = hasAddonPath || localPath || remotePath;

    const operations = profile.operations.filter((operation) => {
      if (operation === "play") return playPath;
      if (operation === "downloadToLibrary") {
        return mayDownloadToLibrary(viewer) && addonDownloadPath && isExecutableDownloadProfile(profile);
      }
      return mayDownloadToDevice(viewer) && (addonDownloadPath || localPath || remotePath);
    });
    if (!operations.length) return [];

    return [{
      id: profile.id,
      nameKey: profile.nameKey,
      revision: profile.revision,
      operations,
      policy: copyPolicy(profile.policy),
    }];
  });
}

export const viewerOfProfileAccount = (user: Pick<UserRecord, "id" | "role" | "permissions" | "disabled">): SourceProfileViewer => ({
  id: user.id,
  role: user.role,
  permissions: { ...user.permissions },
  ...(user.disabled === undefined ? {} : { disabled: user.disabled }),
});
