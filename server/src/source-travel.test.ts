import assert from "node:assert/strict";
import test from "node:test";
import {
  materializeSourceAdmissionPolicy,
  parseSourceAdmissionSnapshotV1,
  type SourceAdmissionSnapshotV1,
} from "./source-admission.js";
import {
  evaluateSourceCandidate,
  type SourceEvidenceCandidateV1,
  type SourceEvidenceFactsV1,
  type SourceEvidenceLevel,
  type SourceFact,
} from "./source-evidence.js";
import {
  SOURCE_PROFILE_DEFINITIONS,
  SOURCE_PROFILE_IDS,
} from "./source-profiles.js";
import {
  parseSourcePolicyV1,
  type SourcePolicyConstraints,
} from "./source-policy.js";
import {
  inspectedAddonSourceEvidence,
  listedAddonSourceEvidence,
} from "./source-addon-evidence.js";
import {
  TRAVEL_INSPECTION_BUDGET,
  TRAVEL_MAX_REJECTED_INDICES,
  verifyTravelCandidates,
  type TravelContinuationCursorV1,
  type TravelInspectionResult,
} from "./source-travel.js";

const fact = <T>(value: T, evidence: SourceEvidenceLevel = "inspected"): SourceFact<T> => ({
  evidence,
  value,
});

const unknown = <T>(): SourceFact<T> => ({ evidence: "unknown" });

const facts = (overrides: Partial<SourceEvidenceFactsV1> = {}): SourceEvidenceFactsV1 => ({
  audio: {
    listed: unknown<readonly string[]>(),
    tracks: unknown(),
  },
  embeddedSubtitles: unknown(),
  externalSubtitles: unknown(),
  bytes: unknown(),
  durationSeconds: unknown(),
  heightPixels: unknown(),
  sampleOrTrailer: unknown(),
  ...overrides,
});

const candidate = (
  sourceId: string,
  overrides: Partial<Omit<SourceEvidenceCandidateV1, "facts" | "sourceId">> & {
    facts?: Partial<SourceEvidenceFactsV1>;
  } = {},
): SourceEvidenceCandidateV1 => {
  const { facts: factOverrides, ...candidateOverrides } = overrides;
  return {
    sourceId,
    providerKey: "addon:one",
    providerClass: "addon",
    sourceKind: "http",
    capabilities: ["downloadToLibrary"],
    providerResponseIndex: 0,
    available: true,
    ...candidateOverrides,
    facts: facts(factOverrides),
  };
};

const inspectedCandidate = (
  source: SourceEvidenceCandidateV1,
  overrides: Partial<SourceEvidenceFactsV1>,
): TravelInspectionResult => ({
  status: "ok",
  candidate: {
    ...source,
    facts: facts(overrides),
  },
});

const travelDefinition = SOURCE_PROFILE_DEFINITIONS.find((definition) =>
  definition.id === SOURCE_PROFILE_IDS.travel);
assert.ok(travelDefinition);

const snapshot = (
  providerKeys: string[] = ["addon:one", "addon:two"],
  profileId: string = SOURCE_PROFILE_IDS.travel,
  operation: SourceAdmissionSnapshotV1["operation"] = "downloadToLibrary",
): SourceAdmissionSnapshotV1 => {
  const definition = SOURCE_PROFILE_DEFINITIONS.find((candidate) => candidate.id === profileId);
  assert.ok(definition);
  return parseSourceAdmissionSnapshotV1({
    schemaVersion: 1,
    profile: { id: profileId, revision: definition.revision },
    operation,
    providerKeys,
    policy: materializeSourceAdmissionPolicy(
      definition.policy,
      providerKeys,
      { audioLanguage: "en", subtitleLanguage: "en" },
    ),
  });
};

const snapshotWithKinds = (
  sourceKinds: SourcePolicyConstraints["sourceKinds"],
): SourceAdmissionSnapshotV1 => {
  const providerKeys = ["addon:one"];
  const policy = parseSourcePolicyV1({
    ...structuredClone(travelDefinition.policy),
    constraints: {
      ...structuredClone(travelDefinition.policy.constraints),
      sourceKinds,
    },
  });
  return {
    schemaVersion: 1,
    profile: { id: SOURCE_PROFILE_IDS.travel, revision: 1, template: "travel" },
    operation: "downloadToLibrary",
    providerKeys,
    policy: materializeSourceAdmissionPolicy(
      policy,
      providerKeys,
      { audioLanguage: "en", subtitleLanguage: "en" },
    ),
  };
};

const always = () => true;

test("rotated URL-only candidates continue past fifteen rejections to the sixteenth", async () => {
  const listing = (token: string): SourceEvidenceCandidateV1[] => {
    const samples = Array.from({ length: TRAVEL_INSPECTION_BUDGET }, (_entry, index) => {
      const source = listedAddonSourceEvidence({
        providerKey: "addon:one",
        providerResponseIndex: index,
        stream: {
          url: `https://media.example/sample-${index}.mkv?token=${token}`,
          name: "English sample",
          title: `Sample ${index}`,
          behaviorHints: { videoSize: index + 1 },
        },
        available: true,
      });
      assert.ok(source);
      return source;
    });
    const episode = listedAddonSourceEvidence({
      providerKey: "addon:one",
      providerResponseIndex: TRAVEL_INSPECTION_BUDGET,
      stream: {
        url: `https://media.example/episode.mkv?token=${token}`,
        name: "English episode",
        title: "Episode",
        behaviorHints: { videoSize: 100 },
      },
      available: true,
    });
    assert.ok(episode);
    return [...samples, episode];
  };
  const inspectedIndices: number[] = [];
  const inspect = async (source: SourceEvidenceCandidateV1): Promise<TravelInspectionResult> => {
    inspectedIndices.push(source.providerResponseIndex);
    const video = source.providerResponseIndex === TRAVEL_INSPECTION_BUDGET
      ? { height: 480, duration: 3_600 }
      : { height: 2_160, duration: 59 };
    return {
      status: "ok",
      candidate: inspectedAddonSourceEvidence(source, {
        container: "matroska",
        duration: video.duration,
        video: { codec: "h264", height: video.height },
        audioTracks: [{ index: 0, codec: "aac", language: "en" }],
        subtitleTracks: [],
      }),
    };
  };

  const first = await verifyTravelCandidates({
    snapshot: snapshot(["addon:one"]),
    candidates: listing("first"),
    inspect,
    shouldContinue: always,
    scopeStamp: "scope-one",
  });
  assert.equal(first.status, "budgetExhausted");
  assert.equal(first.observations.probesUsed, TRAVEL_INSPECTION_BUDGET);
  assert.deepEqual(first.cursor.rejectedIndices, []);
  assert.doesNotMatch(JSON.stringify(first), /media\.example|token=|first/i);

  inspectedIndices.length = 0;
  const second = await verifyTravelCandidates({
    snapshot: snapshot(["addon:one"]),
    candidates: listing("second"),
    inspect,
    shouldContinue: always,
    scopeStamp: "scope-one",
    cursor: first.cursor,
  });
  assert.equal(second.status, "selected");
  assert.equal(second.selection.candidate.providerResponseIndex, TRAVEL_INSPECTION_BUDGET);
  assert.equal(inspectedIndices[0], TRAVEL_INSPECTION_BUDGET);
  assert.equal(second.observations.probesUsed, TRAVEL_INSPECTION_BUDGET);
  assert.ok(second.observations.probesUsed <= TRAVEL_INSPECTION_BUDGET);
});

test("rotated URL-only continuation resets for changed listing facts or scope", async () => {
  const listing = (token: string, name = "English sample"): SourceEvidenceCandidateV1[] =>
    Array.from({ length: TRAVEL_INSPECTION_BUDGET + 1 }, (_entry, index) => {
      const source = listedAddonSourceEvidence({
        providerKey: "addon:one",
        providerResponseIndex: index,
        stream: {
          url: `https://media.example/${index}.mkv?token=${token}`,
          name: index === 0 ? name : `English sample ${index}`,
          title: `Sample ${index}`,
          behaviorHints: { videoSize: index + 1 },
        },
        available: true,
      });
      assert.ok(source);
      return source;
    });

  const first = await verifyTravelCandidates({
    snapshot: snapshot(["addon:one"]),
    candidates: listing("first"),
    inspect: async () => ({ status: "temporaryFailure" }),
    shouldContinue: always,
    scopeStamp: { token: "scope-one" },
  });
  assert.equal(first.status, "budgetExhausted");

  for (const variant of [
    {
      snapshot: snapshot(["addon:one"]),
      candidates: listing("rotated", "Czech sample"),
      scopeStamp: { token: "scope-one" },
    },
    {
      snapshot: snapshot(["addon:one"]),
      candidates: listing("rotated"),
      scopeStamp: { token: "scope-two" },
    },
    {
      snapshot: snapshot(["addon:two", "addon:one"]),
      candidates: listing("rotated"),
      scopeStamp: { token: "scope-one" },
    },
  ]) {
    const calls: number[] = [];
    const result = await verifyTravelCandidates({
      ...variant,
      inspect: async (source) => {
        calls.push(source.providerResponseIndex);
        return { status: "temporaryFailure" };
      },
      shouldContinue: always,
      cursor: first.cursor,
    });
    assert.equal(result.status, "budgetExhausted");
    assert.equal(calls[0], 0);
  }
});

test("URL-only rejections stay episodic while durable rows keep their rejections", async () => {
  const sources = [
    candidate("url-only", {
      hints: { bytes: 1 },
      continuationIdentity: { key: "url-position", reusableRejection: false },
    }),
    candidate("filename", {
      hints: { bytes: 2 },
      continuationIdentity: { key: "stable-filename", reusableRejection: true },
    }),
    candidate("torrent-file", {
      hints: { bytes: 3 },
      sourceKind: "torrent",
      continuationIdentity: { key: "stable-torrent", reusableRejection: true },
    }),
    candidate("temporary", { hints: { bytes: 4 } }),
  ];
  const calls: string[] = [];
  const inspect = async (source: SourceEvidenceCandidateV1): Promise<TravelInspectionResult> => {
    calls.push(source.sourceId);
    return source.sourceId === "temporary"
      ? { status: "temporaryFailure" }
      : inspectedCandidate(source, { heightPixels: fact(360) });
  };

  const first = await verifyTravelCandidates({
    snapshot: snapshotWithKinds(["http", "torrent"]),
    candidates: sources,
    inspect,
    shouldContinue: always,
    scopeStamp: "scope-one",
  });
  assert.equal(first.status, "temporaryFailure");
  assert.deepEqual(first.cursor.rejectedIndices, [1, 2]);
  assert.ok(first.observations.probesUsed <= TRAVEL_INSPECTION_BUDGET);

  calls.length = 0;
  const second = await verifyTravelCandidates({
    snapshot: snapshotWithKinds(["http", "torrent"]),
    candidates: sources,
    inspect,
    shouldContinue: always,
    scopeStamp: "scope-one",
    cursor: first.cursor,
  });
  assert.equal(second.status, "temporaryFailure");
  assert.deepEqual(calls, ["url-only", "temporary"]);
  assert.deepEqual(second.cursor.rejectedIndices, [1, 2]);
  assert.ok(second.observations.probesUsed <= TRAVEL_INSPECTION_BUDGET);
});

test("fifteen inspected samples stop at the budget and the cursor reaches the valid episode", async () => {
  const samples = Array.from({ length: 15 }, (_entry, index) => candidate(
    `sample-${String(index).padStart(2, "0")}`,
    { hints: { bytes: index + 1 } },
  ));
  const episode = candidate("episode", { hints: { bytes: 100 } });
  const calls: string[] = [];
  const inspect = async (source: SourceEvidenceCandidateV1): Promise<TravelInspectionResult> => {
    calls.push(source.sourceId);
    return source.sourceId === episode.sourceId
      ? inspectedCandidate(source, {
        heightPixels: fact(480),
        durationSeconds: fact(3_600),
        sampleOrTrailer: fact(false),
      })
      : inspectedCandidate(source, {
        heightPixels: fact(2_160),
        sampleOrTrailer: fact(true),
      });
  };

  const first = await verifyTravelCandidates({
    snapshot: snapshot(),
    candidates: [...samples, episode],
    inspect,
    shouldContinue: always,
    scopeStamp: "scope-one",
  });
  assert.equal(first.status, "budgetExhausted");
  assert.equal(first.observations.probesUsed, 15);
  assert.deepEqual(calls, samples.map((source) => source.sourceId));
  assert.ok("cursor" in first);

  calls.length = 0;
  const second = await verifyTravelCandidates({
    snapshot: snapshot(),
    candidates: [...samples, episode],
    inspect,
    shouldContinue: always,
    scopeStamp: "scope-one",
    cursor: JSON.parse(JSON.stringify(first.cursor)) as TravelContinuationCursorV1,
  });
  assert.equal(second.status, "selected");
  assert.equal(second.selection.candidate.sourceId, "episode");
  assert.equal(second.searchStatus, "complete");
  assert.deepEqual(calls, ["episode"]);
});

test("transport failures advance but remain revisitable after the cursor wraps", async () => {
  const failures = Array.from({ length: 15 }, (_entry, index) => candidate(
    `failure-${String(index).padStart(2, "0")}`,
    { hints: { bytes: index + 1 } },
  ));
  const episode = candidate("episode", { hints: { bytes: 100 } });
  const calls: string[] = [];
  const inspect = async (source: SourceEvidenceCandidateV1): Promise<TravelInspectionResult> => {
    calls.push(source.sourceId);
    return source.sourceId === episode.sourceId
      ? inspectedCandidate(source, { heightPixels: fact(480) })
      : { status: "temporaryFailure" };
  };

  const first = await verifyTravelCandidates({
    snapshot: snapshot(),
    candidates: [...failures, episode],
    inspect,
    shouldContinue: always,
    scopeStamp: "scope-one",
  });
  assert.equal(first.status, "budgetExhausted");
  assert.equal(first.observations.temporaryFailures, 15);
  assert.deepEqual(first.cursor.rejectedIndices, []);

  calls.length = 0;
  const second = await verifyTravelCandidates({
    snapshot: snapshot(),
    candidates: [...failures, episode],
    inspect,
    shouldContinue: always,
    scopeStamp: "scope-one",
    cursor: first.cursor,
  });
  assert.equal(second.status, "selected");
  assert.equal(second.selection.candidate.sourceId, "episode");
  assert.equal(second.searchStatus, "incompleteSearch");
  assert.equal(second.observations.probesUsed, 15);
  assert.deepEqual(calls.slice(0, 2), ["episode", "failure-00"]);
  assert.equal(calls.at(-1), "failure-13");
  assert.deepEqual(second.cursor?.rejectedIndices, []);
});

test("metadata exclusions consume no probes and truthful inspected facts decide eligibility", async () => {
  const excluded = [
    candidate("metadata-360", {
      facts: { heightPixels: fact(360, "providerMetadata"), bytes: fact(1) },
    }),
    candidate("metadata-sample", {
      facts: { sampleOrTrailer: fact(true, "providerMetadata"), bytes: fact(2) },
    }),
  ];
  const eligible = candidate("metadata-480", {
    facts: { heightPixels: fact(480, "providerMetadata"), bytes: fact(3) },
  });
  const calls: string[] = [];
  const inspect = async (source: SourceEvidenceCandidateV1): Promise<TravelInspectionResult> => {
    calls.push(source.sourceId);
    return { status: "temporaryFailure" };
  };
  const result = await verifyTravelCandidates({
    snapshot: snapshot(),
    candidates: [...excluded, eligible],
    inspect,
    shouldContinue: always,
    scopeStamp: "scope-one",
  });
  assert.equal(result.status, "selected");
  assert.equal(result.selection.candidate.sourceId, "metadata-480");
  assert.deepEqual(calls, []);
  assert.equal(result.observations.probesUsed, 0);

  const hinted = candidate("hinted-720", {
    hints: { heightPixels: 720, bytes: 1 },
  });
  const inspectedCalls: string[] = [];
  const falseHint = await verifyTravelCandidates({
    snapshot: snapshot(),
    candidates: [hinted],
    inspect: async (source) => {
      inspectedCalls.push(source.sourceId);
      return inspectedCandidate(source, { heightPixels: fact(360) });
    },
    shouldContinue: always,
    scopeStamp: "scope-one",
  });
  assert.equal(falseHint.status, "noMatch");
  assert.deepEqual(inspectedCalls, ["hinted-720"]);
});

test("480p passes while a high-resolution short sample does not", async () => {
  const eligible = candidate("480p", { hints: { bytes: 1 } });
  const sample = candidate("short-2160p", { hints: { bytes: 2 } });
  const calls: string[] = [];
  const result = await verifyTravelCandidates({
    snapshot: snapshot(),
    candidates: [eligible, sample],
    inspect: async (source) => {
      calls.push(source.sourceId);
      return source.sourceId === "480p"
        ? inspectedCandidate(source, {
          heightPixels: fact(480),
          durationSeconds: fact(3_600),
          sampleOrTrailer: fact(false),
        })
        : inspectedCandidate(source, {
          heightPixels: fact(2_160),
          durationSeconds: fact(59),
          sampleOrTrailer: fact(false),
        });
    },
    shouldContinue: always,
    scopeStamp: "scope-one",
  });
  assert.equal(result.status, "selected");
  assert.equal(result.selection.candidate.sourceId, "480p");
  assert.deepEqual(calls, ["480p", "short-2160p"]);
});

test("legitimate low-bitrate content above sixty seconds stays eligible", async () => {
  const source = candidate("low-bitrate", {
    facts: {
      bytes: fact(20_000_000, "providerMetadata"),
      durationSeconds: fact(61, "providerMetadata"),
      heightPixels: fact(480, "providerMetadata"),
    },
  });
  const result = await verifyTravelCandidates({
    snapshot: snapshot(),
    candidates: [source],
    inspect: async () => assert.fail("metadata was sufficient"),
    shouldContinue: always,
    scopeStamp: "scope-one",
  });
  assert.equal(result.status, "selected");
  assert.equal(result.selection.candidate.sourceId, "low-bitrate");
});

test("unknown hard facts remain unresolved and exhaust the retryable budget", async () => {
  const candidates = Array.from({ length: 15 }, (_entry, index) =>
    candidate(`unknown-${String(index).padStart(2, "0")}`, { hints: { bytes: index } }));
  const calls: string[] = [];
  const result = await verifyTravelCandidates({
    snapshot: snapshot(),
    candidates,
    inspect: async (source) => {
      calls.push(source.sourceId);
      return inspectedCandidate(source, {});
    },
    shouldContinue: always,
    scopeStamp: "scope-one",
  });
  assert.equal(result.status, "budgetExhausted");
  assert.equal(result.observations.probesUsed, 15);
  assert.equal(result.observations.unresolvedCandidates, 15);
  assert.deepEqual(result.cursor.rejectedIndices, []);
  assert.deepEqual(calls, candidates.map((source) => source.sourceId));
});

test("a verified choice is returned with incomplete search when work remains", async () => {
  const candidates = Array.from({ length: 16 }, (_entry, index) =>
    candidate(`source-${String(index).padStart(2, "0")}`, { hints: { bytes: index } }));
  const result = await verifyTravelCandidates({
    snapshot: snapshot(),
    candidates,
    inspect: async (source) => {
      if (source.sourceId === "source-01") {
        return inspectedCandidate(source, { heightPixels: fact(720), bytes: fact(200) });
      }
      if (source.sourceId === "source-00") {
        return inspectedCandidate(source, { heightPixels: fact(480), bytes: fact(400) });
      }
      return inspectedCandidate(source, { heightPixels: fact(360), bytes: fact(indexOf(source.sourceId)) });
    },
    shouldContinue: always,
    scopeStamp: "scope-one",
  });
  assert.equal(result.status, "selected");
  assert.equal(result.selection.candidate.sourceId, "source-01");
  assert.equal(result.searchStatus, "incompleteSearch");
  assert.equal(result.observations.probesUsed, 15);
  assert.equal(result.cursor?.nextIndex, 15);
});

const indexOf = (sourceId: string): number => Number(sourceId.slice(-2));

test("noMatch requires an exhausted search and access denial wins over temporary failure", async () => {
  const rejected = [
    candidate("first", { hints: { bytes: 1 } }),
    candidate("second", { hints: { bytes: 2 } }),
  ];
  const noMatch = await verifyTravelCandidates({
    snapshot: snapshot(),
    candidates: rejected,
    inspect: async (source) => inspectedCandidate(source, { heightPixels: fact(360) }),
    shouldContinue: always,
    scopeStamp: "scope-one",
  });
  assert.equal(noMatch.status, "noMatch");
  assert.equal(noMatch.observations.probesUsed, 2);

  const temporary = await verifyTravelCandidates({
    snapshot: snapshot(),
    candidates: [candidate("temporary", { hints: { bytes: 1 } })],
    inspect: async () => ({ status: "temporaryFailure" }),
    shouldContinue: always,
    scopeStamp: "scope-one",
  });
  assert.equal(temporary.status, "temporaryFailure");
  assert.equal(temporary.retryable, true);
  assert.ok("cursor" in temporary);

  const denied = await verifyTravelCandidates({
    snapshot: snapshot(),
    candidates: [
      candidate("temporary", { hints: { bytes: 1 } }),
      candidate("denied", { hints: { bytes: 2 } }),
    ],
    inspect: async (source) => source.sourceId === "denied"
      ? { status: "accessDenied" }
      : { status: "temporaryFailure" },
    shouldContinue: always,
    scopeStamp: "scope-one",
  });
  assert.equal(denied.status, "accessDenied");
  assert.equal(denied.retryable, false);
  assert.equal(denied.observations.temporaryFailures, 1);
  assert.equal(denied.observations.accessDenials, 1);
});

test("cancellation before inspection makes no call and cancellation after inspection discards its result", async () => {
  const sources = [
    candidate("first", { hints: { bytes: 1 } }),
    candidate("second", { hints: { bytes: 2 } }),
  ];
  let calls = 0;
  const before = await verifyTravelCandidates({
    snapshot: snapshot(),
    candidates: sources,
    inspect: async () => {
      calls++;
      return inspectedCandidate(sources[0]!, { heightPixels: fact(480) });
    },
    shouldContinue: () => false,
    scopeStamp: "scope-one",
  });
  assert.equal(before.status, "cancelled");
  assert.equal(before.observations.probesUsed, 0);
  assert.equal(calls, 0);

  let checks = 0;
  const after = await verifyTravelCandidates({
    snapshot: snapshot(),
    candidates: sources,
    inspect: async (source) => {
      calls++;
      return inspectedCandidate(source, { heightPixels: fact(480) });
    },
    shouldContinue: () => ++checks === 1,
    scopeStamp: "scope-one",
  });
  assert.equal(after.status, "cancelled");
  assert.equal(after.observations.probesUsed, 1);
  assert.equal(calls, 1);
});

test("changed scope, provider configuration or candidate facts reset the cursor", async () => {
  const failures = Array.from({ length: 15 }, (_entry, index) =>
    candidate(`failure-${String(index).padStart(2, "0")}`, { hints: { bytes: index } }));
  const final = candidate("final", { hints: { bytes: 100 } });
  const candidates = [...failures, final];
  const cursorRun = await verifyTravelCandidates({
    snapshot: snapshot(),
    candidates,
    inspect: async () => ({ status: "temporaryFailure" }),
    shouldContinue: always,
    scopeStamp: "scope-one",
  });
  assert.equal(cursorRun.status, "budgetExhausted");

  const resetCalls: string[] = [];
  const variants = [
    { scopeStamp: "scope-two", snapshot: snapshot(), candidates },
    { scopeStamp: "scope-one", snapshot: snapshot(["addon:two", "addon:one"]), candidates },
    {
      scopeStamp: "scope-one",
      snapshot: snapshot(),
      candidates: [...failures, candidate("final", { hints: { bytes: 101 } })],
    },
  ];
  for (const variant of variants) {
    resetCalls.length = 0;
    const result = await verifyTravelCandidates({
      ...variant,
      inspect: async (source) => {
        resetCalls.push(source.sourceId);
        return { status: "temporaryFailure" };
      },
      shouldContinue: always,
      cursor: cursorRun.cursor,
    });
    assert.equal(result.status, "budgetExhausted");
    assert.equal(resetCalls[0], "failure-00");
  }
});

test("cursor roundtrips and neither cursors nor errors expose source addresses or secrets", async () => {
  const secret = "https://private.example/token?secret=top-secret";
  const sources = [
    candidate(secret, { hints: { bytes: 1 } }),
    candidate("visible", { hints: { bytes: 2 } }),
  ];
  const first = await verifyTravelCandidates({
    snapshot: snapshot(),
    candidates: sources,
    inspect: async () => ({ status: "temporaryFailure" }),
    shouldContinue: always,
    scopeStamp: { authorization: "scope-secret", secret },
  });
  assert.equal(first.status, "temporaryFailure");
  assert.ok("cursor" in first);
  const serialized = JSON.stringify(first.cursor);
  assert.doesNotMatch(serialized, /private|token|top-secret|scope-secret|visible/i);
  const restored = JSON.parse(serialized) as unknown;

  const second = await verifyTravelCandidates({
    snapshot: snapshot(),
    candidates: sources,
    inspect: async () => ({ status: "temporaryFailure" }),
    shouldContinue: always,
    scopeStamp: { authorization: "scope-secret", secret },
    cursor: restored as TravelContinuationCursorV1,
  });
  assert.equal(second.status, "temporaryFailure");

  await assert.rejects(
    verifyTravelCandidates({
      snapshot: snapshot(),
      candidates: sources,
      inspect: async () => ({ status: "temporaryFailure" }),
      shouldContinue: always,
      scopeStamp: "scope-one",
      cursor: { ...first.cursor, secret } as unknown as TravelContinuationCursorV1,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Invalid Travel verification input.");
      assert.doesNotMatch(JSON.stringify(error), /private|token|top-secret/i);
      return true;
    },
  );
});

test("wrong profile, wrong operation, malformed cursors and identity changes fail safely", async () => {
  const source = candidate("source", { hints: { bytes: 1 } });
  const badInputs = [
    {
      snapshot: snapshot(undefined, SOURCE_PROFILE_IDS.recommended),
      candidates: [source],
    },
    {
      snapshot: snapshot(undefined, SOURCE_PROFILE_IDS.travel, "play"),
      candidates: [source],
    },
    {
      snapshot: snapshot(),
      candidates: [source],
      cursor: { schemaVersion: 1 } as TravelContinuationCursorV1,
    },
  ];
  for (const bad of badInputs) {
    await assert.rejects(
      verifyTravelCandidates({
        ...bad,
        inspect: async () => ({ status: "temporaryFailure" }),
        shouldContinue: always,
        scopeStamp: "scope-one",
      }),
      { name: "TravelVerificationError", message: "Invalid Travel verification input." },
    );
  }

  await assert.rejects(
    verifyTravelCandidates({
      snapshot: snapshot(),
      candidates: [source],
      inspect: async () => ({
        status: "ok",
        candidate: { ...source, sourceId: "changed" },
      }),
      shouldContinue: always,
      scopeStamp: "scope-one",
    }),
    { name: "TravelVerificationError", message: "Invalid Travel verification input." },
  );
  await assert.rejects(
    verifyTravelCandidates({
      snapshot: snapshot(),
      candidates: [source],
      inspect: async () => ({
        status: "ok",
        candidate: { ...source, capabilities: [] },
      }),
      shouldContinue: always,
      scopeStamp: "scope-one",
    }),
    { name: "TravelVerificationError", message: "Invalid Travel verification input." },
  );
});

test("inspection ordering uses bytes, then frozen provider and stable source identity", async () => {
  const sources = [
    candidate("z-source", {
      providerKey: "addon:two",
      providerResponseIndex: 0,
      hints: { bytes: 1 },
    }),
    candidate("b-source", {
      providerKey: "addon:one",
      providerResponseIndex: 1,
      hints: { bytes: 1 },
    }),
    candidate("a-source", {
      providerKey: "addon:one",
      providerResponseIndex: 0,
      hints: { bytes: 1 },
    }),
    candidate("unknown", {
      providerKey: "addon:one",
      providerResponseIndex: 2,
    }),
  ];
  const calls: string[] = [];
  const result = await verifyTravelCandidates({
    snapshot: snapshot(),
    candidates: sources,
    inspect: async (source) => {
      calls.push(source.sourceId);
      return { status: "temporaryFailure" };
    },
    shouldContinue: always,
    scopeStamp: "scope-one",
  });
  assert.equal(result.status, "temporaryFailure");
  assert.deepEqual(calls, ["a-source", "b-source", "z-source", "unknown"]);
});

test("the persisted rejection set stops growing at its documented bound", async () => {
  const sources = Array.from({ length: 400 }, (_entry, index) =>
    candidate(`rejected-${String(index).padStart(3, "0")}`, { hints: { bytes: index } }));
  let cursor: TravelContinuationCursorV1 | undefined;
  let result;
  for (let attempt = 0; attempt < 18; attempt++) {
    result = await verifyTravelCandidates({
      snapshot: snapshot(),
      candidates: sources,
      inspect: async (source) => inspectedCandidate(source, { heightPixels: fact(360) }),
      shouldContinue: always,
      scopeStamp: "scope-one",
      ...(cursor === undefined ? {} : { cursor }),
    });
    assert.equal(result.status, "budgetExhausted");
    cursor = JSON.parse(JSON.stringify(result.cursor)) as TravelContinuationCursorV1;
  }
  assert.equal(cursor?.rejectedIndices.length, TRAVEL_MAX_REJECTED_INDICES);
  assert.equal(result?.status, "budgetExhausted");
});

test("the evaluator itself rejects a false hinted resolution", () => {
  const source = candidate("hinted", { hints: { heightPixels: 720 } });
  assert.equal(evaluateSourceCandidate(snapshot(), source).status, "needsInspection");
});
