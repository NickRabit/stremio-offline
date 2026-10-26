import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppError } from "./errors.js";
import {
  materializeSourceAdmissionPolicy,
  parseSourceAdmissionSnapshotV1,
  SourceAdmissionValidationError,
  type SourceAdmissionSnapshotV1,
} from "./source-admission.js";
import { defaultDownloadSettings } from "./naming.js";
import type { LibraryRecord } from "./libraries.js";
import { SOURCE_PROFILE_DEFINITIONS, SOURCE_PROFILE_IDS } from "./source-profiles.js";
import {
  TravelVerificationError,
  type TravelContinuationCursorV1,
} from "./source-travel.js";
import type { TravelProfileResolution } from "./source-profile-resolver.js";
import {
  DownloadQueue,
  TRAVEL_SOURCE_FALLBACK_ATTEMPT_LIMIT,
  type DownloadJob,
  type DownloadSelection,
  type QueueHooks,
} from "./downloads.js";

process.env.ALLOW_PRIVATE_ADDONS = "1";

const LIBRARY_ID = "lib_51a5510a";
const PROVIDER_ONE = "addon:queue-private-token";
const PROVIDER_TWO = "addon:second-provider";
const TRAVEL_BUDGET_ATTEMPT_LIMIT = 1_000;

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

const travelDefinition = SOURCE_PROFILE_DEFINITIONS.find((definition) => definition.id === SOURCE_PROFILE_IDS.travel);
assert.ok(travelDefinition);

const travelSnapshot = (): SourceAdmissionSnapshotV1 => parseSourceAdmissionSnapshotV1({
  schemaVersion: 1,
  profile: { id: SOURCE_PROFILE_IDS.travel, revision: 1 },
  operation: "downloadToLibrary",
  providerKeys: [PROVIDER_TWO, PROVIDER_ONE],
  policy: materializeSourceAdmissionPolicy(
    travelDefinition.policy,
    [PROVIDER_TWO, PROVIDER_ONE],
    { audioLanguage: "English", subtitleLanguage: "cs" },
  ),
});

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
  assert.equal(Object.hasOwn(view, "travelSourceFallbackAttempts"), false);
  assert.equal(Object.hasOwn(view, "travelBudgetAttempts"), false);
  assert.equal(Object.hasOwn(view, "policy"), false);
  const text = JSON.stringify(view);
  assert.doesNotMatch(text, /queue-private-token/);
  assert.doesNotMatch(text, /sourceAdmission/);
  assert.doesNotMatch(text, /travelCursor/);
  assert.doesNotMatch(text, /travelSourceFallbackAttempts/);
  assert.doesNotMatch(text, /travelBudgetAttempts/);
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

const emptyObservations = {
  probesUsed: 0,
  confirmedRejections: 0,
  temporaryFailures: 0,
  accessDenials: 0,
  unresolvedCandidates: 0,
} as const;

type SelectedTravel = Extract<TravelProfileResolution, { status: "selected" }>;

const selectedTravel = (url: string, title = "Film"): SelectedTravel => ({
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
  searchStatus: "complete",
  retryable: false,
  observations: emptyObservations,
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
  const nonTravelSnapshot = structuredClone(validSnapshot);
  nonTravelSnapshot.profile.id = SOURCE_PROFILE_IDS.recommended;
  const cases: Array<{ name: string; admission?: unknown; cursor: unknown; stream?: unknown; budgetAttempts?: unknown }> = [
    { name: "malformed cursor", admission: validSnapshot, cursor: { ...travelCursor(), extra: true } },
    { name: "legacy job", cursor: travelCursor() },
    { name: "non-Travel snapshot", admission: nonTravelSnapshot, cursor: travelCursor() },
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
    assert.equal((stored.stream as { url?: string }).url, url);
    assert.match(String(stored.target), new RegExp(`^${LIBRARY_ID}/Film/Film\\.mp4$`));
  } finally {
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
    if (resolutions === TRAVEL_SOURCE_FALLBACK_ATTEMPT_LIMIT + 1) {
      assert.deepEqual(input.source.tried, [], "an explicit retry starts a fresh source history");
      assert.equal(internalJobs(queue)[0]?.travelSourceFallbackAttempts, undefined);
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
    assert.equal(resolutions, TRAVEL_SOURCE_FALLBACK_ATTEMPT_LIMIT);
    assert.equal(requests, TRAVEL_SOURCE_FALLBACK_ATTEMPT_LIMIT);
    const failed = queue.get(added.id)!;
    assert.equal(failed.errorKey, "err.noMatchingSource");
    assertPublicViewIsClean(failed as unknown as Record<string, unknown>);
    assert.equal(internalJobs(queue)[0]?.travelSourceFallbackAttempts, TRAVEL_SOURCE_FALLBACK_ATTEMPT_LIMIT);
    await waitFor(queue, async () => {
      const stored = (await readJobs(state)).find((entry) => entry.id === added.id);
      return stored?.status === "failed"
        && stored.travelSourceFallbackAttempts === TRAVEL_SOURCE_FALLBACK_ATTEMPT_LIMIT;
    });

    await queue.retry(added.id);
    await waitFor(queue, () => queue.get(added.id)?.status === "failed" && resolutions === TRAVEL_SOURCE_FALLBACK_ATTEMPT_LIMIT * 2);
    assert.equal(resolutions, TRAVEL_SOURCE_FALLBACK_ATTEMPT_LIMIT * 2);
    assert.equal(requests, TRAVEL_SOURCE_FALLBACK_ATTEMPT_LIMIT * 2);
    assert.equal(internalJobs(queue)[0]?.travelSourceFallbackAttempts, TRAVEL_SOURCE_FALLBACK_ATTEMPT_LIMIT);
    await waitFor(queue, async () => {
      const stored = (await readJobs(state)).find((entry) => entry.id === added.id);
      return stored?.status === "failed"
        && stored.travelSourceFallbackAttempts === TRAVEL_SOURCE_FALLBACK_ATTEMPT_LIMIT;
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
    assert.equal(Object.hasOwn(internalJobs(queue)[0]!, "travelSourceFallbackAttempts"), false);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Travel source fallback count survives restart cleanup without transferring the old stream", async () => {
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
    assert.equal(internalJobs(first)[0]?.travelSourceFallbackAttempts, 3);
    assert.equal(oldSource.requests(), 0);
    await first.stop();

    const reopened = openQueue(data, downloads);
    await reopened.load();
    try {
      assert.equal(internalJobs(reopened)[0]?.status, "failed");
      assert.equal(internalJobs(reopened)[0]?.travelSourceFallbackAttempts, 3);
      assert.equal((await readJobs(state))[0]?.travelSourceFallbackAttempts, 3);
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
  const nonTravelSnapshot = structuredClone(validSnapshot);
  nonTravelSnapshot.profile.id = SOURCE_PROFILE_IDS.recommended;
  const cases: Array<{ name: string; admission?: unknown; attempts: unknown }> = [
    { name: "negative count", admission: validSnapshot, attempts: -1 },
    { name: "fractional count", admission: validSnapshot, attempts: 1.5 },
    { name: "count over limit", admission: validSnapshot, attempts: TRAVEL_SOURCE_FALLBACK_ATTEMPT_LIMIT + 1 },
    { name: "string count", admission: validSnapshot, attempts: "2" },
    { name: "null count", admission: validSnapshot, attempts: null },
    { name: "legacy job", attempts: 1 },
    { name: "non-Travel snapshot", admission: nonTravelSnapshot, attempts: 1 },
  ];

  for (const entry of cases) {
    const { directory, data, downloads, state } = await setup();
    const bytes = JSON.stringify([{
      ...rawLazyJob(entry.admission),
      travelSourceFallbackAttempts: entry.attempts,
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

test("restart discards an old Travel URL and partial before resolving a fresh source", async () => {
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

test("a non-Travel snapshot remains fail-closed without a Travel resolver", async () => {
  const { directory, data, downloads, state } = await setup();
  const snapshot = structuredClone(travelSnapshot());
  snapshot.profile.id = SOURCE_PROFILE_IDS.providerPriority;
  await writeFile(state, JSON.stringify([{
    ...rawLazyJob(snapshot),
    ownerUserId: "usr_00000016",
  }], null, 2));
  let legacyResolutions = 0;
  const queue = openQueue(data, downloads);
  queue.setResolver(async () => {
    legacyResolutions += 1;
    return undefined;
  });
  try {
    await queue.load();
    await waitFor(queue, () => queue.get("job-source-admission")?.status === "failed");
    assert.equal(queue.get("job-source-admission")?.errorKey, "err.noMatchingSource");
    assert.equal(legacyResolutions, 0);
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
