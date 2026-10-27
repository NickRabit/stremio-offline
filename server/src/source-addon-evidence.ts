import { createHash } from "node:crypto";
import { normalizeLanguage } from "./language.js";
import type { MediaInfo, Track } from "./probe.js";
import { streamLanguages, streamSize } from "./ranking.js";
import type { SourceEvidenceCandidateV1, SourceFact } from "./source-evidence.js";
import type { ReleaseKind } from "./source-policy.js";
import type { StreamItem, SubtitleItem } from "./types.js";

export interface ListedAddonSourceEvidenceInput {
  readonly providerKey: string;
  readonly stream: StreamItem;
  readonly providerResponseIndex: number;
  readonly available: boolean;
  readonly titleLanguage?: string;
  readonly externalSubtitles?: readonly SubtitleItem[];
}

type SourceIdentity =
  | { readonly kind: "http"; readonly url: string }
  | { readonly kind: "torrent"; readonly infoHash: string; readonly fileIdx?: number };

const unknown = <T>(): SourceFact<T> => ({ evidence: "unknown" });

const listedLanguages = (
  values: readonly unknown[],
): SourceFact<readonly string[]> => {
  const languages = [...new Set(values.flatMap((value) => {
    if (typeof value !== "string") return [];
    const language = normalizeLanguage(value);
    return language ? [language] : [];
  }))];
  return languages.length ? { evidence: "listed", value: languages } : unknown();
};

const directHttpUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
};

const sourceIdentity = (stream: StreamItem): SourceIdentity | undefined => {
  if (typeof stream.url === "string" && stream.url.trim() !== "") {
    const url = directHttpUrl(stream.url);
    return url === undefined ? undefined : { kind: "http", url };
  }

  if (typeof stream.infoHash !== "string" || stream.infoHash.trim() === "") return undefined;
  if (stream.fileIdx !== undefined
    && (typeof stream.fileIdx !== "number" || !Number.isSafeInteger(stream.fileIdx) || stream.fileIdx < 0)) {
    return undefined;
  }
  return {
    kind: "torrent",
    infoHash: stream.infoHash,
    ...(stream.fileIdx === undefined ? {} : { fileIdx: stream.fileIdx }),
  };
};

const sourceId = (providerKey: string, identity: SourceIdentity): string =>
  createHash("sha256")
    .update(JSON.stringify([
      providerKey,
      identity.kind,
      identity.kind === "http" ? identity.url : identity.infoHash,
      identity.kind === "torrent" ? identity.fileIdx ?? null : null,
    ]), "utf8")
    .digest("hex");

const subtitleLanguages = (
  stream: StreamItem,
  externalSubtitles: readonly SubtitleItem[],
): SourceFact<readonly string[]> => {
  const languages = (subtitles: unknown): unknown[] => Array.isArray(subtitles)
    ? subtitles.map((subtitle) => subtitle && typeof subtitle === "object"
      ? (subtitle as Record<string, unknown>).lang
      : undefined)
    : [];
  return listedLanguages([
    ...languages(stream.subtitles),
    ...languages(externalSubtitles),
  ]);
};

const addonAudioLanguages = (
  stream: StreamItem,
  titleLanguage: string | undefined,
): SourceFact<readonly string[]> => {
  try {
    return listedLanguages(streamLanguages(stream, titleLanguage));
  } catch {
    return unknown();
  }
};

const addonStreamSize = (stream: StreamItem): number | undefined => {
  try {
    return streamSize(stream);
  } catch {
    return undefined;
  }
};

const continuationKey = (parts: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(["addon-source-continuation-v1", parts]), "utf8")
    .digest("hex");

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const validVideoSize = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const listingReleaseKind = (text: string): ReleaseKind | undefined => {
  // Short tags count only in capitals: "Cam" or "ts" in a title is a word, not a release.
  if (/\b(?:HDCAM|CAMRIP)\b/i.test(text) || /\bCAM\b/.test(text)) return "cam";
  if (/\b(?:HDTS|TELESYNC|TELECINE)\b/i.test(text) || /\b(?:TS|TC)\b/.test(text)) return "telesync";
  if (/\b(?:SCREENER|DVDSCR)\b/i.test(text) || /\bSCR\b/.test(text)) return "screener";
  return undefined;
};

export function releaseKindFromListing(stream: StreamItem): SourceFact<ReleaseKind | null> {
  const kind = listingReleaseKind([
    stream.name,
    stream.title,
    stream.description,
    stream.behaviorHints?.filename,
  ].filter((value): value is string => typeof value === "string").join(" "));
  return kind === undefined
    ? { evidence: "listed", value: null }
    : { evidence: "listed", value: kind };
}

const urlOnlyListingFacts = (input: ListedAddonSourceEvidenceInput): unknown => {
  const stream = input.stream;
  const behaviorHints = stream.behaviorHints;
  return {
    providerResponseIndex: input.providerResponseIndex,
    available: input.available,
    name: optionalString(stream.name),
    title: optionalString(stream.title),
    description: optionalString(stream.description),
    behaviorHints: behaviorHints === undefined ? undefined : {
      notWebReady: typeof behaviorHints.notWebReady === "boolean" ? behaviorHints.notWebReady : undefined,
      videoSize: validVideoSize(behaviorHints.videoSize),
      bingeGroup: optionalString(behaviorHints.bingeGroup),
    },
  };
};

const addonContinuationIdentity = (
  input: ListedAddonSourceEvidenceInput,
  identity: SourceIdentity,
  facts: SourceEvidenceCandidateV1["facts"],
  hints: SourceEvidenceCandidateV1["hints"],
): NonNullable<SourceEvidenceCandidateV1["continuationIdentity"]> => {
  if (identity.kind === "torrent") {
    return {
      key: continuationKey({
        providerKey: input.providerKey,
        kind: "torrent",
        infoHash: identity.infoHash.trim().toLowerCase(),
        fileIdx: identity.fileIdx ?? null,
      }),
      reusableRejection: true,
    };
  }

  const filename = input.stream.behaviorHints?.filename;
  if (typeof filename === "string" && filename.trim() !== "") {
    return {
      key: continuationKey({
        providerKey: input.providerKey,
        kind: "http-filename",
        filename,
        videoSize: validVideoSize(input.stream.behaviorHints?.videoSize) ?? null,
        name: optionalString(input.stream.name) ?? null,
      }),
      reusableRejection: true,
    };
  }

  return {
    key: continuationKey({
      providerKey: input.providerKey,
      kind: "http-position",
      listing: urlOnlyListingFacts(input),
      facts,
      hints,
    }),
    reusableRejection: false,
  };
};

export function listedAddonSourceEvidence(
  input: ListedAddonSourceEvidenceInput,
): SourceEvidenceCandidateV1 | undefined {
  if (typeof input.providerKey !== "string" || input.providerKey.length === 0
    || typeof input.available !== "boolean"
    || !Number.isSafeInteger(input.providerResponseIndex) || input.providerResponseIndex < 0) {
    return undefined;
  }

  const identity = sourceIdentity(input.stream);
  if (!identity) return undefined;

  const titleLanguage = typeof input.titleLanguage === "string"
    ? normalizeLanguage(input.titleLanguage)
    : undefined;
  const audioLanguages = addonAudioLanguages(input.stream, titleLanguage);
  const bytes = addonStreamSize(input.stream);
  const hints = bytes !== undefined && Number.isFinite(bytes) && bytes >= 0
    ? { bytes }
    : undefined;
  const facts: SourceEvidenceCandidateV1["facts"] = {
    audio: {
      listed: audioLanguages,
      tracks: unknown(),
    },
    embeddedSubtitles: unknown(),
    externalSubtitles: subtitleLanguages(input.stream, input.externalSubtitles ?? []),
    bytes: unknown(),
    durationSeconds: unknown(),
    heightPixels: unknown(),
    releaseKind: releaseKindFromListing(input.stream),
    sampleOrTrailer: unknown(),
  };

  return {
    sourceId: sourceId(input.providerKey, identity),
    continuationIdentity: addonContinuationIdentity(input, identity, facts, hints),
    providerKey: input.providerKey,
    providerClass: "addon",
    sourceKind: identity.kind,
    capabilities: ["downloadToLibrary"],
    providerResponseIndex: input.providerResponseIndex,
    available: input.available,
    facts,
    ...(hints === undefined ? {} : { hints }),
  };
}

const inspectedNumber = (value: unknown): SourceFact<number> =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? { evidence: "inspected", value }
    : unknown();

const copiedListedLanguages = (
  fact: SourceFact<readonly string[]>,
): SourceFact<readonly string[]> =>
  fact.evidence === "unknown"
    ? unknown()
    : { evidence: fact.evidence, value: [...fact.value] };

const copiedTrackLanguages = (
  fact: SourceFact<readonly (string | undefined)[]>,
): SourceFact<readonly (string | undefined)[]> =>
  fact.evidence === "unknown"
    ? unknown()
    : { evidence: fact.evidence, value: [...fact.value] };

const inspectedTracks = (tracks: readonly Track[]): readonly (string | undefined)[] =>
  tracks.map((track) => {
    const language = track && typeof track === "object"
      ? (track as unknown as Record<string, unknown>).language
      : undefined;
    return typeof language === "string" ? normalizeLanguage(language) : undefined;
  });

export function inspectedAddonSourceEvidence(
  candidate: SourceEvidenceCandidateV1,
  info: MediaInfo,
): SourceEvidenceCandidateV1 {
  const audioTracks = Array.isArray(info.audioTracks) ? info.audioTracks : [];
  const subtitleTracks = Array.isArray(info.subtitleTracks) ? info.subtitleTracks : [];
  const tracks = inspectedTracks(audioTracks);

  return {
    ...candidate,
    capabilities: [...candidate.capabilities],
    available: candidate.available && info.video != null
      && audioTracks.some((track) => track != null && typeof track === "object"),
    facts: {
      ...candidate.facts,
      audio: {
        listed: copiedListedLanguages(candidate.facts.audio.listed),
        tracks: { evidence: "inspected", value: tracks },
      },
      embeddedSubtitles: { evidence: "inspected", value: inspectedTracks(subtitleTracks) },
      externalSubtitles: copiedTrackLanguages(candidate.facts.externalSubtitles),
      bytes: unknown(),
      durationSeconds: inspectedNumber(info.duration),
      heightPixels: inspectedNumber(info.video?.height),
      releaseKind: candidate.facts.releaseKind,
      sampleOrTrailer: unknown(),
    },
    ...(candidate.hints === undefined ? {} : { hints: { ...candidate.hints } }),
    ...(candidate.continuationIdentity === undefined
      ? {}
      : { continuationIdentity: { ...candidate.continuationIdentity } }),
  };
}
