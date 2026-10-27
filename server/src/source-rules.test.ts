import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDownloadRules,
  rulesPolicy,
  type DownloadRules,
} from "./download-rules.js";
import type { MediaInfo } from "./probe.js";
import {
  materializeSourceAdmissionPolicy,
  parseSourceAdmissionSnapshotV1,
  type SourceAdmissionSnapshotV1,
} from "./source-admission.js";
import {
  inspectedAddonSourceEvidence,
  listedAddonSourceEvidence,
} from "./source-addon-evidence.js";
import type { SourceEvidenceCandidateV1 } from "./source-evidence.js";
import { verifyRulesAddonStreams } from "./source-rules-execution.js";
import {
  parseRulesContinuationCursorV1,
  RULES_INSPECTION_BUDGET,
  verifyRulesCandidates,
  type RulesContinuationCursorV1,
} from "./source-rules.js";
import type { StreamItem } from "./types.js";

const baseRules = (overrides: Partial<DownloadRules> = {}): DownloadRules => parseDownloadRules({
  addons: { scope: "all", order: "viewer" },
  torrents: false,
  resolution: { min: null, max: null },
  audio: { mode: "prefer", fallback: null },
  subtitles: "off",
  maxSizeGb: { episode: null, movie: null },
  skipCinema: false,
  preference: ["language"],
  ...overrides,
});

const snapshot = (
  overrides: Partial<DownloadRules> = {},
  providerKeys = ["addon:one"],
): SourceAdmissionSnapshotV1 => parseSourceAdmissionSnapshotV1({
  schemaVersion: 1,
  profile: { id: "rules-test", revision: 1, template: "rules" },
  operation: "downloadToLibrary",
  providerKeys,
  policy: materializeSourceAdmissionPolicy(
    rulesPolicy(baseRules(overrides), "episode"),
    providerKeys,
    { audioLanguage: "en", subtitleLanguage: "en" },
  ),
});

const stream = (
  title: string,
  input: {
    readonly url?: string;
    readonly size?: number;
    readonly infoHash?: string;
    readonly fileIdx?: number;
  } = {},
): StreamItem => ({
  addonKey: "one",
  ...(input.url === undefined && input.infoHash === undefined
    ? { url: `https://media.example/${encodeURIComponent(title)}.mkv` }
    : input.url === undefined ? {} : { url: input.url }),
  name: title,
  ...(input.size === undefined ? {} : { behaviorHints: { videoSize: input.size } }),
  ...(input.infoHash === undefined ? {} : { infoHash: input.infoHash }),
  ...(input.fileIdx === undefined ? {} : { fileIdx: input.fileIdx }),
});

const candidate = (item: StreamItem): SourceEvidenceCandidateV1 => {
  const value = listedAddonSourceEvidence({
    providerKey: "addon:one",
    stream: item,
    providerResponseIndex: 0,
    available: true,
  });
  assert.ok(value);
  return value;
};

const media = (
  height: number,
  audio: readonly (string | undefined)[] = ["en"],
): MediaInfo => ({
  container: "matroska",
  duration: 3_600,
  video: { codec: "h264", height },
  audioTracks: audio.map((language, index) => ({
    index,
    codec: "aac",
    ...(language === undefined ? {} : { language }),
  })),
  subtitleTracks: [],
});

const inspectWith = (height: number, calls: string[] = []) =>
  async (source: SourceEvidenceCandidateV1) => {
    calls.push(source.sourceId);
    return { status: "ok" as const, candidate: inspectedAddonSourceEvidence(source, media(height)) };
  };

test("listing height hints order preferred rows before unknown heights without treating them as proof", async () => {
  const low = candidate(stream("English 720p"));
  const high = candidate(stream("English 1080p"));
  const unknown = candidate(stream("English"));
  const calls: string[] = [];
  const result = await verifyRulesCandidates({
    snapshot: snapshot({ resolution: { min: 720, max: null }, preference: ["resolutionHigher"] }),
    candidates: [unknown, low, high],
    inspect: async (source) => {
      calls.push(source.facts.heightPixels.evidence === "unknown"
        ? "unknown"
        : String(source.facts.heightPixels.value));
      return {
        status: "ok",
        candidate: inspectedAddonSourceEvidence(source, media(
          source.facts.heightPixels.evidence === "unknown" ? 720 : source.facts.heightPixels.value,
        )),
      };
    },
    shouldContinue: () => true,
    scopeStamp: "height-order",
    hasRealDebrid: false,
  });

  assert.equal(result.status, "selected");
  assert.deepEqual(calls, ["1080", "720", "unknown"]);
  if (result.status === "selected") assert.equal(result.selection.heightPixels, 1080);
});

test("strict audio probes claimed preferred language first", async () => {
  const other = candidate(stream("Czech release 1080p"));
  const preferred = candidate(stream("English release 720p"));
  const noClaim = candidate(stream("Episode 720p"));
  const calls: string[] = [];
  const result = await verifyRulesCandidates({
    snapshot: snapshot({
      resolution: { min: 720, max: 1080 },
      audio: { mode: "only", fallback: null },
      preference: ["resolutionHigher", "language"],
    }),
    candidates: [noClaim, other, preferred],
    inspect: async (source) => {
      calls.push(source.facts.audio.listed.evidence !== "unknown"
        ? source.facts.audio.listed.value[0] ?? "none"
        : "none");
      return {
        status: "ok",
        candidate: inspectedAddonSourceEvidence(source, media(720, ["en"])),
      };
    },
    shouldContinue: () => true,
    scopeStamp: "strict-order",
    hasRealDebrid: false,
  });

  assert.equal(result.status, "selected");
  assert.deepEqual(calls, ["en", "cs", "none"]);
});

test("a grace-strict snapshot rejects fallback audio that the original preferred snapshot accepts", async () => {
  const source = candidate(stream("Czech release 720p"));
  const inspect = async (value: SourceEvidenceCandidateV1) => ({
    status: "ok" as const,
    candidate: inspectedAddonSourceEvidence(value, media(720, ["cs"])),
  });
  const strict = await verifyRulesCandidates({
    snapshot: snapshot({
      resolution: { min: 720, max: 1080 },
      audio: { mode: "only", fallback: null },
      preference: ["resolutionHigher"],
    }),
    candidates: [source],
    inspect,
    shouldContinue: () => true,
    scopeStamp: "grace-audio",
    hasRealDebrid: false,
  });
  assert.equal(strict.status, "noMatch");

  const preferred = await verifyRulesCandidates({
    snapshot: snapshot({
      resolution: { min: 720, max: 1080 },
      audio: { mode: "prefer", fallback: "cs" },
      preference: ["resolutionHigher"],
    }),
    candidates: [source],
    inspect,
    shouldContinue: () => true,
    scopeStamp: "grace-audio",
    hasRealDebrid: false,
  });
  assert.equal(preferred.status, "selected");
  if (preferred.status === "selected") assert.equal(preferred.selection.audioTier, "fallback");
});

test("an unknown-height row is probed while it can beat a verified 720p", async () => {
  const known = candidate(stream("English 720p"));
  const unknown = candidate(stream("English episode"));
  const calls: string[] = [];
  const result = await verifyRulesCandidates({
    snapshot: snapshot({ resolution: { min: 720, max: 1080 }, preference: ["resolutionHigher"] }),
    candidates: [unknown, known],
    inspect: async (source) => {
      calls.push(source.facts.heightPixels.evidence === "unknown" ? "unknown" : "720");
      return {
        status: "ok",
        candidate: inspectedAddonSourceEvidence(
          source,
          media(source.facts.heightPixels.evidence === "unknown" ? 1080 : 720),
        ),
      };
    },
    shouldContinue: () => true,
    scopeStamp: "optimistic-height",
    hasRealDebrid: false,
  });

  assert.equal(result.status, "selected");
  assert.deepEqual(calls, ["720", "unknown"]);
  if (result.status === "selected") assert.equal(result.selection.heightPixels, 1080);
});

test("a worse size hint is not probed after the verified height reaches the maximum", async () => {
  const best = candidate(stream("English 1080p", { size: 100 }));
  const unknown = candidate(stream("English episode", { size: 200 }));
  const calls: string[] = [];
  const result = await verifyRulesCandidates({
    snapshot: snapshot({
      resolution: { min: 720, max: 1080 },
      preference: ["resolutionHigher", "smaller"],
    }),
    candidates: [unknown, best],
    inspect: inspectWith(1080, calls),
    shouldContinue: () => true,
    scopeStamp: "stop-on-bound",
    hasRealDebrid: false,
  });

  assert.equal(result.status, "selected");
  assert.equal(calls.length, 1);
});

test("listing maximum size, range, release kind and source kind can exclude with zero probes", async () => {
  const tooLarge = candidate(stream("English 720p", { size: 2_000_000_000 }));
  const tooLow = candidate(stream("English 360p"));
  const cinema = candidate(stream("English 720p HDCAM"));
  const calls = 0;
  const result = await verifyRulesCandidates({
    snapshot: snapshot({
      resolution: { min: 720, max: 1080 },
      maxSizeGb: { episode: 1, movie: null },
      skipCinema: true,
    }),
    candidates: [tooLarge, tooLow, cinema],
    inspect: async (source) => {
      void calls;
      throw new Error(`unexpected probe ${source.sourceId}`);
    },
    shouldContinue: () => true,
    scopeStamp: "listing-exclusions",
    hasRealDebrid: true,
  });

  assert.equal(result.status, "noMatch");
  assert.equal(result.observations.probesUsed, 0);
});

test("unknown size passes, listed size within passes, and listed size over is excluded", async () => {
  const unknown = candidate(stream("English 720p"));
  const within = candidate(stream("English 720p copy", { size: 1_000_000_000 }));
  const over = candidate(stream("English 720p too large", { size: 1_000_000_001 }));
  const result = await verifyRulesCandidates({
    snapshot: snapshot({ maxSizeGb: { episode: 1, movie: null } }),
    candidates: [over, within, unknown],
    inspect: async () => {
      throw new Error("sizes and unknown height without a height policy need no probe");
    },
    shouldContinue: () => true,
    scopeStamp: "approximate-size",
    hasRealDebrid: false,
  });

  assert.equal(result.status, "selected");
  assert.equal(result.observations.probesUsed, 0);
  if (result.status === "selected") {
    assert.notEqual(result.selection.candidate.sourceId, over.sourceId);
  }
});

test("the sixteenth probe returns a cursor and the next attempt can select its 1080p", async () => {
  const streams = Array.from({ length: 16 }, (_entry, index) =>
    stream(`English 720p row ${index}`, { url: `https://media.example/row-${index}.mkv?token=${index}` }));
  const candidates = streams.map(candidate);
  const firstCalls: string[] = [];
  const first = await verifyRulesCandidates({
    snapshot: snapshot({ resolution: { min: 720, max: 1080 }, preference: ["resolutionHigher"] }),
    candidates,
    inspect: inspectWith(720, firstCalls),
    shouldContinue: () => true,
    scopeStamp: "budget",
    hasRealDebrid: false,
  });
  assert.equal(first.status, "budgetExhausted");
  assert.equal(firstCalls.length, RULES_INSPECTION_BUDGET);
  if (first.status !== "budgetExhausted") return;
  assert.equal(first.cursor.nextIndex, RULES_INSPECTION_BUDGET);

  const secondCalls: string[] = [];
  const second = await verifyRulesCandidates({
    snapshot: snapshot({ resolution: { min: 720, max: 1080 }, preference: ["resolutionHigher"] }),
    candidates,
    inspect: async (source) => {
      secondCalls.push(source.sourceId);
      return {
        status: "ok",
        candidate: inspectedAddonSourceEvidence(source, media(1080)),
      };
    },
    shouldContinue: () => true,
    scopeStamp: "budget",
    hasRealDebrid: false,
    cursor: first.cursor,
  });
  assert.equal(second.status, "selected");
  assert.equal(secondCalls.length, 1);
  if (second.status === "selected") assert.equal(second.selection.heightPixels, 1080);
});

test("a changed listing resets the continuation cursor", async () => {
  const first = candidate(stream("English 720p one"));
  const second = candidate(stream("English 720p two"));
  const cursor: RulesContinuationCursorV1 = {
    schemaVersion: 1,
    scopeFingerprint: "a".repeat(64),
    listingFingerprint: "b".repeat(64),
    nextIndex: 1,
    rejectedIndices: [],
    verified: [],
  };
  const calls: string[] = [];
  const result = await verifyRulesCandidates({
    snapshot: snapshot({ resolution: { min: 720, max: 1080 } }),
    candidates: [first, second],
    inspect: inspectWith(720, calls),
    shouldContinue: () => true,
    scopeStamp: "changed-listing",
    hasRealDebrid: false,
    cursor,
  });
  assert.equal(result.status, "selected");
  assert.equal(calls[0], first.sourceId);
});

test("rules cursors round-trip strictly without accepting extra fields or invalid tiers", () => {
  const cursor: RulesContinuationCursorV1 = {
    schemaVersion: 1,
    scopeFingerprint: "a".repeat(64),
    listingFingerprint: "b".repeat(64),
    nextIndex: 2,
    rejectedIndices: [0, 1],
    verified: [{
      continuationKey: "c".repeat(64),
      audioTier: "preferred",
      heightPixels: 720,
      subtitleTier: "unknown",
    }],
  };
  assert.deepEqual(parseRulesContinuationCursorV1(cursor), cursor);
  assert.throws(() => parseRulesContinuationCursorV1({ ...cursor, extra: true }));
  assert.throws(() => parseRulesContinuationCursorV1({
    ...cursor,
    verified: [{ ...cursor.verified[0], audioTier: "invalid" }],
  }));
});

test("temporary failures stay in the pool and cancellation is explicit", async () => {
  const source = candidate(stream("English 720p"));
  const temporary = await verifyRulesCandidates({
    snapshot: snapshot({ resolution: { min: 720, max: 1080 } }),
    candidates: [source],
    inspect: async () => ({ status: "temporaryFailure" }),
    shouldContinue: () => true,
    scopeStamp: "temporary",
    hasRealDebrid: false,
  });
  assert.equal(temporary.status, "temporaryFailure");
  if (temporary.status === "temporaryFailure") {
    assert.deepEqual(temporary.cursor.rejectedIndices, []);
  }

  const cancelled = await verifyRulesCandidates({
    snapshot: snapshot({ resolution: { min: 720, max: 1080 } }),
    candidates: [source],
    inspect: inspectWith(720),
    shouldContinue: () => false,
    scopeStamp: "cancelled",
    hasRealDebrid: false,
  });
  assert.equal(cancelled.status, "cancelled");
});

test("torrents open only after an HTTP pool has no verified source and Real-Debrid is configured", async () => {
  const http = candidate(stream("English 720p"));
  const torrentStream = stream("English 1080p", {
    infoHash: "a".repeat(40),
    fileIdx: 1,
  });
  const torrent = candidate(torrentStream);
  const rules = snapshot({ torrents: true, resolution: { min: 720, max: 1080 } });

  const selected = await verifyRulesCandidates({
    snapshot: rules,
    candidates: [torrent, http],
    inspect: async () => ({ status: "temporaryFailure" }),
    shouldContinue: () => true,
    scopeStamp: "torrent-after-http",
    hasRealDebrid: true,
  });
  assert.equal(selected.status, "temporaryFailure");

  const noHttp = await verifyRulesCandidates({
    snapshot: rules,
    candidates: [torrent],
    inspect: async () => {
      throw new Error("a torrent is chosen from its listing");
    },
    shouldContinue: () => true,
    scopeStamp: "torrent-after-http",
    hasRealDebrid: true,
  });
  assert.equal(noHttp.status, "selected");
  if (noHttp.status === "selected") {
    assert.equal(noHttp.selection.candidate.sourceKind, "torrent");
    assert.equal(noHttp.selection.audioTier, "preferred");
  }

  const verifiedHttp = candidate(stream("English 720p verified"));
  const verified = await verifyRulesCandidates({
    snapshot: rules,
    candidates: [torrent, verifiedHttp],
    inspect: async (source) => ({
      status: "ok",
      candidate: inspectedAddonSourceEvidence(source, media(720)),
    }),
    shouldContinue: () => true,
    scopeStamp: "torrent-after-http",
    hasRealDebrid: true,
  });
  assert.equal(verified.status, "selected");
  if (verified.status === "selected") {
    assert.equal(verified.selection.candidate.sourceKind, "http");
  }
});

test("strict torrents need a listed preferred language and episodes need fileIdx", async () => {
  const unclaimed = stream("1080p", { infoHash: "b".repeat(40), fileIdx: 1 });
  const claimed = stream("English 1080p", { infoHash: "c".repeat(40), fileIdx: 1 });
  const result = await verifyRulesAddonStreams({
    snapshot: snapshot({
      torrents: true,
      resolution: { min: 720, max: 1080 },
      audio: { mode: "only", fallback: null },
    }),
    streams: [unclaimed, claimed],
    externalSubtitles: [],
    episode: true,
    inspect: async () => undefined,
    shouldContinue: () => true,
    scopeStamp: "strict-torrent",
    hasRealDebrid: true,
  });
  assert.equal(result.status, "selected");
  if (result.status === "selected") assert.equal(result.stream, claimed);

  const missingFile = await verifyRulesAddonStreams({
    snapshot: snapshot({ torrents: true }),
    streams: [stream("English 1080p", { infoHash: "d".repeat(40) })],
    externalSubtitles: [],
    episode: true,
    inspect: async () => undefined,
    shouldContinue: () => true,
    scopeStamp: "episode-file",
    hasRealDebrid: true,
  });
  assert.equal(missingFile.status, "noMatch");
});
