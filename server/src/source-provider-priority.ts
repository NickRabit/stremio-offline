import type { MediaInfo } from "./probe.js";
import {
  parseSourceAdmissionSnapshotV1,
  type SourceAdmissionSnapshotV1,
} from "./source-admission.js";
import {
  inspectedAddonSourceEvidence,
  listedAddonSourceEvidence,
} from "./source-addon-evidence.js";
import {
  evaluateSourceCandidate,
  rankEligibleSources,
  type SourceEvidenceCandidateV1,
} from "./source-evidence.js";
import { torrentKey } from "./download-selection.js";
import type { StreamItem, SubtitleItem } from "./types.js";

export const PROVIDER_PRIORITY_INSPECTION_BUDGET = 15;

const MIN_STREAM_DURATION_SECONDS = 60;

export class ProviderPrioritySnapshotError extends Error {
  constructor() {
    super("Invalid Provider priority source snapshot.");
    this.name = "ProviderPrioritySnapshotError";
  }
}

export interface SelectProviderPriorityDownloadInput {
  readonly snapshot: SourceAdmissionSnapshotV1;
  readonly streams: readonly StreamItem[];
  readonly externalSubtitles: readonly SubtitleItem[];
  readonly titleLanguage?: string;
  readonly tried: readonly string[];
  readonly episode: boolean;
  readonly hasRealDebrid: boolean;
  readonly inspect: (stream: StreamItem) => Promise<MediaInfo | undefined>;
  readonly shouldContinue: () => boolean;
}

export type ProviderPrioritySelectionResult =
  | {
    readonly status: "selected";
    readonly addonKey: string;
    readonly stream: StreamItem;
    readonly candidate: SourceEvidenceCandidateV1;
    readonly info?: MediaInfo;
    readonly checkedCandidates: number;
    readonly temporaryFailures: number;
    readonly truncated: boolean;
  }
  | {
    readonly status: "noMatch";
    readonly checkedCandidates: number;
    readonly temporaryFailures: number;
    readonly truncated: boolean;
  }
  | {
    readonly status: "cancelled";
  };

interface PreparedStream {
  readonly addonKey: string;
  readonly stream: StreamItem;
  readonly candidate: SourceEvidenceCandidateV1;
}

interface InspectedStream extends PreparedStream {
  readonly info: MediaInfo;
}

export function validateProviderPriorityDownloadSnapshot(
  snapshot: SourceAdmissionSnapshotV1,
): SourceAdmissionSnapshotV1 {
  let parsed: SourceAdmissionSnapshotV1;
  try {
    parsed = parseSourceAdmissionSnapshotV1(snapshot);
  } catch {
    throw new ProviderPrioritySnapshotError();
  }
  if (parsed.profile.template !== "providerPriority"
    || parsed.operation !== "downloadToLibrary") {
    throw new ProviderPrioritySnapshotError();
  }
  return parsed;
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

const realMedia = (info: MediaInfo | undefined): info is MediaInfo => {
  if (info === null || typeof info !== "object") return false;
  return info.video !== undefined
    && info.video !== null
    && Array.isArray(info.audioTracks)
    && info.audioTracks.some((track) => track !== null && typeof track === "object");
};

export async function selectProviderPriorityDownloadSource(
  input: SelectProviderPriorityDownloadInput,
): Promise<ProviderPrioritySelectionResult> {
  const snapshot = validateProviderPriorityDownloadSnapshot(input.snapshot);
  if (!input.shouldContinue()) return { status: "cancelled" };
  const authorized = new Set(snapshot.providerKeys.filter((key) => key.startsWith("addon:")));
  const tried = new Set(input.tried);
  const responseIndices = new Map<string, number>();
  const http: PreparedStream[] = [];
  const torrents: PreparedStream[] = [];

  for (const stream of input.streams) {
    if (stream === null || typeof stream !== "object") continue;
    const addonKey = stream.addonKey;
    if (typeof addonKey !== "string" || addonKey.length === 0) continue;

    const providerResponseIndex = responseIndices.get(addonKey) ?? 0;
    responseIndices.set(addonKey, providerResponseIndex + 1);

    const providerKey = `addon:${addonKey}`;
    if (!authorized.has(providerKey)) continue;

    const url = stream.url;
    if (directHttpUrl(url)) {
      if (tried.has(url)) continue;
    } else if (stream.url !== undefined && stream.url !== "") {
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

    const prepared = { addonKey, stream, candidate };
    if (candidate.sourceKind === "http") http.push(prepared);
    else if (candidate.sourceKind === "torrent") torrents.push(prepared);
  }

  const httpByCandidate = new Map<SourceEvidenceCandidateV1, PreparedStream>();
  for (const entry of http) httpByCandidate.set(entry.candidate, entry);
  const rankedHttp = rankEligibleSources(snapshot, http.map((entry) => entry.candidate));
  const truncated = rankedHttp.length > PROVIDER_PRIORITY_INSPECTION_BUDGET;
  const inspected: InspectedStream[] = [];
  let checkedCandidates = 0;
  let temporaryFailures = 0;

  for (const { candidate } of rankedHttp.slice(0, PROVIDER_PRIORITY_INSPECTION_BUDGET)) {
    const entry = httpByCandidate.get(candidate);
    if (!entry) throw new Error("Provider priority HTTP candidate lost its stream.");
    if (!input.shouldContinue()) return { status: "cancelled" };

    checkedCandidates++;
    let info: MediaInfo | undefined;
    try {
      info = await input.inspect(entry.stream);
    } catch {
      info = undefined;
    }
    if (!input.shouldContinue()) return { status: "cancelled" };

    if (!realMedia(info)) {
      temporaryFailures++;
      continue;
    }
    if (info.duration !== undefined && info.duration < MIN_STREAM_DURATION_SECONDS) continue;

    let inspectedCandidate: SourceEvidenceCandidateV1;
    try {
      inspectedCandidate = inspectedAddonSourceEvidence(candidate, info);
    } catch {
      temporaryFailures++;
      continue;
    }
    if (evaluateSourceCandidate(snapshot, inspectedCandidate).status !== "eligible") continue;
    inspected.push({ ...entry, candidate: inspectedCandidate, info });
  }

  if (!input.shouldContinue()) return { status: "cancelled" };
  const rankedInspected = rankEligibleSources(snapshot, inspected.map((entry) => entry.candidate));
  const winner = rankedInspected[0]?.candidate;
  if (winner) {
    const selected = inspected.find((entry) => entry.candidate === winner);
    if (!selected) throw new Error("Provider priority inspected candidate lost its stream.");
    return {
      status: "selected",
      addonKey: selected.addonKey,
      stream: selected.stream,
      candidate: selected.candidate,
      info: selected.info,
      checkedCandidates,
      temporaryFailures,
      truncated,
    };
  }

  if (input.hasRealDebrid) {
    const torrentByCandidate = new Map<SourceEvidenceCandidateV1, PreparedStream>();
    for (const entry of torrents) torrentByCandidate.set(entry.candidate, entry);
    const rankedTorrents = rankEligibleSources(snapshot, torrents.map((entry) => entry.candidate));
    const torrent = rankedTorrents[0]?.candidate;
    if (torrent) {
      const selected = torrentByCandidate.get(torrent);
      if (!selected) throw new Error("Provider priority torrent candidate lost its stream.");
      return {
        status: "selected",
        addonKey: selected.addonKey,
        stream: selected.stream,
        candidate: selected.candidate,
        checkedCandidates,
        temporaryFailures,
        truncated,
      };
    }
  }

  return {
    status: "noMatch",
    checkedCandidates,
    temporaryFailures,
    truncated,
  };
}
