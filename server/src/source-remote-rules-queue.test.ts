import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DownloadQueue, REMOTE_DOWNLOAD_MARKER, type DownloadJob, type DownloadSelection, type RemoteDownloadBackend } from "./downloads.js";
import { SourceError } from "./download-policy.js";
import { relativeWithin, type LibraryRecord } from "./libraries.js";
import { remoteDownloadKey, type RemoteDownloadReference } from "./media-server-download.js";
import { defaultDownloadSettings } from "./naming.js";
import { materializeSourceAdmissionPolicy, parseSourceAdmissionSnapshotV1, type SourceAdmissionSnapshotV1 } from "./source-admission.js";
import { rulesPolicy } from "./download-rules.js";
import type { RulesProfileResolution } from "./source-profile-resolver.js";
import { RULE_PRESETS, SOURCE_PROFILE_IDS } from "./source-profiles.js";
import type { StreamItem } from "./types.js";

const OWNER = "usr_00000051";
const LIBRARY_ID = "lib_51000001";
const REMOTE_LIBRARY = `rlib_${"6".repeat(32)}`;
const REMOTE_KEY = `remote:${REMOTE_LIBRARY}`;
const BODY = Buffer.from("remote rules fixture bytes");
const SUBTITLES = [
  { index: 2, language: "cs" },
  { index: 5, language: "en" },
];

const library = (root: string): LibraryRecord => ({
  id: LIBRARY_ID,
  name: "Downloads",
  type: "mixed",
  root,
  enabled: true,
  order: 0,
  addedAt: "2026-01-01T00:00:00.000Z",
  writeArtwork: false,
  visibleTo: [OWNER],
});

const selection = (): DownloadSelection => ({
  addonKeys: [],
  sourceStrategy: "priority",
  audioLanguage: "cs",
  audioMode: "preferred",
  subtitleMode: "optional",
  subtitleLanguage: "en",
  targetSettings: defaultDownloadSettings().series,
});

const snapshot = (): SourceAdmissionSnapshotV1 => {
  const preset = RULE_PRESETS.find((candidate) => candidate.id === SOURCE_PROFILE_IDS.balanced);
  assert.ok(preset);
  return parseSourceAdmissionSnapshotV1({
    schemaVersion: 1,
    profile: { id: preset.id, revision: 1, template: "rules" },
    operation: "downloadToLibrary",
    providerKeys: [REMOTE_KEY],
    policy: materializeSourceAdmissionPolicy(
      rulesPolicy(preset.rules, "episode"),
      [REMOTE_KEY],
      { audioLanguage: "cs", subtitleLanguage: "en" },
    ),
  });
};

const reference = (): RemoteDownloadReference => ({
  schemaVersion: 1,
  ownerUserId: OWNER,
  connectionId: `mconn_${"7".repeat(32)}`,
  libraryId: REMOTE_LIBRARY,
  generation: 1,
  provider: "jellyfin",
  serverId: "server-1",
  accountId: "account-1",
  itemId: "episode-1",
  mediaSourceId: "version-1",
  subtitles: SUBTITLES,
});

const stream = (): StreamItem => ({
  name: "Show.S01E02.1080p.mkv",
  behaviorHints: { filename: "Show.S01E02.1080p.mkv", videoSize: BODY.length },
});

const selectedRemote = (): RulesProfileResolution => ({
  status: "selected",
  remoteDownload: reference(),
  stream: stream(),
  resolution: {
    checkedCandidates: 1,
    audioLanguage: "cs",
    audioEvidence: "metadata",
    subtitleStatus: "missing",
  },
  searchStatus: "complete",
  retryable: false,
  observations: {
    probesUsed: 0,
    confirmedRejections: 0,
    temporaryFailures: 0,
    accessDenials: 0,
    unresolvedCandidates: 0,
  },
});

const backend = (state: { allowed: boolean; opens: number; revalidations: number; subtitles: number[] }): RemoteDownloadBackend => ({
  current: () => state.allowed,
  open: async (_job, _args, _signal) => {
    state.opens += 1;
    return new Response(BODY, {
      status: 200,
      headers: { "content-length": String(BODY.length) },
    });
  },
  revalidate: async () => { state.revalidations += 1; },
  readSubtitle: async (_job, subtitle) => {
    state.subtitles.push(subtitle.index);
    return {
      bytes: new TextEncoder().encode(`1\n00:00:01,000 --> 00:00:02,000\n${subtitle.language ?? "unknown"}\n`),
      contentType: "application/x-subrip",
    };
  },
});

const waitFor = async (queue: DownloadQueue, predicate: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout: ${JSON.stringify(queue.snapshot())}`);
};

const setup = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-remote-rules-"));
  const data = path.join(directory, "data");
  const downloads = path.join(directory, "downloads");
  await mkdir(data, { recursive: true });
  await mkdir(downloads, { recursive: true });
  return { directory, data, downloads };
};

const openQueue = (
  data: string,
  downloads: string,
  remote: RemoteDownloadBackend,
  ownerAllowed: () => boolean = () => true,
) => {
  const root = library(downloads);
  return new DownloadQueue(() => 1, () => 1, data, downloads, {
    libraries: () => [root],
    defaultLibrary: () => root,
    ownerAllowed,
    remoteDownload: remote,
    freeSpace: async () => ({ freeBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 }),
    retryDelay: () => 5,
  });
};

const addRemoteJob = async (queue: DownloadQueue) => {
  const added = await queue.addPending(
    "Show S01E02",
    { type: "series", videoId: "tt-show:1:2", selection: selection() },
    { kind: "episode", title: "Show", season: 1, episode: 2 },
    OWNER,
    undefined,
    snapshot(),
  );
  assert.ok(added);
  return added;
};

test("a rules remote selection stages and completes through the remote-copy backend", async () => {
  const { directory, data, downloads } = await setup();
  const state = { allowed: true, opens: 0, revalidations: 0, subtitles: [] as number[] };
  const queue = openQueue(data, downloads, backend(state));
  queue.setRulesResolver(async () => selectedRemote());
  await queue.load();
  try {
    const added = await addRemoteJob(queue);
    await waitFor(queue, () => queue.get(added.id)?.status === "completed");
    const completed = queue.get(added.id)!;
    const internal = (queue as unknown as { jobs: DownloadJob[] }).jobs[0]!;
    assert.deepEqual(internal.remoteDownload, reference());
    assert.equal(internal.stream?.url, REMOTE_DOWNLOAD_MARKER);
    assert.equal(internal.stream?.behaviorHints?.filename, "Show.S01E02.1080p.mkv");
    assert.equal(state.opens, 1);
    assert.deepEqual(state.subtitles, [2, 5]);
    assert.equal(
      await readFile(path.join(downloads, relativeWithin(LIBRARY_ID, completed.target)), "utf8"),
      BODY.toString(),
    );
    const directory = path.dirname(path.join(downloads, relativeWithin(LIBRARY_ID, completed.target)));
    assert.match(await readFile(path.join(directory, "Show - S01E02.cs.srt"), "utf8"), /cs/);
    assert.match(await readFile(path.join(directory, "Show - S01E02.en.srt"), "utf8"), /en/);

    await queue.stop();
    const reopened = openQueue(data, downloads, backend(state));
    await reopened.load();
    try {
      assert.equal(reopened.get(added.id)?.status, "completed");
      assert.equal(state.opens, 1, "restart does not copy the persisted reference again");
      assert.equal(reopened.list().length, 1, "restart does not duplicate the completed job");
      assert.equal(
        await readFile(path.join(downloads, relativeWithin(LIBRARY_ID, completed.target)), "utf8"),
        BODY.toString(),
      );
    } finally {
      await reopened.stop();
    }
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a rule naming a subtitle language copies only that external track", async () => {
  const { directory, data, downloads } = await setup();
  const state = { allowed: true, opens: 0, revalidations: 0, subtitles: [] as number[] };
  const queue = openQueue(data, downloads, backend(state));
  queue.setRulesResolver(async () => {
    const selected = selectedRemote();
    if (selected.status !== "selected") throw new Error("The remote fixture did not select a source.");
    return {
      ...selected,
      resolution: { ...selected.resolution, subtitleLanguage: "en" },
    };
  });
  await queue.load();
  try {
    const added = await addRemoteJob(queue);
    await waitFor(queue, () => queue.get(added.id)?.status === "completed");
    const internal = (queue as unknown as { jobs: DownloadJob[] }).jobs[0]!;
    assert.deepEqual(internal.remoteDownload?.subtitles, [{ index: 5, language: "en" }]);
    assert.deepEqual(state.subtitles, [5]);
    const directory = path.dirname(path.join(downloads, relativeWithin(LIBRARY_ID, queue.get(added.id)!.target)));
    await assert.rejects(readFile(path.join(directory, "Show - S01E02.cs.srt")));
    assert.match(await readFile(path.join(directory, "Show - S01E02.en.srt"), "utf8"), /en/);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("permission removed after admission pauses a staged rules remote copy before bytes", async () => {
  const { directory, data, downloads } = await setup();
  const state = { allowed: true, opens: 0, revalidations: 0, subtitles: [] as number[] };
  let allowed = true;
  const queue = openQueue(data, downloads, backend(state), () => allowed);
  queue.setRulesResolver(async () => {
    allowed = false;
    state.allowed = false;
    return selectedRemote();
  });
  await queue.load();
  try {
    const added = await addRemoteJob(queue);
    await waitFor(queue, () => queue.get(added.id)?.pauseReason === "permission");
    assert.equal(queue.get(added.id)?.status, "paused");
    assert.equal(state.opens, 0);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed staged rules remote source is added to tried for the next selection", async () => {
  const { directory, data, downloads } = await setup();
  const state = { allowed: true, opens: 0, revalidations: 0, subtitles: [] as number[], fail: true };
  const remote: RemoteDownloadBackend = {
    ...backend(state),
    open: async () => {
      state.opens += 1;
      if (state.fail) {
        state.fail = false;
        throw new SourceError("The original is gone.");
      }
      return new Response(BODY, { status: 200, headers: { "content-length": String(BODY.length) } });
    },
  };
  const queue = openQueue(data, downloads, remote);
  const remoteSourceId = `remote:${remoteDownloadKey(reference())}`;
  queue.setRulesResolver(async ({ source: input }) => input.tried.includes(remoteSourceId)
    ? {
        status: "noMatch",
        retryable: false,
        observations: {
          probesUsed: 0,
          confirmedRejections: 0,
          temporaryFailures: 0,
          accessDenials: 0,
          unresolvedCandidates: 0,
        },
      }
    : selectedRemote());
  await queue.load();
  try {
    const added = await addRemoteJob(queue);
    await waitFor(queue, () => queue.get(added.id)?.status === "failed");
    const internal = (queue as unknown as { jobs: DownloadJob[] }).jobs[0]!;
    assert.equal(internal.source?.tried.includes(remoteSourceId), true);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
