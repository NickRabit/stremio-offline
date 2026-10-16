import { api } from "./api";
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
  /** A version of a title the catalogue can name, held under the title's own key. `remote` is the
   *  incoming context of a media-server version, and says which version wrote the row. */
  | { kind: "catalogue"; key: string; progressKey: string; remote?: RemoteStreamContext };

/**
 * The one place a selected row's progress, subtitles and saves are resolved from, so a detail and
 * the player it hands the row to can never disagree about which version is on screen. A row of the
 * viewer's own library is a file; everything else is the title, so one film or episode keeps one
 * position whichever version plays it, whether that is an addon answer or a version a media server
 * owns. Only a media-server version no title can name keeps the store of its own item, and nothing
 * falls back to the path or the item a detail happened to be opened on.
 */
export function sourceProgressOwner(stream: Stream, catalogue: CatalogueRef | null): SourceProgressOwner | null {
  if (isLocalStream(stream) && stream.localPath) {
    const path = stream.localPath;
    const progressKey = localFileProgressKey(path);
    return { kind: "file", key: progressKey, path, progressKey };
  }
  // A media-server version the catalogue cannot name is the only one that keeps its own store.
  if (!catalogue) return stream.remoteItem ? { kind: "remote", key: remoteVersionKey(stream.remoteItem), item: stream.remoteItem } : null;
  const progressKey = genericProgressKey(catalogue);
  return { kind: "catalogue", key: progressKey, progressKey, ...(stream.remoteItem ? { remote: stream.remoteItem } : {}) };
}

/** What one version's saved row says, from whichever store answered it. */
export interface SavedVersionProgress { position: number; duration: number; watched?: boolean; mediaSourceId?: string }

/**
 * The row one version resumes from: the title's own row when it answers, and otherwise the
 * version's own remote state -- where a media server kept the position before the title held it --
 * which the media-source guard reads exactly as it always has. A row another media source wrote is
 * another version's and counts as nothing.
 */
export async function versionSavedRow(
  progressKey: string | null | undefined,
  remote: RemoteStreamContext | null | undefined,
  signal?: AbortSignal,
): Promise<SavedVersionProgress | null> {
  if (progressKey) {
    const title = await api.progressOf(progressKey, signal).catch(() => null);
    if (title) return title;
  }
  if (!remote) return null;
  const own = await api.remoteState(remote.libraryId, remote.itemId, signal).catch(() => null);
  return own && own.mediaSourceId === remote.mediaSourceId ? own : null;
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
