import { allowedAddons } from "./addons.js";
import { mayDownloadToLibrary, type DownloadResolution, type StreamResolver } from "./downloads.js";
import { selectDownloadSource, selectTorrentSource } from "./download-selection.js";
import { rankStreams } from "./ranking.js";
import type { MediaInfo } from "./probe.js";
import type { UserPrefs } from "./store.js";
import type { AddonDownloadSettings, AddonRecord, StreamItem, SubtitleItem } from "./types.js";
import { findUserById, type UserRecord } from "./users.js";

export interface SourceResolverDeps {
  users: () => UserRecord[];
  addons: () => AddonRecord[];
  prefs: (ownerUserId: string) => Pick<UserPrefs, "audioLanguage">;
  hasRealDebrid: () => boolean;
  serverReady: Promise<void>;
  listStreams: (addons: AddonRecord[], type: string, id: string) => Promise<StreamItem[]>;
  listSubtitles: (addons: AddonRecord[], type: string, id: string, signal: AbortSignal) => Promise<SubtitleItem[]>;
  inspect: (stream: StreamItem, signal: AbortSignal) => Promise<MediaInfo | undefined>;
}

interface Authorization {
  usable: AddonRecord[];
  streamSources: AddonRecord[];
  priority: Map<string, number>;
}

const selectedBy = (addons: AddonRecord[], keys: string[] | undefined) => {
  if (!keys) return addons;
  const selected = new Set(keys);
  return addons.filter((addon) => selected.has(addon.key));
};

export function createSourceResolver(deps: SourceResolverDeps): StreamResolver {
  return async (source, ownerUserId, signal) => {
    if (!ownerUserId) return undefined;
    const current = (): Authorization | undefined => {
      if (signal.aborted) return undefined;
      const owner = findUserById(deps.users(), ownerUserId);
      if (!owner || owner.disabled || !mayDownloadToLibrary(owner)) return undefined;
      const usable = allowedAddons(deps.addons(), { id: owner.id, role: owner.role }).filter((addon) => addon.enabled);
      return {
        usable,
        streamSources: selectedBy(usable, source.selection?.addonKeys),
        priority: new Map(usable.map((addon, index) => [addon.key, index])),
      };
    };
    const permittedStreams = (authorization: Authorization, streams: StreamItem[]) => {
      const keys = new Set(authorization.streamSources.map((addon) => addon.key));
      return streams.filter((stream) => stream.addonKey !== undefined && keys.has(stream.addonKey));
    };
    const settingsFor = (authorization: Authorization, stream: StreamItem): AddonDownloadSettings | undefined =>
      authorization.usable.find((addon) => addon.key === stream.addonKey)?.downloadSettings;
    const returnable = (authorization: Authorization, choice: { stream: StreamItem; subtitle?: SubtitleItem; resolution?: DownloadResolution }) => {
      if (!authorization.streamSources.some((addon) => addon.key === choice.stream.addonKey)) return undefined;
      if (choice.subtitle?.addonKey && !authorization.usable.some((addon) => addon.key === choice.subtitle!.addonKey)) return undefined;
      const settings = settingsFor(authorization, choice.stream);
      return settings ? { ...choice, settings } : undefined;
    };

    const initial = current();
    if (!initial) return undefined;
    const listed = await deps.listStreams(initial.streamSources, source.type, source.videoId);
    const afterListing = current();
    if (!afterListing) return undefined;
    const candidates = permittedStreams(afterListing, listed).filter((stream) => stream.url);

    if (source.selection) {
      await deps.serverReady;
      const beforeSubtitles = current();
      if (!beforeSubtitles) return undefined;
      const listedSubtitles = source.selection.subtitleMode === "off"
        ? []
        : await deps.listSubtitles(beforeSubtitles.usable, source.type, source.videoId, signal);
      const beforeSelection = current();
      if (!beforeSelection) return undefined;
      const external = listedSubtitles.filter((subtitle) => subtitle.addonKey && beforeSelection.usable.some((addon) => addon.key === subtitle.addonKey));

      const selected = await selectDownloadSource({
        candidates: permittedStreams(beforeSelection, candidates),
        subtitles: external,
        selection: source.selection,
        tried: source.tried,
        inspect: (stream) => deps.inspect(stream, signal),
        shouldContinue: (stream) => {
          const authorization = current();
          return Boolean(authorization?.streamSources.some((addon) => addon.key === stream.addonKey));
        },
      });
      const afterSelection = current();
      if (!afterSelection) return undefined;
      if (selected) return returnable(afterSelection, selected);

      if (!deps.hasRealDebrid()) return undefined;
      const beforeTorrent = current();
      if (!beforeTorrent) return undefined;
      const torrent = selectTorrentSource({
        candidates: permittedStreams(beforeTorrent, listed),
        subtitles: external.filter((subtitle) => beforeTorrent.usable.some((addon) => addon.key === subtitle.addonKey)),
        selection: source.selection,
        tried: source.tried,
        episode: source.type === "series",
      });
      if (!torrent) return undefined;
      return returnable(beforeTorrent, torrent);
    }

    const ranked = rankStreams(candidates, deps.prefs(ownerUserId).audioLanguage, afterListing.priority);
    const next = ranked.find((stream) => !source.tried.includes(stream.url!));
    if (!next) return undefined;
    const settings = settingsFor(afterListing, next);
    return settings ? { stream: next, settings } : undefined;
  };
}
