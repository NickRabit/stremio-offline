import { createHash } from "node:crypto";
import { normalizeLanguage } from "./language.js";
import { remoteDownloadKey, type RemoteDownloadReference } from "./media-server-download.js";
import type { ProviderVersion } from "./media-server-provider.js";
import { releaseKindFromListing } from "./source-addon-evidence.js";
import type { SourceEvidenceCandidateV1, SourceFact } from "./source-evidence.js";
import { videoResolutionClass } from "./video-resolution.js";

const unknown = <T>(): SourceFact<T> => ({ evidence: "unknown" });

const languages = (values: readonly (string | undefined)[]): Array<string | undefined> =>
  values.map((language) => normalizeLanguage(language));

const uniqueLanguages = (values: readonly (string | undefined)[]): string[] =>
  [...new Set(languages(values).filter((language): language is string => language !== undefined))];

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
        listed: audioTracks === undefined
          ? unknown()
          : { evidence: "providerMetadata", value: uniqueLanguages(audioTracks) },
        tracks: audioTracks === undefined
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
