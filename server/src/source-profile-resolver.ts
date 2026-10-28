import { allowedAddons } from "./addons.js";
import { addonIdentity, isAddonIdentity } from "./addon-identity.js";
import { mayDownloadToLibrary, type DownloadJob, type DownloadResolution } from "./downloads.js";
import { resolveAddonSourceSelection } from "./source-addon-resolution.js";
import type { SourceAdmissionSnapshotV1 } from "./source-admission.js";
import {
  selectProviderPriorityDownloadSource,
  validateProviderPriorityDownloadSnapshot,
} from "./source-provider-priority.js";
import type { SourceResolverDeps } from "./source-resolver.js";
import { declaresStream } from "./source-profiles.js";
import {
  verifyTravelAddonStreams,
  type TravelAddonStreamOutcome,
} from "./source-travel-execution.js";
import type {
  TravelContinuationCursorV1,
  TravelObservationSummary,
} from "./source-travel.js";
import type { RulesContinuationCursorV1 } from "./source-rules.js";
import {
  verifyRulesAddonStreams,
  type RemoteRulesCandidate,
  type RulesAddonStreamOutcome,
} from "./source-rules-execution.js";
import type { AddonDownloadSettings, AddonRecord, StreamItem, SubtitleItem } from "./types.js";
import { findUserById, type UserRecord } from "./users.js";

export interface TravelProfileResolverInput {
  readonly source: NonNullable<DownloadJob["source"]>;
  readonly snapshot: SourceAdmissionSnapshotV1;
  readonly ownerUserId: string | undefined;
  readonly signal: AbortSignal;
  readonly cursor?: TravelContinuationCursorV1;
}

export interface ProviderPriorityProfileResolverInput {
  readonly source: NonNullable<DownloadJob["source"]>;
  readonly snapshot: SourceAdmissionSnapshotV1;
  readonly ownerUserId: string | undefined;
  readonly signal: AbortSignal;
}

export interface RulesProfileResolverInput {
  readonly source: NonNullable<DownloadJob["source"]>;
  readonly snapshot: SourceAdmissionSnapshotV1;
  readonly ownerUserId: string | undefined;
  readonly signal: AbortSignal;
  readonly cursor?: RulesContinuationCursorV1;
  readonly finalTemporaryAttempt?: boolean;
}

type TravelUnselectedOutcome = Exclude<TravelAddonStreamOutcome, { status: "selected" }>;

export type TravelProfileResolution =
  | TravelUnselectedOutcome
  | (Extract<TravelAddonStreamOutcome, { status: "selected" }> & {
    readonly settings: AddonDownloadSettings;
    readonly streamAddonIdentity: string;
    readonly subtitleAddonIdentity?: string;
  });

export type ProviderPriorityProfileResolution =
  | {
    readonly status: "selected";
    readonly stream: StreamItem;
    readonly subtitle?: SubtitleItem;
    readonly resolution: DownloadResolution;
    readonly settings: AddonDownloadSettings;
    readonly streamAddonIdentity: string;
    readonly subtitleAddonIdentity?: string;
    readonly searchStatus: "complete" | "incompleteSearch";
  }
  | {
    readonly status: "noMatch";
    readonly checkedCandidates: number;
    readonly temporaryFailures: number;
    readonly truncated: boolean;
  }
  | {
    readonly status: "accessDenied";
  }
  | {
    readonly status: "cancelled";
  };

type RulesUnselectedOutcome = Exclude<RulesAddonStreamOutcome, { status: "selected" }>;
type RulesSelectedOutcome = Extract<RulesAddonStreamOutcome, { status: "selected" }>;
type RulesRemoteSelectedOutcome = Extract<RulesSelectedOutcome, { remoteDownload: unknown }>;
type RulesAddonSelectedOutcome = Exclude<RulesSelectedOutcome, RulesRemoteSelectedOutcome>;

export type RulesProfileResolution =
  | RulesUnselectedOutcome
  | (RulesAddonSelectedOutcome & {
    readonly settings: AddonDownloadSettings;
    readonly streamAddonIdentity: string;
    readonly subtitleAddonIdentity?: string;
  })
  | RulesRemoteSelectedOutcome;

const rulesAccessDenied = (): RulesUnselectedOutcome => ({
  status: "accessDenied",
  retryable: false,
  observations: emptyObservations(),
});

const rulesCancelled = (): RulesUnselectedOutcome => ({
  status: "cancelled",
  retryable: false,
  observations: emptyObservations(),
});

const rulesUnavailable = (
  acquired: Extract<AcquiredProfileAddons, { status: "accessDenied" | "cancelled" }>,
): RulesUnselectedOutcome => acquired.status === "cancelled" ? rulesCancelled() : rulesAccessDenied();

interface LiveAuthorization {
  readonly owner: UserRecord;
  readonly usable: AddonRecord[];
  readonly scopedStreamProviders: AddonRecord[];
}

interface FinalizedAddonSelection {
  readonly settings: AddonDownloadSettings;
  readonly streamAddonIdentity: string;
  readonly subtitleAddonIdentity?: string;
}

interface AcquiredProfileAddonsInput {
  readonly source: NonNullable<DownloadJob["source"]>;
  readonly snapshot: SourceAdmissionSnapshotV1;
  readonly ownerUserId: string | undefined;
  readonly signal: AbortSignal;
}

type AcquiredProfileAddons =
  | {
    readonly status: "accessDenied" | "cancelled";
  }
  | {
    readonly status: "ready";
    readonly streams: StreamItem[];
    readonly externalSubtitles: SubtitleItem[];
    readonly shouldContinue: () => boolean;
    readonly scopeStamp: unknown;
    readonly finalize: (selection: {
      readonly stream: StreamItem;
      readonly subtitle?: SubtitleItem;
    }) => FinalizedAddonSelection | undefined;
  };

const emptyObservations = (): TravelObservationSummary => ({
  probesUsed: 0,
  confirmedRejections: 0,
  temporaryFailures: 0,
  accessDenials: 0,
  unresolvedCandidates: 0,
});

const travelAccessDenied = (): TravelUnselectedOutcome => ({
  status: "accessDenied",
  retryable: false,
  observations: emptyObservations(),
});

const travelCancelled = (): TravelUnselectedOutcome => ({
  status: "cancelled",
  retryable: false,
  observations: emptyObservations(),
});

const travelUnavailable = (acquired: Extract<AcquiredProfileAddons, { status: "accessDenied" | "cancelled" }>) =>
  acquired.status === "cancelled" ? travelCancelled() : travelAccessDenied();

const sameIdentity = (
  captured: ReadonlyMap<string, string>,
  addon: AddonRecord | undefined,
): addon is AddonRecord =>
  addon !== undefined && captured.get(addon.key) === addonIdentity(addon);

const permittedScopedStreams = (
  authorization: LiveAuthorization,
  captured: ReadonlyMap<string, string>,
): AddonRecord[] =>
  authorization.scopedStreamProviders.filter((addon) => sameIdentity(captured, addon));

const scopeStampFor = (
  ownerUserId: string,
  snapshot: SourceAdmissionSnapshotV1,
  streamProviders: readonly AddonRecord[],
) => ({
  schemaVersion: 1,
  ownerUserId,
  providerKeys: [...snapshot.providerKeys].sort(),
  scopedStreamAddons: streamProviders
    .map((addon) => ({ key: addon.key, identity: addonIdentity(addon) }))
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
});

const httpUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const abortable = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const stopped = () => reject(new Error("Remote discovery was stopped."));
    if (signal.aborted) {
      stopped();
      return;
    }
    signal.addEventListener("abort", stopped, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", stopped);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", stopped);
        reject(error);
      },
    );
  });

const externalSubtitlesForResolution = (
  stream: StreamItem,
  externalSubtitles: readonly SubtitleItem[],
): { readonly stream: StreamItem; readonly externalSubtitles: SubtitleItem[] } => ({
  stream: Array.isArray(stream.subtitles)
    ? {
      ...stream,
      subtitles: stream.subtitles.filter((subtitle) =>
        subtitle !== null && typeof subtitle === "object" && httpUrl(subtitle.url)),
    }
    : stream,
  externalSubtitles: externalSubtitles.filter((subtitle) => httpUrl(subtitle.url)),
});

async function acquireProfileAddons(
  deps: SourceResolverDeps,
  input: AcquiredProfileAddonsInput,
  allowWithoutAddons = false,
): Promise<AcquiredProfileAddons> {
  const { source, snapshot, ownerUserId, signal } = input;
  if (signal.aborted) return { status: "cancelled" };
  if (!ownerUserId) return { status: "accessDenied" };

  const current = (): LiveAuthorization | undefined => {
    if (signal.aborted) return undefined;
    const owner = findUserById(deps.users(), ownerUserId);
    if (!owner || owner.disabled || !mayDownloadToLibrary(owner)) return undefined;
    const usable = allowedAddons(deps.addons(), { id: owner.id, role: owner.role })
      .filter((addon) => addon.enabled);
    const providerKeys = new Set(snapshot.providerKeys);
    const scopedStreamProviders = usable.filter((addon) =>
      providerKeys.has(`addon:${addon.key}`)
      && addon.role !== "catalog"
      && declaresStream(addon));
    return { owner, usable, scopedStreamProviders };
  };

  const unavailable = (): Extract<AcquiredProfileAddons, { status: "accessDenied" | "cancelled" }> =>
    signal.aborted ? { status: "cancelled" } : { status: "accessDenied" };

  const initial = current();
  if (!initial) return unavailable();
  if (initial.scopedStreamProviders.length === 0) {
    if (!allowWithoutAddons) return { status: "accessDenied" };
    return {
      status: "ready",
      streams: [],
      externalSubtitles: [],
      shouldContinue: () => current() !== undefined,
      scopeStamp: scopeStampFor(initial.owner.id, snapshot, []),
      finalize: () => undefined,
    };
  }

  const streamIdentities = new Map(
    initial.scopedStreamProviders.map((addon) => [addon.key, addonIdentity(addon)]),
  );

  let listed: StreamItem[];
  try {
    listed = await deps.listStreams(initial.scopedStreamProviders, source.type, source.videoId);
  } catch (error) {
    if (signal.aborted) return { status: "cancelled" };
    throw error;
  }

  const afterListing = current();
  if (!afterListing) return unavailable();
  let streamProviders = permittedScopedStreams(afterListing, streamIdentities);
  if (streamProviders.length === 0) return { status: "accessDenied" };

  let streams = listed.filter((stream) =>
    typeof stream.addonKey === "string"
    && streamProviders.some((addon) =>
      addon.key === stream.addonKey && streamIdentities.get(addon.key) === addonIdentity(addon)));

  try {
    await deps.serverReady;
  } catch (error) {
    if (signal.aborted) return { status: "cancelled" };
    throw error;
  }

  const beforeSubtitles = current();
  if (!beforeSubtitles) return unavailable();
  streamProviders = permittedScopedStreams(beforeSubtitles, streamIdentities);
  if (streamProviders.length === 0) return { status: "accessDenied" };

  const subtitleIdentities = new Map(
    beforeSubtitles.usable.map((addon) => [addon.key, addonIdentity(addon)]),
  );
  let listedSubtitles: SubtitleItem[] = [];
  if (snapshot.policy.constraints.subtitles.mode !== "off") {
    try {
      listedSubtitles = await deps.listSubtitles(
        beforeSubtitles.usable,
        source.type,
        source.videoId,
        signal,
      );
    } catch (error) {
      if (signal.aborted) return { status: "cancelled" };
      throw error;
    }
  }

  const beforeVerification = current();
  if (!beforeVerification) return unavailable();
  streamProviders = permittedScopedStreams(beforeVerification, streamIdentities);
  if (streamProviders.length === 0) return { status: "accessDenied" };

  streams = streams.filter((stream) =>
    typeof stream.addonKey === "string"
    && streamProviders.some((addon) =>
      addon.key === stream.addonKey && streamIdentities.get(addon.key) === addonIdentity(addon)));
  const externalSubtitles = listedSubtitles.filter((subtitle) =>
    typeof subtitle.addonKey === "string"
    && beforeVerification.usable.some((addon) =>
      addon.key === subtitle.addonKey
      && subtitleIdentities.get(addon.key) === addonIdentity(addon)));

  const shouldContinue = (): boolean => {
    if (signal.aborted) return false;
    const authorization = current();
    return authorization !== undefined && streamProviders.every((addon) => {
      const live = authorization.usable.find((candidate) => candidate.key === addon.key);
      return sameIdentity(streamIdentities, live);
    });
  };

  const finalize = (selection: {
    readonly stream: StreamItem;
    readonly subtitle?: SubtitleItem;
  }): FinalizedAddonSelection | undefined => {
    const final = current();
    if (!final) return undefined;
    const selectedStreamProvider = final.usable.find((addon) =>
      addon.key === selection.stream.addonKey);
    if (!sameIdentity(streamIdentities, selectedStreamProvider)) return undefined;

    const streamAddonIdentity = addonIdentity(selectedStreamProvider);
    let subtitleAddonIdentity: string | undefined;
    if (selection.subtitle?.addonKey !== undefined) {
      const selectedSubtitleAddon = final.usable.find((addon) =>
        addon.key === selection.subtitle!.addonKey);
      const capturedIdentity = subtitleIdentities.get(selection.subtitle.addonKey)
        ?? streamIdentities.get(selection.subtitle.addonKey);
      if (capturedIdentity === undefined
        || selectedSubtitleAddon === undefined
        || addonIdentity(selectedSubtitleAddon) !== capturedIdentity
        || !isAddonIdentity(capturedIdentity)) {
        return undefined;
      }
      subtitleAddonIdentity = capturedIdentity;
    }

    return {
      settings: selectedStreamProvider.downloadSettings,
      streamAddonIdentity,
      ...(subtitleAddonIdentity === undefined ? {} : { subtitleAddonIdentity }),
    };
  };

  return {
    status: "ready",
    streams,
    externalSubtitles,
    shouldContinue,
    scopeStamp: scopeStampFor(initial.owner.id, snapshot, streamProviders),
    finalize,
  };
}

export function createTravelProfileResolver(
  deps: SourceResolverDeps,
): (input: TravelProfileResolverInput) => Promise<TravelProfileResolution> {
  return async ({ source, snapshot, ownerUserId, signal, cursor }) => {
    const acquired = await acquireProfileAddons(deps, {
      source,
      snapshot,
      ownerUserId,
      signal,
    });
    if (acquired.status !== "ready") return travelUnavailable(acquired);

    const outcome = await verifyTravelAddonStreams({
      snapshot,
      streams: acquired.streams,
      externalSubtitles: acquired.externalSubtitles,
      ...(source.selection?.titleLanguage === undefined
        ? {}
        : { titleLanguage: source.selection.titleLanguage }),
      inspect: (stream) => deps.inspect(stream, signal),
      shouldContinue: acquired.shouldContinue,
      scopeStamp: acquired.scopeStamp,
      ...(deps.debridReady === undefined ? {} : { debridReady: deps.debridReady }),
      ...(cursor === undefined ? {} : { cursor }),
      tried: source.tried,
    });

    if (outcome.status !== "selected") return outcome;

    const finalized = acquired.finalize(outcome);
    if (!finalized) return travelUnavailable({ status: signal.aborted ? "cancelled" : "accessDenied" });
    return { ...outcome, ...finalized };
  };
}

export function createRulesProfileResolver(
  deps: SourceResolverDeps,
): (input: RulesProfileResolverInput) => Promise<RulesProfileResolution> {
  return async ({ source, snapshot, ownerUserId, signal, cursor, finalTemporaryAttempt }) => {
    const acquired = await acquireProfileAddons(deps, {
      source,
      snapshot,
      ownerUserId,
      signal,
    }, true);
    if (acquired.status !== "ready") return rulesUnavailable(acquired);

    const remoteKeys = snapshot.providerKeys.filter((key) => key.startsWith("remote:"));
    const remoteCandidates: RemoteRulesCandidate[] = [];
    let remoteTemporaryFailures = 0;
    if (ownerUserId && remoteKeys.length > 0 && (source.type === "movie" || source.type === "series")) {
      const listing = new Array<RemoteRulesCandidate[] | undefined>(remoteKeys.length);
      let next = 0;
      const worker = async () => {
        while (!signal.aborted) {
          const index = next++;
          const providerKey = remoteKeys[index];
          if (providerKey === undefined) return;
          const libraryId = providerKey.slice("remote:".length);
          try {
            const remoteSignal = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
            const candidates = await abortable(deps.remoteDownloadCandidates({
              ownerUserId,
              libraryId,
              type: source.type as "movie" | "series",
              catalogId: source.videoId,
              signal: remoteSignal,
            }), remoteSignal);
            listing[index] = candidates.map((candidate, candidateIndex) => ({
              providerKey,
              reference: candidate.reference,
              version: candidate.version,
              stream: candidate.stream,
              providerResponseIndex: index * 10_000 + candidateIndex,
            }));
          } catch {
            if (signal.aborted) return;
            remoteTemporaryFailures += 1;
          }
        }
      };
      await Promise.all([worker(), worker()]);
      if (signal.aborted) return rulesCancelled();
      for (const candidates of listing) if (candidates !== undefined) remoteCandidates.push(...candidates);
    }

    const outcome = await verifyRulesAddonStreams({
      snapshot,
      streams: acquired.streams,
      remoteCandidates,
      remoteTemporaryFailures,
      externalSubtitles: acquired.externalSubtitles.filter((subtitle) => httpUrl(subtitle.url)),
      ...(source.selection?.titleLanguage === undefined
        ? {}
        : { titleLanguage: source.selection.titleLanguage }),
      episode: source.type === "series",
      inspect: (stream) => deps.inspect(stream, signal),
      shouldContinue: acquired.shouldContinue,
      scopeStamp: acquired.scopeStamp,
      hasRealDebrid: deps.hasRealDebrid(),
      ...(deps.debridReady === undefined ? {} : { debridReady: deps.debridReady }),
      ...(cursor === undefined ? {} : { cursor }),
      ...(finalTemporaryAttempt === undefined ? {} : { finalTemporaryAttempt }),
      tried: source.tried,
    });
    if (outcome.status !== "selected") return outcome;
    if ("remoteDownload" in outcome) return outcome;
    if (outcome.stream.infoHash !== undefined && !deps.hasRealDebrid()) {
      return rulesAccessDenied();
    }

    const finalized = acquired.finalize({
      stream: outcome.stream,
      ...(outcome.subtitle === undefined ? {} : { subtitle: outcome.subtitle }),
    });
    if (!finalized) return signal.aborted ? rulesCancelled() : rulesAccessDenied();
    return { ...outcome, ...finalized };
  };
}

export function createProviderPriorityProfileResolver(
  deps: SourceResolverDeps,
): (input: ProviderPriorityProfileResolverInput) => Promise<ProviderPriorityProfileResolution> {
  return async ({ source, snapshot: suppliedSnapshot, ownerUserId, signal }) => {
    const snapshot = validateProviderPriorityDownloadSnapshot(suppliedSnapshot);
    if (signal.aborted) return { status: "cancelled" };

    const acquired = await acquireProfileAddons(deps, {
      source,
      snapshot,
      ownerUserId,
      signal,
    });
    if (acquired.status !== "ready") return acquired;

    const selection = await selectProviderPriorityDownloadSource({
      snapshot,
      streams: acquired.streams,
      externalSubtitles: acquired.externalSubtitles,
      ...(source.selection?.titleLanguage === undefined
        ? {}
        : { titleLanguage: source.selection.titleLanguage }),
      tried: source.tried,
      episode: source.type === "series",
      hasRealDebrid: deps.hasRealDebrid(),
      ...(deps.debridReady === undefined ? {} : { debridReady: deps.debridReady }),
      inspect: (stream) => deps.inspect(stream, signal),
      shouldContinue: acquired.shouldContinue,
    });

    if (selection.status === "noMatch") {
      return {
        status: "noMatch",
        checkedCandidates: selection.checkedCandidates,
        temporaryFailures: selection.temporaryFailures,
        truncated: selection.truncated,
      };
    }
    if (selection.status === "cancelled") {
      return { status: signal.aborted ? "cancelled" : "accessDenied" };
    }
    if (signal.aborted) return { status: "cancelled" };
    if (selection.candidate.sourceKind === "torrent" && !deps.hasRealDebrid()) {
      return { status: "accessDenied" };
    }

    const safeSubtitles = externalSubtitlesForResolution(
      selection.stream,
      acquired.externalSubtitles,
    );
    const resolved = resolveAddonSourceSelection({
      snapshot,
      candidate: selection.candidate,
      stream: safeSubtitles.stream,
      ...(selection.info === undefined ? {} : { info: selection.info }),
      externalSubtitles: safeSubtitles.externalSubtitles,
      checkedCandidates: selection.checkedCandidates,
    });
    if (resolved === undefined) {
      return {
        status: "noMatch",
        checkedCandidates: selection.checkedCandidates,
        temporaryFailures: selection.temporaryFailures,
        truncated: selection.truncated,
      };
    }

    const finalized = acquired.finalize({
      stream: selection.stream,
      ...(resolved.subtitle === undefined ? {} : { subtitle: resolved.subtitle }),
    });
    if (!finalized) return { status: signal.aborted ? "cancelled" : "accessDenied" };

    return {
      status: "selected",
      stream: selection.stream,
      ...(resolved.subtitle === undefined ? {} : { subtitle: resolved.subtitle }),
      resolution: resolved.resolution,
      searchStatus: selection.truncated ? "incompleteSearch" : "complete",
      ...finalized,
    };
  };
}
