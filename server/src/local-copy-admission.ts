import { stat as statPath } from "node:fs/promises";
import path from "node:path";
import type { FoundFile } from "./library.js";
import type { LibraryMetaRecord, TitleUnit } from "./library-match.js";
import { subtitleSidecars as readSubtitleSidecars, type SubtitleSidecars } from "./library-sidecars.js";
import {
  resolveLibraryPath as resolveConfiguredLibraryPath,
  visibleLibraries,
  type LibraryRecord,
  type ResolvedPath,
} from "./libraries.js";
import { normalizeLanguage } from "./language.js";
import { localCopies, type LocalCopy } from "./local-sources.js";
import type { MediaInfo } from "./probe.js";
import {
  inspectedVideoFacts,
  listedAudioLanguages,
  videoCodecFromListing,
  videoRangeFromListing,
} from "./source-addon-evidence.js";
import {
  evaluateSourceCandidate,
  type SourceEvidenceCandidateV1,
  type SourceEvidenceFactsV1,
  type SourceFact,
} from "./source-evidence.js";
import type { SourceAdmissionSnapshotV1 } from "./source-admission.js";
import type { UserRecord } from "./users.js";
import { videoResolutionClass } from "./video-resolution.js";

export const EXISTING_LOCAL_COPY_PROBE_LIMIT = 15;

export interface ExistingLocalCopyInput {
  ownerUserId?: string;
  type: string;
  videoId: string;
  sourceAdmission: SourceAdmissionSnapshotV1;
}

export interface ExistingLocalCopyReference {
  key: string;
  libraryId: string;
  actualSize: number;
}

export interface ExistingLocalCopyDeps {
  users: () => readonly UserRecord[];
  libraries: () => readonly LibraryRecord[];
  libraryFiles: () => Promise<FoundFile[]>;
  libraryUnits: () => Promise<TitleUnit[]>;
  qualifiedMeta: () => Record<string, LibraryMetaRecord>;
  mayDownloadToLibrary: (owner: UserRecord) => boolean;
  probe: (file: string) => Promise<MediaInfo | undefined>;
  resolveLibraryPath?: typeof resolveConfiguredLibraryPath;
  stat?: typeof statPath;
  subtitleSidecars?: (file: string) => Promise<SubtitleSidecars>;
}

interface OwnerScope {
  owner: UserRecord;
  libraries: LibraryRecord[];
}

interface PresentCopy extends LocalCopy {
  absolute: string;
  actualSize: number;
  ino: number;
  dev: number;
  mtimeMs: number;
}

const unknownFact = <T>(): SourceFact<T> => ({ evidence: "unknown" });
const inspectedFact = <T>(value: T): SourceFact<T> => ({ evidence: "inspected", value });

const unknownFacts = (size: number): SourceEvidenceFactsV1 => ({
  audio: {
    listed: unknownFact(),
    tracks: unknownFact(),
  },
  embeddedSubtitles: unknownFact(),
  externalSubtitles: unknownFact(),
  bytes: inspectedFact(size),
  durationSeconds: unknownFact(),
  heightPixels: unknownFact(),
  releaseKind: unknownFact(),
  sampleOrTrailer: unknownFact(),
  videoCodec: unknownFact(),
  videoRange: unknownFact(),
});

const inspectedFacts = (
  size: number,
  info: MediaInfo,
  externalSubtitles: SourceFact<readonly (string | undefined)[]>,
): SourceEvidenceFactsV1 => ({
  audio: {
    listed: unknownFact(),
    tracks: inspectedFact(info.audioTracks.map((track) => track.language)),
  },
  embeddedSubtitles: inspectedFact(info.subtitleTracks.map((track) => track.language)),
  externalSubtitles,
  bytes: inspectedFact(size),
  durationSeconds: info.duration !== undefined && Number.isFinite(info.duration)
    ? inspectedFact(info.duration)
    : unknownFact(),
  heightPixels: (() => {
    const resolution = videoResolutionClass(info.video?.width, info.video?.height);
    return resolution === undefined ? unknownFact() : inspectedFact(resolution);
  })(),
  releaseKind: unknownFact(),
  sampleOrTrailer: unknownFact(),
  ...inspectedVideoFacts(info.video),
});

const sidecarLanguage = (name: string): string | undefined => {
  const match = /\.([a-zA-Z]{2,3})\.(?:srt|vtt)$/i.exec(name);
  return match?.[1] ? normalizeLanguage(match[1]) : undefined;
};

const evidenceCandidate = (
  copy: LocalCopy,
  index: number,
  facts: SourceEvidenceFactsV1,
): SourceEvidenceCandidateV1 => ({
  sourceId: copy.key,
  providerKey: "local",
  providerClass: "local",
  sourceKind: "localFile",
  capabilities: ["downloadToLibrary"],
  providerResponseIndex: index,
  available: true,
  facts,
});

export function listedLocalCopyEvidence(
  copy: Pick<LocalCopy, "key" | "size">,
  providerResponseIndex: number,
  filename = path.posix.basename(copy.key),
): SourceEvidenceCandidateV1 {
  const stream = { behaviorHints: { filename } };
  return {
    sourceId: copy.key,
    providerKey: "local",
    providerClass: "local",
    sourceKind: "localFile",
    capabilities: ["play"],
    providerResponseIndex,
    available: true,
    facts: {
      ...unknownFacts(copy.size),
      audio: {
        listed: listedAudioLanguages(stream, undefined),
        tracks: unknownFact(),
      },
      bytes: { evidence: "listed", value: copy.size },
      videoCodec: videoCodecFromListing(stream),
      videoRange: videoRangeFromListing(stream),
    },
  };
}

export async function findAdequateExistingLocalCopy(
  input: ExistingLocalCopyInput,
  deps: ExistingLocalCopyDeps,
): Promise<ExistingLocalCopyReference | undefined> {
  const stat = deps.stat ?? statPath;
  const resolve = deps.resolveLibraryPath ?? resolveConfiguredLibraryPath;
  const sidecars = deps.subtitleSidecars ?? readSubtitleSidecars;

  const currentScope = (): OwnerScope | undefined => {
    if (!input.ownerUserId) return undefined;
    const owner = deps.users().find((candidate) => candidate.id === input.ownerUserId);
    if (!owner || owner.disabled || !deps.mayDownloadToLibrary(owner)) return undefined;
    return {
      owner,
      libraries: visibleLibraries([...deps.libraries()], { id: owner.id, role: owner.role })
        .filter((library) => library.enabled),
    };
  };

  const initialScope = currentScope();
  if (!initialScope) return undefined;

  let files: FoundFile[];
  let units: TitleUnit[];
  try {
    [files, units] = await Promise.all([deps.libraryFiles(), deps.libraryUnits()]);
  } catch {
    return undefined;
  }
  const afterWalkScope = currentScope();
  if (!afterWalkScope) return undefined;

  const candidates = (libraries: LibraryRecord[], records: Record<string, LibraryMetaRecord>) =>
    localCopies({
      type: input.type,
      id: input.videoId,
      files,
      units,
      records,
      libraries,
    });

  const stillBound = (key: string, scope: OwnerScope): boolean => {
    const current = currentScope();
    return current !== undefined
      && current.owner.id === scope.owner.id
      && candidates(current.libraries, deps.qualifiedMeta()).some((copy) => copy.key === key);
  };

  const present = async (copy: LocalCopy): Promise<PresentCopy | undefined> => {
    const scope = currentScope();
    if (!scope || !scope.libraries.some((library) => library.id === copy.libraryId)) return undefined;
    let resolved: ResolvedPath | undefined;
    try {
      resolved = await resolve(scope.libraries, copy.key);
    } catch {
      return undefined;
    }
    if (!resolved || resolved.key !== copy.key) return undefined;
    try {
      const info = await stat(resolved.absolute);
      if (!info.isFile() || info.size <= 0) return undefined;
      return {
        ...copy,
        absolute: resolved.absolute,
        actualSize: info.size,
        ino: info.ino,
        dev: info.dev,
        mtimeMs: info.mtimeMs,
      };
    } catch {
      return undefined;
    }
  };

  const remainsPresent = async (copy: PresentCopy): Promise<boolean> => {
    let scope = currentScope();
    if (!scope || !scope.libraries.some((library) => library.id === copy.libraryId)) return false;
    if (!stillBound(copy.key, scope)) return false;

    let first: ResolvedPath | undefined;
    try {
      first = await resolve(scope.libraries, copy.key);
    } catch {
      return false;
    }
    if (!first || first.absolute !== copy.absolute) return false;

    scope = currentScope();
    if (!scope || !scope.libraries.some((library) => library.id === copy.libraryId)) return false;
    if (!stillBound(copy.key, scope)) return false;

    let firstInfo;
    try {
      firstInfo = await stat(first.absolute);
    } catch {
      return false;
    }
    if (!firstInfo.isFile()
      || firstInfo.size !== copy.actualSize
      || firstInfo.ino !== copy.ino
      || firstInfo.dev !== copy.dev
      || firstInfo.mtimeMs !== copy.mtimeMs) return false;

    let finalResolved: ResolvedPath | undefined;
    try {
      finalResolved = await resolve(scope.libraries, copy.key);
    } catch {
      return false;
    }
    if (!finalResolved || finalResolved.absolute !== copy.absolute) return false;

    let finalInfo;
    try {
      finalInfo = await stat(finalResolved.absolute);
    } catch {
      return false;
    }
    if (!finalInfo.isFile()
      || finalInfo.size !== copy.actualSize
      || finalInfo.ino !== copy.ino
      || finalInfo.dev !== copy.dev
      || finalInfo.mtimeMs !== copy.mtimeMs) return false;

    const finalScope = currentScope();
    return finalScope !== undefined
      && finalScope.libraries.some((library) => library.id === copy.libraryId)
      && stillBound(copy.key, finalScope);
  };

  const currentExternalSubtitles = async (
    copy: PresentCopy,
  ): Promise<SourceFact<readonly (string | undefined)[]>> => {
    try {
      const adjacent = await sidecars(copy.absolute);
      const present: Array<string | undefined> = [];
      for (const name of adjacent.names) {
        const info = await stat(path.join(path.dirname(copy.absolute), name));
        if (info.isFile() && info.size > 0) present.push(sidecarLanguage(name));
      }
      return inspectedFact(present);
    } catch {
      return unknownFact();
    }
  };

  const remainsAdequateWithRequiredSubtitles = async (
    copy: PresentCopy,
    index: number,
    info: MediaInfo,
  ): Promise<boolean> => {
    if (!await remainsPresent(copy)) return false;
    let externalSubtitles = await currentExternalSubtitles(copy);
    if (evaluateSourceCandidate(
      input.sourceAdmission,
      evidenceCandidate(copy, index, inspectedFacts(copy.actualSize, info, externalSubtitles)),
      "existingLocalCopy",
    ).status !== "eligible") return false;

    if (!await remainsPresent(copy)) return false;
    externalSubtitles = await currentExternalSubtitles(copy);
    if (evaluateSourceCandidate(
      input.sourceAdmission,
      evidenceCandidate(copy, index, inspectedFacts(copy.actualSize, info, externalSubtitles)),
      "existingLocalCopy",
    ).status !== "eligible") return false;

    const finalScope = currentScope();
    return finalScope !== undefined
      && finalScope.libraries.some((library) => library.id === copy.libraryId)
      && stillBound(copy.key, finalScope);
  };

  const presentCopies: PresentCopy[] = [];
  const initialCandidates = candidates(afterWalkScope.libraries, deps.qualifiedMeta());
  for (const copy of initialCandidates) {
    const found = await present(copy);
    if (found) presentCopies.push(found);
  }

  if (input.sourceAdmission.policy.existingLocalCopy === "any") {
    for (const [index, copy] of presentCopies.entries()) {
      const evaluation = evaluateSourceCandidate(
        input.sourceAdmission,
        evidenceCandidate(copy, index, unknownFacts(copy.actualSize)),
        "existingLocalCopy",
      );
      if (evaluation.status === "eligible" && await remainsPresent(copy)) {
        return { key: copy.key, libraryId: copy.libraryId, actualSize: copy.actualSize };
      }
    }
    return undefined;
  }

  let probed = 0;
  for (const [index, copy] of presentCopies.entries()) {
    if (probed >= EXISTING_LOCAL_COPY_PROBE_LIMIT) break;
    probed += 1;

    let info: MediaInfo | undefined;
    try {
      info = await deps.probe(copy.absolute);
    } catch {
      continue;
    }
    if (!info) continue;

    const externalSubtitles = await currentExternalSubtitles(copy);

    const evaluation = evaluateSourceCandidate(
      input.sourceAdmission,
      evidenceCandidate(copy, index, inspectedFacts(copy.actualSize, info, externalSubtitles)),
      "existingLocalCopy",
    );
    if (evaluation.status !== "eligible") continue;
    if (input.sourceAdmission.policy.constraints.subtitles.mode === "required") {
      if (await remainsAdequateWithRequiredSubtitles(copy, index, info)) {
        return { key: copy.key, libraryId: copy.libraryId, actualSize: copy.actualSize };
      }
    } else if (await remainsPresent(copy)) {
      return { key: copy.key, libraryId: copy.libraryId, actualSize: copy.actualSize };
    }
  }

  return undefined;
}

export async function hasAdequateExistingLocalCopy(
  input: ExistingLocalCopyInput,
  deps: ExistingLocalCopyDeps,
): Promise<boolean> {
  return await findAdequateExistingLocalCopy(input, deps) !== undefined;
}
