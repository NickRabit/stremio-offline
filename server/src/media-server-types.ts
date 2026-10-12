import { createHash, randomBytes } from "node:crypto";
import type { ProviderItem } from "./media-server-provider.js";

export type MediaServerKind = "jellyfin" | "emby";
export const MEDIA_SERVER_KINDS: readonly MediaServerKind[] = ["jellyfin", "emby"];

/** The canonical remote identity of one item. Not a local handle: a connection or a URL is
 *  never identity, so reattaching the same verified account keeps the same key. */
export interface RemoteIdentity {
  provider: MediaServerKind;
  serverId: string;
  accountId: string;
  itemId: string;
}

export const remoteProgressKey = (identity: RemoteIdentity): string =>
  `remote:${createHash("sha256")
    .update(JSON.stringify([identity.provider, identity.serverId, identity.accountId, identity.itemId]))
    .digest("hex")}`;

/** Local handles for remote records. `mconn_`/`rlib_` + 32 lowercase hex cannot pass the
 *  filesystem matchers (`lib_` + 8 hex), so a remote id is never mistaken for a local one. */
export const MEDIA_CONNECTION_ID = /^mconn_[0-9a-f]{32}$/;
export const REMOTE_LIBRARY_ID = /^rlib_[0-9a-f]{32}$/;
export const MEDIA_SECRET_REF = /^msecret_[0-9a-f]{32}$/;

export const newConnectionId = (): string => `mconn_${randomBytes(16).toString("hex")}`;
export const newRemoteLibraryId = (): string => `rlib_${randomBytes(16).toString("hex")}`;
export const newSecretRef = (): string => `msecret_${randomBytes(16).toString("hex")}`;

export const MEDIA_SERVER_LIMITS = Object.freeze({
  name: 256,
  upstreamId: 512,
  url: 2048,
  token: 8192,
  allowedUsersPerLibrary: 1024,
  connections: 128,
  libraries: 1024,
  requestBody: 16 * 1024,
  responseBody: 2 * 1024 * 1024,
  secretCleanup: 2048,
});

export type RemoteLibraryType = "movie" | "series" | "mixed";

export interface MediaConnectionRecord {
  id: string;
  provider: MediaServerKind;
  name: string;
  baseUrl: string;
  allowLan: boolean;
  allowLoopback: boolean;
  serverId: string;
  accountId: string;
  enabled: boolean;
  generation: number;
  secretRef?: string;
  addedAt: string;
}

export interface RemoteLibraryRecord {
  id: string;
  connectionId: string;
  remoteId: string;
  name: string;
  type: RemoteLibraryType;
  enabled: boolean;
  order: number;
  allowedUsers: string[];
  showOnHome: boolean;
  showInContinueWatching: boolean;
}

export interface RemoteCapabilities {
  rename: false;
  move: false;
  delete: false;
  identify: false;
  writeArtwork: false;
  downloadToLibrary: false;
  downloadToDevice: false;
}

export const READ_ONLY_MEDIA_CAPABILITIES: RemoteCapabilities = Object.freeze({
  rename: false,
  move: false,
  delete: false,
  identify: false,
  writeArtwork: false,
  downloadToLibrary: false,
  downloadToDevice: false,
});

export interface PublicMediaConnection {
  id: string;
  provider: MediaServerKind;
  name: string;
  enabled: boolean;
  generation: number;
  configured: boolean;
}

export const publicMediaConnection = (record: MediaConnectionRecord): PublicMediaConnection => ({
  id: record.id,
  provider: record.provider,
  name: record.name,
  enabled: record.enabled,
  generation: record.generation,
  configured: Boolean(record.secretRef),
});

export interface AdminMediaConnection {
  id: string;
  provider: MediaServerKind;
  name: string;
  baseUrl: string;
  allowLan: boolean;
  allowLoopback: boolean;
  serverId: string;
  accountId: string;
  enabled: boolean;
  generation: number;
  configured: boolean;
}

export const adminMediaConnection = (record: MediaConnectionRecord): AdminMediaConnection => ({
  id: record.id,
  provider: record.provider,
  name: record.name,
  baseUrl: record.baseUrl,
  allowLan: record.allowLan,
  allowLoopback: record.allowLoopback,
  serverId: record.serverId,
  accountId: record.accountId,
  enabled: record.enabled,
  generation: record.generation,
  configured: Boolean(record.secretRef),
});

export interface PublicRemoteLibrary {
  id: string;
  connectionId: string;
  remoteId: string;
  name: string;
  type: RemoteLibraryType;
  enabled: boolean;
  order: number;
  showOnHome: boolean;
  showInContinueWatching: boolean;
  capabilities: RemoteCapabilities;
  /** The provider of the stored connection, when it still exists. Never a secret or address. */
  provider?: MediaServerKind;
}

export const publicRemoteLibrary = (record: RemoteLibraryRecord, provider?: MediaServerKind): PublicRemoteLibrary => ({
  id: record.id,
  connectionId: record.connectionId,
  remoteId: record.remoteId,
  name: record.name,
  type: record.type,
  enabled: record.enabled,
  order: record.order,
  showOnHome: record.showOnHome,
  showInContinueWatching: record.showInContinueWatching,
  capabilities: READ_ONLY_MEDIA_CAPABILITIES,
  ...(provider === undefined ? {} : { provider }),
});

export const adminRemoteLibrary = (record: RemoteLibraryRecord, provider?: MediaServerKind): PublicRemoteLibrary & { allowedUsers: string[] } => ({
  ...publicRemoteLibrary(record, provider),
  allowedUsers: [...record.allowedUsers],
});

/** A provider item as the interface may see it: the internal shape plus the two same-origin
 *  artwork paths the client loads instead of any upstream address. Built only from an encoded
 *  local library and item handle and a fixed image role, so a cached provider row can never
 *  turn into a client-admitted URL. */
export type PublicRemoteItem = ProviderItem & { poster: string; wide: string };

export const remoteArtworkPath = (libraryId: string, itemId: string, imageType: "Primary" | "Backdrop"): string =>
  `/api/remote-libraries/${encodeURIComponent(libraryId)}/items/${encodeURIComponent(itemId)}/artwork/${imageType}`;

export const publicRemoteItem = (item: ProviderItem, libraryId: string): PublicRemoteItem => ({
  ...item,
  poster: remoteArtworkPath(libraryId, item.id, "Primary"),
  wide: remoteArtworkPath(libraryId, item.id, "Backdrop"),
});

export type MediaServerErrorCode =
  | "invalid-input"
  | "unsafe-address"
  | "timeout"
  | "cancelled"
  | "busy"
  | "closed"
  | "authentication-required"
  | "forbidden"
  | "not-found"
  | "rate-limited"
  | "unavailable"
  | "invalid-response"
  | "response-too-large"
  | "stale-generation"
  | "identity-changed"
  | "unsupported-policy"
  | "secret-key-unavailable"
  | "secret-unavailable";

/** The single failure type for these modules. It carries a stable code plus fixed English
 *  text: upstream payloads, tokens, raw URLs and remote error messages never reach it. */
export class MediaServerError extends Error {
  constructor(
    readonly code: MediaServerErrorCode,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "MediaServerError";
  }
}

export const isMediaServerError = (value: unknown): value is MediaServerError =>
  value instanceof MediaServerError;

/** A provider-issued bearer token used in a quoted `Authorization` header. Printable ASCII
 *  with neither quote nor backslash, so it can be quoted verbatim; shared by transport and
 *  vault so a token one accepts the other accepts too. */
export function validateMediaServerToken(token: unknown): string {
  if (typeof token !== "string" || token.length === 0 || token.length > MEDIA_SERVER_LIMITS.token) {
    throw new MediaServerError("invalid-input", "The token is missing or too long.");
  }
  for (let index = 0; index < token.length; index += 1) {
    const code = token.charCodeAt(index);
    if (code < 0x21 || code > 0x7e || code === 0x22 || code === 0x5c) {
      throw new MediaServerError("invalid-input", "The token contains a character that cannot be sent.");
    }
  }
  return token;
}
