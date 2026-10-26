import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  DownloadQueue,
  type DownloadJob,
  type DownloadSelection,
  type QueueHooks,
} from "./downloads.js";

const LIBRARY_ID = "lib_51a5510a";
const PROVIDER_ONE = "addon:queue-private-token";
const PROVIDER_TWO = "addon:second-provider";

const travelCursor = (): TravelContinuationCursorV1 => ({
  schemaVersion: 1,
  scopeFingerprint: "a".repeat(64),
  listingFingerprint: "b".repeat(64),
  nextIndex: 2,
  rejectedIndices: [0, 1],
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

const waitFor = async (queue: DownloadQueue, predicate: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout: ${JSON.stringify(queue.snapshot())}`);
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
  assert.equal(Object.hasOwn(view, "policy"), false);
  const text = JSON.stringify(view);
  assert.doesNotMatch(text, /queue-private-token/);
  assert.doesNotMatch(text, /sourceAdmission/);
  assert.doesNotMatch(text, /travelCursor/);
  assert.doesNotMatch(text, /"policy"/);
};

const countingServer = () => new Promise<{ server: Server; url: string; requests: () => number }>((resolve) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "video/mp4", "content-length": "1" });
    response.end("x");
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as { port: number };
    resolve({ server, url: `http://127.0.0.1:${address.port}/film.mp4`, requests: () => requests });
  });
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
  const cases: Array<{ name: string; admission?: unknown; cursor: unknown; stream?: unknown }> = [
    { name: "malformed cursor", admission: validSnapshot, cursor: { ...travelCursor(), extra: true } },
    { name: "legacy job", cursor: travelCursor() },
    { name: "non-Travel snapshot", admission: nonTravelSnapshot, cursor: travelCursor() },
    { name: "selected stream", admission: validSnapshot, cursor: travelCursor(), stream: { url: "http://127.0.0.1/private" } },
  ];

  for (const entry of cases) {
    const { directory, data, downloads, state } = await setup();
    const bytes = JSON.stringify([{
      ...rawLazyJob(entry.admission),
      ...(entry.stream === undefined ? {} : { stream: entry.stream }),
      travelCursor: entry.cursor,
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

test("a restored snapshot with a preselected stream fails closed without transferring it", async () => {
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
    assert.equal(internalJobs(queue)[0]?.startedAt, undefined, "the direct transfer path never starts");
    const view = queue.get("job-source-admission")!;
    assert.equal(view.errorKey, "err.noMatchingSource");
    assert.doesNotMatch(JSON.stringify(view), /queue-private-token/);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed persisted snapshots make the queue unreadable without rewriting or dispatching", async () => {
  const valid = travelSnapshot();
  const malformedScope = structuredClone(valid);
  malformedScope.policy.scope = { mode: "allAvailable" };
  const cases: Array<{ name: string; value: unknown }> = [
    { name: "unknown schema version", value: { ...structuredClone(valid), schemaVersion: 2 } },
    { name: "malformed scope", value: malformedScope },
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
