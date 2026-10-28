import { createHash } from "node:crypto";
import { normalizeLanguage } from "./language.js";
import { remoteDownloadKey, type RemoteDownloadReference } from "./media-server-download.js";
import type { ProviderVersion } from "./media-server-provider.js";
import { listedAudioLanguages, releaseKindFromListing } from "./source-addon-evidence.js";
import type { SourceEvidenceCandidateV1, SourceFact } from "./source-evidence.js";
import { videoResolutionClass } from "./video-resolution.js";

const unknown = <T>(): SourceFact<T> => ({ evidence: "unknown" });

const languages = (values: readonly (string | undefined)[]): Array<string | undefined> =>
  values.map((language) => normalizeLanguage(language));

const uniqueLanguages = (values: readonly (string | undefined)[]): string[] =>
  [...new Set(languages(values).filter((language): language is string => language !== undefined))];

export function remoteAudioLanguages(version: ProviderVersion): { languages: string[]; guessed: boolean } {
  const tagged = uniqueLanguages(version.audioLanguages ?? []);
  if (tagged.length) return { languages: tagged, guessed: false };
  if (!version.audioLanguages?.length) return { languages: [], guessed: false };

  const guess = listedAudioLanguages({ name: version.name }, undefined);
  return guess.evidence === "listed"
    ? { languages: [...guess.value], guessed: true }
    : { languages: [], guessed: false };
}

export function remoteSubtitleLanguages(version: ProviderVersion): string[] {
  return uniqueLanguages([
    ...(version.embeddedSubtitleLanguages ?? []),
    ...(version.externalSubtitles ?? []).map((subtitle) => subtitle.language),
  ]);
}

const continuationKey = (
  providerKey: string,
  reference: RemoteDownloadReference,
): string => createHash("sha256")
  .update(JSON.stringify([
    "remote-source-continuation-v1",
    providerKey,
    remoteDownloadKey(reference),
  ]), "utf8")
  .digest("hex");

export function remoteSourceEvidence(input: {
  providerKey: string;
  reference: RemoteDownloadReference;
  version: ProviderVersion;
  providerResponseIndex: number;
}): SourceEvidenceCandidateV1 {
  const { providerKey, reference, version } = input;
  const heightPixels = videoResolutionClass(version.videoWidth, version.videoHeight);
  const audioTracks = version.audioLanguages === undefined
    ? undefined
    : languages(version.audioLanguages);
  const knownAudioTracks = audioTracks === undefined ? [] : uniqueLanguages(audioTracks);
  const audioLanguages = remoteAudioLanguages(version);
  const embeddedSubtitles = version.embeddedSubtitleLanguages === undefined
    ? undefined
    : languages(version.embeddedSubtitleLanguages);
  const externalSubtitles = version.externalSubtitles === undefined
    ? undefined
    : languages(version.externalSubtitles.map((subtitle) => subtitle.language));

  return {
    sourceId: `remote:${remoteDownloadKey(reference)}`,
    continuationIdentity: {
      key: continuationKey(providerKey, reference),
      reusableRejection: true,
    },
    providerKey,
    providerClass: "remote",
    sourceKind: "mediaServerOriginal",
    capabilities: ["downloadToLibrary"],
    providerResponseIndex: input.providerResponseIndex,
    available: true,
    facts: {
      audio: {
        listed: audioLanguages.languages.length
          ? { evidence: audioLanguages.guessed ? "listed" : "providerMetadata", value: audioLanguages.languages }
          : unknown(),
        tracks: knownAudioTracks.length === 0 || audioTracks === undefined
          ? unknown()
          : { evidence: "providerMetadata", value: audioTracks },
      },
      embeddedSubtitles: embeddedSubtitles === undefined
        ? unknown()
        : { evidence: "providerMetadata", value: embeddedSubtitles },
      externalSubtitles: externalSubtitles === undefined
        ? unknown()
        : { evidence: "providerMetadata", value: externalSubtitles },
      bytes: version.size === undefined
        ? unknown()
        : { evidence: "providerMetadata", value: version.size },
      durationSeconds: version.durationTicks === undefined
        ? unknown()
        : { evidence: "providerMetadata", value: version.durationTicks / 10_000_000 },
      heightPixels: heightPixels === undefined
        ? unknown()
        : { evidence: "providerMetadata", value: heightPixels },
      releaseKind: releaseKindFromListing({ name: version.name }),
      sampleOrTrailer: unknown(),
    },
  };
}
