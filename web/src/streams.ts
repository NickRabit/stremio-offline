import { bingeGroupLanguages, guessLanguages, leavesLanguageBlank } from "./languages";
import type { Stream } from "./types";

/** Everything the addon wrote about the source. It sends neither language nor size as data; they tend to be in here. */
export const streamText = (stream: Stream) =>
  [stream.name, stream.title, stream.description, stream.behaviorHints?.filename].filter(Boolean).join(" ");

const UNITS: Record<string, number> = { tb: 1e12, gb: 1e9, mb: 1e6, kb: 1e3 };
// Torrentio does not send the size in behaviorHints at all, only in the text as "💾 35.09 GB".
const SIZE = /(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB)\b/gi;

export function streamSize(stream: Stream): number | undefined {
  const hinted = stream.behaviorHints?.videoSize;
  if (typeof hinted === "number" && hinted > 0) return hinted;
  const matches = [...streamText(stream).matchAll(SIZE)];
  const match = matches[matches.length - 1];
  if (!match) return undefined;
  const value = Number(match[1].replace(",", "."));
  const unit = UNITS[match[2].toLowerCase()];
  return Number.isFinite(value) && unit ? Math.round(value * unit) : undefined;
}

/** `titleLanguage` stands in only for a source whose addon admitted it found no language. */
export function streamLanguages(stream: Stream, titleLanguage?: string): string[] {
  const found = [...new Set([...guessLanguages(streamText(stream)), ...bingeGroupLanguages(stream.behaviorHints?.bingeGroup)])];
  if (found.length || !titleLanguage || !leavesLanguageBlank(stream.behaviorHints?.bingeGroup)) return found;
  return [titleLanguage];
}

export type StreamSort = "recommended" | "size-desc" | "size-asc" | "addon";

export interface StreamFilters { addon: string; language: string; sort: StreamSort }

/** Recommended = the preferred language first, largest first within the group. */
export function arrangeStreams(streams: Stream[], filters: StreamFilters, preferredLanguage: string, priority: Map<string, number> = new Map(), titleLanguage?: string): Stream[] {
  const list = streams.filter((stream) =>
    (!filters.addon || stream.addonName === filters.addon) &&
    (!filters.language || streamLanguages(stream, titleLanguage).includes(filters.language)));

  const size = new Map(list.map((stream) => [stream, streamSize(stream)]));
  const decorated = list.map((stream, index) => ({ stream, index }));
  const rank = (stream: Stream) => priority.get(stream.addonName ?? "") ?? Number.MAX_SAFE_INTEGER;
  decorated.sort((a, b) => {
    if (filters.sort === "addon") return (rank(a.stream) - rank(b.stream)) || (a.index - b.index);
    if (filters.sort === "recommended") {
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
  if (stream.playable) return "HTTP";
  if (stream.kind === "torrent") return "RD";
  return "EXT";
}

export function canQueue(stream: Stream, debridConfigured: boolean): boolean {
  return stream.playable || (stream.kind === "torrent" && debridConfigured);
}

/** Sources keep arriving after the first ones are shown, and a later one can rank higher
 *  than the one already picked. Moving the pick is right while the viewer is still looking
 *  at the list and wrong once they are watching: the player would stop the session it is
 *  playing and start the film again on the new source. */
export function repickStream<T>(state: {
  playing: boolean; picked: boolean; pending: number;
  visible: readonly T[]; selected: T | null; preferred: T | null;
}): { move: true; to: T | null } | { move: false } {
  if (!state.visible.length) return state.selected !== null && !state.playing ? { move: true, to: null } : { move: false };
  if (state.playing) return { move: false };
  if (!state.selected || !state.visible.includes(state.selected)) return { move: true, to: state.preferred };
  // A better source may arrive while paging, but the viewer's own pick is never overridden.
  if (!state.picked && state.pending > 0 && state.preferred && state.selected !== state.preferred) return { move: true, to: state.preferred };
  return { move: false };
}
