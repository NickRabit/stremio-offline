import { genericProgressKey } from "./native-addon-sources";
import { isLocalStream } from "./streams";
import type { CatalogueRef } from "./title-enrichment";
import type { RemoteStreamContext, Stream } from "./types";

/** The key one file of the viewer's own library is remembered under, by the detail that plays it
 *  and by the player that writes it. */
export const localFileProgressKey = (path: string) => `file:${path}`;

/** The identity of one remote version: the whole tuple, because two libraries may hand out the
 *  same media-source id for two different copies and neither may answer for the other. */
export const remoteVersionKey = (item: { libraryId: string; itemId: string; mediaSourceId: string }) =>
  `remote:${item.libraryId}\u0000${item.itemId}\u0000${item.mediaSourceId}`;

/** Where the saved position of one selected version lives, and what names it in the interface.
 *  A remote version is named by its whole incoming context, never by the media-source id alone. */
export type SourceProgressOwner =
  /** A file of the viewer's own library, held under its path. */
  | { kind: "file"; key: string; path: string; progressKey: string }
  /** A version a media server owns; read and written through the remote state of its own item. */
  | { kind: "remote"; key: string; item: RemoteStreamContext }
  /** An addon answer, held under the exact catalogue key of the title it answered for. */
  | { kind: "catalogue"; key: string; progressKey: string };

/**
 * The one place a selected row's progress, subtitles and saves are resolved from, so a detail and
 * the player it hands the row to can never disagree about which version is on screen. A row of the
 * viewer's own library is a file, a version with a remote context belongs to that library's item,
 * and anything else is an addon answer that only the catalogue can name -- nothing falls back to
 * the path or the item a detail happened to be opened on.
 */
export function sourceProgressOwner(stream: Stream, catalogue: CatalogueRef | null): SourceProgressOwner | null {
  if (isLocalStream(stream) && stream.localPath) {
    const path = stream.localPath;
    const progressKey = localFileProgressKey(path);
    return { kind: "file", key: progressKey, path, progressKey };
  }
  if (stream.remoteItem) return { kind: "remote", key: remoteVersionKey(stream.remoteItem), item: stream.remoteItem };
  if (!catalogue) return null;
  const progressKey = genericProgressKey(catalogue);
  return { kind: "catalogue", key: progressKey, progressKey };
}

/**
 * What one finished write of the alternative player invalidates. Only the row captured when that
 * playback started counts: another row's key, or a write that lands after the viewer moved on,
 * changes nothing. Any personal store is redrawn -- a catalogue answer writes the very progress
 * the Home shelves read, exactly as a copy of another media server does -- while a file of the
 * viewer's own library is private to the listing that offered it. The caller runs this once the
 * final write has resolved, never before it.
 */
export function alternativeProgressSaved(owner: SourceProgressOwner, key: string, refresh: { personal: () => void; detail: () => void }, scope: { captured: number; current: number }): boolean {
  if (scope.captured !== scope.current || key !== owner.key) return false;
  if (owner.kind !== "file") refresh.personal();
  refresh.detail();
  return true;
}
