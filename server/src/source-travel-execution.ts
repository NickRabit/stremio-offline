import type { DownloadResolution } from "./downloads.js";
import type { MediaInfo } from "./probe.js";
import type { SourceAdmissionSnapshotV1 } from "./source-admission.js";
import { resolveAddonSourceSelection } from "./source-addon-resolution.js";
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

  const resolved = resolveAddonSourceSelection({
    snapshot: input.snapshot,
    candidate: selected.candidate,
    stream: selected.stream,
    info: selected.info,
    externalSubtitles: input.externalSubtitles,
    checkedCandidates: outcome.observations.probesUsed,
  });
  if (resolved === undefined) throw new TravelVerificationError();

  return {
    status: "selected",
    stream: selected.stream,
    ...(resolved.subtitle === undefined ? {} : { subtitle: resolved.subtitle }),
    resolution: resolved.resolution,
    searchStatus: outcome.searchStatus,
    retryable: outcome.retryable,
    ...(outcome.cursor === undefined ? {} : { cursor: outcome.cursor }),
    observations: outcome.observations,
  };
}
