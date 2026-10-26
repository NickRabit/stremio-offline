import { createHash } from "node:crypto";
import {
  evaluateSourceCandidate,
  rankEligibleSources,
  type EligibleSourceCandidate,
  type SourceEvidenceCandidateV1,
} from "./source-evidence.js";
import type { SourceAdmissionSnapshotV1 } from "./source-admission.js";
import { SOURCE_PROFILE_IDS } from "./source-profiles.js";

export const TRAVEL_INSPECTION_BUDGET = 15;
export const TRAVEL_MAX_REJECTED_INDICES = 256;

const MAX_CANDIDATES = 10_000;
const FINGERPRINT = /^[a-f0-9]{64}$/;

export interface TravelContinuationCursorV1 {
  readonly schemaVersion: 1;
  readonly scopeFingerprint: string;
  readonly listingFingerprint: string;
  readonly nextIndex: number;
  readonly rejectedIndices: readonly number[];
}

export type TravelInspectionResult =
  | { readonly status: "ok"; readonly candidate: SourceEvidenceCandidateV1 }
  | { readonly status: "temporaryFailure" }
  | { readonly status: "accessDenied" };

export interface VerifyTravelCandidatesInput {
  readonly snapshot: SourceAdmissionSnapshotV1;
  readonly candidates: readonly SourceEvidenceCandidateV1[];
  readonly inspect: (candidate: SourceEvidenceCandidateV1) => Promise<TravelInspectionResult>;
  readonly shouldContinue: () => boolean;
  readonly scopeStamp: unknown;
  readonly cursor?: TravelContinuationCursorV1;
}

export interface TravelObservationSummary {
  readonly probesUsed: number;
  readonly confirmedRejections: number;
  readonly temporaryFailures: number;
  readonly accessDenials: number;
  readonly unresolvedCandidates: number;
}

export type TravelVerificationOutcome =
  | {
    readonly status: "selected";
    readonly selection: EligibleSourceCandidate;
    readonly searchStatus: "complete" | "incompleteSearch";
    readonly retryable: boolean;
    readonly observations: TravelObservationSummary;
    readonly cursor?: TravelContinuationCursorV1;
  }
  | {
    readonly status: "budgetExhausted";
    readonly retryable: true;
    readonly observations: TravelObservationSummary;
    readonly cursor: TravelContinuationCursorV1;
  }
  | {
    readonly status: "noMatch";
    readonly retryable: false;
    readonly observations: TravelObservationSummary;
  }
  | {
    readonly status: "temporaryFailure";
    readonly retryable: true;
    readonly observations: TravelObservationSummary;
    readonly cursor: TravelContinuationCursorV1;
  }
  | {
    readonly status: "accessDenied";
    readonly retryable: false;
    readonly observations: TravelObservationSummary;
  }
  | {
    readonly status: "cancelled";
    readonly retryable: false;
    readonly observations: TravelObservationSummary;
  };

export class TravelVerificationError extends Error {
  constructor() {
    super("Invalid Travel verification input.");
    this.name = "TravelVerificationError";
  }
}

interface SortedCandidate {
  readonly candidate: SourceEvidenceCandidateV1;
  readonly responseOrder: number;
}

const invalid = (): never => {
  throw new TravelVerificationError();
};

const canonicalJson = (value: unknown): string => {
  const ancestors = new Set<object>();

  const encode = (current: unknown): string => {
    if (current === null) return "null";
    if (typeof current === "string" || typeof current === "boolean") return JSON.stringify(current);
    if (typeof current === "number") {
      return Number.isFinite(current) ? JSON.stringify(current) : invalid();
    }
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
    || Object.getPrototypeOf(identity) !== Object.prototype) {
    return invalid();
  }
  const keys = Object.keys(identity);
  if (keys.length !== 2 || !Object.hasOwn(identity, "key") || !Object.hasOwn(identity, "reusableRejection")
    || typeof identity.key !== "string" || identity.key.length === 0
    || typeof identity.reusableRejection !== "boolean") {
    return invalid();
  }
  return identity;
};

const continuationKey = (candidate: SourceEvidenceCandidateV1): string =>
  continuationIdentity(candidate)?.key ?? candidate.sourceId;

const persistsRejection = (candidate: SourceEvidenceCandidateV1): boolean =>
  continuationIdentity(candidate)?.reusableRejection ?? true;

const candidateListing = (snapshot: SourceAdmissionSnapshotV1, candidates: readonly SourceEvidenceCandidateV1[]) => ({
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

const parseCursor = (input: unknown): TravelContinuationCursorV1 | undefined => {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== "object" || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype) {
    return invalid();
  }

  const expected = [
    "schemaVersion",
    "scopeFingerprint",
    "listingFingerprint",
    "nextIndex",
    "rejectedIndices",
  ];
  const keys = Object.keys(input);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(input, key))) {
    return invalid();
  }

  const cursor = input as Record<string, unknown>;
  if (cursor.schemaVersion !== 1
    || typeof cursor.scopeFingerprint !== "string" || !FINGERPRINT.test(cursor.scopeFingerprint)
    || typeof cursor.listingFingerprint !== "string" || !FINGERPRINT.test(cursor.listingFingerprint)
    || typeof cursor.nextIndex !== "number" || !Number.isSafeInteger(cursor.nextIndex) || cursor.nextIndex < 0
    || !Array.isArray(cursor.rejectedIndices)
    || cursor.rejectedIndices.length > TRAVEL_MAX_REJECTED_INDICES) {
    return invalid();
  }

  let previous = -1;
  for (const index of cursor.rejectedIndices) {
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index <= previous) return invalid();
    previous = index;
  }

  return {
    schemaVersion: 1,
    scopeFingerprint: cursor.scopeFingerprint,
    listingFingerprint: cursor.listingFingerprint,
    nextIndex: cursor.nextIndex,
    rejectedIndices: [...cursor.rejectedIndices] as number[],
  };
};

const estimatedBytes = (candidate: SourceEvidenceCandidateV1): number | undefined => {
  const fact = candidate.facts.bytes;
  if (fact.evidence !== "unknown" && Number.isFinite(fact.value) && fact.value >= 0) return fact.value;
  const hinted = candidate.hints?.bytes;
  return hinted !== undefined && Number.isFinite(hinted) && hinted >= 0 ? hinted : undefined;
};

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sortInspectionCandidates = (
  snapshot: SourceAdmissionSnapshotV1,
  candidates: readonly SourceEvidenceCandidateV1[],
): SortedCandidate[] => {
  const providerOrder = new Map(snapshot.providerKeys.map((key, index) => [key, index]));
  return candidates.map((candidate, responseOrder) => ({ candidate, responseOrder })).sort((left, right) => {
    const leftBytes = estimatedBytes(left.candidate);
    const rightBytes = estimatedBytes(right.candidate);
    if (leftBytes !== rightBytes) {
      if (leftBytes === undefined) return 1;
      if (rightBytes === undefined) return -1;
      return leftBytes - rightBytes;
    }

    const leftProvider = providerOrder.get(left.candidate.providerKey) ?? Number.MAX_SAFE_INTEGER;
    const rightProvider = providerOrder.get(right.candidate.providerKey) ?? Number.MAX_SAFE_INTEGER;
    if (leftProvider !== rightProvider) return leftProvider - rightProvider;

    const identity = compareText(continuationKey(left.candidate), continuationKey(right.candidate));
    if (identity) return identity;
    if (left.candidate.providerResponseIndex !== right.candidate.providerResponseIndex) {
      return left.candidate.providerResponseIndex - right.candidate.providerResponseIndex;
    }
    return left.responseOrder - right.responseOrder;
  });
};

const sameInspectionIdentity = (
  initial: SourceEvidenceCandidateV1,
  updated: SourceEvidenceCandidateV1,
  operation: SourceAdmissionSnapshotV1["operation"],
): boolean => initial.providerKey === updated.providerKey
  && initial.sourceId === updated.sourceId
  && initial.providerClass === updated.providerClass
  && initial.sourceKind === updated.sourceKind
  && initial.providerResponseIndex === updated.providerResponseIndex
  && initial.capabilities.includes(operation) === updated.capabilities.includes(operation);

const observations = (input: {
  probesUsed: number;
  confirmedRejections: number;
  temporaryFailures: number;
  accessDenials: number;
  unresolvedCandidates: number;
}): TravelObservationSummary => ({ ...input });

const cursorFor = (input: {
  scopeFingerprint: string;
  listingFingerprint: string;
  nextIndex: number;
  rejectedIndices: ReadonlySet<number>;
}): TravelContinuationCursorV1 => ({
  schemaVersion: 1,
  scopeFingerprint: input.scopeFingerprint,
  listingFingerprint: input.listingFingerprint,
  nextIndex: input.nextIndex,
  rejectedIndices: [...input.rejectedIndices].sort((left, right) => left - right),
});

export async function verifyTravelCandidates(
  input: VerifyTravelCandidatesInput,
): Promise<TravelVerificationOutcome> {
  if (input === null || typeof input !== "object"
    || input.snapshot === null || typeof input.snapshot !== "object"
    || input.snapshot.profile === null || typeof input.snapshot.profile !== "object"
    || input.snapshot.profile.id !== SOURCE_PROFILE_IDS.travel
    || input.snapshot.profile.revision !== 1
    || input.snapshot.operation !== "downloadToLibrary"
    || !Array.isArray(input.candidates) || input.candidates.length > MAX_CANDIDATES
    || typeof input.inspect !== "function" || typeof input.shouldContinue !== "function") {
    return invalid();
  }

  const priorCursor = parseCursor(input.cursor);
  for (const candidate of input.candidates) continuationIdentity(candidate);
  const scopeFingerprint = fingerprint(input.scopeStamp);
  const listingFingerprint = fingerprint(candidateListing(input.snapshot, input.candidates));
  const inspectable: SourceEvidenceCandidateV1[] = [];
  const eligible: SourceEvidenceCandidateV1[] = [];

  for (const candidate of input.candidates) {
    const evaluation = evaluateSourceCandidate(input.snapshot, candidate);
    if (evaluation.status === "eligible") eligible.push(candidate);
    if (evaluation.status === "needsInspection") inspectable.push(candidate);
  }

  const sorted = sortInspectionCandidates(input.snapshot, inspectable);
  const sameAttempt = priorCursor !== undefined
    && priorCursor.scopeFingerprint === scopeFingerprint
    && priorCursor.listingFingerprint === listingFingerprint;
  const persistedRejections = sameAttempt ? priorCursor.rejectedIndices : [];
  if (persistedRejections.some((index) => index >= sorted.length)) return invalid();
  const rejected = new Set<number>(sameAttempt
    ? persistedRejections.filter((index) => persistsRejection(sorted[index]!.candidate))
    : []);

  if (sameAttempt && (sorted.length === 0 ? priorCursor.nextIndex !== 0 : priorCursor.nextIndex >= sorted.length)) {
    return invalid();
  }
  let nextIndex = sameAttempt && sorted.length > 0 ? priorCursor.nextIndex : 0;

  let probesUsed = 0;
  let confirmedRejections = 0;
  let temporaryFailures = 0;
  let accessDenials = 0;
  const unresolved = new Set<number>();
  const inspectedThisAttempt = new Set<number>();

  const nextInspectableIndex = (): number | undefined => {
    if (sorted.length === 0) return undefined;
    let index = nextIndex;
    for (let visited = 0; visited < sorted.length; visited++) {
      if (!rejected.has(index) && !inspectedThisAttempt.has(index)) return index;
      index = (index + 1) % sorted.length;
    }
    return undefined;
  };

  while (probesUsed < TRAVEL_INSPECTION_BUDGET) {
    const index = nextInspectableIndex();
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

    let result: TravelInspectionResult;
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
      unresolved.add(index);
      continue;
    }
    if (result?.status === "accessDenied") {
      accessDenials++;
      unresolved.add(index);
      continue;
    }
    if (result?.status !== "ok" || result.candidate === null || typeof result.candidate !== "object"
      || !sameInspectionIdentity(original, result.candidate, input.snapshot.operation)) {
      return invalid();
    }

    const evaluation = evaluateSourceCandidate(input.snapshot, result.candidate);
    if (evaluation.status === "eligible") {
      eligible.push(result.candidate);
    } else if (evaluation.status === "excluded") {
      confirmedRejections++;
      if (persistsRejection(result.candidate) && rejected.size < TRAVEL_MAX_REJECTED_INDICES) {
        rejected.add(index);
      }
    } else {
      unresolved.add(index);
    }
  }

  const ranked = rankEligibleSources(input.snapshot, eligible);
  const unexaminedCandidates = sorted.reduce(
    (count, _candidate, index) => count + (!rejected.has(index) && !inspectedThisAttempt.has(index) ? 1 : 0),
    0,
  );
  const hasUnresolved = unresolved.size > 0;
  const observationsValue = observations({
    probesUsed,
    confirmedRejections,
    temporaryFailures,
    accessDenials,
    unresolvedCandidates: unresolved.size,
  });
  const continuation = cursorFor({
    scopeFingerprint,
    listingFingerprint,
    nextIndex,
    rejectedIndices: rejected,
  });

  const selection = ranked[0];
  if (selection) {
    const incomplete = unexaminedCandidates > 0 || hasUnresolved;
    return {
      status: "selected",
      selection,
      searchStatus: incomplete ? "incompleteSearch" : "complete",
      retryable: incomplete,
      observations: observationsValue,
      ...(incomplete ? { cursor: continuation } : {}),
    };
  }

  if (unexaminedCandidates > 0 || (probesUsed === TRAVEL_INSPECTION_BUDGET && hasUnresolved)) {
    return {
      status: "budgetExhausted",
      retryable: true,
      observations: observationsValue,
      cursor: continuation,
    };
  }
  if (accessDenials > 0) {
    return { status: "accessDenied", retryable: false, observations: observationsValue };
  }
  if (temporaryFailures > 0 || hasUnresolved) {
    return {
      status: "temporaryFailure",
      retryable: true,
      observations: observationsValue,
      cursor: continuation,
    };
  }
  return { status: "noMatch", retryable: false, observations: observationsValue };
}
