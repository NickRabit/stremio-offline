import assert from "node:assert/strict";
import test from "node:test";
import { addonIdentity } from "./addon-identity.js";
import type { DownloadJob, DownloadSelection } from "./downloads.js";
import { defaultDownloadSettings } from "./naming.js";
import { remoteDownloadKey, type RemoteDownloadReference } from "./media-server-download.js";
import type { ProviderVersion } from "./media-server-provider.js";
import type { MediaInfo } from "./probe.js";
import { materializeSourceAdmissionPolicy, type SourceAdmissionSnapshotV1 } from "./source-admission.js";
import { parseDownloadRules, rulesPolicy, type DownloadRules } from "./download-rules.js";
import {
  createRulesProfileResolver,
  type RulesProfileResolverInput,
} from "./source-profile-resolver.js";
import { RULE_PRESETS, SOURCE_PROFILE_IDS } from "./source-profiles.js";
import type { SourceResolverDeps } from "./source-resolver.js";
import type { AddonRecord, StreamItem } from "./types.js";
import type { UserRecord } from "./users.js";

const OWNER = "usr_00000041";
const REMOTE_LIBRARY = `rlib_${"4".repeat(32)}`;
const REMOTE_KEY = `remote:${REMOTE_LIBRARY}`;
const ADDON_KEY = "addon:fixture";

const user = (): UserRecord => ({
  id: OWNER,
  username: "owner",
  passwordHash: "",
  secret: "owner-secret",
  role: "user",
  createdAt: "2026-01-01T00:00:00.000Z",
  permissions: { downloadToLibrary: true, downloadToDevice: true },
  permissionsVersion: 0,
});

const addon = (): AddonRecord => ({
  key: "fixture",
  manifestUrl: "https://addon.example/manifest.json",
  role: "source",
  enabled: true,
  globalSearch: true,
  allowedUsers: [OWNER],
  addedAt: "2026-01-01T00:00:00.000Z",
  downloadSettings: defaultDownloadSettings(),
  manifest: {
    id: "fixture",
    name: "Fixture",
    version: "1",
    resources: ["stream"],
  },
});

const balancedRules = (overrides: Partial<DownloadRules> = {}): DownloadRules =>
  parseDownloadRules({
    ...structuredClone(RULE_PRESETS.find((preset) => preset.id === SOURCE_PROFILE_IDS.balanced)!.rules),
    ...overrides,
  });

const snapshot = (
  providerKeys: string[],
  rules: DownloadRules = balancedRules(),
): SourceAdmissionSnapshotV1 => ({
  schemaVersion: 1,
  profile: { id: SOURCE_PROFILE_IDS.balanced, revision: 1, template: "rules" },
  operation: "downloadToLibrary",
  providerKeys,
  policy: materializeSourceAdmissionPolicy(
    rulesPolicy(rules, "episode"),
    providerKeys,
    { audioLanguage: "cs", subtitleLanguage: "en" },
  ),
});

const selection = (): DownloadSelection => ({
  addonKeys: ["fixture"],
  sourceStrategy: "priority",
  audioLanguage: "cs",
  fallbackAudioLanguage: undefined,
  audioMode: "preferred",
  subtitleMode: "optional",
  subtitleLanguage: "en",
  targetSettings: defaultDownloadSettings().series,
});

const source = (tried: string[] = []): NonNullable<DownloadJob["source"]> => ({
  type: "series",
  videoId: "tt-continue:1:2",
  tried,
  selection: selection(),
});

const reference = (overrides: Partial<RemoteDownloadReference> = {}): RemoteDownloadReference => ({
  schemaVersion: 1,
  ownerUserId: OWNER,
  connectionId: `mconn_${"5".repeat(32)}`,
  libraryId: REMOTE_LIBRARY,
  generation: 1,
  provider: "jellyfin",
  serverId: "server-1",
  accountId: "account-1",
  itemId: "episode-1",
  mediaSourceId: "version-1",
  ...overrides,
});

const remoteStream = (name = "Show.S01E02.1080p.mkv"): StreamItem => ({
  name,
  behaviorHints: { filename: name, videoSize: 4_000_000_000 },
});

const remoteCandidate = (
  version: ProviderVersion = {
    id: "version-1",
    name: "Show.S01E02.1080p.mkv",
    size: 4_000_000_000,
    videoWidth: 1920,
    videoHeight: 800,
    audioLanguages: ["cs"],
  },
) => ({
  reference: reference(),
  version,
  libraryName: "Shows",
  stream: remoteStream(version.name),
});

const addonStream = (): StreamItem => ({
  addonKey: "fixture",
  url: "https://addon.example/Show.S01E02.720p.mkv?token=secret",
  name: "Show.S01E02.720p.mkv",
  behaviorHints: { filename: "Show.S01E02.720p.mkv", videoSize: 2_000_000_000 },
});

const media = (height: number): MediaInfo => ({
  container: "matroska",
  duration: 2_400,
  video: { codec: "h264", width: Math.round(height * 16 / 9), height },
  audioTracks: [{ index: 0, codec: "aac", language: "cs" }],
  subtitleTracks: [],
});

const resolverFor = (options: {
  remote: SourceResolverDeps["remoteDownloadCandidates"];
  addonStreams?: StreamItem[];
  inspected?: MediaInfo;
  inspectedIds?: string[];
}) => {
  const deps: SourceResolverDeps = {
    users: () => [user()],
    addons: () => [addon()],
    prefs: () => ({ audioLanguage: "cs" }),
    hasRealDebrid: () => false,
    serverReady: Promise.resolve(),
    listStreams: async () => options.addonStreams ?? [],
    listSubtitles: async () => [],
    inspect: async (stream) => {
      options.inspectedIds?.push(stream.url ?? stream.name ?? "");
      return options.inspected ?? media(720);
    },
    remoteDownloadCandidates: options.remote,
  };
  return createRulesProfileResolver(deps);
};

const input = (
  snapshotValue: SourceAdmissionSnapshotV1,
  overrides: Partial<RulesProfileResolverInput> = {},
): RulesProfileResolverInput => ({
  source: source(),
  snapshot: snapshotValue,
  ownerUserId: OWNER,
  signal: new AbortController().signal,
  ...overrides,
});

test("a remote 1080p Czech original beats an addon 720p under the same rules", async () => {
  const inspected: string[] = [];
  const resolver = resolverFor({
    addonStreams: [addonStream()],
    inspectedIds: inspected,
    remote: async () => [remoteCandidate()],
  });

  const result = await resolver(input(snapshot([REMOTE_KEY, ADDON_KEY])));

  assert.equal(result.status, "selected");
  if (result.status !== "selected") return;
  assert.equal("remoteDownload" in result, true);
  if (!("remoteDownload" in result)) return;
  assert.equal(result.remoteDownload.mediaSourceId, "version-1");
  assert.deepEqual(result.stream, remoteStream());
  assert.equal(result.resolution.audioLanguage, "cs");
  assert.equal(result.resolution.audioEvidence, "metadata");
  assert.equal(inspected.length, 0, "the lower listed addon cannot beat the metadata-ranked remote");
});

test("an addon wins when the remote original breaks a hard resolution limit", async () => {
  const resolver = resolverFor({
    addonStreams: [addonStream()],
    inspected: media(1080),
    remote: async () => [remoteCandidate({
      id: "version-1",
      name: "Show.S01E02.2160p.mkv",
      videoWidth: 3840,
      videoHeight: 2160,
      audioLanguages: ["cs"],
    })],
  });

  const result = await resolver(input(snapshot([REMOTE_KEY, ADDON_KEY])));

  assert.equal(result.status, "selected");
  if (result.status !== "selected") return;
  assert.equal("remoteDownload" in result, false);
  if ("remoteDownload" in result) return;
  assert.equal(result.stream.addonKey, "fixture");
  assert.equal(result.streamAddonIdentity, addonIdentity(addon()));
});

test("a remote provider failure leaves an addon selectable and records a temporary failure", async () => {
  const resolver = resolverFor({
    addonStreams: [addonStream()],
    remote: async () => { throw new Error("temporarily offline"); },
  });

  const result = await resolver(input(snapshot([REMOTE_KEY, ADDON_KEY])));

  assert.equal(result.status, "selected");
  if (result.status !== "selected") return;
  assert.equal(result.stream.addonKey, "fixture");
  assert.equal(result.observations.temporaryFailures, 1);
});

test("a remote-only provider failure is temporary rather than noMatch", async () => {
  const resolver = resolverFor({
    remote: async () => { throw new Error("temporarily offline"); },
  });

  const result = await resolver(input(snapshot([REMOTE_KEY])));

  assert.equal(result.status, "temporaryFailure");
  assert.equal(result.retryable, true);
  assert.equal(result.observations.temporaryFailures, 1);
});

test("no exact remote match produces no remote candidate", async () => {
  const resolver = resolverFor({ remote: async () => [] });
  const result = await resolver(input(snapshot([REMOTE_KEY])));
  assert.equal(result.status, "noMatch");
  assert.equal("remoteDownload" in result, false);
});

test("a tried remote source is skipped", async () => {
  const candidate = remoteCandidate();
  const tried = `remote:${remoteDownloadKey(candidate.reference)}`;
  const resolver = resolverFor({ remote: async () => [candidate] });
  const result = await resolver(input(snapshot([REMOTE_KEY]), { source: source([tried]) }));
  assert.equal(result.status, "noMatch");
});

test("remote discovery receives the episode catalogue id unchanged", async () => {
  const calls: Parameters<SourceResolverDeps["remoteDownloadCandidates"]>[0][] = [];
  const resolver = resolverFor({
    remote: async (request) => {
      calls.push(request);
      return [];
    },
  });
  await resolver(input(snapshot([REMOTE_KEY])));
  assert.deepEqual(calls.map((call) => ({
    ownerUserId: call.ownerUserId,
    libraryId: call.libraryId,
    type: call.type,
    catalogId: call.catalogId,
  })), [{
    ownerUserId: OWNER,
    libraryId: REMOTE_LIBRARY,
    type: "series",
    catalogId: "tt-continue:1:2",
  }]);
});
