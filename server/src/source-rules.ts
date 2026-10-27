import { createHash } from "node:crypto";
import {
  compareFinalTie,
  evaluateSourceCandidate,
  rankingBytes,
  type EligibleSourceCandidate,
  type SourceEvidenceCandidateV1,
  type SourceEvidenceTier,
} from "./source-evidence.js";
import {
  parseSourceAdmissionSnapshotV1,
  type SourceAdmissionSnapshotV1,
} from "./source-admission.js";

export const RULES_INSPECTION_BUDGET = 15;
export const RULES_MAX_CURSOR_ENTRIES = 256;

const MAX_CANDIDATES = 10_000;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const TIERS = new Set<SourceEvidenceTier>(["preferred", "fallback", "knownOther", "unknown"]);

export interface RulesVerifiedCandidateV1 {
  readonly continuationKey: string;
  readonly audioTier: SourceEvidenceTier;
  readonly heightPixels?: number;
  readonly subtitleTier: SourceEvidenceTier;
}

export interface RulesContinuationCursorV1 {
  readonly schemaVersion: 1;
  readonly scopeFingerprint: string;
  readonly listingFingerprint: string;
  readonly nextIndex: number;
  readonly rejectedIndices: readonly number[];
  readonly verified: readonly RulesVerifiedCandidateV1[];
}

export type RulesInspectionResult =
  | { readonly status: "ok"; readonly candidate: SourceEvidenceCandidateV1 }
  | { readonly status: "temporaryFailure" }
  | { readonly status: "accessDenied" };

export interface VerifyRulesCandidatesInput {
  readonly snapshot: SourceAdmissionSnapshotV1;
  readonly candidates: readonly SourceEvidenceCandidateV1[];
  readonly inspect: (candidate: SourceEvidenceCandidateV1) => Promise<RulesInspectionResult>;
  readonly shouldContinue: () => boolean;
  readonly scopeStamp: unknown;
  readonly hasRealDebrid: boolean;
  readonly cursor?: RulesContinuationCursorV1;
  readonly finalTemporaryAttempt?: boolean;
}

export interface RulesObservationSummary {
  readonly probesUsed: number;
  readonly confirmedRejections: number;
  readonly temporaryFailures: number;
  readonly accessDenials: number;
  readonly unresolvedCandidates: number;
}

export interface RulesSelectedCandidate {
  readonly candidate: SourceEvidenceCandidateV1;
  readonly audioTier: SourceEvidenceTier;
  readonly heightPixels?: number;
  readonly subtitleTier: SourceEvidenceTier;
}

export type RulesVerificationOutcome =
  | {
    readonly status: "selected";
    readonly selection: RulesSelectedCandidate;
    readonly searchStatus: "complete";
    readonly retryable: false;
    readonly observations: RulesObservationSummary;
  }
  | {
    readonly status: "budgetExhausted";
    readonly retryable: true;
    readonly observations: RulesObservationSummary;
    readonly cursor: RulesContinuationCursorV1;
  }
  | {
    readonly status: "temporaryFailure";
    readonly retryable: true;
    readonly observations: RulesObservationSummary;
    readonly cursor: RulesContinuationCursorV1;
  }
  | {
    readonly status: "noMatch";
    readonly retryable: false;
    readonly observations: RulesObservationSummary;
  }
  | {
    readonly status: "accessDenied";
    readonly retryable: false;
    readonly observations: RulesObservationSummary;
  }
  | {
    readonly status: "cancelled";
    readonly retryable: false;
    readonly observations: RulesObservationSummary;
  };

export class RulesVerificationError extends Error {
  constructor() {
    super("Invalid rules source verification input.");
    this.name = "RulesVerificationError";
  }
}

interface RankedCandidate extends RulesSelectedCandidate {
  readonly responseOrder: number;
}

const invalid = (): never => {
  throw new RulesVerificationError();
};

const canonicalJson = (value: unknown): string => {
  const ancestors = new Set<object>();
  const encode = (current: unknown): string => {
    if (current === null) return "null";
    if (typeof current === "string" || typeof current === "boolean") return JSON.stringify(current);
    if (typeof current === "number") return Number.isFinite(current) ? JSON.stringify(current) : invalid();
    if (typeof current !== "object") return invalid();
    if (ancestors.has(current)) return invalid();
    ancestors.add(current);
    let encoded: string;
    if (Array.isArray(current)) {
      encoded = `[${current.map((entry) => entry === undefined ? "null" : encode(entry)).join(",")}]`;
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return invalid();
      encoded = `{${Object.keys(current)
        .filter((key) => (current as Record<string, unknown>)[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode((current as Record<string, unknown>)[key])}`)
        .join(",")}}`;
    }
    ancestors.delete(current);
    return encoded;
  };
  return encode(value);
};

const fingerprint = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

const continuationIdentity = (
  candidate: SourceEvidenceCandidateV1,
): NonNullable<SourceEvidenceCandidateV1["continuationIdentity"]> | undefined => {
  if (candidate === null || typeof candidate !== "object") return invalid();
  const identity = candidate.continuationIdentity;
  if (identity === undefined) return undefined;
  if (identity === null || typeof identity !== "object" || Array.isArray(identity)
    || Object.getPrototypeOf(identity) !== Object.prototype) return invalid();
  const keys = Object.keys(identity);
  if (keys.length !== 2 || !Object.hasOwn(identity, "key") || !Object.hasOwn(identity, "reusableRejection")
    || typeof identity.key !== "string" || identity.key.length === 0
    || typeof identity.reusableRejection !== "boolean") return invalid();
  return identity;
};

const continuationKey = (candidate: SourceEvidenceCandidateV1): string =>
  continuationIdentity(candidate)?.key ?? candidate.sourceId;

const persistsRejection = (candidate: SourceEvidenceCandidateV1): boolean =>
  continuationIdentity(candidate)?.reusableRejection ?? true;

const listing = (
  snapshot: SourceAdmissionSnapshotV1,
  candidates: readonly SourceEvidenceCandidateV1[],
) => ({
  snapshot: {
    schemaVersion: snapshot.schemaVersion,
    profile: snapshot.profile,
    operation: snapshot.operation,
    providerKeys: snapshot.providerKeys,
    policy: snapshot.policy,
  },
  candidates: candidates.map((candidate) => ({
    continuationIdentity: continuationKey(candidate),
    providerKey: candidate.providerKey,
    providerClass: candidate.providerClass,
    sourceKind: candidate.sourceKind,
    capabilities: candidate.capabilities,
    providerResponseIndex: candidate.providerResponseIndex,
    available: candidate.available,
    facts: candidate.facts,
    hints: candidate.hints,
  })),
});

const parseVerified = (input: unknown): RulesVerifiedCandidateV1 => {
  if (input === null || typeof input !== "object" || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype) return invalid();
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.length !== (value.heightPixels === undefined ? 3 : 4)
    || !Object.hasOwn(value, "continuationKey")
    || !Object.hasOwn(value, "audioTier")
    || !Object.hasOwn(value, "subtitleTier")
    || typeof value.continuationKey !== "string" || value.continuationKey.length === 0
    || typeof value.audioTier !== "string" || !TIERS.has(value.audioTier as SourceEvidenceTier)
    || typeof value.subtitleTier !== "string" || !TIERS.has(value.subtitleTier as SourceEvidenceTier)
    || (value.heightPixels !== undefined
      && (typeof value.heightPixels !== "number" || !Number.isFinite(value.heightPixels) || value.heightPixels < 0))) {
    return invalid();
  }
  return {
    continuationKey: value.continuationKey,
    audioTier: value.audioTier as SourceEvidenceTier,
    subtitleTier: value.subtitleTier as SourceEvidenceTier,
    ...(value.heightPixels === undefined ? {} : { heightPixels: value.heightPixels as number }),
  };
};

export const parseRulesContinuationCursorV1 = (
  input: unknown,
): RulesContinuationCursorV1 | undefined => {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== "object" || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype) return invalid();
  const expected = [
    "schemaVersion",
    "scopeFingerprint",
    "listingFingerprint",
    "nextIndex",
    "rejectedIndices",
    "verified",
  ];
  const keys = Object.keys(input);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(input, key))) invalid();
  const cursor = input as Record<string, unknown>;
  if (cursor.schemaVersion !== 1
    || typeof cursor.scopeFingerprint !== "string" || !FINGERPRINT.test(cursor.scopeFingerprint)
    || typeof cursor.listingFingerprint !== "string" || !FINGERPRINT.test(cursor.listingFingerprint)
    || typeof cursor.nextIndex !== "number" || !Number.isSafeInteger(cursor.nextIndex) || cursor.nextIndex < 0
    || !Array.isArray(cursor.rejectedIndices) || cursor.rejectedIndices.length > RULES_MAX_CURSOR_ENTRIES
    || !Array.isArray(cursor.verified) || cursor.verified.length > RULES_MAX_CURSOR_ENTRIES) {
    return invalid();
  }

  let previous = -1;
  for (const index of cursor.rejectedIndices) {
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index <= previous) invalid();
    previous = index;
  }
  const verified = cursor.verified.map(parseVerified);
  if (new Set(verified.map((entry) => entry.continuationKey)).size !== verified.length) invalid();
  return {
    schemaVersion: 1,
    scopeFingerprint: cursor.scopeFingerprint,
    listingFingerprint: cursor.listingFingerprint,
    nextIndex: cursor.nextIndex,
    rejectedIndices: [...cursor.rejectedIndices] as number[],
    verified,
  };
};

const tierRank: Record<SourceEvidenceTier, number> = {
  preferred: 0,
  fallback: 1,
  knownOther: 2,
  unknown: 3,
};

const listingAudioTier = (
  candidate: SourceEvidenceCandidateV1,
  snapshot: SourceAdmissionSnapshotV1,
): SourceEvidenceTier => {
  const listed = candidate.facts.audio.listed;
  if (listed.evidence === "unknown") return "unknown";
  const audio = snapshot.policy.constraints.audio;
  const preferred = "code" in audio.preferred ? audio.preferred.code : undefined;
  const fallback = audio.fallback && "code" in audio.fallback ? audio.fallback.code : undefined;
  if (preferred && listed.value.includes(preferred)) return "preferred";
  if (fallback && listed.value.includes(fallback)) return "fallback";
  return listed.value.length ? "knownOther" : "unknown";
};

const knownHeight = (candidate: SourceEvidenceCandidateV1): number | undefined => {
  const fact = candidate.facts.heightPixels;
  if (fact.evidence !== "unknown" && Number.isFinite(fact.value) && fact.value >= 0) return fact.value;
  const hint = candidate.hints?.heightPixels;
  return hint !== undefined && Number.isFinite(hint) && hint >= 0 ? hint : undefined;
};

const compareKnown = (
  left: number | undefined,
  right: number | undefined,
  direction: "asc" | "desc",
): number => {
  if (left !== right) {
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return direction === "asc" ? left - right : right - left;
  }
  return 0;
};

const compareNumericFacts = (
  left: ReturnType<typeof rankingBytes>,
  right: ReturnType<typeof rankingBytes>,
  direction: "asc" | "desc",
): number => {
  const leftKnown = left.evidence !== "unknown" && Number.isFinite(left.value);
  const rightKnown = right.evidence !== "unknown" && Number.isFinite(right.value);
  if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
  if (!leftKnown || !rightKnown) return 0;
  return direction === "asc" ? left.value - right.value : right.value - left.value;
};

const eligibleShell = (entry: RankedCandidate): EligibleSourceCandidate => ({
  candidate: entry.candidate,
  evaluation: {
    status: "eligible",
    reasons: [],
    audioTier: entry.audioTier,
    subtitleTier: entry.subtitleTier,
  },
});

const comparePreference = (
  snapshot: SourceAdmissionSnapshotV1,
  left: RankedCandidate,
  right: RankedCandidate,
): number => {
  for (const criterion of snapshot.policy.criteria) {
    let comparison = 0;
    switch (criterion.kind) {
      case "audioTier":
        comparison = tierRank[left.audioTier] - tierRank[right.audioTier];
        break;
      case "resolution":
        comparison = compareKnown(left.heightPixels, right.heightPixels, criterion.direction);
        break;
      case "size":
        comparison = compareNumericFacts(rankingBytes(left.candidate), rankingBytes(right.candidate), criterion.direction);
        break;
      case "providerOrder": {
        const keys = "keys" in criterion ? criterion.keys : snapshot.providerKeys;
        const rank = new Map(keys.map((key, index) => [key, index]));
        comparison = (rank.get(left.candidate.providerKey) ?? Number.MAX_SAFE_INTEGER)
          - (rank.get(right.candidate.providerKey) ?? Number.MAX_SAFE_INTEGER);
        break;
      }
      default:
        break;
    }
    if (comparison) return comparison;
  }
  const tie = compareFinalTie(snapshot, eligibleShell(left), eligibleShell(right));
  if (tie) return tie;
  return left.responseOrder - right.responseOrder;
};

const actualRanking = (
  candidate: SourceEvidenceCandidateV1,
  verified: RulesVerifiedCandidateV1 | undefined,
  audioTier: SourceEvidenceTier,
  subtitleTier: SourceEvidenceTier,
  responseOrder: number,
): RankedCandidate => {
  const heightPixels = verified?.heightPixels ?? knownHeight(candidate);
  return {
    candidate,
    audioTier: verified?.audioTier ?? audioTier,
    subtitleTier: verified?.subtitleTier ?? subtitleTier,
    ...(heightPixels === undefined ? {} : { heightPixels }),
    responseOrder,
  };
};

const listingRanking = (
  candidate: SourceEvidenceCandidateV1,
  snapshot: SourceAdmissionSnapshotV1,
  responseOrder: number,
): RankedCandidate => ({
  candidate,
  audioTier: listingAudioTier(candidate, snapshot),
  subtitleTier: "unknown",
  ...(knownHeight(candidate) === undefined ? {} : { heightPixels: knownHeight(candidate) }),
  responseOrder,
});

const optimisticRanking = (
  candidate: SourceEvidenceCandidateV1,
  snapshot: SourceAdmissionSnapshotV1,
  responseOrder: number,
): RankedCandidate => {
  const base = listingRanking(candidate, snapshot, responseOrder);
  let heightPixels = base.heightPixels;
  const resolution = snapshot.policy.criteria.find((criterion) => criterion.kind === "resolution");
  if (resolution?.kind === "resolution") {
    const fact = candidate.facts.heightPixels;
    if (fact.evidence === "providerMetadata" || fact.evidence === "inspected") {
      heightPixels = fact.value;
    } else if (resolution.direction === "desc") {
      heightPixels = snapshot.policy.constraints.heightPixels?.max ?? Number.MAX_SAFE_INTEGER;
    } else {
      heightPixels = snapshot.policy.constraints.heightPixels?.min ?? 0;
    }
  }
  return {
    ...base,
    audioTier: snapshot.policy.constraints.audio.mode === "strict"
      || snapshot.policy.constraints.audio.mode === "preferred"
      ? "preferred"
      : base.audioTier,
    ...(heightPixels === undefined ? {} : { heightPixels }),
  };
};

const observations = (input: {
  probesUsed: number;
  confirmedRejections: number;
  temporaryFailures: number;
  accessDenials: number;
  unresolvedCandidates: number;
}): RulesObservationSummary => ({ ...input });

const sameInspectionIdentity = (
  initial: SourceEvidenceCandidateV1,
  updated: SourceEvidenceCandidateV1,
): boolean => initial.providerKey === updated.providerKey
  && initial.sourceId === updated.sourceId
  && initial.providerClass === updated.providerClass
  && initial.sourceKind === updated.sourceKind
  && initial.providerResponseIndex === updated.providerResponseIndex
  && initial.capabilities.includes("downloadToLibrary") === updated.capabilities.includes("downloadToLibrary");

const selected = (
  entry: RankedCandidate,
  observationsValue: RulesObservationSummary,
): RulesVerificationOutcome => ({
  status: "selected",
  selection: {
    candidate: entry.candidate,
    audioTier: entry.audioTier,
    subtitleTier: entry.subtitleTier,
    ...(entry.heightPixels === undefined ? {} : { heightPixels: entry.heightPixels }),
  },
  searchStatus: "complete",
  retryable: false,
  observations: observationsValue,
});

const cursorFor = (input: {
  scopeFingerprint: string;
  listingFingerprint: string;
  nextIndex: number;
  rejectedIndices: ReadonlySet<number>;
  verified: readonly RankedCandidate[];
}): RulesContinuationCursorV1 => ({
  schemaVersion: 1,
  scopeFingerprint: input.scopeFingerprint,
  listingFingerprint: input.listingFingerprint,
  nextIndex: input.nextIndex,
  rejectedIndices: [...input.rejectedIndices].sort((left, right) => left - right),
  verified: input.verified.slice(0, RULES_MAX_CURSOR_ENTRIES).map((entry) => ({
    continuationKey: continuationKey(entry.candidate),
    audioTier: entry.audioTier,
    subtitleTier: entry.subtitleTier,
    ...(entry.heightPixels === undefined ? {} : { heightPixels: entry.heightPixels }),
  })),
});

const torrentIsSelectable = (
  entry: { candidate: SourceEvidenceCandidateV1; evaluation: ReturnType<typeof evaluateSourceCandidate> },
  snapshot: SourceAdmissionSnapshotV1,
): boolean => {
  if (entry.evaluation.status === "excluded") return false;
  if (snapshot.policy.constraints.audio.mode === "strict"
    && listingAudioTier(entry.candidate, snapshot) !== "preferred") return false;
  if (entry.evaluation.status === "eligible") return true;
  const reasons = entry.evaluation.reasons;
  return reasons.every((reason) =>
    (reason.code === "inspectionRequired" && reason.field === "heightPixels")
    || (snapshot.policy.constraints.audio.mode === "strict"
      && reason.code === "inspectionRequired" && reason.field === "audio"));
};

export async function verifyRulesCandidates(
  input: VerifyRulesCandidatesInput,
): Promise<RulesVerificationOutcome> {
  if (input === null || typeof input !== "object"
    || input.snapshot === null || typeof input.snapshot !== "object"
    || !Array.isArray(input.candidates) || input.candidates.length > MAX_CANDIDATES
    || typeof input.inspect !== "function" || typeof input.shouldContinue !== "function"
    || typeof input.hasRealDebrid !== "boolean"
    || (input.finalTemporaryAttempt !== undefined && typeof input.finalTemporaryAttempt !== "boolean")) {
    return invalid();
  }
  let snapshot: SourceAdmissionSnapshotV1;
  try {
    snapshot = parseSourceAdmissionSnapshotV1(input.snapshot);
  } catch {
    return invalid();
  }
  if (snapshot.profile.template !== "rules" || snapshot.operation !== "downloadToLibrary") return invalid();
  const priorCursor = parseRulesContinuationCursorV1(input.cursor);
  for (const candidate of input.candidates) continuationIdentity(candidate);

  const http: Array<{
    candidate: SourceEvidenceCandidateV1;
    evaluation: ReturnType<typeof evaluateSourceCandidate>;
  }> = [];
  const torrents: typeof http = [];
  for (const candidate of input.candidates) {
    const evaluation = evaluateSourceCandidate(snapshot, candidate);
    if (evaluation.status === "excluded") continue;
    if (candidate.sourceKind === "http") http.push({ candidate, evaluation });
    else if (candidate.sourceKind === "torrent") torrents.push({ candidate, evaluation });
  }

  const scopeFingerprint = fingerprint(input.scopeStamp);
  const listingFingerprint = fingerprint(listing(snapshot, input.candidates));
  const sameAttempt = priorCursor !== undefined
    && priorCursor.scopeFingerprint === scopeFingerprint
    && priorCursor.listingFingerprint === listingFingerprint;
  const candidatesByKey = new Map<string, SourceEvidenceCandidateV1>();
  for (const candidate of input.candidates) {
    const key = continuationKey(candidate);
    if (candidatesByKey.has(key)) invalid();
    candidatesByKey.set(key, candidate);
  }

  const verified = new Map<string, RankedCandidate>();
  for (const entry of http) {
    if (entry.evaluation.status !== "eligible") continue;
    const key = continuationKey(entry.candidate);
    verified.set(key, actualRanking(
      entry.candidate,
      undefined,
      entry.evaluation.audioTier,
      entry.evaluation.subtitleTier,
      http.indexOf(entry),
    ));
  }
  if (sameAttempt) {
    for (const saved of priorCursor.verified) {
      const candidate = candidatesByKey.get(saved.continuationKey);
      if (candidate === undefined) return invalid();
      if (!verified.has(saved.continuationKey)) {
        verified.set(saved.continuationKey, actualRanking(
          candidate,
          saved,
          saved.audioTier,
          saved.subtitleTier,
          http.findIndex((entry) => entry.candidate === candidate),
        ));
      }
    }
  }

  const sorted = http.map((entry) => ({
    ...entry,
    ranking: listingRanking(entry.candidate, snapshot, http.indexOf(entry)),
  })).sort((left, right) => comparePreference(snapshot, left.ranking, right.ranking)
    || left.ranking.responseOrder - right.ranking.responseOrder);
  const sameCursor = sameAttempt ? priorCursor : undefined;
  const persistedRejections = sameCursor?.rejectedIndices ?? [];
  if (persistedRejections.some((index) => index >= sorted.length)) invalid();
  const rejected = new Set<number>(sameCursor
    ? persistedRejections.filter((index) => persistsRejection(sorted[index]!.candidate))
    : []);
  if (sameCursor && sorted.length > 0 && sameCursor.nextIndex >= sorted.length) invalid();

  let nextIndex = sameCursor !== undefined && sorted.length > 0 ? sameCursor.nextIndex : 0;
  const inspectedThisAttempt = new Set<number>();
  const temporarilyFailed = new Set<number>();
  const unresolved = new Set<number>();
  let probesUsed = 0;
  let confirmedRejections = 0;
  let temporaryFailures = 0;
  let accessDenials = 0;

  const rankedVerified = (): RankedCandidate[] =>
    [...verified.values()].sort((left, right) => comparePreference(snapshot, left, right));
  const isAvailable = (index: number): boolean => {
    const candidate = sorted[index]!.candidate;
    return !rejected.has(index)
      && !inspectedThisAttempt.has(index)
      && !verified.has(continuationKey(candidate));
  };
  const canBeat = (index: number, incumbent: RankedCandidate | undefined): boolean => {
    if (!isAvailable(index)) return false;
    if (!incumbent) return true;
    const optimistic = optimisticRanking(sorted[index]!.candidate, snapshot, index);
    return comparePreference(snapshot, optimistic, incumbent) < 0;
  };
  const canStillBeat = (index: number, incumbent: RankedCandidate | undefined): boolean => {
    if (!isAvailable(index) && !temporarilyFailed.has(index)) return false;
    if (!incumbent) return true;
    const optimistic = optimisticRanking(sorted[index]!.candidate, snapshot, index);
    return comparePreference(snapshot, optimistic, incumbent) < 0;
  };
  const nextProbe = (incumbent: RankedCandidate | undefined): number | undefined => {
    if (sorted.length === 0) return undefined;
    let best: { index: number; claimRank: number } | undefined;
    for (let visited = 0; visited < sorted.length; visited++) {
      const index = (nextIndex + visited) % sorted.length;
      if (!canBeat(index, incumbent)) continue;
      const audioMode = snapshot.policy.constraints.audio.mode;
      const claimRank = audioMode === "strict" || audioMode === "preferred"
        ? tierRank[listingAudioTier(sorted[index]!.candidate, snapshot)]
        : 0;
      if (!best || claimRank < best.claimRank) best = { index, claimRank };
    }
    return best?.index;
  };

  while (probesUsed < RULES_INSPECTION_BUDGET) {
    const incumbent = rankedVerified()[0];
    const index = nextProbe(incumbent);
    if (index === undefined) break;
    if (!input.shouldContinue()) {
      return {
        status: "cancelled",
        retryable: false,
        observations: observations({
          probesUsed,
          confirmedRejections,
          temporaryFailures,
          accessDenials,
          unresolvedCandidates: unresolved.size,
        }),
      };
    }

    const original = sorted[index]!.candidate;
    inspectedThisAttempt.add(index);
    nextIndex = (index + 1) % sorted.length;
    probesUsed++;
    let result: RulesInspectionResult;
    try {
      result = await input.inspect(original);
    } catch {
      result = { status: "temporaryFailure" };
    }
    if (!input.shouldContinue()) {
      return {
        status: "cancelled",
        retryable: false,
        observations: observations({
          probesUsed,
          confirmedRejections,
          temporaryFailures,
          accessDenials,
          unresolvedCandidates: unresolved.size,
        }),
      };
    }
    if (result?.status === "temporaryFailure") {
      temporaryFailures++;
      temporarilyFailed.add(index);
      unresolved.add(index);
      continue;
    }
    if (result?.status === "accessDenied") {
      accessDenials++;
      unresolved.add(index);
      continue;
    }
    if (result?.status !== "ok" || result.candidate === null || typeof result.candidate !== "object"
      || !sameInspectionIdentity(original, result.candidate)) {
      return invalid();
    }
    const evaluation = evaluateSourceCandidate(snapshot, result.candidate);
    if (evaluation.status === "eligible") {
      const height = result.candidate.facts.heightPixels;
      verified.set(continuationKey(result.candidate), {
        candidate: result.candidate,
        audioTier: evaluation.audioTier,
        subtitleTier: evaluation.subtitleTier,
        ...(height.evidence !== "unknown" && Number.isFinite(height.value) ? { heightPixels: height.value } : {}),
        responseOrder: index,
      });
    } else if (evaluation.status === "excluded") {
      confirmedRejections++;
      if (persistsRejection(result.candidate) && rejected.size < RULES_MAX_CURSOR_ENTRIES) {
        rejected.add(index);
      }
    } else {
      unresolved.add(index);
      temporaryFailures++;
      temporarilyFailed.add(index);
    }
  }

  const incumbent = rankedVerified()[0];
  const remainingPotential = sorted.some((_entry, index) => canStillBeat(index, incumbent));
  const observationsValue = observations({
    probesUsed,
    confirmedRejections,
    temporaryFailures,
    accessDenials,
    unresolvedCandidates: unresolved.size,
  });
  if (incumbent && !remainingPotential) return selected(incumbent, observationsValue);

  const cursorForOutcome = (): RulesContinuationCursorV1 => cursorFor({
    scopeFingerprint,
    listingFingerprint,
    nextIndex: sorted.length === 0 ? 0 : nextIndex,
    rejectedIndices: rejected,
    verified: rankedVerified(),
  });
  if (probesUsed === RULES_INSPECTION_BUDGET && remainingPotential) {
    return {
      status: "budgetExhausted",
      retryable: true,
      observations: observationsValue,
      cursor: cursorForOutcome(),
    };
  }
  if (unresolved.size > 0) {
    if (temporaryFailures > 0) {
      if (incumbent && input.finalTemporaryAttempt === true) {
        return selected(incumbent, observationsValue);
      }
      return {
        status: "temporaryFailure",
        retryable: true,
        observations: observationsValue,
        cursor: cursorForOutcome(),
      };
    }
    return { status: "accessDenied", retryable: false, observations: observationsValue };
  }
  if (remainingPotential) {
    return {
      status: "budgetExhausted",
      retryable: true,
      observations: observationsValue,
      cursor: cursorForOutcome(),
    };
  }

  if (input.hasRealDebrid) {
    const selectableTorrents = torrents.filter((entry) => torrentIsSelectable(entry, snapshot));
    const ranked = selectableTorrents.map((entry, responseOrder) => {
      const audioTier = snapshot.policy.constraints.audio.mode === "strict"
        ? "preferred" as const
        : entry.evaluation.status === "eligible" ? entry.evaluation.audioTier : listingAudioTier(entry.candidate, snapshot);
      const subtitleTier = entry.evaluation.status === "eligible" ? entry.evaluation.subtitleTier : "unknown";
      const heightPixels = knownHeight(entry.candidate);
      return {
        candidate: entry.candidate,
        audioTier,
        subtitleTier,
        ...(heightPixels === undefined ? {} : { heightPixels }),
        responseOrder,
      } satisfies RankedCandidate;
    }).sort((left, right) => comparePreference(snapshot, left, right));
    if (ranked[0]) return selected(ranked[0], observationsValue);
  }

  return { status: "noMatch", retryable: false, observations: observationsValue };
}
