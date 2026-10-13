import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  MEDIA_CONNECTION_ID,
  MEDIA_SERVER_KINDS,
  MEDIA_SERVER_LIMITS,
  REMOTE_LIBRARY_ID,
  type MediaServerKind,
  type RemoteIdentity,
} from "./media-server-types.js";
import type { StreamItem } from "./types.js";

/** The session that asked for one remote original, and the proof it was signed in to the
 *  account this reference was sealed for. `secretStamp` is what notices a password change. */
export interface RemoteContentOwner {
  userId: string;
  sid: string;
  expiresAt: number;
  secretStamp: string;
}

/** A trusted original-file source: the verified identity of one item, the local handles it
 *  was reached through, and the session that asked. It is never read from a request body or
 *  an addon field. `generation` is the connection generation at seal time. */
export interface RemoteContentRef extends RemoteIdentity {
  connectionId: string;
  libraryId: string;
  generation: number;
  mediaSourceId: string;
  /** Present only on a sealed external-subtitle address: the provider's own subtitle index. */
  subtitleIndex?: number;
  owner: RemoteContentOwner;
}

const SEAL_SCHEME = "media-server:";
const SEAL_MAX = 16_384;
const PAYLOAD_MAX = 8_192;
const ID_MAX = MEDIA_SERVER_LIMITS.upstreamId;
const OWNER_ID_MAX = 512;
const HEX64 = /^[0-9a-f]{64}$/;
const SEGMENT_BAD = /[/\\?#%\u0000-\u001f\u007f]/;
const REF_KEYS: readonly string[] = ["provider", "serverId", "accountId", "itemId", "connectionId", "libraryId", "generation", "mediaSourceId", "owner"];
const SUBTITLE_INDEX_KEY = "subtitleIndex";
const SUBTITLE_INDEX_MAX = 1023;
const OWNER_KEYS = ["userId", "sid", "expiresAt", "secretStamp"] as const;

/** A module-private random key. The seal is an in-process address, not a portable token:
 *  it intentionally does not survive a restart, when the source registry is gone too. */
const sealKey = randomBytes(32);

export const remoteSecretStamp = (secret: string): string => createHash("sha256").update(secret).digest("hex");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Only an own data property is read, so an inherited value or an accessor cannot stand in
 *  for a field that was never written. */
const ownValue = (record: Record<string, unknown>, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};

const exactKeys = (record: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(record).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(record, key));

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

/** The base keys exactly, plus the one optional subtitle index: nothing else. */
const refKeysValid = (keys: readonly string[]): boolean =>
  keys.length >= REF_KEYS.length
  && REF_KEYS.every((key) => keys.includes(key))
  && keys.every((key) => REF_KEYS.includes(key) || key === SUBTITLE_INDEX_KEY);

const isSegmentId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= ID_MAX
  && !SEGMENT_BAD.test(value) && value !== "." && value !== "..";

const isSubtitleIndex = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= SUBTITLE_INDEX_MAX;

const isOwnerId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= OWNER_ID_MAX;

const isOwner = (value: unknown): value is RemoteContentOwner => {
  if (!isRecord(value) || !exactKeys(value, OWNER_KEYS)) return false;
  const userId = ownValue(value, "userId");
  const sid = ownValue(value, "sid");
  const expiresAt = ownValue(value, "expiresAt");
  const secretStamp = ownValue(value, "secretStamp");
  return isOwnerId(userId) && isOwnerId(sid)
    && typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) && expiresAt > 0
    && typeof secretStamp === "string" && HEX64.test(secretStamp);
};

/** Whether a value is a well-formed reference. Structural only: it proves nothing about the
 *  records behind it, which callers check against the live state. */
export const isRemoteContentRef = (value: unknown): value is RemoteContentRef => {
  if (!isRecord(value)) return false;
  const keys = plainKeys(value);
  if (!keys || !refKeysValid(keys)) return false;
  const provider = ownValue(value, "provider");
  const serverId = ownValue(value, "serverId");
  const accountId = ownValue(value, "accountId");
  const itemId = ownValue(value, "itemId");
  const connectionId = ownValue(value, "connectionId");
  const libraryId = ownValue(value, "libraryId");
  const generation = ownValue(value, "generation");
  const mediaSourceId = ownValue(value, "mediaSourceId");
  const owner = ownValue(value, "owner");
  const subtitleIndex = ownValue(value, SUBTITLE_INDEX_KEY);
  return MEDIA_SERVER_KINDS.includes(provider as MediaServerKind)
    && isSegmentId(serverId) && isSegmentId(accountId) && isSegmentId(itemId) && isSegmentId(mediaSourceId)
    && typeof connectionId === "string" && MEDIA_CONNECTION_ID.test(connectionId)
    && typeof libraryId === "string" && REMOTE_LIBRARY_ID.test(libraryId)
    && typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0
    && (subtitleIndex === undefined || isSubtitleIndex(subtitleIndex))
    && isOwner(owner);
};

const canonical = (ref: RemoteContentRef): RemoteContentRef => ({
  provider: ref.provider,
  serverId: ref.serverId,
  accountId: ref.accountId,
  itemId: ref.itemId,
  connectionId: ref.connectionId,
  libraryId: ref.libraryId,
  generation: ref.generation,
  mediaSourceId: ref.mediaSourceId,
  ...(ref.subtitleIndex === undefined ? {} : { subtitleIndex: ref.subtitleIndex }),
  owner: {
    userId: ref.owner.userId,
    sid: ref.owner.sid,
    expiresAt: ref.owner.expiresAt,
    secretStamp: ref.owner.secretStamp,
  },
});

const payloadOf = (ref: RemoteContentRef): string => Buffer.from(JSON.stringify(canonical(ref)), "utf8").toString("base64url");
const signatureOf = (payload: string): string => createHmac("sha256", sealKey).update(payload).digest("hex");

/** Seals one reference into an internal address. The result is never a public or upstream
 *  URL; the caller is the only place such an address may be minted for a verified item. */
export const sealRemoteContent = (ref: RemoteContentRef): string => {
  if (!isRemoteContentRef(ref)) throw new Error("The media-server reference is malformed.");
  const payload = payloadOf(ref);
  if (payload.length === 0 || payload.length > PAYLOAD_MAX) throw new Error("The media-server reference is too large.");
  const sealed = `${SEAL_SCHEME}${payload}.${signatureOf(payload)}`;
  if (sealed.length > SEAL_MAX) throw new Error("The media-server reference is too large.");
  return sealed;
};

/** Opens a sealed address, proving the signature, the canonical encoding and every field
 *  before handing back a fresh clone. An expiry decision is not made here: the caller
 *  validates the current owner. */
export const openRemoteContent = (url: unknown): RemoteContentRef | undefined => {
  if (typeof url !== "string" || url.length === 0 || url.length > SEAL_MAX || !url.startsWith(SEAL_SCHEME)) return undefined;
  const body = url.slice(SEAL_SCHEME.length);
  const dot = body.indexOf(".");
  if (dot <= 0 || dot !== body.lastIndexOf(".")) return undefined;
  const payload = body.slice(0, dot);
  const signature = body.slice(dot + 1);
  if (payload.length === 0 || payload.length > PAYLOAD_MAX || !HEX64.test(signature)) return undefined;
  const expected = Buffer.from(signatureOf(payload), "hex");
  const given = Buffer.from(signature, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  const json = Buffer.from(payload, "base64url");
  if (json.length === 0 || json.length > PAYLOAD_MAX || json.toString("base64url") !== payload) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(json.toString("utf8")); }
  catch { return undefined; }
  if (!isRemoteContentRef(parsed)) return undefined;
  if (payloadOf(parsed) !== payload) return undefined;
  return canonical(parsed);
};

/** Whether a stream is a media-server attempt at all -- including a malformed one, so the
 *  download and fallback paths can refuse provenance they cannot verify. */
export const isRemoteMediaStream = (stream: Pick<StreamItem, "url">): boolean =>
  typeof stream.url === "string" && stream.url.startsWith(SEAL_SCHEME);
