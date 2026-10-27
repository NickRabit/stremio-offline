import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLanguage } from "./language.js";
import type { MediaInfo } from "./probe.js";
import {
  materializeSourceAdmissionPolicy,
  parseSourceAdmissionSnapshotV1,
  type SourceAdmissionSnapshotV1,
} from "./source-admission.js";
import {
  inspectedAddonSourceEvidence,
  listedAddonSourceEvidence,
  type ListedAddonSourceEvidenceInput,
} from "./source-addon-evidence.js";
import {
  evaluateSourceCandidate,
  type SourceEvidenceCandidateV1,
} from "./source-evidence.js";
import {
  parseSourcePolicyV1,
} from "./source-policy.js";
import {
  SOURCE_PROFILE_DEFINITIONS,
  SOURCE_PROFILE_IDS,
} from "./source-profiles.js";
import { verifyTravelCandidates } from "./source-travel.js";
import type { StreamItem, SubtitleItem } from "./types.js";

const HASH_A = "59e11cef8c2152ac73681092844ebd3db19025bc";
const HASH_B = "1111111111111111111111111111111111111111";
const SECRET_URL = "https://private.example/token?secret=top-secret";

const travelDefinition = SOURCE_PROFILE_DEFINITIONS.find((definition) =>
  definition.id === SOURCE_PROFILE_IDS.travel);
assert.ok(travelDefinition);

const addon = (
  stream: StreamItem,
  overrides: Partial<Omit<ListedAddonSourceEvidenceInput, "stream">> = {},
): SourceEvidenceCandidateV1 => {
  const candidate = listedAddonSourceEvidence({
    providerKey: "addon:one",
    stream,
    providerResponseIndex: 0,
    available: true,
    ...overrides,
  });
  assert.ok(candidate);
  return candidate;
};

const travelSnapshot = (
  providerKeys: string[] = ["addon:one", "addon:two"],
): SourceAdmissionSnapshotV1 => parseSourceAdmissionSnapshotV1({
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

const travelWithNumericBounds = (): SourceAdmissionSnapshotV1 => {
  const providerKeys = ["addon:one"];
  const policy = parseSourcePolicyV1({
    ...structuredClone(travelDefinition.policy),
    constraints: {
      ...structuredClone(travelDefinition.policy.constraints),
      bytes: { min: 10_000_000_000 },
      durationSeconds: { min: 60 },
    },
  });
  return {
    schemaVersion: 1,
    profile: { id: SOURCE_PROFILE_IDS.travel, revision: 1 },
    operation: "downloadToLibrary",
    providerKeys,
    policy: materializeSourceAdmissionPolicy(
      policy,
      providerKeys,
      { audioLanguage: "en", subtitleLanguage: "en" },
    ),
  };
};

const mediaInfo = (input: {
  height?: number;
  duration?: number;
  audio?: readonly (string | undefined)[];
  subtitles?: readonly (string | undefined)[];
}): MediaInfo => ({
  container: "matroska",
  ...(input.duration === undefined ? {} : { duration: input.duration }),
  ...(input.height === undefined ? {} : { video: { codec: "h264", height: input.height } }),
  audioTracks: (input.audio ?? []).map((language, index) => ({
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

const freeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
};

test("addon rows map only supported addresses and use stable secret-free hashed identities", () => {
  const direct = addon(
    { url: SECRET_URL, infoHash: HASH_A, fileIdx: 3, title: "720p" },
    { providerKey: "addon:alpha", providerResponseIndex: 7 },
  );
  assert.equal(direct.providerKey, "addon:alpha");
  assert.equal(direct.providerClass, "addon");
  assert.equal(direct.sourceKind, "http");
  assert.equal(direct.providerResponseIndex, 7);
  assert.deepEqual(direct.capabilities, ["downloadToLibrary"]);
  assert.match(direct.sourceId, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(direct.sourceId, /private|token|top-secret|example/i);
  assert.equal(
    addon({ url: SECRET_URL, infoHash: HASH_A, fileIdx: 3 }, { providerKey: "addon:alpha" }).sourceId,
    direct.sourceId,
  );
  assert.notEqual(
    addon({ url: SECRET_URL }, { providerKey: "addon:beta" }).sourceId,
    addon({ url: SECRET_URL }, { providerKey: "addon:alpha" }).sourceId,
  );

  const torrent = addon({ infoHash: HASH_A, fileIdx: 2 });
  assert.equal(torrent.sourceKind, "torrent");
  assert.equal(torrent.sourceId, addon({ infoHash: HASH_A, fileIdx: 2 }).sourceId);
  assert.notEqual(torrent.sourceId, addon({ infoHash: HASH_A, fileIdx: 3 }).sourceId);
  assert.notEqual(torrent.sourceId, addon({ infoHash: HASH_B, fileIdx: 2 }).sourceId);

  for (const stream of [
    { url: "magnet:?xt=urn:btih:" + HASH_A },
    { url: "file:///tmp/movie.mkv" },
    { url: "local-file://movie" },
    { url: "remote-download:original" },
    { externalUrl: "https://addon.example/watch/1" },
    { infoHash: "   ", fileIdx: 0 },
    { infoHash: HASH_A, fileIdx: -1 },
    { infoHash: HASH_A, fileIdx: 1.5 },
  ] satisfies StreamItem[]) {
    assert.equal(listedAddonSourceEvidence({
      providerKey: "addon:one",
      stream,
      providerResponseIndex: 0,
      available: true,
    }), undefined);
  }
});

test("continuation identity ignores rotated addresses and distinguishes listing facts", () => {
  const filenameOne = addon({
    url: "https://media.example/film.mkv?token=one",
    name: "English 1080p",
    behaviorHints: { filename: "Film.1080p.mkv", videoSize: 8_000_000_000 },
  });
  const filenameTwo = addon({
    url: "https://media.example/film.mkv?token=two",
    name: "English 1080p",
    behaviorHints: { filename: "Film.1080p.mkv", videoSize: 8_000_000_000 },
  });
  assert.notEqual(filenameOne.sourceId, filenameTwo.sourceId);
  assert.deepEqual(filenameOne.continuationIdentity, filenameTwo.continuationIdentity);
  assert.equal(filenameOne.continuationIdentity?.reusableRejection, true);

  const positionalOne = addon({
    url: "https://media.example/film.mkv?token=one",
    name: "English 1080p",
    title: "Film",
    behaviorHints: { videoSize: 4_000_000_000 },
  }, { providerResponseIndex: 3 });
  const positionalTwo = addon({
    url: "https://media.example/film.mkv?token=two",
    name: "English 1080p",
    title: "Film",
    behaviorHints: { videoSize: 4_000_000_000 },
  }, { providerResponseIndex: 3 });
  assert.notEqual(positionalOne.sourceId, positionalTwo.sourceId);
  assert.deepEqual(positionalOne.continuationIdentity, positionalTwo.continuationIdentity);
  assert.equal(positionalOne.continuationIdentity?.reusableRejection, false);
  assert.notEqual(positionalOne.continuationIdentity?.key, addon({
    url: "https://media.example/film.mkv?token=one",
    name: "Czech 1080p",
    title: "Film",
    behaviorHints: { videoSize: 4_000_000_000 },
  }, { providerResponseIndex: 3 }).continuationIdentity?.key);
  assert.notEqual(positionalOne.continuationIdentity?.key, addon({
    url: "https://media.example/film.mkv?token=one",
    name: "English 1080p",
    title: "Film",
    behaviorHints: { videoSize: 4_000_000_000 },
  }, { providerResponseIndex: 4, providerKey: "addon:two" }).continuationIdentity?.key);

  const torrentOne = addon({ infoHash: HASH_A, fileIdx: 2 });
  const torrentTwo = addon({ infoHash: ` ${HASH_A.toUpperCase()} `, fileIdx: 2 });
  assert.notEqual(torrentOne.sourceId, torrentTwo.sourceId);
  assert.deepEqual(torrentOne.continuationIdentity, torrentTwo.continuationIdentity);
  assert.equal(torrentOne.continuationIdentity?.reusableRejection, true);

  for (const candidate of [filenameOne, positionalOne, torrentOne]) {
    assert.doesNotMatch(JSON.stringify(candidate), /media\.example|token=|token%3d/i);
  }
});

test("listing claims stay hints and cannot settle numeric hard bounds", () => {
  const source = addon({
    url: "https://media.example/movie.mkv",
    title: "720p sample 3.2 GB",
    behaviorHints: { videoSize: 8_000_000_000 },
  });
  assert.deepEqual(source.hints, { bytes: 8_000_000_000 });
  assert.deepEqual(source.facts.bytes, { evidence: "unknown" });
  assert.deepEqual(source.facts.durationSeconds, { evidence: "unknown" });
  assert.deepEqual(source.facts.heightPixels, { evidence: "unknown" });
  assert.deepEqual(source.facts.sampleOrTrailer, { evidence: "unknown" });

  assert.deepEqual(evaluateSourceCandidate(travelSnapshot(["addon:one"]), source), {
    status: "needsInspection",
    reasons: [{ code: "inspectionRequired", field: "heightPixels" }],
  });
  assert.deepEqual(evaluateSourceCandidate(travelWithNumericBounds(), source), {
    status: "needsInspection",
    reasons: [
      { code: "inspectionRequired", field: "bytes" },
      { code: "inspectionRequired", field: "durationSeconds" },
      { code: "inspectionRequired", field: "heightPixels" },
    ],
  });
});

test("listing keeps language provenance and inspection replaces only verifiable facts", () => {
  const source = addon({
    url: "https://media.example/movie.mkv",
    title: "Czech audio",
    subtitles: [
      { url: "https://subs.example/one", lang: "English" },
      { url: "https://subs.example/bad", lang: "not-a-language" },
    ],
  }, {
    externalSubtitles: [
      { url: "https://subs.example/two", lang: "cze" },
      { url: "https://subs.example/missing" },
    ],
  });
  assert.deepEqual(source.facts.audio, {
    listed: { evidence: "listed", value: ["cs"] },
    tracks: { evidence: "unknown" },
  });
  assert.deepEqual(source.facts.embeddedSubtitles, { evidence: "unknown" });
  assert.deepEqual(source.facts.externalSubtitles, {
    evidence: "listed",
    value: ["en", "cs"],
  });

  const info = mediaInfo({
    height: 480,
    duration: 3_600,
    audio: ["English", "not-a-language"],
    subtitles: ["Czech", undefined],
  });
  assert.deepEqual(source.facts.audio.tracks, { evidence: "unknown" });
  assert.deepEqual(source.facts.embeddedSubtitles, { evidence: "unknown" });

  const inspected = inspectedAddonSourceEvidence(source, info);
  assert.deepEqual(inspected.facts.audio, {
    listed: { evidence: "listed", value: ["cs"] },
    tracks: { evidence: "inspected", value: ["en", undefined] },
  });
  assert.deepEqual(inspected.facts.embeddedSubtitles, {
    evidence: "inspected",
    value: ["cs", undefined],
  });
  assert.deepEqual(inspected.facts.externalSubtitles, source.facts.externalSubtitles);
  assert.deepEqual(inspected.facts.heightPixels, { evidence: "inspected", value: 480 });
  assert.deepEqual(inspected.facts.durationSeconds, { evidence: "inspected", value: 3_600 });
  assert.equal(inspected.available, true);

  for (const info of [
    mediaInfo({ duration: 3_600, audio: ["en"] }),
    mediaInfo({ height: 480, duration: 3_600, audio: [] }),
    { ...mediaInfo({ height: 480, duration: 3_600 }), audioTracks: [null] } as unknown as MediaInfo,
  ]) {
    const unavailable = inspectedAddonSourceEvidence(source, info);
    assert.equal(unavailable.available, false);
    assert.equal(evaluateSourceCandidate(travelSnapshot(["addon:one"]), unavailable).status, "excluded");
  }
});

test("Travel accepts inspected 480p over sixty seconds and rejects false quality or short samples", async () => {
  const run = async (info: MediaInfo) => verifyTravelCandidates({
    snapshot: travelSnapshot(["addon:one"]),
    candidates: [addon({ url: SECRET_URL, title: "English 720p" })],
    inspect: async (source) => ({
      status: "ok",
      candidate: inspectedAddonSourceEvidence(source, info),
    }),
    shouldContinue: () => true,
    scopeStamp: "addon-evidence",
  });

  assert.equal((await run(mediaInfo({
    height: 360,
    duration: 3_600,
    audio: ["en"],
  }))).status, "noMatch");
  assert.equal((await run(mediaInfo({
    height: 480,
    duration: 61,
    audio: ["en"],
  }))).status, "selected");
  assert.equal((await run(mediaInfo({
    height: 2_160,
    duration: 59,
    audio: ["en"],
  }))).status, "noMatch");
});

test("adapter output keeps its identity in a fresh immutable copy and preserves listing hints", () => {
  const stream = freeze({
    url: SECRET_URL,
    title: "English 1080p",
    behaviorHints: { videoSize: 4_000_000_000 },
  } satisfies StreamItem);
  const input = freeze({
    providerKey: "addon:one",
    stream,
    providerResponseIndex: 4,
    available: true,
  } satisfies ListedAddonSourceEvidenceInput);
  const source = freeze(listedAddonSourceEvidence(input)!);
  const before = structuredClone(source);

  const inspected = inspectedAddonSourceEvidence(source, mediaInfo({
    height: 720,
    duration: 1_200,
    audio: ["en"],
    subtitles: ["en"],
  }));

  assert.deepEqual(source, before);
  assert.notEqual(inspected, source);
  assert.notEqual(inspected.facts, source.facts);
  assert.notEqual(inspected.facts.audio.listed, source.facts.audio.listed);
  assert.notEqual(inspected.facts.externalSubtitles, source.facts.externalSubtitles);
  assert.notEqual(inspected.capabilities, source.capabilities);
  assert.notEqual(inspected.hints, source.hints);
  assert.equal(inspected.sourceId, source.sourceId);
  assert.deepEqual(inspected.continuationIdentity, source.continuationIdentity);
  assert.notEqual(inspected.continuationIdentity, source.continuationIdentity);
  assert.equal(inspected.providerKey, source.providerKey);
  assert.equal(inspected.providerResponseIndex, source.providerResponseIndex);
  assert.deepEqual(inspected.capabilities, ["downloadToLibrary"]);
  assert.deepEqual(inspected.hints, { bytes: 4_000_000_000 });
  assert.deepEqual(inspected.facts.bytes, { evidence: "unknown" });
  assert.deepEqual(inspected.facts.sampleOrTrailer, { evidence: "unknown" });
  assert.doesNotMatch(JSON.stringify(inspected), /private|token|top-secret|example/i);
});

test("Travel inspects adapter sources in size order and returns the measured choice", async () => {
  const large = addon({
    url: "https://media.example/large.mkv",
    title: "English 4K",
    behaviorHints: { videoSize: 900 },
  }, { providerResponseIndex: 0 });
  const small = addon({
    url: "https://media.example/small.mkv",
    title: "English 480p",
    behaviorHints: { videoSize: 100 },
  }, { providerResponseIndex: 1 });
  const calls: string[] = [];

  const result = await verifyTravelCandidates({
    snapshot: travelSnapshot(["addon:one"]),
    candidates: [large, small],
    inspect: async (source) => {
      calls.push(source.sourceId);
      return {
        status: "ok",
        candidate: inspectedAddonSourceEvidence(source, source.sourceId === small.sourceId
          ? mediaInfo({ height: 480, duration: 3_600, audio: ["en"] })
          : mediaInfo({ height: 2_160, duration: 59, audio: ["en"] })),
      };
    },
    shouldContinue: () => true,
    scopeStamp: "addon-evidence-order",
  });

  assert.equal(result.status, "selected");
  assert.equal(result.selection.candidate.sourceId, small.sourceId);
  assert.deepEqual(calls, [small.sourceId, large.sourceId]);
});

test("malformed languages are ignored and unsupported inputs fail without leaking addresses", () => {
  assert.deepEqual(
    addon({ url: "https://media.example/film.mkv", title: "not-a-language" }).facts.audio.listed,
    { evidence: "unknown" },
  );
  const malformed = addon({
    url: "https://media.example/film.mkv",
    subtitles: [{ url: "https://subs.example/bad", lang: 42 }],
    behaviorHints: { bingeGroup: 42 },
  } as unknown as StreamItem, {
    externalSubtitles: [{ url: "https://subs.example/bad", lang: 42 }] as unknown as SubtitleItem[],
  });
  assert.deepEqual(malformed.facts.audio.listed, { evidence: "unknown" });
  assert.deepEqual(malformed.facts.externalSubtitles, { evidence: "unknown" });
  assert.equal(normalizeLanguage("not-a-language"), undefined);
  assert.equal(listedAddonSourceEvidence({
    providerKey: "addon:one",
    stream: { url: SECRET_URL },
    providerResponseIndex: -1,
    available: true,
  }), undefined);
  assert.doesNotThrow(() => listedAddonSourceEvidence({
    providerKey: "addon:one",
    stream: { url: SECRET_URL.replace("https:", "sealed:") },
    providerResponseIndex: 0,
    available: true,
  }));
});
