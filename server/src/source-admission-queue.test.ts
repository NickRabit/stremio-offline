import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addonIdentity } from "./addon-identity.js";
import { DebridError } from "./debrid.js";
import { AppError } from "./errors.js";
import {
  materializeSourceAdmissionPolicy,
  parseSourceAdmissionSnapshotV1,
  SourceAdmissionValidationError,
  type SourceAdmissionSnapshotV1,
} from "./source-admission.js";
import { defaultDownloadSettings } from "./naming.js";
import { relativeWithin, type LibraryRecord } from "./libraries.js";
import {
  buildTemplatePolicy,
  defaultTemplateParameters,
  RULE_PRESETS,
  SOURCE_PROFILE_DEFINITIONS,
  SOURCE_PROFILE_IDS,
  type TravelParameters,
} from "./source-profiles.js";
import { rulesPolicy } from "./download-rules.js";
import {
  TravelVerificationError,
  type TravelContinuationCursorV1,
} from "./source-travel.js";
import {
  RULES_INSPECTION_BUDGET,
  type RulesContinuationCursorV1,
} from "./source-rules.js";
import type {
  ProviderPriorityProfileResolution,
  RulesProfileResolution,
  TravelProfileResolution,
} from "./source-profile-resolver.js";
import {
  DownloadQueue,
  ownerMayDownload,
  SOURCE_FALLBACK_ATTEMPT_LIMIT,
  type DownloadJob,
  type DownloadSelection,
  type QueueHooks,
} from "./downloads.js";
import type { AddonRecord, StreamItem } from "./types.js";
import type { UserRecord } from "./users.js";

process.env.ALLOW_PRIVATE_ADDONS = "1";

const LIBRARY_ID = "lib_51a5510a";
const QUEUE_OWNER = "usr_00000031";
const PROVIDER_ONE = "addon:queue-private-token";
const PROVIDER_TWO = "addon:second-provider";
const TRAVEL_BUDGET_ATTEMPT_LIMIT = 1_000;
const RULES_BUDGET_ATTEMPT_LIMIT = 1_000;

const travelCursor = (
  nextIndex = 2,
  rejectedIndices = [0, 1],
): TravelContinuationCursorV1 => ({
  schemaVersion: 1,
  scopeFingerprint: "a".repeat(64),
  listingFingerprint: "b".repeat(64),
  nextIndex,
  rejectedIndices,
});

const rulesCursor = (
  nextIndex = 2,
  rejectedIndices: number[] = [0, 1],
  verified: RulesContinuationCursorV1["verified"] = [],
): RulesContinuationCursorV1 => ({
  schemaVersion: 1,
  scopeFingerprint: "c".repeat(64),
  listingFingerprint: "d".repeat(64),
  nextIndex,
  rejectedIndices,
  verified,
});

const fixedSnapshot = (profileId: string): SourceAdmissionSnapshotV1 => {
  const definition = SOURCE_PROFILE_DEFINITIONS.find((candidate) => candidate.id === profileId);
  assert.ok(definition);
  const providerKeys = [PROVIDER_TWO, PROVIDER_ONE];
  return parseSourceAdmissionSnapshotV1({
    schemaVersion: 1,
    profile: { id: profileId, revision: definition.revision },
    operation: "downloadToLibrary",
    providerKeys,
    policy: materializeSourceAdmissionPolicy(
      definition.policy,
      providerKeys,
      { audioLanguage: "English", subtitleLanguage: "cs" },
    ),
  });
};

const travelSnapshot = (): SourceAdmissionSnapshotV1 => fixedSnapshot(SOURCE_PROFILE_IDS.travel);
const providerPrioritySnapshot = (): SourceAdmissionSnapshotV1 =>
  fixedSnapshot(SOURCE_PROFILE_IDS.providerPriority);
const rulesSnapshot = (): SourceAdmissionSnapshotV1 => {
  const preset = RULE_PRESETS.find((candidate) => candidate.id === SOURCE_PROFILE_IDS.balanced);
  assert.ok(preset);
  const providerKeys = [PROVIDER_TWO, PROVIDER_ONE];
  return parseSourceAdmissionSnapshotV1({
    schemaVersion: 1,
    profile: { id: preset.id, revision: 1, template: "rules" },
    operation: "downloadToLibrary",
    providerKeys,
    policy: materializeSourceAdmissionPolicy(
      rulesPolicy(preset.rules, "movie"),
      providerKeys,
      { audioLanguage: "English", subtitleLanguage: "cs" },
    ),
  });
};
const nonTravelSnapshot = (): SourceAdmissionSnapshotV1 =>
  fixedSnapshot(SOURCE_PROFILE_IDS.recommended);

const storedTravelSnapshot = (
  id = "f29694e1-6b59-4d0b-8ac6-f6d26dc5f27b",
  parameters: TravelParameters = {
    ...defaultTemplateParameters("travel"),
    scope: { mode: "selected", addonKeys: ["queue-private-token"] },
    providerOrder: { addonKeys: ["queue-private-token"] },
    heightPixels: { min: 720 },
  },
): SourceAdmissionSnapshotV1 => {
  const providerKeys = [PROVIDER_ONE];
  return parseSourceAdmissionSnapshotV1({
    schemaVersion: 1,
    profile: { id, revision: 1, template: "travel" },
    operation: "downloadToLibrary",
    providerKeys,
    policy: materializeSourceAdmissionPolicy(
      buildTemplatePolicy("travel", parameters),
      providerKeys,
      { audioLanguage: "English", subtitleLanguage: "cs" },
    ),
  });
};

const selection = (addonKey: string): DownloadSelection => ({
  addonKeys: [addonKey],
  sourceStrategy: "priority",
  audioLanguage: "en",
  audioMode: "preferred",
  subtitleMode: "optional",
  subtitleLanguage: "cs",
  targetSettings: defaultDownloadSettings().movie,
});

const library = (root: string): LibraryRecord => ({
  id: LIBRARY_ID,
  name: "Downloads",
  type: "mixed",
  root,
  enabled: true,
  order: 0,
  addedAt: "2026-01-01T00:00:00.000Z",
  writeArtwork: false,
  visibleTo: [QUEUE_OWNER],
});

const setup = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-source-admission-"));
  const data = path.join(directory, "data");
  const downloads = path.join(directory, "downloads");
  await mkdir(data, { recursive: true });
  await mkdir(downloads, { recursive: true });
  return { directory, data, downloads, state: path.join(data, "downloads.json") };
};

const openQueue = (data: string, downloads: string, hooks: QueueHooks = {}) => {
  const configured = library(downloads);
  return new DownloadQueue(() => 1, () => 1, data, downloads, {
    libraries: () => [configured],
    defaultLibrary: () => configured,
    ...hooks,
  });
};

const readJobs = async (state: string): Promise<Array<Record<string, unknown>>> =>
  JSON.parse(await readFile(state, "utf8")) as Array<Record<string, unknown>>;

const waitFor = async (queue: DownloadQueue, predicate: () => boolean | Promise<boolean>, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout: ${JSON.stringify(queue.snapshot())}`);
};

const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

const internalJobs = (queue: DownloadQueue): DownloadJob[] =>
  (queue as unknown as { jobs: DownloadJob[] }).jobs;

const rawLazyJob = (sourceAdmission: unknown = undefined): Record<string, unknown> => ({
  id: "job-source-admission",
  title: "Film",
  source: { type: "movie", videoId: "tt0000001", tried: [], selection: selection("addon:legacy") },
  ...(sourceAdmission === undefined ? {} : { sourceAdmission }),
  status: "queued",
  target: "",
  received: 0,
  speed: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const assertPublicViewIsClean = (view: Record<string, unknown>) => {
  assert.equal(Object.hasOwn(view, "sourceAdmission"), false);
  assert.equal(Object.hasOwn(view, "travelCursor"), false);
  assert.equal(Object.hasOwn(view, "sourceStreamAddonIdentity"), false);
  assert.equal(Object.hasOwn(view, "sourceSubtitleAddonIdentity"), false);
  assert.equal(Object.hasOwn(view, "sourceFallbackAttempts"), false);
  assert.equal(Object.hasOwn(view, "travelStreamAddonIdentity"), false);
  assert.equal(Object.hasOwn(view, "travelSubtitleAddonIdentity"), false);
  assert.equal(Object.hasOwn(view, "travelSourceFallbackAttempts"), false);
  assert.equal(Object.hasOwn(view, "travelBudgetAttempts"), false);
  assert.equal(Object.hasOwn(view, "rulesCursor"), false);
  assert.equal(Object.hasOwn(view, "rulesTemporaryFailures"), false);
  assert.equal(Object.hasOwn(view, "rulesBudgetAttempts"), false);
  assert.equal(Object.hasOwn(view, "policy"), false);
  const text = JSON.stringify(view);
  assert.doesNotMatch(text, /queue-private-token/);
  assert.doesNotMatch(text, /sourceAdmission/);
  assert.doesNotMatch(text, /travelCursor/);
  assert.doesNotMatch(text, /sourceStreamAddonIdentity/);
  assert.doesNotMatch(text, /sourceSubtitleAddonIdentity/);
  assert.doesNotMatch(text, /sourceFallbackAttempts/);
  assert.doesNotMatch(text, /travelStreamAddonIdentity/);
  assert.doesNotMatch(text, /travelSubtitleAddonIdentity/);
  assert.doesNotMatch(text, /travelSourceFallbackAttempts/);
  assert.doesNotMatch(text, /travelBudgetAttempts/);
  assert.doesNotMatch(text, /rulesCursor/);
  assert.doesNotMatch(text, /"policy"/);
};

const countingServer = (status = 200) => new Promise<{ server: Server; url: string; requests: () => number }>((resolve) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(status, { "content-type": "video/mp4", "content-length": "1" });
    response.end("x");
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as { port: number };
    resolve({ server, url: `http://127.0.0.1:${address.port}/film.mp4`, requests: () => requests });
  });
});

const publicationServer = () => new Promise<{ server: Server; videoUrl: string; subtitleUrl: string }>((resolve) => {
  const server = createServer((request, response) => {
    if (request.url?.endsWith(".vtt")) {
      response.writeHead(200, { "content-type": "text/vtt" });
      response.end("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nSubtitle\n");
      return;
    }
    response.writeHead(200, { "content-type": "video/mp4", "content-length": "1" });
    response.end("x");
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}`;
    resolve({
      server,
      videoUrl: `${origin}/film.mp4`,
      subtitleUrl: `${origin}/film.cs.vtt`,
    });
  });
});

const missingSubtitleServer = () => new Promise<{ server: Server; videoUrl: string; subtitleUrl: string }>((resolve) => {
  const server = createServer((request, response) => {
    if (request.url?.endsWith(".vtt")) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "video/mp4", "content-length": "1" });
    response.end("x");
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}`;
    resolve({
      server,
      videoUrl: `${origin}/film.mp4`,
      subtitleUrl: `${origin}/film.cs.vtt`,
    });
  });
});

const gatedBodyServer = () => new Promise<{
  server: Server;
  url: string;
  entered: Promise<void>;
  release: () => void;
}>((resolve) => {
  const entered = deferred();
  const body = deferred();
  let requests = 0;
  const server = createServer(async (_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "video/mp4", "content-length": "1" });
    if (requests === 1) {
      entered.release();
      await body.promise;
    }
    response.end("x");
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as { port: number };
    resolve({
      server,
      url: `http://127.0.0.1:${address.port}/film.mp4`,
      entered: entered.promise,
      release: body.release,
    });
  });
});

const fileAbsent = async (file: string) => {
  try {
    await stat(file);
    return false;
  } catch {
    return true;
  }
};

const emptyObservations = {
  probesUsed: 0,
  confirmedRejections: 0,
  temporaryFailures: 0,
  accessDenials: 0,
  unresolvedCandidates: 0,
} as const;

type SelectedTravel = Extract<TravelProfileResolution, { status: "selected" }>;
type SelectedProviderPriority = Extract<ProviderPriorityProfileResolution, { status: "selected" }>;

const queueOwner: UserRecord = {
  id: QUEUE_OWNER,
  username: "queue-owner",
  passwordHash: "scrypt$aa$bb",
  secret: "secret",
  role: "user",
  createdAt: "2026-01-01T00:00:00.000Z",
  permissions: { downloadToLibrary: true, downloadToDevice: true },
  permissionsVersion: 0,
};

const identityAddon = (overrides: Partial<AddonRecord> = {}): AddonRecord => ({
  key: "queue-private-token",
  manifestUrl: "https://travel.example/manifest.json?token=addon-secret",
  role: "source",
  enabled: true,
  globalSearch: true,
  allowedUsers: [QUEUE_OWNER],
  addedAt: "2026-01-01T00:00:00.000Z",
  downloadSettings: defaultDownloadSettings(),
  manifest: {
    id: "travel",
    name: "Travel fixture",
    version: "1",
    resources: ["stream"],
  },
  ...overrides,
});

const selectedTravel = (
  url: string,
  title = "Film",
  streamAddonIdentity = "a".repeat(64),
): SelectedTravel => ({
  status: "selected",
  stream: {
    url,
    addonKey: "queue-private-token",
    addonName: "Travel fixture",
    name: `${title}.mp4`,
    behaviorHints: { filename: `${title}.mp4`, videoSize: 1 },
  },
  resolution: { checkedCandidates: 1, audioLanguage: "en", audioEvidence: "probe" },
  settings: defaultDownloadSettings(),
  streamAddonIdentity,
  searchStatus: "complete",
  retryable: false,
  observations: emptyObservations,
});

const selectedProviderPriority = (
  stream: string | StreamItem,
  options: Partial<Pick<
    SelectedProviderPriority,
    "streamAddonIdentity" | "subtitle" | "subtitleAddonIdentity" | "resolution"
  >> = {},
): SelectedProviderPriority => ({
  status: "selected",
  stream: typeof stream === "string"
    ? {
      url: stream,
      addonKey: "queue-private-token",
      addonName: "Travel fixture",
      name: "Film.mp4",
      behaviorHints: { filename: "Film.mp4", videoSize: 1 },
    }
    : stream,
  resolution: options.resolution ?? { checkedCandidates: 1, audioLanguage: "en", audioEvidence: "probe" },
  settings: defaultDownloadSettings(),
  streamAddonIdentity: options.streamAddonIdentity ?? "a".repeat(64),
  ...(options.subtitle === undefined ? {} : { subtitle: options.subtitle }),
  ...(options.subtitleAddonIdentity === undefined ? {} : { subtitleAddonIdentity: options.subtitleAddonIdentity }),
  searchStatus: "complete",
});

const selectedRules = (url: string): RulesProfileResolution => ({
  status: "selected",
  stream: {
    url,
    addonKey: "queue-private-token",
    addonName: "Rules fixture",
    name: "Film.mp4",
    behaviorHints: { filename: "Film.mp4", videoSize: 1 },
  },
  resolution: { checkedCandidates: 1, audioLanguage: "en", audioEvidence: "probe" },
  settings: defaultDownloadSettings(),
  streamAddonIdentity: "a".repeat(64),
  searchStatus: "complete",
  retryable: false,
  observations: emptyObservations,
});

test("a stored Travel variant runs through the Travel resolver", async () => {
  const { directory, data, downloads } = await setup();
  const source = await countingServer();
  const queue = openQueue(data, downloads);
  let resolverCalls = 0;
  queue.setTravelResolver(async () => {
    resolverCalls += 1;
    return selectedTravel(source.url);
  });
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-stored-travel", selection: selection("queue-private-token") },
      { kind: "movie", title: "Film" },
      QUEUE_OWNER,
      undefined,
      storedTravelSnapshot(),
    );
    assert.ok(added);
    await waitFor(queue, () => queue.get(added.id)?.status === "completed");
    assert.equal(resolverCalls, 1);
  } finally {
    await queue.stop();
    source.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an old Travel queue snapshot without a template still loads and runs", async () => {
  const { directory, data, downloads, state } = await setup();
  const source = await countingServer();
  const snapshot = structuredClone(storedTravelSnapshot(SOURCE_PROFILE_IDS.travel)) as unknown as {
    profile: { template?: string };
  };
  delete snapshot.profile.template;
  await writeFile(state, JSON.stringify([{
    ...rawLazyJob(snapshot),
    id: "old-travel-snapshot",
    source: {
      type: "movie",
      videoId: "tt-old-travel",
      tried: [],
      selection: selection("queue-private-token"),
    },
  }]));
  const queue = openQueue(data, downloads);
  let resolverCalls = 0;
  queue.setTravelResolver(async () => {
    resolverCalls += 1;
    return selectedTravel(source.url);
  });
  try {
    await queue.load();
    await waitFor(queue, () => queue.get("old-travel-snapshot")?.status === "completed");
    assert.equal(resolverCalls, 1);
  } finally {
    await queue.stop();
    source.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a completed Travel job migrates its legacy identity without resolving again after restart", async () => {
  const { directory, data, downloads, state } = await setup();
  const source = await countingServer();
  const first = openQueue(data, downloads);
  let completions = 0;
  first.onCompleted = () => { completions += 1; };
  first.setTravelResolver(async () => selectedTravel(source.url));
  await first.load();
  try {
    const added = await first.addPending(
      "Film",
      { type: "movie", videoId: "tt-completed-restart", selection: selection("queue-private-token") },
      { kind: "movie", title: "Film" },
      QUEUE_OWNER,
      undefined,
      travelSnapshot(),
    );
    assert.ok(added);
    await waitFor(first, () => first.get(added.id)?.status === "completed");
    await first.stop();
    const completed = first.get(added.id)!;
    const target = path.join(downloads, relativeWithin(LIBRARY_ID, completed.target));
    const before = await stat(target);
    const requests = source.requests();
    const legacy = await readJobs(state);
    const completedRow = legacy.find((job) => job.id === added.id)!;
    assert.equal(completedRow.sourceStreamAddonIdentity, "a".repeat(64));
    completedRow.travelStreamAddonIdentity = completedRow.sourceStreamAddonIdentity;
    delete completedRow.sourceStreamAddonIdentity;
    completedRow.subtitle = { url: "http://127.0.0.1/subtitle.vtt", addonKey: "subtitle-provider", name: "Film.cs.vtt" };
    completedRow.travelSubtitleAddonIdentity = "b".repeat(64);
    await writeFile(state, JSON.stringify(legacy, null, 2));

    const reopened = openQueue(data, downloads, { ownerAllowed: () => false });
    reopened.onCompleted = () => { completions += 1; };
    try {
      await reopened.load();
      const restored = reopened.get(added.id)!;
      assert.equal(restored.status, "completed");
      assert.equal(restored.completedAt, completed.completedAt);
      assert.equal(restored.updatedAt, completed.updatedAt);
      assert.equal(restored.target, completed.target);
      assert.equal(restored.libraryId, completed.libraryId);
      assert.equal(restored.received, 1);
      assert.equal(restored.total, 1);
      assert.equal(restored.error, undefined);
      assert.equal(reopened.history().length, 1);
      assert.equal(completions, 1, "restart does not emit completion again");
      assert.equal(source.requests(), requests, "restart does not request the source again");
      assert.deepEqual(internalJobs(reopened)[0]?.sourceAdmission, travelSnapshot());
      assert.equal(internalJobs(reopened)[0]?.sourceStreamAddonIdentity, "a".repeat(64));
      assert.equal(internalJobs(reopened)[0]?.sourceSubtitleAddonIdentity, "b".repeat(64));
      assertPublicViewIsClean(restored as unknown as Record<string, unknown>);
      const stored = (await readJobs(state)).find((job) => job.id === added.id)!;
      assert.equal(stored.sourceStreamAddonIdentity, "a".repeat(64));
      assert.equal(stored.sourceSubtitleAddonIdentity, "b".repeat(64));
      assert.equal(Object.hasOwn(stored, "travelStreamAddonIdentity"), false);
      assert.equal(Object.hasOwn(stored, "travelSubtitleAddonIdentity"), false);
      assert.equal(await readFile(target, "utf8"), "x");
      assert.equal((await stat(target)).mtimeMs, before.mtimeMs);
    } finally {
      await reopened.stop();
    }
  } finally {
    await first.stop();
    source.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a lazy job durably stores a detached materialized Travel snapshot without exposing it", async () => {
  const { directory, data, downloads, state } = await setup();
  const queue = openQueue(data, downloads);
  let resolutions = 0;
  queue.setResolver(async () => {
    resolutions += 1;
    return undefined;
  });
  await queue.load();
  try {
    const submitted = travelSnapshot();
    const canonical = structuredClone(submitted);
    const returned = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt0000001" },
      undefined,
      "usr_00000001",
      { followId: "follow-1", episodeKey: "movie", intent: "download" },
      submitted,
    );
    assert.ok(returned);
    await waitFor(queue, () => queue.get(returned.id)?.status === "failed");

    submitted.profile.revision = 99;
    submitted.providerKeys.reverse();
    submitted.policy.constraints.audio.preferred = { code: "de" };
    const providerOrder = submitted.policy.criteria.find((criterion) => criterion.kind === "providerOrder");
    if (providerOrder && "keys" in providerOrder) providerOrder.keys.length = 0;

    assertPublicViewIsClean(returned as unknown as Record<string, unknown>);
    for (const view of [queue.get(returned.id)!, queue.list()[0]!, queue.followJobs()[0]!]) {
      assertPublicViewIsClean(view as unknown as Record<string, unknown>);
      assert.doesNotMatch(JSON.stringify(view), /queue-private-token/);
    }
    assert.deepEqual(internalJobs(queue)[0]?.sourceAdmission, canonical);
    assert.equal(resolutions, 0, "the legacy resolver is never called for a snapshot-bearing job");

    await queue.stop();
    const stored = (await readJobs(state)).find((job) => job.id === returned.id)!;
    assert.deepEqual(stored.sourceAdmission, canonical);
    assert.equal(canonical.profile.id, SOURCE_PROFILE_IDS.travel);
    assert.equal(canonical.profile.revision, 1);
    assert.deepEqual(canonical.providerKeys, [PROVIDER_TWO, PROVIDER_ONE]);
    assert.deepEqual(
      canonical.policy.criteria.find((criterion) => criterion.kind === "providerOrder"),
      { kind: "providerOrder", keys: [PROVIDER_TWO, PROVIDER_ONE] },
    );
    assert.deepEqual(canonical.policy.constraints.audio.preferred, { code: "en" });
    assert.deepEqual(canonical.policy.constraints.subtitles.preferred, { code: "cs" });
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a canonical Travel cursor is saved, hidden, and restored with its snapshot", async () => {
  const { directory, data, downloads, state } = await setup();
  let releasePermission!: (allowed: boolean) => void;
  const permission = new Promise<boolean>((resolve) => { releasePermission = resolve; });
  let resolutions = 0;
  const queue = openQueue(data, downloads, { ownerAllowed: () => permission });
  queue.setResolver(async () => {
    resolutions += 1;
    return undefined;
  });
  await queue.load();
  let id = "";
  try {
    const added = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt0000007" },
      undefined,
      "usr_00000007",
      { followId: "follow-cursor", episodeKey: "movie", intent: "download" },
      travelSnapshot(),
    );
    assert.ok(added);
    id = added.id;
    await waitFor(queue, () => queue.get(id)?.status === "checking");

    const submitted = travelCursor();
    await queue.setTravelCursor(id, submitted);
    (submitted as unknown as { rejectedIndices: number[] }).rejectedIndices = [99];
    (submitted as unknown as { nextIndex: number }).nextIndex = 99;
    assert.deepEqual(internalJobs(queue)[0]?.travelCursor, travelCursor());

    for (const view of [queue.get(id)!, queue.list()[0]!, queue.snapshot().jobs[0]!, queue.followJobs()[0]!]) {
      assertPublicViewIsClean(view as unknown as Record<string, unknown>);
    }
    let stored = (await readJobs(state)).find((job) => job.id === id)!;
    assert.deepEqual(stored.travelCursor, travelCursor());
    await queue.setTravelCursor(id, undefined);
    assert.equal(Object.hasOwn(internalJobs(queue)[0]!, "travelCursor"), false);
    stored = (await readJobs(state)).find((job) => job.id === id)!;
    assert.equal(Object.hasOwn(stored, "travelCursor"), false);
    await queue.setTravelCursor(id, travelCursor());

    await assert.rejects(
      queue.setTravelCursor(id, { ...travelCursor(), rejectedIndices: [1, 1] }),
      TravelVerificationError,
    );
    assert.deepEqual(internalJobs(queue)[0]?.travelCursor, travelCursor());
    stored = (await readJobs(state)).find((job) => job.id === id)!;
    assert.deepEqual(stored.travelCursor, travelCursor());

    releasePermission(true);
    await waitFor(queue, () => queue.get(id)?.status === "failed");
    assert.equal(resolutions, 0, "the snapshot remains fail-closed with a cursor present");
    await assert.rejects(queue.setTravelCursor(id, travelCursor()), /queued Travel snapshot job/);
  } finally {
    releasePermission(true);
    await queue.stop();
  }

  const reopened = openQueue(data, downloads);
  reopened.setResolver(async () => {
    resolutions += 1;
    return undefined;
  });
  try {
    await reopened.load();
    await waitFor(reopened, () => reopened.get(id)?.status === "failed");
    assert.deepEqual(internalJobs(reopened)[0]?.travelCursor, travelCursor());
    assertPublicViewIsClean(reopened.get(id)! as unknown as Record<string, unknown>);
    assert.equal(resolutions, 0, "reload never dispatches a resolver for a snapshot job");
  } finally {
    await reopened.stop();
    const stored = (await readJobs(state)).find((job) => job.id === id)!;
    assert.deepEqual(stored.travelCursor, travelCursor());
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed or misplaced Travel cursors make the queue unreadable without changing its bytes", async () => {
  const validSnapshot = travelSnapshot();
  const validNonTravelSnapshot = nonTravelSnapshot();
  const cases: Array<{ name: string; admission?: unknown; cursor: unknown; stream?: unknown; budgetAttempts?: unknown }> = [
    { name: "malformed cursor", admission: validSnapshot, cursor: { ...travelCursor(), extra: true } },
    { name: "legacy job", cursor: travelCursor() },
    { name: "non-Travel snapshot", admission: validNonTravelSnapshot, cursor: travelCursor() },
    { name: "Provider priority snapshot", admission: providerPrioritySnapshot(), cursor: travelCursor() },
    { name: "selected stream", admission: validSnapshot, cursor: travelCursor(), stream: { url: "http://127.0.0.1/private" } },
    {
      name: "budget attempts over limit",
      admission: validSnapshot,
      cursor: travelCursor(),
      budgetAttempts: TRAVEL_BUDGET_ATTEMPT_LIMIT + 1,
    },
  ];

  for (const entry of cases) {
    const { directory, data, downloads, state } = await setup();
    const bytes = JSON.stringify([{
      ...rawLazyJob(entry.admission),
      ...(entry.stream === undefined ? {} : { stream: entry.stream }),
      travelCursor: entry.cursor,
      ...(entry.budgetAttempts === undefined ? {} : { travelBudgetAttempts: entry.budgetAttempts }),
    }], null, 2);
    await writeFile(state, bytes);
    let resolutions = 0;
    const queue = openQueue(data, downloads);
    queue.setResolver(async () => {
      resolutions += 1;
      return undefined;
    });
    try {
      await queue.load();
      assert.deepEqual(queue.list(), [], entry.name);
      assert.equal(await readFile(state, "utf8"), bytes, `${entry.name} leaves the queue bytes intact`);
      assert.equal((await readdir(data)).some((name) => name.startsWith("downloads.json.damaged-")), false);
      assert.equal(resolutions, 0, `${entry.name} starts no resolver work`);
      await assert.rejects(
        queue.addPending("Other", { type: "movie", videoId: "tt0000008" }),
        (error: AppError) => error.messageKey === "err.queueUnreadable" && error.status === 503,
      );
      assert.equal(await readFile(state, "utf8"), bytes, `${entry.name} refuses new work without writing`);
    } finally {
      await queue.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("malformed or misplaced Travel addon identities make the queue unreadable without rewriting", async () => {
  const validSnapshot = travelSnapshot();
  const validNonTravelSnapshot = nonTravelSnapshot();
  const stream = {
    url: "http://127.0.0.1/private.mp4",
    addonKey: "queue-private-token",
    name: "Film.mp4",
  };
  const cases: Array<Record<string, unknown>> = [
    { snapshot: validSnapshot, stream, identity: "not-a-hash" },
    { snapshot: validSnapshot, identity: identityAddon() },
    { snapshot: validNonTravelSnapshot, stream, identity: "a".repeat(64) },
    {
      snapshot: validSnapshot,
      stream,
      identity: "a".repeat(64),
      subtitle: { addonKey: "subtitle-provider", url: "http://127.0.0.1/subtitle.srt" },
    },
    {
      snapshot: validSnapshot,
      stream,
      identity: "a".repeat(64),
      subtitle: { url: "http://127.0.0.1/subtitle.srt" },
      subtitleIdentity: "b".repeat(64),
    },
    {
      snapshot: validSnapshot,
      stream: { url: "http://127.0.0.1/private.mp4" },
      identity: "a".repeat(64),
    },
  ];

  for (const [index, entry] of cases.entries()) {
    const { directory, data, downloads, state } = await setup();
    const bytes = JSON.stringify([{
      ...rawLazyJob(entry.snapshot),
      ...(entry.stream === undefined ? {} : { stream: entry.stream }),
      ...(entry.subtitle === undefined ? {} : { subtitle: entry.subtitle }),
      ...(entry.identity === undefined ? {} : { sourceStreamAddonIdentity: entry.identity }),
      ...(entry.subtitleIdentity === undefined ? {} : { sourceSubtitleAddonIdentity: entry.subtitleIdentity }),
    }], null, 2);
    await writeFile(state, bytes);
    let resolutions = 0;
    const queue = openQueue(data, downloads);
    queue.setTravelResolver(async () => {
      resolutions += 1;
      return { status: "noMatch", retryable: false, observations: emptyObservations };
    });
    try {
      await queue.load();
      assert.deepEqual(queue.list(), [], `identity case ${index}`);
      assert.equal(await readFile(state, "utf8"), bytes, `identity case ${index} leaves bytes intact`);
      assert.equal((await readdir(data)).some((name) => name.startsWith("downloads.json.damaged-")), false);
      assert.equal(resolutions, 0);
      await assert.rejects(
        queue.addPending("Other", { type: "movie", videoId: `tt-identity-${index}` }),
        (error: AppError) => error.messageKey === "err.queueUnreadable" && error.status === 503,
      );
    } finally {
      await queue.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("records carrying canonical and legacy private spellings are refused as ambiguous without rewriting", async () => {
  const stream = {
    url: "http://127.0.0.1/private.mp4",
    addonKey: "queue-private-token",
    name: "Film.mp4",
  };
  const subtitle = { addonKey: "subtitle-provider", url: "http://127.0.0.1/subtitle.srt" };
  const cases: Array<{ name: string; fields: Record<string, unknown> }> = [
    {
      name: "stream identity",
      fields: { stream, sourceStreamAddonIdentity: "a".repeat(64), travelStreamAddonIdentity: "a".repeat(64) },
    },
    {
      name: "subtitle identity",
      fields: {
        stream,
        subtitle,
        sourceStreamAddonIdentity: "a".repeat(64),
        sourceSubtitleAddonIdentity: "b".repeat(64),
        travelSubtitleAddonIdentity: "b".repeat(64),
      },
    },
    {
      name: "source fallback",
      fields: { sourceFallbackAttempts: 2, travelSourceFallbackAttempts: 2 },
    },
  ];

  for (const [index, entry] of cases.entries()) {
    const { directory, data, downloads, state } = await setup();
    const bytes = JSON.stringify([{ ...rawLazyJob(travelSnapshot()), ...entry.fields }], null, 2);
    await writeFile(state, bytes);
    const queue = openQueue(data, downloads);
    try {
      await queue.load();
      assert.deepEqual(queue.list(), [], entry.name);
      assert.equal(await readFile(state, "utf8"), bytes, `${entry.name} leaves the queue bytes intact`);
      await assert.rejects(
        queue.addPending("Other", { type: "movie", videoId: `tt-ambiguous-${index}` }),
        (error: AppError) => error.messageKey === "err.queueUnreadable" && error.status === 503,
      );
    } finally {
      await queue.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("malformed legacy private values remain unreadable without rewriting", async () => {
  const stream = {
    url: "http://127.0.0.1/private.mp4",
    addonKey: "queue-private-token",
    name: "Film.mp4",
  };
  const subtitle = { addonKey: "subtitle-provider", url: "http://127.0.0.1/subtitle.srt" };
  const cases: Array<{ name: string; fields: Record<string, unknown> }> = [
    { name: "stream identity", fields: { stream, travelStreamAddonIdentity: "not-a-hash" } },
    {
      name: "subtitle identity",
      fields: {
        stream,
        subtitle,
        sourceStreamAddonIdentity: "a".repeat(64),
        travelSubtitleAddonIdentity: "not-a-hash",
      },
    },
    { name: "source fallback", fields: { travelSourceFallbackAttempts: SOURCE_FALLBACK_ATTEMPT_LIMIT + 1 } },
  ];

  for (const [index, entry] of cases.entries()) {
    const { directory, data, downloads, state } = await setup();
    const bytes = JSON.stringify([{ ...rawLazyJob(travelSnapshot()), ...entry.fields }], null, 2);
    await writeFile(state, bytes);
    const queue = openQueue(data, downloads);
    try {
      await queue.load();
      assert.deepEqual(queue.list(), [], entry.name);
      assert.equal(await readFile(state, "utf8"), bytes, `${entry.name} leaves the queue bytes intact`);
      await assert.rejects(
        queue.addPending("Other", { type: "movie", videoId: `tt-malformed-legacy-${index}` }),
        (error: AppError) => error.messageKey === "err.queueUnreadable" && error.status === 503,
      );
    } finally {
      await queue.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("Provider priority state refuses Travel-only legacy field aliases", async () => {
  const stream = {
    url: "http://127.0.0.1/private.mp4",
    addonKey: "queue-private-token",
    name: "Film.mp4",
  };
  for (const fields of [
    { stream, travelStreamAddonIdentity: "a".repeat(64) },
    { travelSourceFallbackAttempts: 1 },
  ]) {
    const { directory, data, downloads, state } = await setup();
    const bytes = JSON.stringify([{ ...rawLazyJob(providerPrioritySnapshot()), ...fields }], null, 2);
    await writeFile(state, bytes);
    const queue = openQueue(data, downloads);
    try {
      await queue.load();
      assert.deepEqual(queue.list(), []);
      assert.equal(await readFile(state, "utf8"), bytes);
      await assert.rejects(
        queue.addPending("Other", { type: "movie", videoId: "tt-provider-legacy-alias" }),
        (error: AppError) => error.messageKey === "err.queueUnreadable" && error.status === 503,
      );
    } finally {
      await queue.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("an explicit retry clears a Travel cursor while passive snapshot failure retains it", async () => {
  const { directory, data, downloads, state } = await setup();
  await writeFile(state, JSON.stringify([{
    ...rawLazyJob(travelSnapshot()),
    travelCursor: travelCursor(),
  }], null, 2));
  let resolutions = 0;
  const queue = openQueue(data, downloads);
  queue.setResolver(async () => {
    resolutions += 1;
    return undefined;
  });
  try {
    await queue.load();
    await waitFor(queue, () => queue.get("job-source-admission")?.status === "failed");
    assert.deepEqual(internalJobs(queue)[0]?.travelCursor, travelCursor());

    await queue.retry("job-source-admission");
    assert.equal(internalJobs(queue)[0]?.travelCursor, undefined);
    await waitFor(queue, () => queue.get("job-source-admission")?.status === "failed");
    assert.equal(resolutions, 0, "retrying a snapshot job still never reaches the legacy resolver");

    await queue.stop();
    const stored = (await readJobs(state)).find((job) => job.id === "job-source-admission")!;
    assert.equal(Object.hasOwn(stored, "travelCursor"), false);
    assert.deepEqual(stored.sourceAdmission, travelSnapshot());
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a valid snapshot survives restart and retry without accepting a legacy selection", async () => {
  const { directory, data, downloads, state } = await setup();
  const snapshot = travelSnapshot();
  const admitted = structuredClone(snapshot);
  const originalSelection = selection("addon:admitted");
  let resolutions = 0;
  const first = openQueue(data, downloads);
  first.setResolver(async () => {
    resolutions += 1;
    return undefined;
  });
  await first.load();
  let id = "";
  try {
    const job = await first.addPending(
      "Film",
      { type: "movie", videoId: "tt0000002", selection: originalSelection },
      undefined,
      undefined,
      undefined,
      snapshot,
    );
    assert.ok(job);
    id = job.id;
    await waitFor(first, () => first.get(id)?.status === "failed");
  } finally {
    await first.stop();
  }

  const reopened = openQueue(data, downloads);
  reopened.setResolver(async () => {
    resolutions += 1;
    return undefined;
  });
  try {
    await reopened.load();
    await waitFor(reopened, () => reopened.get(id)?.status === "failed");
    assert.deepEqual(internalJobs(reopened)[0]?.sourceAdmission, admitted);
    assert.deepEqual(internalJobs(reopened)[0]?.source?.selection, originalSelection);

    await reopened.retry(id, selection("addon:replacement"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await waitFor(reopened, () => reopened.get(id)?.status === "failed");
    assert.deepEqual(internalJobs(reopened)[0]?.sourceAdmission, admitted);
    assert.deepEqual(internalJobs(reopened)[0]?.source?.selection, originalSelection);
    assert.equal(resolutions, 0, "neither the first attempt nor the retry calls the legacy resolver");

    await reopened.stop();
    const stored = (await readJobs(state)).find((job) => job.id === id)!;
    assert.deepEqual(stored.sourceAdmission, admitted);
    assert.deepEqual((stored.source as { selection?: unknown }).selection, originalSelection);
  } finally {
    await reopened.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a restored snapshot without a Travel resolver fails closed without transferring its stream", async () => {
  const { directory, data, downloads, state } = await setup();
  const snapshot = travelSnapshot();
  const { server, url, requests } = await countingServer();
  const storedJob = {
    ...rawLazyJob(snapshot),
    stream: { url, name: "Film.mp4" },
    target: `${LIBRARY_ID}/Film/Film.mp4`,
    libraryId: LIBRARY_ID,
  };
  await writeFile(state, JSON.stringify([storedJob], null, 2));
  let resolutions = 0;
  const queue = openQueue(data, downloads);
  queue.setResolver(async () => {
    resolutions += 1;
    return undefined;
  });
  try {
    await queue.load();
    await waitFor(queue, () => queue.get("job-source-admission")?.status === "failed");
    assert.equal(requests(), 0, "no byte or header request reaches the preselected stream");
    assert.equal(resolutions, 0);
    assert.deepEqual(internalJobs(queue)[0]?.sourceAdmission, snapshot);
    assert.equal(internalJobs(queue)[0]?.stream, undefined, "the saved selection is discarded before dispatch");
    const view = queue.get("job-source-admission")!;
    assert.equal(view.errorKey, "err.noMatchingSource");
    assert.doesNotMatch(JSON.stringify(view), /queue-private-token/);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Travel budget makes progress past four exhausted attempts without using the temporary-failure limit", async () => {
  const { directory, data, downloads, state } = await setup();
  let clock = 10_000;
  const queue = openQueue(data, downloads, {
    now: () => clock,
    retryDelay: () => 250,
  });
  let legacyResolutions = 0;
  const inputs: Array<{ cursor?: TravelContinuationCursorV1 }> = [];
  queue.setResolver(async () => {
    legacyResolutions += 1;
    return undefined;
  });
  queue.setTravelResolver(async (input) => {
    inputs.push({ ...(input.cursor === undefined ? {} : { cursor: input.cursor }) });
    if (inputs.length === 1) {
      return {
        status: "temporaryFailure",
        retryable: true,
        observations: { ...emptyObservations, temporaryFailures: 1 },
        cursor: travelCursor(1, [0]),
      };
    }
    if (inputs.length <= 5) {
      const nextIndex = inputs.length;
      return {
        status: "budgetExhausted",
        retryable: true,
        observations: { ...emptyObservations, probesUsed: 15 },
        cursor: travelCursor(nextIndex, Array.from({ length: nextIndex - 1 }, (_entry, index) => index)),
      };
    }
    return { status: "noMatch", retryable: false, observations: emptyObservations };
  });
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      { type: "series", videoId: "tt-budget" },
      { kind: "episode", title: "Show", season: 1, episode: 1 },
      "usr_00000011",
      undefined,
      travelSnapshot(),
    );
    assert.ok(added);

    await waitFor(queue, () => internalJobs(queue)[0]?.travelCursor?.nextIndex === 1);
    assert.equal(internalJobs(queue)[0]?.travelTemporaryFailures, 1);
    assert.equal(internalJobs(queue)[0]?.notBefore, 10_250);
    let stored!: Record<string, unknown>;
    await waitFor(queue, async () => {
      stored = (await readJobs(state)).find((entry) => entry.id === added.id)!;
      return (stored?.travelCursor as TravelContinuationCursorV1 | undefined)?.nextIndex === 1;
    });
    assert.equal(stored.travelTemporaryFailures, 1);
    assert.equal(stored.notBefore, 10_250);

    clock = 10_250;
    queue.changed();
    for (let nextIndex = 2; nextIndex <= 5; nextIndex += 1) {
      await waitFor(queue, () => internalJobs(queue)[0]?.travelCursor?.nextIndex === nextIndex);
      const job = internalJobs(queue)[0]!;
      assert.equal(job.status, "queued");
      assert.equal(job.travelTemporaryFailures, undefined, "budget progress resets temporary failures");
      assert.equal(job.travelBudgetAttempts, nextIndex - 1);
      assert.equal(job.retryCount, undefined, "source inspection does not spend a transfer retry");
      assert.equal(job.notBefore, clock + 250);
      await waitFor(queue, async () => {
        stored = (await readJobs(state)).find((entry) => entry.id === added.id)!;
        return (stored.travelCursor as TravelContinuationCursorV1 | undefined)?.nextIndex === nextIndex;
      });
      assert.deepEqual(stored.travelCursor, job.travelCursor);
      assert.equal(Object.hasOwn(stored, "travelTemporaryFailures"), false);
      assert.equal(stored.travelBudgetAttempts, nextIndex - 1);
      assert.equal(inputs.length, nextIndex);
      await new Promise((resolve) => setTimeout(resolve, 15));
      assert.equal(inputs.length, nextIndex, "the retry does not run before notBefore");
      clock += 250;
      queue.changed();
    }

    await waitFor(queue, () => queue.get(added.id)?.status === "failed");
    assert.equal(inputs.length, 6);
    assert.deepEqual(inputs[1]?.cursor, travelCursor(1, [0]));
    assert.deepEqual(inputs[5]?.cursor, travelCursor(5, [0, 1, 2, 3]));
    assert.equal(queue.get(added.id)?.errorKey, "err.noMatchingSource");
    assert.equal(internalJobs(queue)[0]?.travelBudgetAttempts, undefined);
    assert.equal(legacyResolutions, 0);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a persisted Travel budget count at its limit fails before scheduling another attempt", async () => {
  const { directory, data, downloads, state } = await setup();
  await writeFile(state, JSON.stringify([{
    ...rawLazyJob(travelSnapshot()),
    ownerUserId: "usr_00000020",
    travelCursor: travelCursor(5, [0, 1, 2, 3]),
    travelBudgetAttempts: TRAVEL_BUDGET_ATTEMPT_LIMIT,
  }], null, 2));
  let calls = 0;
  let legacyResolutions = 0;
  const queue = openQueue(data, downloads);
  queue.setResolver(async () => {
    legacyResolutions += 1;
    return undefined;
  });
  queue.setTravelResolver(async (input) => {
    calls += 1;
    assert.equal(input.cursor?.nextIndex, 5);
    return {
      status: "budgetExhausted",
      retryable: true,
      observations: { ...emptyObservations, probesUsed: 15 },
      cursor: travelCursor(6, [0, 1, 2, 3, 4]),
    };
  });
  try {
    await queue.load();
    await waitFor(queue, () => queue.get("job-source-admission")?.status === "failed");
    assert.equal(calls, 1);
    assert.equal(queue.get("job-source-admission")?.errorKey, "err.noMatchingSource");
    assert.equal(internalJobs(queue)[0]?.travelCursor, undefined);
    assert.equal(internalJobs(queue)[0]?.travelBudgetAttempts, undefined);
    assert.equal(internalJobs(queue)[0]?.notBefore, undefined);
    assertPublicViewIsClean(queue.get("job-source-admission")! as unknown as Record<string, unknown>);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls, 1, "the final budget outcome schedules no further attempt");
    const stored = (await readJobs(state)).find((entry) => entry.id === "job-source-admission")!;
    assert.equal(stored.status, "failed");
    assert.equal(Object.hasOwn(stored, "travelCursor"), false);
    assert.equal(Object.hasOwn(stored, "travelBudgetAttempts"), false);
    assert.equal(Object.hasOwn(stored, "notBefore"), false);
    assert.equal(legacyResolutions, 0);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("repeated Travel temporary failures remain finite and use bounded delays", async () => {
  const { directory, data, downloads } = await setup();
  let clock = 20_000;
  let calls = 0;
  const queue = openQueue(data, downloads, {
    now: () => clock,
    retryDelay: () => 100,
  });
  queue.setTravelResolver(async () => {
    calls += 1;
    return {
      status: "temporaryFailure",
      retryable: true,
      observations: { ...emptyObservations, temporaryFailures: 1 },
      cursor: travelCursor(calls, Array.from({ length: calls }, (_entry, index) => index)),
    };
  });
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      { type: "series", videoId: "tt-temporary-budget" },
      { kind: "episode", title: "Show", season: 1, episode: 1 },
      "usr_00000019",
      undefined,
      travelSnapshot(),
    );
    assert.ok(added);
    for (let failures = 1; failures <= 3; failures += 1) {
      await waitFor(queue, () => internalJobs(queue)[0]?.travelTemporaryFailures === failures);
      assert.equal(internalJobs(queue)[0]?.status, "queued");
      assert.equal(internalJobs(queue)[0]?.travelBudgetAttempts, undefined);
      assert.equal(internalJobs(queue)[0]?.notBefore, clock + 100);
      clock += 100;
      queue.changed();
    }
    await waitFor(queue, () => queue.get(added.id)?.status === "failed");
    assert.equal(calls, 4);
    assert.equal(queue.get(added.id)?.errorKey, "err.noMatchingSource");
    assert.equal(internalJobs(queue)[0]?.travelCursor, undefined);
    assert.equal(internalJobs(queue)[0]?.travelTemporaryFailures, undefined);
    assert.equal(internalJobs(queue)[0]?.retryCount, undefined);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Travel no-match fails while denied or cancelled work stops without staying active", async () => {
  for (const status of ["noMatch", "accessDenied", "cancelled"] as const) {
    const { directory, data, downloads } = await setup();
    let legacyResolutions = 0;
    const queue = openQueue(data, downloads);
    queue.setResolver(async () => {
      legacyResolutions += 1;
      return undefined;
    });
    queue.setTravelResolver(async () => status === "noMatch"
      ? { status: "noMatch", retryable: false, observations: emptyObservations }
      : { status, retryable: false, observations: emptyObservations });
    await queue.load();
    try {
      const added = await queue.addPending(
        status,
        { type: "series", videoId: `tt-${status}` },
        { kind: "episode", title: "Show", season: 1, episode: 1 },
        "usr_00000012",
        undefined,
        travelSnapshot(),
      );
      assert.ok(added);
      await waitFor(queue, () => {
        const job = queue.get(added.id);
        return status === "noMatch" ? job?.status === "failed" : job?.status === "paused";
      });
      const view = queue.get(added.id)!;
      if (status === "noMatch") {
        assert.equal(view.status, "failed");
        assert.equal(view.errorKey, "err.noMatchingSource");
      } else {
        assert.equal(view.status, "paused");
        assert.equal(view.pauseReason, "permission");
      }
      assert.equal(view.retryCount, undefined);
      assert.equal(legacyResolutions, 0);
    } finally {
      await queue.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("Travel rejects non-HTTP and torrent selections before opening bytes", async () => {
  const { server, url, requests } = await countingServer();
  const cases: Array<{ name: string; selected: SelectedTravel }> = [
    { name: "file URL", selected: selectedTravel("file:///tmp/private-travel.mp4") },
    { name: "empty URL", selected: selectedTravel("") },
    {
      name: "torrent hash",
      selected: {
        ...selectedTravel(url),
        stream: { ...selectedTravel(url).stream, infoHash: "a".repeat(40) },
      },
    },
  ];
  try {
    for (const entry of cases) {
      const { directory, data, downloads } = await setup();
      let legacyResolutions = 0;
      const queue = openQueue(data, downloads);
      queue.setResolver(async () => {
        legacyResolutions += 1;
        return undefined;
      });
      queue.setTravelResolver(async () => entry.selected);
      await queue.load();
      try {
        const added = await queue.addPending(
          entry.name,
          {
            type: "movie",
            videoId: `tt-invalid-${entry.name}`,
            selection: selection("addon:queue-private-token"),
          },
          { kind: "movie", title: entry.name },
          "usr_00000018",
          undefined,
          travelSnapshot(),
        );
        assert.ok(added);
        await waitFor(queue, () => queue.get(added.id)?.status === "failed");
        assert.equal(queue.get(added.id)?.errorKey, "err.noMatchingSource", entry.name);
        assert.equal(internalJobs(queue)[0]?.stream, undefined, entry.name);
        assert.equal(internalJobs(queue)[0]?.target, "", entry.name);
        assert.equal(requests(), 0, `${entry.name} never reaches the transfer path`);
        assert.equal(legacyResolutions, 0, entry.name);
      } finally {
        await queue.stop();
        await rm(directory, { recursive: true, force: true });
      }
    }
  } finally {
    server.close();
  }
});

test("a selected Travel source transfers over HTTP and persists no cursor beside it", async () => {
  const { directory, data, downloads, state } = await setup();
  const { server, url, requests } = await countingServer();
  let overlappingPrivateState = false;
  let legacyResolutions = 0;
  await writeFile(state, JSON.stringify([{
    ...rawLazyJob(travelSnapshot()),
    ownerUserId: "usr_00000013",
    travelCursor: travelCursor(),
    travelBudgetAttempts: 7,
  }], null, 2));
  const queue = openQueue(data, downloads, {
    writeState: async (file, contents) => {
      const jobs = JSON.parse(contents) as Array<Record<string, unknown>>;
      if (jobs.some((job) => job.stream !== undefined && job.travelCursor !== undefined)) {
        overlappingPrivateState = true;
      }
      await writeFile(file, contents);
    },
  });
  queue.setResolver(async () => {
    legacyResolutions += 1;
    return undefined;
  });
  queue.setTravelResolver(async (input) => {
    assert.deepEqual(input.cursor, travelCursor());
    return selectedTravel(url);
  });
  await queue.load();
  try {
    await waitFor(queue, () => queue.get("job-source-admission")?.status === "completed");

    assert.equal(requests(), 1);
    assert.equal(legacyResolutions, 0);
    assert.equal(overlappingPrivateState, false);
    const stored = (await readJobs(state)).find((entry) => entry.id === "job-source-admission")!;
    assert.equal(Object.hasOwn(stored, "travelCursor"), false);
    assert.equal(Object.hasOwn(stored, "travelBudgetAttempts"), false);
    assert.equal(stored.sourceStreamAddonIdentity, "a".repeat(64));
    assert.match(String(stored.sourceStreamAddonIdentity), /^[0-9a-f]{64}$/);
    assert.equal(Object.hasOwn(stored, "sourceSubtitleAddonIdentity"), false);
    assert.equal((stored.stream as { url?: string }).url, url);
    assert.match(String(stored.target), new RegExp(`^${LIBRARY_ID}/Film/Film\\.mp4$`));
    assertPublicViewIsClean(queue.get("job-source-admission")! as unknown as Record<string, unknown>);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unavailable optional subtitle does not pause valid Provider priority or Travel jobs", async () => {
  for (const profile of ["Provider priority", "Travel"] as const) {
    await test(profile, async () => {
      const { directory, data, downloads } = await setup();
      const { server, videoUrl, subtitleUrl } = await missingSubtitleServer();
      const configured = library(downloads);
      const streamAddon = identityAddon();
      const subtitleAddon: AddonRecord = {
        ...identityAddon(),
        key: "subtitle-provider",
        manifestUrl: "https://subtitles.example/manifest.json",
        role: "both",
        manifest: {
          id: "subtitles",
          name: "Subtitles",
          version: "1",
          resources: ["subtitles"],
        },
      };
      const addons = [streamAddon, subtitleAddon];
      const queue = openQueue(data, downloads, {
        ownerAllowed: (job) => ownerMayDownload({ owner: queueOwner, addons, libraries: [configured] }, job),
      });
      const subtitle = { addonKey: subtitleAddon.key, url: subtitleUrl, lang: "cs", name: "Film.cs.vtt" };
      const resolution = {
        checkedCandidates: 1,
        audioLanguage: "en",
        audioEvidence: "probe" as const,
        subtitleLanguage: "cs",
        subtitleSource: "addon" as const,
      };
      if (profile === "Provider priority") {
        queue.setProviderPriorityResolver(async () => selectedProviderPriority(videoUrl, {
          streamAddonIdentity: addonIdentity(streamAddon),
          subtitle,
          subtitleAddonIdentity: addonIdentity(subtitleAddon),
          resolution,
        }));
      } else {
        const selected = selectedTravel(videoUrl, "Film", addonIdentity(streamAddon));
        queue.setTravelResolver(async () => ({
          ...selected,
          subtitle,
          subtitleAddonIdentity: addonIdentity(subtitleAddon),
          resolution,
        }));
      }
      await queue.load();
      try {
        const admission = profile === "Provider priority" ? providerPrioritySnapshot() : travelSnapshot();
        const added = await queue.addPending(
          "Film",
          { type: "movie", videoId: `tt-optional-subtitle-${profile}`, selection: selection("queue-private-token") },
          { kind: "movie", title: "Film" },
          QUEUE_OWNER,
          undefined,
          admission,
        );
        assert.ok(added);
        await waitFor(queue, () => queue.get(added.id)?.status === "completed");

        const job = internalJobs(queue)[0]!;
        assert.equal(job.pauseReason, undefined);
        assert.equal(job.subtitle, undefined);
        assert.equal(job.sourceSubtitleAddonIdentity, undefined);
        const published = path.join(downloads, job.target.slice(LIBRARY_ID.length + 1));
        assert.equal(await readFile(published, "utf8"), "x");
      } finally {
        await queue.stop();
        server.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("the live owner check refuses every effective Travel addon identity loss", () => {
  const configured = library("/tmp/travel-owner-identity");
  const original = identityAddon();
  const job: DownloadJob = {
    id: "identity-owner-check",
    title: "Film",
    ownerUserId: QUEUE_OWNER,
    source: {
      type: "movie",
      videoId: "tt-owner-identity",
      tried: [],
      selection: selection(original.key),
    },
    sourceAdmission: travelSnapshot(),
    stream: {
      url: "http://127.0.0.1/film.mp4",
      addonKey: original.key,
      name: "Film.mp4",
    },
    sourceStreamAddonIdentity: addonIdentity(original),
    targetSettings: defaultDownloadSettings().movie,
    libraryId: configured.id,
    target: `${configured.id}/Film/Film.mp4`,
    status: "downloading",
    received: 0,
    speed: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const allowed = (addons: AddonRecord[]) => ownerMayDownload({
    owner: queueOwner,
    addons,
    libraries: [configured],
  }, job);

  assert.equal(allowed([original]), true);
  const losses: Array<[string, AddonRecord[]]> = [
    ["deleted", []],
    ["disabled", [{ ...original, enabled: false }]],
    ["ungranted", [{ ...original, allowedUsers: [] }]],
    ["catalog-only", [{ ...original, role: "catalog" }]],
    ["stream resource removed", [{ ...original, manifest: { ...original.manifest, resources: [] } }]],
  ];
  for (const [name, addons] of losses) assert.equal(allowed(addons), false, name);
});

test("a Travel stream identity change during transfer pauses without a fallback or published file", async () => {
  for (const change of ["version", "url"] as const) {
    await test(`during transfer: ${change}`, async () => {
      const { directory, data, downloads } = await setup();
      const { server, url, entered, release } = await gatedBodyServer();
      const configured = library(downloads);
      const addons = [identityAddon()];
      const selectedIdentity = addonIdentity(addons[0]!);
      let resolutions = 0;
      const queue = openQueue(data, downloads, {
        ownerAllowed: (job) => ownerMayDownload({
          owner: queueOwner,
          addons,
          libraries: [configured],
        }, job),
      });
      queue.setTravelResolver(async () => {
        resolutions += 1;
        return selectedTravel(url, "Film", selectedIdentity);
      });
      await queue.load();
      try {
        const added = await queue.addPending(
          "Film",
          { type: "movie", videoId: `tt-identity-${change}`, selection: selection("queue-private-token") },
          { kind: "movie", title: "Film" },
          QUEUE_OWNER,
          undefined,
          travelSnapshot(),
        );
        assert.ok(added);
        await entered;
        addons[0] = change === "version"
          ? { ...addons[0]!, manifest: { ...addons[0]!.manifest, version: "2" } }
          : { ...addons[0]!, manifestUrl: "https://travel.example/reconfigured.json" };
        release();

        await waitFor(queue, () => queue.get(added.id)?.status === "paused");
        const job = internalJobs(queue)[0]!;
        assert.equal(job.pauseReason, "permission");
        assert.equal(job.errorKey, "download.pausedNoPermission");
        assert.equal(job.sourceFallbackAttempts, undefined);
        assert.equal(resolutions, 1);
        assert.ok(job.target);
        assert.equal(await fileAbsent(path.join(downloads, job.target.slice(LIBRARY_ID.length + 1))), true);
      } finally {
        await queue.stop();
        server.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("an explicit retry after an identity refusal resolves against the current identity", async () => {
  const { directory, data, downloads, state } = await setup();
  const { server, url, entered, release } = await gatedBodyServer();
  const configured = library(downloads);
  const addons = [identityAddon()];
  const firstIdentity = addonIdentity(addons[0]!);
  let secondIdentity: string | undefined;
  let resolutions = 0;
  const queue = openQueue(data, downloads, {
    ownerAllowed: (job) => ownerMayDownload({ owner: queueOwner, addons, libraries: [configured] }, job),
  });
  queue.setTravelResolver(async () => {
    resolutions += 1;
    return selectedTravel(url, "Film", resolutions === 1 ? firstIdentity : secondIdentity!);
  });
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-retry-current-identity", selection: selection("queue-private-token") },
      { kind: "movie", title: "Film" },
      QUEUE_OWNER,
      undefined,
      travelSnapshot(),
    );
    assert.ok(added);
    await entered;
    addons[0] = { ...addons[0]!, manifest: { ...addons[0]!.manifest, version: "2" } };
    secondIdentity = addonIdentity(addons[0]);
    release();
    await waitFor(queue, () => queue.get(added.id)?.status === "paused");

    await queue.resume(added.id);
    await waitFor(queue, () => queue.get(added.id)?.status === "completed");
    assert.equal(resolutions, 2);
    assert.equal(internalJobs(queue)[0]?.sourceStreamAddonIdentity, secondIdentity);
    const stored = (await readJobs(state)).find((job) => job.id === added.id)!;
    assert.equal(stored.sourceStreamAddonIdentity, secondIdentity);
  } finally {
    release();
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Travel identity change at final publication withdraws the file and spends no fallback", async () => {
  const { directory, data, downloads } = await setup();
  const { server, videoUrl } = await publicationServer();
  const configured = library(downloads);
  const addons = [identityAddon()];
  const selectedIdentity = addonIdentity(addons[0]!);
  const renameEntered = deferred();
  const releaseRename = deferred();
  let resolutions = 0;
  const queue = openQueue(data, downloads, {
    ownerAllowed: (job) => ownerMayDownload({ owner: queueOwner, addons, libraries: [configured] }, job),
    renamePublication: async (from, to) => {
      renameEntered.release();
      await releaseRename.promise;
      await rename(from, to);
    },
  });
  queue.setTravelResolver(async () => {
    resolutions += 1;
    return selectedTravel(videoUrl, "Film", selectedIdentity);
  });
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-final-identity", selection: selection("queue-private-token") },
      { kind: "movie", title: "Film" },
      QUEUE_OWNER,
      undefined,
      travelSnapshot(),
    );
    assert.ok(added);
    await renameEntered.promise;
    const target = internalJobs(queue)[0]!.target;
    assert.ok(target);
    const published = path.join(downloads, target.slice(LIBRARY_ID.length + 1));
    addons[0] = { ...addons[0]!, manifest: { ...addons[0]!.manifest, resources: [] } };
    releaseRename.release();

    await waitFor(queue, async () => queue.get(added.id)?.status === "paused" && await fileAbsent(published));
    assert.equal(queue.get(added.id)?.pauseReason, "permission");
    assert.equal(internalJobs(queue)[0]?.sourceFallbackAttempts, undefined);
    assert.equal(resolutions, 1);
  } finally {
    releaseRename.release();
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a selected subtitle identity change at publication withdraws video and subtitle", async () => {
  const { directory, data, downloads } = await setup();
  const { server, videoUrl, subtitleUrl } = await publicationServer();
  const configured = library(downloads);
  const streamAddon = identityAddon();
  const subtitleAddon: AddonRecord = {
    ...identityAddon(),
    key: "subtitle-provider",
    manifestUrl: "https://subtitles.example/manifest.json",
    role: "both",
    manifest: {
      id: "subtitles",
      name: "Subtitles",
      version: "1",
      resources: ["subtitles"],
    },
  };
  const addons = [streamAddon, subtitleAddon];
  const renameEntered = deferred();
  const releaseRename = deferred();
  let resolutions = 0;
  const queue = openQueue(data, downloads, {
    ownerAllowed: (job) => ownerMayDownload({ owner: queueOwner, addons, libraries: [configured] }, job),
    renamePublication: async (from, to) => {
      renameEntered.release();
      await releaseRename.promise;
      await rename(from, to);
    },
  });
  queue.setTravelResolver(async () => {
    resolutions += 1;
    const selected = selectedTravel(videoUrl, "Film", addonIdentity(streamAddon));
    return {
      ...selected,
      subtitle: { addonKey: subtitleAddon.key, url: subtitleUrl, lang: "cs" },
      subtitleAddonIdentity: addonIdentity(subtitleAddon),
      resolution: {
        ...selected.resolution,
        subtitleLanguage: "cs",
        subtitleSource: "addon",
      },
    };
  });
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-subtitle-identity", selection: selection("queue-private-token") },
      { kind: "movie", title: "Film" },
      QUEUE_OWNER,
      undefined,
      travelSnapshot(),
    );
    assert.ok(added);
    await renameEntered.promise;
    const target = internalJobs(queue)[0]!.target;
    assert.ok(target);
    const published = path.join(downloads, target.slice(LIBRARY_ID.length + 1));
    const publishedSubtitle = path.join(
      path.dirname(published),
      `${path.basename(published, path.extname(published))}.cs.vtt`,
    );
    addons[1] = {
      ...addons[1]!,
      manifest: { ...addons[1]!.manifest, version: "2" },
    };
    releaseRename.release();

    await waitFor(queue, async () =>
      queue.get(added.id)?.status === "paused"
      && await fileAbsent(published)
      && await fileAbsent(publishedSubtitle));
    assert.equal(queue.get(added.id)?.pauseReason, "permission");
    assert.equal(internalJobs(queue)[0]?.sourceFallbackAttempts, undefined);
    assert.equal(resolutions, 1);
  } finally {
    releaseRename.release();
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("revocation during final publication withdraws the Travel file", async () => {
  for (const revocation of ["permission", "removal"] as const) {
    await test(`during rename: ${revocation}`, async () => {
      const { directory, data, downloads } = await setup();
      const { server, videoUrl, subtitleUrl } = await publicationServer();
      let allowed = true;
      const renameEntered = deferred();
      const releaseRename = deferred();
      const queue = openQueue(data, downloads, {
        ownerAllowed: () => allowed,
        renamePublication: async (from, to) => {
          renameEntered.release();
          await releaseRename.promise;
          await rename(from, to);
        },
      });
      queue.setTravelResolver(async () => {
        const selected = selectedTravel(videoUrl);
        return {
          ...selected,
          subtitle: { addonKey: "queue-private-token", url: subtitleUrl, lang: "cs" },
          resolution: {
            ...selected.resolution,
            subtitleLanguage: "cs",
            subtitleSource: "addon",
          },
        };
      });
      await queue.load();
      let remove: Promise<number> | undefined;
      try {
        const added = await queue.addPending(
          "Film",
          {
            type: "movie",
            videoId: `tt-publication-${revocation}`,
            selection: selection("queue-private-token"),
          },
          { kind: "movie", title: "Film" },
          "usr_00000018",
          undefined,
          travelSnapshot(),
        );
        assert.ok(added);
        await renameEntered.promise;
        const target = internalJobs(queue)[0]?.target;
        assert.ok(target);
        const published = path.join(downloads, target.slice(LIBRARY_ID.length + 1));
        const publishedSubtitle = path.join(
          path.dirname(published),
          `${path.basename(published, path.extname(published))}.cs.vtt`,
        );

        allowed = false;
        if (revocation === "removal") {
          remove = queue.removeMatching((job) => job.id === added.id);
          await waitFor(queue, () => queue.get(added.id) === undefined);
        }
        releaseRename.release();

        if (remove) await remove;
        const absent = async (file: string) => {
          try {
            await stat(file);
            return false;
          } catch {
            return true;
          }
        };
        await waitFor(queue, async () => await absent(published) && await absent(publishedSubtitle));
        await assert.rejects(stat(published), { code: "ENOENT" });
        await assert.rejects(stat(publishedSubtitle), { code: "ENOENT" });
        assert.equal(queue.snapshot().jobs.some((job) => job.status === "completed"), false);
        if (revocation === "permission") {
          assert.equal(queue.get(added.id)?.status, "paused");
        } else {
          assert.equal(queue.get(added.id), undefined);
        }
      } finally {
        releaseRename.release();
        await remove?.catch(() => undefined);
        await queue.stop();
        server.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("a type flip during final publication withdraws video and subtitle and resumes in place", async () => {
  const { directory, data, downloads } = await setup();
  const { server, videoUrl, subtitleUrl } = await publicationServer();
  const configured = library(downloads);
  let type: LibraryRecord["type"] = "series";
  const current = () => [{ ...configured, type }];
  const renameEntered = deferred();
  const releaseRename = deferred();
  const queue = new DownloadQueue(() => 1, () => 1, data, downloads, {
    libraries: current,
    defaultLibrary: () => current()[0],
    libraryState: async (libraryId) => current().find((library) => library.id === libraryId),
    renamePublication: async (from, to) => {
      renameEntered.release();
      await releaseRename.promise;
      await rename(from, to);
    },
  });
  queue.setTravelResolver(async () => {
    const selected = selectedTravel(videoUrl, "Show");
    return {
      ...selected,
      subtitle: { addonKey: "queue-private-token", url: subtitleUrl, lang: "cs" },
      resolution: {
        ...selected.resolution,
        subtitleLanguage: "cs",
        subtitleSource: "addon",
      },
    };
  });
  await queue.load();
  try {
    const added = await queue.addPending(
      "Show",
      {
        type: "series",
        videoId: "tt-publication-library-type",
        selection: selection("queue-private-token"),
      },
      { kind: "episode", title: "Show", season: 1, episode: 1 },
      "usr_00000019",
      undefined,
      travelSnapshot(),
    );
    assert.ok(added);
    await renameEntered.promise;
    const target = queue.get(added.id)?.target;
    assert.ok(target);
    const published = path.join(downloads, target.slice(LIBRARY_ID.length + 1));
    const publishedSubtitle = path.join(
      path.dirname(published),
      `${path.basename(published, path.extname(published))}.cs.vtt`,
    );

    type = "movie";
    releaseRename.release();
    await waitFor(queue, () => queue.get(added.id)?.status === "paused");
    await waitFor(queue, async () => {
      try {
        await stat(published);
        return false;
      } catch {
        try {
          await stat(publishedSubtitle);
          return false;
        } catch {
          return true;
        }
      }
    });
    assert.equal(queue.get(added.id)?.pauseReason, "library");
    assert.equal(queue.get(added.id)?.target, target);

    type = "series";
    await queue.resume(added.id);
    await waitFor(queue, () => queue.get(added.id)?.status === "completed");
    assert.equal(queue.get(added.id)?.target, target, "the restored job kept its destination");
    assert.ok((await stat(published)).isFile());
    assert.ok((await stat(publishedSubtitle)).isFile());
  } finally {
    releaseRename.release();
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an explicit retry of a Travel no-match resolves again under the Travel callback", async () => {
  const { directory, data, downloads } = await setup();
  const { server, url, requests } = await countingServer();
  let calls = 0;
  let legacyResolutions = 0;
  const queue = openQueue(data, downloads);
  queue.setResolver(async () => {
    legacyResolutions += 1;
    return undefined;
  });
  queue.setTravelResolver(async () => {
    calls += 1;
    assert.ok(internalJobs(queue)[0]?.source?.selection?.targetSettings);
    return calls === 1
      ? { status: "noMatch", retryable: false, observations: emptyObservations }
      : selectedTravel(url);
  });
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      {
        type: "movie",
        videoId: "tt-explicit-travel",
        selection: selection("addon:queue-private-token"),
      },
      { kind: "movie", title: "Film" },
      "usr_00000014",
      undefined,
      travelSnapshot(),
    );
    assert.ok(added);
    await waitFor(queue, () => queue.get(added.id)?.status === "failed");
    internalJobs(queue)[0]!.travelBudgetAttempts = 3;
    await queue.retry(added.id);
    await waitFor(queue, () => queue.get(added.id)?.status === "completed");
    assert.equal(calls, 2);
    assert.equal(requests(), 1);
    assert.equal(internalJobs(queue)[0]?.travelBudgetAttempts, undefined);
    assert.equal(legacyResolutions, 0);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed Travel transfer re-resolves without spending the transfer retry count", async () => {
  const { directory, data, downloads } = await setup();
  const failedSource = await countingServer(404);
  const goodSource = await countingServer();
  let calls = 0;
  let legacyResolutions = 0;
  const queue = openQueue(data, downloads, { retryDelay: () => 20 });
  queue.setResolver(async () => {
    legacyResolutions += 1;
    return undefined;
  });
  queue.setTravelResolver(async (input) => {
    calls += 1;
    if (calls === 2) {
      assert.deepEqual(input.source.tried, [failedSource.url]);
      assert.equal(internalJobs(queue)[0]?.retryCount, undefined);
      return selectedTravel(goodSource.url);
    }
    return selectedTravel(failedSource.url);
  });
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      {
        type: "movie",
        videoId: "tt-transfer-retry-travel",
        selection: selection("addon:queue-private-token"),
      },
      { kind: "movie", title: "Film" },
      "usr_00000017",
      undefined,
      travelSnapshot(),
    );
    assert.ok(added);
    await waitFor(queue, () => queue.get(added.id)?.status === "completed");
    assert.equal(calls, 2);
    assert.equal(failedSource.requests(), 1);
    assert.equal(goodSource.requests(), 1);
    assert.equal(legacyResolutions, 0);
  } finally {
    await queue.stop();
    failedSource.server.close();
    goodSource.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("selected Travel transfer fallbacks stay bounded across rotating URLs until an explicit retry", async () => {
  const { directory, data, downloads, state } = await setup();
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(404, { "content-type": "video/mp4" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const sourceUrl = `http://127.0.0.1:${address.port}/film.mp4`;
  let resolutions = 0;
  const queue = openQueue(data, downloads, { retryDelay: () => 0 });
  queue.setTravelResolver(async (input) => {
    resolutions += 1;
    if (resolutions === SOURCE_FALLBACK_ATTEMPT_LIMIT + 1) {
      assert.deepEqual(input.source.tried, [], "an explicit retry starts a fresh source history");
      assert.equal(internalJobs(queue)[0]?.sourceFallbackAttempts, undefined);
    }
    return selectedTravel(`${sourceUrl}?token=${resolutions}`);
  });
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      {
        type: "movie",
        videoId: "tt-rotating-travel",
        selection: selection("addon:queue-private-token"),
      },
      { kind: "movie", title: "Film" },
      "usr_00000021",
      undefined,
      travelSnapshot(),
    );
    assert.ok(added);

    await waitFor(queue, () => queue.get(added.id)?.status === "failed");
    assert.equal(resolutions, SOURCE_FALLBACK_ATTEMPT_LIMIT);
    assert.equal(requests, SOURCE_FALLBACK_ATTEMPT_LIMIT);
    const failed = queue.get(added.id)!;
    assert.equal(failed.errorKey, "err.noMatchingSource");
    assertPublicViewIsClean(failed as unknown as Record<string, unknown>);
    assert.equal(internalJobs(queue)[0]?.sourceFallbackAttempts, SOURCE_FALLBACK_ATTEMPT_LIMIT);
    await waitFor(queue, async () => {
      const stored = (await readJobs(state)).find((entry) => entry.id === added.id);
      return stored?.status === "failed"
        && stored.sourceFallbackAttempts === SOURCE_FALLBACK_ATTEMPT_LIMIT;
    });

    await queue.retry(added.id);
    await waitFor(queue, () => queue.get(added.id)?.status === "failed" && resolutions === SOURCE_FALLBACK_ATTEMPT_LIMIT * 2);
    assert.equal(resolutions, SOURCE_FALLBACK_ATTEMPT_LIMIT * 2);
    assert.equal(requests, SOURCE_FALLBACK_ATTEMPT_LIMIT * 2);
    assert.equal(internalJobs(queue)[0]?.sourceFallbackAttempts, SOURCE_FALLBACK_ATTEMPT_LIMIT);
    await waitFor(queue, async () => {
      const stored = (await readJobs(state)).find((entry) => entry.id === added.id);
      return stored?.status === "failed"
        && stored.sourceFallbackAttempts === SOURCE_FALLBACK_ATTEMPT_LIMIT;
    });
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a transient Travel transfer failure still selects a new source immediately", async () => {
  const { directory, data, downloads } = await setup();
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    const status = requests === 1 ? 503 : 200;
    response.writeHead(status, { "content-type": "video/mp4", "content-length": "1" });
    response.end(status === 200 ? "x" : "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const sourceUrl = `http://127.0.0.1:${address.port}/film.mp4`;
  let resolutions = 0;
  const queue = openQueue(data, downloads, { retryDelay: () => 0 });
  queue.setTravelResolver(async () => {
    resolutions += 1;
    return selectedTravel(`${sourceUrl}?token=${resolutions}`);
  });
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-transient-travel", selection: selection("addon:queue-private-token") },
      { kind: "movie", title: "Film" },
      "usr_00000022",
      undefined,
      travelSnapshot(),
    );
    assert.ok(added);
    await waitFor(queue, () => queue.get(added.id)?.status === "completed");
    assert.equal(requests, 2);
    assert.equal(resolutions, 2);
    assert.equal(Object.hasOwn(internalJobs(queue)[0]!, "sourceFallbackAttempts"), false);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a legacy Travel source fallback count migrates across restart without transferring the old stream", async () => {
  const { directory, data, downloads, state } = await setup();
  const oldSource = await countingServer();
  let resolutions = 0;
  const rawJob = {
    ...rawLazyJob(travelSnapshot()),
    ownerUserId: "usr_00000023",
    stream: {
      url: oldSource.url,
      addonKey: "queue-private-token",
      name: "Film.mp4",
      behaviorHints: { filename: "Film.mp4", videoSize: 1 },
    },
    target: `${LIBRARY_ID}/Film/Film.mp4`,
    targetSettings: defaultDownloadSettings().movie,
    libraryId: LIBRARY_ID,
    status: "failed",
    travelSourceFallbackAttempts: 3,
  };
  await writeFile(state, JSON.stringify([rawJob], null, 2));
  const first = openQueue(data, downloads);
  first.setTravelResolver(async () => {
    resolutions += 1;
    return { status: "noMatch", retryable: false, observations: emptyObservations };
  });
  try {
    await first.load();
    assert.equal(internalJobs(first)[0]?.stream, undefined);
    assert.equal(internalJobs(first)[0]?.sourceFallbackAttempts, 3);
    assert.equal(oldSource.requests(), 0);
    await first.stop();
    const migrated = (await readJobs(state))[0]!;
    assert.equal(migrated.sourceFallbackAttempts, 3);
    assert.equal(Object.hasOwn(migrated, "travelSourceFallbackAttempts"), false);

    const reopened = openQueue(data, downloads);
    await reopened.load();
    try {
      assert.equal(internalJobs(reopened)[0]?.status, "failed");
      assert.equal(internalJobs(reopened)[0]?.sourceFallbackAttempts, 3);
      assert.equal((await readJobs(state))[0]?.sourceFallbackAttempts, 3);
      assertPublicViewIsClean(reopened.get("job-source-admission")! as unknown as Record<string, unknown>);
      assert.equal(oldSource.requests(), 0);
      assert.equal(resolutions, 0);
    } finally {
      await reopened.stop();
    }
  } finally {
    await first.stop();
    oldSource.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed or misplaced Travel source fallback counts make the queue unreadable", async () => {
  const validSnapshot = travelSnapshot();
  const validNonTravelSnapshot = nonTravelSnapshot();
  const cases: Array<{ name: string; admission?: unknown; attempts: unknown }> = [
    { name: "negative count", admission: validSnapshot, attempts: -1 },
    { name: "fractional count", admission: validSnapshot, attempts: 1.5 },
    { name: "count over limit", admission: validSnapshot, attempts: SOURCE_FALLBACK_ATTEMPT_LIMIT + 1 },
    { name: "string count", admission: validSnapshot, attempts: "2" },
    { name: "null count", admission: validSnapshot, attempts: null },
    { name: "legacy job", attempts: 1 },
    { name: "non-Travel snapshot", admission: validNonTravelSnapshot, attempts: 1 },
  ];

  for (const entry of cases) {
    const { directory, data, downloads, state } = await setup();
    const bytes = JSON.stringify([{
      ...rawLazyJob(entry.admission),
      sourceFallbackAttempts: entry.attempts,
    }], null, 2);
    await writeFile(state, bytes);
    let resolutions = 0;
    const queue = openQueue(data, downloads);
    queue.setTravelResolver(async () => {
      resolutions += 1;
      return { status: "noMatch", retryable: false, observations: emptyObservations };
    });
    try {
      await queue.load();
      assert.deepEqual(queue.list(), [], entry.name);
      assert.equal(await readFile(state, "utf8"), bytes, `${entry.name} leaves the queue bytes intact`);
      assert.equal((await readdir(data)).some((name) => name.startsWith("downloads.json.damaged-")), false);
      assert.equal(resolutions, 0, `${entry.name} starts no resolver work`);
      await assert.rejects(
        queue.addPending("Other", { type: "movie", videoId: "tt00000024" }),
        (error: AppError) => error.messageKey === "err.queueUnreadable" && error.status === 503,
      );
      assert.equal(await readFile(state, "utf8"), bytes, `${entry.name} refuses new work without writing`);
    } finally {
      await queue.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("restart migrates a selected Travel row, discards its old URL and partial, and resolves fresh", async () => {
  const { directory, data, downloads, state } = await setup();
  const oldSource = await countingServer();
  const newSource = await countingServer();
  const oldPartial = path.join(downloads, "Film", "Film.mp4.part");
  await mkdir(path.dirname(oldPartial), { recursive: true });
  await writeFile(oldPartial, "stale");
  const snapshot = travelSnapshot();
  await writeFile(state, JSON.stringify([{
    ...rawLazyJob(snapshot),
    ownerUserId: "usr_00000015",
    stream: { url: oldSource.url, addonKey: "queue-private-token", name: "Film.mp4", behaviorHints: { filename: "Film.mp4" } },
    subtitle: { url: "http://127.0.0.1/old-subtitle.vtt", addonKey: "subtitle-provider", name: "Film.cs.vtt" },
    travelStreamAddonIdentity: "a".repeat(64),
    travelSubtitleAddonIdentity: "b".repeat(64),
    travelSourceFallbackAttempts: 2,
    target: `${LIBRARY_ID}/Film/Film.mp4`,
    targetSettings: defaultDownloadSettings().movie,
    libraryId: LIBRARY_ID,
  }], null, 2));

  let legacyResolutions = 0;
  const queue = openQueue(data, downloads);
  queue.setResolver(async () => {
    legacyResolutions += 1;
    return undefined;
  });
  queue.setTravelResolver(async (input) => {
    assert.equal(input.cursor, undefined);
    assert.deepEqual(input.source.tried, []);
    assert.equal(internalJobs(queue)[0]?.sourceFallbackAttempts, 2);
    assert.equal(Object.hasOwn(internalJobs(queue)[0]!, "travelSourceFallbackAttempts"), false);
    return selectedTravel(newSource.url);
  });
  try {
    await queue.load();
    await waitFor(queue, () => queue.get("job-source-admission")?.status === "completed");
    assert.equal(oldSource.requests(), 0);
    assert.equal(newSource.requests(), 1);
    assert.equal(legacyResolutions, 0);
    assert.equal(await readFile(oldPartial, "utf8").catch(() => undefined), undefined);
    const stored = (await readJobs(state)).find((entry) => entry.id === "job-source-admission")!;
    assert.equal((stored.stream as { url?: string }).url, newSource.url);
    assert.equal(stored.sourceStreamAddonIdentity, "a".repeat(64));
    assert.equal(Object.hasOwn(stored, "sourceSubtitleAddonIdentity"), false);
    assert.equal(Object.hasOwn(stored, "travelStreamAddonIdentity"), false);
    assert.equal(Object.hasOwn(stored, "travelSubtitleAddonIdentity"), false);
    assert.equal(Object.hasOwn(stored, "travelSourceFallbackAttempts"), false);
    assert.equal(Object.hasOwn(stored, "travelCursor"), false);
    assert.equal(stored.ownerUserId, "usr_00000015");
    assert.deepEqual(stored.sourceAdmission, snapshot);
  } finally {
    await queue.stop();
    oldSource.server.close();
    newSource.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Recommended snapshot remains fail-closed even when profile resolvers are wired", async () => {
  const { directory, data, downloads, state } = await setup();
  const snapshot = nonTravelSnapshot();
  await writeFile(state, JSON.stringify([{
    ...rawLazyJob(snapshot),
    ownerUserId: "usr_00000016",
  }], null, 2));
  let legacyResolutions = 0;
  let profileResolutions = 0;
  const queue = openQueue(data, downloads);
  queue.setResolver(async () => {
    legacyResolutions += 1;
    return undefined;
  });
  queue.setTravelResolver(async () => {
    profileResolutions += 1;
    return { status: "noMatch", retryable: false, observations: emptyObservations };
  });
  queue.setProviderPriorityResolver(async () => {
    profileResolutions += 1;
    return {
      status: "noMatch",
      checkedCandidates: 0,
      temporaryFailures: 0,
      truncated: false,
    };
  });
  try {
    await queue.load();
    await waitFor(queue, () => queue.get("job-source-admission")?.status === "failed");
    assert.equal(queue.get("job-source-admission")?.errorKey, "err.noMatchingSource");
    assert.equal(legacyResolutions, 0);
    assert.equal(profileResolutions, 0);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed persisted snapshots make the queue unreadable without rewriting or dispatching", async () => {
  const valid = travelSnapshot();
  const malformedScope = structuredClone(valid);
  malformedScope.policy.scope = { mode: "allAvailable" };
  const tamperedHeight = structuredClone(valid);
  tamperedHeight.policy.constraints.heightPixels = { min: 1 };
  const cases: Array<{ name: string; value: unknown }> = [
    { name: "unknown schema version", value: { ...structuredClone(valid), schemaVersion: 2 } },
    { name: "malformed scope", value: malformedScope },
    { name: "tampered Travel height", value: tamperedHeight },
    { name: "null snapshot", value: null },
    { name: "wrong operation", value: { ...structuredClone(valid), operation: "play" } },
  ];

  for (const entry of cases) {
    const { directory, data, downloads, state } = await setup();
    const bytes = JSON.stringify([rawLazyJob(entry.value)], null, 2);
    await writeFile(state, bytes);
    let resolutions = 0;
    const queue = openQueue(data, downloads);
    queue.setResolver(async () => {
      resolutions += 1;
      return undefined;
    });
    try {
      await queue.load();
      assert.deepEqual(queue.list(), [], entry.name);
      assert.equal(await readFile(state, "utf8"), bytes, `${entry.name} leaves the queue bytes intact`);
      assert.equal((await readdir(data)).some((name) => name.startsWith("downloads.json.damaged-")), false);
      assert.equal(resolutions, 0, `${entry.name} starts no resolver work`);
      await assert.rejects(
        queue.addPending("Other", { type: "movie", videoId: "tt0000003" }),
        (error: AppError) => error.messageKey === "err.queueUnreadable" && error.status === 503,
      );
      assert.equal(await readFile(state, "utf8"), bytes, `${entry.name} refuses new work without writing`);
    } finally {
      await queue.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("legacy queue rows without a snapshot still load and reach the legacy resolver", async () => {
  const { directory, data, downloads, state } = await setup();
  await writeFile(state, JSON.stringify([rawLazyJob()], null, 2));
  let resolutions = 0;
  const queue = openQueue(data, downloads);
  queue.setResolver(async () => {
    resolutions += 1;
    return undefined;
  });
  try {
    await queue.load();
    await waitFor(queue, () => queue.get("job-source-admission")?.status === "failed");
    assert.equal(resolutions, 1);
    assert.equal(queue.get("job-source-admission")?.errorKey, "err.noMatchingSource");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid admission is rejected before state changes while explicit undefined stays legacy", async () => {
  const { directory, data, downloads, state } = await setup();
  const queue = openQueue(data, downloads);
  let resolutions = 0;
  queue.setResolver(async () => {
    resolutions += 1;
    return undefined;
  });
  await queue.load();
  try {
    const bytes = await readFile(state, "utf8");
    const wrongOperation = { ...travelSnapshot(), operation: "play" };
    for (const invalid of [null, wrongOperation]) {
      await assert.rejects(
        queue.addPending("Film", { type: "movie", videoId: "tt0000004" }, undefined, undefined, undefined, invalid),
        (error: unknown) =>
          error instanceof SourceAdmissionValidationError
          && error.message === "Invalid source admission data.",
      );
      assert.deepEqual(queue.list(), []);
      assert.equal(await readFile(state, "utf8"), bytes);
    }
    assert.equal(resolutions, 0);

    const legacy = await queue.addPending(
      "Legacy",
      { type: "movie", videoId: "tt0000005" },
      undefined,
      undefined,
      undefined,
      undefined,
    );
    assert.ok(legacy);
    await waitFor(queue, () => queue.get(legacy.id)?.status === "failed");
    assert.equal(resolutions, 1);
    const stored = (await readJobs(state)).find((job) => job.id === legacy.id)!;
    assert.equal(Object.hasOwn(stored, "sourceAdmission"), false);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed queue write leaves no snapshot-bearing job in memory or on disk", async () => {
  const { directory, data, downloads, state } = await setup();
  let failing = false;
  const queue = openQueue(data, downloads, {
    writeState: async (file, contents) => {
      if (failing) throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      await writeFile(file, contents);
    },
  });
  await queue.load();
  try {
    const bytes = await readFile(state, "utf8");
    failing = true;
    await assert.rejects(
      queue.addPending("Film", { type: "movie", videoId: "tt0000006" }, undefined, undefined, undefined, travelSnapshot()),
      (error: AppError) => error.messageKey === "err.queueNotSaved",
    );
    assert.deepEqual(queue.list(), []);
    assert.equal(await readFile(state, "utf8"), bytes);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a profile bulk admission skips when the local-copy hook reports an adequate file", async () => {
  const { directory, data, downloads, state } = await setup();
  const seen: Array<{
    ownerUserId: string | undefined;
    source: { type: string; videoId: string };
    media: unknown;
    sourceAdmission: SourceAdmissionSnapshotV1;
  }> = [];
  const admission = travelSnapshot();
  const queue = openQueue(data, downloads, {
    existingLocalCopy: async (input) => {
      seen.push(input);
      return true;
    },
  });
  await queue.load();
  try {
    const before = await readFile(state, "utf8");
    const media = { kind: "movie" as const, title: "Film", id: "tt00000011" };
    const job = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt00000011", selection: selection("addon:legacy") },
      media,
      QUEUE_OWNER,
      undefined,
      admission,
    );
    assert.equal(job, undefined);
    assert.deepEqual(seen, [{
      ownerUserId: QUEUE_OWNER,
      source: { type: "movie", videoId: "tt00000011", selection: selection("addon:legacy") },
      media,
      sourceAdmission: admission,
    }]);
    assert.deepEqual(internalJobs(queue), []);
    assert.equal(await readFile(state, "utf8"), before);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent identical profile admissions run their local-copy checks one at a time", async () => {
  const { directory, data, downloads } = await setup();
  const firstEntered = deferred();
  const releaseFirst = deferred();
  let calls = 0;
  let active = 0;
  let peak = 0;
  const queue = openQueue(data, downloads, {
    existingLocalCopy: async () => {
      calls += 1;
      active += 1;
      peak = Math.max(peak, active);
      if (calls === 1) {
        firstEntered.release();
        await releaseFirst.promise;
      }
      active -= 1;
      return true;
    },
  });
  await queue.load();
  try {
    const first = queue.addPending(
      "Film",
      { type: "movie", videoId: "tt00000012" },
      undefined,
      QUEUE_OWNER,
      undefined,
      travelSnapshot(),
    );
    await firstEntered.promise;
    const second = queue.addPending(
      "Film",
      { type: "movie", videoId: "tt00000012" },
      undefined,
      QUEUE_OWNER,
      undefined,
      travelSnapshot(),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1);
    releaseFirst.release();
    assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]);
    assert.equal(calls, 2);
    assert.equal(peak, 1);
    assert.deepEqual(internalJobs(queue), []);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy admission never runs the local-copy hook", async () => {
  const { directory, data, downloads } = await setup();
  let calls = 0;
  const queue = openQueue(data, downloads, {
    existingLocalCopy: async () => {
      calls += 1;
      return true;
    },
  });
  queue.setResolver(async () => undefined);
  await queue.load();
  try {
    const job = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt00000013" },
      undefined,
      QUEUE_OWNER,
    );
    assert.ok(job);
    assert.equal(calls, 0);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed local-copy lookup fails open and persists the profile job", async () => {
  const { directory, data, downloads } = await setup();
  const queue = openQueue(data, downloads, {
    existingLocalCopy: async () => {
      throw new Error("library unavailable");
    },
  });
  queue.setResolver(async () => undefined);
  await queue.load();
  try {
    const job = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt00000014" },
      undefined,
      QUEUE_OWNER,
      undefined,
      travelSnapshot(),
    );
    assert.ok(job);
    assert.equal(queue.list().length, 1);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Provider priority downloads a direct HTTP source through its own resolver", async () => {
  const { directory, data, downloads } = await setup();
  const { server, url } = await countingServer();
  let providerResolutions = 0;
  let travelResolutions = 0;
  let legacyResolutions = 0;
  let debridCalls = 0;
  const queue = openQueue(data, downloads, {
    debrid: {
      configured: () => true,
      advance: async () => {
        debridCalls += 1;
        throw new Error("a direct URL must not reach Real-Debrid");
      },
    },
  });
  queue.setResolver(async () => {
    legacyResolutions += 1;
    return undefined;
  });
  queue.setTravelResolver(async () => {
    travelResolutions += 1;
    return { status: "noMatch", retryable: false, observations: emptyObservations };
  });
  queue.setProviderPriorityResolver(async () => {
    providerResolutions += 1;
    return selectedProviderPriority({
      url,
      infoHash: "a".repeat(40),
      addonKey: "queue-private-token",
      addonName: "Travel fixture",
      name: "Film.mp4",
      behaviorHints: { filename: "Film.mp4", videoSize: 1 },
    });
  });
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-provider-http", selection: selection("queue-private-token") },
      { kind: "movie", title: "Film" },
      QUEUE_OWNER,
      undefined,
      providerPrioritySnapshot(),
    );
    assert.ok(added);
    await waitFor(queue, () => queue.get(added.id)?.status === "completed");
    assert.equal(providerResolutions, 1);
    assert.equal(travelResolutions, 0);
    assert.equal(legacyResolutions, 0);
    assert.equal(debridCalls, 0);
    assertPublicViewIsClean(queue.get(added.id)! as unknown as Record<string, unknown>);
    assert.equal(JSON.stringify(queue.snapshot()).includes(url), false);
    assert.match(String(internalJobs(queue)[0]?.target), new RegExp(`^${LIBRARY_ID}/Film/`));
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Provider priority no-match with truncation alone fails without retrying", async () => {
  const { directory, data, downloads } = await setup();
  let resolutions = 0;
  const queue = openQueue(data, downloads);
  queue.setProviderPriorityResolver(async () => {
    resolutions += 1;
    return {
      status: "noMatch",
      checkedCandidates: 3,
      temporaryFailures: 0,
      truncated: true,
    };
  });
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-provider-no-match", selection: selection("queue-private-token") },
      { kind: "movie", title: "Film" },
      QUEUE_OWNER,
      undefined,
      providerPrioritySnapshot(),
    );
    assert.ok(added);
    await waitFor(queue, () => queue.get(added.id)?.status === "failed");
    assert.equal(resolutions, 1);
    assert.equal(queue.get(added.id)?.errorKey, "err.noMatchingSource");
    assertPublicViewIsClean(queue.get(added.id)! as unknown as Record<string, unknown>);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Provider priority temporary lookup failures use three bounded retries", async () => {
  const { directory, data, downloads } = await setup();
  let resolutions = 0;
  const delays: number[] = [];
  const queue = openQueue(data, downloads, {
    retryDelay: (retryCount) => {
      delays.push(retryCount);
      return 0;
    },
  });
  queue.setProviderPriorityResolver(async () => {
    resolutions += 1;
    return {
      status: "noMatch",
      checkedCandidates: 2,
      temporaryFailures: 1,
      truncated: false,
    };
  });
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-provider-temporary", selection: selection("queue-private-token") },
      { kind: "movie", title: "Film" },
      QUEUE_OWNER,
      undefined,
      providerPrioritySnapshot(),
    );
    assert.ok(added);
    await waitFor(queue, () => queue.get(added.id)?.status === "failed");
    assert.equal(resolutions, 4);
    assert.deepEqual(delays, [1, 2, 3]);
    assert.equal(queue.get(added.id)?.errorKey, "err.noMatchingSource");
    assert.equal(internalJobs(queue)[0]?.retryCount, 3);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed Provider priority HTTP source falls back to the next selection", async () => {
  const { directory, data, downloads } = await setup();
  const failed = await countingServer(404);
  const good = await countingServer();
  let resolutions = 0;
  const queue = openQueue(data, downloads, { retryDelay: () => 0 });
  queue.setProviderPriorityResolver(async (input) => {
    resolutions += 1;
    if (resolutions === 2) {
      assert.deepEqual(input.source.tried, [failed.url]);
      assert.equal(internalJobs(queue)[0]?.sourceFallbackAttempts, 1);
      return selectedProviderPriority(good.url);
    }
    return selectedProviderPriority(failed.url);
  });
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-provider-fallback", selection: selection("queue-private-token") },
      { kind: "movie", title: "Film" },
      QUEUE_OWNER,
      undefined,
      providerPrioritySnapshot(),
    );
    assert.ok(added);
    await waitFor(queue, () => queue.get(added.id)?.status === "completed");
    assert.equal(resolutions, 2);
    assert.equal(failed.requests(), 1);
    assert.equal(good.requests(), 1);
    assert.equal(internalJobs(queue)[0]?.sourceFallbackAttempts, undefined);
  } finally {
    await queue.stop();
    failed.server.close();
    good.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Provider priority rotating signed URLs consume one finite fallback budget", async () => {
  const { directory, data, downloads, state } = await setup();
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(404, { "content-type": "video/mp4" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const sourceUrl = `http://127.0.0.1:${address.port}/film.mp4`;
  let resolutions = 0;
  const queue = openQueue(data, downloads, { retryDelay: () => 0 });
  queue.setProviderPriorityResolver(async () => {
    resolutions += 1;
    return selectedProviderPriority(`${sourceUrl}?signature=${resolutions}`);
  });
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-provider-rotating", selection: selection("queue-private-token") },
      { kind: "movie", title: "Film" },
      QUEUE_OWNER,
      undefined,
      providerPrioritySnapshot(),
    );
    assert.ok(added);
    await waitFor(queue, () => queue.get(added.id)?.status === "failed");
    assert.equal(resolutions, SOURCE_FALLBACK_ATTEMPT_LIMIT);
    assert.equal(requests, SOURCE_FALLBACK_ATTEMPT_LIMIT);
    assert.equal(internalJobs(queue)[0]?.sourceFallbackAttempts, SOURCE_FALLBACK_ATTEMPT_LIMIT);
    await waitFor(queue, async () => {
      const stored = (await readJobs(state)).find((job) => job.id === added.id);
      return stored?.sourceFallbackAttempts === SOURCE_FALLBACK_ATTEMPT_LIMIT;
    });
    assert.equal(queue.get(added.id)?.errorKey, "err.noMatchingSource");
    assertPublicViewIsClean(queue.get(added.id)! as unknown as Record<string, unknown>);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart refreshes an unfinished Provider priority selection and keeps its budget", async () => {
  const { directory, data, downloads, state } = await setup();
  const stale = await countingServer();
  const fresh = await countingServer();
  const snapshot = providerPrioritySnapshot();
  const target = `${LIBRARY_ID}/Film/Film.mp4`;
  const partial = path.join(downloads, "Film", "Film.mp4.part");
  await mkdir(path.dirname(partial), { recursive: true });
  await writeFile(partial, "stale");
  await writeFile(state, JSON.stringify([{
    ...rawLazyJob(snapshot),
    id: "provider-restart",
    ownerUserId: QUEUE_OWNER,
    status: "downloading",
    sourceFallbackAttempts: 2,
    stream: {
      url: stale.url,
      addonKey: "queue-private-token",
      addonName: "Travel fixture",
      name: "Film.mp4",
      behaviorHints: { filename: "Film.mp4", videoSize: 1 },
    },
    sourceStreamAddonIdentity: "a".repeat(64),
    targetSettings: defaultDownloadSettings().movie,
    target,
    libraryId: LIBRARY_ID,
    received: 5,
    total: 10,
    segments: [{ start: 0, end: 9, received: 5 }],
    debrid: { torrentId: "old", status: "downloaded" },
    debridStartedAt: "2026-01-01T00:00:00.000Z",
  }], null, 2));
  const entered = deferred();
  const release = deferred();
  let resolutions = 0;
  const queue = openQueue(data, downloads);
  queue.setProviderPriorityResolver(async (input) => {
    resolutions += 1;
    assert.deepEqual(input.snapshot, snapshot);
    assert.equal(internalJobs(queue)[0]?.sourceFallbackAttempts, 2);
    entered.release();
    await release.promise;
    return selectedProviderPriority(fresh.url);
  });
  await queue.load();
  try {
    await entered.promise;
    const job = internalJobs(queue)[0]!;
    assert.deepEqual(job.sourceAdmission, snapshot);
    assert.equal(job.stream, undefined);
    assert.equal(job.sourceStreamAddonIdentity, undefined);
    assert.equal(job.debrid, undefined);
    assert.equal(job.segments, undefined);
    assert.equal(job.sourceFallbackAttempts, 2);
    assert.equal(await fileAbsent(partial), true);
    release.release();
    await waitFor(queue, () => queue.get("provider-restart")?.status === "completed");
    assert.equal(resolutions, 1);
    assert.equal(stale.requests(), 0);
    assert.equal(fresh.requests(), 1);
  } finally {
    release.release();
    await queue.stop();
    stale.server.close();
    fresh.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("completed Provider priority rows survive restart with their history", async () => {
  const { directory, data, downloads } = await setup();
  const source = await countingServer();
  const first = openQueue(data, downloads);
  let completions = 0;
  first.onCompleted = () => { completions += 1; };
  first.setProviderPriorityResolver(async () => selectedProviderPriority(source.url));
  await first.load();
  let id = "";
  let completedAt: string | undefined;
  try {
    const added = await first.addPending(
      "Film",
      { type: "movie", videoId: "tt-provider-completed", selection: selection("queue-private-token") },
      { kind: "movie", title: "Film" },
      QUEUE_OWNER,
      undefined,
      providerPrioritySnapshot(),
    );
    assert.ok(added);
    id = added.id;
    await waitFor(first, () => first.get(id)?.status === "completed");
    completedAt = first.get(id)?.completedAt;
    await first.stop();

    let resolutions = 0;
    const reopened = openQueue(data, downloads, { ownerAllowed: () => false });
    reopened.onCompleted = () => { completions += 1; };
    reopened.setProviderPriorityResolver(async () => {
      resolutions += 1;
      return selectedProviderPriority(source.url);
    });
    try {
      await reopened.load();
      const restored = reopened.get(id)!;
      assert.equal(restored.status, "completed");
      assert.equal(restored.completedAt, completedAt);
      assert.equal(restored.received, 1);
      assert.equal(reopened.history().length, 1);
      assert.equal(completions, 1);
      assert.equal(resolutions, 0);
      assertPublicViewIsClean(restored as unknown as Record<string, unknown>);
    } finally {
      await reopened.stop();
    }
  } finally {
    await first.stop();
    source.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Provider priority identity or grant loss during transfer pauses without publication", async () => {
  for (const loss of ["identity", "grant"] as const) {
    await test(`during transfer: ${loss}`, async () => {
      const { directory, data, downloads } = await setup();
      const { server, url, entered, release } = await gatedBodyServer();
      const configured = library(downloads);
      const addons = [identityAddon()];
      const selectedIdentity = addonIdentity(addons[0]!);
      let resolutions = 0;
      const queue = openQueue(data, downloads, {
        ownerAllowed: (job) => ownerMayDownload({
          owner: queueOwner,
          addons,
          libraries: [configured],
        }, job),
      });
      queue.setProviderPriorityResolver(async () => {
        resolutions += 1;
        return selectedProviderPriority(url, { streamAddonIdentity: selectedIdentity });
      });
      await queue.load();
      try {
        const added = await queue.addPending(
          "Film",
          { type: "movie", videoId: `tt-provider-transfer-${loss}`, selection: selection("queue-private-token") },
          { kind: "movie", title: "Film" },
          QUEUE_OWNER,
          undefined,
          providerPrioritySnapshot(),
        );
        assert.ok(added);
        await entered;
        addons[0] = loss === "identity"
          ? { ...addons[0]!, manifest: { ...addons[0]!.manifest, version: "2" } }
          : { ...addons[0]!, allowedUsers: [] };
        release();

        await waitFor(queue, () => queue.get(added.id)?.status === "paused");
        const job = internalJobs(queue)[0]!;
        assert.equal(job.pauseReason, "permission");
        assert.equal(job.sourceFallbackAttempts, undefined);
        assert.equal(resolutions, 1);
        if (job.target) {
          assert.equal(await fileAbsent(path.join(downloads, job.target.slice(LIBRARY_ID.length + 1))), true);
        }
      } finally {
        release();
        await queue.stop();
        server.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("Provider priority identity or grant loss at final rename withdraws publication", async () => {
  for (const loss of ["identity", "grant"] as const) {
    await test(`during rename: ${loss}`, async () => {
      const { directory, data, downloads } = await setup();
      const { server, videoUrl } = await publicationServer();
      const configured = library(downloads);
      const addons = [identityAddon()];
      const selectedIdentity = addonIdentity(addons[0]!);
      const renameEntered = deferred();
      const releaseRename = deferred();
      let resolutions = 0;
      const queue = openQueue(data, downloads, {
        ownerAllowed: (job) => ownerMayDownload({
          owner: queueOwner,
          addons,
          libraries: [configured],
        }, job),
        renamePublication: async (from, to) => {
          renameEntered.release();
          await releaseRename.promise;
          await rename(from, to);
        },
      });
      queue.setProviderPriorityResolver(async () => {
        resolutions += 1;
        return selectedProviderPriority(videoUrl, { streamAddonIdentity: selectedIdentity });
      });
      await queue.load();
      try {
        const added = await queue.addPending(
          "Film",
          { type: "movie", videoId: `tt-provider-rename-${loss}`, selection: selection("queue-private-token") },
          { kind: "movie", title: "Film" },
          QUEUE_OWNER,
          undefined,
          providerPrioritySnapshot(),
        );
        assert.ok(added);
        await renameEntered.promise;
        const target = internalJobs(queue)[0]!.target;
        assert.ok(target);
        const published = path.join(downloads, target.slice(LIBRARY_ID.length + 1));
        addons[0] = loss === "identity"
          ? { ...addons[0]!, manifest: { ...addons[0]!.manifest, resources: [] } }
          : { ...addons[0]!, allowedUsers: [] };
        releaseRename.release();

        await waitFor(queue, async () =>
          queue.get(added.id)?.status === "paused" && await fileAbsent(published));
        assert.equal(queue.get(added.id)?.pauseReason, "permission");
        assert.equal(internalJobs(queue)[0]?.sourceFallbackAttempts, undefined);
        assert.equal(resolutions, 1);
      } finally {
        releaseRename.release();
        await queue.stop();
        server.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("a selected Provider priority torrent waits for Real-Debrid and then completes", async () => {
  const { directory, data, downloads } = await setup();
  const ready = await countingServer();
  const hash = "1".repeat(40);
  const calls: Array<{ infoHash: string; fileIdx?: number }> = [];
  const queue = openQueue(data, downloads, {
    debrid: {
      configured: () => true,
      advance: async (input) => {
        calls.push(input);
        return { ready: true, url: ready.url, torrentId: "torrent-1", filename: "Film.mp4" };
      },
    },
  });
  queue.setProviderPriorityResolver(async () => selectedProviderPriority({
    infoHash: hash,
    fileIdx: 0,
    addonKey: "queue-private-token",
    addonName: "Travel fixture",
    name: "Film.mp4",
    behaviorHints: { filename: "Film.mp4", videoSize: 1 },
  }));
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-provider-torrent", selection: selection("queue-private-token") },
      { kind: "movie", title: "Film" },
      QUEUE_OWNER,
      undefined,
      providerPrioritySnapshot(),
    );
    assert.ok(added);
    await waitFor(queue, () => queue.get(added.id)?.status === "completed");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.infoHash, hash);
    assert.equal(calls[0]?.fileIdx, 0);
    assert.equal(ready.requests(), 1);
    const stream = internalJobs(queue)[0]?.stream;
    assert.equal(stream?.infoHash, hash);
    assert.equal(stream?.url, ready.url);
    assertPublicViewIsClean(queue.get(added.id)! as unknown as Record<string, unknown>);
  } finally {
    await queue.stop();
    ready.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a profile episode torrent missing its admitted Real-Debrid file falls back to the next source", async () => {
  const { directory, data, downloads } = await setup();
  const ready = await countingServer();
  const hash = "6".repeat(40);
  const calls: Array<{ fileIdx?: number; exactFile?: boolean }> = [];
  let resolutions = 0;
  const queue = openQueue(data, downloads, {
    retryDelay: () => 0,
    debrid: {
      configured: () => true,
      advance: async (input) => {
        calls.push(input);
        throw new DebridError("Real-Debrid did not contain the selected file.");
      },
    },
  });
  queue.setProviderPriorityResolver(async () => {
    resolutions += 1;
    if (resolutions === 2) {
      assert.equal(internalJobs(queue)[0]?.sourceFallbackAttempts, 1);
      return selectedProviderPriority(ready.url);
    }
    return selectedProviderPriority({
      infoHash: hash,
      fileIdx: 3,
      addonKey: "queue-private-token",
      addonName: "Travel fixture",
      name: "Show.S01E01.mp4",
      behaviorHints: { filename: "Show.S01E01.mp4", videoSize: 1 },
    });
  });
  await queue.load();
  try {
    const added = await queue.addPending(
      "Show",
      { type: "series", videoId: "tt-provider-missing-file", selection: selection("queue-private-token") },
      { kind: "episode", title: "Show", season: 1, episode: 1 },
      QUEUE_OWNER,
      undefined,
      providerPrioritySnapshot(),
    );
    assert.ok(added);
    await waitFor(queue, () => queue.get(added.id)?.status === "completed");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.fileIdx, 3);
    assert.equal(calls[0]?.exactFile, true);
    assert.equal(resolutions, 2);
    assert.equal(ready.requests(), 1);
  } finally {
    await queue.stop();
    ready.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed Provider priority torrents try the next source within the finite budget", async () => {
  for (const failure of ["terminal", "wrong-episode"] as const) {
    await test(failure, async () => {
      const { directory, data, downloads } = await setup();
      const { server, videoUrl } = await publicationServer();
      const good = await countingServer();
      let resolutions = 0;
      const firstHash = failure === "terminal" ? "2".repeat(40) : "3".repeat(40);
      const queue = openQueue(data, downloads, {
        retryDelay: () => 0,
        debrid: {
          configured: () => true,
          advance: async () => {
            if (failure === "terminal") throw new Error("torrent is unavailable");
            return {
              ready: true,
              url: videoUrl,
              torrentId: "wrong-episode",
              filename: "Show.S01E02.mp4",
            };
          },
        },
      });
      queue.setProviderPriorityResolver(async (input) => {
        resolutions += 1;
        if (resolutions === 2) {
          assert.ok(input.source.tried.includes(`torrent:${firstHash}:0`));
          assert.equal(internalJobs(queue)[0]?.sourceFallbackAttempts, 1);
          return selectedProviderPriority(good.url);
        }
        return selectedProviderPriority({
          infoHash: firstHash,
          fileIdx: 0,
          addonKey: "queue-private-token",
          addonName: "Travel fixture",
          name: "Show.S01E01.mp4",
          behaviorHints: { filename: "Show.S01E01.mp4", videoSize: 1 },
        });
      });
      await queue.load();
      try {
        const added = await queue.addPending(
          "Show",
          { type: "series", videoId: `tt-provider-${failure}`, selection: selection("queue-private-token") },
          { kind: "episode", title: "Show", season: 1, episode: 1 },
          QUEUE_OWNER,
          undefined,
          providerPrioritySnapshot(),
        );
        assert.ok(added);
        await waitFor(queue, () => queue.get(added.id)?.status === "completed");
        assert.equal(resolutions, 2);
        assert.equal(good.requests(), 1);
      } finally {
        await queue.stop();
        good.server.close();
        server.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("Provider priority terminal torrent failures exhaust the shared fallback budget", async () => {
  const { directory, data, downloads } = await setup();
  let resolutions = 0;
  let advances = 0;
  const queue = openQueue(data, downloads, {
    debrid: {
      configured: () => true,
      advance: async () => {
        advances += 1;
        throw new Error("torrent is unavailable");
      },
    },
  });
  queue.setProviderPriorityResolver(async () => {
    resolutions += 1;
    return selectedProviderPriority({
      infoHash: resolutions.toString(16).padStart(40, "0"),
      fileIdx: 0,
      addonKey: "queue-private-token",
      addonName: "Travel fixture",
      name: "Film.mp4",
      behaviorHints: { filename: "Film.mp4", videoSize: 1 },
    });
  });
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-provider-torrent-budget", selection: selection("queue-private-token") },
      { kind: "movie", title: "Film" },
      QUEUE_OWNER,
      undefined,
      providerPrioritySnapshot(),
    );
    assert.ok(added);
    await waitFor(queue, () => queue.get(added.id)?.status === "failed");
    assert.equal(resolutions, SOURCE_FALLBACK_ATTEMPT_LIMIT);
    assert.equal(advances, SOURCE_FALLBACK_ATTEMPT_LIMIT);
    assert.equal(internalJobs(queue)[0]?.sourceFallbackAttempts, SOURCE_FALLBACK_ATTEMPT_LIMIT);
    assert.equal(queue.get(added.id)?.errorKey, "err.noMatchingSource");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("identity loss during a deferred Real-Debrid answer discards the late result", async () => {
  const { directory, data, downloads } = await setup();
  const ready = await countingServer();
  const configured = library(downloads);
  const addons = [identityAddon()];
  const selectedIdentity = addonIdentity(addons[0]!);
  const entered = deferred();
  const release = deferred();
  const hash = "4".repeat(40);
  let resolutions = 0;
  const queue = openQueue(data, downloads, {
    ownerAllowed: (job) => ownerMayDownload({
      owner: queueOwner,
      addons,
      libraries: [configured],
    }, job),
    debrid: {
      configured: () => true,
      advance: async () => {
        entered.release();
        await release.promise;
        return { ready: true, url: ready.url, torrentId: "late", filename: "Film.mp4" };
      },
    },
  });
  queue.setProviderPriorityResolver(async () => {
    resolutions += 1;
    return selectedProviderPriority({
      infoHash: hash,
      fileIdx: 0,
      addonKey: "queue-private-token",
      addonName: "Travel fixture",
      name: "Film.mp4",
      behaviorHints: { filename: "Film.mp4", videoSize: 1 },
    }, { streamAddonIdentity: selectedIdentity });
  });
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-provider-deferred", selection: selection("queue-private-token") },
      { kind: "movie", title: "Film" },
      QUEUE_OWNER,
      undefined,
      providerPrioritySnapshot(),
    );
    assert.ok(added);
    await entered.promise;
    addons[0] = { ...addons[0]!, manifest: { ...addons[0]!.manifest, version: "2" } };
    release.release();
    await waitFor(queue, () => queue.get(added.id)?.status === "paused");
    assert.equal(queue.get(added.id)?.pauseReason, "permission");
    assert.equal(resolutions, 1);
    assert.equal(internalJobs(queue)[0]?.stream?.url, undefined);
    assert.equal(internalJobs(queue)[0]?.sourceFallbackAttempts, undefined);
    assert.equal(ready.requests(), 0);
  } finally {
    release.release();
    await queue.stop();
    ready.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an invalid Real-Debrid ready URL falls back to the next Provider priority source", async () => {
  const { directory, data, downloads } = await setup();
  const good = await countingServer();
  let resolutions = 0;
  const hash = "5".repeat(40);
  const queue = openQueue(data, downloads, {
    retryDelay: () => 0,
    debrid: {
      configured: () => true,
      advance: async () => ({
        ready: true,
        url: "file:///tmp/provider-private.mp4",
        torrentId: "invalid-url",
        filename: "Film.mp4",
      }),
    },
  });
  queue.setProviderPriorityResolver(async (input) => {
    resolutions += 1;
    if (resolutions === 2) {
      assert.ok(input.source.tried.includes(`torrent:${hash}:0`));
      return selectedProviderPriority(good.url);
    }
    return selectedProviderPriority({
      infoHash: hash,
      fileIdx: 0,
      addonKey: "queue-private-token",
      addonName: "Travel fixture",
      name: "Film.mp4",
      behaviorHints: { filename: "Film.mp4", videoSize: 1 },
    });
  });
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-provider-invalid-ready", selection: selection("queue-private-token") },
      { kind: "movie", title: "Film" },
      QUEUE_OWNER,
      undefined,
      providerPrioritySnapshot(),
    );
    assert.ok(added);
    await waitFor(queue, () => queue.get(added.id)?.status === "completed");
    assert.equal(resolutions, 2);
    assert.equal(good.requests(), 1);
    assert.equal(internalJobs(queue)[0]?.stream?.url, good.url);
  } finally {
    await queue.stop();
    good.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Provider priority torrent fails closed when Real-Debrid is no longer configured", async () => {
  const { directory, data, downloads, state } = await setup();
  const hash = "6".repeat(40);
  await writeFile(state, JSON.stringify([{
    ...rawLazyJob(providerPrioritySnapshot()),
    id: "provider-no-debrid",
    ownerUserId: QUEUE_OWNER,
    status: "waiting",
    stream: {
      infoHash: hash,
      fileIdx: 0,
      addonKey: "queue-private-token",
      addonName: "Travel fixture",
      name: "Film.mp4",
      behaviorHints: { filename: "Film.mp4", videoSize: 1 },
    },
    sourceStreamAddonIdentity: "a".repeat(64),
    targetSettings: defaultDownloadSettings().movie,
    target: `${LIBRARY_ID}/Film/Film.mp4`,
    libraryId: LIBRARY_ID,
    debrid: {},
    debridStartedAt: new Date().toISOString(),
  }], null, 2));
  const queue = openQueue(data, downloads, {
    debrid: {
      configured: () => false,
      advance: async () => {
        throw new Error("must not advance");
      },
    },
  });
  queue.setProviderPriorityResolver(async () => selectedProviderPriority({
    infoHash: hash,
    fileIdx: 0,
    addonKey: "queue-private-token",
    addonName: "Travel fixture",
    name: "Film.mp4",
    behaviorHints: { filename: "Film.mp4", videoSize: 1 },
  }));
  try {
    await queue.load();
    await waitFor(queue, () => queue.get("provider-no-debrid")?.status === "failed");
    assert.equal(queue.get("provider-no-debrid")?.errorKey, "err.debridTokenMissing");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an explicit retry of Provider priority no-match resolves with a fresh budget", async () => {
  const { directory, data, downloads } = await setup();
  const { server, url, requests } = await countingServer();
  let resolutions = 0;
  const queue = openQueue(data, downloads);
  queue.setProviderPriorityResolver(async (input) => {
    resolutions += 1;
    if (resolutions === 1) {
      return {
        status: "noMatch",
        checkedCandidates: 1,
        temporaryFailures: 0,
        truncated: false,
      };
    }
    assert.deepEqual(input.source.tried, []);
    assert.equal(internalJobs(queue)[0]?.sourceFallbackAttempts, undefined);
    return selectedProviderPriority(url);
  });
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-provider-explicit-retry", selection: selection("queue-private-token") },
      { kind: "movie", title: "Film" },
      QUEUE_OWNER,
      undefined,
      providerPrioritySnapshot(),
    );
    assert.ok(added);
    await waitFor(queue, () => queue.get(added.id)?.status === "failed");
    internalJobs(queue)[0]!.sourceFallbackAttempts = SOURCE_FALLBACK_ATTEMPT_LIMIT;
    internalJobs(queue)[0]!.source!.tried.push("http://127.0.0.1/stale");
    await queue.retry(added.id);
    await waitFor(queue, () => queue.get(added.id)?.status === "completed");
    assert.equal(resolutions, 2);
    assert.equal(requests(), 1);
    assert.equal(internalJobs(queue)[0]?.sourceFallbackAttempts, undefined);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a rules snapshot runs only through the rules resolver and stages a verified HTTP source", async () => {
  const { directory, data, downloads } = await setup();
  const source = await countingServer();
  const queue = openQueue(data, downloads);
  const calls = { rules: 0, travel: 0, provider: 0 };
  queue.setRulesResolver(async () => {
    calls.rules += 1;
    return selectedRules(source.url);
  });
  queue.setTravelResolver(async () => {
    calls.travel += 1;
    return selectedTravel(source.url);
  });
  queue.setProviderPriorityResolver(async () => {
    calls.provider += 1;
    return selectedProviderPriority(source.url);
  });
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-rules-http", selection: selection("queue-private-token") },
      { kind: "movie", title: "Film" },
      QUEUE_OWNER,
      undefined,
      rulesSnapshot(),
    );
    assert.ok(added);
    await waitFor(queue, () => queue.get(added.id)?.status === "completed");
    assert.deepEqual(calls, { rules: 1, travel: 0, provider: 0 });
    assert.equal(internalJobs(queue)[0]?.rulesCursor, undefined);
    assertPublicViewIsClean(queue.get(added.id)! as unknown as Record<string, unknown>);
  } finally {
    await queue.stop();
    source.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a rules budget cursor is persisted, retryable, and eventually fails at its bound", async () => {
  const { directory, data, downloads } = await setup();
  let clock = 10_000;
  const queue = openQueue(data, downloads, {
    now: () => clock,
    retryDelay: () => 100,
  });
  let calls = 0;
  queue.setRulesResolver(async (input) => {
    calls += 1;
    assert.deepEqual(input.cursor?.nextIndex, calls === 1 ? undefined : RULES_INSPECTION_BUDGET);
    return {
      status: "budgetExhausted",
      retryable: true,
      observations: { ...emptyObservations, probesUsed: RULES_INSPECTION_BUDGET },
      cursor: rulesCursor(RULES_INSPECTION_BUDGET, [0, 1]),
    };
  });
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-rules-budget", selection: selection("queue-private-token") },
      { kind: "movie", title: "Film" },
      QUEUE_OWNER,
      undefined,
      rulesSnapshot(),
    );
    assert.ok(added);
    await waitFor(queue, () => internalJobs(queue)[0]?.rulesBudgetAttempts === 1);
    assert.deepEqual(internalJobs(queue)[0]?.rulesCursor, rulesCursor(RULES_INSPECTION_BUDGET, [0, 1]));

    internalJobs(queue)[0]!.rulesBudgetAttempts = RULES_BUDGET_ATTEMPT_LIMIT;
    internalJobs(queue)[0]!.notBefore = clock;
    queue.changed();
    await waitFor(queue, () => queue.get(added.id)?.status === "failed");
    assert.equal(queue.get(added.id)?.errorKey, "err.checkedSources");
    assert.equal(internalJobs(queue)[0]?.rulesCursor, undefined);
    assert.equal(internalJobs(queue)[0]?.rulesBudgetAttempts, undefined);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the rules temporary-failure limit stages a verified incumbent on the final attempt", async () => {
  const { directory, data, downloads, state } = await setup();
  const source = await countingServer();
  const cursor = rulesCursor(1, [], [{
    continuationKey: "a".repeat(64),
    audioTier: "preferred",
    heightPixels: 720,
    subtitleTier: "unknown",
  }]);
  await writeFile(state, JSON.stringify([{
    ...rawLazyJob(rulesSnapshot()),
    ownerUserId: QUEUE_OWNER,
    rulesCursor: cursor,
    rulesTemporaryFailures: 3,
  }], null, 2));
  const queue = openQueue(data, downloads);
  let calls = 0;
  queue.setRulesResolver(async (input) => {
    calls += 1;
    assert.equal(input.finalTemporaryAttempt, true);
    return selectedRules(source.url);
  });
  try {
    await queue.load();
    await waitFor(queue, () => queue.get("job-source-admission")?.status === "completed");
    assert.equal(calls, 1);
    assert.equal(source.requests(), 1);
    assert.equal(internalJobs(queue)[0]?.stream?.url, source.url);
  } finally {
    await queue.stop();
    source.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the rules temporary-failure limit still fails without a verified incumbent", async () => {
  const { directory, data, downloads, state } = await setup();
  await writeFile(state, JSON.stringify([{
    ...rawLazyJob(rulesSnapshot()),
    ownerUserId: QUEUE_OWNER,
    rulesCursor: rulesCursor(1),
    rulesTemporaryFailures: 3,
  }], null, 2));
  const queue = openQueue(data, downloads);
  let calls = 0;
  queue.setRulesResolver(async (input) => {
    calls += 1;
    assert.equal(input.finalTemporaryAttempt, true);
    return {
      status: "temporaryFailure",
      retryable: true,
      observations: { ...emptyObservations, temporaryFailures: 1 },
      cursor: input.cursor!,
    };
  });
  try {
    await queue.load();
    await waitFor(queue, () => queue.get("job-source-admission")?.status === "failed");
    assert.equal(calls, 1);
    assert.equal(queue.get("job-source-admission")?.errorKey, "err.noMatchingSource");
    assert.equal(internalJobs(queue)[0]?.rulesCursor, undefined);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("load accepts a rules cursor only on an unresolved rules job", async () => {
  const { directory, data, downloads, state } = await setup();
  const cursor = rulesCursor(3, [0], [{
    continuationKey: "a".repeat(64),
    audioTier: "preferred",
    heightPixels: 720,
    subtitleTier: "unknown",
  }]);
  await writeFile(state, JSON.stringify([{
    ...rawLazyJob(rulesSnapshot()),
    rulesCursor: cursor,
    rulesBudgetAttempts: 7,
  }], null, 2));
  const queue = openQueue(data, downloads);
  const entered = deferred();
  queue.setRulesResolver(async (input) => {
    assert.deepEqual(input.cursor, cursor);
    entered.release();
    return {
      status: "temporaryFailure",
      retryable: true,
      observations: { ...emptyObservations, temporaryFailures: 1 },
      cursor,
    };
  });
  try {
    await queue.load();
    await entered.promise;
    assert.deepEqual(internalJobs(queue)[0]?.rulesCursor, cursor);
    assert.equal(internalJobs(queue)[0]?.rulesBudgetAttempts, 7);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit retry clears rules cursor state and tried sources", async () => {
  const { directory, data, downloads } = await setup();
  const source = await countingServer();
  let calls = 0;
  const queue = openQueue(data, downloads);
  queue.setRulesResolver(async (input) => {
    calls += 1;
    if (calls === 1) {
      return {
        status: "noMatch",
        retryable: false,
        observations: { ...emptyObservations, probesUsed: 1 },
      };
    }
    assert.equal(input.cursor, undefined);
    assert.deepEqual(input.source.tried, []);
    return selectedRules(source.url);
  });
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-rules-retry", selection: selection("queue-private-token") },
      { kind: "movie", title: "Film" },
      QUEUE_OWNER,
      undefined,
      rulesSnapshot(),
    );
    assert.ok(added);
    await waitFor(queue, () => queue.get(added.id)?.status === "failed");
    const job = internalJobs(queue)[0]!;
    job.rulesCursor = rulesCursor();
    job.rulesBudgetAttempts = 9;
    job.rulesTemporaryFailures = 2;
    job.source!.tried.push("http://127.0.0.1/stale");
    await queue.retry(added.id);
    await waitFor(queue, () => queue.get(added.id)?.status === "completed");
    assert.equal(job.rulesCursor, undefined);
    assert.equal(job.rulesBudgetAttempts, undefined);
    assert.equal(job.rulesTemporaryFailures, undefined);
  } finally {
    await queue.stop();
    source.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a selected rules torrent uses the existing exact-file debrid path", async () => {
  const { directory, data, downloads } = await setup();
  const ready = await countingServer();
  const hash = "7".repeat(40);
  const calls: Array<{ infoHash: string; fileIdx?: number; exactFile?: boolean }> = [];
  const queue = openQueue(data, downloads, {
    debrid: {
      configured: () => true,
      advance: async (input) => {
        calls.push(input);
        return { ready: true, url: ready.url, torrentId: "rules-torrent", filename: "Film.mp4" };
      },
    },
  });
  queue.setRulesResolver(async () => ({
    ...selectedRules(ready.url),
    stream: {
      infoHash: hash,
      fileIdx: 0,
      addonKey: "queue-private-token",
      addonName: "Rules fixture",
      name: "Film.mp4",
      behaviorHints: { filename: "Film.mp4", videoSize: 1 },
    },
    resolution: { checkedCandidates: 0, audioLanguage: "en", audioEvidence: "listing" },
  }));
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-rules-torrent", selection: selection("queue-private-token") },
      { kind: "movie", title: "Film" },
      QUEUE_OWNER,
      undefined,
      rulesSnapshot(),
    );
    assert.ok(added);
    await waitFor(queue, () => queue.get(added.id)?.status === "completed");
    assert.deepEqual(calls, [{ infoHash: hash, fileIdx: 0, torrentId: undefined, exactFile: true }]);
  } finally {
    await queue.stop();
    ready.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a rules job with no rules resolver fails closed", async () => {
  const { directory, data, downloads } = await setup();
  const queue = openQueue(data, downloads);
  queue.setTravelResolver(async () => selectedTravel("http://127.0.0.1/not-used.mp4"));
  queue.setProviderPriorityResolver(async () => selectedProviderPriority("http://127.0.0.1/not-used.mp4"));
  await queue.load();
  try {
    const added = await queue.addPending(
      "Film",
      { type: "movie", videoId: "tt-rules-missing-runtime", selection: selection("queue-private-token") },
      { kind: "movie", title: "Film" },
      QUEUE_OWNER,
      undefined,
      rulesSnapshot(),
    );
    assert.ok(added);
    await waitFor(queue, () => queue.get(added.id)?.status === "failed");
    assert.equal(queue.get(added.id)?.errorKey, "err.noMatchingSource");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
