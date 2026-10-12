import { MEDIA_SERVER_LIMITS, remoteProgressKey, type MediaConnectionRecord } from "./media-server-types.js";
import type { RemoteLibraryRecord } from "./media-server-types.js";
import type { UserData, UserRecord } from "./users.js";

/** The state one history pass reads. Structural, so a caller can look at the records without
 *  having to hand the whole store over. */
export interface RemoteHistoryState {
  users?: UserRecord[];
  userData?: Record<string, UserData>;
  mediaConnections?: MediaConnectionRecord[];
  remoteLibraries?: RemoteLibraryRecord[];
}

/** How long a piece of remote history is kept after the attachment that held it was removed.
 *  Counted from the removal, never from the last time the row was touched: a playback, a
 *  favourite or an outage does not extend it. */
export const REMOTE_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The identity one removal took away. `remoteLibraryId` narrows the scope to one upstream
 *  library; without it every library of that exact identity is covered. A different account
 *  on the same server is a different identity and never matches. */
export interface RemovedRemoteScope {
  provider: string;
  serverId: string;
  accountId: string;
  remoteLibraryId?: string;
}

/** The local records the same write is taking away, so they are not read as an attachment
 *  that still holds the history it is covering. */
export interface RemovedRemoteAttachments {
  connectionIds?: readonly string[];
  libraryIds?: readonly string[];
}

/** The identity one connection record stands for, as a removal scope over its libraries. */
export const connectionScope = (connection: MediaConnectionRecord): RemovedRemoteScope => ({
  provider: connection.provider,
  serverId: connection.serverId,
  accountId: connection.accountId,
});

/** The identity facts of one stored row. Only the fields a scope is matched on are read: the
 *  progress a row carries is the personal module's business, never this one's. */
interface StoredRemoteRow {
  key: string;
  provider: string;
  serverId: string;
  accountId: string;
  itemId: string;
  remoteLibraryId: string;
  orphanedAt?: string;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= MEDIA_SERVER_LIMITS.upstreamId ? value : undefined;

/** A row that names itself: the map key, the stored key and the canonical key of the identity
 *  the row carries all agree. A malformed row is never marked, recovered or purged, so it can
 *  never stand in for another identity. */
const canonicalRow = (mapKey: string, value: unknown): StoredRemoteRow | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const provider = record.provider;
  if (provider !== "jellyfin" && provider !== "emby") return undefined;
  const key = text(record.key);
  const serverId = text(record.serverId);
  const accountId = text(record.accountId);
  const itemId = text(record.itemId);
  const remoteLibraryId = text(record.remoteLibraryId);
  if (!key || !serverId || !accountId || !itemId || !remoteLibraryId || key !== mapKey) return undefined;
  if (key !== remoteProgressKey({ provider, serverId, accountId, itemId })) return undefined;
  const raw = record.orphanedAt;
  const orphanedAt = typeof raw === "string" && !Number.isNaN(Date.parse(raw)) ? raw : undefined;
  return { key, provider, serverId, accountId, itemId, remoteLibraryId, ...(orphanedAt === undefined ? {} : { orphanedAt }) };
};

/** Visits every canonical row of every account's map. A visitor that answers false stops the
 *  walk, so a read-only question can stop at its first answer. */
const forEachRow = (state: RemoteHistoryState, visit: (row: StoredRemoteRow, map: Record<string, unknown>, key: string) => boolean | void): void => {
  for (const data of Object.values((state.userData ?? {}) as Record<string, UserData>)) {
    const map = data?.remoteMedia;
    if (!map || typeof map !== "object") continue;
    for (const key of Object.keys(map)) {
      const row = canonicalRow(key, map[key]);
      if (row && visit(row, map, key) === false) return;
    }
  }
};

/** Whether a local attachment still holds this upstream library. A disabled record still
 *  holds its history; only a record this write is taking away, or none at all, releases it. */
const stillAttached = (state: RemoteHistoryState, row: StoredRemoteRow, gone: RemovedRemoteAttachments): boolean => {
  const connections = state.mediaConnections ?? [];
  return (state.remoteLibraries ?? []).some((library) => {
    if (library.remoteId !== row.remoteLibraryId) return false;
    if (gone.libraryIds?.includes(library.id) || gone.connectionIds?.includes(library.connectionId)) return false;
    const connection = connections.find((candidate) => candidate.id === library.connectionId);
    return connection !== undefined && connection.provider === row.provider
      && connection.serverId === row.serverId && connection.accountId === row.accountId;
  });
};

const inScope = (row: StoredRemoteRow, scope: RemovedRemoteScope): boolean =>
  row.provider === scope.provider && row.serverId === scope.serverId && row.accountId === scope.accountId
  && (scope.remoteLibraryId === undefined || row.remoteLibraryId === scope.remoteLibraryId);

/** Marks the history of one removed scope as orphaned, once. A row whose countdown is already
 *  running keeps its stamp, so removing the same thing twice never extends the 30 days, and a
 *  row another attachment still holds is left as it was. */
export function markRemovedHistory(state: RemoteHistoryState, scope: RemovedRemoteScope, now: number, gone: RemovedRemoteAttachments = {}): void {
  const stamp = new Date(now).toISOString();
  forEachRow(state, (row, map, key) => {
    if (!inScope(row, scope) || row.orphanedAt !== undefined) return;
    if (stillAttached(state, row, gone)) return;
    map[key] = { ...(map[key] as Record<string, unknown>), orphanedAt: stamp };
  });
}

/** Forgets the history of one removed scope at once: the rows are gone, whatever they carried.
 *  Nothing upstream is contacted and no other account's rows are read. */
export function forgetRemovedHistory(state: RemoteHistoryState, scope: RemovedRemoteScope): void {
  forEachRow(state, (row, map, key) => {
    if (inScope(row, scope)) delete map[key];
  });
}

/** Drops every orphaned row whose 30 days have run out. Answers whether anything changed, so a
 *  sweep that found nothing leaves the state -- and the disk -- alone. */
export function purgeExpiredHistory(state: RemoteHistoryState, now: number): boolean {
  let changed = false;
  forEachRow(state, (row, map, key) => {
    if (row.orphanedAt === undefined) return;
    if (Date.parse(row.orphanedAt) > now - REMOTE_HISTORY_RETENTION_MS) return;
    delete map[key];
    changed = true;
  });
  return changed;
}

/** Starts the countdown for every row an attachment no longer holds. A row that already has
 *  one keeps it, so a sweep never restarts a retention. */
export function markDetachedHistory(state: RemoteHistoryState, now: number): boolean {
  const stamp = new Date(now).toISOString();
  let changed = false;
  forEachRow(state, (row, map, key) => {
    if (row.orphanedAt !== undefined || stillAttached(state, row, {})) return;
    map[key] = { ...(map[key] as Record<string, unknown>), orphanedAt: stamp };
    changed = true;
  });
  return changed;
}

/** Whether one maintenance pass would change anything. Read-only, so a sweep that has nothing
 *  to do never rewrites the state. */
export function historySweepPending(state: RemoteHistoryState, now: number): boolean {
  let pending = false;
  forEachRow(state, (row) => {
    if (row.orphanedAt === undefined) {
      if (stillAttached(state, row, {})) return;
    } else if (Date.parse(row.orphanedAt) > now - REMOTE_HISTORY_RETENTION_MS) return;
    pending = true;
    return false;
  });
  return pending;
}

/** One pass over every account's stored history: expired orphans go and detached rows that
 *  carry no countdown get one. Answers whether the state changed. */
export function sweepRemoteHistory(state: RemoteHistoryState, now: number): boolean {
  const purged = purgeExpiredHistory(state, now);
  const marked = markDetachedHistory(state, now);
  return purged || marked;
}

/** A reattached upstream library holds its history again: rows of the very same identity and
 *  remote library lose the countdown a removal started. */
export function retainHistoryOnAttach(state: RemoteHistoryState, identity: Omit<RemovedRemoteScope, "remoteLibraryId">, remoteLibraryId: string): void {
  forEachRow(state, (row, map, key) => {
    if (row.provider !== identity.provider || row.serverId !== identity.serverId || row.accountId !== identity.accountId) return;
    if (row.remoteLibraryId !== remoteLibraryId || row.orphanedAt === undefined) return;
    const { orphanedAt: _dropped, ...rest } = map[key] as Record<string, unknown>;
    map[key] = rest;
  });
}
