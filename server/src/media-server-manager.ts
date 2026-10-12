import { AppError } from "./errors.js";
import { log } from "./logger.js";
import { remoteLibraryVisibleTo } from "./media-server-access.js";
import { ResourceError } from "./media-resources.js";
import { isRemoteContentRef, remoteSecretStamp, type RemoteContentRef } from "./media-server-reference.js";
import {
  connectionScope,
  forgetRemovedHistory,
  historySweepPending,
  markDetachedHistory,
  markRemovedHistory,
  purgeExpiredHistory,
  retainHistoryOnAttach,
  sweepRemoteHistory,
} from "./media-server-retention.js";
import { remoteIdsMatch, remoteMatchCandidates, remoteMatchTarget, type RemoteMatchTarget } from "./media-server-match.js";
import { MediaServerIndex, type MediaServerSnapshotKey, type SnapshotScan } from "./media-server-index.js";
import {
  createMediaServerProvider,
  type MediaServerProvider,
  type ProviderItem,
  type ProviderItemType,
  type ProviderLibrary,
  type ProviderVersion,
} from "./media-server-provider.js";
import { createMediaServerTransport, normalizeMediaServerUrl, type MediaServerAsset, type MediaServerTransport, type MediaServerTransportConfig } from "./media-server-security.js";
import type { MediaServerSecrets } from "./media-server-secrets.js";
import {
  MEDIA_SERVER_CONFIGURATION_MAX_BYTES,
  MediaServerConfiguration,
  bool,
  boundedString,
  checkKeys,
  order as libraryOrder,
  prepareMediaServerConfiguration,
  verifiedKey,
  type MediaServerConfigurationExport,
} from "./media-server-store.js";
import {
  MediaServerError,
  MEDIA_CONNECTION_ID,
  MEDIA_SECRET_REF,
  MEDIA_SERVER_KINDS,
  MEDIA_SERVER_LIMITS,
  READ_ONLY_MEDIA_CAPABILITIES,
  REMOTE_LIBRARY_ID,
  adminMediaConnection,
  adminRemoteLibrary,
  newConnectionId,
  newRemoteLibraryId,
  publicRemoteItem,
  publicRemoteLibrary,
  type AdminMediaConnection,
  type MediaConnectionRecord,
  type MediaServerKind,
  type PublicRemoteItem,
  type PublicRemoteLibrary,
  type RemoteCapabilities,
  type RemoteIdentity,
  type RemoteLibraryRecord,
} from "./media-server-types.js";
import { ForbiddenError, assertStillAdmin } from "./roles.js";
import type { State, Store } from "./store.js";
import { bumpPermissions, dormantGrants, findUserById, usersToBump, type UserRecord } from "./users.js";

/** The verified identity behind a request. `assertCurrent` is the route's own access gate
 *  (`requireAccess`), captured before the first await and re-run on every authority check. */
export interface MediaServerAuthority {
  actor: Pick<UserRecord, "id" | "secret">;
  assertCurrent(): void;
}

export type MediaServerConnectionStatus = "disabled" | "available" | "unavailable" | "reauthentication-required" | "identity-changed";

export type AdminConnectionView = AdminMediaConnection & { status: MediaServerConnectionStatus };
export type AdminLibraryView = ReturnType<typeof adminRemoteLibrary>;

export interface MediaServerBrowsePage {
  items: PublicRemoteItem[];
  total: number;
  asOf: string;
  stale: false;
  capabilities: RemoteCapabilities;
  cursor?: string;
}

export interface MediaServerDetail {
  item: PublicRemoteItem;
  capabilities: RemoteCapabilities;
}

/** One playable item with every ordinary file version behind it, plus the verified identity
 *  and the local handles a caller seals into references. Carries no URL, path or token. */
export interface MediaServerItemVersions {
  item: ProviderItem;
  versions: ProviderVersion[];
  identity: RemoteIdentity;
  connectionId: string;
  libraryId: string;
  generation: number;
  libraryName: string;
}

/** What a content mutation took away. A scope with no fields means everything. */
export interface MediaServerInvalidationScope {
  connectionId?: string;
  libraryId?: string;
  userId?: string;
}

export interface MediaServerManagerSeams {
  transportFactory?: (config: MediaServerTransportConfig) => MediaServerTransport;
  providerFactory?: (kind: MediaServerKind, transport: MediaServerTransport) => MediaServerProvider;
  clock?: () => number;
  index?: MediaServerIndex;
  cleanupIntervalMs?: number;
  networkMax?: number;
}

const USERNAME_MAX = 256;
const PASSWORD_MAX = 1024;
const RUNTIME_MAX = 128;
const CLEANUP_INTERVAL_MS = 60_000;
const SCAN_PAGE_LIMIT = 200;
const SCAN_PAGE_MAX = 50;
const SCAN_ITEM_MAX = 10_000;
const SCAN_BYTES_MAX = 5 * 1024 * 1024;
const MATCH_CANDIDATE_MAX = 40;
const MATCH_STREAM_MAX = 200;
const EXPORT_MAX_BYTES = MEDIA_SERVER_CONFIGURATION_MAX_BYTES;
const CURSOR_MAX = 8192;
const CURSOR_JSON_MAX = 6144;
const SEARCH_MAX = 256;
const OFFSET_MAX = 1_000_000_000;
const ITEM_TYPES: readonly ProviderItemType[] = ["movie", "series", "season", "episode"];
const CREATE_KEYS = ["provider", "name", "baseUrl", "allowLan", "allowLoopback", "username", "password"];
const ATTACH_KEYS = ["remoteId", "name", "order", "showOnHome", "showInContinueWatching"];
const LIBRARY_PATCH_KEYS = ["name", "enabled", "order", "showOnHome", "showInContinueWatching", "allowedUsers"];
const CONNECTION_PATCH_KEYS = ["name", "enabled"];
const BROWSE_QUERY_KEYS = ["limit", "cursor", "search", "type"];
const EPISODE_QUERY_KEYS = ["limit", "cursor"];

const invalid = (message: string): MediaServerError => new MediaServerError("invalid-input", message);
const notFound = (message: string): MediaServerError => new MediaServerError("not-found", message);
const busy = (message: string): MediaServerError => new MediaServerError("busy", message);
const stale = (): MediaServerError => new MediaServerError("stale-generation", "The media-server configuration changed; start again.");

/** The one optional flag a removal takes. A misspelled key or a non-boolean value is refused
 *  rather than ignored, so a removal never runs with a setting the caller did not mean. */
const readForgetOption = (options: unknown): boolean => {
  if (options === undefined) return false;
  const record = checkKeys(options, ["forget"], "The media-server removal");
  if (record.forget === undefined) throw invalid("The media-server removal names nothing to change.");
  return bool(record.forget, "forget");
};

const identityChanged = (): MediaServerError => new MediaServerError("identity-changed", "The media-server identity is not the configured one.");
const closedError = (): MediaServerError => new MediaServerError("closed", "The media-server manager is closed.");
const cancelled = (): MediaServerError => new MediaServerError("cancelled", "The media-server request was cancelled.");

const bumpGeneration = (generation: number): number => {
  if (!Number.isSafeInteger(generation) || generation < 0 || generation >= Number.MAX_SAFE_INTEGER) throw invalid("The media-server generation cannot be advanced.");
  return generation + 1;
};

const requestItemId = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > MEDIA_SERVER_LIMITS.upstreamId) throw invalid("The media-server item id is missing or too long.");
  if (/[/\\?#%\u0000-\u001f\u007f]/.test(value) || value === "." || value === "..") throw invalid("The media-server item id is not allowed.");
  return value;
};

const readQuery = (query: unknown, keys: readonly string[]): Record<string, string | undefined> => {
  if (query === undefined || query === null) return {};
  if (typeof query !== "object" || Array.isArray(query)) throw invalid("The media-server query is malformed.");
  const record = query as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) throw invalid("The media-server query has an unknown field.");
  }
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    if (typeof value !== "string") throw invalid("The media-server query has a malformed field.");
    out[key] = value;
  }
  return out;
};

const parseLimit = (value: string | undefined): number => {
  if (value === undefined || value === "") return 100;
  if (!/^\d{1,3}$/.test(value)) throw invalid("The media-server limit is out of range.");
  const limit = Number(value);
  if (limit < 1 || limit > 200) throw invalid("The media-server limit is out of range.");
  return limit;
};

const parseSearch = (value: string | undefined): string | undefined => {
  if (value === undefined || value === "") return undefined;
  if (value.length > SEARCH_MAX) throw invalid("The media-server search term is too long.");
  return value;
};

const parseType = (value: string | undefined): ProviderItemType | undefined => {
  if (value === undefined || value === "") return undefined;
  if (!ITEM_TYPES.includes(value as ProviderItemType)) throw invalid("The media-server item type is not supported.");
  return value as ProviderItemType;
};

const parseCursor = (value: string | undefined): string | undefined => {
  if (value === undefined || value === "") return undefined;
  if (value.length > CURSOR_MAX) throw invalid("The media-server cursor is malformed.");
  return value;
};

interface BrowseCursor {
  v: 1;
  s: string;
  l: string;
  g: number;
  a: string;
  q: string;
  t: string;
  p: string;
  o: number;
}

const encodeCursor = (cursor: BrowseCursor): string => Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

/** Canonical decode: bounded base64url, bounded JSON, bounded fields and a re-encode check, so
 *  no two spellings share one cursor and nothing unbounded reaches a comparison. */
const decodeCursor = (value: unknown): BrowseCursor => {
  if (typeof value !== "string" || value.length === 0 || value.length > CURSOR_MAX) throw invalid("The media-server cursor is malformed.");
  const json = Buffer.from(value, "base64url");
  if (json.length === 0 || json.length > CURSOR_JSON_MAX) throw invalid("The media-server cursor is malformed.");
  let parsed: unknown;
  try { parsed = JSON.parse(json.toString("utf8")); }
  catch { throw invalid("The media-server cursor is malformed."); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid("The media-server cursor is malformed.");
  const { v, s, l, g, a, q, t, p, o } = parsed as Record<string, unknown>;
  const bounded = (entry: unknown, max: number, allowEmpty: boolean): boolean =>
    typeof entry === "string" && (allowEmpty || entry.length > 0) && entry.length <= max;
  if (v !== 1 || !bounded(s, MEDIA_SERVER_LIMITS.upstreamId, false) || !bounded(l, MEDIA_SERVER_LIMITS.upstreamId, false)
    || typeof g !== "number" || !Number.isSafeInteger(g) || g < 0 || !bounded(a, MEDIA_SERVER_LIMITS.upstreamId, false)
    || !bounded(q, SEARCH_MAX, true) || !bounded(t, 32, true) || !bounded(p, MEDIA_SERVER_LIMITS.upstreamId, true)
    || typeof o !== "number" || !Number.isSafeInteger(o) || o < 0 || o > OFFSET_MAX) {
    throw invalid("The media-server cursor is malformed.");
  }
  const cursor: BrowseCursor = { v: 1, s: s as string, l: l as string, g, a: a as string, q: q as string, t: t as string, p: p as string, o };
  if (encodeCursor(cursor) !== value) throw invalid("The media-server cursor is not canonical.");
  return cursor;
};

interface CachedRuntime {
  generation: number;
  secretRef: string | undefined;
  transport: MediaServerTransport;
  provider: MediaServerProvider;
}

/** One proved live session: the token, the provider behind it, its transport and the view
 *  list the account may reach. Held for the length of a single request so several reads
 *  share one identity proof. */
interface LiveSession {
  token: string;
  provider: MediaServerProvider;
  transport: MediaServerTransport;
  libraries: ProviderLibrary[];
}

interface StatusRecord {
  generation: number;
  secretRef: string | undefined;
  status: MediaServerConnectionStatus;
}

// Re-exported so existing callers keep importing it from the manager; the pure
// implementation lives beside the other remote-access helpers.
export { remoteLibraryVisibleTo };

/** The administration and authorized-browsing surface over the persisted records. Every
 *  request-facing method takes the caller's authority first, re-reads the acting account
 *  after each awaited step, and repeats the mandated checks inside the synchronous state
 *  mutator that lands the write, so a revocation during an awaited call cannot publish or
 *  write anything under an authority that has since gone away. */
export class MediaServerManager {
  private readonly runtimes = new Map<string, CachedRuntime>();
  private readonly statuses = new Map<string, StatusRecord>();
  private readonly configuration: MediaServerConfiguration;
  private readonly index: MediaServerIndex;
  private readonly clock: () => number;
  private readonly providerFactory: (kind: MediaServerKind, transport: MediaServerTransport) => MediaServerProvider;
  private readonly transportFactory: (config: MediaServerTransportConfig) => MediaServerTransport;
  private readonly networkMax: number;
  private readonly cleanupIntervalMs: number;
  private readonly lifetime = new AbortController();
  private readonly loginTransports = new Set<MediaServerTransport>();
  private credentialChain: Promise<unknown> = Promise.resolve();
  private maintenance: Promise<void> | undefined;
  private cleanupTimer: NodeJS.Timeout | undefined;
  private activeNetwork = 0;
  private mutationInFlight = false;
  private closed = false;
  private initialized = false;
  private contentInvalidator: ((scope: MediaServerInvalidationScope) => Promise<void>) | undefined;

  constructor(
    private readonly store: Store,
    private readonly vault: MediaServerSecrets,
    seams: MediaServerManagerSeams = {},
  ) {
    this.clock = seams.clock ?? (() => Date.now());
    this.index = seams.index ?? new MediaServerIndex({ clock: this.clock });
    this.providerFactory = seams.providerFactory ?? createMediaServerProvider;
    this.transportFactory = seams.transportFactory ?? ((config) => createMediaServerTransport(config));
    this.networkMax = seams.networkMax ?? 4;
    this.cleanupIntervalMs = seams.cleanupIntervalMs ?? CLEANUP_INTERVAL_MS;
    this.configuration = new MediaServerConfiguration(this.store);
  }

  /** Reconcile the vault against the stored references, then start the periodic drain. A
   *  missing key, an unsafe vault or a state that never carried media-server fields defers
   *  cleanup instead of stopping the app; nothing is generated and nothing is deleted off a
   *  state that was never loaded. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.vault.keyConfigured()) {
      log("WARN", "No media-server secret key is configured; media-server credentials are unavailable");
    } else {
      try { await this.serializedCredential(() => this.reconcileVault()); }
      catch (error) { log("WARN", "Media-server secret reconciliation was deferred", { reason: error instanceof MediaServerError ? error.code : "unavailable" }); }
    }
    this.cleanupTimer = setInterval(() => {
      void this.runMaintenance().catch(() => log("WARN", "Media-server maintenance was deferred"));
    }, this.cleanupIntervalMs);
    this.cleanupTimer.unref?.();
    await this.runMaintenance();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = undefined; }
    await this.index.close();
    const transports = [...this.runtimes.values()].map((runtime) => runtime.transport);
    this.runtimes.clear();
    this.statuses.clear();
    const logins = [...this.loginTransports];
    this.loginTransports.clear();
    await Promise.allSettled([...transports, ...logins].map((transport) => transport.close()));
  }

  /** Registers the one callback that tears down live remote content when a write takes it
   *  away. Only one owner may register; a second registration is a wiring mistake and fails
   *  loudly rather than silently replacing the first. */
  setContentInvalidator(callback: (scope: MediaServerInvalidationScope) => Promise<void>): void {
    if (this.contentInvalidator) throw new Error("A media-server content invalidator is already registered.");
    this.contentInvalidator = callback;
  }

  async listConnections(authority: MediaServerAuthority): Promise<{ connections: AdminConnectionView[]; keyConfigured: boolean }> {
    this.requireAdmin(authority);
    const connections = this.store.mediaConnections().map((connection) => this.adminConnectionView(connection));
    this.requireAdmin(authority);
    return { connections, keyConfigured: this.vault.keyConfigured() };
  }

  async createConnection(authority: MediaServerAuthority, input: unknown, signal?: AbortSignal): Promise<AdminConnectionView> {
    const request = this.requestSignal(signal);
    const actor = this.requireAdmin(authority, request);
    const record = checkKeys(input, CREATE_KEYS, "The media-server connection");
    const kind = record.provider;
    if (!MEDIA_SERVER_KINDS.includes(kind as MediaServerKind)) throw invalid("The media-server provider is not supported.");
    const name = boundedString(record.name, MEDIA_SERVER_LIMITS.name, "name");
    const baseUrl = normalizeMediaServerUrl(record.baseUrl as string);
    const allowLan = bool(record.allowLan, "allowLan");
    const allowLoopback = bool(record.allowLoopback, "allowLoopback");
    const username = boundedString(record.username, USERNAME_MAX, "username");
    const password = boundedString(record.password, PASSWORD_MAX, "password");
    return this.adminMutation(async () => {
      const id = newConnectionId();
      const transport = this.transportFactory({ baseUrl, allowLan, allowLoopback, deviceId: id });
      let cached = false;
      this.loginTransports.add(transport);
      try {
        const provider = this.providerFactory(kind as MediaServerKind, transport);
        const result = await this.net(request, () => provider.authenticate(username, password, request));
        this.checkLive(request);
        this.requireAdmin(authority, request);
        const binding = { connectionId: id, provider: kind as MediaServerKind, serverId: result.serverId, accountId: result.accountId };
        const ref = await this.serializedCredential(() => {
          this.assertWriteAuthority({ users: this.store.users() }, authority, request);
          return this.vault.put(binding, result.token);
        });
        let installed!: MediaConnectionRecord;
        try {
          await this.store.update((state) => {
            this.assertWriteAuthority(state, authority, request);
            const list = state.mediaConnections ?? [];
            if (list.length >= MEDIA_SERVER_LIMITS.connections) throw invalid("Too many media-server connections.");
            if (list.some((candidate) => verifiedKey(candidate.provider, candidate.serverId, candidate.accountId) === verifiedKey(binding.provider, binding.serverId, binding.accountId))) {
              throw invalid("That remote account is already connected.");
            }
            installed = {
              id, provider: binding.provider, name, baseUrl, allowLan, allowLoopback,
              serverId: binding.serverId, accountId: binding.accountId, enabled: true, generation: 0,
              secretRef: ref, addedAt: new Date().toISOString(),
            };
            state.mediaConnections = [...list, installed];
          });
        } catch (error) {
          await this.rollbackSecret(ref);
          throw error;
        }
        this.cacheRuntime(id, { generation: installed.generation, secretRef: installed.secretRef, transport, provider });
        cached = true;
        this.markAvailable(installed);
        log("INFO", "Media-server connection created", { actor: actor.username, connectionId: id, provider: installed.provider });
        return this.adminConnectionView(installed);
      } finally {
        this.loginTransports.delete(transport);
        if (!cached) await transport.close().catch(() => undefined);
      }
    });
  }

  async patchConnection(authority: MediaServerAuthority, id: unknown, patch: unknown, signal?: AbortSignal): Promise<AdminConnectionView> {
    const request = this.requestSignal(signal);
    const actor = this.requireAdmin(authority, request);
    const connectionId = this.requireConnectionId(id);
    const record = checkKeys(patch, CONNECTION_PATCH_KEYS, "The media-server connection change");
    const name = record.name === undefined ? undefined : boundedString(record.name, MEDIA_SERVER_LIMITS.name, "name");
    const enabled = record.enabled === undefined ? undefined : bool(record.enabled, "enabled");
    if (name === undefined && enabled === undefined) throw invalid("The media-server connection change names nothing to change.");
    return this.adminMutation(async () => {
      let updated!: MediaConnectionRecord;
      let generationChanged = false;
      await this.store.update((state) => {
        this.assertWriteAuthority(state, authority, request);
        const connection = (state.mediaConnections ?? []).find((candidate) => candidate.id === connectionId);
        if (!connection) throw notFound("That media-server connection does not exist.");
        if (name !== undefined) connection.name = name;
        if (enabled !== undefined && enabled !== connection.enabled) {
          if (enabled && !connection.secretRef) throw invalid("That media-server connection has no stored credential yet.");
          connection.enabled = enabled;
          connection.generation = bumpGeneration(connection.generation);
          generationChanged = true;
          const affected = this.granteeIds(state.users, (state.remoteLibraries ?? []).filter((library) => library.connectionId === connectionId));
          if (affected.length) state.users = bumpPermissions(state.users ?? [], affected);
        }
        updated = structuredClone(connection);
      });
      // A rename changes nothing derived, so it neither bumps the generation nor throws away
      // live work; a visibility change does both.
      if (generationChanged) {
        this.invalidateRuntime(connectionId);
        await this.invalidateContent({ connectionId });
      }
      log("INFO", "Media-server connection updated", { actor: actor.username, connectionId });
      return this.adminConnectionView(updated);
    });
  }

  /** Removes one connection and its attachments. The stored history is kept, invisibly and
   *  for thirty days, unless the caller asks to forget it, which deletes it at once in the
   *  same atomic write as the removal. */
  async removeConnection(authority: MediaServerAuthority, id: unknown, signal?: AbortSignal, options?: unknown): Promise<void> {
    const request = this.requestSignal(signal);
    const actor = this.requireAdmin(authority, request);
    const connectionId = this.requireConnectionId(id);
    const forget = readForgetOption(options);
    await this.adminMutation(async () => {
      await this.store.update((state) => {
        this.assertWriteAuthority(state, authority, request);
        const connection = (state.mediaConnections ?? []).find((candidate) => candidate.id === connectionId);
        if (!connection) throw notFound("That media-server connection does not exist.");
        const scope = connectionScope(connection);
        if (forget) forgetRemovedHistory(state, scope);
        else markRemovedHistory(state, scope, this.clock(), { connectionIds: [connectionId] });
        const removed = (state.remoteLibraries ?? []).filter((library) => library.connectionId === connectionId);
        const affected = this.granteeIds(state.users, removed);
        state.mediaConnections = (state.mediaConnections ?? []).filter((candidate) => candidate.id !== connectionId);
        state.remoteLibraries = (state.remoteLibraries ?? []).filter((library) => library.connectionId !== connectionId);
        state.mediaSecretCleanup = this.appendCleanup(state.mediaSecretCleanup, connection.secretRef ? [connection.secretRef] : []);
        if (affected.length) state.users = bumpPermissions(state.users ?? [], affected);
      });
      this.invalidateRuntime(connectionId);
      await this.invalidateContent({ connectionId });
      await this.drainCleanup();
      log("INFO", "Media-server connection removed", { actor: actor.username, connectionId });
    });
  }

  async reauthenticate(authority: MediaServerAuthority, id: unknown, credentials: unknown, signal?: AbortSignal): Promise<AdminConnectionView> {
    const request = this.requestSignal(signal);
    const actor = this.requireAdmin(authority, request);
    const connectionId = this.requireConnectionId(id);
    const record = checkKeys(credentials, ["username", "password"], "The media-server credentials");
    const username = boundedString(record.username, USERNAME_MAX, "username");
    const password = boundedString(record.password, PASSWORD_MAX, "password");
    return this.adminMutation(async () => {
      const connection = this.store.mediaConnections().find((candidate) => candidate.id === connectionId);
      if (!connection) throw notFound("That media-server connection does not exist.");
      const transport = this.transportFactory({ baseUrl: connection.baseUrl, allowLan: connection.allowLan, allowLoopback: connection.allowLoopback, deviceId: connection.id });
      let cached = false;
      this.loginTransports.add(transport);
      try {
        const provider = this.providerFactory(connection.provider, transport);
        const result = await this.net(request, () => provider.authenticate(username, password, request));
        this.checkLive(request);
        this.requireAdmin(authority, request);
        if (result.serverId !== connection.serverId || result.accountId !== connection.accountId) {
          this.markIdentityChanged(connection);
          throw identityChanged();
        }
        const binding = { connectionId, provider: connection.provider, serverId: connection.serverId, accountId: connection.accountId };
        const ref = await this.serializedCredential(() => {
          this.assertWriteAuthority({ users: this.store.users() }, authority, request);
          return this.vault.put(binding, result.token);
        });
        let updated!: MediaConnectionRecord;
        try {
          await this.store.update((state) => {
            this.assertWriteAuthority(state, authority, request);
            const current = (state.mediaConnections ?? []).find((candidate) => candidate.id === connectionId);
            if (!current || current.generation !== connection.generation || current.provider !== connection.provider
              || current.serverId !== connection.serverId || current.accountId !== connection.accountId
              || current.baseUrl !== connection.baseUrl || current.secretRef !== connection.secretRef) {
              throw stale();
            }
            const previous = current.secretRef;
            current.secretRef = ref;
            current.generation = bumpGeneration(current.generation);
            state.mediaSecretCleanup = this.appendCleanup(state.mediaSecretCleanup, previous && previous !== ref ? [previous] : []);
            updated = structuredClone(current);
          });
        } catch (error) {
          await this.rollbackSecret(ref);
          throw error;
        }
        this.invalidateRuntime(connectionId);
        await this.invalidateContent({ connectionId });
        await this.drainCleanup();
        this.cacheRuntime(connectionId, { generation: updated.generation, secretRef: updated.secretRef, transport, provider });
        cached = true;
        this.markAvailable(updated);
        log("INFO", "Media-server connection re-authenticated", { actor: actor.username, connectionId });
        return this.adminConnectionView(updated);
      } finally {
        this.loginTransports.delete(transport);
        if (!cached) await transport.close().catch(() => undefined);
      }
    });
  }

  async discoverLibraries(authority: MediaServerAuthority, id: unknown, signal?: AbortSignal): Promise<ProviderLibrary[]> {
    const request = this.requestSignal(signal);
    this.requireAdmin(authority, request);
    const connection = this.requireConnection(id);
    const session = await this.liveSession(authority, connection, {}, request);
    this.requireAdmin(authority, request);
    return session.libraries.map((library) => ({ ...library }));
  }

  async attachLibrary(authority: MediaServerAuthority, id: unknown, input: unknown, signal?: AbortSignal): Promise<AdminLibraryView> {
    const request = this.requestSignal(signal);
    const actor = this.requireAdmin(authority, request);
    const connection = this.requireConnection(id);
    const record = checkKeys(input, ATTACH_KEYS, "The remote library");
    const remoteId = boundedString(record.remoteId, MEDIA_SERVER_LIMITS.upstreamId, "library id");
    const name = record.name === undefined ? undefined : boundedString(record.name, MEDIA_SERVER_LIMITS.name, "library name");
    const order = record.order === undefined ? 0 : libraryOrder(record.order);
    const showOnHome = record.showOnHome === undefined ? true : bool(record.showOnHome, "showOnHome");
    const showInContinueWatching = record.showInContinueWatching === undefined ? true : bool(record.showInContinueWatching, "showInContinueWatching");
    return this.adminMutation(async () => {
      const session = await this.liveSession(authority, connection, { libraryRemoteId: remoteId }, request);
      const discovered = session.libraries.find((library) => library.id === remoteId);
      if (!discovered) throw notFound("That remote library is not visible to the account.");
      this.recheckConnection(authority, request, connection);
      let installed!: RemoteLibraryRecord;
      await this.store.update((state) => {
        this.assertWriteAuthority(state, authority, request);
        const current = (state.mediaConnections ?? []).find((candidate) => candidate.id === connection.id);
        if (!current || !this.sameConnection(current, connection)) throw stale();
        const libraries = state.remoteLibraries ?? [];
        if (libraries.length >= MEDIA_SERVER_LIMITS.libraries) throw invalid("Too many remote libraries.");
        if (libraries.some((library) => library.connectionId === connection.id && library.remoteId === remoteId)) throw invalid("That remote library is already attached.");
        // An attachment of the very same verified identity and upstream library takes its
        // history back: whatever removal started a countdown for it stops now.
        purgeExpiredHistory(state, this.clock());
        retainHistoryOnAttach(state, connectionScope(connection), remoteId);
        installed = {
          id: newRemoteLibraryId(), connectionId: connection.id, remoteId, name: name ?? discovered.name,
          type: discovered.type, enabled: true, order, allowedUsers: [], showOnHome, showInContinueWatching,
        };
        state.remoteLibraries = [...libraries, installed];
      });
      log("INFO", "Remote library attached", { actor: actor.username, connectionId: connection.id, remoteId });
      return adminRemoteLibrary(installed);
    });
  }

  async patchLibrary(authority: MediaServerAuthority, id: unknown, patch: unknown, signal?: AbortSignal): Promise<AdminLibraryView> {
    const request = this.requestSignal(signal);
    const actor = this.requireAdmin(authority, request);
    const libraryId = this.requireLibraryId(id);
    const record = checkKeys(patch, LIBRARY_PATCH_KEYS, "The remote library change");
    const name = record.name === undefined ? undefined : boundedString(record.name, MEDIA_SERVER_LIMITS.name, "library name");
    const enabled = record.enabled === undefined ? undefined : bool(record.enabled, "enabled");
    const order = record.order === undefined ? undefined : libraryOrder(record.order);
    const showOnHome = record.showOnHome === undefined ? undefined : bool(record.showOnHome, "showOnHome");
    const showInContinueWatching = record.showInContinueWatching === undefined ? undefined : bool(record.showInContinueWatching, "showInContinueWatching");
    const requestedUsers = record.allowedUsers === undefined ? undefined : this.readAllowedUsers(record.allowedUsers);
    return this.adminMutation(async () => {
      let updated!: RemoteLibraryRecord;
      let permissionChange = false;
      let enabledChanged = false;
      let removedUsers: string[] = [];
      await this.store.update((state) => {
        this.assertWriteAuthority(state, authority, request);
        const library = (state.remoteLibraries ?? []).find((candidate) => candidate.id === libraryId);
        if (!library) throw notFound("That remote library does not exist.");
        const connection = (state.mediaConnections ?? []).find((candidate) => candidate.id === library.connectionId);
        if (!connection) throw notFound("That media-server connection does not exist.");
        const next: RemoteLibraryRecord = { ...library };
        if (name !== undefined) next.name = name;
        if (enabled !== undefined) next.enabled = enabled;
        if (order !== undefined) next.order = order;
        if (showOnHome !== undefined) next.showOnHome = showOnHome;
        if (showInContinueWatching !== undefined) next.showInContinueWatching = showInContinueWatching;
        const before = library.allowedUsers;
        if (requestedUsers !== undefined) {
          const wanted = new Set<string>(dormantGrants(state.users ?? [], library.allowedUsers));
          for (const userId of requestedUsers) {
            const user = findUserById(state.users ?? [], userId);
            if (!user) throw new AppError("That account does not exist.", "err.unknownUser");
            if (user.role === "admin" && !wanted.has(userId)) throw new AppError("An administrator already sees every library.", "err.adminAlwaysSees");
            wanted.add(userId);
          }
          next.allowedUsers = [...wanted];
        }
        enabledChanged = next.enabled !== library.enabled;
        removedUsers = before.filter((id) => !next.allowedUsers.includes(id) && findUserById(state.users ?? [], id)?.role === "user");
        // A grant edit or a visibility switch is a permission change for the ordinary
        // accounts on either side of it; a rename or a reorder is not.
        permissionChange = JSON.stringify(next.allowedUsers) !== JSON.stringify(before) || next.enabled !== library.enabled;
        if (permissionChange) connection.generation = bumpGeneration(connection.generation);
        state.remoteLibraries = (state.remoteLibraries ?? []).map((candidate) => candidate.id === libraryId ? next : candidate);
        if (permissionChange) {
          const affected = this.granteeIds(state.users, [next]).concat(this.granteeIds(state.users, [library]));
          const bump = usersToBump(before, next.allowedUsers).filter((entry) => findUserById(state.users ?? [], entry)?.role === "user");
          const union = [...new Set([...bump, ...affected])];
          if (union.length) state.users = bumpPermissions(state.users ?? [], union);
        }
        updated = structuredClone(next);
      });
      if (permissionChange) this.invalidateRuntime(updated.connectionId);
      if (enabledChanged) await this.invalidateContent({ libraryId });
      for (const userId of removedUsers) await this.invalidateContent({ libraryId, userId });
      log("INFO", "Remote library updated", { actor: actor.username, libraryId });
      return adminRemoteLibrary(updated);
    });
  }

  /** Removes one attached library. Its stored history is kept, invisibly and for thirty days,
   *  unless the caller asks to forget it, which deletes it at once in the same atomic write. */
  async deleteLibrary(authority: MediaServerAuthority, id: unknown, signal?: AbortSignal, options?: unknown): Promise<void> {
    const request = this.requestSignal(signal);
    const actor = this.requireAdmin(authority, request);
    const libraryId = this.requireLibraryId(id);
    const forget = readForgetOption(options);
    await this.adminMutation(async () => {
      let connectionId = "";
      await this.store.update((state) => {
        this.assertWriteAuthority(state, authority, request);
        const library = (state.remoteLibraries ?? []).find((candidate) => candidate.id === libraryId);
        if (!library) throw notFound("That remote library does not exist.");
        connectionId = library.connectionId;
        const connection = (state.mediaConnections ?? []).find((candidate) => candidate.id === connectionId);
        // A record whose connection is already gone has no verified identity to scope its
        // history by; the removal itself still goes through, as it always did.
        if (connection) {
          const scope = { ...connectionScope(connection), remoteLibraryId: library.remoteId };
          if (forget) forgetRemovedHistory(state, scope);
          else markRemovedHistory(state, scope, this.clock(), { libraryIds: [libraryId] });
        }
        const affected = this.granteeIds(state.users, [library]);
        state.remoteLibraries = (state.remoteLibraries ?? []).filter((candidate) => candidate.id !== libraryId);
        if (affected.length) state.users = bumpPermissions(state.users ?? [], affected);
      });
      this.index.invalidateLibrary(libraryId);
      await this.invalidateContent({ libraryId });
      log("INFO", "Remote library removed", { actor: actor.username, libraryId, connectionId });
    });
  }

  exportConfiguration(authority: MediaServerAuthority): MediaServerConfigurationExport {
    this.requireAdmin(authority);
    return this.configuration.exportConfiguration();
  }

  async importConfiguration(authority: MediaServerAuthority, body: unknown, signal?: AbortSignal): Promise<{ connections: AdminConnectionView[]; libraries: AdminLibraryView[] }> {
    const request = this.requestSignal(signal);
    this.requireAdmin(authority, request);
    const size = Buffer.byteLength(JSON.stringify(body ?? null), "utf8");
    if (size > EXPORT_MAX_BYTES) throw new AppError("The media-server configuration is too large.", "err.invalidRequest", 413);
    await this.adminMutation(async () => {
      // The guard runs inside the restore's own mutating update, so a demotion during a slow
      // body upload cannot land a restored configuration.
      const replacedConnections = this.store.mediaConnections().map((connection) => connection.id);
      const guarded = new MediaServerConfiguration(this.store, { beforeWrite: (state) => this.assertWriteAuthority(state, authority, request) });
      await guarded.restoreConfiguration(body);
      this.requireAdmin(authority, request);
      // A restored configuration may have replaced any connection or library, so nothing live
      // can be assumed to still exist.
      for (const connectionId of replacedConnections) await this.invalidateContent({ connectionId });
    });
    return {
      connections: this.store.mediaConnections().map((connection) => this.adminConnectionView(connection)),
      libraries: this.store.remoteLibraries().map((library) => adminRemoteLibrary(library)),
    };
  }

  /** Replaces the stored remote configuration with one prepared from a settings backup,
   *  atomically with the settings and addon changes that backup carries. The metadata is
   *  prepared -- and so the whole configuration validated -- before the write; inside the one
   *  mutating update the caller's own mutator still proves the actor is an administrator, no
   *  credential or grant survives the replacement, the previous secret references go onto the
   *  durable cleanup queue and every ordinary account whose grant the replacement took away
   *  has its permission stamp moved. Nothing is read back or written before the update, and
   *  the actor is re-checked after the awaited cleanup. */
  async restoreSettingsConfiguration(
    authority: MediaServerAuthority,
    metadata: unknown,
    mutateSettings: (state: State) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const request = this.requestSignal(signal);
    this.requireAdmin(authority, request);
    const prepared = prepareMediaServerConfiguration(metadata);
    await this.adminMutation(async () => {
      const replaced: string[] = [];
      await this.store.update((state) => {
        this.assertWriteAuthority(state, authority, request);
        mutateSettings(state);
        this.assertWriteAuthority(state, authority, request);
        const previousConnections = state.mediaConnections ?? [];
        const previousLibraries = state.remoteLibraries ?? [];
        replaced.push(...previousConnections.map((connection) => connection.id));
        state.mediaConnections = prepared.connections;
        state.remoteLibraries = prepared.libraries;
        const now = this.clock();
        purgeExpiredHistory(state, now);
        for (const library of prepared.libraries) {
          const connection = prepared.connections.find((candidate) => candidate.id === library.connectionId)!;
          retainHistoryOnAttach(state, connectionScope(connection), library.remoteId);
        }
        markDetachedHistory(state, now);
        state.mediaSecretCleanup = this.appendCleanup(
          state.mediaSecretCleanup,
          previousConnections.map((connection) => connection.secretRef).filter((ref): ref is string => ref !== undefined),
        );
        const affected = this.granteeIds(state.users, previousLibraries);
        if (affected.length) state.users = bumpPermissions(state.users ?? [], affected);
      });
      for (const connectionId of replaced) {
        this.invalidateRuntime(connectionId);
        await this.invalidateContent({ connectionId });
      }
      await this.drainCleanup();
      this.requireAdmin(authority, request);
      log("INFO", "The media-server configuration was restored from a settings backup", { connections: prepared.connections.length, libraries: prepared.libraries.length });
    });
  }

  async visibleLibraries(authority: MediaServerAuthority, signal?: AbortSignal): Promise<PublicRemoteLibrary[]> {
    const request = this.requestSignal(signal);
    const user = this.currentActor(authority, request);
    const libraries = this.visibleFor(user);
    this.currentActor(authority, request);
    const connections = this.store.mediaConnections();
    return libraries.map((library) => publicRemoteLibrary(library, connections.find((candidate) => candidate.id === library.connectionId)?.provider));
  }

  /** Every attached remote library, disabled ones included, with the provider of its stored
   *  connection. Administrator-only and no upstream work: the attachment records are enough. */
  async listAdminLibraries(authority: MediaServerAuthority): Promise<Array<AdminLibraryView & { provider?: MediaServerKind }>> {
    this.requireAdmin(authority);
    const connections = this.store.mediaConnections();
    const libraries = this.store.remoteLibraries();
    this.requireAdmin(authority);
    return libraries.map((library) => ({ ...adminRemoteLibrary(library, connections.find((candidate) => candidate.id === library.connectionId)?.provider) }));
  }

  async browseItems(authority: MediaServerAuthority, libraryId: unknown, query: unknown, signal?: AbortSignal): Promise<MediaServerBrowsePage> {
    const request = this.requestSignal(signal);
    const user = this.currentActor(authority, request);
    const record = readQuery(query, BROWSE_QUERY_KEYS);
    const limit = parseLimit(record.limit);
    const search = parseSearch(record.search);
    const type = parseType(record.type);
    const rawCursor = parseCursor(record.cursor);
    const library = this.requireVisibleLibrary(user, libraryId);
    const connection = this.requireConnection(library.connectionId);
    let cursor: BrowseCursor | undefined;
    if (rawCursor !== undefined) {
      cursor = decodeCursor(rawCursor);
      if (cursor.l !== library.id || cursor.a !== user.id || cursor.g !== connection.generation
        || cursor.q !== (search ?? "") || cursor.t !== (type ?? "") || cursor.p !== "") throw stale();
    }
    const session = await this.liveSession(authority, connection, { libraryRemoteId: library.remoteId }, request);
    const snapshot = await this.index.resolve(this.snapshotKey(connection, library), {
      ...(cursor ? { cursorSnapshotId: cursor.s } : {}),
      scan: (scanSignal) => this.scanLibrary(authority, connection, library, session.token, session.provider, scanSignal, request),
    });
    this.recheckContent(authority, request, library.id, connection);
    const filtered = this.filterItems(snapshot.items, search, type);
    const offset = cursor?.o ?? 0;
    if (offset > filtered.length) throw invalid("The media-server cursor is out of range.");
    const slice = filtered.slice(offset, offset + limit);
    const page: MediaServerBrowsePage = {
      items: slice.map((item) => publicRemoteItem(structuredClone(item), library.id)),
      total: filtered.length,
      asOf: snapshot.asOf,
      stale: false,
      capabilities: READ_ONLY_MEDIA_CAPABILITIES,
    };
    if (offset + slice.length < filtered.length) {
      page.cursor = encodeCursor({ v: 1, s: snapshot.id, l: library.id, g: connection.generation, a: user.id, q: search ?? "", t: type ?? "", p: "", o: offset + slice.length });
    }
    return page;
  }

  async itemDetail(authority: MediaServerAuthority, libraryId: unknown, itemId: unknown, signal?: AbortSignal): Promise<MediaServerDetail> {
    const request = this.requestSignal(signal);
    const user = this.currentActor(authority, request);
    const library = this.requireVisibleLibrary(user, libraryId);
    const connection = this.requireConnection(library.connectionId);
    const requested = requestItemId(itemId);
    const session = await this.liveSession(authority, connection, { libraryRemoteId: library.remoteId }, request);
    const item = await this.upstream(connection, request, () => session.provider.detail(session.token, connection.accountId, requested, request));
    this.recheckContent(authority, request, library.id, connection);
    const ancestors = await this.upstream(connection, request, () => session.provider.ancestors(session.token, connection.accountId, item.id, request));
    if (!ancestors.includes(library.remoteId)) throw notFound("That item is not in this library.");
    this.recheckContent(authority, request, library.id, connection);
    return { item: publicRemoteItem(structuredClone(item), library.id), capabilities: READ_ONLY_MEDIA_CAPABILITIES };
  }

  async itemEpisodes(authority: MediaServerAuthority, libraryId: unknown, itemId: unknown, query: unknown, signal?: AbortSignal): Promise<MediaServerBrowsePage> {
    const request = this.requestSignal(signal);
    const user = this.currentActor(authority, request);
    const record = readQuery(query, EPISODE_QUERY_KEYS);
    const limit = parseLimit(record.limit);
    const rawCursor = parseCursor(record.cursor);
    const library = this.requireVisibleLibrary(user, libraryId);
    const connection = this.requireConnection(library.connectionId);
    const parentId = requestItemId(itemId);
    let cursor: BrowseCursor | undefined;
    if (rawCursor !== undefined) {
      cursor = decodeCursor(rawCursor);
      if (cursor.l !== library.id || cursor.a !== user.id || cursor.g !== connection.generation
        || cursor.q !== "" || cursor.t !== "" || cursor.p !== parentId) throw stale();
    }
    const session = await this.liveSession(authority, connection, { libraryRemoteId: library.remoteId }, request);
    const parent = await this.upstream(connection, request, () => session.provider.detail(session.token, connection.accountId, parentId, request));
    this.recheckContent(authority, request, library.id, connection);
    const ancestors = await this.upstream(connection, request, () => session.provider.ancestors(session.token, connection.accountId, parent.id, request));
    if (!ancestors.includes(library.remoteId)) throw notFound("That item is not in this library.");
    if (parent.type !== "series" && parent.type !== "season") throw invalid("That item has no episodes.");
    const snapshot = await this.index.resolve(this.snapshotKey(connection, library), {
      ...(cursor ? { cursorSnapshotId: cursor.s } : {}),
      scan: (scanSignal) => this.scanLibrary(authority, connection, library, session.token, session.provider, scanSignal, request),
    });
    this.recheckContent(authority, request, library.id, connection);
    const episodes = snapshot.items.filter((item) => item.type === "episode"
      && (parent.type === "series" ? item.seriesId === parent.id : item.parentId === parent.id));
    const offset = cursor?.o ?? 0;
    if (offset > episodes.length) throw invalid("The media-server cursor is out of range.");
    const slice = episodes.slice(offset, offset + limit);
    const page: MediaServerBrowsePage = {
      items: slice.map((item) => publicRemoteItem(structuredClone(item), library.id)),
      total: episodes.length,
      asOf: snapshot.asOf,
      stale: false,
      capabilities: READ_ONLY_MEDIA_CAPABILITIES,
    };
    if (offset + slice.length < episodes.length) {
      page.cursor = encodeCursor({ v: 1, s: snapshot.id, l: library.id, g: connection.generation, a: user.id, q: "", t: "", p: parentId, o: offset + slice.length });
    }
    return page;
  }

  /** Every ordinary file version of one playable item, re-reading the acting account and the
   *  local records after each awaited step. Only a movie or an episode has media to hand over;
   *  the answer carries no URL, path or token. */
  async itemVersions(authority: MediaServerAuthority, libraryId: unknown, itemId: unknown, signal?: AbortSignal): Promise<MediaServerItemVersions> {
    const request = this.requestSignal(signal);
    const user = this.currentActor(authority, request);
    const library = this.requireVisibleLibrary(user, libraryId);
    const connection = this.requireConnection(library.connectionId);
    const requested = requestItemId(itemId);
    const session = await this.liveSession(authority, connection, { libraryRemoteId: library.remoteId }, request);
    return this.versionsUnder(authority, request, library, connection, session, requested);
  }

  /** Proves the acting account may still reach one attached library: the current actor, a
   *  visible library and its captured connection, then a live session that re-reads the
   *  identity, the account policy and the view list, and a content re-check afterwards. It
   *  reads no upstream payload and writes nothing, so it is the confirmation a projection
   *  needs without the item-shaped answers the browse routes carry. */
  async verifyLibrary(authority: MediaServerAuthority, libraryId: unknown, signal?: AbortSignal): Promise<void> {
    const request = this.requestSignal(signal);
    const user = this.currentActor(authority, request);
    const library = this.requireVisibleLibrary(user, libraryId);
    const connection = this.requireConnection(library.connectionId);
    await this.liveSession(authority, connection, { libraryRemoteId: library.remoteId }, request);
    this.recheckContent(authority, request, library.id, connection);
  }

  /** The verified playable items behind one exact external id. Authorization comes first, then
   *  a bounded snapshot and a fresh detail read for every candidate: the snapshot alone never
   *  proves a match after metadata changes, a drifted title is dropped, and an id this app does
   *  not match exactly is an empty answer rather than an error. Only an exact namespaced id is
   *  matched; there is no fuzzy title or path lookup and no external network conversion. */
  async matchingItems(authority: MediaServerAuthority, libraryId: unknown, type: unknown, catalogId: unknown, signal?: AbortSignal): Promise<ProviderItem[]> {
    const request = this.requestSignal(signal);
    const user = this.currentActor(authority, request);
    const library = this.requireVisibleLibrary(user, libraryId);
    const connection = this.requireConnection(library.connectionId);
    const target = remoteMatchTarget(String(type), String(catalogId));
    if (!target) return this.unmatchable(authority, request, library, connection);
    const { items } = await this.matchUnder(authority, request, library, connection, target);
    return items;
  }

  /** The verified original versions behind one exact external id, each re-read after the match
   *  so a candidate whose metadata moved mints no sources. An episode is proved again against
   *  its series after its versions, under the same captured connection and generation, so an
   *  episode that moved to another series -- or a series whose ids moved -- is dropped before
   *  any address is minted. The public stream budget is bounded here rather than truncated. */
  async matchedVersions(authority: MediaServerAuthority, libraryId: unknown, type: unknown, catalogId: unknown, signal?: AbortSignal): Promise<MediaServerItemVersions[]> {
    const request = this.requestSignal(signal);
    const user = this.currentActor(authority, request);
    const library = this.requireVisibleLibrary(user, libraryId);
    const connection = this.requireConnection(library.connectionId);
    const target = remoteMatchTarget(String(type), String(catalogId));
    if (!target) return this.unmatchable(authority, request, library, connection);
    const { session, items } = await this.matchUnder(authority, request, library, connection, target);
    const out: MediaServerItemVersions[] = [];
    let streams = 0;
    for (const item of items) {
      const versions = await this.versionsUnder(authority, request, library, connection, session, item.id);
      if (!this.freshMatch(target, versions.item)) continue;
      if (target.type === "episode") {
        const seriesId = versions.item.seriesId;
        if (seriesId === undefined || seriesId !== item.seriesId) continue;
        const parent = await this.verifiedDetail(authority, request, library, connection, session, seriesId);
        if (parent.type !== "series" || !remoteIdsMatch(target.ids, parent.providerIds)) continue;
      }
      streams += versions.versions.length;
      if (streams > MATCH_STREAM_MAX) throw new MediaServerError("response-too-large", "The media-server match has too many sources.");
      out.push(versions);
    }
    return out;
  }

  /** One item's official artwork, read only through the scoped binary transport after a fresh
   *  detail and ancestry proof. The image role is one of two fixed values and the item may be of
   *  any kind; the answer is bounded validated bytes and their content type, never a URL. */
  async readArtwork(authority: MediaServerAuthority, libraryId: unknown, itemId: unknown, imageType: unknown, signal?: AbortSignal): Promise<MediaServerAsset> {
    const request = this.requestSignal(signal);
    if (imageType !== "Primary" && imageType !== "Backdrop") throw invalid("The media-server image type is not supported.");
    const user = this.currentActor(authority, request);
    const library = this.requireVisibleLibrary(user, libraryId);
    const connection = this.requireConnection(library.connectionId);
    const requested = requestItemId(itemId);
    const session = await this.liveSession(authority, connection, { libraryRemoteId: library.remoteId }, request);
    await this.verifiedDetail(authority, request, library, connection, session, requested);
    const asset = await this.upstream(connection, request, () => session.transport.requestAsset({ kind: "artwork", itemId: requested, imageType }, session.token, request));
    this.recheckContent(authority, request, library.id, connection);
    return { bytes: new Uint8Array(asset.bytes), contentType: asset.contentType };
  }

  /** One sealed external subtitle. The reference must name an ordinary file version whose
   *  provider entry still lists that exact index as an external text track; only then does the
   *  scoped transport read the bytes, and the reference is re-proved afterwards. A reference
   *  with no subtitle index, or one the provider no longer offers, is refused. */
  async readSubtitle(authority: MediaServerAuthority, ref: RemoteContentRef, signal?: AbortSignal): Promise<MediaServerAsset> {
    const request = this.requestSignal(signal);
    if (!isRemoteContentRef(ref)) throw notFound("That media-server subtitle does not exist.");
    const index = ref.subtitleIndex;
    if (index === undefined) throw notFound("That media-server subtitle does not exist.");
    const { library, connection } = this.recheckRef(authority, request, ref);
    const session = await this.liveSession(authority, connection, { libraryRemoteId: library.remoteId }, request);
    this.recheckRef(authority, request, ref);
    const item = await this.upstream(connection, request, () => session.provider.detail(session.token, connection.accountId, ref.itemId, request));
    this.recheckRef(authority, request, ref);
    if (item.id !== ref.itemId) throw new MediaServerError("invalid-response", "The media-server item identity changed.");
    const ancestors = await this.upstream(connection, request, () => session.provider.ancestors(session.token, connection.accountId, item.id, request));
    if (!ancestors.includes(library.remoteId)) throw notFound("That item is not in this library.");
    this.recheckRef(authority, request, ref);
    if (item.type !== "movie" && item.type !== "episode") throw invalid("That item has no playable media.");
    const versions = await this.upstream(connection, request, () => session.provider.versions(session.token, connection.accountId, item.id, request));
    this.recheckRef(authority, request, ref);
    if (!versions.some((version) => version.id === ref.mediaSourceId && version.externalSubtitles?.some((entry) => entry.index === index))) {
      throw notFound("That media-server subtitle is no longer available.");
    }
    const asset = await this.upstream(connection, request, () => session.transport.requestAsset({ kind: "subtitle", itemId: ref.itemId, mediaSourceId: ref.mediaSourceId, index }, session.token, request));
    this.recheckRef(authority, request, ref);
    return { bytes: new Uint8Array(asset.bytes), contentType: asset.contentType };
  }

  /** Proves a sealed reference still names a live, permitted original: the actor owns it, the
   *  records still match, and the named version is still an ordinary file. Reads no bytes and
   *  writes no upstream history. */
  async revalidateOriginal(authority: MediaServerAuthority, ref: RemoteContentRef, signal?: AbortSignal): Promise<void> {
    const request = this.requestSignal(signal);
    if (!isRemoteContentRef(ref)) throw notFound("That media-server item does not exist.");
    if (ref.subtitleIndex !== undefined) throw notFound("That media-server item does not exist.");
    const { library, connection } = this.recheckRef(authority, request, ref);
    const session = await this.liveSession(authority, connection, { libraryRemoteId: library.remoteId }, request);
    this.recheckRef(authority, request, ref);
    const item = await this.upstream(connection, request, () => session.provider.detail(session.token, connection.accountId, ref.itemId, request));
    this.recheckRef(authority, request, ref);
    if (item.id !== ref.itemId) throw new MediaServerError("invalid-response", "The media-server item identity changed.");
    const ancestors = await this.upstream(connection, request, () => session.provider.ancestors(session.token, connection.accountId, item.id, request));
    if (!ancestors.includes(library.remoteId)) throw notFound("That item is not in this library.");
    this.recheckRef(authority, request, ref);
    if (item.type !== "movie" && item.type !== "episode") throw invalid("That item has no playable media.");
    const versions = await this.upstream(connection, request, () => session.provider.versions(session.token, connection.accountId, item.id, request));
    this.recheckRef(authority, request, ref);
    if (!versions.some((version) => version.id === ref.mediaSourceId)) throw notFound("That media-server source is no longer available.");
  }

  /** Opens one original file over the binary transport. The full preflight runs first, the
   *  token is read only for this operation, and the result is re-checked before any body
   *  leaves the manager; a stale or denied result has its body cancelled. The request shares
   *  the manager lifetime, so a shutdown or a connection change aborts it. */
  async openOriginal(authority: MediaServerAuthority, ref: RemoteContentRef, args: { method: "GET" | "HEAD"; range?: string }, signal?: AbortSignal): Promise<Response> {
    const request = this.requestSignal(signal);
    if (!isRemoteContentRef(ref)) throw notFound("That media-server item does not exist.");
    if (ref.subtitleIndex !== undefined) throw notFound("That media-server item does not exist.");
    if (!args || (args.method !== "GET" && args.method !== "HEAD")) throw invalid("The media-server request method is not supported.");
    if (args.range !== undefined && (typeof args.range !== "string" || args.range.length > 128)) throw invalid("The media-server byte range is malformed.");
    const { library, connection } = this.recheckRef(authority, request, ref);
    const session = await this.liveSession(authority, connection, { libraryRemoteId: library.remoteId }, request);
    this.recheckRef(authority, request, ref);
    const item = await this.upstream(connection, request, () => session.provider.detail(session.token, connection.accountId, ref.itemId, request));
    this.recheckRef(authority, request, ref);
    if (item.id !== ref.itemId) throw new MediaServerError("invalid-response", "The media-server item identity changed.");
    const ancestors = await this.upstream(connection, request, () => session.provider.ancestors(session.token, connection.accountId, item.id, request));
    if (!ancestors.includes(library.remoteId)) throw notFound("That item is not in this library.");
    this.recheckRef(authority, request, ref);
    const versions = await this.upstream(connection, request, () => session.provider.versions(session.token, connection.accountId, item.id, request));
    this.recheckRef(authority, request, ref);
    if (!versions.some((version) => version.id === ref.mediaSourceId)) throw notFound("That media-server source is no longer available.");
    const response = await this.upstream(connection, request, () => session.transport.requestOriginal(
      { itemId: ref.itemId, mediaSourceId: ref.mediaSourceId, method: args.method, ...(args.range === undefined ? {} : { range: args.range }) },
      session.token,
      request,
    ));
    const abortBody = () => { void response.body?.cancel().catch(() => undefined); };
    try {
      this.recheckRef(authority, request, ref);
      this.checkLive(request);
    } catch (error) {
      abortBody();
      throw error;
    }
    if (request.aborted) {
      abortBody();
      throw cancelled();
    }
    request.addEventListener("abort", abortBody, { once: true });
    return response;
  }

  private requestSignal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal;
  }

  private checkLive(signal: AbortSignal): void {
    if (this.closed) throw closedError();
    if (signal.aborted) throw cancelled();
  }

  /** The current account behind a request, read afresh from the state. Fails closed after a
   *  shutdown or an abort, and after any change to the acting account. */
  private currentActor(authority: MediaServerAuthority, signal?: AbortSignal): UserRecord {
    authority.assertCurrent();
    if (this.closed) throw closedError();
    if (signal?.aborted) throw cancelled();
    const user = findUserById(this.store.users(), authority.actor.id);
    if (!user || user.secret !== authority.actor.secret || user.disabled || user.mustChangePassword) throw new ResourceError(401, "AUTH_REQUIRED");
    return user;
  }

  private requireAdmin(authority: MediaServerAuthority, signal?: AbortSignal): UserRecord {
    const user = this.currentActor(authority, signal);
    if (user.role !== "admin") throw new ForbiddenError();
    return user;
  }

  /** The mandated write-time guard, run inside the synchronous mutator that lands a write.
   *  It inspects the passed state, so a write queued behind another cannot land on an
   *  authority that a revocation, a demotion or a shutdown has since taken away. */
  private assertWriteAuthority(state: { users?: UserRecord[] }, authority: MediaServerAuthority, signal?: AbortSignal): void {
    authority.assertCurrent();
    if (this.closed) throw closedError();
    if (signal?.aborted) throw cancelled();
    const users = state.users ?? [];
    const user = findUserById(users, authority.actor.id);
    if (!user || user.secret !== authority.actor.secret || user.disabled || user.mustChangePassword) throw new ResourceError(401, "AUTH_REQUIRED");
    assertStillAdmin(users, authority.actor);
  }

  /** Re-reads the connection behind an in-flight request and refuses when it moved. */
  private recheckConnection(authority: MediaServerAuthority, signal: AbortSignal, connection: MediaConnectionRecord): void {
    this.currentActor(authority, signal);
    const fresh = this.requireConnection(connection.id);
    if (!this.sameConnection(fresh, connection)) throw stale();
  }

  /** The same, plus the local library visibility a content read depends on. */
  private recheckContent(authority: MediaServerAuthority, signal: AbortSignal, libraryId: string, connection: MediaConnectionRecord): void {
    const user = this.currentActor(authority, signal);
    const library = this.requireVisibleLibrary(user, libraryId);
    const fresh = this.requireConnection(library.connectionId);
    if (!this.sameConnection(fresh, connection)) throw stale();
  }

  /** One upstream detail read proved to be the item asked for and to still sit in the library,
   *  with the acting authority and the local records re-checked after every await. */
  private async verifiedDetail(
    authority: MediaServerAuthority,
    signal: AbortSignal,
    library: RemoteLibraryRecord,
    connection: MediaConnectionRecord,
    session: { token: string; provider: MediaServerProvider },
    itemId: string,
  ): Promise<ProviderItem> {
    const item = await this.upstream(connection, signal, () => session.provider.detail(session.token, connection.accountId, itemId, signal));
    this.recheckContent(authority, signal, library.id, connection);
    if (item.id !== itemId) throw new MediaServerError("invalid-response", "The media-server item identity changed.");
    const ancestors = await this.upstream(connection, signal, () => session.provider.ancestors(session.token, connection.accountId, item.id, signal));
    if (!ancestors.includes(library.remoteId)) throw notFound("That item is not in this library.");
    this.recheckContent(authority, signal, library.id, connection);
    return item;
  }

  /** The exact-id match re-applied to a freshly read item: a movie by its shared namespaced id,
   *  or an episode by season and episode with no multi-episode range. */
  private freshMatch(target: RemoteMatchTarget, item: ProviderItem): boolean {
    if (target.type === "movie") return item.type === "movie" && remoteIdsMatch(target.ids, item.providerIds);
    return item.type === "episode" && item.season === target.season && item.episode === target.episode
      && (item.episodeEnd === undefined || item.episodeEnd === item.episode);
  }

  /** An id this app does not match exactly is an empty answer, never an error -- but only
   *  after the live session and the local records have been proved, and before the index is
   *  asked for a snapshot it could never use. */
  private async unmatchable(
    authority: MediaServerAuthority,
    request: AbortSignal,
    library: RemoteLibraryRecord,
    connection: MediaConnectionRecord,
  ): Promise<[]> {
    await this.liveSession(authority, connection, { libraryRemoteId: library.remoteId }, request);
    this.recheckContent(authority, request, library.id, connection);
    return [];
  }

  /** One live session, one bounded snapshot and the freshly proved items behind one exact
   *  external id, shared by `matchingItems` and `matchedVersions` so both prove the same
   *  identity under the same captured connection and generation. */
  private async matchUnder(
    authority: MediaServerAuthority,
    request: AbortSignal,
    library: RemoteLibraryRecord,
    connection: MediaConnectionRecord,
    target: RemoteMatchTarget,
  ): Promise<{ session: LiveSession; items: ProviderItem[] }> {
    const session = await this.liveSession(authority, connection, { libraryRemoteId: library.remoteId }, request);
    this.recheckContent(authority, request, library.id, connection);
    const snapshot = await this.index.resolve(this.snapshotKey(connection, library), {
      scan: (scanSignal) => this.scanLibrary(authority, connection, library, session.token, session.provider, scanSignal, request),
    });
    this.recheckContent(authority, request, library.id, connection);
    const candidates = remoteMatchCandidates(snapshot.items, target);
    if (candidates.length > MATCH_CANDIDATE_MAX) throw new MediaServerError("response-too-large", "The media-server match has too many candidates.");
    const parents = new Map<string, boolean>();
    const items: ProviderItem[] = [];
    for (const candidate of candidates) {
      const fresh = await this.verifiedDetail(authority, request, library, connection, session, candidate.id);
      if (!this.freshMatch(target, fresh)) continue;
      if (target.type === "episode") {
        const seriesId = fresh.seriesId;
        if (seriesId === undefined) continue;
        let proven = parents.get(seriesId);
        if (proven === undefined) {
          const parent = await this.verifiedDetail(authority, request, library, connection, session, seriesId);
          proven = parent.type === "series" && remoteIdsMatch(target.ids, parent.providerIds);
          parents.set(seriesId, proven);
        }
        if (!proven) continue;
      }
      items.push(fresh);
    }
    return { session, items };
  }

  /** The versions of one item read inside an already proved session: the detail, the ancestry
   *  proof, the playable check and the version list, with the local records re-checked after
   *  every await. */
  private async versionsUnder(
    authority: MediaServerAuthority,
    request: AbortSignal,
    library: RemoteLibraryRecord,
    connection: MediaConnectionRecord,
    session: LiveSession,
    requested: string,
  ): Promise<MediaServerItemVersions> {
    this.recheckContent(authority, request, library.id, connection);
    const item = await this.upstream(connection, request, () => session.provider.detail(session.token, connection.accountId, requested, request));
    this.recheckContent(authority, request, library.id, connection);
    if (item.id !== requested) throw new MediaServerError("invalid-response", "The media-server item identity changed.");
    const ancestors = await this.upstream(connection, request, () => session.provider.ancestors(session.token, connection.accountId, item.id, request));
    if (!ancestors.includes(library.remoteId)) throw notFound("That item is not in this library.");
    this.recheckContent(authority, request, library.id, connection);
    if (item.type !== "movie" && item.type !== "episode") throw invalid("That item has no playable media.");
    const versions = await this.upstream(connection, request, () => session.provider.versions(session.token, connection.accountId, item.id, request));
    this.recheckContent(authority, request, library.id, connection);
    return {
      item: structuredClone(item),
      versions: versions.map((version) => ({ ...version })),
      identity: { provider: connection.provider, serverId: connection.serverId, accountId: connection.accountId, itemId: item.id },
      connectionId: connection.id,
      libraryId: library.id,
      generation: connection.generation,
      libraryName: library.name,
    };
  }

  /** Re-reads the records a sealed reference names and refuses when any of them moved: the
   *  actor must be the owner with an unchanged secret and a live session, and the library,
   *  connection, identity and generation exactly the configured ones. */
  private recheckRef(authority: MediaServerAuthority, signal: AbortSignal, ref: RemoteContentRef): { library: RemoteLibraryRecord; connection: MediaConnectionRecord } {
    const user = this.currentActor(authority, signal);
    if (!(ref.owner.expiresAt > Date.now()) || user.id !== ref.owner.userId || user.revoked?.[ref.owner.sid] || ref.owner.secretStamp !== remoteSecretStamp(user.secret)) {
      throw new ResourceError(404, "RESOURCE_NOT_FOUND");
    }
    const connections = this.store.mediaConnections();
    const library = this.store.remoteLibraries().find((candidate) => candidate.id === ref.libraryId);
    if (!library || library.connectionId !== ref.connectionId) throw notFound("That remote library does not exist.");
    if (!remoteLibraryVisibleTo(connections, library, user)) throw notFound("That remote library does not exist.");
    const connection = connections.find((candidate) => candidate.id === ref.connectionId);
    if (!connection || !connection.enabled || !connection.secretRef) throw invalid("That media-server connection is disabled.");
    if (connection.provider !== ref.provider || connection.serverId !== ref.serverId
      || connection.accountId !== ref.accountId || connection.generation !== ref.generation) throw stale();
    return { library, connection };
  }

  private requireConnectionId(value: unknown): string {
    if (typeof value !== "string" || !MEDIA_CONNECTION_ID.test(value)) throw invalid("The media-server connection id is malformed.");
    return value;
  }

  private requireLibraryId(value: unknown): string {
    if (typeof value !== "string" || !REMOTE_LIBRARY_ID.test(value)) throw notFound("That remote library does not exist.");
    return value;
  }

  private requireConnection(connectionId: unknown): MediaConnectionRecord {
    const id = this.requireConnectionId(connectionId);
    const connection = this.store.mediaConnections().find((candidate) => candidate.id === id);
    if (!connection) throw notFound("That media-server connection does not exist.");
    if (!connection.enabled) throw invalid("That media-server connection is disabled.");
    if (!connection.serverId || !connection.accountId || !connection.secretRef) throw invalid("That media-server connection is not configured.");
    return connection;
  }

  private visibleFor(user: UserRecord): RemoteLibraryRecord[] {
    const connections = this.store.mediaConnections();
    return this.store.remoteLibraries()
      .filter((library) => remoteLibraryVisibleTo(connections, library, user))
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  }

  private requireVisibleLibrary(user: UserRecord, libraryId: unknown): RemoteLibraryRecord {
    const id = this.requireLibraryId(libraryId);
    const connections = this.store.mediaConnections();
    const library = this.store.remoteLibraries().find((candidate) => candidate.id === id);
    if (!library || !remoteLibraryVisibleTo(connections, library, user)) throw notFound("That remote library does not exist.");
    return library;
  }

  private readAllowedUsers(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > MEDIA_SERVER_LIMITS.allowedUsersPerLibrary) throw invalid("The remote library grants are malformed.");
    const users: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string" || entry.length === 0 || entry.length > MEDIA_SERVER_LIMITS.upstreamId) throw invalid("The remote library grants are malformed.");
      if (!users.includes(entry)) users.push(entry);
    }
    return users;
  }

  /** The ordinary accounts a set of libraries is granted to. Their permission stamp moves
   *  whenever those libraries become visible or invisible to them. */
  private granteeIds(users: UserRecord[] | undefined, libraries: readonly RemoteLibraryRecord[]): string[] {
    const known = users ?? [];
    const ids = new Set<string>();
    for (const library of libraries) {
      for (const id of library.allowedUsers) {
        if (findUserById(known, id)?.role === "user") ids.add(id);
      }
    }
    return [...ids];
  }

  private sameConnection(left: MediaConnectionRecord, right: MediaConnectionRecord): boolean {
    return left.id === right.id && left.generation === right.generation && left.secretRef === right.secretRef
      && left.serverId === right.serverId && left.accountId === right.accountId && left.baseUrl === right.baseUrl
      && left.enabled === right.enabled;
  }

  private snapshotKey(connection: MediaConnectionRecord, library: RemoteLibraryRecord): MediaServerSnapshotKey {
    return {
      libraryId: library.id,
      connectionId: connection.id,
      remoteId: library.remoteId,
      generation: connection.generation,
      identityKey: verifiedKey(connection.provider, connection.serverId, connection.accountId),
    };
  }

  private filterItems(items: readonly ProviderItem[], search: string | undefined, type: ProviderItemType | undefined): readonly ProviderItem[] {
    const needle = search?.toLowerCase();
    return items.filter((item) => {
      if (type !== undefined && item.type !== type) return false;
      if (needle !== undefined && needle.length > 0 && !item.name.toLowerCase().includes(needle)) return false;
      return true;
    });
  }

  private adminConnectionView(connection: MediaConnectionRecord): AdminConnectionView {
    return { ...adminMediaConnection(connection), status: this.statusOf(connection) };
  }

  private statusOf(connection: MediaConnectionRecord): MediaServerConnectionStatus {
    if (!connection.enabled) return "disabled";
    const record = this.statuses.get(connection.id);
    if (!record || record.generation !== connection.generation || record.secretRef !== connection.secretRef) return "unavailable";
    return record.status;
  }

  private markAvailable(connection: MediaConnectionRecord): void {
    this.statuses.set(connection.id, { generation: connection.generation, secretRef: connection.secretRef, status: "available" });
  }

  private markReauthentication(connection: MediaConnectionRecord): void {
    this.dropRuntime(connection.id);
    this.statuses.set(connection.id, { generation: connection.generation, secretRef: connection.secretRef, status: "reauthentication-required" });
    this.notifyContent({ connectionId: connection.id });
  }

  private markIdentityChanged(connection: MediaConnectionRecord): void {
    this.dropRuntime(connection.id);
    this.statuses.set(connection.id, { generation: connection.generation, secretRef: connection.secretRef, status: "identity-changed" });
    this.notifyContent({ connectionId: connection.id });
  }

  /** Starts an invalidation without waiting for it, for a 401 or an identity change that must
   *  reach live content at once. A failure is logged and never resurrects the state. */
  private notifyContent(scope: MediaServerInvalidationScope): void {
    const callback = this.contentInvalidator;
    if (!callback) return;
    void callback(scope).catch((error: unknown) =>
      log("WARN", "Media-server content invalidation failed", { reason: error instanceof Error ? error.message : String(error) }));
  }

  /** Awaits an invalidation for a write that is reporting completion. A failure is logged and
   *  never rolls the write back. */
  private async invalidateContent(scope: MediaServerInvalidationScope): Promise<void> {
    const callback = this.contentInvalidator;
    if (!callback) return;
    try { await callback(scope); }
    catch (error) {
      log("WARN", "Media-server content invalidation failed", { reason: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Forgets everything derived from one connection without claiming a new status: the next
   *  reader sees `unavailable` until a live operation proves otherwise. */
  private invalidateRuntime(connectionId: string): void {
    this.dropRuntime(connectionId);
    this.statuses.delete(connectionId);
  }

  private dropRuntime(connectionId: string): void {
    const cached = this.runtimes.get(connectionId);
    if (cached) {
      this.runtimes.delete(connectionId);
      void cached.transport.close().catch(() => undefined);
    }
    this.index.invalidateConnection(connectionId);
  }

  private cacheRuntime(connectionId: string, runtime: CachedRuntime): void {
    // A concurrent read can install a runtime for the same handle while a reauthentication
    // awaits its cleanup; closing any different runtime under the handle before replacing it
    // is what keeps a live binary transport from being orphaned outside the map.
    const existing = this.runtimes.get(connectionId);
    if (existing && existing !== runtime) {
      this.runtimes.delete(connectionId);
      void existing.transport.close().catch(() => undefined);
    }
    while (this.runtimes.size >= RUNTIME_MAX && !this.runtimes.has(connectionId)) {
      const oldest = this.runtimes.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const evicted = this.runtimes.get(oldest);
      this.runtimes.delete(oldest);
      if (evicted) void evicted.transport.close().catch(() => undefined);
    }
    this.runtimes.set(connectionId, runtime);
  }

  private providerFor(connection: MediaConnectionRecord): CachedRuntime {
    const cached = this.runtimes.get(connection.id);
    if (cached && cached.generation === connection.generation && cached.secretRef === connection.secretRef) return cached;
    if (cached) {
      this.runtimes.delete(connection.id);
      void cached.transport.close().catch(() => undefined);
    }
    const transport = this.transportFactory({ baseUrl: connection.baseUrl, allowLan: connection.allowLan, allowLoopback: connection.allowLoopback, deviceId: connection.id });
    const runtime: CachedRuntime = { generation: connection.generation, secretRef: connection.secretRef, transport, provider: this.providerFactory(connection.provider, transport) };
    this.cacheRuntime(connection.id, runtime);
    return runtime;
  }

  /** The live permission check every read repeats: current identity, the exact stored account,
   *  its policy facts and the current view list, re-reading the acting account and the local
   *  records after each await. Nothing is cached as permission. */
  private async liveSession(
    authority: MediaServerAuthority,
    connection: MediaConnectionRecord,
    options: { libraryRemoteId?: string },
    signal: AbortSignal,
  ): Promise<LiveSession> {
    this.checkLive(signal);
    if (!connection.secretRef) throw new MediaServerError("secret-unavailable", "That media-server connection has no stored credential.");
    const binding = { connectionId: connection.id, provider: connection.provider, serverId: connection.serverId, accountId: connection.accountId };
    const runtime = this.providerFor(connection);
    const token = await this.serializedCredential(() => this.vault.get(binding, connection.secretRef as string));
    this.recheckConnection(authority, signal, connection);
    try {
      const identity = await this.net(signal, () => runtime.provider.verifyIdentity(signal));
      this.recheckConnection(authority, signal, connection);
      if (identity.serverId !== connection.serverId) {
        this.markIdentityChanged(connection);
        throw identityChanged();
      }
      const account = await this.net(signal, () => runtime.provider.currentAccount(token, connection.accountId, signal));
      this.recheckConnection(authority, signal, connection);
      if (account.accountId !== connection.accountId) {
        this.markIdentityChanged(connection);
        throw identityChanged();
      }
      const policy = account.policy;
      if (policy.disabled) throw new MediaServerError("unavailable", "The media-server account is disabled.");
      if (!policy.mediaPlayback) throw new MediaServerError("forbidden", "The media-server account may not play.");
      if (policy.hasAdditionalRestrictions) throw new MediaServerError("unsupported-policy", "The media-server account has unsupported restrictions.");
      const libraries = await this.net(signal, () => runtime.provider.listLibraries(token, connection.accountId, signal));
      this.recheckConnection(authority, signal, connection);
      this.markAvailable(connection);
      if (options.libraryRemoteId !== undefined) {
        if (!libraries.some((library) => library.id === options.libraryRemoteId)) throw notFound("That remote library is not visible to the account.");
        if (!policy.allFolders && !policy.folderIds.includes(options.libraryRemoteId)) {
          throw new MediaServerError("forbidden", "The media-server account cannot reach that library.");
        }
      }
      return { token, provider: runtime.provider, transport: runtime.transport, libraries };
    } catch (error) {
      if (error instanceof MediaServerError && error.code === "authentication-required") this.markReauthentication(connection);
      throw error;
    }
  }

  /** One library, paged to completion or refused whole, with a running byte and item budget
   *  and a record of every cursor seen so a cycle is refused before the page limit. */
  private async scanLibrary(
    authority: MediaServerAuthority,
    connection: MediaConnectionRecord,
    library: RemoteLibraryRecord,
    token: string,
    provider: MediaServerProvider,
    scanSignal: AbortSignal,
    requestSignal: AbortSignal,
  ): Promise<SnapshotScan> {
    const signal = AbortSignal.any([scanSignal, requestSignal]);
    const items: ProviderItem[] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let bytes = 2;
    let cursor: string | undefined;
    for (let page = 0; page < SCAN_PAGE_MAX; page += 1) {
      const options = cursor === undefined ? { limit: SCAN_PAGE_LIMIT } : { cursor, limit: SCAN_PAGE_LIMIT };
      const result = await this.upstream(connection, signal, () => provider.pageItems(token, connection.accountId, library.remoteId, options, signal));
      this.recheckContent(authority, signal, library.id, connection);
      for (const item of result.items) {
        if (seen.has(item.id)) throw new MediaServerError("invalid-response", "The media-server library repeated an item.");
        seen.add(item.id);
        bytes += Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
        if (bytes > SCAN_BYTES_MAX) throw new MediaServerError("response-too-large", "The media-server library snapshot is too large.");
        items.push(item);
        if (items.length > SCAN_ITEM_MAX) throw new MediaServerError("response-too-large", "The media-server library has too many items.");
      }
      if (result.cursor === undefined) {
        this.recheckContent(authority, signal, library.id, connection);
        return { items, asOf: new Date(this.clock()).toISOString() };
      }
      if (cursors.has(result.cursor)) throw new MediaServerError("invalid-response", "The media-server paging cursor did not advance.");
      cursors.add(result.cursor);
      cursor = result.cursor;
    }
    throw new MediaServerError("response-too-large", "The media-server library needed too many pages.");
  }

  private async net<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    this.checkLive(signal);
    if (this.activeNetwork >= this.networkMax) throw busy("Too many media-server requests are running.");
    this.activeNetwork += 1;
    try { return await work(); } finally { this.activeNetwork -= 1; }
  }

  /** A provider call that also revokes the runtime on an authentication refusal: a 401 from
   *  any operation, not only the preflight, means the cached token is no longer usable. */
  private async upstream<T>(connection: MediaConnectionRecord, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    try {
      return await this.net(signal, work);
    } catch (error) {
      if (error instanceof MediaServerError && error.code === "authentication-required") this.markReauthentication(connection);
      throw error;
    }
  }

  private async adminMutation<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) throw closedError();
    if (this.mutationInFlight) throw busy("Another media-server change is in progress.");
    this.mutationInFlight = true;
    try { return await work(); } finally { this.mutationInFlight = false; }
  }

  private serializedCredential<T>(work: () => Promise<T>): Promise<T> {
    const run = this.credentialChain.then(work);
    this.credentialChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private appendCleanup(queue: string[] | undefined, refs: readonly string[]): string[] {
    const next = [...(queue ?? [])];
    for (const ref of refs) {
      if (!MEDIA_SECRET_REF.test(ref) || next.includes(ref)) continue;
      if (next.length >= MEDIA_SERVER_LIMITS.secretCleanup) throw busy("The media-server cleanup queue is full.");
      next.push(ref);
    }
    return next;
  }

  /** Removes a secret file the caller just wrote but could not bind. This is internal
   *  recovery, so it deliberately runs without a request authority and after a shutdown. */
  private async rollbackSecret(ref: string): Promise<void> {
    try {
      await this.serializedCredential(() => this.vault.remove(ref));
      return;
    } catch { /* fall through to a durable retry */ }
    try {
      await this.store.update((state) => { state.mediaSecretCleanup = this.appendCleanup(state.mediaSecretCleanup, [ref]); });
    } catch {
      log("WARN", "A media-server secret could not be cleaned up; startup reconciliation will retry");
    }
  }

  /** The periodic work: the secret-cleanup drain and the history sweep, coalesced so a pass
   *  still running never overlaps the next tick. Both are internal maintenance and run
   *  without an actor, like the vault reconciliation. */
  private runMaintenance(): Promise<void> {
    if (this.maintenance) return this.maintenance;
    const run = (async () => {
      try {
        await this.drainCleanup();
        await this.sweepHistory();
      } finally {
        this.maintenance = undefined;
      }
    })();
    this.maintenance = run;
    return run;
  }

  /** One pass over every account's stored remote history. The records are read first: a pass
   *  with nothing to expire and nothing to mark writes nothing at all. It never touches a live
   *  attachment, never moves a permission stamp and never cancels a source. */
  private async sweepHistory(): Promise<void> {
    const now = this.clock();
    if (!historySweepPending(this.historyView(), now)) return;
    let changed = false;
    await this.store.update((state) => { changed = sweepRemoteHistory(state, now); });
    if (changed) log("INFO", "Remote media history was swept");
  }

  /** The history-bearing records as a read-only view, so a pass can ask whether it has
   *  anything to do without writing. `store.userData` answers the live row, never a copy. */
  private historyView() {
    const users = this.store.users();
    return {
      users,
      userData: Object.fromEntries(users.map((user) => [user.id, this.store.userData(user.id)])),
      mediaConnections: this.store.mediaConnections(),
      remoteLibraries: this.store.remoteLibraries(),
    };
  }

  private drainCleanup(): Promise<void> {
    return this.serializedCredential(async () => {
      const queue = this.store.mediaSecretCleanup();
      if (!queue.length) return;
      const bound = new Set(this.store.mediaConnections().map((connection) => connection.secretRef).filter((ref): ref is string => Boolean(ref)));
      for (const ref of queue) {
        if (bound.has(ref)) continue;
        try { await this.vault.remove(ref); }
        catch { continue; }
        try {
          await this.store.update((state) => {
            state.mediaSecretCleanup = (state.mediaSecretCleanup ?? []).filter((entry) => entry !== ref);
          });
        } catch { /* the entry stays; the next drain retries it */ }
      }
    });
  }

  /** Startup reconciliation only when both a real state file and a state that once carried
   *  media-server fields were seen: a legacy state that never knew about remote connections
   *  must not authorize deleting a newer vault left behind by a backup rollback. */
  private async reconcileVault(): Promise<void> {
    if (!this.store.hasPersistedState() || !this.store.hasMediaServerState()) return;
    const refs = await this.vault.references();
    if (!refs.length) return;
    const bound = new Set(this.store.mediaConnections().map((connection) => connection.secretRef).filter((ref): ref is string => Boolean(ref)));
    const queued = new Set(this.store.mediaSecretCleanup());
    const orphans = refs.filter((ref) => !bound.has(ref) && !queued.has(ref));
    if (!orphans.length) return;
    await this.store.update((state) => { state.mediaSecretCleanup = this.appendCleanup(state.mediaSecretCleanup, orphans); });
    log("INFO", "Queued unbound media-server secrets for cleanup", { count: orphans.length });
  }
}
