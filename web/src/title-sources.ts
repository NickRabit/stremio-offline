import { api } from "./api";
import { isLocalStream } from "./streams";
import type { RemoteLibrary, Stream } from "./types";

/** Every row one title's player can switch to: the catalogue's own streams, the account's own
 *  copies and the other libraries, read at that one intent and never while browsing. */
export async function titlePlaybackSources(ref: { type: "movie" | "series"; id: string }): Promise<Stream[]> {
  const [providers, localCopies] = await Promise.all([
    api.streamSources(ref.type, ref.id),
    api.localStreams(ref.type, ref.id).catch(() => [] as Stream[]),
  ]);
  const parts = await Promise.all(providers.map((provider) => api.streams(ref.type, ref.id, provider.key).catch(() => [] as Stream[])));
  const libraries = await api.remoteLibraries({ timeoutMs: 3_000 }).catch(() => [] as RemoteLibrary[]);
  const remote = await Promise.all(libraries.filter((library) => library.enabled)
    .map((library) => api.remoteLibraryStreams(library.id, ref.type, ref.id).catch(() => [] as Stream[])));
  const seen = new Set<string>();
  // The viewer's own copies stand where the catalogue detail puts them: first.
  return [...localCopies.filter(isLocalStream), ...parts.flat(), ...remote.flat()]
    .filter((stream) => stream.playable && stream.sourceId.trim().length > 0
      && !seen.has(stream.sourceId) && (seen.add(stream.sourceId), true));
}
