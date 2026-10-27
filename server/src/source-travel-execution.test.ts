import assert from "node:assert/strict";
import test from "node:test";
import type { MediaInfo } from "./probe.js";
import {
  materializeSourceAdmissionPolicy,
  type SourceAdmissionSnapshotV1,
} from "./source-admission.js";
import {
  parseSourcePolicyV1,
} from "./source-policy.js";
import {
  SOURCE_PROFILE_DEFINITIONS,
  SOURCE_PROFILE_IDS,
} from "./source-profiles.js";
import { verifyTravelAddonStreams } from "./source-travel-execution.js";
import { TRAVEL_INSPECTION_BUDGET } from "./source-travel.js";
import type { StreamItem, SubtitleItem } from "./types.js";

const travelDefinition = SOURCE_PROFILE_DEFINITIONS.find((definition) =>
  definition.id === SOURCE_PROFILE_IDS.travel);
assert.ok(travelDefinition);

interface SnapshotOptions {
  readonly preferredAudio?: string;
  readonly fallbackAudio?: string;
  readonly subtitleMode?: "off" | "optional" | "required";
  readonly preferredSubtitle?: string;
  readonly fallbackSubtitle?: string;
}

const snapshot = (
  providerKeys: string[] = ["addon:one"],
  options: SnapshotOptions = {},
): SourceAdmissionSnapshotV1 => {
  const source = structuredClone(travelDefinition.policy);
  source.constraints.audio = {
    mode: "preferred",
    preferred: { code: options.preferredAudio ?? "en" },
    ...(options.fallbackAudio === undefined ? {} : { fallback: { code: options.fallbackAudio } }),
  };
  const subtitleMode = options.subtitleMode ?? "optional";
  source.constraints.subtitles = subtitleMode === "off"
    ? { mode: "off" }
    : {
      mode: subtitleMode,
      preferred: { code: options.preferredSubtitle ?? "en" },
      ...(options.fallbackSubtitle === undefined ? {} : { fallback: { code: options.fallbackSubtitle } }),
    };
  const policy = parseSourcePolicyV1(source);
  return {
    schemaVersion: 1,
    profile: { id: SOURCE_PROFILE_IDS.travel, revision: 1 },
    operation: "downloadToLibrary",
    providerKeys,
    policy: materializeSourceAdmissionPolicy(policy, providerKeys, {}),
  };
};

const mediaInfo = (input: {
  readonly height?: number;
  readonly duration?: number;
  readonly video?: false;
  readonly audio?: readonly (string | undefined)[];
  readonly subtitles?: readonly (string | undefined)[];
} = {}): MediaInfo => ({
  container: "matroska",
  duration: input.duration ?? 3_600,
  ...(input.video === false
    ? {}
    : { video: { codec: "h264", height: input.height ?? 480 } }),
  audioTracks: (input.audio ?? ["en"]).map((language, index) => ({
    index,
    codec: "aac",
    ...(language === undefined ? {} : { language }),
  })),
  subtitleTracks: (input.subtitles ?? []).map((language, index) => ({
    index,
    codec: "subrip",
    ...(language === undefined ? {} : { language }),
  })),
});

const stream = (
  url: string,
  size: number,
  input: Partial<StreamItem> = {},
): StreamItem => ({
  url,
  addonKey: "one",
  name: "English release",
  title: "Episode",
  behaviorHints: { videoSize: size },
  ...input,
});

const always = () => true;

test("signed URL rotation resumes at the valid sixteenth addon row", async () => {
  const listing = (token: string): StreamItem[] => [
    ...Array.from({ length: TRAVEL_INSPECTION_BUDGET }, (_entry, index) => stream(
      `https://media.example/sample-${index}.mkv?token=${token}`,
      index + 1,
      { title: `Sample ${index}` },
    )),
    stream(`https://media.example/episode.mkv?token=${token}`, 100, { title: "Full episode" }),
  ];
  const firstStreams = listing("first-secret");
  const secondStreams = listing("second-secret");
  const firstCalls: string[] = [];

  const first = await verifyTravelAddonStreams({
    snapshot: snapshot(),
    streams: firstStreams,
    externalSubtitles: [],
    inspect: async (item) => {
      firstCalls.push(item.url!);
      return mediaInfo({
        height: item.title === "Full episode" ? 480 : 360,
        audio: ["en"],
      });
    },
    shouldContinue: always,
    scopeStamp: "signed-url-continuation",
  });

  assert.equal(first.status, "budgetExhausted");
  assert.equal(first.observations.probesUsed, TRAVEL_INSPECTION_BUDGET);
  assert.equal(firstCalls.length, TRAVEL_INSPECTION_BUDGET);
  assert.doesNotMatch(JSON.stringify(first), /media\.example|token=|secret/i);

  const secondCalls: string[] = [];
  const second = await verifyTravelAddonStreams({
    snapshot: snapshot(),
    streams: secondStreams,
    externalSubtitles: [],
    inspect: async (item) => {
      secondCalls.push(item.url!);
      return mediaInfo({
        height: item.title === "Full episode" ? 480 : 360,
        audio: ["en"],
      });
    },
    shouldContinue: always,
    scopeStamp: "signed-url-continuation",
    cursor: first.cursor,
  });

  assert.equal(second.status, "selected");
  assert.equal(second.stream, secondStreams[TRAVEL_INSPECTION_BUDGET]);
  assert.equal(secondCalls[0], secondStreams[TRAVEL_INSPECTION_BUDGET]!.url);
  assert.ok(second.observations.probesUsed <= TRAVEL_INSPECTION_BUDGET);
  assert.doesNotMatch(JSON.stringify(second.cursor), /media\.example|token=|secret/i);
});

test("scope and transport shape are filtered before inspection", async () => {
  const selected = stream("https://media.example/selected.mkv", 10);
  const calls: string[] = [];
  const result = await verifyTravelAddonStreams({
    snapshot: snapshot(["addon:one"]),
    streams: [
      { url: "https://media.example/no-addon.mkv", behaviorHints: { videoSize: 1 } },
      stream("https://media.example/other.mkv", 2, { addonKey: "two" }),
      stream("https://media.example/torrent.mkv", 3, { url: undefined, infoHash: "a".repeat(40) }),
      stream("file:///media/remote.mkv", 4),
      stream("https://media.example/external.mkv", 5, {
        url: undefined,
        externalUrl: "https://media.example/external.mkv",
      }),
      selected,
    ],
    externalSubtitles: [],
    inspect: async (item) => {
      calls.push(item.url!);
      return mediaInfo({ audio: ["en"] });
    },
    shouldContinue: always,
    scopeStamp: "scope-filter",
  });

  assert.equal(result.status, "selected");
  assert.equal(result.stream, selected);
  assert.deepEqual(calls, [selected.url]);
});

test("the 480px floor and actual audio and subtitle track metadata decide the result", async () => {
  const small = stream("https://media.example/small.mkv", 1);
  const accepted = stream("https://media.example/accepted.mkv", 2);
  const preferredSubtitle: SubtitleItem = {
    url: "https://subs.example/preferred.srt",
    lang: "cze",
    addonKey: "subs",
  };
  const fallbackSubtitle: SubtitleItem = {
    url: "https://subs.example/fallback.srt",
    lang: "English",
    addonKey: "subs",
  };
  const calls: string[] = [];

  const result = await verifyTravelAddonStreams({
    snapshot: snapshot(["addon:one"], {
      preferredAudio: "cs",
      fallbackAudio: "en",
      preferredSubtitle: "cs",
      fallbackSubtitle: "en",
    }),
    streams: [small, accepted],
    externalSubtitles: [fallbackSubtitle, preferredSubtitle],
    inspect: async (item) => {
      calls.push(item.url!);
      return item === small
        ? mediaInfo({ height: 479, audio: ["cs"], subtitles: ["cs"] })
        : mediaInfo({ height: 480, audio: ["en", "de"], subtitles: ["en"] });
    },
    shouldContinue: always,
    scopeStamp: "quality-metadata",
  });

  assert.equal(result.status, "selected");
  assert.equal(result.stream, accepted);
  assert.deepEqual(calls, [small.url, accepted.url]);
  assert.equal(result.resolution.checkedCandidates, 2);
  assert.equal(result.resolution.audioLanguage, "en");
  assert.equal(result.resolution.audioTrack, 0);
  assert.equal(result.resolution.fallbackUsed, true);
  assert.equal(result.resolution.audioEvidence, "probe");
  assert.equal(result.resolution.subtitleLanguage, "cs");
  assert.equal(result.resolution.subtitleSource, "addon");
  assert.equal(result.resolution.subtitleStatus, "ready");
  assert.equal(result.subtitle, preferredSubtitle);
});

test("Travel selects the smaller eligible stream from its listing size hint", async () => {
  const large = stream("https://media.example/large-eligible.mkv", 200);
  const small = stream("https://media.example/small-eligible.mkv", 100);
  const calls: string[] = [];
  const result = await verifyTravelAddonStreams({
    snapshot: snapshot(["addon:one"], { subtitleMode: "off" }),
    streams: [large, small],
    externalSubtitles: [],
    inspect: async (item) => {
      calls.push(item.url!);
      return mediaInfo({ audio: ["en"] });
    },
    shouldContinue: always,
    scopeStamp: "listed-size-soft-ranking",
  });

  assert.equal(result.status, "selected");
  assert.equal(result.stream, small);
  assert.deepEqual(calls, [small.url, large.url]);
  assert.equal(result.resolution.checkedCandidates, 2);
});

test("an untagged probed track uses the listed preferred language", async () => {
  const selected = stream("https://media.example/untagged-preferred.mkv", 1, {
    name: "Czech audio",
    title: "Episode",
  });
  const result = await verifyTravelAddonStreams({
    snapshot: snapshot(["addon:one"], {
      preferredAudio: "cs",
      fallbackAudio: "en",
      subtitleMode: "off",
    }),
    streams: [selected],
    externalSubtitles: [],
    inspect: async () => mediaInfo({ audio: [undefined] }),
    shouldContinue: always,
    scopeStamp: "untagged-listed-audio",
  });

  assert.equal(result.status, "selected");
  assert.equal(result.resolution.audioLanguage, "cs");
  assert.equal(result.resolution.audioTrack, 0);
  assert.equal(result.resolution.fallbackUsed, false);
  assert.equal(result.resolution.audioEvidence, "listing");
});

test("an untagged track with no policy language in the listing stays unlabelled", async () => {
  const selected = stream("https://media.example/untagged-other.mkv", 1, {
    name: "Release",
    title: "Episode",
  });
  const result = await verifyTravelAddonStreams({
    snapshot: snapshot(["addon:one"], {
      preferredAudio: "cs",
      fallbackAudio: "de",
      subtitleMode: "off",
    }),
    streams: [selected],
    externalSubtitles: [],
    inspect: async () => ({
      container: "matroska",
      duration: 3_600,
      video: { codec: "h264", height: 480 },
      audioTracks: [{ index: 3, codec: "aac" }],
      subtitleTracks: [],
    }),
    shouldContinue: always,
    scopeStamp: "untagged-no-listed-audio",
  });

  assert.equal(result.status, "selected");
  assert.equal(result.resolution.audioLanguage, undefined);
  assert.equal(result.resolution.audioTrack, 3);
  assert.equal(result.resolution.fallbackUsed, true);
  assert.equal(result.resolution.audioEvidence, "none");
});

test("an unmatched inspected track is recorded as other audio", async () => {
  const selected = stream("https://media.example/german.mkv", 1, {
    name: "Release",
    title: "Episode",
  });
  const result = await verifyTravelAddonStreams({
    snapshot: snapshot(["addon:one"], { preferredAudio: "cs" }),
    streams: [selected],
    externalSubtitles: [],
    inspect: async () => ({
      container: "matroska",
      duration: 3_600,
      video: { codec: "h264", height: 480 },
      audioTracks: [{ index: 2, codec: "aac", language: "de" }],
      subtitleTracks: [],
    }),
    shouldContinue: always,
    scopeStamp: "other-audio",
  });

  assert.equal(result.status, "selected");
  assert.equal(result.stream, selected);
  assert.equal(result.resolution.audioLanguage, "de");
  assert.equal(result.resolution.audioTrack, 2);
  assert.equal(result.resolution.fallbackUsed, true);
  assert.equal(result.resolution.audioEvidence, "probe");
});

test("invalid media is rejected while failed or missing probes remain retryable", async () => {
  const invalid = stream("https://media.example/invalid.mkv", 1);
  for (const info of [
    mediaInfo({ video: false, audio: ["en"] }),
    mediaInfo({ audio: [] }),
  ]) {
    const result = await verifyTravelAddonStreams({
      snapshot: snapshot(),
      streams: [invalid],
      externalSubtitles: [],
      inspect: async () => info,
      shouldContinue: always,
      scopeStamp: "invalid-media",
    });
    assert.equal(result.status, "noMatch");
    assert.doesNotMatch(JSON.stringify(result), /media\.example/);
  }

  for (const inspect of [
    async () => undefined,
    async (): Promise<MediaInfo> => {
      throw new Error("probe transport failed");
    },
  ]) {
    const result = await verifyTravelAddonStreams({
      snapshot: snapshot(),
      streams: [invalid],
      externalSubtitles: [],
      inspect,
      shouldContinue: always,
      scopeStamp: "failed-probe",
    });
    assert.equal(result.status, "temporaryFailure");
    assert.equal(result.retryable, true);
    assert.ok("cursor" in result);
    assert.doesNotMatch(JSON.stringify(result), /media\.example/);
  }
});

test("required subtitles select the authorized external candidate and fail closed when absent", async () => {
  const required = snapshot(["addon:one"], {
    preferredAudio: "cs",
    subtitleMode: "required",
    preferredSubtitle: "cs",
  });
  const selected = stream("https://media.example/required.mkv", 1);
  const subtitle: SubtitleItem = {
    url: "https://subs.example/required.srt",
    lang: "Czech",
    addonKey: "subs",
  };

  const result = await verifyTravelAddonStreams({
    snapshot: required,
    streams: [selected],
    externalSubtitles: [subtitle],
    inspect: async () => mediaInfo({ audio: ["cs"] }),
    shouldContinue: always,
    scopeStamp: "required-subtitles",
  });

  assert.equal(result.status, "selected");
  assert.equal(result.subtitle, subtitle);
  assert.equal(result.resolution.subtitleLanguage, "cs");
  assert.equal(result.resolution.subtitleSource, "addon");
  assert.equal(result.resolution.subtitleStatus, "ready");

  const missing = await verifyTravelAddonStreams({
    snapshot: required,
    streams: [selected],
    externalSubtitles: [],
    inspect: async () => mediaInfo({ audio: ["cs"] }),
    shouldContinue: always,
    scopeStamp: "required-subtitles",
  });
  assert.equal(missing.status, "temporaryFailure");
  assert.equal(missing.retryable, true);
});

test("tried URLs are not inspected and the next authorized row wins", async () => {
  const tried = stream("https://media.example/tried.mkv", 1);
  const fresh = stream("https://media.example/fresh.mkv", 2);
  const calls: string[] = [];
  const result = await verifyTravelAddonStreams({
    snapshot: snapshot(),
    streams: [tried, fresh],
    externalSubtitles: [],
    inspect: async (item) => {
      calls.push(item.url!);
      return mediaInfo({ audio: ["en"] });
    },
    shouldContinue: always,
    scopeStamp: "tried-filter",
    tried: [tried.url!],
  });

  assert.equal(result.status, "selected");
  assert.equal(result.stream, fresh);
  assert.deepEqual(calls, [fresh.url]);
  assert.equal(result.resolution.checkedCandidates, 1);
});
