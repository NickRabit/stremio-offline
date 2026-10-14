import { createHmac, randomBytes } from "node:crypto";
import { AppError } from "./errors.js";
import { log } from "./logger.js";
import { remoteLibraryVisibleTo } from "./media-server-access.js";
import { ResourceError } from "./media-resources.js";
import { isRemoteContentRef, remoteSecretStamp, type RemoteContentRef } from "./media-server-reference.js";
import { isRemoteDownloadReference, type RemoteDownloadReference } from "./media-server-download.js";
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
import { remoteIdsMatch, remoteMatchTarget, type RemoteMatchTarget } from "./media-server-match.js";
import { MediaServerIndex } from "./media-server-index.js";
import {
  createMediaServerProvider,
  type MediaServerProvider,
  type ProviderDirectoryOptions,
  type ProviderOrder,
  type ProviderItem,
  type ProviderItemType,
  type ProviderLibrary,
  type ProviderSort,
  type ProviderVersion,
  type RemoteAccountPolicy,
  PROVIDER_ORDERS,
  PROVIDER_SORTS,
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
  effectiveBrowseMode,
  effectiveMosaic,
  newConnectionId,
  newRemoteLibraryId,
  publicRemoteItem,
  publicRemoteLibrary,
  remoteArtworkPath,
  validateArtworkTag,
  type AdminMediaConnection,
  type MediaConnectionRecord,
  type MediaServerKind,
  type PublicRemoteItem,
  type PublicRemoteLibrary,
  type RemoteCapabilities,
  type RemoteBrowseMode,
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
  /** The shortest gap between two upstream request starts on one connection. Production paces
   *  at 125ms (eight starts a second); tests raise it to prove the spacing or zero it to keep
   *  an unrelated suite fast. */
  networkStartIntervalMs?: number;
  /** Whether identical in-flight live-session metadata reads on one runtime are shared.
   *  Production shares them; a test turns this off to drive the pre-coalescing network lane. */
  coalesceReads?: boolean;
}

const USERNAME_MAX = 256;
const PASSWORD_MAX = 1024;
const RUNTIME_MAX = 128;
const CLEANUP_INTERVAL_MS = 60_000;
const MATCH_CANDIDATE_MAX = 40;
const MATCH_STREAM_MAX = 200;
/** A page asked for one season's episodes: the one parent-scoped page an episode match reads. */
const MATCH_EPISODE_PAGE_LIMIT = 200;
/** How long one proven live session's identity, account policy and view list stay usable. */
const SESSION_FACTS_TTL_MS = 30_000;
/** How long one item or parent membership proof stays usable once it was proved. */
const PROOF_TTL_MS = 5 * 60_000;
/** The most membership proofs held at once; the oldest is evicted past this bound. */
const PROOF_MAX = 8192;
/** How long one proved original stays usable once it was proved: one playback-guard interval. */
const ORIGINAL_PROOF_TTL_MS = 30_000;
/** The most original proofs held at once; the oldest is evicted past this bound. */
const ORIGINAL_PROOF_MAX = 256;
const EXPORT_MAX_BYTES = MEDIA_SERVER_CONFIGURATION_MAX_BYTES;
const CURSOR_MAX = 8192;
const CURSOR_JSON_MAX = 6144;
const IF_NONE_MATCH_MAX = 1024;
const SEARCH_MAX = 256;
const ITEM_TYPES: readonly ProviderItemType[] = ["movie", "series", "season", "episode"];
const CREATE_KEYS = ["provider", "name", "baseUrl", "allowLan", "allowLoopback", "username", "password"];
const ATTACH_KEYS = ["remoteId", "name", "order", "showOnHome", "showInContinueWatching", "browseMode", "mosaic", "showInFavorites"];
const LIBRARY_PATCH_KEYS = ["name", "enabled", "order", "showOnHome", "showInContinueWatching", "allowedUsers", "browseMode", "mosaic", "showInFavorites"];
const CONNECTION_PATCH_KEYS = ["name", "enabled"];
const BROWSE_QUERY_KEYS = ["limit", "cursor", "search", "type"];
const EPISODE_QUERY_KEYS = ["limit", "cursor"];
const DIRECTORY_QUERY_KEYS = ["parentId", "mode", "limit", "cursor", "search", "type", "sort", "order"];
const DIRECTORY_LIMIT_DEFAULT = 60;
/** How many operations may wait in the network lane before a further one is refused outright. */
const NET_QUEUE_MAX = 128;
/** The production start interval: one upstream request per connection every 125ms (8/s). */
const NETWORK_START_INTERVAL_MS = 125;
/** How many operations may wait for one connection's start pacing before a further one is refused. */
const PACER_QUEUE_MAX = 128;

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

const parseBrowseMode = (value: string | undefined): RemoteBrowseMode | undefined => {
  if (value === undefined || value === "") return undefined;
  if (value !== "folders" && value !== "titles") throw invalid("The media-server browse mode is not supported.");
  return value;
};

const parseDirectoryLimit = (value: string | undefined): number => {
  if (value === undefined || value === "") return DIRECTORY_LIMIT_DEFAULT;
  if (!/^\d{1,3}$/.test(value)) throw invalid("The media-server limit is out of range.");
  const limit = Number(value);
  if (limit < 1 || limit > 200) throw invalid("The media-server limit is out of range.");
  return limit;
};

const parseSort = (value: string | undefined): ProviderSort => {
  if (value === undefined || value === "") return "name";
  if (!PROVIDER_SORTS.includes(value as ProviderSort)) throw invalid("The media-server sort is not supported.");
  return value as ProviderSort;
};

const parseOrder = (value: string | undefined): ProviderOrder => {
  if (value === undefined || value === "") return "asc";
  if (!PROVIDER_ORDERS.includes(value as ProviderOrder)) throw invalid("The media-server order is not supported.");
  return value as ProviderOrder;
};

const parseParentId = (value: string | undefined): string | undefined => {
  if (value === undefined || value === "") return undefined;
  return requestItemId(value);
};

const parseCursor = (value: string | undefined): string | undefined => {
  if (value === undefined || value === "") return undefined;
  if (value.length > CURSOR_MAX) throw invalid("The media-server cursor is malformed.");
  return value;
};

/** Whether one episode row is the episode an exact external id names: the same season and a
 *  numeric episode covered by the row's own first-to-last range, so a double-episode file still
 *  matches either of the numbers it spans. */
const episodeCovers = (item: ProviderItem, target: RemoteMatchTarget): boolean => {
  if (item.type !== "episode" || item.season !== target.season || item.episode === undefined || target.episode === undefined) return false;
  const end = item.episodeEnd ?? item.episode;
  return item.episode <= target.episode && target.episode <= end;
};

/** The one conditional header a read accepts: a bounded `If-None-Match` value. */
const readIfNoneMatch = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > IF_NONE_MATCH_MAX) throw invalid("The media-server conditional header is malformed.");
  return value;
};

/** The one optional artwork size a read accepts: the fixed `detail` variant, or nothing. */
const readArtworkSize = (value: unknown): "detail" | undefined => {
  if (value === undefined) return undefined;
  if (value !== "detail") throw invalid("The media-server artwork size is not supported.");
  return "detail";
};

/** A strong or weak `If-None-Match` match against the one current tag. */
const ifNoneMatchMatches = (header: string, etag: string): boolean => {
  for (const raw of header.split(",")) {
    const entry = raw.trim();
    if (entry === "*" || entry === etag || entry === `W/${etag}`) return true;
  }
  return false;
};

const IMAGE_CACHE_CONTROL = "private, no-cache";

const artworkNotModified = (etag: string): Response =>
  new Response(null, { status: 304, headers: { etag, "cache-control": IMAGE_CACHE_CONTROL } });

/** A native-browse cursor. It binds the acting account, the library, the connection generation,
 *  the requested parent, mode, type, search and the sort pair, plus the provider's own page
 *  cursor. Its signature is drawn from a process-scoped key, so a continuation is only trusted
 *  as proof of the parent it names when this process minted it: a forged `parentId` cannot skip
 *  the parent proof. A cursor from any other context is still refused before a provider call. */
interface DirectoryCursor {
  v: 1;
  l: string;
  g: number;
  a: string;
  p: string;
  m: string;
  t: string;
  q: string;
  s: string;
  r: string;
  c: string;
  i: number;
  h: string;
}

/** The process-scoped signing key. It is never persisted and never leaves the process, so a
 *  cursor minted by one run is refused by the next and by any other holder. */
const DIRECTORY_CURSOR_KEY = randomBytes(32);

const directoryCursorPayload = (cursor: Omit<DirectoryCursor, "h">): string =>
  JSON.stringify([cursor.v, cursor.l, cursor.g, cursor.a, cursor.p, cursor.m, cursor.t, cursor.q, cursor.s, cursor.r, cursor.c, cursor.i]);

const directoryCursorTag = (cursor: Omit<DirectoryCursor, "h">): string =>
  createHmac("sha256", DIRECTORY_CURSOR_KEY).update(directoryCursorPayload(cursor), "utf8").digest("base64url");

const encodeDirectoryCursor = (cursor: Omit<DirectoryCursor, "h">): string =>
  Buffer.from(JSON.stringify({ ...cursor, h: directoryCursorTag(cursor) }), "utf8").toString("base64url");

const decodeDirectoryCursor = (value: unknown): DirectoryCursor => {
  if (typeof value !== "string" || value.length === 0 || value.length > CURSOR_MAX) throw invalid("The media-server cursor is malformed.");
  const json = Buffer.from(value, "base64url");
  if (json.length === 0 || json.length > CURSOR_JSON_MAX) throw invalid("The media-server cursor is malformed.");
  let parsed: unknown;
  try { parsed = JSON.parse(json.toString("utf8")); }
  catch { throw invalid("The media-server cursor is malformed."); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid("The media-server cursor is malformed.");
  const { v, l, g, a, p, m, t, q, s, r, c, i, h } = parsed as Record<string, unknown>;
  const bounded = (entry: unknown, max: number, allowEmpty: boolean): boolean =>
    typeof entry === "string" && (allowEmpty || entry.length > 0) && entry.length <= max;
  if (v !== 1 || !bounded(l, MEDIA_SERVER_LIMITS.upstreamId, false)
    || typeof g !== "number" || !Number.isSafeInteger(g) || g < 0
    || !bounded(a, MEDIA_SERVER_LIMITS.upstreamId, false)
    || !bounded(p, MEDIA_SERVER_LIMITS.upstreamId, false)
    || !bounded(m, 16, false) || !bounded(t, 32, true) || !bounded(q, SEARCH_MAX, true)
    || !bounded(s, 16, false) || !bounded(r, 16, false) || !bounded(c, CURSOR_MAX, false)
    || typeof i !== "number" || !Number.isSafeInteger(i) || i < 0
    || !bounded(h, 64, false)) {
    throw invalid("The media-server cursor is malformed.");
  }
  const body: Omit<DirectoryCursor, "h"> = { v: 1, l: l as string, g, a: a as string, p: p as string, m: m as string, t: t as string, q: q as string, s: s as string, r: r as string, c: c as string, i };
  // Re-encoding recomputes the tag, so this one canonical check both rejects a non-canonical
  // spelling and refuses any cursor whose signature this process did not produce.
  if (encodeDirectoryCursor(body) !== value) throw invalid("The media-server cursor is not canonical.");
  return { ...body, h: h as string };
};

interface CachedRuntime {
  generation: number;
  secretRef: string | undefined;
  transport: MediaServerTransport;
  provider: MediaServerProvider;
  /** One pacer per runtime, so two connections never share a start budget. */
  readonly pacer: RuntimePacer;
  readonly dispatchPacer: RuntimePacer;
  /** Identical in-flight metadata reads currently shared by this runtime's callers. */
  readonly inflight: Map<string, InflightRead>;
  /** The last proved identity, account policy and view list, reused for a short window and
   *  dropped with the runtime on any invalidation. It never carries the token: the credential
   *  is re-read from the vault on every request so a changed or removed key still fails closed. */
  session?: SessionFacts;
}

/** The remote facts one live session proves. Cached per runtime for a short window -- never the
 *  token or any local authority -- so a burst of reads shares one identity, policy and view list
 *  instead of re-reading them upstream. */
interface SessionFacts {
  serverId: string;
  accountId: string;
  policy: RemoteAccountPolicy;
  libraries: ProviderLibrary[];
  at: number;
}

/** One proved membership: an item (or a library root) was shown to sit inside a granted library
 *  for one acting account under one connection generation and secret. Cached for a short window
 *  so an image read for an id a page already returned never repeats the detail and ancestor
 *  proof. It grants no playback permission and is keyed by actor, library and generation, so a
 *  proof can never leak across accounts, libraries or connections. */
interface MembershipProof {
  actorId: string;
  libraryId: string;
  connectionId: string;
  generation: number;
  secretRef: string | undefined;
  itemId: string;
  type: ProviderItemType;
  hasPrimaryImage?: boolean;
  hasBackdropImage?: boolean;
  primaryImageTag?: string;
  backdropImageTag?: string;
  at: number;
}

/** One proved original: the item detail, ancestor chain and named version were shown to hold for
 *  one acting account under one connection generation and secret. Cached for one playback-guard
 *  interval so a further byte range of the same source skips the preflight and repeats only the
 *  local grant and the live session. It is not a membership proof and grants no playback
 *  permission on its own; a revalidation drops it when the source moves. */
interface OriginalProof {
  actorId: string;
  libraryId: string;
  connectionId: string;
  generation: number;
  secretRef: string | undefined;
  itemId: string;
  mediaSourceId: string;
  at: number;
}

/** One operation waiting for its turn under a connection's start pacing. `settled` separates an
 *  entry still in the queue from one an admission or an abort has already resolved, so neither
 *  the abort listener nor a later pump acts twice on the same waiter. */
interface PacerWaiter {
  signal: AbortSignal;
  settled: boolean;
  onAbort: () => void;
  admit: () => void;
  fail: (error: MediaServerError) => void;
}

/** Per-connection start pacing: at most one upstream request starts per interval, with a
 *  bounded, abortable waiting queue. Never shared across connection identities. */
interface RuntimePacer {
  lastStart: number;
  timer: NodeJS.Timeout | undefined;
  waiters: PacerWaiter[];
}

/** One in-flight coalesced metadata read shared by several callers. Its dedicated controller is
 *  combined with the manager lifetime; the last subscriber to leave cancels it, and its promise
 *  always carries a rejection handler so an abandoned read cannot surface as an unhandled
 *  rejection. A settled entry is dropped at once: no permission result is ever cached. */
interface InflightRead {
  promise: Promise<unknown>;
  controller: AbortController;
  subscribers: number;
}

const newRuntime = (
  generation: number,
  secretRef: string | undefined,
  transport: MediaServerTransport,
  provider: MediaServerProvider,
): CachedRuntime => ({
  generation,
  secretRef,
  transport,
  provider,
  pacer: { lastStart: 0, timer: undefined, waiters: [] },
  dispatchPacer: { lastStart: 0, timer: undefined, waiters: [] },
  inflight: new Map<string, InflightRead>(),
});

/** One proved live session: the token, the provider behind it, its transport and the view
 *  list the account may reach. Held for the length of a single request so several reads
 *  share one identity proof. */
interface LiveSession {
  token: string;
  provider: MediaServerProvider;
  transport: MediaServerTransport;
  libraries: ProviderLibrary[];
  /** The account policy the session proved, so a caller that needs an extra native permission
   *  (a download) can read it without repeating the identity, policy and view reads. */
  policy: RemoteAccountPolicy;
}

interface StatusRecord {
  generation: number;
  secretRef: string | undefined;
  status: MediaServerConnectionStatus;
}

/** One operation waiting for a network slot. `settled` distinguishes an entry still in the
 *  queue from one a drain admission or an abort has already resolved, so neither the abort
 *  listener nor a later drain acts twice on the same waiter. */
interface NetWaiter {
  signal: AbortSignal;
  settled: boolean;
  onAbort: () => void;
  admit: () => void;
  fail: (error: MediaServerError) => void;
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
  /** Bounded, time-limited item/parent membership proofs. Keyed by actor, library and
   *  connection generation/secret, they never grant playback and are dropped with an
   *  invalidated connection. */
  private readonly proofs = new Map<string, MembershipProof>();
  /** Bounded, time-limited original proofs. Keyed like the membership proofs plus the media
   *  source, they never substitute for the local grant and are dropped with an invalidated
   *  connection. */
  private readonly originalProofs = new Map<string, OriginalProof>();
  private readonly configuration: MediaServerConfiguration;
  private readonly index: MediaServerIndex;
  private readonly clock: () => number;
  private readonly providerFactory: (kind: MediaServerKind, transport: MediaServerTransport) => MediaServerProvider;
  private readonly transportFactory: (config: MediaServerTransportConfig) => MediaServerTransport;
  private readonly networkMax: number;
  private readonly networkStartIntervalMs: number;
  private readonly coalesceReads: boolean;
  private readonly cleanupIntervalMs: number;
  private readonly lifetime = new AbortController();
  private readonly loginTransports = new Set<MediaServerTransport>();
  private credentialChain: Promise<unknown> = Promise.resolve();
  private maintenance: Promise<void> | undefined;
  private cleanupTimer: NodeJS.Timeout | undefined;
  private activeNetwork = 0;
  private readonly netWaiters: NetWaiter[] = [];
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
    this.networkStartIntervalMs = seams.networkStartIntervalMs ?? NETWORK_START_INTERVAL_MS;
    this.coalesceReads = seams.coalesceReads ?? true;
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
    // The lifetime abort rejects every queued request through its own signal; this sweep only
    // covers a waiter whose signal was somehow not bound to the lifetime, so nothing leaks.
    while (this.netWaiters.length > 0) {
      const waiter = this.netWaiters.shift() as NetWaiter;
      waiter.settled = true;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.fail(closedError());
    }
    // A pacer waiter is bound to the lifetime signal too, so this only covers one whose signal
    // was somehow not combined with it.
    for (const runtime of this.runtimes.values()) {
      this.failPacer(runtime.pacer, closedError());
      this.failPacer(runtime.dispatchPacer, closedError());
    }
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = undefined; }
    await this.index.close();
    const transports = [...this.runtimes.values()].map((runtime) => runtime.transport);
    this.runtimes.clear();
    this.statuses.clear();
    this.proofs.clear();
    this.originalProofs.clear();
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
        const result = await this.net(undefined, request, () => provider.authenticate(username, password, request));
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
        this.cacheRuntime(id, newRuntime(installed.generation, installed.secretRef, transport, provider));
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
        const result = await this.net(undefined, request, () => provider.authenticate(username, password, request));
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
        this.cacheRuntime(connectionId, newRuntime(updated.generation, updated.secretRef, transport, provider));
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
    // An administrator discovering libraries must see one that appeared upstream just now, so a
    // cached view list is never reused here.
    const session = await this.liveSession(authority, connection, { refresh: true }, request);
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
    const browseMode = parseBrowseMode(record.browseMode as string | undefined);
    const mosaic = record.mosaic === undefined ? undefined : bool(record.mosaic, "mosaic");
    const showInFavorites = record.showInFavorites === undefined ? undefined : bool(record.showInFavorites, "showInFavorites");
    return this.adminMutation(async () => {
      // A library the administrator is attaching may have appeared after the cache was filled,
      // so the view list is proved afresh before the attachment is verified against it.
      const session = await this.liveSession(authority, connection, { libraryRemoteId: remoteId, refresh: true }, request);
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
          ...(browseMode === undefined ? {} : { browseMode }),
          ...(mosaic === undefined ? {} : { mosaic }),
          ...(showInFavorites === undefined ? {} : { showInFavorites }),
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
    const browseMode = parseBrowseMode(record.browseMode as string | undefined);
    const mosaic = record.mosaic === undefined ? undefined : bool(record.mosaic, "mosaic");
    const showInFavorites = record.showInFavorites === undefined ? undefined : bool(record.showInFavorites, "showInFavorites");
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
        // Display-only settings: they never bump the generation or revoke live content.
        if (browseMode !== undefined) next.browseMode = browseMode;
        if (mosaic !== undefined) next.mosaic = mosaic;
        if (showInFavorites !== undefined) next.showInFavorites = showInFavorites;
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
    return libraries.map((library) => {
      const connection = connections.find((candidate) => candidate.id === library.connectionId);
      const result = publicRemoteLibrary(library, connection?.provider);
      const runtime = connection && this.runtimes.get(connection.id);
      const facts = runtime?.session;
      if (connection && runtime?.generation === connection.generation && runtime.secretRef === connection.secretRef
        && facts && this.clock() - facts.at < SESSION_FACTS_TTL_MS && effectiveMosaic(library)) {
        const tag = facts.libraries.find((view) => view.id === library.remoteId)?.primaryImageTag;
        if (tag !== undefined) result.poster = remoteArtworkPath(library.id, library.remoteId, "Primary", tag);
      }
      return result;
    });
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

  /** The legacy one-page browse. It is a thin wrapper over `browseDirectory`: it accepts only
   *  the old `limit`/`cursor`/`search`/`type` keys and never scans or continues past one
   *  provider page. */
  async browseItems(authority: MediaServerAuthority, libraryId: unknown, query: unknown, signal?: AbortSignal): Promise<MediaServerBrowsePage> {
    const record = readQuery(query, BROWSE_QUERY_KEYS);
    return this.browseDirectory(authority, libraryId, {
      ...(record.limit === undefined ? {} : { limit: record.limit }),
      ...(record.cursor === undefined ? {} : { cursor: record.cursor }),
      ...(record.search === undefined ? {} : { search: record.search }),
      ...(record.type === undefined ? {} : { type: record.type }),
    }, signal);
  }

  /** One native browse page of an attached remote library, folders or titles. It reads exactly
   *  one provider page for one request -- the recursive snapshot index is never consulted -- and
   *  re-proves the acting authority, the library grant and the connection identity after every
   *  await. A nested parent is proved to belong to the library, and only a folder, series or
   *  season may be browsed further. */
  async browseDirectory(authority: MediaServerAuthority, libraryId: unknown, query: unknown, signal?: AbortSignal): Promise<MediaServerBrowsePage> {
    const request = this.requestSignal(signal);
    const user = this.currentActor(authority, request);
    const record = readQuery(query, DIRECTORY_QUERY_KEYS);
    const limit = parseDirectoryLimit(record.limit);
    const search = parseSearch(record.search);
    const type = parseType(record.type);
    const sort = parseSort(record.sort);
    const order = parseOrder(record.order);
    const requestedParent = parseParentId(record.parentId);
    const rawCursor = parseCursor(record.cursor);
    const library = this.requireVisibleLibrary(user, libraryId);
    const connection = this.requireConnection(library.connectionId);
    const mode = parseBrowseMode(record.mode) ?? effectiveBrowseMode(library);
    const parent = requestedParent ?? library.remoteId;
    let cursor: DirectoryCursor | undefined;
    if (rawCursor !== undefined) {
      cursor = decodeDirectoryCursor(rawCursor);
      if (cursor.l !== library.id || cursor.a !== user.id || cursor.g !== connection.generation
        || cursor.p !== parent || cursor.m !== mode || cursor.t !== (type ?? "") || cursor.q !== (search ?? "")
        || cursor.s !== sort || cursor.r !== order) throw stale();
    }
    const session = await this.liveSession(authority, connection, { libraryRemoteId: library.remoteId }, request);
    // A signed cursor that binds this exact actor, library, generation, parent and query can
    // only have been minted after the parent was proved, so a continuation skips the proof; a
    // fresh first page, or anything the signature does not prove, is proved again.
    const parentProofExpired = cursor !== undefined && this.clock() - cursor.i >= PROOF_TTL_MS;
    if (requestedParent !== undefined && (cursor === undefined || parentProofExpired)) {
      await this.proveParent(authority, request, library, connection, session, requestedParent);
    }
    const page = await this.upstream(connection, request, () => session.provider.pageDirectory(session.token, connection.accountId, parent, {
      mode,
      limit,
      sort,
      order,
      ...(cursor === undefined ? {} : { cursor: cursor.c }),
      ...(search === undefined ? {} : { search }),
      ...(type === undefined ? {} : { type }),
    }, request));
    this.recheckContent(authority, request, library.id, connection);
    // A page of a parent already proved to sit in this library is a set of members of this
    // library: register each as a proof so a later image read never repeats its detail and
    // ancestor chain. Only after the current checks, so a stale page registers nothing.
    for (const item of page.items) this.putProof(this.proofOf(user, library, connection, item));
    const result: MediaServerBrowsePage = {
      items: page.items.map((item) => publicRemoteItem(structuredClone(item), library.id)),
      total: page.total,
      asOf: new Date(this.clock()).toISOString(),
      stale: false,
      capabilities: READ_ONLY_MEDIA_CAPABILITIES,
    };
    if (page.cursor !== undefined) {
      result.cursor = encodeDirectoryCursor({
        v: 1, l: library.id, g: connection.generation, a: user.id, p: parent, m: mode,
        t: type ?? "", q: search ?? "", s: sort, r: order, c: page.cursor,
        i: cursor !== undefined && !parentProofExpired ? cursor.i : this.clock(),
      });
    }
    return result;
  }

  /** Own artwork wins; otherwise one bounded child page supplies the mosaic. */
  async previewDirectory(authority: MediaServerAuthority, libraryId: unknown, parentId?: unknown, signal?: AbortSignal, preferChildren = false): Promise<{ posters: string[] }> {
    const request = this.requestSignal(signal);
    const user = this.currentActor(authority, request);
    const library = this.requireVisibleLibrary(user, libraryId);
    const connection = this.requireConnection(library.connectionId);
    if (!effectiveMosaic(library)) return { posters: [] };
    const requestedParent = parseParentId(typeof parentId === "string" ? parentId : undefined);
    const session = await this.liveSession(authority, connection, { libraryRemoteId: library.remoteId }, request);
    let root = library.remoteId;
    let tag: string | undefined;
    if (requestedParent === undefined) {
      tag = session.libraries.find((entry) => entry.id === root)?.primaryImageTag;
    } else {
      const parent = await this.proveParent(authority, request, library, connection, session, requestedParent);
      if (parent.type === "season") return { posters: [] };
      root = parent.itemId;
      tag = parent.primaryImageTag;
    }
    this.recheckContent(authority, request, library.id, connection);
    if (tag !== undefined && (!preferChildren || requestedParent !== undefined)) return { posters: [remoteArtworkPath(library.id, root, "Primary", tag)] };
    const page = await this.upstream(connection, request, () => session.provider.pageDirectory(session.token, connection.accountId, root, {
      mode: preferChildren && requestedParent === undefined && library.type !== "mixed" ? "titles" : "folders",
      ...(preferChildren && requestedParent === undefined && library.type !== "mixed" ? { type: library.type } : {}),
      limit: 12,
    }, request));
    this.recheckContent(authority, request, library.id, connection);
    for (const item of page.items) this.putProof(this.proofOf(user, library, connection, item));
    return { posters: page.items.filter((item) => item.hasPrimaryImage === true).slice(0, 4)
      .map((item) => remoteArtworkPath(library.id, item.id, "Primary", item.primaryImageTag)) };
  }

  async itemDetail(authority: MediaServerAuthority, libraryId: unknown, itemId: unknown, signal?: AbortSignal): Promise<MediaServerDetail> {
    const request = this.requestSignal(signal);
    const user = this.currentActor(authority, request);
    const library = this.requireVisibleLibrary(user, libraryId);
    const connection = this.requireConnection(library.connectionId);
    const requested = requestItemId(itemId);
    const session = await this.liveSession(authority, connection, { libraryRemoteId: library.remoteId }, request);
    const item = await this.verifiedDetail(authority, request, library, connection, session, requested);
    return { item: publicRemoteItem(structuredClone(item), library.id), capabilities: READ_ONLY_MEDIA_CAPABILITIES };
  }

  /** The legacy one-page episode list. It is a thin wrapper over `browseDirectory`: one
   *  parent-scoped page of the parent's episodes, never a scan or a snapshot. It accepts only
   *  the old `limit`/`cursor` keys. */
  async itemEpisodes(authority: MediaServerAuthority, libraryId: unknown, itemId: unknown, query: unknown, signal?: AbortSignal): Promise<MediaServerBrowsePage> {
    const record = readQuery(query, EPISODE_QUERY_KEYS);
    return this.browseDirectory(authority, libraryId, {
      parentId: String(itemId),
      mode: "titles",
      type: "episode",
      ...(record.limit === undefined ? {} : { limit: record.limit }),
      ...(record.cursor === undefined ? {} : { cursor: record.cursor }),
    }, signal);
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
   *  one bounded provider-id query and a fresh detail read for every candidate, so a drifted
   *  title is dropped. An id this app does not match exactly is an empty answer, produced
   *  without a single upstream call. Only an exact namespaced id is matched; there is no fuzzy
   *  title or path lookup and no external network conversion. */
  async matchingItems(authority: MediaServerAuthority, libraryId: unknown, type: unknown, catalogId: unknown, signal?: AbortSignal): Promise<ProviderItem[]> {
    const request = this.requestSignal(signal);
    const user = this.currentActor(authority, request);
    const library = this.requireVisibleLibrary(user, libraryId);
    const connection = this.requireConnection(library.connectionId);
    const target = remoteMatchTarget(String(type), String(catalogId));
    if (!target) return this.unmatchable(authority, request, library, connection);
    const { items } = await this.matchUnder(authority, request, library, connection, target, undefined);
    return items;
  }

  /** The verified original versions behind one exact external id, each re-read after the match
   *  so a candidate whose metadata moved mints no sources. An episode is proved again against
   *  its series after its versions, under the same captured connection and generation, so an
   *  episode that moved to another series -- or a series whose ids moved -- is dropped before
   *  any address is minted. The public stream budget is bounded here rather than truncated. */
  async matchedVersions(authority: MediaServerAuthority, libraryId: unknown, type: unknown, catalogId: unknown, signal?: AbortSignal, nameHint?: string): Promise<MediaServerItemVersions[]> {
    const request = this.requestSignal(signal);
    const user = this.currentActor(authority, request);
    const library = this.requireVisibleLibrary(user, libraryId);
    const connection = this.requireConnection(library.connectionId);
    const target = remoteMatchTarget(String(type), String(catalogId));
    if (!target) return this.unmatchable(authority, request, library, connection);
    const { session, items } = await this.matchUnder(authority, request, library, connection, target, nameHint);
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

  /** One item's official artwork as a scoped, streaming response. The image role is one of two
   *  fixed values, the optional `tag` is a bounded opaque string and the optional `size` is the one
   *  fixed `detail` variant; the item may be of any kind. Membership is taken from a short-lived
   *  proof (an id a page already returned, or a one-time detail and ancestor proof for an unknown
   *  id) so a page's images never fan out into per-image detail and ancestor calls. `If-None-Match`
   *  is answered locally with a 304 once the local authority and the current tag still hold, and a
   *  detail variant carries its own ETag so a tile ETag can never answer a detail request; the bytes
   *  stream through the image lane so an image burst never consumes a metadata or playback-guard
   *  slot. */
  async readArtwork(
    authority: MediaServerAuthority,
    libraryId: unknown,
    itemId: unknown,
    imageType: unknown,
    signal?: AbortSignal,
    options?: { tag?: unknown; ifNoneMatch?: unknown; size?: unknown },
  ): Promise<Response> {
    const request = this.requestSignal(signal);
    if (imageType !== "Primary" && imageType !== "Backdrop") throw invalid("The media-server image type is not supported.");
    const user = this.currentActor(authority, request);
    const library = this.requireVisibleLibrary(user, libraryId);
    const connection = this.requireConnection(library.connectionId);
    const requested = requestItemId(itemId);
    const tag = options?.tag === undefined ? undefined : validateArtworkTag(options.tag);
    const ifNoneMatch = readIfNoneMatch(options?.ifNoneMatch);
    const size = readArtworkSize(options?.size);
    const session = await this.liveSession(authority, connection, { libraryRemoteId: library.remoteId }, request);
    this.recheckContent(authority, request, library.id, connection);
    let proof = this.proofFor(user, library, connection, requested);
    if (!proof) {
      proof = await this.proveArtwork(authority, request, library, connection, session, requested);
      this.recheckContent(authority, request, library.id, connection);
      this.putProof(proof);
    }
    const currentTag = imageType === "Primary" ? proof.primaryImageTag : proof.backdropImageTag;
    const etagValue = currentTag === undefined ? undefined : size === "detail" ? `${currentTag}:detail` : currentTag;
    const etag = etagValue === undefined ? undefined : `"${etagValue}"`;
    if (etag !== undefined && ifNoneMatch !== undefined && ifNoneMatchMatches(ifNoneMatch, etag)) {
      this.recheckContent(authority, request, library.id, connection);
      return artworkNotModified(etag);
    }
    const response = await this.imageUpstream(connection, request, () =>
      session.transport.requestArtwork({
        itemId: requested,
        imageType,
        ...(tag === undefined ? {} : { tag }),
        ...(size === undefined ? {} : { size }),
      }, session.token, request));
    try {
      this.recheckContent(authority, request, library.id, connection);
      return this.scopedImage(authority, request, library, connection, response, etag);
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
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
   *  writes no upstream history. It always contacts the provider, and a success stores or
   *  refreshes the original proof a later open reuses; a failure past the local check drops it. */
  async revalidateOriginal(authority: MediaServerAuthority, ref: RemoteContentRef, signal?: AbortSignal, options?: { download?: boolean }): Promise<void> {
    const request = this.requestSignal(signal);
    if (!isRemoteContentRef(ref)) throw notFound("That media-server item does not exist.");
    if (ref.subtitleIndex !== undefined) throw notFound("That media-server item does not exist.");
    const { library, connection } = this.recheckRef(authority, request, ref);
    const user = this.currentActor(authority, request);
    try {
      const session = await this.liveSession(authority, connection, { libraryRemoteId: library.remoteId, download: options?.download === true }, request);
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
    } catch (error) {
      this.deleteOriginalProof(user.id, library.id, connection.id, connection.generation, connection.secretRef, ref.itemId, ref.mediaSourceId);
      throw error;
    }
    this.putOriginalProof({
      actorId: user.id,
      libraryId: library.id,
      connectionId: connection.id,
      generation: connection.generation,
      secretRef: connection.secretRef,
      itemId: ref.itemId,
      mediaSourceId: ref.mediaSourceId,
      at: this.clock(),
    });
  }

  /** Opens one original file over the binary transport. The local grant and the live session are
   *  repeated on every open; the item detail, ancestor chain and named version are skipped when
   *  the same source was proved within the last playback-guard interval. The token is read only
   *  for this operation, the byte read runs on the transport's own pool, and the result is
   *  re-checked before any body leaves the manager; a stale or denied result has its body
   *  cancelled. The request shares the manager lifetime, so a shutdown or a connection change
   *  aborts it. */
  async openOriginal(authority: MediaServerAuthority, ref: RemoteContentRef, args: { method: "GET" | "HEAD"; range?: string }, signal?: AbortSignal): Promise<Response> {
    const request = this.requestSignal(signal);
    if (!isRemoteContentRef(ref)) throw notFound("That media-server item does not exist.");
    if (ref.subtitleIndex !== undefined) throw notFound("That media-server item does not exist.");
    if (!args || (args.method !== "GET" && args.method !== "HEAD")) throw invalid("The media-server request method is not supported.");
    if (args.range !== undefined && (typeof args.range !== "string" || args.range.length > 128)) throw invalid("The media-server byte range is malformed.");
    const { library, connection } = this.recheckRef(authority, request, ref);
    const session = await this.liveSession(authority, connection, { libraryRemoteId: library.remoteId }, request);
    this.recheckRef(authority, request, ref);
    const user = this.currentActor(authority, request);
    if (!this.originalProofFor(user, library, connection, ref.itemId, ref.mediaSourceId)) {
      const item = await this.upstream(connection, request, () => session.provider.detail(session.token, connection.accountId, ref.itemId, request));
      this.recheckRef(authority, request, ref);
      if (item.id !== ref.itemId) throw new MediaServerError("invalid-response", "The media-server item identity changed.");
      const ancestors = await this.upstream(connection, request, () => session.provider.ancestors(session.token, connection.accountId, item.id, request));
      if (!ancestors.includes(library.remoteId)) throw notFound("That item is not in this library.");
      this.recheckRef(authority, request, ref);
      const versions = await this.upstream(connection, request, () => session.provider.versions(session.token, connection.accountId, item.id, request));
      this.recheckRef(authority, request, ref);
      if (!versions.some((version) => version.id === ref.mediaSourceId)) throw notFound("That media-server source is no longer available.");
      this.putOriginalProof({
        actorId: user.id,
        libraryId: library.id,
        connectionId: connection.id,
        generation: connection.generation,
        secretRef: connection.secretRef,
        itemId: ref.itemId,
        mediaSourceId: ref.mediaSourceId,
        at: this.clock(),
      });
    }
    const response = await this.originalUpstream(connection, request, () => session.transport.requestOriginal(
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

  /** Re-reads the records a durable download reference names and refuses when any moved: the
   *  actor is the owner, and the library grant, connection, identity and generation are the
   *  configured ones now. A download reference carries no session, so there is no sid or secret
   *  stamp to compare; the account's current secret is checked by `currentActor` alone. */
  private recheckDownloadRef(authority: MediaServerAuthority, signal: AbortSignal, reference: RemoteDownloadReference): { library: RemoteLibraryRecord; connection: MediaConnectionRecord } {
    const user = this.currentActor(authority, signal);
    if (user.id !== reference.ownerUserId) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
    const connections = this.store.mediaConnections();
    const library = this.store.remoteLibraries().find((candidate) => candidate.id === reference.libraryId);
    if (!library || library.connectionId !== reference.connectionId) throw notFound("That remote library does not exist.");
    if (!remoteLibraryVisibleTo(connections, library, user)) throw notFound("That remote library does not exist.");
    const connection = connections.find((candidate) => candidate.id === reference.connectionId);
    if (!connection || !connection.enabled || !connection.secretRef) throw invalid("That media-server connection is disabled.");
    if (connection.provider !== reference.provider || connection.serverId !== reference.serverId
      || connection.accountId !== reference.accountId || connection.generation !== reference.generation) throw stale();
    return { library, connection };
  }

  /** The live original behind a download reference: the item, its ancestor chain reaching the
   *  granted library and the named file version are read from the provider and re-checked after
   *  every await. A success is recorded in the same proof map playback uses, so a bounded window
   *  of opens costs one proof and a proof never crosses accounts, generations or sources. */
  private async proveDownloadOriginal(
    authority: MediaServerAuthority,
    signal: AbortSignal,
    reference: RemoteDownloadReference,
    library: RemoteLibraryRecord,
    connection: MediaConnectionRecord,
    session: LiveSession,
    user: UserRecord,
  ): Promise<void> {
    const item = await this.upstream(connection, signal, () => session.provider.detail(session.token, connection.accountId, reference.itemId, signal));
    this.recheckDownloadRef(authority, signal, reference);
    if (item.id !== reference.itemId) throw new MediaServerError("invalid-response", "The media-server item identity changed.");
    const ancestors = await this.upstream(connection, signal, () => session.provider.ancestors(session.token, connection.accountId, item.id, signal));
    if (!ancestors.includes(library.remoteId)) throw notFound("That item is not in this library.");
    this.recheckDownloadRef(authority, signal, reference);
    if (item.type !== "movie" && item.type !== "episode") throw invalid("That item has no playable media.");
    const versions = await this.upstream(connection, signal, () => session.provider.versions(session.token, connection.accountId, item.id, signal));
    this.recheckDownloadRef(authority, signal, reference);
    if (!versions.some((version) => version.id === reference.mediaSourceId)) throw notFound("That media-server source is no longer available.");
    this.putOriginalProof({
      actorId: user.id,
      libraryId: library.id,
      connectionId: connection.id,
      generation: connection.generation,
      secretRef: connection.secretRef,
      itemId: reference.itemId,
      mediaSourceId: reference.mediaSourceId,
      at: this.clock(),
    });
  }

  /** Proves a durable download reference still names a live, permitted original, with no session
   *  and no bytes. It always contacts the provider, and a failure past the local check drops any
   *  stored proof. The owner comes from the authority, never from the reference alone. */
  async revalidateDownloadOriginal(authority: MediaServerAuthority, reference: RemoteDownloadReference, signal?: AbortSignal): Promise<void> {
    const request = this.requestSignal(signal);
    if (!isRemoteDownloadReference(reference)) throw notFound("That media-server item does not exist.");
    const { library, connection } = this.recheckDownloadRef(authority, request, reference);
    const user = this.currentActor(authority, request);
    try {
      const session = await this.liveSession(authority, connection, { libraryRemoteId: library.remoteId, download: true }, request);
      this.recheckDownloadRef(authority, request, reference);
      await this.proveDownloadOriginal(authority, request, reference, library, connection, session, user);
    } catch (error) {
      this.deleteOriginalProof(user.id, library.id, connection.id, connection.generation, connection.secretRef, reference.itemId, reference.mediaSourceId);
      throw error;
    }
  }

  /** Opens one original file for a local library copy over the binary transport, with the same
   *  live-session and post-await checks playback uses. A recent original proof is reused; a miss
   *  reads the item, ancestor chain and version once. The result is re-checked before the body
   *  leaves the manager, and a stale or denied result has its body cancelled. */
  async openDownloadOriginal(authority: MediaServerAuthority, reference: RemoteDownloadReference, args: { method: "GET" | "HEAD"; range?: string }, signal?: AbortSignal): Promise<Response> {
    const request = this.requestSignal(signal);
    if (!isRemoteDownloadReference(reference)) throw notFound("That media-server item does not exist.");
    if (!args || (args.method !== "GET" && args.method !== "HEAD")) throw invalid("The media-server request method is not supported.");
    if (args.range !== undefined && (typeof args.range !== "string" || args.range.length > 128)) throw invalid("The media-server byte range is malformed.");
    const { library, connection } = this.recheckDownloadRef(authority, request, reference);
    const session = await this.liveSession(authority, connection, { libraryRemoteId: library.remoteId, download: true }, request);
    this.recheckDownloadRef(authority, request, reference);
    const user = this.currentActor(authority, request);
    if (!this.originalProofFor(user, library, connection, reference.itemId, reference.mediaSourceId)) {
      await this.proveDownloadOriginal(authority, request, reference, library, connection, session, user);
    }
    const response = await this.originalUpstream(connection, request, () => session.transport.requestOriginal(
      { itemId: reference.itemId, mediaSourceId: reference.mediaSourceId, method: args.method, ...(args.range === undefined ? {} : { range: args.range }) },
      session.token,
      request,
    ));
    const abortBody = () => { void response.body?.cancel().catch(() => undefined); };
    try {
      this.recheckDownloadRef(authority, request, reference);
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

  /** The proof map key: actor, library and connection generation/secret binding plus the item,
   *  so no proof can be read from another account, library or generation. */
  private proofKey(actorId: string, libraryId: string, connectionId: string, generation: number, secretRef: string | undefined, itemId: string): string {
    return [actorId, libraryId, connectionId, String(generation), secretRef ?? "", itemId].join("\u0000");
  }

  private proofFor(user: UserRecord, library: RemoteLibraryRecord, connection: MediaConnectionRecord, itemId: string): MembershipProof | undefined {
    const key = this.proofKey(user.id, library.id, connection.id, connection.generation, connection.secretRef, itemId);
    const proof = this.proofs.get(key);
    if (!proof) return undefined;
    if (this.clock() - proof.at > PROOF_TTL_MS) {
      this.proofs.delete(key);
      return undefined;
    }
    return proof;
  }

  private putProof(proof: MembershipProof): void {
    const key = this.proofKey(proof.actorId, proof.libraryId, proof.connectionId, proof.generation, proof.secretRef, proof.itemId);
    this.proofs.delete(key);
    this.proofs.set(key, proof);
    while (this.proofs.size > PROOF_MAX) {
      const oldest = this.proofs.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.proofs.delete(oldest);
    }
  }

  /** The original-proof key: the membership binding plus the media source, so a proof cannot
   *  authorize another account, library, generation or source. */
  private originalProofKey(actorId: string, libraryId: string, connectionId: string, generation: number, secretRef: string | undefined, itemId: string, mediaSourceId: string): string {
    return [actorId, libraryId, connectionId, String(generation), secretRef ?? "", itemId, mediaSourceId].join("\u0000");
  }

  private originalProofFor(user: UserRecord, library: RemoteLibraryRecord, connection: MediaConnectionRecord, itemId: string, mediaSourceId: string): OriginalProof | undefined {
    const key = this.originalProofKey(user.id, library.id, connection.id, connection.generation, connection.secretRef, itemId, mediaSourceId);
    const proof = this.originalProofs.get(key);
    if (!proof) return undefined;
    if (this.clock() - proof.at > ORIGINAL_PROOF_TTL_MS) {
      this.originalProofs.delete(key);
      return undefined;
    }
    return proof;
  }

  private putOriginalProof(proof: OriginalProof): void {
    const key = this.originalProofKey(proof.actorId, proof.libraryId, proof.connectionId, proof.generation, proof.secretRef, proof.itemId, proof.mediaSourceId);
    this.originalProofs.delete(key);
    this.originalProofs.set(key, proof);
    while (this.originalProofs.size > ORIGINAL_PROOF_MAX) {
      const oldest = this.originalProofs.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.originalProofs.delete(oldest);
    }
  }

  private deleteOriginalProof(actorId: string, libraryId: string, connectionId: string, generation: number, secretRef: string | undefined, itemId: string, mediaSourceId: string): void {
    this.originalProofs.delete(this.originalProofKey(actorId, libraryId, connectionId, generation, secretRef, itemId, mediaSourceId));
  }

  /** One proved member of a granted library, as a proof record. */
  private proofOf(user: UserRecord, library: RemoteLibraryRecord, connection: MediaConnectionRecord, item: ProviderItem): MembershipProof {
    return {
      actorId: user.id,
      libraryId: library.id,
      connectionId: connection.id,
      generation: connection.generation,
      secretRef: connection.secretRef,
      itemId: item.id,
      type: item.type,
      ...(item.hasPrimaryImage === undefined ? {} : { hasPrimaryImage: item.hasPrimaryImage }),
      ...(item.hasBackdropImage === undefined ? {} : { hasBackdropImage: item.hasBackdropImage }),
      ...(item.primaryImageTag === undefined ? {} : { primaryImageTag: item.primaryImageTag }),
      ...(item.backdropImageTag === undefined ? {} : { backdropImageTag: item.backdropImageTag }),
      at: this.clock(),
    };
  }

  private dropProofs(connectionId: string): void {
    for (const [key, proof] of [...this.proofs]) {
      if (proof.connectionId === connectionId) this.proofs.delete(key);
    }
    for (const [key, proof] of [...this.originalProofs]) {
      if (proof.connectionId === connectionId) this.originalProofs.delete(key);
    }
  }

  /** Proves one item belongs to a granted library, once: a library root is taken from the view
   *  list the live session already proved, so it never asks for an ancestor of itself, and any
   *  other id reads its detail and ancestor chain exactly once. The result is the proof a later
   *  image read reuses. */
  private async proveArtwork(
    authority: MediaServerAuthority,
    signal: AbortSignal,
    library: RemoteLibraryRecord,
    connection: MediaConnectionRecord,
    session: LiveSession,
    itemId: string,
  ): Promise<MembershipProof> {
    const user = this.currentActor(authority, signal);
    if (itemId === library.remoteId) {
      const view = session.libraries.find((entry) => entry.id === library.remoteId);
      return {
        actorId: user.id,
        libraryId: library.id,
        connectionId: connection.id,
        generation: connection.generation,
        secretRef: connection.secretRef,
        itemId,
        type: "folder",
        ...(view?.primaryImageTag === undefined ? {} : { hasPrimaryImage: true, primaryImageTag: view.primaryImageTag }),
        at: this.clock(),
      };
    }
    const item = await this.upstream(connection, signal, () => session.provider.detail(session.token, connection.accountId, itemId, signal));
    this.recheckContent(authority, signal, library.id, connection);
    if (item.id !== itemId) throw new MediaServerError("invalid-response", "The media-server item identity changed.");
    const ancestors = await this.upstream(connection, signal, () => session.provider.ancestors(session.token, connection.accountId, item.id, signal));
    if (!ancestors.includes(library.remoteId)) throw notFound("That item is not in this library.");
    this.recheckContent(authority, signal, library.id, connection);
    return this.proofOf(user, library, connection, item);
  }

  /** An image request never enters the metadata network lane: the transport owns its own
   *  bounded image pool, so an image burst cannot delay a browse or the playback guard. Only a
   *  401 is mapped the same way, as a reauthentication that drops the runtime and its caches. */
  private async imageUpstream<T>(connection: MediaConnectionRecord, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    this.checkLive(signal);
    try {
      return await work();
    } catch (error) {
      if (error instanceof MediaServerError && error.code === "authentication-required") this.markReauthentication(connection);
      throw error;
    }
  }

  /** An original byte read never enters the metadata network lane: the transport owns its own
   *  bounded original pool, so a range burst cannot delay a browse or the playback guard. Only a
   *  401 is mapped the same way, as a reauthentication that drops the runtime and its caches. */
  private async originalUpstream<T>(connection: MediaConnectionRecord, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    this.checkLive(signal);
    try {
      return await work();
    } catch (error) {
      if (error instanceof MediaServerError && error.code === "authentication-required") this.markReauthentication(connection);
      throw error;
    }
  }

  /** The image body as a private, no-cache stream that re-checks the local authority and the
   *  connection before every chunk and aborts the upstream read when the client goes away. */
  private scopedImage(
    authority: MediaServerAuthority,
    signal: AbortSignal,
    library: RemoteLibraryRecord,
    connection: MediaConnectionRecord,
    upstream: Response,
    etag: string | undefined,
  ): Response {
    if (upstream.status !== 200 || !upstream.body) {
      void upstream.body?.cancel().catch(() => undefined);
      throw new MediaServerError("unavailable", "The media-server image is unavailable.");
    }
    const headers = new Headers({
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": IMAGE_CACHE_CONTROL,
      "x-content-type-options": "nosniff",
    });
    if (etag !== undefined) headers.set("etag", etag);
    const reader = upstream.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          this.recheckContent(authority, signal, library.id, connection);
          const chunk = await reader.read();
          if (chunk.done) controller.close();
          else controller.enqueue(chunk.value);
        } catch (error) {
          void reader.cancel().catch(() => undefined);
          controller.error(error);
        }
      },
      cancel: (reason) => reader.cancel(reason).catch(() => undefined),
    });
    return new Response(body, { status: 200, headers });
  }

  /** Proves a requested browse parent sits inside the granted library and may be opened: the
   *  exact item, its ancestor chain reaching the library's remote id, and a folder, series or
   *  season kind. A fresh membership proof is reused when one exists, so a parent proved for a
   *  preview is not proved again for a browse; a miss reads the detail and ancestor chain once
   *  and records the proof. The library root is already proved by the live session. */
  private async proveParent(
    authority: MediaServerAuthority,
    signal: AbortSignal,
    library: RemoteLibraryRecord,
    connection: MediaConnectionRecord,
    session: { token: string; provider: MediaServerProvider },
    parentId: string,
  ): Promise<MembershipProof> {
    const user = this.currentActor(authority, signal);
    const cached = this.proofFor(user, library, connection, parentId);
    if (cached && (cached.type === "folder" || cached.type === "series" || cached.type === "season")) return cached;
    const parent = await this.upstream(connection, signal, () => session.provider.detail(session.token, connection.accountId, parentId, signal));
    this.recheckContent(authority, signal, library.id, connection);
    if (parent.id !== parentId) throw new MediaServerError("invalid-response", "The media-server item identity changed.");
    const ancestors = await this.upstream(connection, signal, () => session.provider.ancestors(session.token, connection.accountId, parent.id, signal));
    if (!ancestors.includes(library.remoteId)) throw notFound("That item is not in this library.");
    this.recheckContent(authority, signal, library.id, connection);
    if (parent.type !== "folder" && parent.type !== "series" && parent.type !== "season") throw invalid("That item cannot be browsed.");
    const proof = this.proofOf(user, library, connection, parent);
    this.putProof(proof);
    return proof;
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
    this.putProof(this.proofOf(this.currentActor(authority, signal), library, connection, item));
    return item;
  }

  /** The exact-id match re-applied to a freshly read item: a movie by its shared namespaced id,
   *  or an episode by season and a numeric episode covered by the row's own range, so a
   *  double-episode file still matches either of the numbers it spans. */
  private freshMatch(target: RemoteMatchTarget, item: ProviderItem): boolean {
    if (target.type === "movie") return item.type === "movie" && remoteIdsMatch(target.ids, item.providerIds);
    return episodeCovers(item, target);
  }

  /** An id this app does not match exactly is an empty answer, never an error, and it is
   *  produced without any upstream work once the local authority has been re-checked. */
  private async unmatchable(
    authority: MediaServerAuthority,
    request: AbortSignal,
    library: RemoteLibraryRecord,
    connection: MediaConnectionRecord,
  ): Promise<[]> {
    this.recheckContent(authority, request, library.id, connection);
    return [];
  }

  /** One live session, then one bounded provider-id query for one exact external id, shared by
   *  `matchingItems` and `matchedVersions`. A movie asks for the movie type in the library; an
   *  episode asks once for the series, then reads one parent-scoped season episode page and
   *  filters it by the season and the numeric episode or range locally. Every candidate is read
   *  again before it is accepted, so a row whose metadata moved mints nothing. */
  private async matchUnder(
    authority: MediaServerAuthority,
    request: AbortSignal,
    library: RemoteLibraryRecord,
    connection: MediaConnectionRecord,
    target: RemoteMatchTarget,
    nameHint: string | undefined,
  ): Promise<{ session: LiveSession; items: ProviderItem[] }> {
    const session = await this.liveSession(authority, connection, { libraryRemoteId: library.remoteId }, request);
    this.recheckContent(authority, request, library.id, connection);
    const items: ProviderItem[] = [];
    if (target.type === "movie") {
      const candidates = await this.upstream(connection, request, () =>
        session.provider.findByProviderIds(session.token, connection.accountId, library.remoteId, target.ids, "movie", nameHint, request));
      this.recheckContent(authority, request, library.id, connection);
      for (const candidate of candidates) {
        const fresh = await this.verifiedDetail(authority, request, library, connection, session, candidate.id);
        if (this.freshMatch(target, fresh)) items.push(fresh);
      }
      return { session, items };
    }
    const seriesCandidates = await this.upstream(connection, request, () =>
      session.provider.findByProviderIds(session.token, connection.accountId, library.remoteId, target.ids, "series", nameHint, request));
    this.recheckContent(authority, request, library.id, connection);
    let examined = 0;
    for (const candidate of seriesCandidates) {
      if (examined >= MATCH_CANDIDATE_MAX) throw new MediaServerError("response-too-large", "The media-server match has too many candidates.");
      examined += 1;
      const series = await this.verifiedDetail(authority, request, library, connection, session, candidate.id);
      if (series.type !== "series" || !remoteIdsMatch(target.ids, series.providerIds)) continue;
      const page = await this.upstream(connection, request, () => session.provider.pageDirectory(session.token, connection.accountId, series.id, {
        mode: "titles",
        type: "episode",
        season: target.season,
        limit: MATCH_EPISODE_PAGE_LIMIT,
        sort: "name",
        order: "asc",
      }, request));
      this.recheckContent(authority, request, library.id, connection);
      for (const row of page.items) {
        if (row.type !== "episode" || !episodeCovers(row, target)) continue;
        const fresh = await this.verifiedDetail(authority, request, library, connection, session, row.id);
        if (this.freshMatch(target, fresh)) items.push(fresh);
      }
      if (items.length > 0) break;
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
      this.failPacer(cached.pacer, stale());
      this.failPacer(cached.dispatchPacer, stale());
      void cached.transport.close().catch(() => undefined);
    }
    // A dropped runtime means the identity or the credential is no longer trusted: every proof
    // taken under that connection goes with it, so a 401 invalidates the membership cache too.
    this.dropProofs(connectionId);
    this.index.invalidateConnection(connectionId);
  }

  private cacheRuntime(connectionId: string, runtime: CachedRuntime): void {
    // A concurrent read can install a runtime for the same handle while a reauthentication
    // awaits its cleanup; closing any different runtime under the handle before replacing it
    // is what keeps a live binary transport from being orphaned outside the map.
    const existing = this.runtimes.get(connectionId);
    if (existing && existing !== runtime) {
      this.runtimes.delete(connectionId);
      this.failPacer(existing.pacer, stale());
      this.failPacer(existing.dispatchPacer, stale());
      void existing.transport.close().catch(() => undefined);
    }
    while (this.runtimes.size >= RUNTIME_MAX && !this.runtimes.has(connectionId)) {
      const oldest = this.runtimes.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const evicted = this.runtimes.get(oldest);
      this.runtimes.delete(oldest);
      if (evicted) {
        this.failPacer(evicted.pacer, stale());
        this.failPacer(evicted.dispatchPacer, stale());
        void evicted.transport.close().catch(() => undefined);
      }
    }
    this.runtimes.set(connectionId, runtime);
  }

  private providerFor(connection: MediaConnectionRecord): CachedRuntime {
    const cached = this.runtimes.get(connection.id);
    if (cached && cached.generation === connection.generation && cached.secretRef === connection.secretRef) return cached;
    if (cached) {
      this.runtimes.delete(connection.id);
      this.failPacer(cached.pacer, stale());
      this.failPacer(cached.dispatchPacer, stale());
      void cached.transport.close().catch(() => undefined);
    }
    const transport = this.transportFactory({ baseUrl: connection.baseUrl, allowLan: connection.allowLan, allowLoopback: connection.allowLoopback, deviceId: connection.id });
    const runtime = newRuntime(connection.generation, connection.secretRef, transport, this.providerFactory(connection.provider, transport));
    this.cacheRuntime(connection.id, runtime);
    return runtime;
  }

  /** The live permission check every read repeats: the credential is re-read from the vault, so
   *  a removed or changed key still fails closed, and the remote identity, account policy and
   *  view list are proved. Those three facts are cached for a short window per runtime; the
   *  local actor, the library grant and the connection are re-checked after every await, and the
   *  cached facts are re-validated on each use. Nothing here caches local authority. */
  private async liveSession(
    authority: MediaServerAuthority,
    connection: MediaConnectionRecord,
    options: { libraryRemoteId?: string; refresh?: boolean; download?: boolean },
    signal: AbortSignal,
  ): Promise<LiveSession> {
    this.checkLive(signal);
    if (!connection.secretRef) throw new MediaServerError("secret-unavailable", "That media-server connection has no stored credential.");
    const binding = { connectionId: connection.id, provider: connection.provider, serverId: connection.serverId, accountId: connection.accountId };
    const runtime = this.providerFor(connection);
    const token = await this.serializedCredential(() => this.vault.get(binding, connection.secretRef as string));
    this.recheckConnection(authority, signal, connection);
    try {
      const facts = await this.runtimeFacts(runtime, connection, token, signal, options.refresh === true);
      this.recheckConnection(authority, signal, connection);
      if (facts.serverId !== connection.serverId) {
        this.markIdentityChanged(connection);
        throw identityChanged();
      }
      if (facts.accountId !== connection.accountId) {
        this.markIdentityChanged(connection);
        throw identityChanged();
      }
      const policy = facts.policy;
      if (policy.disabled) throw new MediaServerError("unavailable", "The media-server account is disabled.");
      if (!policy.mediaPlayback) throw new MediaServerError("forbidden", "The media-server account may not play.");
      // Downloading is a separate native permission: a playable account that may not download is
      // refused here, and only here, so ordinary playback stays unaffected.
      if (options.download === true && policy.contentDownloading !== true) throw new MediaServerError("forbidden", "The media-server account may not download.");
      if (policy.hasAdditionalRestrictions) throw new MediaServerError("unsupported-policy", "The media-server account has unsupported restrictions.");
      this.markAvailable(connection);
      if (options.libraryRemoteId !== undefined) {
        if (!facts.libraries.some((library) => library.id === options.libraryRemoteId)) throw notFound("That remote library is not visible to the account.");
        if (!policy.allFolders && !policy.folderIds.includes(options.libraryRemoteId)) {
          throw new MediaServerError("forbidden", "The media-server account cannot reach that library.");
        }
      }
      return { token, provider: runtime.provider, transport: runtime.transport, libraries: facts.libraries, policy };
    } catch (error) {
      if (error instanceof MediaServerError && error.code === "authentication-required") this.markReauthentication(connection);
      throw error;
    }
  }

  /** The remote facts behind one live session, cached for a short window on the runtime. A miss
   *  stages each read through the network lane and coalesces identical in-flight reads, so a
   *  burst of callers proves the identity, policy and views once. The token is only used here,
   *  never stored on the runtime, so the vault's fail-closed invariant still holds. */
  private async runtimeFacts(runtime: CachedRuntime, connection: MediaConnectionRecord, token: string, signal: AbortSignal, refresh: boolean): Promise<SessionFacts> {
    const cached = runtime.session;
    if (!refresh && cached && this.clock() - cached.at < SESSION_FACTS_TTL_MS) return cached;
    const identity = await this.coalesced(runtime, "identity", signal, (inner) => runtime.provider.verifyIdentity(inner));
    this.checkLive(signal);
    const account = await this.coalesced(runtime, `account:${connection.accountId}`, signal, (inner) => runtime.provider.currentAccount(token, connection.accountId, inner));
    this.checkLive(signal);
    const libraries = await this.coalesced(runtime, `views:${connection.accountId}`, signal, (inner) => runtime.provider.listLibraries(token, connection.accountId, inner));
    this.checkLive(signal);
    const facts: SessionFacts = { serverId: identity.serverId, accountId: account.accountId, policy: account.policy, libraries, at: this.clock() };
    runtime.session = facts;
    return facts;
  }

  /** Stage starts before reserving a slot; pace actual dispatch again after a saturated
   *  global lane so delayed admissions cannot arrive upstream as a catch-up burst. */
  private async net<T>(runtime: CachedRuntime | undefined, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    if (runtime) await this.pace(runtime.pacer, signal);
    await this.acquireNet(signal);
    try {
      if (runtime) await this.pace(runtime.dispatchPacer, signal);
      this.checkLive(signal);
      return await work();
    } finally {
      this.releaseNet();
    }
  }

  /** Wait for this connection's next start slot. A start is admitted at once when the interval
   *  has already elapsed and nobody is waiting; otherwise the caller joins a bounded, abortable
   *  FIFO queue. Idle time never accrues credit, so a burst after a quiet spell is still spaced
   *  rather than released all at once. */
  private pace(pacer: RuntimePacer, signal: AbortSignal): Promise<void> {
    const interval = this.networkStartIntervalMs;
    if (interval <= 0) return Promise.resolve();
    const now = Date.now();
    if (pacer.waiters.length === 0 && now - pacer.lastStart >= interval) {
      pacer.lastStart = now;
      return Promise.resolve();
    }
    if (pacer.waiters.length >= PACER_QUEUE_MAX) return Promise.reject(busy("Too many media-server requests are queued."));
    return new Promise<void>((resolve, reject) => {
      const waiter: PacerWaiter = { signal, settled: false, onAbort: () => undefined, admit: resolve, fail: reject };
      waiter.onAbort = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = pacer.waiters.indexOf(waiter);
        if (index !== -1) pacer.waiters.splice(index, 1);
        // An emptied queue must not leave a stale pump holding the event loop open.
        if (pacer.waiters.length === 0 && pacer.timer) { clearTimeout(pacer.timer); pacer.timer = undefined; }
        reject(this.closed ? closedError() : cancelled());
      };
      pacer.waiters.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.pumpPacer(pacer);
    });
  }

  /** Admit every waiter whose start is due, in arrival order, then arm one timer for the next.
   *  A single pending timer drives the whole queue, so a burst never schedules a timer per
   *  waiter and the queue stays a plain array. */
  private pumpPacer(pacer: RuntimePacer): void {
    if (pacer.timer) return;
    for (;;) {
      if (pacer.waiters.length === 0) return;
      const now = Date.now();
      if (now - pacer.lastStart < this.networkStartIntervalMs) {
        const delay = Math.max(1, pacer.lastStart + this.networkStartIntervalMs - now);
        pacer.timer = setTimeout(() => { pacer.timer = undefined; this.pumpPacer(pacer); }, delay);
        return;
      }
      const waiter = pacer.waiters.shift() as PacerWaiter;
      waiter.settled = true;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      pacer.lastStart = now;
      waiter.admit();
    }
  }

  /** Fail every waiter still queued for a pacer (a dropped or closing runtime): no abort listener
   *  outlives the wait and the timer is cleared so a stale pump cannot fire. */
  private failPacer(pacer: RuntimePacer, error: MediaServerError): void {
    if (pacer.timer) { clearTimeout(pacer.timer); pacer.timer = undefined; }
    while (pacer.waiters.length > 0) {
      const waiter = pacer.waiters.shift() as PacerWaiter;
      waiter.settled = true;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.fail(error);
    }
  }

  /** Reserve a live slot at once, or wait in the FIFO queue for one to be handed over. On
   *  success the slot is already counted; a rejection (abort, close or a full queue) leaves the
   *  counter untouched. No abort listener outlives the wait in any of those paths. */
  private acquireNet(signal: AbortSignal): Promise<void> {
    this.checkLive(signal);
    if (this.activeNetwork < this.networkMax) {
      this.activeNetwork += 1;
      return Promise.resolve();
    }
    if (this.netWaiters.length >= NET_QUEUE_MAX) return Promise.reject(busy("Too many media-server requests are queued."));
    return new Promise<void>((resolve, reject) => {
      const waiter: NetWaiter = { signal, settled: false, onAbort: () => undefined, admit: resolve, fail: reject };
      waiter.onAbort = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = this.netWaiters.indexOf(waiter);
        if (index !== -1) this.netWaiters.splice(index, 1);
        reject(this.closed ? closedError() : cancelled());
      };
      this.netWaiters.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  private releaseNet(): void {
    this.activeNetwork -= 1;
    while (this.activeNetwork < this.networkMax && this.netWaiters.length > 0) {
      const waiter = this.netWaiters.shift() as NetWaiter;
      waiter.settled = true;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      this.activeNetwork += 1;
      waiter.admit();
    }
  }

  /** A provider call that also revokes the runtime on an authentication refusal: a 401 from
   *  any operation, not only the preflight, means the cached token is no longer usable. */
  private async upstream<T>(connection: MediaConnectionRecord, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    try {
      return await this.net(this.liveRuntime(connection), signal, work);
    } catch (error) {
      if (error instanceof MediaServerError && error.code === "authentication-required") this.markReauthentication(connection);
      throw error;
    }
  }

  /** The cached runtime a connection's content call belongs to, or undefined when it is not
   *  installed; pacing then simply does not apply. */
  private liveRuntime(connection: MediaConnectionRecord): CachedRuntime | undefined {
    const cached = this.runtimes.get(connection.id);
    return cached && cached.generation === connection.generation && cached.secretRef === connection.secretRef ? cached : undefined;
  }

  /** Share one in-flight metadata read with every caller asking for the same key on the same
   *  runtime. The read runs under a dedicated controller combined with the manager lifetime, so
   *  it stops only when the last subscriber leaves and never inherits one caller's abort. A
   *  settled entry is dropped at once; nothing about a permission result is cached. */
  private coalesced<T>(runtime: CachedRuntime, key: string, signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.checkLive(signal);
    if (!this.coalesceReads) return this.net(runtime, signal, () => work(signal));
    const existing = runtime.inflight.get(key);
    if (existing) return this.joinInflight<T>(runtime, key, existing, signal);
    const controller = new AbortController();
    const entry: InflightRead = { promise: Promise.resolve(), controller, subscribers: 0 };
    const combined = AbortSignal.any([this.lifetime.signal, controller.signal]);
    entry.promise = this.net(runtime, combined, () => work(combined)).finally(() => {
      if (runtime.inflight.get(key) === entry) runtime.inflight.delete(key);
    });
    // The read may outlive every subscriber; keep its rejection handled so it can never surface
    // as an unhandled rejection, and drop it from the map the moment it settles.
    void entry.promise.catch(() => undefined);
    runtime.inflight.set(key, entry);
    return this.joinInflight<T>(runtime, key, entry, signal);
  }

  /** Subscribe to a shared read. This caller's own signal cancels only its wait; the underlying
   *  read is cancelled when the last subscriber leaves, so one abort never hurts another. */
  private joinInflight<T>(runtime: CachedRuntime, key: string, entry: InflightRead, signal: AbortSignal): Promise<T> {
    this.checkLive(signal);
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (settle: () => void): void => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        settle();
      };
      const onAbort = (): void => {
        entry.subscribers -= 1;
        if (entry.subscribers <= 0) {
          if (runtime.inflight.get(key) === entry) runtime.inflight.delete(key);
          entry.controller.abort();
        }
        finish(() => reject(this.closed ? closedError() : cancelled()));
      };
      entry.subscribers += 1;
      signal.addEventListener("abort", onAbort, { once: true });
      entry.promise.then(
        (value) => finish(() => resolve(value as T)),
        (error) => finish(() => reject(error)),
      );
    });
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
