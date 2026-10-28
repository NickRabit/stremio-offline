import assert from "node:assert/strict";
import { test } from "node:test";
import type { LibraryRecord } from "./libraries.js";
import type { MediaConnectionRecord, RemoteLibraryRecord } from "./media-server-types.js";
import { defaultDownloadSettings } from "./naming.js";
import { parseDownloadRules, rulesPolicy } from "./download-rules.js";
import {
  materializeSourceAdmission,
  materializeSourceAdmissionPolicy,
  parseSourceAdmissionSnapshotV1,
  parseSourceProfileSnapshot,
  parseSourceProfileReference,
  sourceAdmissionProviderScope,
  SourceAdmissionRejected,
  SourceAdmissionValidationError,
  type SourceAdmissionContext,
  type SourceAdmissionSnapshotV1,
} from "./source-admission.js";
import {
  defaultTemplateParameters,
  RULE_PRESETS,
  SOURCE_PROFILE_DEFINITIONS,
  SOURCE_PROFILE_IDS,
  viewerOfProfileAccount,
} from "./source-profiles.js";
import { parseSourcePolicyV1, type SourcePolicyV1 } from "./source-policy.js";
import type { StoredSourceProfile } from "./store.js";
import type { AddonRecord } from "./types.js";
import type { UserRecord } from "./users.js";

const ADMIN = "usr_00000001";
const MEMBER = "usr_00000002";
const OTHER = "usr_00000003";
const REMOTE_ONE = `rlib_${"1".repeat(32)}`;
const REMOTE_TWO = `rlib_${"2".repeat(32)}`;

const account = (
  id = MEMBER,
  role: UserRecord["role"] = "user",
  permissions = { downloadToLibrary: true, downloadToDevice: true },
): UserRecord => ({
  id,
  username: id,
  passwordHash: "",
  secret: `secret-${id}`,
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
  manifestUrl: `https://private-addon.example/${key}/manifest.json?token=manifest-secret`,
  role: options.role ?? "source",
  enabled: options.enabled ?? true,
  globalSearch: true,
  allowedUsers: options.allowedUsers ?? [ADMIN, MEMBER],
  addedAt: "2026-01-01T00:00:00.000Z",
  manifest: {
    id: `manifest-${key}`,
    name: options.name ?? `Private addon ${key}`,
    version: "1.0.0",
    resources: options.resources ?? [{ name: "stream" }],
  },
  downloadSettings: defaultDownloadSettings(),
});

const library = (id: string, visibleTo: string[], enabled = true): LibraryRecord => ({
  id,
  name: `Private library ${id}`,
  type: "movie",
  root: `/private/library/${id}`,
  enabled,
  order: 0,
  addedAt: "2026-01-01T00:00:00.000Z",
  writeArtwork: false,
  visibleTo,
});

const connection: MediaConnectionRecord = {
  id: `mconn_${"3".repeat(32)}`,
  provider: "jellyfin",
  name: "Private connection",
  baseUrl: "https://private-media.example:8920",
  allowLan: false,
  allowLoopback: false,
  serverId: "private-server",
  accountId: "private-account",
  enabled: true,
  generation: 1,
  secretRef: `msecret_${"4".repeat(32)}`,
  addedAt: "2026-01-01T00:00:00.000Z",
};

const remoteLibrary = (id: string, allowedUsers: string[], enabled = true): RemoteLibraryRecord => ({
  id,
  connectionId: connection.id,
  remoteId: `remote-${id}`,
  name: `Private remote ${id}`,
  type: "movie",
  enabled,
  order: 0,
  allowedUsers,
  showOnHome: true,
  showInContinueWatching: true,
});

const storedBuiltIns = (): StoredSourceProfile[] =>
  (["recommended", "providerPriority", "travel"] as const).map((template) => ({
    id: SOURCE_PROFILE_IDS[template],
    revision: 1,
    template,
    nameKey: `sourceProfile.${template}`,
    ...(template === "recommended" ? {} : { parameters: defaultTemplateParameters(template) }),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));

const storedRules = (): StoredSourceProfile => ({
  id: SOURCE_PROFILE_IDS.balanced,
  revision: 1,
  template: "rules",
  nameKey: "rules.preset.balanced",
  parameters: defaultTemplateParameters("rules"),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const context = (
  user = account(),
  options: Partial<Omit<SourceAdmissionContext, "viewer" | "preferences" | "operation" | "mediaKind">> & {
    audioLanguage?: string;
    subtitleLanguage?: string;
    operation?: SourceAdmissionContext["operation"];
    mediaKind?: SourceAdmissionContext["mediaKind"];
  } = {},
): SourceAdmissionContext => ({
  viewer: viewerOfProfileAccount(user),
  profiles: options.profiles ?? storedBuiltIns(),
  addons: options.addons ?? [],
  libraries: options.libraries ?? [],
  remoteLibraries: options.remoteLibraries ?? [],
  mediaConnections: options.mediaConnections ?? [connection],
  ...(options.addonOrder === undefined ? {} : { addonOrder: options.addonOrder }),
  preferences: {
    audioLanguage: options.audioLanguage ?? "en",
    subtitleLanguage: options.subtitleLanguage ?? "en",
  },
  operation: options.operation ?? "play",
  mediaKind: options.mediaKind ?? "episode",
});

const reference = (profileId: string, revision = 1) => ({ profileId, revision });

const rejectionCode = (code: SourceAdmissionRejected["code"]) =>
  (error: unknown) => error instanceof SourceAdmissionRejected && error.code === code;

const expectValidationError = (value: () => unknown): void => {
  assert.throws(value, (error) =>
    error instanceof SourceAdmissionValidationError
      && error.message === "Invalid source admission data.");
};

const selectedPolicy = (
  keys: string[],
  options: { audioFallback?: "en"; subtitleFallback?: "en" } = {},
): SourcePolicyV1 => parseSourcePolicyV1({
  schemaVersion: 1,
  scope: { mode: "selected", providerKeys: keys },
  constraints: {
    sourceKinds: ["http", "torrent"],
    audio: {
      mode: "preferred",
      preferred: { preference: "audio" },
      ...(options.audioFallback ? { fallback: { code: options.audioFallback } } : {}),
    },
    subtitles: options.subtitleFallback
      ? { mode: "optional", preferred: { preference: "subtitle" }, fallback: { code: options.subtitleFallback } }
      : { mode: "optional", preferred: { preference: "subtitle" } },
  },
  criteria: [
    { kind: "providerOrder", from: "viewer" },
    { kind: "size", direction: "desc" },
  ],
  nextEpisode: "profile",
  existingLocalCopy: "meetsRequirements",
});

test("profile references accept only exact plain data fields", () => {
  assert.deepEqual(parseSourceProfileReference({ profileId: SOURCE_PROFILE_IDS.recommended, revision: 1 }), {
    profileId: SOURCE_PROFILE_IDS.recommended,
    revision: 1,
  });

  let accessorRead = false;
  const accessor = {};
  Object.defineProperty(accessor, "profileId", {
    enumerable: true,
    get() {
      accessorRead = true;
      return SOURCE_PROFILE_IDS.recommended;
    },
  });
  Object.defineProperty(accessor, "revision", { enumerable: true, value: 1 });

  const invalid = [
    null,
    [],
    { profileId: SOURCE_PROFILE_IDS.recommended, revision: 1, policy: { scope: "all" } },
    Object.assign(Object.create({ profileId: SOURCE_PROFILE_IDS.recommended }), { revision: 1 }),
    new (class extends Array {})(),
    accessor,
    { profileId: "", revision: 1 },
    { profileId: SOURCE_PROFILE_IDS.recommended, revision: 0 },
    { profileId: SOURCE_PROFILE_IDS.recommended, revision: 1.5 },
  ];
  for (const value of invalid) expectValidationError(() => parseSourceProfileReference(value));
  assert.equal(accessorRead, false);
});

test("unknown profiles and stale revisions fail distinctly without echoing identifiers", () => {
  assert.throws(
    () => materializeSourceAdmission(reference("not-a-profile", 7), context()),
    rejectionCode("profileUnknown"),
  );
  assert.throws(
    () => materializeSourceAdmission(reference(SOURCE_PROFILE_IDS.travel, 2), context()),
    (error) => error instanceof Error
      && rejectionCode("profileRevisionStale")(error)
      && !error.message.includes(SOURCE_PROFILE_IDS.travel)
      && !error.message.includes("2"),
  );
});

test("current grants and enabled stream addons alone select addon providers", () => {
  const visible = addon("private-key-one", { name: "Same display name", allowedUsers: [MEMBER] });
  const hidden = addon("private-key-two", { name: "Same display name", allowedUsers: [OTHER] });
  const disabled = addon("disabled-key", { allowedUsers: [MEMBER], enabled: false });
  const catalogOnly = addon("catalog-key", { allowedUsers: [MEMBER], role: "catalog" });
  const metadataOnly = addon("metadata-key", {
    allowedUsers: [MEMBER],
    resources: [{ name: "meta" }],
  });
  const snapshot = materializeSourceAdmission(
    reference(SOURCE_PROFILE_IDS.recommended),
    context(account(), { addons: [visible, hidden, disabled, catalogOnly, metadataOnly] }),
  );

  assert.deepEqual(snapshot.providerKeys, ["addon:private-key-one"]);
  assert.deepEqual(
    snapshot.policy.criteria.find((criterion) => criterion.kind === "providerOrder"),
    { kind: "providerOrder", keys: ["addon:private-key-one"] },
  );
});

test("rules profiles admit by media kind and their policies round-trip", () => {
  const preset = RULE_PRESETS[0]!;
  const profile: StoredSourceProfile = {
    id: preset.id,
    revision: 1,
    template: "rules",
    nameKey: preset.nameKey,
    parameters: preset.rules,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const source = addon("rule-addon", { allowedUsers: [MEMBER] });
  const episode = materializeSourceAdmission(reference(profile.id), context(account(), {
    profiles: [profile],
    addons: [source],
    operation: "downloadToLibrary",
    mediaKind: "episode",
  }));
  assert.deepEqual(episode.profile, { id: profile.id, revision: 1, template: "rules" });
  assert.deepEqual(episode.policy.constraints.bytes, { max: 4_000_000_000 });
  assert.deepEqual(parseSourceAdmissionSnapshotV1(structuredClone(episode)), episode);

  const movie = materializeSourceAdmission(reference(profile.id), context(account(), {
    profiles: [profile],
    addons: [source],
    operation: "downloadToLibrary",
    mediaKind: "movie",
  }));
  assert.deepEqual(movie.policy.constraints.bytes, { max: 15_000_000_000 });

  assert.deepEqual(parseSourceProfileSnapshot({
    profileId: profile.id,
    revision: 1,
    template: "rules",
    parameters: preset.rules,
  }), {
    profileId: profile.id,
    revision: 1,
    template: "rules",
    parameters: preset.rules,
  });
});

test("a frozen snapshot built from v1 rules still validates with the same policy", () => {
  const providerKeys = ["addon:legacy-rule"];
  const legacyRules = parseDownloadRules({
    addons: { scope: { selected: ["legacy-rule"] }, order: "viewer" },
    torrents: true,
    resolution: { min: 720, max: 1080 },
    audio: { mode: "prefer", fallback: "cs" },
    subtitles: "ifAvailable",
    maxSizeGb: { episode: 4, movie: 15 },
    skipCinema: false,
    preference: ["language", "resolutionHigher", "addonOrder", "smaller"],
  });
  const policy = materializeSourceAdmissionPolicy(
    rulesPolicy(legacyRules, "episode"),
    providerKeys,
    { audioLanguage: "en", subtitleLanguage: "en" },
  );
  const snapshot = parseSourceAdmissionSnapshotV1({
    schemaVersion: 1,
    profile: { id: "legacy-rules", revision: 1, template: "rules" },
    operation: "downloadToLibrary",
    providerKeys,
    policy,
  });
  assert.deepEqual(snapshot.policy, policy);
});

test("provider order keeps instance class order and the viewer addon overlay", () => {
  const zeta = addon("zeta", { allowedUsers: [ADMIN, MEMBER] });
  const alpha = addon("alpha", { allowedUsers: [ADMIN, MEMBER] });
  const beta = addon("beta", { allowedUsers: [ADMIN, MEMBER] });
  const libraries = [library("lib_00000001", [MEMBER]), library("lib_00000002", [MEMBER])];
  const remotes = [remoteLibrary(REMOTE_TWO, [MEMBER]), remoteLibrary(REMOTE_ONE, [MEMBER])];

  const member = materializeSourceAdmission(
    reference(SOURCE_PROFILE_IDS.recommended),
    context(account(), {
      addons: [zeta, alpha, beta],
      libraries,
      remoteLibraries: remotes,
      addonOrder: ["alpha", "zeta"],
    }),
  );
  assert.deepEqual(member.providerKeys, [
    "local",
    `remote:${REMOTE_TWO}`,
    `remote:${REMOTE_ONE}`,
    "addon:alpha",
    "addon:zeta",
    "addon:beta",
  ]);
  assert.deepEqual(
    member.policy.criteria.find((criterion) => criterion.kind === "providerOrder"),
    { kind: "providerOrder", keys: member.providerKeys },
  );

  const admin = materializeSourceAdmission(
    reference(SOURCE_PROFILE_IDS.recommended),
    context(account(ADMIN, "admin"), {
      addons: [zeta, alpha, beta],
      addonOrder: ["alpha", "zeta"],
    }),
  );
  assert.deepEqual(admin.providerKeys, ["addon:zeta", "addon:alpha", "addon:beta"]);

  const earlierRemote = { ...remotes[1]!, order: 1 };
  const laterRemote = { ...remotes[0]!, order: 2 };
  const byConfiguredOrder = materializeSourceAdmission(
    reference(SOURCE_PROFILE_IDS.recommended),
    context(account(), { remoteLibraries: [laterRemote, earlierRemote] }),
  );
  assert.deepEqual(byConfiguredOrder.providerKeys, [
    `remote:${REMOTE_ONE}`,
    `remote:${REMOTE_TWO}`,
  ]);
});

test("selected scope intersects in current provider order and never adds visible providers", () => {
  const scope = selectedPolicy(["addon:hidden", `remote:${REMOTE_ONE}`, "addon:visible"]).scope;
  const available = ["addon:visible", "local", `remote:${REMOTE_ONE}`];

  assert.deepEqual(sourceAdmissionProviderScope(scope, available), [
    "addon:visible",
    `remote:${REMOTE_ONE}`,
  ]);
  assert.deepEqual(sourceAdmissionProviderScope({ mode: "allAvailable" }, available), available);
  assert.deepEqual(sourceAdmissionProviderScope(scope, ["addon:other", "local"]), []);

  const reverseMembership = selectedPolicy(["addon:zeta", "addon:alpha"]);
  const frozenMembership = sourceAdmissionProviderScope(reverseMembership.scope, ["addon:alpha", "addon:zeta"]);
  assert.deepEqual(frozenMembership, ["addon:alpha", "addon:zeta"]);
  assert.deepEqual(
    materializeSourceAdmissionPolicy(reverseMembership, frozenMembership, {
      audioLanguage: "cs",
      subtitleLanguage: "en",
    }).criteria[0],
    { kind: "providerOrder", keys: ["addon:alpha", "addon:zeta"] },
  );

  const policy = selectedPolicy(["addon:zeta", "addon:alpha"]);
  const frozen = materializeSourceAdmissionPolicy(policy, ["addon:alpha"], {
    audioLanguage: "cs",
    subtitleLanguage: "en",
  });
  assert.deepEqual(frozen.scope, { mode: "selected", providerKeys: ["addon:alpha"] });
  assert.deepEqual(frozen.criteria[0], { kind: "providerOrder", keys: ["addon:alpha"] });
});

test("operation grants and source paths are checked inside admission", () => {
  assert.throws(
    () => materializeSourceAdmission(reference(SOURCE_PROFILE_IDS.recommended), context()),
    rejectionCode("providerScopeUnavailable"),
  );

  const writable = addon("writable", { allowedUsers: [MEMBER] });
  const noLibraryDownload = account(MEMBER, "user", {
    downloadToLibrary: false,
    downloadToDevice: true,
  });
  assert.throws(
    () => materializeSourceAdmission(reference(SOURCE_PROFILE_IDS.travel), context(noLibraryDownload, {
      addons: [writable],
      operation: "downloadToLibrary",
    })),
    rejectionCode("operationForbidden"),
  );

  assert.throws(
    () => materializeSourceAdmission(reference(SOURCE_PROFILE_IDS.travel), context(account(), {
      libraries: [library("lib_00000001", [MEMBER])],
      remoteLibraries: [remoteLibrary(REMOTE_ONE, [MEMBER])],
      operation: "downloadToLibrary",
    })),
    rejectionCode("providerScopeUnavailable"),
  );

  const librarySnapshot = materializeSourceAdmission(
    reference(SOURCE_PROFILE_IDS.travel),
    context(account(), {
      addons: [writable],
      libraries: [library("lib_00000001", [MEMBER])],
      remoteLibraries: [remoteLibrary(REMOTE_ONE, [MEMBER])],
      operation: "downloadToLibrary",
    }),
  );
  assert.deepEqual(librarySnapshot.providerKeys, ["addon:writable"]);

  assert.throws(
    () => materializeSourceAdmission(reference(SOURCE_PROFILE_IDS.recommended), context(account(), {
      addons: [writable],
      operation: "downloadToLibrary",
    })),
    rejectionCode("operationUnsupported"),
  );

  const disabledViewer = { ...account(), disabled: true };
  assert.throws(
    () => materializeSourceAdmission(reference(SOURCE_PROFILE_IDS.recommended), context(disabledViewer, {
      addons: [writable],
    })),
    rejectionCode("operationForbidden"),
  );
  assert.throws(
    () => materializeSourceAdmission(
      reference(SOURCE_PROFILE_IDS.recommended),
      context(account(), { addons: [writable], operation: "bulk" as SourceAdmissionContext["operation"] }),
    ),
    rejectionCode("operationUnsupported"),
  );
});

test("language preferences resolve canonically and conflicting values fail", () => {
  const snapshot = materializeSourceAdmission(
    reference(SOURCE_PROFILE_IDS.recommended),
    context(account(), {
      addons: [addon("language-source", { allowedUsers: [MEMBER] })],
      audioLanguage: "Czech",
      subtitleLanguage: "ENG",
    }),
  );
  assert.deepEqual(snapshot.policy.constraints.audio, {
    mode: "preferred",
    preferred: { code: "cs" },
  });
  assert.deepEqual(snapshot.policy.constraints.subtitles, {
    mode: "optional",
    preferred: { code: "en" },
  });

  assert.throws(
    () => materializeSourceAdmission(
      reference(SOURCE_PROFILE_IDS.recommended),
      context(account(), { addons: [addon("source")], audioLanguage: "xx" }),
    ),
    rejectionCode("languagePreferenceUnavailable"),
  );

  assert.throws(
    () => materializeSourceAdmissionPolicy(selectedPolicy(["addon:a"], { audioFallback: "en" }), ["addon:a"], {
      audioLanguage: "English",
      subtitleLanguage: "cs",
    }),
    rejectionCode("languagePreferenceDuplicate"),
  );
  assert.throws(
    () => materializeSourceAdmissionPolicy(selectedPolicy(["addon:a"], { subtitleFallback: "en" }), ["addon:a"], {
      audioLanguage: "cs",
      subtitleLanguage: "ENG",
    }),
    rejectionCode("languagePreferenceDuplicate"),
  );
});

test("Travel freezes its quality floor, ascending size and local-copy policy", () => {
  const snapshot = materializeSourceAdmission(
    reference(SOURCE_PROFILE_IDS.travel),
    context(account(), {
      addons: [addon("travel-source", { allowedUsers: [MEMBER] })],
      libraries: [library("lib_00000001", [MEMBER])],
      remoteLibraries: [remoteLibrary(REMOTE_ONE, [MEMBER])],
      audioLanguage: "cs",
      subtitleLanguage: "en",
    }),
  );

  assert.deepEqual(snapshot.policy.constraints.heightPixels, { min: 480 });
  assert.deepEqual(snapshot.policy.constraints.sourceKinds, ["localFile", "http", "mediaServerOriginal"]);
  assert.deepEqual(snapshot.policy.criteria, [
    { kind: "audioTier" },
    { kind: "size", direction: "asc" },
    {
      kind: "providerOrder",
      keys: ["local", `remote:${REMOTE_ONE}`, "addon:travel-source"],
    },
  ]);
  assert.equal(snapshot.policy.existingLocalCopy, "meetsRequirements");
  assert.equal(snapshot.policy.nextEpisode, "profile");
});

test("rules downloads admit visible remote libraries before addons", () => {
  const firstRemote = remoteLibrary(REMOTE_ONE, [MEMBER]);
  const secondRemote = { ...remoteLibrary(REMOTE_TWO, [MEMBER]), order: 1 };
  const snapshot = materializeSourceAdmission(
    reference(SOURCE_PROFILE_IDS.balanced),
    context(account(), {
      profiles: [storedRules()],
      addons: [addon("first", { allowedUsers: [MEMBER] }), addon("second", { allowedUsers: [MEMBER] })],
      remoteLibraries: [secondRemote, firstRemote],
      operation: "downloadToLibrary",
    }),
  );

  assert.deepEqual(snapshot.providerKeys, [
    `remote:${REMOTE_ONE}`,
    `remote:${REMOTE_TWO}`,
    "addon:first",
    "addon:second",
  ]);
  assert.deepEqual(
    snapshot.policy.criteria.find((criterion) => criterion.kind === "providerOrder"),
    { kind: "providerOrder", keys: snapshot.providerKeys },
  );
});

test("other download templates keep their addon-only provider snapshots", () => {
  for (const profileId of [SOURCE_PROFILE_IDS.travel, SOURCE_PROFILE_IDS.providerPriority]) {
    const snapshot = materializeSourceAdmission(
      reference(profileId),
      context(account(), {
        addons: [addon("source", { allowedUsers: [MEMBER] })],
        remoteLibraries: [remoteLibrary(REMOTE_ONE, [MEMBER])],
        operation: "downloadToLibrary",
      }),
    );
    assert.deepEqual(snapshot.providerKeys, ["addon:source"], profileId);
  }
});

test("rules downloads without the copy right keep remote providers out", () => {
  assert.throws(
    () => materializeSourceAdmission(
      reference(SOURCE_PROFILE_IDS.balanced),
      context(account(MEMBER, "user", { downloadToLibrary: false, downloadToDevice: true }), {
        profiles: [storedRules()],
        addons: [addon("source", { allowedUsers: [MEMBER] })],
        remoteLibraries: [remoteLibrary(REMOTE_ONE, [MEMBER])],
        operation: "downloadToLibrary",
      }),
    ),
    rejectionCode("operationForbidden"),
  );
});

test("Travel snapshot parsing rematerializes only its mutable provider and language fields", () => {
  const materialized = materializeSourceAdmission(
    reference(SOURCE_PROFILE_IDS.travel),
    context(account(), {
      addons: [addon("travel-source"), addon("travel-backup")],
      audioLanguage: "cs",
      subtitleLanguage: "en",
      operation: "downloadToLibrary",
    }),
  );
  const snapshot = parseSourceAdmissionSnapshotV1(JSON.parse(JSON.stringify(materialized)));
  assert.deepEqual(snapshot.providerKeys, ["addon:travel-source", "addon:travel-backup"]);
  assert.deepEqual(snapshot.policy.constraints.audio.preferred, { code: "cs" });
  assert.deepEqual(snapshot.policy.constraints.subtitles.preferred, { code: "en" });

  const reordered = JSON.parse(JSON.stringify(snapshot));
  reordered.policy = Object.fromEntries(Object.entries(reordered.policy).reverse());
  reordered.policy.constraints = Object.fromEntries(Object.entries(reordered.policy.constraints).reverse());
  reordered.policy.constraints.audio = Object.fromEntries(
    Object.entries(reordered.policy.constraints.audio).reverse(),
  );
  assert.deepEqual(parseSourceAdmissionSnapshotV1(reordered), snapshot);

  const reject = (tamper: (value: SourceAdmissionSnapshotV1) => void) => {
    const value = structuredClone(snapshot);
    tamper(value);
    expectValidationError(() => parseSourceAdmissionSnapshotV1(value));
  };
  reject((value) => { value.policy.constraints.heightPixels = { min: 1 }; });
  reject((value) => {
    const ranking = value.policy.criteria.find((criterion) => criterion.kind === "size");
    assert.ok(ranking?.kind === "size");
    ranking.direction = "desc";
  });
  reject((value) => { value.policy.existingLocalCopy = "any"; });
});

for (const [name, profileId] of [
  ["Recommended", SOURCE_PROFILE_IDS.recommended],
  ["Provider priority", SOURCE_PROFILE_IDS.providerPriority],
] as const) {
  test(`${name} snapshot parsing validates its current fixed definition`, () => {
    const definition = SOURCE_PROFILE_DEFINITIONS.find((candidate) => candidate.id === profileId);
    assert.ok(definition);
    const providerKeys = ["local", `remote:${REMOTE_ONE}`, "addon:first", "addon:second"];
    const snapshot = parseSourceAdmissionSnapshotV1({
      schemaVersion: 1,
      profile: { id: profileId, revision: definition.revision },
      operation: "downloadToDevice",
      providerKeys,
      policy: materializeSourceAdmissionPolicy(
        definition.policy,
        providerKeys,
        { audioLanguage: "cs", subtitleLanguage: "en" },
      ),
    });

    const serialized = JSON.parse(JSON.stringify(snapshot)) as SourceAdmissionSnapshotV1;
    const reordered = Object.fromEntries(
      Object.entries(serialized).reverse(),
    ) as unknown as SourceAdmissionSnapshotV1;
    reordered.profile = Object.fromEntries(Object.entries(serialized.profile).reverse()) as typeof serialized.profile;
    reordered.policy = Object.fromEntries(
      Object.entries(serialized.policy).reverse(),
    ) as unknown as SourcePolicyV1;
    reordered.policy.scope = Object.fromEntries(
      Object.entries(serialized.policy.scope).reverse(),
    ) as typeof serialized.policy.scope;
    reordered.policy.constraints = Object.fromEntries(
      Object.entries(serialized.policy.constraints).reverse(),
    ) as typeof serialized.policy.constraints;
    reordered.policy.constraints.audio = Object.fromEntries(
      Object.entries(serialized.policy.constraints.audio).reverse(),
    ) as typeof serialized.policy.constraints.audio;
    reordered.policy.constraints.subtitles = Object.fromEntries(
      Object.entries(serialized.policy.constraints.subtitles).reverse(),
    ) as typeof serialized.policy.constraints.subtitles;
    assert.deepEqual(parseSourceAdmissionSnapshotV1(reordered), snapshot);

    const allowedProviderKeys = ["addon:second", "local"];
    const allowed = parseSourceAdmissionSnapshotV1({
      schemaVersion: 1,
      profile: { id: profileId, revision: definition.revision },
      operation: "play",
      providerKeys: allowedProviderKeys,
      policy: materializeSourceAdmissionPolicy(
        definition.policy,
        allowedProviderKeys,
        { audioLanguage: "en", subtitleLanguage: "cs" },
      ),
    });
    assert.deepEqual(allowed.providerKeys, allowedProviderKeys);
    assert.deepEqual(allowed.policy.constraints.audio.preferred, { code: "en" });
    assert.deepEqual(allowed.policy.constraints.subtitles.preferred, { code: "cs" });

    const reject = (tamper: (value: SourceAdmissionSnapshotV1) => void) => {
      const value = structuredClone(snapshot);
      tamper(value);
      expectValidationError(() => parseSourceAdmissionSnapshotV1(value));
    };
    reject((value) => {
      const ranking = value.policy.criteria.find((criterion) => criterion.kind === "providerClass");
      assert.ok(ranking?.kind === "providerClass");
      ranking.order.reverse();
    });
    reject((value) => { value.policy.existingLocalCopy = "any"; });
    reject((value) => { value.policy.constraints.audio.mode = "strict"; });
    reject((value) => { value.policy.constraints.sourceKinds.reverse(); });
    reject((value) => {
      value.policy.scope = { mode: "selected", providerKeys: [...value.providerKeys].reverse() };
    });
    reject((value) => {
      const ranking = value.policy.criteria.find((criterion) => criterion.kind === "providerOrder");
      assert.ok(ranking?.kind === "providerOrder" && "keys" in ranking);
      ranking.keys.reverse();
    });
    reject((value) => { value.policy.constraints.subtitles.mode = "required"; });
  });
}

test("snapshots are JSON-safe deep copies and leak no provider configuration", () => {
  const provider = addon("opaque-addon-key", { name: "Secret display name", allowedUsers: [MEMBER] });
  const local = library("lib_00000001", [MEMBER]);
  const remote = remoteLibrary(REMOTE_ONE, [MEMBER]);
  const first = materializeSourceAdmission(
    reference(SOURCE_PROFILE_IDS.recommended),
    context(account(), { addons: [provider], libraries: [local], remoteLibraries: [remote] }),
  );
  const second = materializeSourceAdmission(
    reference(SOURCE_PROFILE_IDS.recommended),
    context(account(), { addons: [provider], libraries: [local], remoteLibraries: [remote] }),
  );

  assert.deepEqual(Object.keys(first).sort(), ["operation", "policy", "profile", "providerKeys", "schemaVersion"]);
  assert.deepEqual(first.profile, {
    id: SOURCE_PROFILE_IDS.recommended,
    revision: 1,
    template: "recommended",
  });
  const text = JSON.stringify(first);
  for (const secret of [
    "Secret display name",
    "private-addon.example",
    "manifest-secret",
    "Private library",
    "/private/library",
    "Private remote",
    "Private connection",
    "private-media.example",
    "private-server",
    "private-account",
    connection.secretRef!,
  ]) {
    assert.doesNotMatch(text, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  first.providerKeys.length = 0;
  first.policy.scope = { mode: "allAvailable" };
  first.policy.constraints.sourceKinds.length = 0;
  const providerOrder = first.policy.criteria.find((criterion) => criterion.kind === "providerOrder");
  if (providerOrder && "keys" in providerOrder) providerOrder.keys.length = 0;
  assert.ok(second.providerKeys.length > 0);
  assert.notEqual(first.policy.constraints.sourceKinds, second.policy.constraints.sourceKinds);
  assert.deepEqual(SOURCE_PROFILE_DEFINITIONS[0]?.policy.scope, { mode: "allAvailable" });
  assert.deepEqual(SOURCE_PROFILE_DEFINITIONS[0]?.policy.constraints.sourceKinds, [
    "localFile",
    "mediaServerOriginal",
    "http",
    "torrent",
  ]);
});

test("snapshot parsing round-trips and validates provenance without resolving profiles", () => {
  const snapshot = materializeSourceAdmission(
    reference(SOURCE_PROFILE_IDS.recommended),
    context(account(), {
      addons: [addon("first"), addon("second")],
      addonOrder: ["second", "first"],
    }),
  );
  const parsed = parseSourceAdmissionSnapshotV1(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(parsed, snapshot);
  assert.notEqual(parsed, snapshot);
  assert.notEqual(parsed.policy, snapshot.policy);

  const historical = structuredClone(snapshot);
  historical.profile = { id: "deleted-profile", revision: 99, template: "recommended" };
  assert.deepEqual(parseSourceAdmissionSnapshotV1(historical).profile, {
    id: "deleted-profile",
    revision: 99,
    template: "recommended",
  });
});

test("snapshot parsing rejects malformed, symbolic and mismatched data generically", () => {
  const valid = materializeSourceAdmission(
    reference(SOURCE_PROFILE_IDS.recommended),
    context(account(), { addons: [addon("first"), addon("second")] }),
  );
  const malformed: Array<() => unknown> = [
    () => ({ ...structuredClone(valid), schemaVersion: 2 }),
    () => ({ ...structuredClone(valid), extra: "private value" }),
    () => ({ ...structuredClone(valid), operation: "stream" }),
    () => ({ ...structuredClone(valid), profile: { id: "", revision: 1 } }),
    () => ({ ...structuredClone(valid), profile: { id: "profile", revision: 0 } }),
    () => ({ ...structuredClone(valid), providerKeys: ["addon:first", "addon:first"] }),
    () => ({ ...structuredClone(valid), providerKeys: ["file:first", "addon:second"] }),
    () => {
      const value = structuredClone(valid);
      value.policy.scope = { mode: "allAvailable" };
      return value;
    },
    () => {
      const value = structuredClone(valid);
      value.policy.constraints.audio.preferred = { preference: "audio" } as never;
      return value;
    },
    () => {
      const value = structuredClone(valid);
      const criterion = value.policy.criteria.find((item) => item.kind === "providerOrder");
      if (criterion && "keys" in criterion) criterion.keys = ["addon:first"];
      return value;
    },
    () => {
      const value = structuredClone(valid);
      const criterion = value.policy.criteria.find((item) => item.kind === "providerOrder");
      if (criterion && "keys" in criterion) criterion.keys = ["addon:first", "addon:unknown"];
      return value;
    },
    () => {
      const value = structuredClone(valid) as unknown as Record<string, unknown>;
      value.providerKeys = new (class extends Array<string> {})("addon:first", "addon:second");
      return value;
    },
  ];
  for (const value of malformed) expectValidationError(() => parseSourceAdmissionSnapshotV1(value()));

  let accessorRead = false;
  const accessor = structuredClone(valid) as unknown as Record<string, unknown>;
  delete accessor.schemaVersion;
  Object.defineProperty(accessor, "schemaVersion", {
    enumerable: true,
    get() {
      accessorRead = true;
      return 1;
    },
  });
  expectValidationError(() => parseSourceAdmissionSnapshotV1(accessor));
  assert.equal(accessorRead, false);
});

test("template snapshot validation accepts historical built-ins and rejects illegal policies", () => {
  const legacy = structuredClone(materializeSourceAdmission(
    reference(SOURCE_PROFILE_IDS.travel),
    context(account(), { addons: [addon("travel-source")], operation: "downloadToLibrary" }),
  )) as unknown as SourceAdmissionSnapshotV1 & { profile: { template?: string } };
  delete (legacy.profile as { template?: string }).template;
  assert.equal(parseSourceAdmissionSnapshotV1(legacy).profile.template, "travel");

  const illegalTravel = structuredClone(parseSourceAdmissionSnapshotV1(legacy));
  illegalTravel.policy.constraints.heightPixels = { min: 1 };
  expectValidationError(() => parseSourceAdmissionSnapshotV1(illegalTravel));

  const illegalProvider = structuredClone(materializeSourceAdmission(
    reference(SOURCE_PROFILE_IDS.providerPriority),
    context(account(), { addons: [addon("priority-source")], operation: "downloadToLibrary" }),
  ));
  illegalProvider.policy.constraints.heightPixels = { min: 480 };
  expectValidationError(() => parseSourceAdmissionSnapshotV1(illegalProvider));
});

test("a provider revoked between admissions disappears without reordering survivors", () => {
  const first = addon("first", { allowedUsers: [MEMBER] });
  const second = addon("second", { allowedUsers: [MEMBER] });
  const local = library("lib_00000001", [MEMBER]);
  const remote = remoteLibrary(REMOTE_ONE, [MEMBER]);
  const input = context(account(), {
    addons: [first, second],
    libraries: [local],
    remoteLibraries: [remote],
  });

  const before = materializeSourceAdmission(reference(SOURCE_PROFILE_IDS.recommended), input);
  assert.deepEqual(before.providerKeys, [
    "local",
    `remote:${REMOTE_ONE}`,
    "addon:first",
    "addon:second",
  ]);

  first.allowedUsers = [];
  remote.enabled = false;
  const after = materializeSourceAdmission(reference(SOURCE_PROFILE_IDS.recommended), input);
  assert.deepEqual(after.providerKeys, ["local", "addon:second"]);
  assert.deepEqual(
    after.policy.criteria.find((criterion) => criterion.kind === "providerOrder"),
    { kind: "providerOrder", keys: ["local", "addon:second"] },
  );
});

test("the snapshot type keeps fully materialized policy and provider membership", () => {
  const snapshot: SourceAdmissionSnapshotV1 = materializeSourceAdmission(
    reference(SOURCE_PROFILE_IDS.providerPriority),
    context(account(), { addons: [addon("priority")] }),
  );
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.operation, "play");
  assert.deepEqual(snapshot.providerKeys, ["addon:priority"]);
  assert.equal(snapshot.policy.scope.mode, "selected");
  assert.doesNotMatch(JSON.stringify(snapshot), /"from":"viewer"|"preference":"(audio|subtitle)"/);
});
