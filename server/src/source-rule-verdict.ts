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
  evaluateSourceCandidate,
  rankingBytes,
  type SourceEvidenceCandidateV1,
  type SourceEvidenceTier,
  type SourceFact,
} from "./source-evidence.js";
import {
  SOURCE_PROFILE_IDS,
  viewerOfProfileAccount,
} from "./source-profiles.js";
import type { Store, UserPrefs } from "./store.js";
import type { UserRecord } from "./users.js";

const UNKNOWN_RANK = Number.MAX_SAFE_INTEGER;

export interface DefaultSourceRuleInput {
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

const providerOrder = (snapshot: SourceAdmissionSnapshotV1): Map<string, number> => {
  return new Map(snapshot.providerKeys.map((key, index) => [key, index]));
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
  evaluation: ReturnType<typeof evaluateSourceCandidate>,
  candidate: SourceEvidenceCandidateV1,
  snapshot: SourceAdmissionSnapshotV1,
): SourceRuleReason | undefined => {
  if (evaluation.status !== "excluded") return undefined;
  const reason = evaluation.reasons[0];
  if (!reason) return undefined;
  switch (reason.code) {
    case "audioLanguageUnavailable":
      return "language";
    case "subtitleLanguageUnavailable":
      return "subtitles";
    case "releaseKindExcluded":
      return "cinema";
    case "sampleOrTrailer":
    case "durationTooShort":
      return "sample";
    case "numericOutsideBounds":
      if (reason.field !== "heightPixels") return undefined;
      return heightReason(candidate, snapshot);
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
): number[] => {
  const tiers = preferredTier(candidate, snapshot);
  const providers = providerOrder(snapshot);
  const rank = [status === "meets" ? 0 : status === "unverified" ? 1 : 2];
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
      case "providerOrder":
        rank.push(providers.get(candidate.providerKey) ?? UNKNOWN_RANK);
        break;
    }
  }
  return rank;
};

export function defaultRuleSnapshot(input: DefaultSourceRuleInput): SourceAdmissionSnapshotV1 | undefined {
  if (!input.user) return undefined;
  const profiles = input.store.sourceProfiles();
  const preferred = input.preferences.defaultRulesProfileId === undefined
    ? undefined
    : profiles.find((profile) =>
        profile.id === input.preferences.defaultRulesProfileId && profile.template === "rules");
  const profile = preferred
    ?? profiles.find((candidate) =>
      candidate.id === SOURCE_PROFILE_IDS.balanced && candidate.template === "rules");
  if (!profile) return undefined;
  try {
    const snapshot = materializeSourceAdmission(
      { profileId: profile.id, revision: profile.revision },
      {
        viewer: viewerOfProfileAccount(input.user),
        profiles,
        addons: input.store.addons(),
        libraries: input.store.libraries(),
        remoteLibraries: input.store.remoteLibraries(),
        mediaConnections: input.store.mediaConnections(),
        addonOrder: input.store.userData(input.user.id).addonOrder,
        preferences: {
          audioLanguage: input.preferences.audioLanguage,
          subtitleLanguage: input.preferences.subtitleLanguage,
        },
        operation: "play",
        mediaKind: input.mediaKind,
      },
    );
    const { bytes: _ignored, ...constraints } = snapshot.policy.constraints;
    return {
      ...snapshot,
      policy: { ...snapshot.policy, constraints },
    };
  } catch {
    return undefined;
  }
}

export function ruleVerdicts(
  snapshot: SourceAdmissionSnapshotV1,
  candidates: readonly SourceEvidenceCandidateV1[],
): Map<string, SourceRuleVerdict> {
  const verdicts = new Map<string, SourceRuleVerdict>();
  for (const original of candidates) {
    const candidate = playbackEvidence(original);
    const evaluation = evaluateSourceCandidate(snapshot, candidate);
    const reason = evaluation.status === "excluded"
      ? reasonFor(evaluation, candidate, snapshot)
      : undefined;
    const status: SourceRuleVerdict["status"] | undefined = evaluation.status === "eligible"
      ? "meets"
      : evaluation.status === "needsInspection"
        ? "unverified"
        : reason === undefined
          ? undefined
          : "breaks";
    if (status === undefined) continue;
    verdicts.set(candidate.sourceId, {
      profileId: snapshot.profile.id,
      status,
      reasons: status === "breaks" && reason ? [reason] : [],
      rank: rankFor(candidate, snapshot, status),
    });
  }
  return verdicts;
}
