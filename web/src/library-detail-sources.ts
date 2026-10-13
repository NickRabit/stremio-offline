import { t } from "./i18n";
import type { Stream } from "./types";

/** The size one source is compared by: the version's own reported size and nothing guessed.
 *  A source that reports none counts as zero, so it sorts after every known size. */
export const detailSourceSize = (stream: Stream): number => {
  const value = stream.behaviorHints?.videoSize;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
};

/** Largest first, and a tie keeps the order the listing gave, so a refresh can never shuffle
 *  two equally sized sources under the viewer. */
export const orderSources = (streams: Stream[]): Stream[] =>
  streams
    .map((stream, index) => ({ stream, index, size: detailSourceSize(stream) }))
    .sort((left, right) => right.size - left.size || left.index - right.index)
    .map((entry) => entry.stream);

/** The sources a viewer may actually pick: a version the server reports as not playable is
 *  listed by nobody, so it is never chosen here either. */
export const playableSources = (streams: Stream[]): Stream[] => streams.filter((stream) => stream.playable);

/** The source played without a choice: the largest playable one, or nothing when none plays. */
export const defaultSource = (streams: Stream[]): Stream | null => {
  const playable = playableSources(streams);
  return playable.length ? orderSources(playable)[0]! : null;
};

/** What identifies a source across a refresh, never the object a reload replaces: a remote
 *  version names itself with its media-source id, a local copy with its own path. */
export const sourceIdentity = (stream: Stream): string =>
  stream.remoteItem?.mediaSourceId ?? stream.localPath ?? stream.sourceId;

/** The name a row and the play summary show: a local copy's file name first, then the version's
 *  own name, the way an addon or a media server labels it. */
export const sourceName = (stream: Stream): string =>
  stream.behaviorHints?.filename || stream.name || stream.title?.split("\n")[0] || stream.description?.split("\n")[0] || t("tv.version");
