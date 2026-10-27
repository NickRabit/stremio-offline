import assert from "node:assert/strict";
import test from "node:test";
import { torrentKey } from "./download-selection.js";
import type { MediaInfo } from "./probe.js";
import {
  materializeSourceAdmissionPolicy,
  parseSourceAdmissionSnapshotV1,
  type SourceAdmissionSnapshotV1,
} from "./source-admission.js";
import {
  ProviderPrioritySnapshotError,
  selectProviderPriorityDownloadSource,
  type SelectProviderPriorityDownloadInput,
} from "./source-provider-priority.js";
import {
  buildTemplatePolicy,
  SOURCE_PROFILE_DEFINITIONS,
  SOURCE_PROFILE_IDS,
} from "./source-profiles.js";
import type { StreamItem, SubtitleItem } from "./types.js";

const HASH_A = "59e11cef8c2152ac73681092844ebd3db19025bc";
const HASH_B = "1111111111111111111111111111111111111111";

const providerPriorityDefinition = SOURCE_PROFILE_DEFINITIONS.find((definition) =>
  definition.id === SOURCE_PROFILE_IDS.providerPriority);
const travelDefinition = SOURCE_PROFILE_DEFINITIONS.find((definition) =>
  definition.id === SOURCE_PROFILE_IDS.travel);
assert.ok(providerPriorityDefinition);
assert.ok(travelDefinition);

const snapshot = (
  providerKeys: string[] = ["addon:one"],
  operation: SourceAdmissionSnapshotV1["operation"] = "downloadToLibrary",
): SourceAdmissionSnapshotV1 => parseSourceAdmissionSnapshotV1({
  schemaVersion: 1,
  profile: { id: SOURCE_PROFILE_IDS.providerPriority, revision: 1 },
  operation,
  providerKeys,
  policy: materializeSourceAdmissionPolicy(
    providerPriorityDefinition.policy,
    providerKeys,
    { audioLanguage: "en", subtitleLanguage: "en" },
  ),
});

const travelSnapshot = (): SourceAdmissionSnapshotV1 => {
  const providerKeys = ["addon:one"];
  return parseSourceAdmissionSnapshotV1({
    schemaVersion: 1,
    profile: { id: SOURCE_PROFILE_IDS.travel, revision: 1 },
    operation: "downloadToLibrary",
    providerKeys,
    policy: materializeSourceAdmissionPolicy(
      travelDefinition.policy,
      providerKeys,
      { audioLanguage: "en", subtitleLanguage: "en" },
    ),
  });
};

const stream = (
  addonKey: string,
  url: string,
  input: {
    name?: string;
    size?: number;
    addonName?: string;
    infoHash?: string;
    fileIdx?: number;
  } = {},
): StreamItem => ({
  addonKey,
  addonName: input.addonName,
  url,
  ...(input.name === undefined ? {} : { name: input.name }),
  ...(input.size === undefined ? {} : { behaviorHints: { videoSize: input.size } }),
  ...(input.infoHash === undefined ? {} : { infoHash: input.infoHash }),
  ...(input.fileIdx === undefined ? {} : { fileIdx: input.fileIdx }),
});

const media = (audio: readonly (string | undefined)[] = ["en"], duration = 3_600): MediaInfo => ({
  container: "matroska",
  duration,
  video: { codec: "h264", height: 1080 },
  audioTracks: audio.map((language, index) => ({
    index,
    codec: "aac",
    ...(language === undefined ? {} : { language }),
  })),
  subtitleTracks: [],
});

type SelectionOverrides = Partial<Omit<SelectProviderPriorityDownloadInput, "snapshot" | "streams">>;

const select = (
  admission: SourceAdmissionSnapshotV1,
  streams: readonly StreamItem[],
  overrides: SelectionOverrides = {},
) => selectProviderPriorityDownloadSource({
  snapshot: admission,
  streams,
  externalSubtitles: [],
  tried: [],
  episode: false,
  hasRealDebrid: false,
  inspect: async () => media(),
  shouldContinue: () => true,
  ...overrides,
});

const freeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
};

test("same-name providers keep explicit keys and frozen provider order", async () => {
  const beta = stream("beta", "https://media.example/beta.mkv", {
    addonName: "Shared name",
    name: "English",
    size: 1,
  });
  const alpha = stream("alpha", "https://media.example/alpha.mkv", {
    addonName: "Shared name",
    name: "English",
    size: 100,
  });
  const result = await select(snapshot(["addon:beta", "addon:alpha"]), [alpha, beta]);

  assert.equal(result.status, "selected");
  assert.equal(result.addonKey, "beta");
  assert.equal(result.stream, beta);
  assert.equal(result.candidate.providerKey, "addon:beta");
  assert.ok(result.info);
});

test("provider order outranks preferred audio", async () => {
  const highPriority = stream("high", "https://media.example/high.mkv", {
    name: "Czech release",
    size: 10,
  });
  const lowPriority = stream("low", "https://media.example/low.mkv", {
    name: "English release",
    size: 100,
  });
  const result = await select(
    snapshot(["addon:high", "addon:low"]),
    [lowPriority, highPriority],
    {
      inspect: async (candidate) => candidate === highPriority ? media(["cs"]) : media(["en"]),
    },
  );

  assert.equal(result.status, "selected");
  assert.equal(result.stream, highPriority);
  assert.equal(result.candidate.providerKey, "addon:high");
});

test("audio tier outranks size within one provider", async () => {
  const largeOtherAudio = stream("one", "https://media.example/large.mkv", { size: 300 });
  const smallPreferredAudio = stream("one", "https://media.example/small.mkv", { size: 1 });
  const inspected: StreamItem[] = [];
  const result = await select(snapshot(), [smallPreferredAudio, largeOtherAudio], {
    inspect: async (candidate) => {
      inspected.push(candidate);
      return candidate === smallPreferredAudio ? media(["en"]) : media(["cs"]);
    },
  });

  assert.equal(result.status, "selected");
  assert.equal(result.stream, smallPreferredAudio);
  assert.deepEqual(inspected, [largeOtherAudio, smallPreferredAudio]);
});

test("listed size sorts descending and unknown size sorts last", async () => {
  const large = stream("one", "https://media.example/large.mkv", { size: 300 });
  const medium = stream("one", "https://media.example/medium.mkv", { size: 200 });
  const unknown = stream("one", "https://media.example/unknown.mkv");
  const inspected: StreamItem[] = [];
  const result = await select(snapshot(), [unknown, medium, large], {
    inspect: async (candidate) => {
      inspected.push(candidate);
      return media(["en"]);
    },
  });

  assert.equal(result.status, "selected");
  assert.equal(result.stream, large);
  assert.deepEqual(inspected, [large, medium, unknown]);
});

test("source identity ties use response order and count before filtering", async () => {
  const filtered = {
    ...stream("one", "https://media.example/filtered.mkv"),
    externalUrl: "https://addon.example/watch",
  };
  const first = stream("one", "https://media.example/same.mkv", { size: 10 });
  const second = stream("one", "https://media.example/same.mkv", { size: 10 });
  const result = await select(snapshot(), [filtered, first, second], {
    tried: [filtered.url!],
  });

  assert.equal(result.status, "selected");
  assert.equal(result.stream, first);
  assert.equal(result.candidate.providerResponseIndex, 1);
  assert.equal(result.checkedCandidates, 2);
});

test("a dead high-priority provider falls through to the next provider", async () => {
  const dead = stream("high", "https://media.example/dead.mkv", { name: "English" });
  const live = stream("low", "https://media.example/live.mkv", { name: "English" });
  const result = await select(snapshot(["addon:high", "addon:low"]), [dead, live], {
    inspect: async (candidate) => {
      if (candidate === dead) throw new Error("probe failed");
      return media(["en"]);
    },
  });

  assert.equal(result.status, "selected");
  assert.equal(result.stream, live);
  assert.equal(result.checkedCandidates, 2);
  assert.equal(result.temporaryFailures, 1);
});

test("the HTTP probe cap is shared across providers and reports truncation", async () => {
  const streams = Array.from({ length: 16 }, (_entry, index) => stream(
    index < 8 ? "one" : "two",
    `https://media.example/candidate-${index}.mkv`,
    { size: 16 - index },
  ));
  const inspected: StreamItem[] = [];
  const result = await select(snapshot(["addon:one", "addon:two"]), streams, {
    inspect: async (candidate) => {
      inspected.push(candidate);
      return candidate === streams[15] ? media(["en"]) : undefined;
    },
  });

  assert.equal(result.status, "noMatch");
  assert.equal(result.checkedCandidates, 15);
  assert.equal(result.temporaryFailures, 15);
  assert.equal(result.truncated, true);
  assert.equal(inspected.length, 15);
  assert.equal(inspected.includes(streams[15]!), false);
});

test("short samples and probes without video or audio are rejected", async () => {
  const short = stream("one", "https://media.example/short.mkv");
  const result = await select(snapshot(), [short], {
    inspect: async () => media(["en"], 59),
  });
  assert.deepEqual(result, {
    status: "noMatch",
    checkedCandidates: 1,
    temporaryFailures: 0,
    truncated: false,
  });

  for (const info of [
    { ...media(["en"]), video: undefined },
    media([]),
  ] satisfies MediaInfo[]) {
    const missing = await select(snapshot(), [short], { inspect: async () => info });
    assert.equal(missing.status, "noMatch");
    assert.equal(missing.temporaryFailures, 1);
  }
});

test("tried HTTP URLs and torrent keys are never inspected or selected", async () => {
  const triedHttp = stream("one", "https://media.example/tried.mkv");
  const freshHttp = stream("one", "https://media.example/fresh.mkv");
  const httpInspected: StreamItem[] = [];
  const httpResult = await select(snapshot(), [triedHttp, freshHttp], {
    tried: [triedHttp.url!],
    inspect: async (candidate) => {
      httpInspected.push(candidate);
      return media(["en"]);
    },
  });
  assert.equal(httpResult.status, "selected");
  assert.equal(httpResult.stream, freshHttp);
  assert.deepEqual(httpInspected, [freshHttp]);

  const triedTorrent = { addonKey: "one", addonName: "Torrents", infoHash: HASH_A } satisfies StreamItem;
  const freshTorrent = { addonKey: "one", addonName: "Torrents", infoHash: HASH_B } satisfies StreamItem;
  const torrentResult = await select(snapshot(), [triedTorrent, freshTorrent], {
    tried: [torrentKey(triedTorrent)],
    hasRealDebrid: true,
  });
  assert.equal(torrentResult.status, "selected");
  assert.equal(torrentResult.stream, freshTorrent);
  assert.equal("info" in torrentResult, false);
});

test("cancellation after a deferred probe never publishes a stale winner", async () => {
  const candidate = stream("one", "https://media.example/slow.mkv");
  let continueSelection = true;
  let finishProbe!: () => void;
  const probe = new Promise<void>((resolve) => {
    finishProbe = resolve;
  });
  const pending = select(snapshot(), [candidate], {
    shouldContinue: () => continueSelection,
    inspect: async () => {
      await probe;
      return media(["en"]);
    },
  });

  await Promise.resolve();
  continueSelection = false;
  finishProbe();
  assert.deepEqual(await pending, { status: "cancelled" });
});

test("eligible HTTP wins before a higher-priority torrent", async () => {
  const torrent = { addonKey: "high", infoHash: HASH_A } satisfies StreamItem;
  const http = stream("low", "https://media.example/http.mkv");
  const result = await select(snapshot(["addon:high", "addon:low"]), [torrent, http], {
    hasRealDebrid: true,
  });

  assert.equal(result.status, "selected");
  assert.equal(result.stream, http);
  assert.ok(result.info);
});

test("torrent fallback requires Real-Debrid", async () => {
  const torrent = { addonKey: "one", infoHash: HASH_A } satisfies StreamItem;
  const result = await select(snapshot(), [torrent], { hasRealDebrid: false });
  assert.deepEqual(result, {
    status: "noMatch",
    checkedCandidates: 0,
    temporaryFailures: 0,
    truncated: false,
  });
});

test("torrent fallback preserves provider priority before listed audio", async () => {
  const high = { addonKey: "high", infoHash: HASH_A, name: "Czech" } satisfies StreamItem;
  const low = { addonKey: "low", infoHash: HASH_B, name: "English" } satisfies StreamItem;
  const result = await select(snapshot(["addon:high", "addon:low"]), [low, high], {
    hasRealDebrid: true,
  });
  assert.equal(result.status, "selected");
  assert.equal(result.stream, high);
  assert.equal(result.checkedCandidates, 0);
});

test("a stored Provider priority variant excludes torrents and prefers the smaller HTTP file", async () => {
  const providerKeys = ["addon:one"];
  const variant = parseSourceAdmissionSnapshotV1({
    schemaVersion: 1,
    profile: { id: "fb0c7e77-e13e-4d14-9986-04b37fb72d95", revision: 1, template: "providerPriority" },
    operation: "downloadToLibrary",
    providerKeys,
    policy: materializeSourceAdmissionPolicy(
      buildTemplatePolicy("providerPriority", {
        scope: { mode: "allAvailable" },
        providerOrder: { from: "viewer" },
        sizeDirection: "asc",
        transfer: ["http"],
        audioMode: "preferred",
        subtitleMode: "optional",
      }),
      providerKeys,
      { audioLanguage: "en", subtitleLanguage: "en" },
    ),
  });
  const large = stream("one", "https://media.example/large.mkv", { size: 300 });
  const small = stream("one", "https://media.example/small.mkv", { size: 10 });
  const torrent = { addonKey: "one", infoHash: HASH_A } satisfies StreamItem;
  const result = await select(variant, [large, torrent, small], { hasRealDebrid: true });

  assert.equal(result.status, "selected");
  assert.equal(result.stream, small);
});

test("a cancelled torrent-only selection publishes no source", async () => {
  const torrent = { addonKey: "one", infoHash: HASH_A } satisfies StreamItem;
  const result = await select(snapshot(), [torrent], {
    hasRealDebrid: true,
    shouldContinue: () => false,
  });
  assert.deepEqual(result, { status: "cancelled" });
});

test("episodes require a valid torrent file index", async () => {
  const missing = { addonKey: "one", infoHash: HASH_A } satisfies StreamItem;
  const negative = { addonKey: "one", infoHash: HASH_B, fileIdx: -1 } satisfies StreamItem;
  const valid = {
    addonKey: "one",
    infoHash: "2222222222222222222222222222222222222222",
    fileIdx: 0,
  } satisfies StreamItem;
  const result = await select(snapshot(), [missing, negative, valid], {
    episode: true,
    hasRealDebrid: true,
  });

  assert.equal(result.status, "selected");
  assert.equal(result.stream, valid);
  assert.equal(result.candidate.providerResponseIndex, 2);
});

test("malformed, other-profile and other-operation snapshots use the dedicated error", async () => {
  const malformed = {
    ...snapshot(),
    schemaVersion: 2,
  } as unknown as SourceAdmissionSnapshotV1;
  for (const admission of [malformed, travelSnapshot(), snapshot(["addon:one"], "play")]) {
    await assert.rejects(
      select(admission, []),
      (error: unknown) => error instanceof ProviderPrioritySnapshotError
        && error.message === "Invalid Provider priority source snapshot.",
    );
  }
});

test("selection does not mutate its inputs", async () => {
  const subtitle: SubtitleItem = { url: "https://subs.example/en.srt", lang: "English" };
  const inputs = freeze({
    snapshot: snapshot(["addon:high", "addon:low"]),
    streams: [
      stream("low", "https://media.example/low.mkv", { name: "English", size: 10 }),
      stream("high", "https://media.example/high.mkv", { name: "English", size: 20 }),
    ],
    externalSubtitles: [subtitle],
    tried: ["https://media.example/tried.mkv"],
  });
  const before = structuredClone(inputs);
  const result = await select(inputs.snapshot, inputs.streams, {
    externalSubtitles: inputs.externalSubtitles,
    tried: inputs.tried,
  });

  assert.equal(result.status, "selected");
  assert.deepEqual(inputs, before);
});
