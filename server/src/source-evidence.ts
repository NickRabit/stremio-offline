import { normalizeLanguage } from "./language.js";
import type { SourceAdmissionSnapshotV1 } from "./source-admission.js";
import type { ProviderClass, SourceKind } from "./source-policy.js";
import type { SourceOperation } from "./source-profiles.js";

export type SourceEvidenceLevel = "listed" | "providerMetadata" | "inspected";

export type SourceFact<T> =
  | { readonly evidence: SourceEvidenceLevel; readonly value: T }
  | { readonly evidence: "unknown" };

export type SourceNumericField = "bytes" | "durationSeconds" | "heightPixels";
export type SourceEvidenceTier = "preferred" | "fallback" | "knownOther" | "unknown";
export type SourceEvaluationPurpose = "acquisition" | "existingLocalCopy";

export interface SourceEvidenceFactsV1 {
  readonly audio: {
    readonly listed: SourceFact<readonly string[]>;
    readonly tracks: SourceFact<readonly (string | undefined)[]>;
  };
  readonly embeddedSubtitles: SourceFact<readonly (string | undefined)[]>;
  readonly externalSubtitles: SourceFact<readonly (string | undefined)[]>;
  readonly bytes: SourceFact<number>;
  readonly durationSeconds: SourceFact<number>;
  readonly heightPixels: SourceFact<number>;
  readonly sampleOrTrailer: SourceFact<boolean>;
}

export interface SourceEvidenceCandidateV1 {
  readonly sourceId: string;
  readonly continuationIdentity?: {
    readonly key: string;
    readonly reusableRejection: boolean;
  };
  readonly providerKey: string;
  readonly providerClass: ProviderClass;
  readonly sourceKind: SourceKind;
  readonly capabilities: readonly SourceOperation[];
  readonly providerResponseIndex: number;
  /** Established by the caller after visibility, exact-identity and presence checks. */
  readonly available: boolean;
  readonly facts: SourceEvidenceFactsV1;
  readonly hints?: {
    readonly bytes?: number;
    readonly heightPixels?: number;
  };
}

export type SourceEvidenceReason =
  | { readonly code: "providerOutOfScope" }
  | { readonly code: "sourceKindNotAllowed" }
  | { readonly code: "operationUnsupported" }
  | { readonly code: "sourceUnavailable" }
  | { readonly code: "notOwnedLocalCopy" }
  | { readonly code: "sampleOrTrailer" }
  | { readonly code: "durationTooShort" }
  | { readonly code: "numericOutsideBounds"; readonly field: SourceNumericField }
  | { readonly code: "inspectionRequired"; readonly field: SourceNumericField | "audio" | "subtitles" }
  | { readonly code: "audioLanguageUnavailable" }
  | { readonly code: "subtitleLanguageUnavailable" };

export type SourceEligibilityResult =
  | {
    readonly status: "eligible";
    readonly reasons: [];
    readonly audioTier: SourceEvidenceTier;
    readonly subtitleTier: SourceEvidenceTier;
  }
  | { readonly status: "excluded"; readonly reasons: SourceEvidenceReason[] }
  | { readonly status: "needsInspection"; readonly reasons: SourceEvidenceReason[] };

export interface EligibleSourceCandidate {
  readonly candidate: SourceEvidenceCandidateV1;
  readonly evaluation: Extract<SourceEligibilityResult, { status: "eligible" }>;
}

const authoritative = (evidence: SourceEvidenceLevel): boolean =>
  evidence === "providerMetadata" || evidence === "inspected";

const normalizedLanguages = (value: readonly (string | undefined)[]): string[] =>
  value.flatMap((language) => {
    const normalized = normalizeLanguage(language);
    return normalized ? [normalized] : [];
  });

const hasLanguage = (
  fact: SourceFact<readonly (string | undefined)[]>,
  language: string | undefined,
): boolean => {
  if (!language || fact.evidence === "unknown") return false;
  return normalizedLanguages(fact.value).includes(language);
};

const knownOtherLanguage = (
  fact: SourceFact<readonly (string | undefined)[]>,
  excluded: readonly (string | undefined)[],
): boolean => {
  if (fact.evidence === "unknown") return false;
  const wanted = new Set(excluded.filter((language): language is string => Boolean(language)));
  return normalizedLanguages(fact.value).some((language) => !wanted.has(language));
};

const audioAssessment = (
  mode: "strict" | "listed" | "preferred",
  facts: SourceEvidenceFactsV1["audio"],
  preferred: string,
  fallback: string | undefined,
): { status: "tier"; tier: SourceEvidenceTier } | { status: "needsInspection" } | { status: "excluded" } => {
  const tracksListedLanguage = facts.tracks.evidence !== "unknown"
    && normalizedLanguages(facts.tracks.value).length > 0;
  const authoritativeTracks = facts.tracks.evidence !== "unknown"
    && authoritative(facts.tracks.evidence);

  if (authoritativeTracks) {
    if (hasLanguage(facts.tracks, preferred)) return { status: "tier", tier: "preferred" };
    if (hasLanguage(facts.tracks, fallback)) return { status: "tier", tier: "fallback" };

    if (mode === "strict") {
      return facts.tracks.evidence === "inspected" || tracksListedLanguage
        ? { status: "excluded" }
        : { status: "needsInspection" };
    }
  }

  const listedAvailable = facts.listed.evidence !== "unknown";
  if (listedAvailable && mode !== "strict" && !tracksListedLanguage) {
    if (hasLanguage(facts.listed, preferred)) return { status: "tier", tier: "preferred" };
    if (hasLanguage(facts.listed, fallback)) return { status: "tier", tier: "fallback" };
  }

  if (mode === "preferred") {
    if (authoritativeTracks && tracksListedLanguage) return { status: "tier", tier: "knownOther" };
    if (listedAvailable && knownOtherLanguage(facts.listed, [preferred, fallback])) {
      return { status: "tier", tier: "knownOther" };
    }
    return { status: "tier", tier: "unknown" };
  }

  if (authoritativeTracks && (tracksListedLanguage || facts.tracks.evidence === "inspected")) {
    return { status: "excluded" };
  }
  return { status: "needsInspection" };
};

const subtitleAssessment = (
  mode: "off" | "optional" | "required",
  facts: SourceEvidenceFactsV1,
  preferred: string | undefined,
  fallback: string | undefined,
): { status: "tier"; tier: SourceEvidenceTier } | { status: "needsInspection" } | { status: "excluded" } => {
  if (mode === "off" || !preferred) return { status: "tier", tier: "unknown" };

  const sources: SourceFact<readonly (string | undefined)[]>[] = [
    facts.embeddedSubtitles.evidence === "listed" ? { evidence: "unknown" } : facts.embeddedSubtitles,
    facts.externalSubtitles,
  ];
  if (sources.some((source) => hasLanguage(source, preferred))) return { status: "tier", tier: "preferred" };
  if (fallback && sources.some((source) => hasLanguage(source, fallback))) return { status: "tier", tier: "fallback" };
  if (mode === "optional") {
    if (sources.some((source) => knownOtherLanguage(source, [preferred, fallback]))) {
      return { status: "tier", tier: "knownOther" };
    }
    return { status: "tier", tier: "unknown" };
  }

  if (sources.some((source) => source.evidence === "unknown" || source.evidence === "listed")) {
    return { status: "needsInspection" };
  }
  return { status: "excluded" };
};

const inRange = (value: number, range: { min?: number; max?: number }): boolean =>
  (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max);

const numericAssessment = (
  fact: SourceFact<number>,
  range: { min?: number; max?: number } | undefined,
): { status: "pass" } | { status: "needsInspection" } | { status: "excluded" } => {
  if (!range) return { status: "pass" };
  if (fact.evidence === "unknown" || fact.evidence === "listed" || !Number.isFinite(fact.value)) {
    return { status: "needsInspection" };
  }
  return inRange(fact.value, range) ? { status: "pass" } : { status: "excluded" };
};

const excluded = (reason: SourceEvidenceReason): SourceEligibilityResult => ({
  status: "excluded",
  reasons: [reason],
});

export function evaluateSourceCandidate(
  snapshot: SourceAdmissionSnapshotV1,
  candidate: SourceEvidenceCandidateV1,
  purpose: SourceEvaluationPurpose = "acquisition",
): SourceEligibilityResult {
  const { policy } = snapshot;
  const acquisition = purpose === "acquisition";

  if (acquisition && !snapshot.providerKeys.includes(candidate.providerKey)) {
    return excluded({ code: "providerOutOfScope" });
  }
  if (acquisition && !policy.constraints.sourceKinds.includes(candidate.sourceKind)) {
    return excluded({ code: "sourceKindNotAllowed" });
  }
  if (acquisition && !candidate.capabilities.includes(snapshot.operation)) {
    return excluded({ code: "operationUnsupported" });
  }
  if (purpose === "existingLocalCopy" && (snapshot.operation !== "downloadToLibrary"
    || candidate.providerKey !== "local" || candidate.providerClass !== "local"
    || candidate.sourceKind !== "localFile")) {
    return excluded({ code: "notOwnedLocalCopy" });
  }
  if (!candidate.available) return excluded({ code: "sourceUnavailable" });

  if (purpose === "existingLocalCopy" && policy.existingLocalCopy === "any") {
    return {
      status: "eligible",
      reasons: [],
      audioTier: "unknown",
      subtitleTier: "unknown",
    };
  }

  const sample = candidate.facts.sampleOrTrailer;
  if (sample.evidence !== "unknown" && authoritative(sample.evidence) && sample.value) {
    return excluded({ code: "sampleOrTrailer" });
  }

  const duration = candidate.facts.durationSeconds;
  if (duration.evidence !== "unknown" && authoritative(duration.evidence) && duration.value < 60) {
    return excluded({ code: "durationTooShort" });
  }

  const needsInspection: SourceEvidenceReason[] = [];
  const numeric = [
    ["bytes", candidate.facts.bytes, policy.constraints.bytes],
    ["durationSeconds", candidate.facts.durationSeconds, policy.constraints.durationSeconds],
    ["heightPixels", candidate.facts.heightPixels, policy.constraints.heightPixels],
  ] as const;
  for (const [field, fact, range] of numeric) {
    const assessment = numericAssessment(fact, range);
    if (assessment.status === "excluded") return excluded({ code: "numericOutsideBounds", field });
    if (assessment.status === "needsInspection") needsInspection.push({ code: "inspectionRequired", field });
  }

  const audioPreferred = policy.constraints.audio.preferred;
  const audioFallback = policy.constraints.audio.fallback;
  if (audioPreferred === undefined || !("code" in audioPreferred)) {
    throw new Error("Source admission audio language is not materialized.");
  }
  const audio = audioAssessment(
    policy.constraints.audio.mode,
    candidate.facts.audio,
    audioPreferred.code,
    audioFallback && "code" in audioFallback ? audioFallback.code : undefined,
  );
  if (audio.status === "excluded") return excluded({ code: "audioLanguageUnavailable" });
  if (audio.status === "needsInspection") needsInspection.push({ code: "inspectionRequired", field: "audio" });

  const subtitles = policy.constraints.subtitles;
  let subtitleTier: SourceEvidenceTier = "unknown";
  if (subtitles.mode !== "off") {
    if (subtitles.preferred === undefined || !("code" in subtitles.preferred)) {
      throw new Error("Source admission subtitle language is not materialized.");
    }
    const subtitle = subtitleAssessment(
      subtitles.mode,
      candidate.facts,
      subtitles.preferred.code,
      subtitles.fallback && "code" in subtitles.fallback ? subtitles.fallback.code : undefined,
    );
    if (subtitle.status === "excluded") return excluded({ code: "subtitleLanguageUnavailable" });
    if (subtitle.status === "needsInspection") {
      needsInspection.push({ code: "inspectionRequired", field: "subtitles" });
    } else {
      subtitleTier = subtitle.tier;
    }
  }

  if (needsInspection.length) return { status: "needsInspection", reasons: needsInspection };
  if (audio.status !== "tier") throw new Error("Audio assessment did not produce an evidence tier.");

  return {
    status: "eligible",
    reasons: [],
    audioTier: audio.tier,
    subtitleTier,
  };
}

const tierRank: Record<SourceEvidenceTier, number> = {
  preferred: 0,
  fallback: 1,
  knownOther: 2,
  unknown: 3,
};

const compareNumeric = (
  left: SourceFact<number>,
  right: SourceFact<number>,
  direction: "asc" | "desc",
): number => {
  const leftKnown = left.evidence !== "unknown" && Number.isFinite(left.value);
  const rightKnown = right.evidence !== "unknown" && Number.isFinite(right.value);
  if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
  if (!leftKnown || !rightKnown) return 0;
  const difference = left.value - right.value;
  return direction === "asc" ? difference : -difference;
};

const rankingBytes = (candidate: SourceEvidenceCandidateV1): SourceFact<number> => {
  if (candidate.facts.bytes.evidence !== "unknown") return candidate.facts.bytes;
  const hint = candidate.hints?.bytes;
  return typeof hint === "number" && Number.isFinite(hint) && hint >= 0
    ? { evidence: "listed", value: hint }
    : { evidence: "unknown" };
};

const compareIdentifiers = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareFinalTie = (
  snapshot: SourceAdmissionSnapshotV1,
  left: EligibleSourceCandidate,
  right: EligibleSourceCandidate,
): number => {
  const providerOrder = new Map(snapshot.providerKeys.map((key, index) => [key, index]));
  const leftProvider = providerOrder.get(left.candidate.providerKey) ?? Number.MAX_SAFE_INTEGER;
  const rightProvider = providerOrder.get(right.candidate.providerKey) ?? Number.MAX_SAFE_INTEGER;
  if (leftProvider !== rightProvider) return leftProvider - rightProvider;

  if (left.candidate.providerClass === "local" && right.candidate.providerClass === "local") {
    const byResponse = left.candidate.providerResponseIndex - right.candidate.providerResponseIndex;
    if (byResponse) return byResponse;
  }

  const byIdentity = compareIdentifiers(left.candidate.sourceId, right.candidate.sourceId);
  if (byIdentity) return byIdentity;
  return left.candidate.providerResponseIndex - right.candidate.providerResponseIndex;
};

export function compareEligibleSourceCandidates(
  snapshot: SourceAdmissionSnapshotV1,
  left: EligibleSourceCandidate,
  right: EligibleSourceCandidate,
): number {
  for (const criterion of snapshot.policy.criteria) {
    let comparison = 0;
    switch (criterion.kind) {
      case "providerClass": {
        const rank = new Map(criterion.order.map((providerClass, index) => [providerClass, index]));
        comparison = (rank.get(left.candidate.providerClass) ?? Number.MAX_SAFE_INTEGER)
          - (rank.get(right.candidate.providerClass) ?? Number.MAX_SAFE_INTEGER);
        break;
      }
      case "audioTier":
        comparison = tierRank[left.evaluation.audioTier] - tierRank[right.evaluation.audioTier];
        break;
      case "subtitleTier":
        comparison = tierRank[left.evaluation.subtitleTier] - tierRank[right.evaluation.subtitleTier];
        break;
      case "providerOrder": {
        const keys = "keys" in criterion ? criterion.keys : snapshot.providerKeys;
        const rank = new Map(keys.map((key, index) => [key, index]));
        comparison = (rank.get(left.candidate.providerKey) ?? Number.MAX_SAFE_INTEGER)
          - (rank.get(right.candidate.providerKey) ?? Number.MAX_SAFE_INTEGER);
        break;
      }
      case "size":
        comparison = compareNumeric(rankingBytes(left.candidate), rankingBytes(right.candidate), criterion.direction);
        break;
      case "resolution":
        comparison = compareNumeric(
          left.candidate.facts.heightPixels,
          right.candidate.facts.heightPixels,
          criterion.direction,
        );
        break;
    }
    if (comparison) return comparison;
  }
  return compareFinalTie(snapshot, left, right);
}

export function rankEligibleSources(
  snapshot: SourceAdmissionSnapshotV1,
  candidates: readonly SourceEvidenceCandidateV1[],
  purpose: SourceEvaluationPurpose = "acquisition",
): EligibleSourceCandidate[] {
  return candidates.flatMap((candidate): EligibleSourceCandidate[] => {
    const evaluation = evaluateSourceCandidate(snapshot, candidate, purpose);
    return evaluation.status === "eligible" ? [{ candidate, evaluation }] : [];
  }).sort((left, right) => compareEligibleSourceCandidates(snapshot, left, right));
}
