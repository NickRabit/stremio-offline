import { createHash } from "node:crypto";
import { allowedAddons } from "./addons.js";
import { mayDownloadToLibrary, type DownloadJob } from "./downloads.js";
import type { SourceAdmissionSnapshotV1 } from "./source-admission.js";
import type { SourceResolverDeps } from "./source-resolver.js";
import {
  verifyTravelAddonStreams,
  type TravelAddonStreamOutcome,
} from "./source-travel-execution.js";
import type {
  TravelContinuationCursorV1,
  TravelObservationSummary,
} from "./source-travel.js";
import type { AddonDownloadSettings, AddonRecord, StreamItem, SubtitleItem } from "./types.js";
import { findUserById, type UserRecord } from "./users.js";

export interface TravelProfileResolverInput {
  readonly source: NonNullable<DownloadJob["source"]>;
  readonly snapshot: SourceAdmissionSnapshotV1;
  readonly ownerUserId: string | undefined;
  readonly signal: AbortSignal;
  readonly cursor?: TravelContinuationCursorV1;
}

type TravelUnselectedOutcome = Exclude<TravelAddonStreamOutcome, { status: "selected" }>;

export type TravelProfileResolution =
  | TravelUnselectedOutcome
  | (Extract<TravelAddonStreamOutcome, { status: "selected" }> & {
    readonly settings: AddonDownloadSettings;
  });

interface LiveAuthorization {
  readonly owner: UserRecord;
  readonly usable: AddonRecord[];
  readonly scopedStreamProviders: AddonRecord[];
}

const identityOf = (addon: AddonRecord): string =>
  JSON.stringify([addon.manifestUrl, addon.manifest.version]);

const identityFingerprint = (addon: AddonRecord): string =>
  createHash("sha256").update(identityOf(addon), "utf8").digest("hex");

const emptyObservations = (): TravelObservationSummary => ({
  probesUsed: 0,
  confirmedRejections: 0,
  temporaryFailures: 0,
  accessDenials: 0,
  unresolvedCandidates: 0,
});

const accessDenied = (): TravelUnselectedOutcome => ({
  status: "accessDenied",
  retryable: false,
  observations: emptyObservations(),
});

const cancelled = (): TravelUnselectedOutcome => ({
  status: "cancelled",
  retryable: false,
  observations: emptyObservations(),
});

const unavailable = (signal: AbortSignal): TravelUnselectedOutcome =>
  signal.aborted ? cancelled() : accessDenied();

const sameIdentity = (
  captured: ReadonlyMap<string, string>,
  addon: AddonRecord | undefined,
): addon is AddonRecord =>
  addon !== undefined && captured.get(addon.key) === identityOf(addon);

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
    .map((addon) => ({ key: addon.key, identity: identityFingerprint(addon) }))
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
});

export function createTravelProfileResolver(
  deps: SourceResolverDeps,
): (input: TravelProfileResolverInput) => Promise<TravelProfileResolution> {
  return async ({ source, snapshot, ownerUserId, signal, cursor }) => {
    if (signal.aborted) return cancelled();
    if (!ownerUserId) return accessDenied();

    const current = (): LiveAuthorization | undefined => {
      if (signal.aborted) return undefined;
      const owner = findUserById(deps.users(), ownerUserId);
      if (!owner || owner.disabled || !mayDownloadToLibrary(owner)) return undefined;
      const usable = allowedAddons(deps.addons(), { id: owner.id, role: owner.role })
        .filter((addon) => addon.enabled);
      const providerKeys = new Set(snapshot.providerKeys);
      const scopedStreamProviders = usable.filter((addon) =>
        providerKeys.has(`addon:${addon.key}`));
      return { owner, usable, scopedStreamProviders };
    };

    const initial = current();
    if (!initial) return unavailable(signal);
    if (initial.scopedStreamProviders.length === 0) return accessDenied();

    const streamIdentities = new Map(
      initial.scopedStreamProviders.map((addon) => [addon.key, identityOf(addon)]),
    );

    let listed: StreamItem[];
    try {
      listed = await deps.listStreams(initial.scopedStreamProviders, source.type, source.videoId);
    } catch (error) {
      if (signal.aborted) return cancelled();
      throw error;
    }

    const afterListing = current();
    if (!afterListing) return unavailable(signal);
    let streamProviders = permittedScopedStreams(afterListing, streamIdentities);
    if (streamProviders.length === 0) return accessDenied();

    let streams = listed.filter((stream) =>
      typeof stream.addonKey === "string"
      && streamProviders.some((addon) =>
        addon.key === stream.addonKey && streamIdentities.get(addon.key) === identityOf(addon)));

    try {
      await deps.serverReady;
    } catch (error) {
      if (signal.aborted) return cancelled();
      throw error;
    }

    const beforeSubtitles = current();
    if (!beforeSubtitles) return unavailable(signal);
    streamProviders = permittedScopedStreams(beforeSubtitles, streamIdentities);
    if (streamProviders.length === 0) return accessDenied();

    const subtitleIdentities = new Map(
      beforeSubtitles.usable.map((addon) => [addon.key, identityOf(addon)]),
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
        if (signal.aborted) return cancelled();
        throw error;
      }
    }

    const beforeVerification = current();
    if (!beforeVerification) return unavailable(signal);
    streamProviders = permittedScopedStreams(beforeVerification, streamIdentities);
    if (streamProviders.length === 0) return accessDenied();

    streams = streams.filter((stream) =>
      typeof stream.addonKey === "string"
      && streamProviders.some((addon) =>
        addon.key === stream.addonKey && streamIdentities.get(addon.key) === identityOf(addon)));
    const externalSubtitles = listedSubtitles.filter((subtitle) =>
      typeof subtitle.addonKey === "string"
      && beforeVerification.usable.some((addon) =>
        addon.key === subtitle.addonKey
        && subtitleIdentities.get(addon.key) === identityOf(addon)));

    const shouldContinue = (): boolean => {
      if (signal.aborted) return false;
      const authorization = current();
      return authorization !== undefined && streamProviders.every((addon) => {
        const live = authorization.usable.find((candidate) => candidate.key === addon.key);
        return sameIdentity(streamIdentities, live);
      });
    };

    const outcome = await verifyTravelAddonStreams({
      snapshot,
      streams,
      externalSubtitles,
      ...(source.selection?.titleLanguage === undefined
        ? {}
        : { titleLanguage: source.selection.titleLanguage }),
      inspect: (stream) => deps.inspect(stream, signal),
      shouldContinue,
      scopeStamp: scopeStampFor(
        initial.owner.id,
        snapshot,
        streamProviders,
      ),
      ...(cursor === undefined ? {} : { cursor }),
      tried: source.tried,
    });

    if (outcome.status !== "selected") return outcome;

    const final = current();
    if (!final) return unavailable(signal);
    const selectedStreamProvider = final.usable.find((addon) =>
      addon.key === outcome.stream.addonKey);
    if (!sameIdentity(streamIdentities, selectedStreamProvider)) return accessDenied();

    if (outcome.subtitle?.addonKey !== undefined) {
      const selectedSubtitleAddon = final.usable.find((addon) =>
        addon.key === outcome.subtitle!.addonKey);
      const capturedIdentity = subtitleIdentities.get(outcome.subtitle.addonKey)
        ?? streamIdentities.get(outcome.subtitle.addonKey);
      if (capturedIdentity === undefined
        || selectedSubtitleAddon === undefined
        || identityOf(selectedSubtitleAddon) !== capturedIdentity) {
        return accessDenied();
      }
    }

    return { ...outcome, settings: selectedStreamProvider.downloadSettings };
  };
}
