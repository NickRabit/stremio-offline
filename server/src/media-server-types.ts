import { createHash, randomBytes } from "node:crypto";
import type { ProviderItem } from "./media-server-provider.js";
import type { AddonDownloadSettings } from "./types.js";

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

/** How a remote library is listed natively: one provider page per request. `folders` walks the
 *  library hierarchy (`Recursive=false`, `Folder` admitted), `titles` lists the media titles
 *  (`Recursive=true`, no `Folder`). */
export type RemoteBrowseMode = "folders" | "titles";
export const REMOTE_BROWSE_MODES: readonly RemoteBrowseMode[] = ["folders", "titles"];

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
  /** Optional, backward-compatible display settings. Absent stays absent on the record so an
   *  old record, export or backup keeps its exact shape; the projection resolves the default. */
  browseMode?: RemoteBrowseMode;
  mosaic?: boolean;
  showInFavorites?: boolean;
  /** The local library copies of this remote library's originals are saved into. Absent means
   *  the default for the kind; an explicitly stored handle that is gone stays stored and is
   *  refused at the door rather than redirected elsewhere. */
  downloadLibraryId?: string;
  /** How automatic copies of this library's originals are stored: the same two per-kind rules an
   *  addon carries. Absent means the legacy behaviour -- the record's `downloadLibraryId` handle
   *  when there is one, otherwise the kind's default destination with an empty subfolder and the
   *  structured layout. A stored rule that names a destination gone from this machine stays
   *  stored and is refused at the door rather than redirected elsewhere. */
  downloadSettings?: AddonDownloadSettings;
}

/** The effective browse mode of a record: an explicit choice wins, otherwise a mixed library
 *  (Emby Music, say) is a folder tree and a movie or series library is a flat title list. */
export const effectiveBrowseMode = (record: Pick<RemoteLibraryRecord, "type" | "browseMode">): RemoteBrowseMode =>
  record.browseMode === "folders" || record.browseMode === "titles"
    ? record.browseMode
    : record.type === "mixed" ? "folders" : "titles";

/** Whether the mosaic preview is on: only an explicit `false` turns it off. */
export const effectiveMosaic = (record: Pick<RemoteLibraryRecord, "mosaic">): boolean => record.mosaic !== false;

/** Whether the library feeds the favourites destination: only an explicit `false` opts out. */
export const effectiveShowInFavorites = (record: Pick<RemoteLibraryRecord, "showInFavorites">): boolean =>
  record.showInFavorites !== false;

export interface RemoteCapabilities {
  rename: false;
  move: false;
  delete: false;
  identify: false;
  writeArtwork: false;
  /** The flags a trusted source projection may turn on: an original the acting account may copy
   *  into a local library, and one it may take to the device it is using. Both are proved by the
   *  account's own right and by what the media server lets that account download, never from
   *  caller fields; nothing else about a remote original is ever true. */
  downloadToLibrary: boolean;
  downloadToDevice: boolean;
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
  poster?: string;
  id: string;
  connectionId: string;
  remoteId: string;
  name: string;
  type: RemoteLibraryType;
  enabled: boolean;
  order: number;
  showOnHome: boolean;
  showInContinueWatching: boolean;
  /** Resolved display settings: the effective values the interface renders. */
  browseMode: RemoteBrowseMode;
  mosaic: boolean;
  showInFavorites: boolean;
  /** The stored copy destination, when one is configured for this library. */
  downloadLibraryId?: string;
  /** The stored storage rules for automatic copies, when this library has its own. */
  downloadSettings?: AddonDownloadSettings;
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
  browseMode: effectiveBrowseMode(record),
  mosaic: effectiveMosaic(record),
  showInFavorites: effectiveShowInFavorites(record),
  ...(record.downloadLibraryId === undefined ? {} : { downloadLibraryId: record.downloadLibraryId }),
  ...(record.downloadSettings === undefined ? {} : { downloadSettings: structuredClone(record.downloadSettings) }),
  capabilities: READ_ONLY_MEDIA_CAPABILITIES,
  ...(provider === undefined ? {} : { provider }),
});

export const adminRemoteLibrary = (record: RemoteLibraryRecord, provider?: MediaServerKind): PublicRemoteLibrary & { allowedUsers: string[] } => ({
  ...publicRemoteLibrary(record, provider),
  allowedUsers: [...record.allowedUsers],
});

/** A provider item as the interface may see it: the internal shape (never an image flag or an
 *  image tag) plus the same-origin artwork paths the client loads instead of any upstream
 *  address. A path is omitted only when the provider metadata proves that role absent, so an
 *  unknown fact keeps the legacy URL. Two optional paths built from an encoded local library and
 *  item handle, a fixed image role and a validated tag can never turn a cached provider row into
 *  a client-admitted URL. */
export type PublicRemoteItem = Omit<ProviderItem, "hasPrimaryImage" | "hasBackdropImage" | "hasThumbImage" | "primaryImageTag" | "backdropImageTag" | "thumbImageTag"> & { poster?: string; wide?: string; fanart?: string };

/** The one shape an artwork tag may take: bounded, URL-safe and credential-free, so it can travel
 *  in a query string verbatim and never smuggle a remote path, query or address. */
export const ARTWORK_TAG = /^[A-Za-z0-9._~-]{1,128}$/;

export function validateArtworkTag(value: unknown): string {
  if (typeof value !== "string" || !ARTWORK_TAG.test(value)) {
    throw new MediaServerError("invalid-input", "The media-server artwork tag is not allowed.");
  }
  return value;
}

export const remoteArtworkPath = (libraryId: string, itemId: string, imageType: "Primary" | "Backdrop" | "Thumb", tag?: string): string => {
  const path = `/api/remote-libraries/${encodeURIComponent(libraryId)}/items/${encodeURIComponent(itemId)}/artwork/${imageType}`;
  return tag === undefined ? path : `${path}?tag=${encodeURIComponent(tag)}`;
};

/** The picture a wide tile draws: the provider's landscape Thumb when the row has one, else its
 *  Backdrop. A role the metadata proved absent is omitted, and a row that names neither keeps no
 *  wide path at all. The Backdrop is also carried as `fanart`, which is what a full-bleed hero
 *  reads; a tile never does. */
export const publicRemoteItem = (item: ProviderItem, libraryId: string): PublicRemoteItem => {
  const thumb = item.thumbImageTag === undefined ? undefined : remoteArtworkPath(libraryId, item.id, "Thumb", item.thumbImageTag);
  const backdrop = item.hasBackdropImage === false ? undefined : remoteArtworkPath(libraryId, item.id, "Backdrop", item.backdropImageTag);
  const wide = thumb ?? backdrop;
  return {
    ...scrubInternalItemFields(item),
    ...(item.hasPrimaryImage === false ? {} : { poster: remoteArtworkPath(libraryId, item.id, "Primary", item.primaryImageTag) }),
    ...(wide === undefined ? {} : { wide }),
    ...(backdrop === undefined ? {} : { fanart: backdrop }),
  };
};

/** Internal provider-only facts never reach a client projection. A captured tag proves the exact
 *  image version the manager must ask for; the resolved tag role is carried on the public URL, so
 *  the raw tags never leave the server. */
const scrubInternalItemFields = (item: ProviderItem): Omit<ProviderItem, "hasPrimaryImage" | "hasBackdropImage" | "hasThumbImage" | "primaryImageTag" | "backdropImageTag" | "thumbImageTag"> => {
  if (item.hasPrimaryImage === undefined && item.hasBackdropImage === undefined
    && item.hasThumbImage === undefined && item.primaryImageTag === undefined
    && item.backdropImageTag === undefined && item.thumbImageTag === undefined) return item;
  const clone: ProviderItem = { ...item };
  delete clone.hasPrimaryImage;
  delete clone.hasBackdropImage;
  delete clone.hasThumbImage;
  delete clone.primaryImageTag;
  delete clone.backdropImageTag;
  delete clone.thumbImageTag;
  return clone;
};

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
  | "playback-not-allowed"
  | "no-compatible-stream"
  | "bitrate-limit"
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
