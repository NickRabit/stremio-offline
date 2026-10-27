import assert from "node:assert/strict";
import test from "node:test";
import {
  compareEligibleSourceCandidates,
  evaluateSourceCandidate,
  rankEligibleSources,
  type SourceEvidenceCandidateV1,
  type SourceEvidenceFactsV1,
  type SourceEvidenceLevel,
  type SourceFact,
  type EligibleSourceCandidate,
} from "./source-evidence.js";
import {
  type SourceAdmissionSnapshotV1,
} from "./source-admission.js";
import {
  parseSourcePolicyV1,
  type ExistingLocalCopyPolicy,
  type SourcePolicyConstraints,
  type SourcePolicyCriterion,
} from "./source-policy.js";

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
  releaseKind: unknown(),
  sampleOrTrailer: unknown(),
  ...overrides,
});

const candidate = (
  overrides: Partial<Omit<SourceEvidenceCandidateV1, "facts">> & {
    facts?: Partial<SourceEvidenceFactsV1>;
  } = {},
): SourceEvidenceCandidateV1 => {
  const { facts: factOverrides, ...candidateOverrides } = overrides;
  return {
    sourceId: "source-one",
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

const snapshot = (options: {
  providerKeys?: string[];
  sourceKinds?: SourcePolicyConstraints["sourceKinds"];
  audio?: SourcePolicyConstraints["audio"];
  subtitles?: SourcePolicyConstraints["subtitles"];
  bytes?: SourcePolicyConstraints["bytes"];
  durationSeconds?: SourcePolicyConstraints["durationSeconds"];
  heightPixels?: SourcePolicyConstraints["heightPixels"];
  criteria?: SourcePolicyCriterion[];
  existingLocalCopy?: ExistingLocalCopyPolicy;
} = {}): SourceAdmissionSnapshotV1 => {
  const providerKeys = options.providerKeys ?? ["addon:one", "addon:two", "local"];
  return {
    schemaVersion: 1,
    profile: { id: "profile", revision: 1, template: "travel" },
    operation: "downloadToLibrary",
    providerKeys,
    policy: parseSourcePolicyV1({
      schemaVersion: 1,
      scope: { mode: "selected", providerKeys },
      constraints: {
        sourceKinds: options.sourceKinds ?? ["http"],
        audio: options.audio ?? { mode: "preferred", preferred: { code: "cs" }, fallback: { code: "en" } },
        subtitles: options.subtitles ?? { mode: "off" },
        ...(options.bytes === undefined ? {} : { bytes: options.bytes }),
        ...(options.durationSeconds === undefined ? {} : { durationSeconds: options.durationSeconds }),
        ...(options.heightPixels === undefined ? {} : { heightPixels: options.heightPixels }),
      },
      criteria: options.criteria ?? [],
      nextEpisode: "profile",
      existingLocalCopy: options.existingLocalCopy ?? "meetsRequirements",
    }),
  };
};

const best = (items: EligibleSourceCandidate[]): EligibleSourceCandidate => {
  const first = items[0];
  assert.ok(first);
  return first;
};

test("a title-text 720p hint cannot override an inspected 360p fact", () => {
  const result = evaluateSourceCandidate(
    snapshot({ heightPixels: { min: 480 } }),
    candidate({
      hints: { heightPixels: 720, bytes: 8_000_000_000 },
      facts: { heightPixels: fact(360), bytes: fact(1_000_000, "providerMetadata") },
    }),
  );
  assert.deepEqual(result, {
    status: "excluded",
    reasons: [{ code: "numericOutsideBounds", field: "heightPixels" }],
  });
});

test("authoritative 360p metadata excludes without inspection", () => {
  const decision = evaluateSourceCandidate(
    snapshot({ heightPixels: { min: 480 } }),
    candidate({ facts: { heightPixels: fact(360, "providerMetadata") } }),
  );
  assert.equal(decision.status, "excluded");
});

test("provider metadata proving 480p satisfies the bound", () => {
  const decision = evaluateSourceCandidate(
    snapshot({ heightPixels: { min: 480 } }),
    candidate({ facts: { heightPixels: fact(480, "providerMetadata") } }),
  );
  assert.equal(decision.status, "eligible");
});

test("an inspected high-resolution source under one minute is still a short sample", () => {
  const decision = evaluateSourceCandidate(
    snapshot({ heightPixels: { min: 480 } }),
    candidate({
      facts: {
        heightPixels: fact(2160),
        durationSeconds: fact(59),
        sampleOrTrailer: fact(false),
      },
    }),
  );
  assert.deepEqual(decision, { status: "excluded", reasons: [{ code: "durationTooShort" }] });
});

test("an authoritative sample flag is rejected without inspection", () => {
  const decision = evaluateSourceCandidate(
    snapshot(),
    candidate({ facts: { sampleOrTrailer: fact(true, "providerMetadata") } }),
  );
  assert.deepEqual(decision, { status: "excluded", reasons: [{ code: "sampleOrTrailer" }] });
});

test("low-bitrate legitimate content just over one minute remains eligible", () => {
  const decision = evaluateSourceCandidate(
    snapshot({
      bytes: { max: 30_000_000 },
      durationSeconds: { min: 60 },
      heightPixels: { min: 480 },
    }),
    candidate({
      facts: {
        bytes: fact(20_000_000, "providerMetadata"),
        durationSeconds: fact(61, "providerMetadata"),
        heightPixels: fact(480, "providerMetadata"),
      },
    }),
  );
  assert.equal(decision.status, "eligible");
});

test("an unknown bounded height needs inspection", () => {
  const decision = evaluateSourceCandidate(
    snapshot({ heightPixels: { min: 480 } }),
    candidate({ hints: { heightPixels: 1080 } }),
  );
  assert.deepEqual(decision, {
    status: "needsInspection",
    reasons: [{ code: "inspectionRequired", field: "heightPixels" }],
  });
});

test("a known zero is not treated as an unknown fact", () => {
  const profile = snapshot({ bytes: { max: 0 } });
  assert.equal(evaluateSourceCandidate(profile, candidate({
    facts: { bytes: fact(0, "providerMetadata") },
  })).status, "eligible");
  assert.equal(evaluateSourceCandidate(profile, candidate()).status, "needsInspection");
});

test("audio modes use listing and authoritative track evidence differently", () => {
  const strict = snapshot({ audio: { mode: "strict", preferred: { code: "cs" }, fallback: { code: "en" } } });
  assert.deepEqual(
    evaluateSourceCandidate(strict, candidate({
      facts: { audio: { listed: fact(["cs"], "listed"), tracks: unknown() } },
    })),
    { status: "needsInspection", reasons: [{ code: "inspectionRequired", field: "audio" }] },
  );
  assert.equal(evaluateSourceCandidate(strict, candidate({
    facts: { audio: { listed: unknown<readonly string[]>(), tracks: fact(["cs"], "providerMetadata") } },
  })).status, "eligible");

  const listed = snapshot({ audio: { mode: "listed", preferred: { code: "cs" }, fallback: { code: "en" } } });
  assert.deepEqual(
    evaluateSourceCandidate(listed, candidate({
      facts: { audio: { listed: fact(["cs"], "listed"), tracks: fact([undefined]) } },
    })),
    {
      status: "eligible",
      reasons: [],
      audioTier: "preferred",
      subtitleTier: "unknown",
    },
  );
  assert.deepEqual(
    evaluateSourceCandidate(listed, candidate({
      facts: { audio: { listed: fact(["cs"], "listed"), tracks: fact(["de"]) } },
    })),
    { status: "excluded", reasons: [{ code: "audioLanguageUnavailable" }] },
  );
  assert.deepEqual(
    evaluateSourceCandidate(listed, candidate({
      facts: { audio: { listed: unknown<readonly string[]>(), tracks: fact(["de"]) } },
    })),
    { status: "excluded", reasons: [{ code: "audioLanguageUnavailable" }] },
  );

  const preferred = snapshot({ audio: { mode: "preferred", preferred: { code: "cs" }, fallback: { code: "en" } } });
  assert.deepEqual(
    evaluateSourceCandidate(preferred, candidate({
      facts: { audio: { listed: unknown<readonly string[]>(), tracks: fact(["de"]) } },
    })),
    {
      status: "eligible",
      reasons: [],
      audioTier: "knownOther",
      subtitleTier: "unknown",
    },
  );
  assert.equal(evaluateSourceCandidate(preferred, candidate()).status, "eligible");
});

test("audio ranking follows preferred, fallback, known-other and unknown tiers", () => {
  const ranked = rankEligibleSources(
    snapshot({
      audio: { mode: "preferred", preferred: { code: "cs" }, fallback: { code: "en" } },
      criteria: [{ kind: "audioTier" }],
    }),
    [
      candidate({ sourceId: "unknown" }),
      candidate({ sourceId: "other", facts: { audio: { listed: unknown<readonly string[]>(), tracks: fact(["de"]) } } }),
      candidate({ sourceId: "fallback", facts: { audio: { listed: unknown<readonly string[]>(), tracks: fact(["en"]) } } }),
      candidate({ sourceId: "preferred", facts: { audio: { listed: unknown<readonly string[]>(), tracks: fact(["cs"]) } } }),
    ],
  );
  assert.deepEqual(ranked.map((item) => item.candidate.sourceId), [
    "preferred",
    "fallback",
    "other",
    "unknown",
  ]);
});

test("required subtitles need a matching embedded or external language", () => {
  const required = snapshot({
    audio: { mode: "preferred", preferred: { code: "cs" } },
    subtitles: { mode: "required", preferred: { code: "cs" }, fallback: { code: "en" } },
  });
  assert.equal(evaluateSourceCandidate(required, candidate({
    facts: { externalSubtitles: fact(["cs"], "listed") },
  })).status, "eligible");
  assert.deepEqual(evaluateSourceCandidate(required, candidate({
    facts: { embeddedSubtitles: fact(["cs"], "listed"), externalSubtitles: fact([]) },
  })), {
    status: "needsInspection",
    reasons: [{ code: "inspectionRequired", field: "subtitles" }],
  });
  assert.deepEqual(
    evaluateSourceCandidate(required, candidate({
      facts: {
        embeddedSubtitles: fact(["de"]),
        externalSubtitles: fact([]),
      },
    })),
    { status: "excluded", reasons: [{ code: "subtitleLanguageUnavailable" }] },
  );
  assert.deepEqual(
    evaluateSourceCandidate(required, candidate()),
    { status: "needsInspection", reasons: [{ code: "inspectionRequired", field: "subtitles" }] },
  );

  const optional = snapshot({
    audio: { mode: "preferred", preferred: { code: "cs" } },
    subtitles: { mode: "optional", preferred: { code: "cs" } },
  });
  assert.equal(evaluateSourceCandidate(optional, candidate()).status, "eligible");
});

test("existing local-copy policies ignore acquisition scope but differ on content", () => {
  const local = candidate({
    sourceId: "owned-copy",
    providerKey: "local",
    providerClass: "local",
    sourceKind: "localFile",
    capabilities: [],
    facts: {
      audio: { listed: unknown<readonly string[]>(), tracks: fact(["cs"], "providerMetadata") },
      heightPixels: fact(360, "providerMetadata"),
    },
  });
  const acquisition = snapshot({
    providerKeys: ["addon:one", "addon:two"],
    heightPixels: { min: 480 },
  });
  const meets = snapshot({
    heightPixels: { min: 480 },
    existingLocalCopy: "meetsRequirements",
  });
  const any = snapshot({
    heightPixels: { min: 480 },
    existingLocalCopy: "any",
  });

  assert.deepEqual(
    evaluateSourceCandidate(acquisition, local),
    { status: "excluded", reasons: [{ code: "providerOutOfScope" }] },
  );
  assert.deepEqual(
    evaluateSourceCandidate(meets, local, "existingLocalCopy"),
    { status: "excluded", reasons: [{ code: "numericOutsideBounds", field: "heightPixels" }] },
  );
  assert.equal(evaluateSourceCandidate(any, local, "existingLocalCopy").status, "eligible");
  assert.equal(evaluateSourceCandidate(any, { ...local, available: false }, "existingLocalCopy").status, "excluded");
});

test("an HTTP-only acquisition profile accepts an adequate owned local copy", () => {
  const owned = candidate({
    sourceId: "owned",
    providerKey: "local",
    providerClass: "local",
    sourceKind: "localFile",
    capabilities: [],
    facts: {
      audio: { listed: unknown<readonly string[]>(), tracks: fact(["cs"], "providerMetadata") },
      heightPixels: fact(480, "providerMetadata"),
    },
  });
  const profile = snapshot({
    sourceKinds: ["http"],
    heightPixels: { min: 480 },
    existingLocalCopy: "meetsRequirements",
  });
  assert.equal(evaluateSourceCandidate(profile, owned, "existingLocalCopy").status, "eligible");
  assert.equal(rankEligibleSources(profile, [owned], "existingLocalCopy").length, 1);
});

test("a remote-only copy cannot satisfy local ownership", () => {
  const remote = candidate({
    sourceId: "remote-episode",
    providerKey: "remote:visible-library",
    providerClass: "remote",
    sourceKind: "mediaServerOriginal",
    capabilities: ["downloadToLibrary"],
    facts: {
      audio: { listed: unknown<readonly string[]>(), tracks: fact(["cs"], "providerMetadata") },
      heightPixels: fact(1080, "providerMetadata"),
    },
  });
  for (const existingLocalCopy of ["any", "meetsRequirements"] as const) {
    const policy = snapshot({ existingLocalCopy, heightPixels: { min: 480 } });
    assert.deepEqual(evaluateSourceCandidate(policy, remote, "existingLocalCopy"), {
      status: "excluded",
      reasons: [{ code: "notOwnedLocalCopy" }],
    });
    assert.deepEqual(rankEligibleSources(policy, [remote], "existingLocalCopy"), []);
  }
});

test("ranking reads class, provider and size criteria in order", () => {
  const profile = snapshot({
    providerKeys: ["local", "addon:alpha", "addon:beta"],
    sourceKinds: ["http", "localFile"],
    criteria: [
      { kind: "providerClass", order: ["addon", "local", "remote"] },
      { kind: "providerOrder", keys: ["addon:alpha", "addon:beta", "local"] },
      { kind: "size", direction: "asc" },
    ],
  });
  const audio = {
    listed: unknown<readonly string[]>(),
    tracks: fact(["cs"], "providerMetadata"),
  } as const;
  const ranked = rankEligibleSources(profile, [
    candidate({
      sourceId: "local-large",
      providerKey: "local",
      providerClass: "local",
      sourceKind: "localFile",
      capabilities: ["downloadToLibrary"],
      facts: { audio, bytes: fact(100) },
    }),
    candidate({
      sourceId: "beta-small",
      providerKey: "addon:beta",
      facts: { audio, bytes: fact(100) },
    }),
    candidate({
      sourceId: "alpha-large",
      providerKey: "addon:alpha",
      facts: { audio, bytes: fact(300) },
    }),
    candidate({
      sourceId: "alpha-small",
      providerKey: "addon:alpha",
      facts: { audio, bytes: fact(100) },
    }),
  ]);
  assert.deepEqual(ranked.map((item) => item.candidate.sourceId), [
    "alpha-small",
    "alpha-large",
    "beta-small",
    "local-large",
  ]);
});

test("frozen provider order and stable source identity break otherwise equal ties", () => {
  const profile = snapshot({ providerKeys: ["addon:two", "addon:one"] });
  const ranked = rankEligibleSources(profile, [
    candidate({ sourceId: "source-b", providerKey: "addon:one" }),
    candidate({ sourceId: "source-a", providerKey: "addon:one" }),
    candidate({ sourceId: "source-z", providerKey: "addon:two" }),
  ]);
  assert.deepEqual(ranked.map((item) => item.candidate.sourceId), ["source-z", "source-a", "source-b"]);
});

test("local copies preserve response order when their other rank keys tie", () => {
  const profile = snapshot({ providerKeys: ["local"] });
  const ranked = rankEligibleSources(profile, [
    candidate({
      sourceId: "z-copy",
      providerKey: "local",
      providerClass: "local",
      sourceKind: "localFile",
      providerResponseIndex: 0,
    }),
    candidate({
      sourceId: "a-copy",
      providerKey: "local",
      providerClass: "local",
      sourceKind: "localFile",
      providerResponseIndex: 1,
    }),
  ], "existingLocalCopy");
  assert.deepEqual(ranked.map((item) => item.candidate.sourceId), ["z-copy", "a-copy"]);
});

test("unknown numeric values sort last in both directions", () => {
  const source = (sourceId: string, bytes: SourceFact<number>) => candidate({
    sourceId,
    facts: { bytes },
  });
  for (const direction of ["asc", "desc"] as const) {
    const ranked = rankEligibleSources(
      snapshot({ criteria: [{ kind: "size", direction }] }),
      [source("unknown", unknown()), source("known", fact(1_000))],
    );
    assert.deepEqual(ranked.map((item) => item.candidate.sourceId), ["known", "unknown"]);
  }
});

test("listing size hints break ties only for soft size ranking", () => {
  const facts = {
    audio: {
      listed: unknown<readonly string[]>(),
      tracks: fact(["cs"]),
    },
    heightPixels: fact(480),
  } as const;
  const large = candidate({
    sourceId: "a-large",
    hints: { bytes: 200 },
    facts,
  });
  const small = candidate({
    sourceId: "z-small",
    hints: { bytes: 100 },
    facts,
  });
  const ranked = rankEligibleSources(
    snapshot({ criteria: [{ kind: "size", direction: "asc" }] }),
    [large, small],
  );
  assert.deepEqual(ranked.map((item) => item.candidate.sourceId), ["z-small", "a-large"]);

  assert.deepEqual(
    evaluateSourceCandidate(snapshot({ bytes: { max: 150 } }), small),
    { status: "needsInspection", reasons: [{ code: "inspectionRequired", field: "bytes" }] },
  );
});

test("provider order still decides when both size facts and hints are unknown", () => {
  const ranked = rankEligibleSources(
    snapshot({
      providerKeys: ["addon:two", "addon:one"],
      criteria: [{ kind: "size", direction: "asc" }],
    }),
    [
      candidate({ sourceId: "one", providerKey: "addon:one" }),
      candidate({ sourceId: "two", providerKey: "addon:two" }),
    ],
  );
  assert.deepEqual(ranked.map((item) => item.candidate.sourceId), ["two", "one"]);
});

test("ranking does not add a size preference when criteria omit size", () => {
  const profile = snapshot();
  const ranked = rankEligibleSources(profile, [
    candidate({ sourceId: "z-large", facts: { bytes: fact(10_000) } }),
    candidate({ sourceId: "a-small", facts: { bytes: fact(1) } }),
  ]);
  assert.deepEqual(ranked.map((item) => item.candidate.sourceId), ["a-small", "z-large"]);
});

test("eligible comparator is deterministic for evaluated candidates", () => {
  const profile = snapshot();
  const evaluated = rankEligibleSources(profile, [
    candidate({ sourceId: "source-b" }),
    candidate({ sourceId: "source-a" }),
  ]);
  const first = best(evaluated);
  assert.equal(first.candidate.sourceId, "source-a");
  assert.ok(compareEligibleSourceCandidates(profile, first, evaluated[1]!) < 0);
});

test("machine-readable reasons do not echo source names, URLs or tokens", () => {
  const privateCandidate = candidate({
    providerKey: "addon:not-selected",
    sourceId: "https://private.example/token?secret=s3cr3t",
  }) as SourceEvidenceCandidateV1 & { name: string; url: string };
  privateCandidate.name = "Private provider";
  privateCandidate.url = "https://private.example/token?secret=s3cr3t";
  const result = evaluateSourceCandidate(snapshot(), privateCandidate);
  const serialized = JSON.stringify(result);
  assert.deepEqual(result, { status: "excluded", reasons: [{ code: "providerOutOfScope" }] });
  assert.doesNotMatch(serialized, /private|token|secret|s3cr3t/i);
});
