import { isRemoteContentRef, remoteSecretStamp, type RemoteContentRef } from "./media-server-reference.js";
import type { MediaConnectionRecord, RemoteLibraryRecord } from "./media-server-types.js";
import type { UserRecord } from "./users.js";

/** The state a remote-access decision reads. Structural, so this module stays free of the
 *  store and of the manager. */
export interface RemoteAccessSource {
  users(): UserRecord[];
  mediaConnections(): MediaConnectionRecord[];
  remoteLibraries(): RemoteLibraryRecord[];
}

/** Whether one account may see one attached remote library, as the state stands now. A
 *  disabled resource, a connection whose identity is not verified, or a grant list that
 *  does not name the account all answer no; an empty list is administrator-only. */
export const remoteLibraryVisibleTo = (
  connections: readonly MediaConnectionRecord[],
  library: RemoteLibraryRecord,
  user: Pick<UserRecord, "id" | "role">,
): boolean => {
  const connection = connections.find((candidate) => candidate.id === library.connectionId);
  if (!connection || !connection.enabled || !library.enabled) return false;
  if (!connection.serverId || !connection.accountId || !connection.secretRef) return false;
  if (user.role === "admin") return true;
  return library.allowedUsers.includes(user.id);
};

/** Whether one sealed reference is still answerable: the session that asked is live and the
 *  account secret is unchanged, and the library, connection and generation behind it are the
 *  configured ones now. This reads local records only; the live remote policy is checked
 *  separately by the manager, after an awaited call. */
export function remoteContentAccessible(source: RemoteAccessSource, ref: RemoteContentRef, now = Date.now()): boolean {
  if (!isRemoteContentRef(ref)) return false;
  const user = source.users().find((candidate) => candidate.id === ref.owner.userId);
  if (!user || user.disabled || user.mustChangePassword) return false;
  if (user.revoked?.[ref.owner.sid]) return false;
  if (ref.owner.secretStamp !== remoteSecretStamp(user.secret)) return false;
  if (!(ref.owner.expiresAt > now)) return false;
  const connections = source.mediaConnections();
  const library = source.remoteLibraries().find((candidate) => candidate.id === ref.libraryId);
  if (!library || library.connectionId !== ref.connectionId) return false;
  if (!remoteLibraryVisibleTo(connections, library, { id: user.id, role: user.role })) return false;
  const connection = connections.find((candidate) => candidate.id === ref.connectionId);
  if (!connection || !connection.enabled || !connection.secretRef) return false;
  return connection.provider === ref.provider
    && connection.serverId === ref.serverId
    && connection.accountId === ref.accountId
    && connection.generation === ref.generation;
}
