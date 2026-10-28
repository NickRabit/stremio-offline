import { sourceLanguages, sourceSize, sourceText } from "@stremio-offline/source-selection";
import type { Stream } from "./types";

export const streamText = (stream: Stream): string => sourceText(stream);

export function streamSize(stream: Stream): number | undefined {
  return sourceSize(stream);
}

export function streamLanguages(stream: Stream, titleLanguage?: string): string[] {
  return sourceLanguages(stream, titleLanguage);
}

export type StreamSort = "recommended" | "size-desc" | "size-asc" | "addon";

export interface StreamFilters { addon: string; language: string; sort: StreamSort }

export function compareRuleRank(a: Stream, b: Stream): number {
  if (!a.rule) return b.rule ? 1 : 0;
  if (!b.rule) return -1;
  const shared = Math.min(a.rule.rank.length, b.rule.rank.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = a.rule.rank[index]! - b.rule.rank[index]!;
    if (difference) return difference;
  }
  return a.rule.rank.length - b.rule.rank.length;
}

/** Without server verdicts, recommended puts the preferred language first and the largest first within the group. */
export function arrangeStreams(streams: Stream[], filters: StreamFilters, preferredLanguage: string, priority: Map<string, number> = new Map(), titleLanguage?: string): Stream[] {
  const list = streams.filter((stream) =>
    (!filters.addon || stream.addonName === filters.addon) &&
    (!filters.language || streamLanguages(stream, titleLanguage).includes(filters.language)));

  const size = new Map(list.map((stream) => [stream, streamSize(stream)]));
  const decorated = list.map((stream, index) => ({ stream, index }));
  const rank = (stream: Stream) => priority.get(stream.addonName ?? "") ?? Number.MAX_SAFE_INTEGER;
  const hasRule = list.some((stream) => stream.rule);
  decorated.sort((a, b) => {
    if (filters.sort === "addon") return (rank(a.stream) - rank(b.stream)) || (a.index - b.index);
    if (filters.sort === "recommended") {
      if (hasRule) return compareRuleRank(a.stream, b.stream) || (a.index - b.index);
      const preferred = (stream: Stream) => streamLanguages(stream, titleLanguage).includes(preferredLanguage) ? 0 : 1;
      const byLanguage = preferred(a.stream) - preferred(b.stream);
      if (byLanguage) return byLanguage;
      const byPriority = rank(a.stream) - rank(b.stream);
      if (byPriority) return byPriority;
    }
    // An unknown size belongs at the end in both sort directions, not only in descending order.
    const left = size.get(a.stream), right = size.get(b.stream);
    if (left === undefined || right === undefined) {
      if (left !== right) return left === undefined ? 1 : -1;
    } else if (left !== right) {
      return filters.sort === "size-asc" ? left - right : right - left;
    }
    return a.index - b.index;
  });
  return decorated.map((item) => item.stream);
}

export function visibleCatalogStreams(
  streams: Stream[],
  filters: StreamFilters,
  preferredLanguage: string,
  priority: Map<string, number>,
  showTorrents: boolean,
  titleLanguage?: string,
): Stream[] {
  const arranged = arrangeStreams(streams, filters, preferredLanguage, priority, titleLanguage);
  return showTorrents ? arranged : arranged.filter((stream) => stream.kind !== "torrent");
}

export function pickDefaultStream(streams: Stream[]): Stream | undefined {
  return streams.find((stream) => stream.playable) ?? streams[0];
}

/** Whether a film is worth following for its release: only once every addon has answered and
 *  none offered anything playable. While they are still asking, the Follow chip would flash up
 *  and vanish the moment the first source arrived. */
export const filmHasNoSource = (state: { loaded: boolean; pending: number; playable: boolean }): boolean =>
  state.loaded && state.pending === 0 && !state.playable;

/** A copy that already exists in one of the viewer's libraries. */
export const isLocalStream = (stream: Stream): boolean => stream.kind === "library";

/** The source filter value that stands for the viewer's own copies. A manifest name is a plain
 *  string, so a leading control character can never collide with an addon of the same name. */
export const LOCAL_SOURCE = "\u0000local";

/** The source filter value one remote library stands for, prefixed the same collision-safe way. */
export const REMOTE_SOURCE_PREFIX = "\u0000remote:";
export const remoteSourceFilter = (libraryId: string): string => `${REMOTE_SOURCE_PREFIX}${libraryId}`;
export const remoteFilterId = (filter: string): string | undefined =>
  filter.startsWith(REMOTE_SOURCE_PREFIX) ? filter.slice(REMOTE_SOURCE_PREFIX.length) : undefined;

export const isRemoteStream = (stream: Stream): boolean => Boolean(stream.provider || stream.remoteItem);

/** Local files lead the unfiltered recommended and addon-priority lists. Other sorts rank them
 *  with addon rows, while a named addon and the dedicated local filter stay exclusive. */
export function catalogSourceRows(
  local: Stream[], addonStreams: Stream[], filter: string, sort: StreamSort = "recommended",
  preferredLanguage = "en", priority: Map<string, number> = new Map(), titleLanguage?: string,
  remote: Stream[] = [],
): Stream[] {
  if (filter === LOCAL_SOURCE) return local;
  const remoteId = remoteFilterId(filter);
  if (remoteId !== undefined) return remote.filter((stream) => stream.libraryId === remoteId);
  if (filter) return addonStreams;
  if (sort === "recommended") {
    const external = [...remote, ...addonStreams];
    return [...local, ...(external.some((stream) => stream.rule) ? external.sort(compareRuleRank) : external)];
  }
  if (sort === "addon") return [...local, ...remote, ...arrangeStreams(addonStreams, { addon: "", language: "", sort }, preferredLanguage, priority, titleLanguage)];
  return arrangeStreams([...addonStreams, ...local, ...remote], { addon: "", language: "", sort }, preferredLanguage, priority, titleLanguage);
}

/** A new episode should stay with the provider the viewer chose when it can, while still
 * choosing that provider's best language and size variant. */
export function pickNextEpisodeStream(streams: Stream[], current: Stream | null, preferredLanguage: string, priority: Map<string, number>, titleLanguage?: string): Stream | undefined {
  const ranked = arrangeStreams(streams.filter((stream) => stream.playable), { addon: "", language: "", sort: "recommended" }, preferredLanguage, priority, titleLanguage);
  const sameAddon = ranked.filter((stream) => Boolean(current) && (
    (current?.addonKey && stream.addonKey === current.addonKey)
    || (current?.addonName && stream.addonName === current.addonName)
  ));
  if (!sameAddon.length) return ranked[0];
  const currentSize = current ? streamSize(current) : undefined;
  return [...sameAddon].sort((left, right) => {
    const language = Number(!streamLanguages(left, titleLanguage).includes(preferredLanguage)) - Number(!streamLanguages(right, titleLanguage).includes(preferredLanguage));
    if (language) return language;
    if (currentSize !== undefined) {
      const distance = (stream: Stream) => {
        const size = streamSize(stream);
        return size === undefined ? Number.POSITIVE_INFINITY : Math.abs(Math.log(size / currentSize));
      };
      const byDistance = distance(left) - distance(right);
      if (byDistance) return byDistance;
    }
    return ranked.indexOf(left) - ranked.indexOf(right);
  })[0];
}

export function streamBadge(stream: Stream): string {
  if (isLocalStream(stream)) return "LOCAL";
  if (stream.provider) return stream.provider.toUpperCase();
  if (stream.playable) return "HTTP";
  if (stream.kind === "torrent") return "RD";
  return "EXT";
}

export function canQueue(stream: Stream, debridConfigured: boolean): boolean {
  if (isLocalStream(stream)) return false;
  // A remote media-server original may be copied into a local library only when the server
  // proved the account's native download right for this exact source; the device save stays
  // denied and no addon or debrid path picks it up.
  if (stream.provider || stream.remoteItem) return stream.playable && stream.capabilities?.downloadToLibrary === true;
  if (stream.capabilities?.downloadToLibrary === false) return false;
  return stream.playable || (stream.kind === "torrent" && debridConfigured);
}

/** Sources keep arriving after the first ones are shown, and a later one can rank higher
 *  than the one already picked. Moving the pick is right while the viewer is still looking
 *  at the list and wrong once they are watching: the player would stop the session it is
 *  playing and start the film again on the new source. */
export function repickStream<T>(state: {
  playing: boolean; picked: boolean; pending: number; upgrade?: boolean;
  visible: readonly T[]; selected: T | null; preferred: T | null;
}): { move: true; to: T | null } | { move: false } {
  if (!state.visible.length) return state.selected !== null && !state.playing ? { move: true, to: null } : { move: false };
  if (state.playing) return { move: false };
  if (!state.selected || !state.visible.includes(state.selected)) return { move: true, to: state.preferred };
  // A local copy may land after every addon finished, when the pending counter is already
  // zero: it replaces an automatic pick, but never the viewer's own or a playing source.
  if (!state.picked && state.upgrade && state.preferred && state.selected !== state.preferred) return { move: true, to: state.preferred };
  // A better source may arrive while paging, but the viewer's own pick is never overridden.
  if (!state.picked && state.pending > 0 && state.preferred && state.selected !== state.preferred) return { move: true, to: state.preferred };
  return { move: false };
}

/** An addon that cannot be played through the server is not offering a source; it is
 *  talking to the viewer -- an expiring subscription, a link to its own setup page.
 *  Such an entry belongs above the list as a message, never in it as something to pick:
 *  left in, it is chosen by default when nothing else arrived and the viewer is told
 *  their sources are broken when the addon simply found none. */
export const isAddonNotice = (stream: Stream): boolean => stream.kind === "unsupported";

export const noticeText = (stream: Stream): string =>
  [stream.title, stream.description, stream.name].find((text) => text?.trim())?.trim().replace(/\s+/g, " ") ?? "";

export const offeredStreams = (streams: Stream[]): Stream[] => streams.filter((stream) => !isAddonNotice(stream));

/** One line per message. Addons repeat the same notice on every request, and a viewer
 *  running several of them from one provider would otherwise read it several times. */
export function addonNotices(streams: Stream[]): Stream[] {
  const seen = new Set<string>();
  return streams.filter((stream) => {
    if (!isAddonNotice(stream)) return false;
    const text = noticeText(stream);
    if (!text || seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}
