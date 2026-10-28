import type { DownloadResolution } from "./downloads.js";
import { normalizeLanguage } from "./language.js";
import type { RemoteDownloadReference } from "./media-server-download.js";
import type { ProviderVersion } from "./media-server-provider.js";
import type { MediaInfo } from "./probe.js";
import type { SourceAdmissionSnapshotV1 } from "./source-admission.js";
import {
  inspectedAddonSourceEvidence,
  listedAddonSourceEvidence,
} from "./source-addon-evidence.js";
import { resolveAddonSourceSelection } from "./source-addon-resolution.js";
import { torrentKey } from "./download-selection.js";
import { evaluateSourceCandidate, type SourceEvidenceCandidateV1 } from "./source-evidence.js";
import { remoteSourceEvidence } from "./source-remote-evidence.js";
import type {
  RulesContinuationCursorV1,
  RulesObservationSummary,
  RulesSelectedCandidate,
  RulesVerificationOutcome,
} from "./source-rules.js";
import { RulesVerificationError, verifyRulesCandidates } from "./source-rules.js";
import type { StreamItem, SubtitleItem } from "./types.js";

export interface VerifyRulesAddonStreamsInput {
  readonly snapshot: SourceAdmissionSnapshotV1;
  readonly streams: readonly StreamItem[];
  readonly externalSubtitles: readonly SubtitleItem[];
  readonly titleLanguage?: string;
  readonly episode: boolean;
  readonly inspect: (stream: StreamItem) => Promise<MediaInfo | undefined>;
  readonly shouldContinue: () => boolean;
  readonly scopeStamp: unknown;
  readonly hasRealDebrid: boolean;
  readonly remoteCandidates?: readonly RemoteRulesCandidate[];
  readonly remoteTemporaryFailures?: number;
  readonly cursor?: RulesContinuationCursorV1;
  readonly finalTemporaryAttempt?: boolean;
  readonly tried?: readonly string[];
}

export interface RemoteRulesCandidate {
  readonly providerKey: string;
  readonly reference: RemoteDownloadReference;
  readonly version: ProviderVersion;
  readonly stream: StreamItem;
  readonly providerResponseIndex: number;
}

type RulesUnselectedOutcome = Exclude<RulesVerificationOutcome, { status: "selected" }>;
type RulesSelectionDetails = {
  readonly resolution: DownloadResolution;
  readonly searchStatus: "complete";
  readonly retryable: false;
  readonly observations: RulesObservationSummary;
};

export type RulesAddonStreamOutcome =
  | (RulesSelectionDetails & {
    readonly status: "selected";
    readonly stream: StreamItem;
    readonly subtitle?: SubtitleItem;
  })
  | (RulesSelectionDetails & {
    readonly status: "selected";
    readonly remoteDownload: RemoteDownloadReference;
    readonly stream: StreamItem;
  })
  | RulesUnselectedOutcome;

interface PreparedStream {
  readonly kind: "addon";
  readonly candidate: SourceEvidenceCandidateV1;
  readonly stream: StreamItem;
}

interface PreparedRemoteStream {
  readonly kind: "remote";
  readonly candidate: SourceEvidenceCandidateV1;
  readonly stream: StreamItem;
  readonly reference: RemoteDownloadReference;
  readonly version: ProviderVersion;
}

const directHttpUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const realMedia = (info: MediaInfo | undefined): info is MediaInfo =>
  info !== null
  && typeof info === "object"
  && info.video !== undefined
  && info.video !== null
  && Array.isArray(info.audioTracks)
  && info.audioTracks.some((track) => track !== null && typeof track === "object");

const subtitleLanguage = (value: unknown): string | undefined =>
  typeof value === "string" ? normalizeLanguage(value) : undefined;

const listingResolution = (
  snapshot: SourceAdmissionSnapshotV1,
  selection: RulesSelectedCandidate,
  externalSubtitles: readonly SubtitleItem[],
  checkedCandidates: number,
): { readonly resolution: DownloadResolution; readonly subtitle?: SubtitleItem } | undefined => {
  const audio = snapshot.policy.constraints.audio;
  const preferred = "code" in audio.preferred ? audio.preferred.code : undefined;
  const fallback = audio.fallback && "code" in audio.fallback ? audio.fallback.code : undefined;
  if (audio.mode === "strict" && selection.audioTier !== "preferred") return undefined;
  const audioLanguage = selection.audioTier === "preferred"
    ? preferred
    : selection.audioTier === "fallback" ? fallback : undefined;
  if (audio.mode === "strict" && audioLanguage === undefined) return undefined;

  const resolution: DownloadResolution = {
    checkedCandidates,
    ...(audioLanguage === undefined ? {} : { audioLanguage }),
    fallbackUsed: selection.audioTier !== "preferred",
    audioEvidence: selection.candidate.sourceKind === "torrent" ? "listing" : "probe",
  };
  const subtitles = snapshot.policy.constraints.subtitles;
  if (subtitles.mode === "off") return { resolution };

  const subtitlePreferred = subtitles.preferred && "code" in subtitles.preferred
    ? subtitles.preferred.code
    : undefined;
  const subtitleFallback = subtitles.fallback && "code" in subtitles.fallback ? subtitles.fallback.code : undefined;
  if (selection.subtitleTier === "preferred" || selection.subtitleTier === "fallback") {
    const wanted = selection.subtitleTier === "preferred" ? subtitlePreferred : subtitleFallback;
    const external = externalSubtitles.find((subtitle) => subtitleLanguage(subtitle.lang) === wanted);
    return {
      resolution: {
        ...resolution,
        ...(wanted === undefined ? {} : { subtitleLanguage: wanted }),
        subtitleSource: external ? "addon" : "embedded",
        subtitleStatus: "ready",
      },
      ...(external === undefined ? {} : { subtitle: external }),
    };
  }
  if (subtitles.mode === "required") return undefined;
  return { resolution: { ...resolution, subtitleStatus: "missing" } };
};

const sameCandidate = (
  left: SourceEvidenceCandidateV1,
  right: SourceEvidenceCandidateV1,
): boolean => left.sourceId === right.sourceId
  && left.providerKey === right.providerKey
  && left.providerResponseIndex === right.providerResponseIndex;

const remoteResolution = (
  snapshot: SourceAdmissionSnapshotV1,
  selection: RulesSelectedCandidate,
  checkedCandidates: number,
): DownloadResolution | undefined => {
  const audio = snapshot.policy.constraints.audio;
  const preferred = "code" in audio.preferred ? audio.preferred.code : undefined;
  const fallback = audio.fallback && "code" in audio.fallback ? audio.fallback.code : undefined;
  if (audio.mode === "strict" && selection.audioTier !== "preferred") return undefined;
  const audioLanguage = selection.audioTier === "preferred"
    ? preferred
    : selection.audioTier === "fallback" ? fallback : undefined;
  if (audio.mode === "strict" && audioLanguage === undefined) return undefined;

  const resolution: DownloadResolution = {
    checkedCandidates,
    ...(audioLanguage === undefined ? {} : { audioLanguage }),
    fallbackUsed: selection.audioTier !== "preferred",
    audioEvidence: "metadata",
  };
  const subtitles = snapshot.policy.constraints.subtitles;
  if (subtitles.mode === "off") return resolution;

  const subtitlePreferred = subtitles.preferred && "code" in subtitles.preferred
    ? subtitles.preferred.code
    : undefined;
  const subtitleFallback = subtitles.fallback && "code" in subtitles.fallback
    ? subtitles.fallback.code
    : undefined;
  if (selection.subtitleTier === "preferred" || selection.subtitleTier === "fallback") {
    const wanted = selection.subtitleTier === "preferred" ? subtitlePreferred : subtitleFallback;
    return {
      ...resolution,
      ...(wanted === undefined ? {} : { subtitleLanguage: wanted }),
      subtitleStatus: "ready",
    };
  }
  if (subtitles.mode === "required") return undefined;
  return { ...resolution, subtitleStatus: "missing" };
};

export async function verifyRulesAddonStreams(
  input: VerifyRulesAddonStreamsInput,
): Promise<RulesAddonStreamOutcome> {
  const authorized = new Set(input.snapshot.providerKeys);
  const tried = new Set(input.tried ?? []);
  const positions = new Map<string, number>();
  const prepared: Array<PreparedStream | PreparedRemoteStream> = [];
  const preparedKeys = new Set<string>();

  for (const stream of input.streams) {
    if (stream === null || typeof stream !== "object") continue;
    const addonKey = stream.addonKey;
    if (typeof addonKey !== "string" || addonKey.length === 0) continue;
    const providerResponseIndex = positions.get(addonKey) ?? 0;
    positions.set(addonKey, providerResponseIndex + 1);
    const providerKey = `addon:${addonKey}`;
    if (!authorized.has(providerKey)) continue;

    const url = stream.url;
    if (directHttpUrl(url)) {
      if (tried.has(url)) continue;
    } else if (url !== undefined && url !== "") {
      continue;
    } else if (typeof stream.infoHash !== "string" || stream.infoHash.trim().length === 0
      || tried.has(torrentKey(stream))
      || (input.episode
        && (typeof stream.fileIdx !== "number"
          || !Number.isSafeInteger(stream.fileIdx)
          || stream.fileIdx < 0))) {
      continue;
    }

    const candidate = listedAddonSourceEvidence({
      providerKey,
      stream,
      providerResponseIndex,
      available: true,
      ...(input.titleLanguage === undefined ? {} : { titleLanguage: input.titleLanguage }),
      externalSubtitles: input.externalSubtitles,
    });
    if (!candidate) continue;
    const key = candidate.continuationIdentity?.key ?? candidate.sourceId;
    if (preparedKeys.has(key)) continue;
    preparedKeys.add(key);
    prepared.push({ kind: "addon", candidate, stream });
  }

  for (const remote of input.remoteCandidates ?? []) {
    if (!authorized.has(remote.providerKey)) continue;
    const candidate = remoteSourceEvidence(remote);
    if (tried.has(candidate.sourceId)) continue;
    if (evaluateSourceCandidate(input.snapshot, candidate).status === "needsInspection") continue;
    const key = candidate.continuationIdentity?.key ?? candidate.sourceId;
    if (preparedKeys.has(key)) continue;
    preparedKeys.add(key);
    prepared.push({
      kind: "remote",
      candidate,
      stream: remote.stream,
      reference: remote.reference,
      version: remote.version,
    });
  }

  const probed = new Map<string, MediaInfo>();
  const outcome = await verifyRulesCandidates({
    snapshot: input.snapshot,
    candidates: prepared.map((entry) => entry.candidate),
    inspect: async (candidate) => {
      const entry = prepared.find((value) => sameCandidate(value.candidate, candidate));
      if (!entry) throw new RulesVerificationError();
      if (entry.kind === "remote") {
        return {
          status: "ok",
          candidate: { ...entry.candidate, available: false },
        };
      }
      let info: MediaInfo | undefined;
      try {
        info = await input.inspect(entry.stream);
      } catch {
        return { status: "temporaryFailure" };
      }
      if (!realMedia(info)) return { status: "temporaryFailure" };
      const inspected = inspectedAddonSourceEvidence(entry.candidate, info);
      probed.set(inspected.sourceId, info);
      return { status: "ok", candidate: inspected };
    },
    shouldContinue: input.shouldContinue,
    scopeStamp: input.scopeStamp,
    hasRealDebrid: input.hasRealDebrid,
    ...(input.remoteTemporaryFailures === undefined
      ? {}
      : { temporaryFailures: input.remoteTemporaryFailures }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.finalTemporaryAttempt === undefined
      ? {}
      : { finalTemporaryAttempt: input.finalTemporaryAttempt }),
  });
  if (outcome.status !== "selected") return outcome;

  const selected = prepared.find((entry) => sameCandidate(entry.candidate, outcome.selection.candidate));
  if (!selected) throw new RulesVerificationError();
  if (selected.kind === "remote") {
    const resolution = remoteResolution(
      input.snapshot,
      outcome.selection,
      outcome.observations.probesUsed,
    );
    if (resolution === undefined) {
      return {
        status: "noMatch",
        retryable: false,
        observations: outcome.observations,
      };
    }
    return {
      status: "selected",
      remoteDownload: selected.reference,
      stream: selected.stream,
      resolution,
      searchStatus: "complete",
      retryable: false,
      observations: outcome.observations,
    };
  }
  const info = probed.get(outcome.selection.candidate.sourceId);
  const resolved = info === undefined
    ? listingResolution(
      input.snapshot,
      outcome.selection,
      input.externalSubtitles,
      outcome.observations.probesUsed,
    )
    : (() => {
      const value = resolveAddonSourceSelection({
        snapshot: input.snapshot,
        candidate: outcome.selection.candidate,
        stream: selected.stream,
        info,
        externalSubtitles: input.externalSubtitles,
        checkedCandidates: outcome.observations.probesUsed,
      });
      return value === undefined
        ? undefined
        : { resolution: value.resolution, ...(value.subtitle ? { subtitle: value.subtitle } : {}) };
    })();
  if (resolved === undefined) {
    return {
      status: "noMatch",
      retryable: false,
      observations: outcome.observations,
    };
  }

  return {
    status: "selected",
    stream: selected.stream,
    ...(resolved.subtitle === undefined ? {} : { subtitle: resolved.subtitle }),
    resolution: resolved.resolution,
    searchStatus: "complete",
    retryable: false,
    observations: outcome.observations,
  };
}
