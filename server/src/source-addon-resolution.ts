import type { DownloadResolution } from "./downloads.js";
import { normalizeLanguage } from "./language.js";
import type { MediaInfo, Track } from "./probe.js";
import type { SourceAdmissionSnapshotV1 } from "./source-admission.js";
import type { SourceEvidenceCandidateV1 } from "./source-evidence.js";
import type { StreamItem, SubtitleItem } from "./types.js";

export interface ResolveAddonSourceSelectionInput {
  readonly snapshot: SourceAdmissionSnapshotV1;
  readonly candidate: SourceEvidenceCandidateV1;
  readonly stream: StreamItem;
  readonly info?: MediaInfo;
  readonly externalSubtitles: readonly SubtitleItem[];
  readonly checkedCandidates: number;
}

export interface AddonSourceSelection {
  readonly subtitle?: SubtitleItem;
  readonly resolution: DownloadResolution;
}

interface SubtitleResolution {
  readonly subtitle?: SubtitleItem;
  readonly subtitleLanguage?: string;
  readonly subtitleTrack?: number;
  readonly subtitleSource?: "embedded" | "addon";
  readonly subtitleStatus?: "ready" | "missing";
}

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

const inspectedAudioResolution = (
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

const listedAudioResolution = (
  candidate: SourceEvidenceCandidateV1,
  snapshot: SourceAdmissionSnapshotV1,
  checkedCandidates: number,
): DownloadResolution | undefined => {
  const audio = snapshot.policy.constraints.audio;
  if (audio.mode === "strict") return undefined;

  const preferred = "code" in audio.preferred ? audio.preferred.code : undefined;
  const fallback = audio.fallback && "code" in audio.fallback ? audio.fallback.code : undefined;
  const listed = candidate.facts.audio.listed.evidence === "unknown"
    ? []
    : candidate.facts.audio.listed.value;
  const selectedLanguage = listedPolicyLanguage(listed, preferred, fallback)
    ?? (audio.mode === "preferred" ? listed[0] : undefined);
  if (audio.mode === "listed" && selectedLanguage === undefined) return undefined;

  return {
    checkedCandidates,
    ...(selectedLanguage === undefined ? {} : { audioLanguage: selectedLanguage }),
    fallbackUsed: selectedLanguage === undefined || selectedLanguage !== preferred,
    audioEvidence: selectedLanguage === undefined ? "none" : "listing",
  };
};

const subtitleResolution = (
  info: MediaInfo | undefined,
  stream: StreamItem,
  externalSubtitles: readonly SubtitleItem[],
  snapshot: SourceAdmissionSnapshotV1,
): SubtitleResolution => {
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
    const embedded = info === undefined
      ? undefined
      : (Array.isArray(info.subtitleTracks) ? info.subtitleTracks : [])
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

export function resolveAddonSourceSelection(
  input: ResolveAddonSourceSelectionInput,
): AddonSourceSelection | undefined {
  const audio = input.info === undefined
    ? listedAudioResolution(input.candidate, input.snapshot, input.checkedCandidates)
    : inspectedAudioResolution(input.info, input.candidate, input.snapshot, input.checkedCandidates);
  if (audio === undefined) return undefined;

  const subtitles = subtitleResolution(
    input.info,
    input.stream,
    input.externalSubtitles,
    input.snapshot,
  );
  if (input.snapshot.policy.constraints.subtitles.mode === "required"
    && subtitles.subtitleStatus !== "ready") {
    return undefined;
  }

  return {
    ...(subtitles.subtitle === undefined ? {} : { subtitle: subtitles.subtitle }),
    resolution: {
      ...audio,
      ...(subtitles.subtitleLanguage === undefined ? {} : { subtitleLanguage: subtitles.subtitleLanguage }),
      ...(subtitles.subtitleTrack === undefined ? {} : { subtitleTrack: subtitles.subtitleTrack }),
      ...(subtitles.subtitleSource === undefined ? {} : { subtitleSource: subtitles.subtitleSource }),
      ...(subtitles.subtitleStatus === undefined ? {} : { subtitleStatus: subtitles.subtitleStatus }),
    },
  };
}
