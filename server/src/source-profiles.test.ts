import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultDownloadSettings } from "./naming.js";
import {
  SOURCE_PROFILE_DEFINITIONS,
  SOURCE_PROFILE_IDS,
  sourceProfilesForViewer,
  viewerOfProfileAccount,
  type SourceProfileCatalogue,
} from "./source-profiles.js";
import { parseSourcePolicyV1 } from "./source-policy.js";
import type { LibraryRecord } from "./libraries.js";
import type { MediaConnectionRecord, RemoteLibraryRecord } from "./media-server-types.js";
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
  source: Partial<Pick<SourceProfileCatalogue, "addons" | "libraries" | "remoteLibraries" | "mediaConnections">> = {},
): SourceProfileCatalogue => ({
  viewer: viewerOfProfileAccount(user),
  addons: source.addons ?? [],
  libraries: source.libraries ?? [],
  remoteLibraries: source.remoteLibraries ?? [],
  mediaConnections: source.mediaConnections ?? [connection],
});

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
  assert.deepEqual(second[0]?.operations, ["play", "downloadToDevice"]);
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
    { id: SOURCE_PROFILE_IDS.recommended, operations: ["play", "downloadToDevice"] },
    { id: SOURCE_PROFILE_IDS.providerPriority, operations: ["play", "downloadToLibrary", "downloadToDevice"] },
    { id: SOURCE_PROFILE_IDS.travel, operations: ["play", "downloadToLibrary", "downloadToDevice"] },
  ]);
});

test("a local path alone supports playback and a device copy, never a library self-copy", () => {
  const profiles = sourceProfilesForViewer(catalogue(account(MEMBER, "user"), {
    libraries: [library([MEMBER])],
  }));

  assert.deepEqual(operationIds(profiles), [
    { id: SOURCE_PROFILE_IDS.recommended, operations: ["play", "downloadToDevice"] },
    { id: SOURCE_PROFILE_IDS.providerPriority, operations: ["play", "downloadToDevice"] },
    { id: SOURCE_PROFILE_IDS.travel, operations: ["play", "downloadToDevice"] },
  ]);
});

test("a remote path alone supports playback and a device copy, never an automatic follow copy", () => {
  const profiles = sourceProfilesForViewer(catalogue(account(MEMBER, "user"), {
    remoteLibraries: [remoteLibrary([MEMBER])],
  }));

  assert.deepEqual(operationIds(profiles), [
    { id: SOURCE_PROFILE_IDS.recommended, operations: ["play", "downloadToDevice"] },
    { id: SOURCE_PROFILE_IDS.providerPriority, operations: ["play", "downloadToDevice"] },
    { id: SOURCE_PROFILE_IDS.travel, operations: ["play", "downloadToDevice"] },
  ]);
});

test("an addon path supports every operation for a member with both download grants", () => {
  const profiles = sourceProfilesForViewer(catalogue(account(MEMBER, "user"), {
    addons: [addon("stream", { allowedUsers: [MEMBER] })],
  }));

  assert.deepEqual(operationIds(profiles), [
    { id: SOURCE_PROFILE_IDS.recommended, operations: ["play", "downloadToDevice"] },
    { id: SOURCE_PROFILE_IDS.providerPriority, operations: ["play", "downloadToLibrary", "downloadToDevice"] },
    { id: SOURCE_PROFILE_IDS.travel, operations: ["play", "downloadToLibrary", "downloadToDevice"] },
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
  ]);

  input.viewer.permissions = { downloadToLibrary: true, downloadToDevice: false };
  const playAndLibrary = sourceProfilesForViewer(input);
  assert.deepEqual(playAndLibrary.map((profile) => profile.operations), [
    ["play"],
    ["play", "downloadToLibrary"],
    ["play", "downloadToLibrary"],
  ]);

  input.viewer.permissions = { downloadToLibrary: true, downloadToDevice: true };
  const all = sourceProfilesForViewer(input);
  assert.deepEqual(all.map((profile) => profile.operations), [
    ["play", "downloadToDevice"],
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
  assert.equal(before.length, 3);
  assert.doesNotMatch(JSON.stringify(before), /private-key|Same name|manifest\.json/);

  visible.enabled = false;
  assert.deepEqual(sourceProfilesForViewer(input), []);
});
