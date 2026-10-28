import assert from "node:assert/strict";
import { test } from "node:test";
import type { DownloadRules } from "./download-rules.js";
import { defaultDownloadSettings } from "./naming.js";
import {
  buildTemplatePolicy,
  defaultTemplateParameters,
  RULE_PRESETS,
  SOURCE_PROFILE_DEFINITIONS,
  SOURCE_PROFILE_IDS,
  sourceProfilesForViewer,
  viewerOfProfileAccount,
  type SourceProfileCatalogue,
} from "./source-profiles.js";
import { parseSourcePolicyV1 } from "./source-policy.js";
import type { LibraryRecord } from "./libraries.js";
import type { MediaConnectionRecord, RemoteLibraryRecord } from "./media-server-types.js";
import type { StoredSourceProfile } from "./store.js";
import type { AddonRecord } from "./types.js";
import type { UserRecord } from "./users.js";

const ADMIN = "usr_00000001";
const MEMBER = "usr_00000002";
const OTHER = "usr_00000003";

const account = (
  id: string,
  role: UserRecord["role"],
  permissions = { downloadToLibrary: true, downloadToDevice: true },
): UserRecord => ({
  id,
  username: id,
  passwordHash: "",
  secret: "secret",
  role,
  createdAt: "2026-01-01T00:00:00.000Z",
  permissions,
  permissionsVersion: 0,
});

const addon = (
  key: string,
  options: {
    name?: string;
    role?: AddonRecord["role"];
    enabled?: boolean;
    allowedUsers?: string[];
    resources?: AddonRecord["manifest"]["resources"];
  } = {},
): AddonRecord => ({
  key,
  manifestUrl: `https://${key}.example/manifest.json`,
  role: options.role ?? "source",
  enabled: options.enabled ?? true,
  globalSearch: true,
  ...(options.allowedUsers ? { allowedUsers: options.allowedUsers } : {}),
  addedAt: "2026-01-01T00:00:00.000Z",
  manifest: {
    id: key,
    name: options.name ?? key,
    version: "1.0.0",
    resources: options.resources ?? [{ name: "stream" }],
  },
  downloadSettings: defaultDownloadSettings(),
});

const library = (visibleTo: string[]): LibraryRecord => ({
  id: "lib_00000001",
  name: "Local",
  type: "movie",
  root: "/media/local",
  enabled: true,
  order: 0,
  addedAt: "2026-01-01T00:00:00.000Z",
  writeArtwork: false,
  visibleTo,
});

const connection: MediaConnectionRecord = {
  id: `mconn_${"1".repeat(32)}`,
  provider: "jellyfin",
  name: "Private connection",
  baseUrl: "http://media.example",
  allowLan: false,
  allowLoopback: false,
  serverId: "server",
  accountId: "account",
  enabled: true,
  generation: 1,
  secretRef: `msecret_${"2".repeat(32)}`,
  addedAt: "2026-01-01T00:00:00.000Z",
};

const remoteLibrary = (allowedUsers: string[]): RemoteLibraryRecord => ({
  id: `rlib_${"3".repeat(32)}`,
  connectionId: connection.id,
  remoteId: "remote",
  name: "Private remote library",
  type: "movie",
  enabled: true,
  order: 0,
  allowedUsers,
  showOnHome: true,
  showInContinueWatching: true,
});

const catalogue = (
  user: UserRecord,
  source: Partial<Pick<SourceProfileCatalogue, "profiles" | "addons" | "libraries" | "remoteLibraries" | "mediaConnections">> = {},
): SourceProfileCatalogue => ({
  viewer: viewerOfProfileAccount(user),
  profiles: source.profiles ?? storedBuiltIns(),
  addons: source.addons ?? [],
  libraries: source.libraries ?? [],
  remoteLibraries: source.remoteLibraries ?? [],
  mediaConnections: source.mediaConnections ?? [connection],
});

const storedBuiltIns = (): StoredSourceProfile[] =>
  RULE_PRESETS.map((preset) => ({
    id: preset.id,
    revision: 1,
    template: preset.template,
    nameKey: preset.nameKey,
    parameters: preset.rules,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));

const operationIds = (profiles: ReturnType<typeof sourceProfilesForViewer>) =>
  profiles.map((profile) => ({ id: profile.id, operations: profile.operations }));

test("fixed profile definitions parse and keep stable identities", () => {
  assert.deepEqual(SOURCE_PROFILE_DEFINITIONS.map((profile) => ({
    id: profile.id,
    nameKey: profile.nameKey,
    revision: profile.revision,
    operations: profile.operations,
  })), [
    {
      id: SOURCE_PROFILE_IDS.recommended,
      nameKey: "sourceProfile.recommended",
      revision: 1,
      operations: ["play", "downloadToLibrary", "downloadToDevice"],
    },
    {
      id: SOURCE_PROFILE_IDS.providerPriority,
      nameKey: "sourceProfile.providerPriority",
      revision: 1,
      operations: ["play", "downloadToLibrary", "downloadToDevice"],
    },
    {
      id: SOURCE_PROFILE_IDS.travel,
      nameKey: "sourceProfile.travel",
      revision: 1,
      operations: ["play", "downloadToLibrary", "downloadToDevice"],
    },
  ]);
  assert.deepEqual(SOURCE_PROFILE_IDS, {
    recommended: "39de76cc-0ca0-4a5e-95ad-08927fb45410",
    providerPriority: "390a8b1a-85f6-4ded-9d7e-701a299720bb",
    travel: "7e15d713-965c-4636-9ed3-3a112c521fe1",
    balanced: "88302ead-d701-4282-9059-777d47ed913c",
    best: "a02923f1-3457-478e-94b2-a0051f233de9",
    smaller: "2cb9cd41-d5dc-45cd-b765-a0f98149a5b1",
    myLanguage: "f57e4033-dafe-4d7c-88de-4def19014aac",
  });
  for (const profile of SOURCE_PROFILE_DEFINITIONS) {
    assert.deepEqual(parseSourcePolicyV1(structuredClone(profile.policy)), profile.policy);
    assert.equal(Object.isFrozen(profile), true);
    assert.equal(Object.isFrozen(profile.policy), true);
    assert.equal(profile.policy.scope.mode, "allAvailable");
    assert.deepEqual(
      profile.policy.criteria.filter((criterion) => criterion.kind === "providerOrder"),
      [{ kind: "providerOrder", from: "viewer" }],
    );
  }
  assert.deepEqual(SOURCE_PROFILE_DEFINITIONS[2]?.policy.constraints.sourceKinds, [
    "localFile",
    "http",
    "mediaServerOriginal",
  ]);
  assert.deepEqual(SOURCE_PROFILE_DEFINITIONS[0]?.policy.constraints.sourceKinds, [
    "localFile",
    "mediaServerOriginal",
    "http",
    "torrent",
  ]);
  assert.deepEqual(SOURCE_PROFILE_DEFINITIONS[1]?.policy.constraints.sourceKinds, [
    "localFile",
    "mediaServerOriginal",
    "http",
    "torrent",
  ]);
});

test("template defaults reproduce every built-in policy", () => {
  for (const template of ["recommended", "travel", "providerPriority"] as const) {
    const definition = SOURCE_PROFILE_DEFINITIONS.find((candidate) =>
      candidate.id === SOURCE_PROFILE_IDS[template]);
    assert.ok(definition);
    assert.deepEqual(
      buildTemplatePolicy(template, defaultTemplateParameters(template)),
      definition.policy,
    );
  }
});

test("projection returns fresh policies and operation lists on every read", () => {
  const input = catalogue(account(ADMIN, "admin"), {
    addons: [addon("stream")],
    libraries: [library([])],
    remoteLibraries: [remoteLibrary([])],
  });
  const first = sourceProfilesForViewer(input);
  const second = sourceProfilesForViewer(input);

  assert.notEqual(first[0], second[0]);
  assert.notEqual(first[0]?.policy, second[0]?.policy);
  assert.notEqual(first[0]?.policy.constraints.sourceKinds, second[0]?.policy.constraints.sourceKinds);
  assert.notEqual(first[0]?.operations, second[0]?.operations);

  first[0]!.operations.length = 0;
  first[0]!.policy.constraints.sourceKinds.length = 0;
  assert.deepEqual(second[0]?.operations, ["play", "downloadToLibrary", "downloadToDevice"]);
  assert.deepEqual(second[0]?.policy.constraints.sourceKinds, [
    "localFile",
    "mediaServerOriginal",
    "http",
    "torrent",
  ]);
  assert.deepEqual(SOURCE_PROFILE_DEFINITIONS[0]?.policy.constraints.sourceKinds, [
    "localFile",
    "mediaServerOriginal",
    "http",
    "torrent",
  ]);
});

test("administrators see every profile and operation available from their granted paths", () => {
  const profiles = sourceProfilesForViewer(catalogue(account(ADMIN, "admin"), {
    addons: [addon("stream")],
    libraries: [library([])],
    remoteLibraries: [remoteLibrary([])],
  }));

  assert.deepEqual(operationIds(profiles), [
    { id: SOURCE_PROFILE_IDS.balanced, operations: ["play", "downloadToLibrary", "downloadToDevice"] },
    { id: SOURCE_PROFILE_IDS.best, operations: ["play", "downloadToLibrary", "downloadToDevice"] },
    { id: SOURCE_PROFILE_IDS.smaller, operations: ["play", "downloadToLibrary", "downloadToDevice"] },
    { id: SOURCE_PROFILE_IDS.myLanguage, operations: ["play", "downloadToLibrary", "downloadToDevice"] },
  ]);
});

test("public rules expose separate film and episode size limits", () => {
  const profiles = sourceProfilesForViewer(catalogue(account(ADMIN, "admin"), {
    addons: [addon("stream")],
  }));
  const balanced = profiles.find((profile) => profile.id === SOURCE_PROFILE_IDS.balanced);
  assert.deepEqual(balanced?.sizeLimits, {
    episodeBytes: 4_000_000_000,
    movieBytes: 15_000_000_000,
  });
});

test("public rules expose minimum size limits without removing legacy maxima", () => {
  const profile = storedBuiltIns()[0]!;
  const profiles = sourceProfilesForViewer(catalogue(account(ADMIN, "admin"), {
    addons: [addon("stream")],
    profiles: [{
      ...profile,
      parameters: {
        ...profile.parameters as DownloadRules,
        sizeGb: {
          episode: { min: 1, max: 4 },
          movie: { min: 2, max: 15 },
        },
      },
    }],
  }));
  assert.deepEqual(profiles[0]?.sizeLimits, {
    episodeBytes: 4_000_000_000,
    episodeMinBytes: 1_000_000_000,
    movieBytes: 15_000_000_000,
    movieMinBytes: 2_000_000_000,
  });
});

test("a local path alone supports playback and a device copy, never a library self-copy", () => {
  const profiles = sourceProfilesForViewer(catalogue(account(MEMBER, "user"), {
    libraries: [library([MEMBER])],
  }));

  assert.deepEqual(operationIds(profiles), [
    { id: SOURCE_PROFILE_IDS.balanced, operations: ["play", "downloadToDevice"] },
    { id: SOURCE_PROFILE_IDS.best, operations: ["play", "downloadToDevice"] },
    { id: SOURCE_PROFILE_IDS.smaller, operations: ["play", "downloadToDevice"] },
    { id: SOURCE_PROFILE_IDS.myLanguage, operations: ["play", "downloadToDevice"] },
  ]);
});

test("a remote path alone supports every operation through a rules profile", () => {
  const profiles = sourceProfilesForViewer(catalogue(account(MEMBER, "user"), {
    remoteLibraries: [remoteLibrary([MEMBER])],
  }));

  assert.deepEqual(operationIds(profiles), [
    { id: SOURCE_PROFILE_IDS.balanced, operations: ["play", "downloadToLibrary", "downloadToDevice"] },
    { id: SOURCE_PROFILE_IDS.best, operations: ["play", "downloadToLibrary", "downloadToDevice"] },
    { id: SOURCE_PROFILE_IDS.smaller, operations: ["play", "downloadToLibrary", "downloadToDevice"] },
    { id: SOURCE_PROFILE_IDS.myLanguage, operations: ["play", "downloadToLibrary", "downloadToDevice"] },
  ]);
});

test("selected local and remote providers survive projection and drive their operations", () => {
  const remote = remoteLibrary([MEMBER]);
  const base = storedBuiltIns()[0]!;
  const remoteProfile: StoredSourceProfile = {
    ...base,
    id: "00000000-0000-4000-8000-000000000302",
    name: "Remote only",
    parameters: {
      ...base.parameters as DownloadRules,
      addons: {
        scope: { selected: [`remote:${remote.id}`] },
        order: { explicit: [`remote:${remote.id}`] },
      },
    },
  };
  const localProfile: StoredSourceProfile = {
    ...base,
    id: "00000000-0000-4000-8000-000000000303",
    name: "Local only",
    parameters: {
      ...base.parameters as DownloadRules,
      addons: { scope: { selected: ["local"] }, order: { explicit: ["local"] } },
    },
  };
  const profiles = sourceProfilesForViewer(catalogue(account(MEMBER, "user"), {
    profiles: [remoteProfile, localProfile],
    libraries: [library([MEMBER])],
    remoteLibraries: [remote],
  }));

  assert.deepEqual(operationIds(profiles), [
    {
      id: remoteProfile.id,
      operations: ["play", "downloadToLibrary", "downloadToDevice"],
    },
    {
      id: localProfile.id,
      operations: ["play", "downloadToDevice"],
    },
  ]);
  assert.deepEqual(profiles[0]?.policy.scope, {
    mode: "selected",
    providerKeys: [`remote:${remote.id}`],
  });
  assert.deepEqual(profiles[0]?.policy.criteria.filter((criterion) => criterion.kind === "providerOrder"), [
    { kind: "providerOrder", keys: [`remote:${remote.id}`] },
  ]);
  assert.deepEqual(profiles[1]?.policy.scope, {
    mode: "selected",
    providerKeys: ["local"],
  });
});

test("explicit provider order intersects addons, local and visible remote libraries", () => {
  const visibleRemote = remoteLibrary([MEMBER]);
  const hiddenRemote = {
    ...remoteLibrary([OTHER]),
    id: `rlib_${"4".repeat(32)}`,
  };
  const profile: StoredSourceProfile = {
    id: "00000000-0000-4000-8000-000000000304",
    revision: 1,
    template: "rules",
    name: "Visible providers",
    parameters: {
      ...storedBuiltIns()[0]!.parameters as DownloadRules,
      addons: {
        scope: "all",
        order: {
          explicit: [
            `remote:${hiddenRemote.id}`,
            `addon:hidden`,
            "local",
            `remote:${visibleRemote.id}`,
            "addon:visible",
          ],
        },
      },
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const profiles = sourceProfilesForViewer(catalogue(account(MEMBER, "user"), {
    profiles: [profile],
    addons: [
      addon("visible", { allowedUsers: [MEMBER] }),
      addon("hidden", { allowedUsers: [OTHER] }),
    ],
    libraries: [library([MEMBER])],
    remoteLibraries: [visibleRemote, hiddenRemote],
  }));

  assert.deepEqual(profiles[0]?.policy.criteria.filter((criterion) => criterion.kind === "providerOrder"), [{
    kind: "providerOrder",
    keys: ["local", `remote:${visibleRemote.id}`, "addon:visible"],
  }]);
  assert.equal(JSON.stringify(profiles).includes(`remote:${hiddenRemote.id}`), false);
  assert.equal(JSON.stringify(profiles).includes("addon:hidden"), false);
});

test("an addon path supports every operation for a member with both download grants", () => {
  const profiles = sourceProfilesForViewer(catalogue(account(MEMBER, "user"), {
    addons: [addon("stream", { allowedUsers: [MEMBER] })],
  }));

  assert.deepEqual(operationIds(profiles), [
    { id: SOURCE_PROFILE_IDS.balanced, operations: ["play", "downloadToLibrary", "downloadToDevice"] },
    { id: SOURCE_PROFILE_IDS.best, operations: ["play", "downloadToLibrary", "downloadToDevice"] },
    { id: SOURCE_PROFILE_IDS.smaller, operations: ["play", "downloadToLibrary", "downloadToDevice"] },
    { id: SOURCE_PROFILE_IDS.myLanguage, operations: ["play", "downloadToLibrary", "downloadToDevice"] },
  ]);
});

test("disabled, catalog-only and non-stream addons do not create a path", () => {
  const profiles = sourceProfilesForViewer(catalogue(account(MEMBER, "user"), {
    addons: [
      addon("disabled", { enabled: false, allowedUsers: [MEMBER] }),
      addon("catalog", { role: "catalog", allowedUsers: [MEMBER] }),
      addon("metadata", { resources: [{ name: "meta" }], allowedUsers: [MEMBER] }),
    ],
  }));

  assert.deepEqual(profiles, []);
});

test("an account with no path sees no profiles even when download rights are granted", () => {
  assert.deepEqual(sourceProfilesForViewer(catalogue(account(MEMBER, "user"))), []);
});

test("operation grants are applied independently to an available addon path", () => {
  const input = catalogue(account(MEMBER, "user", {
    downloadToLibrary: false,
    downloadToDevice: false,
  }), {
    addons: [addon("stream", { allowedUsers: [MEMBER] })],
  });

  const playOnly = sourceProfilesForViewer(input);
  assert.deepEqual(playOnly.map((profile) => profile.operations), [
    ["play"],
    ["play"],
    ["play"],
    ["play"],
  ]);

  input.viewer.permissions = { downloadToLibrary: true, downloadToDevice: false };
  const playAndLibrary = sourceProfilesForViewer(input);
  assert.deepEqual(playAndLibrary.map((profile) => profile.operations), [
    ["play", "downloadToLibrary"],
    ["play", "downloadToLibrary"],
    ["play", "downloadToLibrary"],
    ["play", "downloadToLibrary"],
  ]);

  input.viewer.permissions = { downloadToLibrary: true, downloadToDevice: true };
  const all = sourceProfilesForViewer(input);
  assert.deepEqual(all.map((profile) => profile.operations), [
    ["play", "downloadToLibrary", "downloadToDevice"],
    ["play", "downloadToLibrary", "downloadToDevice"],
    ["play", "downloadToLibrary", "downloadToDevice"],
    ["play", "downloadToLibrary", "downloadToDevice"],
  ]);
});

test("grant changes and same-name providers do not expose provider identity", () => {
  const visible = addon("private-key-one", {
    name: "Same name",
    allowedUsers: [MEMBER],
  });
  const hidden = addon("private-key-two", {
    name: "Same name",
    allowedUsers: [OTHER],
  });
  const input = catalogue(account(MEMBER, "user"), { addons: [visible, hidden] });

  const before = sourceProfilesForViewer(input);
  assert.equal(before.length, 4);
  assert.doesNotMatch(JSON.stringify(before), /private-key|Same name|manifest\.json/);

  visible.enabled = false;
  assert.deepEqual(sourceProfilesForViewer(input), []);
});

test("an allAvailable profile filters every explicit addon order to the viewer's grants", () => {
  const profile: StoredSourceProfile = {
    id: "00000000-0000-4000-8000-000000000301",
    revision: 1,
    template: "travel",
    name: "Visible only",
    parameters: {
      ...defaultTemplateParameters("travel"),
      scope: { mode: "allAvailable" },
      providerOrder: { addonKeys: ["visible", "hidden"] },
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const profiles = sourceProfilesForViewer(catalogue(account(MEMBER, "user"), {
    profiles: [profile],
    addons: [
      addon("visible", { allowedUsers: [MEMBER] }),
      addon("hidden", { allowedUsers: [OTHER] }),
    ],
  }));

  assert.equal(profiles.length, 1);
  assert.deepEqual(profiles[0]?.policy.criteria.filter((criterion) => criterion.kind === "providerOrder"), [
    { kind: "providerOrder", keys: ["addon:visible"] },
  ]);
  assert.equal(JSON.stringify(profiles).includes("addon:hidden"), false);
});
