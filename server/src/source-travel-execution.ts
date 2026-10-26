import type { DownloadResolution } from "./downloads.js";
import { normalizeLanguage } from "./language.js";
import type { MediaInfo, Track } from "./probe.js";
import type { SourceAdmissionSnapshotV1 } from "./source-admission.js";
import {
  inspectedAddonSourceEvidence,
  listedAddonSourceEvidence,
} from "./source-addon-evidence.js";
import type { SourceEvidenceCandidateV1 } from "./source-evidence.js";
import {
  TravelVerificationError,
  verifyTravelCandidates,
  type TravelContinuationCursorV1,
  type TravelObservationSummary,
  type TravelVerificationOutcome,
} from "./source-travel.js";
import type { StreamItem, SubtitleItem } from "./types.js";

export interface VerifyTravelAddonStreamsInput {
  readonly snapshot: SourceAdmissionSnapshotV1;
  readonly streams: readonly StreamItem[];
  readonly externalSubtitles: readonly SubtitleItem[];
  readonly titleLanguage?: string;
  readonly inspect: (stream: StreamItem) => Promise<MediaInfo | undefined>;
  readonly shouldContinue: () => boolean;
  readonly scopeStamp: unknown;
  readonly cursor?: TravelContinuationCursorV1;
  readonly tried?: readonly string[];
}

type TravelUnselectedOutcome = Exclude<TravelVerificationOutcome, { status: "selected" }>;

export type TravelAddonStreamOutcome =
  | {
    readonly status: "selected";
    readonly stream: StreamItem;
    readonly subtitle?: SubtitleItem;
    readonly resolution: DownloadResolution;
    readonly searchStatus: "complete" | "incompleteSearch";
    readonly retryable: boolean;
    readonly cursor?: TravelContinuationCursorV1;
    readonly observations: TravelObservationSummary;
  }
  | TravelUnselectedOutcome;

interface PreparedStream {
  readonly candidate: SourceEvidenceCandidateV1;
  readonly stream: StreamItem;
}

interface ProbedStream extends PreparedStream {
  readonly info: MediaInfo;
}

const evidenceKey = (candidate: SourceEvidenceCandidateV1): string => JSON.stringify([
  candidate.providerKey,
  candidate.providerResponseIndex,
  candidate.sourceId,
]);

const httpUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const languageCode = (value: unknown): string | undefined =>
  typeof value === "string" ? normalizeLanguage(value) : undefined;

const usableTracks = (tracks: readonly Track[]): Track[] =>
  tracks.filter((track) => track !== null && typeof track === "object"
    && Number.isSafeInteger(track.index) && track.index >= 0);

const listedPolicyLanguage = (
  languages: readonly string[],
  preferred: string | undefined,
  fallback: string | undefined,
): string | undefined => {
  if (preferred !== undefined && languages.includes(preferred)) return preferred;
  if (fallback !== undefined && languages.includes(fallback)) return fallback;
  return undefined;
};

const audioResolution = (
  info: MediaInfo,
  candidate: SourceEvidenceCandidateV1,
  snapshot: SourceAdmissionSnapshotV1,
  checkedCandidates: number,
): DownloadResolution => {
  const audio = snapshot.policy.constraints.audio;
  const preferred = "code" in audio.preferred ? audio.preferred.code : undefined;
  const fallback = audio.fallback && "code" in audio.fallback ? audio.fallback.code : undefined;
  const tracks = usableTracks(info.audioTracks);
  const selected = tracks.find((track) => preferred !== undefined && languageCode(track.language) === preferred)
    ?? tracks.find((track) => fallback !== undefined && languageCode(track.language) === fallback)
    ?? tracks[0];
  const probedLanguage = languageCode(selected?.language);
  const listedLanguages = candidate.facts.audio.listed.evidence === "unknown"
    ? []
    : candidate.facts.audio.listed.value;
  const listingLanguage = probedLanguage === undefined
    ? listedPolicyLanguage(listedLanguages, preferred, fallback)
    : undefined;
  const selectedLanguage = probedLanguage ?? listingLanguage;
  const selectedTier = selectedLanguage !== undefined && selectedLanguage === preferred
    ? "preferred"
    : selectedLanguage !== undefined && selectedLanguage === fallback
      ? "fallback"
      : "other";

  return {
    checkedCandidates,
    ...(selectedLanguage === undefined ? {} : { audioLanguage: selectedLanguage }),
    ...(selected === undefined ? {} : { audioTrack: selected.index }),
    fallbackUsed: selectedTier !== "preferred",
    audioEvidence: probedLanguage !== undefined ? "probe" : listingLanguage !== undefined ? "listing" : "none",
  };
};

const subtitleResolution = (
  info: MediaInfo,
  stream: StreamItem,
  externalSubtitles: readonly SubtitleItem[],
  snapshot: SourceAdmissionSnapshotV1,
): {
  readonly subtitle?: SubtitleItem;
  readonly subtitleLanguage?: string;
  readonly subtitleTrack?: number;
  readonly subtitleSource?: "embedded" | "addon";
  readonly subtitleStatus?: "ready" | "missing";
} => {
  const policy = snapshot.policy.constraints.subtitles;
  if (policy.mode === "off") return {};

  const preferred = policy.preferred && "code" in policy.preferred ? policy.preferred.code : undefined;
  const fallback = policy.fallback && "code" in policy.fallback ? policy.fallback.code : undefined;
  const external = [
    ...(Array.isArray(stream.subtitles) ? stream.subtitles : []),
    ...externalSubtitles,
  ].filter((subtitle): subtitle is SubtitleItem =>
    subtitle !== null && typeof subtitle === "object" && typeof subtitle.url === "string");

  for (const wanted of [preferred, fallback]) {
    if (wanted === undefined) continue;
    const embedded = (Array.isArray(info.subtitleTracks) ? info.subtitleTracks : [])
      .find((track) => track !== null && typeof track === "object"
        && Number.isSafeInteger(track.index) && track.index >= 0
        && languageCode(track.language) === wanted);
    if (embedded) {
      return {
        subtitleLanguage: wanted,
        subtitleTrack: embedded.index,
        subtitleSource: "embedded",
        subtitleStatus: "ready",
      };
    }

    const addon = external.find((subtitle) => languageCode(subtitle.lang) === wanted);
    if (addon) {
      return {
        subtitle: addon,
        subtitleLanguage: wanted,
        subtitleSource: "addon",
        subtitleStatus: "ready",
      };
    }
  }

  if (policy.mode === "required") return {};
  return { subtitleStatus: "missing" };
};

export async function verifyTravelAddonStreams(
  input: VerifyTravelAddonStreamsInput,
): Promise<TravelAddonStreamOutcome> {
  const authorized = new Set(input.snapshot.providerKeys);
  const tried = new Set(input.tried ?? []);
  const positions = new Map<string, number>();
  const prepared: PreparedStream[] = [];

  for (const stream of input.streams) {
    if (stream === null || typeof stream !== "object") continue;
    const addonKey = stream.addonKey;
    if (typeof addonKey !== "string" || addonKey.length === 0) continue;
    const providerResponseIndex = positions.get(addonKey) ?? 0;
    positions.set(addonKey, providerResponseIndex + 1);

    const providerKey = `addon:${addonKey}`;
    const url = stream.url;
    if (!authorized.has(providerKey) || !httpUrl(url) || tried.has(url)) continue;
    const candidate = listedAddonSourceEvidence({
      providerKey,
      stream,
      providerResponseIndex,
      available: true,
      ...(input.titleLanguage === undefined ? {} : { titleLanguage: input.titleLanguage }),
      externalSubtitles: input.externalSubtitles,
    });
    if (candidate) prepared.push({ candidate, stream });
  }

  const byEvidence = new Map<string, PreparedStream>();
  for (const entry of prepared) {
    const key = evidenceKey(entry.candidate);
    if (byEvidence.has(key)) throw new TravelVerificationError();
    byEvidence.set(key, entry);
  }
  const probed = new Map<string, ProbedStream>();

  const outcome = await verifyTravelCandidates({
    snapshot: input.snapshot,
    candidates: prepared.map((entry) => entry.candidate),
    inspect: async (candidate) => {
      const entry = byEvidence.get(evidenceKey(candidate));
      if (!entry) throw new TravelVerificationError();

      let info: MediaInfo | undefined;
      try {
        info = await input.inspect(entry.stream);
      } catch {
        return { status: "temporaryFailure" };
      }
      if (info === undefined) return { status: "temporaryFailure" };

      try {
        const inspected = inspectedAddonSourceEvidence(entry.candidate, info);
        probed.set(evidenceKey(candidate), { ...entry, info });
        return { status: "ok", candidate: inspected };
      } catch {
        return { status: "temporaryFailure" };
      }
    },
    shouldContinue: input.shouldContinue,
    scopeStamp: input.scopeStamp,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  });

  if (outcome.status !== "selected") return outcome;

  const key = evidenceKey(outcome.selection.candidate);
  const selected = probed.get(key);
  if (!selected || selected.candidate.sourceId !== outcome.selection.candidate.sourceId
    || selected.candidate.providerKey !== outcome.selection.candidate.providerKey
    || selected.candidate.providerResponseIndex !== outcome.selection.candidate.providerResponseIndex) {
    throw new TravelVerificationError();
  }

  const subtitles = subtitleResolution(selected.info, selected.stream, input.externalSubtitles, input.snapshot);
  if (input.snapshot.policy.constraints.subtitles.mode === "required" && subtitles.subtitleStatus !== "ready") {
    throw new TravelVerificationError();
  }

  return {
    status: "selected",
    stream: selected.stream,
    ...(subtitles.subtitle === undefined ? {} : { subtitle: subtitles.subtitle }),
    resolution: {
      ...audioResolution(
        selected.info,
        selected.candidate,
        input.snapshot,
        outcome.observations.probesUsed,
      ),
      ...(subtitles.subtitleLanguage === undefined ? {} : { subtitleLanguage: subtitles.subtitleLanguage }),
      ...(subtitles.subtitleTrack === undefined ? {} : { subtitleTrack: subtitles.subtitleTrack }),
      ...(subtitles.subtitleSource === undefined ? {} : { subtitleSource: subtitles.subtitleSource }),
      ...(subtitles.subtitleStatus === undefined ? {} : { subtitleStatus: subtitles.subtitleStatus }),
    },
    searchStatus: outcome.searchStatus,
    retryable: outcome.retryable,
    ...(outcome.cursor === undefined ? {} : { cursor: outcome.cursor }),
    observations: outcome.observations,
  };
}
