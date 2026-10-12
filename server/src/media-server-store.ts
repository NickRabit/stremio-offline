import type { State, Store } from "./store.js";
import {
  MediaServerError,
  MEDIA_CONNECTION_ID,
  MEDIA_SERVER_KINDS,
  MEDIA_SERVER_LIMITS,
  MEDIA_SECRET_REF,
  REMOTE_LIBRARY_ID,
  newConnectionId,
  newRemoteLibraryId,
  type MediaConnectionRecord,
  type RemoteLibraryRecord,
  type RemoteLibraryType,
} from "./media-server-types.js";
import { normalizeMediaServerUrl } from "./media-server-security.js";
import type { MediaServerSecrets } from "./media-server-secrets.js";

/** What `addConnection` accepts: no id, generation or timestamp, and no secret reference --
 *  that is assigned later, once the token has been verified against the vault. */
export type MediaConnectionInput = Omit<MediaConnectionRecord, "id" | "generation" | "addedAt" | "secretRef">;
/** What `attachLibrary` accepts: the connection and handle come from the call, and grants
 *  always start empty. */
export type RemoteLibraryInput = Omit<RemoteLibraryRecord, "id" | "connectionId" | "allowedUsers">;

export interface ExportedMediaConnection {
  id: string;
  provider: MediaConnectionRecord["provider"];
  name: string;
  baseUrl: string;
  allowLan: boolean;
  allowLoopback: boolean;
  serverId: string;
  accountId: string;
}

export interface ExportedRemoteLibrary {
  id: string;
  connectionId: string;
  remoteId: string;
  name: string;
  type: RemoteLibraryType;
  order: number;
  showOnHome: boolean;
  showInContinueWatching: boolean;
}

export interface MediaServerConfigurationExport {
  version: 1;
  connections: ExportedMediaConnection[];
  libraries: ExportedRemoteLibrary[];
}

const invalid = (message: string): MediaServerError => new MediaServerError("invalid-input", message);
const notFound = (message: string): MediaServerError => new MediaServerError("not-found", message);
const stale = (): MediaServerError => new MediaServerError("stale-generation", "The media-server connection changed; start again.");
const nextGeneration = (generation: number): number => {
  if (!Number.isSafeInteger(generation) || generation < 0 || generation >= Number.MAX_SAFE_INTEGER) {
    throw invalid("The media-server generation cannot be advanced.");
  }
  return generation + 1;
};

export const CONNECTION_KEYS = ["provider", "name", "baseUrl", "allowLan", "allowLoopback", "serverId", "accountId", "enabled"];
export const LIBRARY_KEYS = ["remoteId", "name", "type", "enabled", "order", "showOnHome", "showInContinueWatching"];
export const EXPORT_CONNECTION_KEYS = ["id", "provider", "name", "baseUrl", "allowLan", "allowLoopback", "serverId", "accountId"];
export const EXPORT_LIBRARY_KEYS = ["id", "connectionId", "remoteId", "name", "type", "order", "showOnHome", "showInContinueWatching"];
export const LIBRARY_TYPES: readonly RemoteLibraryType[] = ["movie", "series", "mixed"];

export function checkKeys(value: unknown, allowed: readonly string[], context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${context} is malformed.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalid(`${context} has an unknown field.`);
  }
  return value as Record<string, unknown>;
}

export const boundedString = (value: unknown, max: number, field: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw invalid(`The media-server ${field} is missing or too long.`);
  return value;
};

export const bool = (value: unknown, field: string): boolean => {
  if (typeof value !== "boolean") throw invalid(`The media-server ${field} must be a boolean.`);
  return value;
};

export const remoteType = (value: unknown): RemoteLibraryType => {
  if (typeof value !== "string" || !LIBRARY_TYPES.includes(value as RemoteLibraryType)) throw invalid("The media-server library type is not supported.");
  return value as RemoteLibraryType;
};

export const order = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid("The media-server library order is not a non-negative integer.");
  return value;
};

export function readConnectionFields(record: Record<string, unknown>) {
  if (!MEDIA_SERVER_KINDS.includes(record.provider as MediaConnectionRecord["provider"])) throw invalid("The media-server provider is not supported.");
  return {
    provider: record.provider as MediaConnectionRecord["provider"],
    name: boundedString(record.name, MEDIA_SERVER_LIMITS.name, "name"),
    baseUrl: normalizeMediaServerUrl(record.baseUrl as string),
    allowLan: bool(record.allowLan, "allowLan"),
    allowLoopback: bool(record.allowLoopback, "allowLoopback"),
    serverId: boundedString(record.serverId, MEDIA_SERVER_LIMITS.upstreamId, "server id"),
    accountId: boundedString(record.accountId, MEDIA_SERVER_LIMITS.upstreamId, "account id"),
  };
}

export function readLibraryFields(record: Record<string, unknown>) {
  return {
    remoteId: boundedString(record.remoteId, MEDIA_SERVER_LIMITS.upstreamId, "library id"),
    name: boundedString(record.name, MEDIA_SERVER_LIMITS.name, "library name"),
    type: remoteType(record.type),
    order: order(record.order),
    showOnHome: bool(record.showOnHome, "showOnHome"),
    showInContinueWatching: bool(record.showInContinueWatching, "showInContinueWatching"),
  };
}

/** A JSON tuple, not a NUL join: upstream ids may themselves contain a control byte, so a
 *  joined string could map two different identities to one key. */
export const verifiedKey = (provider: string, serverId: string, accountId: string): string =>
  JSON.stringify([provider, serverId, accountId]);

/** A synchronous guard run at the top of every mutating update, so an authority that has
 *  gone stale during an awaited network call cannot land a write. Internal legacy callers
 *  pass nothing and keep their old behaviour. */
export interface MediaServerConfigurationOptions {
  beforeWrite?: (state: State) => void;
}

/** The validated internal configuration surface. Every method reads and writes through the
 *  store's serialized `update`, so a duplicate or a dangling reference is refused atomically
 *  and a failed call leaves nothing behind. */
export class MediaServerConfiguration {
  constructor(private readonly store: Store, private readonly options: MediaServerConfigurationOptions = {}) {}

  private guard(state: State): void {
    this.options.beforeWrite?.(state);
  }

  async addConnection(input: MediaConnectionInput): Promise<MediaConnectionRecord> {
    const record = checkKeys(input, CONNECTION_KEYS, "The media-server connection");
    const fields = readConnectionFields(record);
    const enabled = bool(record.enabled, "enabled");
    const id = newConnectionId();
    let created: MediaConnectionRecord | undefined;
    await this.store.update((state) => {
      this.guard(state);
      const list = state.mediaConnections ?? [];
      if (list.length >= MEDIA_SERVER_LIMITS.connections) throw invalid("Too many media-server connections.");
      if (list.some((connection) => verifiedKey(connection.provider, connection.serverId, connection.accountId) === verifiedKey(fields.provider, fields.serverId, fields.accountId))) {
        throw invalid("That remote account is already connected.");
      }
      created = { id, ...fields, enabled, generation: 0, addedAt: new Date().toISOString() };
      state.mediaConnections = [...list, created];
    });
    return structuredClone(created as MediaConnectionRecord);
  }

  async attachLibrary(connectionId: string, input: RemoteLibraryInput): Promise<RemoteLibraryRecord> {
    if (typeof connectionId !== "string" || !MEDIA_CONNECTION_ID.test(connectionId)) throw invalid("The media-server connection id is malformed.");
    const record = checkKeys(input, LIBRARY_KEYS, "The remote library");
    const fields = readLibraryFields(record);
    const enabled = bool(record.enabled, "enabled");
    const id = newRemoteLibraryId();
    let created: RemoteLibraryRecord | undefined;
    await this.store.update((state) => {
      this.guard(state);
      const connection = (state.mediaConnections ?? []).find((candidate) => candidate.id === connectionId);
      if (!connection) throw notFound("That media-server connection does not exist.");
      if (!connection.enabled) throw invalid("That media-server connection is disabled.");
      if (!connection.serverId || !connection.accountId) throw invalid("That media-server connection is not verified.");
      const libraries = state.remoteLibraries ?? [];
      if (libraries.length >= MEDIA_SERVER_LIMITS.libraries) throw invalid("Too many remote libraries.");
      if (libraries.some((library) => library.connectionId === connectionId && library.remoteId === fields.remoteId)) {
        throw invalid("That remote library is already attached.");
      }
      created = { id, connectionId, ...fields, enabled, allowedUsers: [] };
      state.remoteLibraries = [...libraries, created];
    });
    return structuredClone(created as RemoteLibraryRecord);
  }

  async setEnabled(connectionId: string, enabled: boolean): Promise<void> {
    if (typeof connectionId !== "string" || !MEDIA_CONNECTION_ID.test(connectionId)) throw invalid("The media-server connection id is malformed.");
    if (typeof enabled !== "boolean") throw invalid("The media-server enabled flag must be a boolean.");
    await this.store.update((state) => {
      this.guard(state);
      const connection = (state.mediaConnections ?? []).find((candidate) => candidate.id === connectionId);
      if (!connection) throw notFound("That media-server connection does not exist.");
      if (connection.enabled === enabled) return;
      connection.enabled = enabled;
      connection.generation = nextGeneration(connection.generation);
    });
  }

  /** Removes the connection and its libraries. It does NOT touch the vault: the returned
   *  references are the caller's to delete, and durable retry of that cleanup belongs to MS-2. */
  async removeConnection(connectionId: string): Promise<{ secretRefsToRemove: string[] }> {
    if (typeof connectionId !== "string" || !MEDIA_CONNECTION_ID.test(connectionId)) throw invalid("The media-server connection id is malformed.");
    let secretRefsToRemove: string[] = [];
    await this.store.update((state) => {
      this.guard(state);
      const connection = (state.mediaConnections ?? []).find((candidate) => candidate.id === connectionId);
      if (!connection) throw notFound("That media-server connection does not exist.");
      secretRefsToRemove = connection.secretRef ? [connection.secretRef] : [];
      state.mediaConnections = (state.mediaConnections ?? []).filter((candidate) => candidate.id !== connectionId);
      state.remoteLibraries = (state.remoteLibraries ?? []).filter((library) => library.connectionId !== connectionId);
    });
    return { secretRefsToRemove };
  }

  /** Binds a vault reference to a connection. The token is decrypted with the binding from the
   *  stored record before the write, and the connection's identity and generation are rechecked
   *  inside the queued update, so a revocation or credential change during the awaited decrypt
   *  fails with `stale-generation` instead of binding a stale secret. Returns the references
   *  the caller now owns for deletion -- the previous ref only, never the one just bound. */
  async setSecretReference(
    connectionId: string,
    expectedGeneration: number,
    ref: string,
    vault: Pick<MediaServerSecrets, "get">,
  ): Promise<{ secretRefsToRemove: string[] }> {
    if (typeof connectionId !== "string" || !MEDIA_CONNECTION_ID.test(connectionId)) throw invalid("The media-server connection id is malformed.");
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw invalid("The media-server generation is malformed.");
    if (typeof ref !== "string" || !MEDIA_SECRET_REF.test(ref)) throw invalid("The media-server secret reference is malformed.");
    const snapshot = this.store.mediaConnections().find((candidate) => candidate.id === connectionId);
    if (!snapshot) throw notFound("That media-server connection does not exist.");
    if (snapshot.generation !== expectedGeneration) throw stale();
    await vault.get({ connectionId, provider: snapshot.provider, serverId: snapshot.serverId, accountId: snapshot.accountId }, ref);
    let secretRefsToRemove: string[] = [];
    await this.store.update((state) => {
      this.guard(state);
      const connection = (state.mediaConnections ?? []).find((candidate) => candidate.id === connectionId);
      if (!connection) throw notFound("That media-server connection does not exist.");
      if (connection.generation !== expectedGeneration
        || connection.provider !== snapshot.provider
        || connection.serverId !== snapshot.serverId
        || connection.accountId !== snapshot.accountId) throw stale();
      const previous = connection.secretRef;
      connection.secretRef = ref;
      connection.generation = nextGeneration(connection.generation);
      secretRefsToRemove = previous !== undefined && previous !== ref ? [previous] : [];
    });
    return { secretRefsToRemove };
  }

  /** Metadata only: no reference, generation, grant or timestamp leaves the process here. */
  exportConfiguration(): MediaServerConfigurationExport {
    return {
      version: 1,
      connections: this.store.mediaConnections().map((connection) => ({
        id: connection.id,
        provider: connection.provider,
        name: connection.name,
        baseUrl: connection.baseUrl,
        allowLan: connection.allowLan,
        allowLoopback: connection.allowLoopback,
        serverId: connection.serverId,
        accountId: connection.accountId,
      })),
      libraries: this.store.remoteLibraries().map((library) => ({
        id: library.id,
        connectionId: library.connectionId,
        remoteId: library.remoteId,
        name: library.name,
        type: library.type,
        order: library.order,
        showOnHome: library.showOnHome,
        showInContinueWatching: library.showInContinueWatching,
      })),
    };
  }

  /** Additive restore: every exported handle is only a reference. Fresh local handles are
   *  minted, connections and libraries land disabled with no grants and no secret, and a
   *  duplicate verified account or a dangling reference refuses the whole batch. */
  async restoreConfiguration(input: unknown): Promise<void> {
    const root = checkKeys(input, ["version", "connections", "libraries"], "The media-server configuration");
    if (root.version !== 1) throw invalid("The media-server configuration version is not supported.");
    if (!Array.isArray(root.connections) || !Array.isArray(root.libraries)) throw invalid("The media-server configuration is malformed.");
    if (root.connections.length > MEDIA_SERVER_LIMITS.connections || root.libraries.length > MEDIA_SERVER_LIMITS.libraries) {
      throw invalid("The media-server configuration is too large.");
    }
    const idMap = new Map<string, string>();
    const seenConnectionIds = new Set<string>();
    const seenVerified = new Set<string>();
    const connections: MediaConnectionRecord[] = [];
    for (const raw of root.connections) {
      const record = checkKeys(raw, EXPORT_CONNECTION_KEYS, "The exported connection");
      const oldId = boundedString(record.id, MEDIA_SERVER_LIMITS.upstreamId, "connection id");
      if (!MEDIA_CONNECTION_ID.test(oldId)) throw invalid("The exported connection id is malformed.");
      if (seenConnectionIds.has(oldId)) throw invalid("The exported configuration repeats a connection id.");
      seenConnectionIds.add(oldId);
      const fields = readConnectionFields(record);
      const key = verifiedKey(fields.provider, fields.serverId, fields.accountId);
      if (seenVerified.has(key)) throw invalid("The exported configuration repeats a remote account.");
      seenVerified.add(key);
      const id = newConnectionId();
      idMap.set(oldId, id);
      connections.push({ id, ...fields, enabled: false, generation: 0, addedAt: new Date().toISOString() });
    }
    const libraries: RemoteLibraryRecord[] = [];
    const seenLibraryIds = new Set<string>();
    const seenRemote = new Set<string>();
    for (const raw of root.libraries) {
      const record = checkKeys(raw, EXPORT_LIBRARY_KEYS, "The exported library");
      const oldId = boundedString(record.id, MEDIA_SERVER_LIMITS.upstreamId, "library id");
      if (!REMOTE_LIBRARY_ID.test(oldId)) throw invalid("The exported library id is malformed.");
      if (seenLibraryIds.has(oldId)) throw invalid("The exported configuration repeats a library id.");
      seenLibraryIds.add(oldId);
      const oldConnectionId = boundedString(record.connectionId, MEDIA_SERVER_LIMITS.upstreamId, "connection id");
      const connectionId = idMap.get(oldConnectionId);
      if (!connectionId) throw invalid("The exported configuration has a dangling library connection.");
      const fields = readLibraryFields(record);
      const key = JSON.stringify([connectionId, fields.remoteId]);
      if (seenRemote.has(key)) throw invalid("The exported configuration repeats a remote library.");
      seenRemote.add(key);
      libraries.push({ id: newRemoteLibraryId(), connectionId, ...fields, enabled: false, allowedUsers: [] });
    }
    await this.store.update((state) => {
      this.guard(state);
      const existing = state.mediaConnections ?? [];
      const existingLibraries = state.remoteLibraries ?? [];
      if (existing.length + connections.length > MEDIA_SERVER_LIMITS.connections) throw invalid("Too many media-server connections.");
      if (existingLibraries.length + libraries.length > MEDIA_SERVER_LIMITS.libraries) throw invalid("Too many remote libraries.");
      for (const incoming of connections) {
        if (existing.some((connection) => verifiedKey(connection.provider, connection.serverId, connection.accountId) === verifiedKey(incoming.provider, incoming.serverId, incoming.accountId))) {
          throw invalid("That remote account is already connected.");
        }
      }
      state.mediaConnections = [...existing, ...connections];
      state.remoteLibraries = [...existingLibraries, ...libraries];
    });
  }
}
