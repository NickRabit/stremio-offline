import { remoteLibraryVisibleTo, type RemoteAccessSource } from "./media-server-access.js";
import { defaultLibrary, type DefaultLibrarySettings, type LibraryRecord } from "./libraries.js";
import {
  MEDIA_CONNECTION_ID,
  MEDIA_SERVER_KINDS,
  MEDIA_SERVER_LIMITS,
  REMOTE_LIBRARY_ID,
  type MediaServerKind,
  type RemoteLibraryRecord,
  type RemoteLibraryType,
} from "./media-server-types.js";

/**
 * A durable handle for one explicitly chosen media-server original a local library download may
 * copy. Unlike the sealed playback reference it carries no session: no sid, expiry, secret
 * stamp, token, credential, address or sealed source, so it can be written to the queue file and
 * read after a restart. It names the exact account, connection, generation and file version, and
 * every read is re-proved against the live records. It is never accepted from a request body.
 */
export interface RemoteDownloadReference {
  schemaVersion: 1;
  ownerUserId: string;
  connectionId: string;
  libraryId: string;
  generation: number;
  provider: MediaServerKind;
  serverId: string;
  accountId: string;
  itemId: string;
  mediaSourceId: string;
}

const REF_KEYS: readonly string[] = [
  "schemaVersion", "ownerUserId", "connectionId", "libraryId",
  "generation", "provider", "serverId", "accountId", "itemId", "mediaSourceId",
];
const ID_MAX = MEDIA_SERVER_LIMITS.upstreamId;
const OWNER_ID_MAX = 512;
const SEGMENT_BAD = /[/\\?#%\u0000-\u001f\u007f]/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every own key as a plain data property, or nothing when a symbol or an accessor is present. */
const plainKeys = (record: Record<string, unknown>): string[] | undefined => {
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(record)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(record, key) : undefined;
    if (typeof key !== "string" || !descriptor || !("value" in descriptor)) return undefined;
    keys.push(key);
  }
  return keys;
};

const isSegmentId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= ID_MAX
  && !SEGMENT_BAD.test(value) && value !== "." && value !== "..";

const isOwnerId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= OWNER_ID_MAX;

const ownValue = (record: Record<string, unknown>, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};

/** Whether a value is a well-formed reference. Structural only: it proves nothing about the
 *  records behind it, which every caller checks against the live state. */
export const isRemoteDownloadReference = (value: unknown): value is RemoteDownloadReference => {
  if (!isRecord(value)) return false;
  const keys = plainKeys(value);
  if (!keys || keys.length !== REF_KEYS.length || !REF_KEYS.every((key) => keys.includes(key))) return false;
  return ownValue(value, "schemaVersion") === 1
    && isOwnerId(ownValue(value, "ownerUserId"))
    && typeof ownValue(value, "connectionId") === "string" && MEDIA_CONNECTION_ID.test(ownValue(value, "connectionId") as string)
    && typeof ownValue(value, "libraryId") === "string" && REMOTE_LIBRARY_ID.test(ownValue(value, "libraryId") as string)
    && typeof ownValue(value, "generation") === "number" && Number.isSafeInteger(ownValue(value, "generation")) && (ownValue(value, "generation") as number) >= 0
    && MEDIA_SERVER_KINDS.includes(ownValue(value, "provider") as MediaServerKind)
    && isSegmentId(ownValue(value, "serverId"))
    && isSegmentId(ownValue(value, "accountId"))
    && isSegmentId(ownValue(value, "itemId"))
    && isSegmentId(ownValue(value, "mediaSourceId"));
};

/** The one canonical, plain shape of a reference: nothing inherited, nothing extra. */
export const canonicalRemoteDownloadReference = (ref: RemoteDownloadReference): RemoteDownloadReference => ({
  schemaVersion: 1,
  ownerUserId: ref.ownerUserId,
  connectionId: ref.connectionId,
  libraryId: ref.libraryId,
  generation: ref.generation,
  provider: ref.provider,
  serverId: ref.serverId,
  accountId: ref.accountId,
  itemId: ref.itemId,
  mediaSourceId: ref.mediaSourceId,
});

/** The local identity of the exact version behind a reference, for duplicate detection. */
export const remoteDownloadKey = (ref: RemoteDownloadReference): string =>
  [ref.connectionId, ref.itemId, ref.mediaSourceId].join("\u0000");

/**
 * Whether one account may still copy the original a reference names, read from local records
 * only: the account is live, the remote library is still granted to it, and the connection is
 * enabled with the same identity and generation. There is no session here -- a queued download
 * is owner-bound -- and no permission flag, which the queue's own owner check reads separately.
 */
export function remoteDownloadAccessible(
  source: RemoteAccessSource,
  reference: RemoteDownloadReference,
  ownerUserId: string,
): boolean {
  if (!isRemoteDownloadReference(reference) || reference.ownerUserId !== ownerUserId) return false;
  const user = source.users().find((candidate) => candidate.id === ownerUserId);
  if (!user || user.disabled || user.mustChangePassword) return false;
  const connections = source.mediaConnections();
  const library = source.remoteLibraries().find((candidate) => candidate.id === reference.libraryId);
  if (!library || library.connectionId !== reference.connectionId) return false;
  if (!remoteLibraryVisibleTo(connections, library, { id: user.id, role: user.role })) return false;
  const connection = connections.find((candidate) => candidate.id === reference.connectionId);
  if (!connection || !connection.enabled || !connection.secretRef) return false;
  return connection.provider === reference.provider
    && connection.serverId === reference.serverId
    && connection.accountId === reference.accountId
    && connection.generation === reference.generation;
}

/** Whether one local library may receive a copy of a remote library's originals: it is switched
 *  on with a writable, reachable root, and its type takes the content. A mixed remote library
 *  only ever lands in a mixed local library; a movie or series one may also use a mixed library. */
export const takesRemoteCopy = (
  remoteType: RemoteLibraryType,
  library: Pick<LibraryRecord, "type" | "enabled" | "readOnly" | "unreachable">,
): boolean =>
  library.enabled && !library.readOnly && !library.unreachable
  && (remoteType === "mixed" ? library.type === "mixed" : library.type === remoteType || library.type === "mixed");

/** The local library a copy of one remote library's original lands in when the request names no
 *  target. A configured override wins and is returned exactly as it stands -- an unusable one is
 *  refused at the door rather than swapped for another library -- and otherwise the remote
 *  library's own type decides: a movie or series library follows the default for that kind of
 *  content, while a mixed one prefers the first mixed library by order and falls back to the
 *  kind's default only when no mixed library exists. Pure and provider-free, so the source
 *  projection and the download admission read one rule and cannot disagree. */
export function defaultRemoteCopyLibraryId(
  remote: Pick<RemoteLibraryRecord, "type" | "downloadLibraryId">,
  libraries: readonly LibraryRecord[],
  settings: DefaultLibrarySettings,
  kind: "movie" | "series",
): string | undefined {
  if (remote.downloadLibraryId !== undefined) return remote.downloadLibraryId;
  // The kind's own rule, with a root no copy may be written to left out -- the same fallback the
  // queue resolves for every other download, so a read-only default never lands a copy.
  const forKind = (): string | undefined =>
    defaultLibrary(libraries.filter((library) => !library.readOnly), settings,
      (remote.type === "mixed" ? kind : remote.type) === "movie" ? "movie" : "episode")?.id;
  if (remote.type !== "mixed") return forKind();
  const mixed = libraries
    .filter((library) => takesRemoteCopy("mixed", library))
    .sort((left, right) => left.order - right.order)[0];
  return mixed?.id ?? forKind();
}
