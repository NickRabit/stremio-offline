import type { AddonRecord } from "./types.js";
import type { LibraryRecord } from "./libraries.js";
import { normalizeLanguage } from "./language.js";
import type { MediaConnectionRecord, RemoteLibraryRecord } from "./media-server-types.js";
import {
  materializeSourceAdmission,
  type SourceAdmissionSnapshotV1,
} from "./source-admission.js";
import type { SourceRuleReason, SourceRuleVerdict } from "./api-types.js";
import {
  compareFinalTie,
  evaluateSourceCandidate,
  rankingBytes,
  type SourceEvidenceCandidateV1,
  type SourceEvidenceReason,
  type SourceEvidenceTier,
  type SourceFact,
} from "./source-evidence.js";
import {
  parseTemplateParameters,
  viewerOfProfileAccount,
} from "./source-profiles.js";
import type { Store, UserPrefs } from "./store.js";
import type { UserRecord } from "./users.js";

const UNKNOWN_RANK = Number.MAX_SAFE_INTEGER;

export interface SourceRuleInput {
  user: UserRecord | undefined;
  store: Pick<Store,
    "addons" | "libraries" | "mediaConnections" | "remoteLibraries" | "sourceProfiles" | "userData">;
  preferences: UserPrefs;
  mediaKind: "episode" | "movie";
}

const tier = (candidate: SourceEvidenceCandidateV1): {
  audio: SourceEvidenceTier;
  subtitles: SourceEvidenceTier;
} => {
  return {
    audio: languageTier(candidate.facts.audio),
    subtitles: subtitleTier(candidate.facts),
  };
};

const normalized = (values: readonly (string | undefined)[]): string[] =>
  values.flatMap((value) => {
    const language = normalizeLanguage(value);
    return language ? [language] : [];
  });

const languageTier = (audio: SourceEvidenceCandidateV1["facts"]["audio"]): SourceEvidenceTier => {
  const tracks = audio.tracks.evidence === "unknown" ? [] : normalized(audio.tracks.value);
  const listed = audio.listed.evidence === "unknown" ? [] : normalized(audio.listed.value);
  const languages = new Set([...tracks, ...listed]);
  return languages.size ? "knownOther" : "unknown";
};

const subtitleTier = (facts: SourceEvidenceCandidateV1["facts"]): SourceEvidenceTier => {
  const embedded = facts.embeddedSubtitles.evidence === "unknown"
    ? []
    : normalized(facts.embeddedSubtitles.value);
  const external = facts.externalSubtitles.evidence === "unknown"
    ? []
    : normalized(facts.externalSubtitles.value);
  return embedded.length || external.length ? "knownOther" : "unknown";
};

const preferredTier = (
  candidate: SourceEvidenceCandidateV1,
  snapshot: SourceAdmissionSnapshotV1,
): { audio: SourceEvidenceTier; subtitles: SourceEvidenceTier } => {
  const base = tier(candidate);
  const audio = snapshot.policy.constraints.audio;
  const audioPreferred = "code" in audio.preferred ? audio.preferred.code : undefined;
  const audioFallback = audio.fallback && "code" in audio.fallback ? audio.fallback.code : undefined;
  const audioLanguages = new Set([
    ...(candidate.facts.audio.listed.evidence === "unknown" ? [] : normalized(candidate.facts.audio.listed.value)),
    ...(candidate.facts.audio.tracks.evidence === "unknown" ? [] : normalized(candidate.facts.audio.tracks.value)),
  ]);
  base.audio = audioLanguages.has(audioPreferred ?? "")
    ? "preferred"
    : audioFallback && audioLanguages.has(audioFallback)
      ? "fallback"
      : base.audio;

  const subtitles = snapshot.policy.constraints.subtitles;
  if (subtitles.mode !== "off") {
    const subtitlePreferred = "code" in subtitles.preferred! ? subtitles.preferred!.code : undefined;
    const subtitleFallback = subtitles.fallback && "code" in subtitles.fallback
      ? subtitles.fallback.code
      : undefined;
    const subtitleLanguages = new Set([
      ...(candidate.facts.embeddedSubtitles.evidence === "unknown" ? [] : normalized(candidate.facts.embeddedSubtitles.value)),
      ...(candidate.facts.externalSubtitles.evidence === "unknown" ? [] : normalized(candidate.facts.externalSubtitles.value)),
    ]);
    base.subtitles = subtitleLanguages.has(subtitlePreferred ?? "")
      ? "preferred"
      : subtitleFallback && subtitleLanguages.has(subtitleFallback)
        ? "fallback"
        : base.subtitles;
  }
  return base;
};

const knownNumber = (
  fact: SourceFact<number>,
  hint?: number,
): number | undefined => {
  if (fact.evidence !== "unknown" && Number.isFinite(fact.value)) return fact.value;
  return hint !== undefined && Number.isFinite(hint) ? hint : undefined;
};

const directionalRank = (
  direction: "asc" | "desc",
  value: number | undefined,
): number => {
  if (value === undefined) return UNKNOWN_RANK;
  const signed = direction === "asc" ? value : -value;
  return Math.max(-UNKNOWN_RANK, Math.min(UNKNOWN_RANK, signed));
};

const playbackEvidence = (candidate: SourceEvidenceCandidateV1): SourceEvidenceCandidateV1 => {
  // A playback listing is the only evidence available for these facts.
  const facts = candidate.facts;
  const numeric = (fact: SourceFact<number>): SourceFact<number> =>
    fact.evidence === "listed" ? { evidence: "providerMetadata", value: fact.value } : fact;
  const listedAudio = facts.audio.listed;
  return {
    ...candidate,
    capabilities: candidate.capabilities.includes("play")
      ? [...candidate.capabilities]
      : [...candidate.capabilities, "play"],
    facts: {
      ...facts,
      audio: {
        listed: listedAudio,
        tracks: facts.audio.tracks.evidence === "unknown"
          && listedAudio.evidence === "listed"
          ? { evidence: "providerMetadata", value: [...listedAudio.value] }
          : facts.audio.tracks,
      },
      bytes: numeric(facts.bytes),
      durationSeconds: numeric(facts.durationSeconds),
      heightPixels: numeric(facts.heightPixels),
    },
  };
};

const reasonFor = (
  reason: SourceEvidenceReason,
  candidate: SourceEvidenceCandidateV1,
  snapshot: SourceAdmissionSnapshotV1,
): SourceRuleReason | undefined => {
  switch (reason.code) {
    case "providerOutOfScope":
      return "provider";
    case "sourceKindNotAllowed":
      return "torrent";
    case "audioLanguageUnavailable":
      return "language";
    case "subtitleLanguageUnavailable":
      return "subtitles";
    case "releaseKindExcluded":
      return "cinema";
    case "videoCodecExcluded":
      return "codec";
    case "videoRangeExcluded":
      return "hdr";
    case "sampleOrTrailer":
    case "durationTooShort":
      return "sample";
    case "numericOutsideBounds":
      if (reason.field === "bytes") return "size";
      return reason.field === "heightPixels" ? heightReason(candidate, snapshot) : undefined;
    case "operationUnsupported":
    case "sourceUnavailable":
    case "notOwnedLocalCopy":
    case "inspectionRequired":
    default:
      return undefined;
  }
};

const heightReason = (
  candidate: SourceEvidenceCandidateV1,
  snapshot: SourceAdmissionSnapshotV1,
): SourceRuleReason => {
  const height = knownNumber(candidate.facts.heightPixels, candidate.hints?.heightPixels);
  const bounds = snapshot.policy.constraints.heightPixels;
  if (bounds?.max !== undefined && height !== undefined && height > bounds.max) return "resolutionHigh";
  return "resolutionLow";
};

const rankFor = (
  candidate: SourceEvidenceCandidateV1,
  snapshot: SourceAdmissionSnapshotV1,
  status: SourceRuleVerdict["status"],
  tie: number,
): number[] => {
  const tiers = preferredTier(candidate, snapshot);
  const viewerOrder = snapshot.policy.criteria.some((criterion) =>
    criterion.kind === "providerOrder" && "from" in criterion);
  const localFirst = viewerOrder && candidate.providerKey !== "local" ? 1 : 0;
  const rank = [
    localFirst,
    status === "meets" ? 0 : status === "unverified" ? 1 : 2,
  ];
  for (const criterion of snapshot.policy.criteria) {
    switch (criterion.kind) {
      case "providerClass": {
        const order = new Map(criterion.order.map((value, index) => [value, index]));
        rank.push(order.get(candidate.providerClass) ?? UNKNOWN_RANK);
        break;
      }
      case "audioTier":
        rank.push({ preferred: 0, fallback: 1, knownOther: 2, unknown: 3 }[tiers.audio]);
        break;
      case "subtitleTier":
        rank.push({ preferred: 0, fallback: 1, knownOther: 2, unknown: 3 }[tiers.subtitles]);
        break;
      case "resolution":
        rank.push(directionalRank(
          criterion.direction,
          knownNumber(candidate.facts.heightPixels, candidate.hints?.heightPixels),
        ));
        break;
      case "size": {
        const bytes = rankingBytes(candidate);
        rank.push(directionalRank(
          criterion.direction,
          bytes.evidence === "unknown" ? undefined : bytes.value,
        ));
        break;
      }
      case "providerOrder": {
        const keys = "keys" in criterion ? criterion.keys : snapshot.providerKeys;
        rank.push(new Map(keys.map((key, index) => [key, index])).get(candidate.providerKey) ?? UNKNOWN_RANK);
        break;
      }
    }
  }
  rank.push(tie);
  return rank;
};

const tieOrdinals = (
  snapshot: SourceAdmissionSnapshotV1,
  candidates: readonly SourceEvidenceCandidateV1[],
): Map<string, number> => {
  const ordered = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => {
      const tie = compareFinalTie(
        snapshot,
        {
          candidate: left.candidate,
          evaluation: { status: "eligible", reasons: [], audioTier: "unknown", subtitleTier: "unknown" },
        },
        {
          candidate: right.candidate,
          evaluation: { status: "eligible", reasons: [], audioTier: "unknown", subtitleTier: "unknown" },
        },
      );
      return tie || left.index - right.index;
    });
  return new Map(ordered.map((entry, ordinal) => [entry.candidate.sourceId, ordinal]));
};

export function ruleSnapshots(input: SourceRuleInput): SourceAdmissionSnapshotV1[] {
  const user = input.user;
  if (!user) return [];
  const profiles = input.store.sourceProfiles();
  return profiles.flatMap((profile) => {
    if (profile.template !== "rules") return [];
    try {
      const snapshot = materializeSourceAdmission(
        { profileId: profile.id, revision: profile.revision },
        {
          viewer: viewerOfProfileAccount(user),
          profiles,
          addons: input.store.addons(),
          libraries: input.store.libraries(),
          remoteLibraries: input.store.remoteLibraries(),
          mediaConnections: input.store.mediaConnections(),
          addonOrder: input.store.userData(user.id).addonOrder,
          preferences: {
            audioLanguage: input.preferences.audioLanguage,
            subtitleLanguage: input.preferences.subtitleLanguage,
          },
          operation: "play",
          mediaKind: input.mediaKind,
        },
      );
      const viewerOrder = parseTemplateParameters("rules", profile.parameters).addons.order === "viewer";
      return [{
        ...snapshot,
        policy: {
          ...snapshot.policy,
          criteria: snapshot.policy.criteria.map((criterion) =>
            viewerOrder && criterion.kind === "providerOrder"
              ? { kind: "providerOrder", from: "viewer" }
              : criterion),
        },
      }];
    } catch {
      return [];
    }
  });
}

export function ruleVerdicts(
  snapshot: SourceAdmissionSnapshotV1,
  candidates: readonly SourceEvidenceCandidateV1[],
): Map<string, SourceRuleVerdict> {
  const verdicts = new Map<string, SourceRuleVerdict>();
  const ties = tieOrdinals(snapshot, candidates);
  for (const original of candidates) {
    const candidate = playbackEvidence(original);
    const evaluation = evaluateSourceCandidate(snapshot, candidate);
    const reasons = evaluation.status === "excluded"
      ? evaluation.reasons.flatMap((reason) => {
          const mapped = reasonFor(reason, candidate, snapshot);
          return mapped ? [mapped] : [];
        })
      : [];
    const status: SourceRuleVerdict["status"] | undefined = evaluation.status === "eligible"
      ? "meets"
      : evaluation.status === "needsInspection"
        ? "unverified"
        : reasons.length === 0
          ? undefined
          : "breaks";
    if (status === undefined) continue;
    verdicts.set(candidate.sourceId, {
      profileId: snapshot.profile.id,
      status,
      reasons: status === "breaks" ? reasons : [],
      rank: rankFor(candidate, snapshot, status, ties.get(candidate.sourceId) ?? 0),
    });
  }
  return verdicts;
}

export function ruleVerdictsForProfiles(
  snapshots: readonly SourceAdmissionSnapshotV1[],
  candidates: readonly SourceEvidenceCandidateV1[],
): Map<string, Record<string, SourceRuleVerdict>> {
  const bySource = new Map<string, Record<string, SourceRuleVerdict>>();
  for (const snapshot of snapshots) {
    for (const [sourceId, verdict] of ruleVerdicts(snapshot, candidates)) {
      const rules = bySource.get(sourceId) ?? {};
      rules[snapshot.profile.id] = verdict;
      bySource.set(sourceId, rules);
    }
  }
  return bySource;
}
